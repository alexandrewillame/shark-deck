/**
 * `node-hid`, reimplemented over WebHID: exactly the async subset that
 * src/main/hid/transport.ts uses, so the browser edition drives devices
 * through the same `HidChannel` as the desktop app — same pacing, echo filter,
 * wedge deadline and retries. vite.web.config.ts aliases the bare `node-hid`
 * import to this module; test/contract/webhid-shim.test.ts fails if
 * transport.ts starts using a member that is not in `IMPLEMENTED` below.
 *
 * The byte layout is hidapi's, because transport.ts was written against it:
 *
 *  - Every frame we send carries its report id in byte 0. WebHID takes the id
 *    as a separate argument, so it is split off here.
 *  - `getFeatureReport(id, len)` returns exactly `len` bytes, `[id, ...data]`.
 *    The length is load-bearing: `isEcho()` compares lengths before bytes, so
 *    a reply one byte short or long would silently switch the echo filter off.
 *  - `read()` returns `[id, ...data]` for a numbered report and the bare data
 *    for report id 0 — hidapi strips that zero byte.
 *  - An input report reaches only handles opened on the collection that
 *    declares its id. On Windows node-hid opens a single top-level
 *    collection's path, so that is what transport.ts has always seen.
 *
 * What Chromium was seen to do (docs/protocol/webhid.md):
 *
 *  - Feature reports, provenance: verified-capture — Chrome 157 on Windows 11,
 *    an R85HE, 2026-11-03. `receiveFeatureReport(0)` returns the 64-byte
 *    payload WITHOUT the id byte, and a GET the firmware ignores comes back as
 *    our own SET buffer, exactly as through hidapi — so the echo filter is
 *    needed here too. The replies matched the desktop's captures byte for byte.
 *    `normalizeFeature` still decides from the declared report size rather
 *    than assuming that layout: macOS and Linux are unconfirmed.
 *  - Output and input reports (the V8's path), provenance: inferred — the
 *    rules above are hidapi's documented behaviour, not yet run on hardware.
 */

type Bytes = ArrayLike<number>;

/** The fields of node-hid's `Device` that transport.ts reads. */
export interface WebHidDeviceInfo {
  vendorId: number;
  productId: number;
  path: string;
  serialNumber?: string;
  manufacturer?: string;
  product?: string;
  release?: number;
  interface: number;
  usagePage?: number;
  usage?: number;
}

/** What transport.ts may use, pinned by test/contract/webhid-shim.test.ts. */
export const IMPLEMENTED = {
  /** Members reached through the default import (`HID.x`). */
  module: ['devicesAsync', 'HIDAsync', 'HIDAsync.open'],
  /** Methods called on an open handle. */
  handle: ['write', 'sendFeatureReport', 'getFeatureReport', 'read', 'close'],
} as const;

export const PATH_PREFIX = 'webhid:';

/** How many unread input reports a handle keeps, oldest dropped first —
 *  the order of magnitude of the Windows HID class driver's ring buffer. */
const MAX_QUEUED_REPORTS = 64;

type ReportKind = 'inputReports' | 'outputReports' | 'featureReports';

const hex4 = (n: number): string => n.toString(16).padStart(4, '0');

function* walk(collection: HIDCollectionInfo): Generator<HIDCollectionInfo> {
  yield collection;
  for (const child of collection.children ?? []) yield* walk(child);
}

/** Byte length of one report's payload (id excluded), or null when the descriptor doesn't say. */
export function reportBytes(info: HIDReportInfo | undefined): number | null {
  if (!info?.items?.length) return null;
  let bits = 0;
  for (const item of info.items) bits += (item.reportSize ?? 0) * (item.reportCount ?? 0);
  return bits > 0 ? Math.ceil(bits / 8) : null;
}

function reportIds(collection: HIDCollectionInfo, kind: ReportKind): Set<number> {
  const ids = new Set<number>();
  for (const node of walk(collection)) for (const r of node[kind] ?? []) ids.add(r.reportId ?? 0);
  return ids;
}

function declaredFeatureBytes(device: HIDDevice, reportId: number): number | null {
  for (const top of device.collections) {
    for (const node of walk(top)) {
      const info = node.featureReports?.find((r) => (r.reportId ?? 0) === reportId);
      if (info) return reportBytes(info);
    }
  }
  return null;
}

/**
 * Shape a `receiveFeatureReport` answer the way hidapi's
 * `hid_get_feature_report` does: exactly `length` bytes, the report id first.
 *
 * Whether Chromium already put the id in byte 0 is read off the declared
 * payload size: a buffer longer than the payload must be carrying it. With no
 * descriptor to go by, a buffer of the full requested length is assumed to.
 */
export function normalizeFeature(
  view: DataView,
  reportId: number,
  length: number,
  declared: number | null,
): Uint8Array {
  const raw = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
  const includesId = declared !== null ? raw.length > declared : raw.length >= length;
  const body = includesId ? raw.subarray(1) : raw;
  const out = new Uint8Array(length);
  out[0] = reportId;
  out.set(body.subarray(0, Math.max(0, length - 1)), 1);
  return out;
}

/** An input report as hidapi's `hid_read` hands it over. */
export function inputBytes(reportId: number, data: DataView): Uint8Array {
  const body = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  if (reportId === 0) return body.slice();
  const out = new Uint8Array(body.length + 1);
  out[0] = reportId;
  out.set(body, 1);
  return out;
}

function describe(err: unknown): string {
  if (err instanceof Error) return `${err.name}: ${err.message}`;
  return String(err);
}

/**
 * One `HIDDevice`'s open/close, shared by every handle on it.
 *
 * Reference-counted because the manager may hold a second handle while
 * retiring the first, and serialized because Chromium rejects an `open()` that
 * lands while a `close()` is still pending (InvalidStateError) — exactly what
 * the manager's endpoint handover does when it closes and then reopens.
 */
class DeviceLifecycle {
  private refs = 0;
  private chain: Promise<void> = Promise.resolve();

  constructor(private readonly device: HIDDevice) {}

  acquire(): Promise<void> {
    return this.enqueue(async () => {
      if (this.refs === 0 && !this.device.opened) await this.device.open();
      this.refs++;
    });
  }

  release(): Promise<void> {
    return this.enqueue(async () => {
      if (this.refs === 0) return;
      this.refs--;
      if (this.refs === 0 && this.device.opened) await this.device.close();
    });
  }

  private enqueue(fn: () => Promise<void>): Promise<void> {
    const next = this.chain.then(fn, fn);
    this.chain = next.catch(() => undefined);
    return next;
  }
}

interface Endpoint {
  device: HIDDevice;
  collection: HIDCollectionInfo;
}

export class WebHidHandle {
  private queue: Uint8Array[] = [];
  private waiter: ((report: Uint8Array | undefined) => void) | null = null;
  private closed = false;
  private readonly inputIds: Set<number>;

  private readonly onReport = (event: HIDInputReportEvent): void => {
    if (this.closed || !this.inputIds.has(event.reportId)) return;
    const bytes = inputBytes(event.reportId, event.data);
    const waiter = this.waiter;
    if (waiter) {
      this.waiter = null;
      waiter(bytes);
      return;
    }
    this.queue.push(bytes);
    if (this.queue.length > MAX_QUEUED_REPORTS) this.queue.shift();
  };

  constructor(
    private readonly endpoint: Endpoint,
    private readonly lifecycle: DeviceLifecycle,
  ) {
    this.inputIds = reportIds(endpoint.collection, 'inputReports');
    endpoint.device.addEventListener('inputreport', this.onReport);
  }

  async write(data: Bytes): Promise<number> {
    const bytes = this.frame(data);
    await this.endpoint.device.sendReport(bytes[0] ?? 0, bytes.slice(1));
    return bytes.length;
  }

  async sendFeatureReport(data: Bytes): Promise<number> {
    const bytes = this.frame(data);
    await this.endpoint.device.sendFeatureReport(bytes[0] ?? 0, bytes.slice(1));
    return bytes.length;
  }

  async getFeatureReport(reportId: number, length: number): Promise<Uint8Array> {
    this.assertOpen();
    const view = await this.endpoint.device.receiveFeatureReport(reportId);
    return normalizeFeature(
      view,
      reportId,
      length,
      declaredFeatureBytes(this.endpoint.device, reportId),
    );
  }

  /** Next input report, or `undefined` once `timeoutMs` passes (node-hid's contract). */
  read(timeoutMs?: number): Promise<Uint8Array | undefined> {
    if (this.closed) return Promise.reject(new Error('HID device is closed'));
    const next = this.queue.shift();
    if (next) return Promise.resolve(next);
    if (timeoutMs === 0) return Promise.resolve(undefined);
    return new Promise((resolve) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      this.waiter = (report) => {
        if (timer !== undefined) clearTimeout(timer);
        resolve(report);
      };
      if (timeoutMs !== undefined && timeoutMs > 0) {
        timer = setTimeout(() => {
          this.waiter = null;
          resolve(undefined);
        }, timeoutMs);
      }
    });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.endpoint.device.removeEventListener('inputreport', this.onReport);
    const waiter = this.waiter;
    this.waiter = null;
    waiter?.(undefined);
    this.queue = [];
    await this.lifecycle.release();
  }

  private frame(data: Bytes): Uint8Array {
    this.assertOpen();
    return Uint8Array.from(data);
  }

  private assertOpen(): void {
    if (this.closed) throw new Error('HID device is closed');
  }
}

/**
 * The node-hid module object. `getHid` is read on every call, so a page that
 * gains or loses WebHID (or a test swapping in a fake) needs no re-import.
 */
export function createNodeHidShim(getHid: () => HID | undefined) {
  const endpoints = new Map<string, Endpoint>();
  const lifecycles = new WeakMap<HIDDevice, DeviceLifecycle>();

  function hid(): HID {
    const api = getHid();
    if (!api) throw new Error('WebHID is not available in this browser');
    return api;
  }

  function lifecycleOf(device: HIDDevice): DeviceLifecycle {
    let life = lifecycles.get(device);
    if (!life) {
      life = new DeviceLifecycle(device);
      lifecycles.set(device, life);
    }
    return life;
  }

  /**
   * One entry per top-level collection, as hidapi lists them on Windows. The
   * path is deterministic — vid:pid, the device's index among same-vid:pid
   * devices, the collection's index — because the manager keys serial-less
   * devices by it, and the saved card order and open tabs must survive a reload.
   * WebHID exposes no serial number, bcdDevice or interface number.
   */
  async function devicesAsync(): Promise<WebHidDeviceInfo[]> {
    const devices = await hid().getDevices();
    endpoints.clear();
    const seen = new Map<string, number>();
    const out: WebHidDeviceInfo[] = [];
    for (const device of devices) {
      const vidPid = `${hex4(device.vendorId)}:${hex4(device.productId)}`;
      const index = seen.get(vidPid) ?? 0;
      seen.set(vidPid, index + 1);
      device.collections.forEach((collection, ci) => {
        const path = `${PATH_PREFIX}${vidPid}:${index}:${ci}`;
        endpoints.set(path, { device, collection });
        out.push({
          vendorId: device.vendorId,
          productId: device.productId,
          path,
          product: device.productName || undefined,
          interface: -1,
          usagePage: collection.usagePage,
          usage: collection.usage,
        });
      });
    }
    return out;
  }

  const HIDAsync = {
    /** `options.nonExclusive` is accepted and ignored: Chromium decides sharing itself. */
    async open(path: string, _options?: { nonExclusive?: boolean }): Promise<WebHidHandle> {
      let endpoint = endpoints.get(path);
      if (!endpoint) {
        await devicesAsync();
        endpoint = endpoints.get(path);
      }
      if (!endpoint) {
        throw new Error(`cannot open device with path ${path}: no longer connected or not granted`);
      }
      const lifecycle = lifecycleOf(endpoint.device);
      try {
        await lifecycle.acquire();
      } catch (err) {
        if (err instanceof Error && err.name === 'NotFoundError') {
          throw new Error(
            `cannot open device with path ${path}: no longer connected (${describe(err)})`,
          );
        }
        // `looksLikePermissionError` in devices/manager.ts matches on the text,
        // as it does for hidapi's own messages. Chromium says only "Failed to
        // open the device", whose usual causes are a missing udev rule on
        // Linux and another program holding the device on macOS.
        throw new Error(
          `cannot open device with path ${path}: permission denied, or another program has exclusive access (${describe(err)})`,
        );
      }
      return new WebHidHandle(endpoint, lifecycle);
    },
  };

  return { devicesAsync, HIDAsync };
}

const shim = createNodeHidShim(() => (globalThis.navigator as Navigator | undefined)?.hid);

export const { devicesAsync, HIDAsync } = shim;
export default shim;
