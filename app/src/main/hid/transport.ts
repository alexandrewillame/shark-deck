/**
 * The HID channel: enumeration, feature/output report exchange, echo
 * rejection and the native-call wedge deadline.
 *
 * Provenance of the behaviours encoded here, which are about the *transport*
 * rather than any wire format:
 *
 *  - `verified-capture` on Windows. The echo filter (`isEcho`) and the
 *    command-byte filter in `request()` both exist because the Windows HID
 *    stack hands back our own SET buffer when the firmware has not populated
 *    a reply -- observed directly on hardware, and the cause of the `v0.00`
 *    firmware readout before they were added.
 *  - `inferred` everywhere else. Whether Linux hidraw or macOS IOHIDManager
 *    echo or broadcast the same way is unconfirmed (see
 *    docs/platform-support.md). If a report is rejected or misread ONLY on
 *    macOS or Linux, suspect these filters before the wire protocol.
 */
import HID from 'node-hid';
import type { ChecksumScheme } from '@shared/types/device';
import { toHex } from './frame';
import { compxFeaCkIndex, verifyChecksum } from './checksum';

export interface HidCandidate {
  path: string;
  vendorId: number;
  productId: number;
  usagePage?: number;
  usage?: number;
  serialNumber?: string;
  interface: number;
  release?: number;
  product?: string;
  manufacturer?: string;
}

export interface FrameLogger {
  (dir: 'tx' | 'rx', deviceKey: string, hex: string, note?: string): void;
}

/**
 * In feature-report mode Windows hands back the report we just SET when the
 * firmware has not populated the buffer (a wrong checksum, a sleeping device, or
 * a command with no reply). Such an "answer" has the right command byte but is
 * byte-for-byte our own zero-padded query — accepting it is what produced the
 * `v0.00` firmware readout. Only the version GETs (no SET counterpart to mirror)
 * opt into this check; commands whose zero payload is a valid value must not.
 */
function isEcho(reply: Uint8Array, query: Uint8Array): boolean {
  if (reply.length !== query.length) return false;
  for (let i = 0; i < reply.length; i++) {
    if (reply[i] !== query[i]) return false;
  }
  return true;
}

/**
 * `compx-fea` reply-checksum enforcement — OFF, and it must stay off.
 *
 * The firmware does not compute a checksum over its replies. Byte 8 of a reply
 * is simply whatever our query left in the buffer (our query's own checksum),
 * unless the reply's data runs past byte 8, in which case it is data.
 * `verifyChecksum` recomputes `0xFF - Σ reply[1..7]`, which coincides with our
 * query's checksum only when reply bytes 2..7 are all zero. So enforcement
 * passes for trivial replies and rejects exactly the informative ones.
 *
 * Measured on an R85HE (fw v5.11):
 *   GET_PROFILE  `00 84 00 00 00 00 00 00 7b`  -> expects 7b, gets 7b  (passes)
 *   GET_USB_VER  `00 8f 33 0c 00 00 00 00 11`  -> expects 31, gets 11  (REJECTED)
 *
 * That rejection made `getFirmware()` return null forever, which in turn pinned
 * `CompxHeKeyboard.travelMultiplier()` at its 10 fallback instead of 200 — so
 * every magnetic travel value was off by 20x in both directions (a 2.0 mm
 * actuation read back as 40 mm, and written as 0.1 mm).
 *
 * `shark-sum` (V8 mouse) is a real trailing checksum and is always enforced.
 */
const ENFORCE_COMPX_FEA_REPLY_CHECKSUM = false;

let lastEnumerateError: string | null = null;

/** The last error thrown by `HID.devicesAsync()`, or null if the last call was clean. */
export function lastHidError(): string | null {
  return lastEnumerateError;
}

/**
 * Enumerate every HID collection for a VID/PID. We match the vendor config
 * collection by usage page + usage (from the report descriptor), never by the
 * `colNN` index or instance suffix in the path — those change with USB port.
 * This rule is carried over verbatim from the proven Python switcher
 * (legacy/attack-shark-profile-switcher/sharkctl.py:find_device).
 *
 * node-hid v3 `HID.devicesAsync()` accepts *either* no arguments *or* both a
 * vendor and product id — passing a lone vid (or `vid, undefined`) throws
 * "unexpected number of arguments". So we always call it with none and filter
 * here; that keeps every caller safe regardless of how it invokes us.
 *
 * Async (runs on the libuv threadpool, not the main event loop) — see
 * `HidChannel` below for why every HID call in this module is async now: the
 * previous synchronous API blocked the whole main process for the duration of
 * every read/write, which is what froze frameless-window dragging.
 */
export async function enumerate(vid?: number, pid?: number): Promise<HidCandidate[]> {
  try {
    const all = (await HID.devicesAsync())
      .filter(
        (d) =>
          (vid === undefined || d.vendorId === vid) && (pid === undefined || d.productId === pid),
      )
      .map((d) => ({
        path: d.path ?? '',
        vendorId: d.vendorId,
        productId: d.productId,
        usagePage: d.usagePage,
        usage: d.usage,
        serialNumber: d.serialNumber,
        interface: d.interface ?? -1,
        release: d.release,
        product: d.product,
        manufacturer: d.manufacturer,
      }));
    lastEnumerateError = null;
    return all;
  } catch (err) {
    lastEnumerateError = String((err as Error)?.message ?? err);
    console.error('[hid] enumerate failed:', lastEnumerateError);
    return [];
  }
}

/**
 * Picks the vendor config collection for one device out of an already-fetched
 * candidate list (from `enumerate()`) — the caller passes the *whole* list it
 * fetched for this scan pass, rather than this function re-enumerating the
 * entire bus again per device. `manager.scan()` used to call this once per
 * resolved descriptor, each call doing its own full `enumerate()` — an N+1
 * that multiplied `HID.devicesAsync()`'s SetupAPI walk by the device count on
 * every ~2.5s scan tick.
 */
export function findVendorCollection(
  all: HidCandidate[],
  vid: number,
  pid: number,
  usagePage: number,
  usage: number,
): HidCandidate | null {
  const candidates = all.filter((c) => c.vendorId === vid && c.productId === pid);
  return (
    candidates.find((c) => c.usagePage === usagePage && c.usage === usage && !!c.path) ??
    candidates.find((c) => c.usagePage === usagePage && !!c.path) ??
    null
  );
}

/**
 * A thin, self-healing wrapper around one open HID collection, driven entirely
 * through node-hid's async `HIDAsync` API so a read/write never blocks the
 * main process event loop — a blocked loop is what froze frameless-window
 * dragging and produced the app's periodic ~1s "stall".
 *
 * Every operation is serialized through `gate` (a chained promise): the wire
 * protocol is stateful (a write followed by its read-back, or several chained
 * write-then-read chunks for a multi-frame payload) and depended on the old
 * synchronous API's side effect of the JS event loop being an implicit lock —
 * once reads/writes are genuinely async, two calls issued close together
 * (a scan-loop poll racing a user-initiated write, say) could otherwise
 * interleave their frames on the wire. `transaction()` lets a driver run a
 * whole multi-frame sequence (chunked reads/writes, a write + its read-back)
 * as one atomic unit against this same gate.
 */
/**
 * How long `HidChannel.close()` waits for node-hid's own close before giving
 * up on it. A `close()` against a device that has already been yanked can sit
 * there; the caller (the manager's prune sweep) must not stall on it.
 */
const CLOSE_TIMEOUT_MS = 750;

/**
 * Thrown when a native HID call blows its deadline — the channel is dead from
 * that moment on (see `poison()`), so this is the ONE error the read helpers
 * are allowed to let escape instead of folding into their usual `null`.
 */
export class HidWedgedError extends Error {
  constructor(op: string, ms: number, key: string) {
    super(`HID ${op} on ${key} did not return within ${ms}ms — channel wedged`);
    this.name = 'HidWedgedError';
  }
}

/**
 * Deadline for a single native call.
 *
 * Why this exists at all: hidapi's Windows backend has **no timeout** on the
 * feature-report path. `hid_get_feature_report` issues
 * `DeviceIoControl(IOCTL_HID_GET_FEATURE, …)` and then
 * `GetOverlappedResult(…, TRUE)` — an unbounded wait with no timeout
 * parameter to pass down — and `hid_send_feature_report` is a synchronous
 * `HidD_SetFeature`, which is the call the R85HE notes blame for the 0x79
 * "semaphore timeout" lockup. Only `hid_read_timeout` and `hid_write` (the
 * output-report path, used by the V8 mouse) are natively bounded. So
 * `readUnlocked`'s `timeoutMs` was not merely ignored — on a feature-report
 * device there was nothing to pass it to, and the deadline has to live here.
 *
 * 1500 ms is deliberately generous: 6x the largest read timeout any driver
 * asks for (250) and above hidapi's own 1000 ms write timeout, because a false
 * positive costs a device card going offline for a backoff period.
 */
const OP_TIMEOUT_MS = 1500;
/** Added on top of a caller's own read timeout when that is the larger of the two. */
const OP_TIMEOUT_SLACK_MS = 500;

/**
 * Reads per attempt in `request()` once pacing is on (feature-report mode).
 *
 * The extra reads were provably uninformative, not merely risky. In
 * feature-report mode the device parks its answer in the feature buffer and
 * the host pulls it — so re-reading microseconds later cannot show anything
 * new, because the firmware has not run in between. `readUserPicWith` already
 * says as much ("reading too eagerly returns the previous chunk's buffer still
 * sitting in the endpoint"). So the old 3 attempts x 6 reads was one useful
 * frame and five that did nothing but raise the burst rate the endpoint-lockup
 * note blames. Two paced reads strictly dominate six unpaced ones: a
 * guaranteed-miss GET goes from 14 frames to ~6 over ~130 ms — fewer frames
 * AND a faster failure.
 */
const FEATURE_MAX_POLL_READS = 2;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export class HidChannel {
  private dev: HID.HIDAsync | null = null;
  private opening: Promise<HID.HIDAsync> | null = null;
  /**
   * Set by `close()`, and never cleared — a channel is closed for good.
   *
   * Without this, `close()` was reversible: it nulls `dev`/`opening`, but any
   * operation already queued on `gate` (or any later call) would reach
   * `ensureOpen()` and silently **re-open the handle**. The manager's prune
   * sweep hit exactly that — it stopped the travel stream, which queues a
   * `write`, then fire-and-forget `close()`d the channel and deleted the
   * entry. The queued write then re-opened a handle that nothing could ever
   * close again, and on Windows that stale handle blocks a later
   * `HIDAsync.open()` on the same path — so a replugged keyboard was never
   * picked up again until the app restarted.
   */
  private disposed = false;
  private readonly key: string;
  /** Chained promise every public operation awaits its turn on. */
  private gate: Promise<unknown> = Promise.resolve();
  /** Latched by `poison()`; distinct from `disposed` only so the manager can
   *  tell a deliberate close from a device that stopped answering. */
  private wedged = false;

  constructor(
    private readonly candidate: HidCandidate,
    private readonly log?: FrameLogger,
    private readonly mode: 'output-report' | 'feature-report' = 'output-report',
    /** verify replies against this scheme in `request()`; 'none' skips the check */
    private readonly checksum: ChecksumScheme = 'none',
    /** Optional, positional-last so every existing call site is unchanged. */
    private readonly opts: {
      /** Called once, when this channel wedges. The manager takes the device offline. */
      onWedged?: (reason: string) => void;
      /** Override the native-call deadline. Tests inject a small value. */
      opTimeoutMs?: number;
      /** Delay between the reads of one `request()` attempt, feature-report mode only. */
      requestPaceMs?: number;
    } = {},
  ) {
    this.key = candidate.serialNumber || candidate.path;
  }

  get deviceKey(): string {
    return this.key;
  }

  /**
   * `bcdDevice` from the USB device descriptor of the endpoint this channel
   * talks to, or undefined if the OS didn't report one.
   *
   * This is a real firmware version, not a fallback: the vendor's own
   * `CS_UsbFinder_GetVersion` takes a HID *path* and returns exactly this
   * value (`0x303` in the 2026-08-30 capture), while its wire-level
   * `CS_UsbServer_ReadVersion` came back empty — the same empty answer the
   * `0x02` command still gives. See `CompxMouse8K.getFirmware`.
   */
  get descriptorRelease(): number | undefined {
    return this.candidate.release;
  }

  /** Opens the handle if needed, coalescing concurrent callers onto the same open. */
  private async ensureOpen(): Promise<HID.HIDAsync> {
    if (this.disposed) throw new Error(`HID channel for ${this.key} is closed`);
    if (this.dev) return this.dev;
    if (!this.opening) {
      // Shared, not seized. hidapi opens a device EXCLUSIVELY on macOS unless
      // told otherwise, and there the handle is the whole USB interface — on
      // the V8 that interface also carries input collections, which macOS
      // would stop receiving for as long as Shark Deck held it. The option is
      // macOS-only in node-hid; elsewhere it changes nothing.
      this.opening = HID.HIDAsync.open(this.candidate.path, { nonExclusive: true }).then(
        (dev) => {
          this.dev = dev;
          this.opening = null;
          return dev;
        },
        (err) => {
          // Without this, a rejected open (e.g. Linux EACCES with no udev
          // rule installed) stays cached in `this.opening` forever — every
          // later call on this channel would reject with the *original*
          // error until the manager's 2.5s prune sweep recreates the entry.
          // Clearing it here means fixing the underlying cause (installing
          // the udev rule, freeing the device) takes effect on the very next
          // call, not on the next scan pass.
          this.opening = null;
          throw err;
        },
      );
    }
    return this.opening;
  }

  async open(): Promise<void> {
    await this.ensureOpen();
  }

  /**
   * Close for good. Idempotent, and bounded: a `dev.close()` against a device
   * that has already been unplugged can hang, and the caller (the prune sweep)
   * must not be stuck behind it. Timing out only abandons the wait — `disposed`
   * still guarantees nothing re-opens this channel.
   */
  async close(): Promise<void> {
    const dev = this.dev;
    this.disposed = true;
    this.dev = null;
    this.opening = null;
    if (!dev) return;
    try {
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([
        dev.close(),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, CLOSE_TIMEOUT_MS);
        }),
      ]).finally(() => {
        if (timer) clearTimeout(timer);
      });
    } catch {
      /* ignore */
    }
  }

  isOpen(): boolean {
    return this.dev !== null;
  }

  /** True once `close()` has run — the channel can never be used again. */
  isDisposed(): boolean {
    return this.disposed;
  }

  /** True when this channel died on a blown deadline rather than a deliberate close. */
  isWedged(): boolean {
    return this.wedged;
  }

  /**
   * Runs one native call against a deadline. Must wrap the native call itself
   * and nothing else: node-hid serialises jobs per handle natively
   * (`AsyncWorkerQueue` in its util.h — `QueueJob` only starts a worker when
   * none is running), so only the op at the head of that queue is actually on
   * the wire, and only there does "took too long" mean "the device stopped
   * answering" rather than "something ahead of me is slow".
   */
  private async bounded<T>(op: string, ms: number, fn: () => Promise<T>): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        fn(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new HidWedgedError(op, ms, this.key)), ms);
        }),
      ]);
    } catch (err) {
      if (err instanceof HidWedgedError) this.poison(err.message);
      throw err;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /**
   * Kill the channel after a blown deadline.
   *
   * Abandoning the promise is NOT enough on its own. The native worker keeps
   * running and keeps node-hid's per-handle queue busy, so every later op —
   * `close()` included — is queued behind it and our JS ordering stops
   * matching what reaches the wire. Hence: latch first, so nothing new can
   * enqueue, then `close()` **without awaiting it** — `HIDAsync::close` marks
   * its handle closed synchronously (its own comment: "to stop new jobs being
   * pushed to the queue"), so anything slipping past the latch rejects
   * immediately, and the queued `CloseWorker` runs the real `hid_close` the
   * moment the stuck IRP finally completes.
   *
   * Reusing `disposed` is deliberate: the manager's scan already rebuilds a
   * channel + driver for a disposed entry, so recovery needs no new concept.
   */
  private poison(reason: string): void {
    if (this.wedged) return;
    this.wedged = true;
    const dev = this.dev;
    this.disposed = true;
    this.dev = null;
    this.opening = null;
    // `close()` THROWS synchronously on an already-closed handle rather than
    // rejecting, so this needs the try as well as the catch.
    try {
      void dev?.close().catch(() => undefined);
    } catch {
      /* already closed */
    }
    this.log?.('rx', this.key, '', `channel wedged (${reason})`);
    this.opts.onWedged?.(reason);
  }

  /** Runs `fn` as the next link in this channel's serialization chain. A
   *  rejection doesn't poison the chain for later callers. */
  private run<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.gate.then(fn, fn);
    // Swallow so an awaited-elsewhere rejection doesn't become an unhandled
    // rejection on the gate itself; callers still see the real rejection via
    // `result`.
    this.gate = result.catch(() => undefined);
    return result;
  }

  /** The deadline for one native call on this channel. */
  private get opMs(): number {
    return this.opts.opTimeoutMs ?? OP_TIMEOUT_MS;
  }

  /**
   * Deadline for a read, which is allowed to sit for the caller's own
   * `timeoutMs` and legitimately come back empty — so the default must never
   * be tighter than that. An explicit `opTimeoutMs` is a deliberate override
   * and wins outright; without that, tests injecting a small deadline would
   * have it widened straight back out by the caller's timeout.
   */
  private readDeadline(timeoutMs: number): number {
    if (this.opts.opTimeoutMs !== undefined) return this.opts.opTimeoutMs;
    return Math.max(OP_TIMEOUT_MS, timeoutMs + OP_TIMEOUT_SLACK_MS);
  }

  private async writeUnlocked(frame: Uint8Array): Promise<void> {
    const dev = await this.ensureOpen();
    const bytes = Array.from(frame);
    if (this.mode === 'feature-report') {
      await this.bounded('sendFeatureReport', this.opMs, () => dev.sendFeatureReport(bytes));
    } else {
      await this.bounded('write', this.opMs, () => dev.write(bytes));
    }
    this.log?.('tx', this.key, toHex(frame));
  }

  private async readUnlocked(timeoutMs = 250, featureLen = 65): Promise<Uint8Array | null> {
    const dev = await this.ensureOpen();
    const ms = this.readDeadline(timeoutMs);
    try {
      if (this.mode === 'feature-report') {
        const data = await this.bounded('getFeatureReport', ms, () =>
          dev.getFeatureReport(0x00, featureLen),
        );
        if (!data || data.length === 0) return null;
        const buf = Uint8Array.from(data);
        this.log?.('rx', this.key, toHex(buf));
        return buf;
      }
      const data = await this.bounded('read', ms, () => dev.read(timeoutMs));
      if (!data || data.length === 0) return null;
      const buf = Uint8Array.from(data);
      this.log?.('rx', this.key, toHex(buf));
      return buf;
    } catch (err) {
      // `null` means "the device answered with nothing", which every caller
      // treats as a soft miss worth another frame. A wedge is the opposite: it
      // must abort the whole sweep, so it is the one error allowed out. Folding
      // it into `null` here would leave `readMatrixChunks` returning a partial
      // key matrix and `requestUnlocked` looping on a dead handle — i.e. the
      // deadline above would do nothing at all.
      if (err instanceof HidWedgedError) throw err;
      return null;
    }
  }

  private async readInputUnlocked(timeoutMs = 20): Promise<Uint8Array | null> {
    // Was `if (!this.dev) return null` — unlike every other read primitive
    // this never opened the handle itself, so the very first poll after a
    // fresh app start (before anything else had touched this channel)
    // returned null forever. See readStreamUnlocked for the feature-report
    // fallback a feature-only vendor collection (e.g. the R85HE) may need.
    const dev = await this.ensureOpen();
    try {
      const data = await this.bounded('read', this.readDeadline(timeoutMs), () =>
        dev.read(timeoutMs),
      );
      if (!data || data.length === 0) return null;
      const buf = Uint8Array.from(data);
      this.log?.('rx', this.key, toHex(buf), 'stream');
      return buf;
    } catch (err) {
      if (err instanceof HidWedgedError) throw err;
      return null;
    }
  }

  /**
   * Read one pushed report for a live stream, trying the input-report path
   * first and falling back to a feature-report GET when in `feature-report`
   * mode — the R85HE's vendor collection only speaks feature reports for
   * everything else, so a raw input `read()` may never resolve for its
   * per-key travel stream (`SET_MAGNETISM_REPORT`). `via` tells the caller
   * which path actually answered, for diagnostics. `provenance: inferred`
   * — not yet confirmed on hardware, see
   * docs/reverse-engineering/CAPTURE-KEYBOARD.md.
   */
  private async readStreamUnlocked(
    timeoutMs = 20,
    featureLen = 65,
  ): Promise<{ data: Uint8Array; via: 'input' | 'feature' } | null> {
    const dev = await this.ensureOpen();
    const ms = this.readDeadline(timeoutMs);
    try {
      const data = await this.bounded('read', ms, () => dev.read(timeoutMs));
      if (data && data.length) {
        const buf = Uint8Array.from(data);
        this.log?.('rx', this.key, toHex(buf), 'stream');
        return { data: buf, via: 'input' };
      }
    } catch (err) {
      // A wedge must NOT fall through — the second attempt below would be a
      // fresh op on a handle we have just poisoned.
      if (err instanceof HidWedgedError) throw err;
      /* otherwise fall through to the feature-report attempt below */
    }
    if (this.mode === 'feature-report') {
      try {
        const data = await this.bounded('getFeatureReport', this.opMs, () =>
          dev.getFeatureReport(0x00, featureLen),
        );
        if (data && data.length) {
          const buf = Uint8Array.from(data);
          this.log?.('rx', this.key, toHex(buf), 'stream-feature');
          return { data: buf, via: 'feature' };
        }
      } catch (err) {
        if (err instanceof HidWedgedError) throw err;
        /* ignore */
      }
    }
    return null;
  }

  private async requestUnlocked(
    query: Uint8Array,
    expectCommand: number,
    attempts: number,
    perAttemptReads: number,
    rejectEcho: boolean,
    accept?: (reply: Uint8Array) => boolean,
  ): Promise<Uint8Array | null> {
    const featureLen = query.length;
    // Enforce the reply checksum for every scheme now confirmed against real
    // traffic: `shark-sum` (V8 mouse) and `compx-fea` (R85HE keyboard, decoded
    // from a 2515-frame capture). `none` trivially passes. The legacy
    // `bit7`/`bit8` reconstructions stay unenforced — a genuine reply may not
    // match those. A checksum miss is treated like "no reply yet": keep polling
    // within the attempt budget (see the doc comment on `request()`).
    const enforceChecksum =
      this.checksum === 'shark-sum' ||
      this.checksum === 'none' ||
      (this.checksum === 'compx-fea' && ENFORCE_COMPX_FEA_REPLY_CHECKSUM);
    const ckIndex = this.checksum === 'compx-fea' ? compxFeaCkIndex(expectCommand) : 8;
    // Pacing is feature-report only: the output-report path is natively
    // bounded on both sides and has never shown the lockup, so the V8 mouse's
    // request() behaviour stays byte-for-byte what it was.
    const pace = this.mode === 'feature-report' ? (this.opts.requestPaceMs ?? 0) : 0;
    const reads = pace ? Math.min(perAttemptReads, FEATURE_MAX_POLL_READS) : perAttemptReads;
    for (let a = 0; a < attempts; a++) {
      await this.writeUnlocked(query);
      for (let r = 0; r < reads; r++) {
        // Before the FIRST read too — the firmware needs the settle time to
        // produce an answer at all; reading immediately just returns whatever
        // the endpoint still held from the previous exchange.
        if (pace) await sleep(pace);
        const reply = await this.readUnlocked(250, featureLen);
        if (
          reply &&
          reply[1] === expectCommand &&
          !(rejectEcho && isEcho(reply, query)) &&
          (!enforceChecksum || verifyChecksum(reply, this.checksum, ckIndex)) &&
          (!accept || accept(reply))
        ) {
          return reply;
        }
        if (this.mode === 'output-report' && !reply) break;
      }
    }
    return null;
  }

  write(frame: Uint8Array): Promise<void> {
    return this.run(() => this.writeUnlocked(frame));
  }

  /** Read one report, or null on timeout / no data. */
  read(timeoutMs = 250, featureLen = 65): Promise<Uint8Array | null> {
    return this.run(() => this.readUnlocked(timeoutMs, featureLen));
  }

  /**
   * Read one *input* report (never a feature GET), or null on timeout. Used for
   * asynchronous streams such as the magnetic per-key travel report, which the
   * firmware pushes on its own once enabled.
   */
  readInput(timeoutMs = 20): Promise<Uint8Array | null> {
    return this.run(() => this.readInputUnlocked(timeoutMs));
  }

  /** Public gated form of `readStreamUnlocked` — see its doc comment. */
  readStream(
    timeoutMs = 20,
    featureLen = 65,
  ): Promise<{ data: Uint8Array; via: 'input' | 'feature' } | null> {
    return this.run(() => this.readStreamUnlocked(timeoutMs, featureLen));
  }

  /**
   * Send a query and return the first reply whose command byte matches.
   *
   * output-report mode: Windows delivers every input report to all open
   * handles, so the vendor Hub's status poll is filtered out by command byte;
   * we re-send a few times because a sleeping device leaves the query
   * unacknowledged.
   *
   * feature-report mode: the device keeps its last response in the feature
   * buffer, so one GetFeature after the SetFeature is enough — but we still
   * poll briefly in case the firmware needs a moment to populate it.
   *
   * A reply also has to carry a valid checksum — command-byte matching alone
   * will happily accept a stray or corrupted frame that just happens to share
   * that byte. Enforced for every scheme now confirmed against real captured
   * traffic: `shark-sum` (V8 mouse) and `compx-fea` (R85HE keyboard). The
   * legacy `bit7`/`bit8` reconstructions are NOT enforced — they were a guess
   * at an algorithm computed in a vendor sidecar we cannot see, so a genuine
   * reply may not match them. A checksum failure is treated the same as no
   * reply yet: keep polling within the attempt budget.
   *
   * `accept` narrows it further, for a command where the byte is not enough to
   * identify the answer. The V8's region-A read (`0x08`) is the case that
   * forced this: every offset in the block is read with that same command, so
   * a reply for a DIFFERENT offset — from our own concurrent sweep, or from
   * the vendor Hub polling the device on its own handle (see the note above
   * about Windows fanning input reports out to every open handle) — passes
   * both the command-byte and the checksum test while carrying the wrong
   * bytes. A rejected frame is treated the same as no reply yet, so the right
   * one can still arrive within the attempt budget.
   */
  request(
    query: Uint8Array,
    expectCommand: number,
    attempts = 3,
    perAttemptReads = 6,
    rejectEcho = false,
    accept?: (reply: Uint8Array) => boolean,
  ): Promise<Uint8Array | null> {
    return this.run(() =>
      this.requestUnlocked(query, expectCommand, attempts, perAttemptReads, rejectEcho, accept),
    );
  }

  /**
   * Runs `fn` as one atomic sequence against this channel — no other
   * `write`/`read`/`request`/`readInput`/`transaction` call can interleave its
   * frames with `fn`'s. `fn` receives the *unlocked* primitives (not the public
   * ones above) so it can freely chain several writes/reads without deadlocking
   * against its own lock. Use this for anything that is logically one
   * operation on the wire but more than one frame — a write followed by its
   * read-back, or a multi-chunk block read/write.
   */
  transaction<T>(
    fn: (io: {
      write: (frame: Uint8Array) => Promise<void>;
      read: (timeoutMs?: number, featureLen?: number) => Promise<Uint8Array | null>;
      readInput: (timeoutMs?: number) => Promise<Uint8Array | null>;
      request: (
        query: Uint8Array,
        expectCommand: number,
        attempts?: number,
        perAttemptReads?: number,
        rejectEcho?: boolean,
        accept?: (reply: Uint8Array) => boolean,
      ) => Promise<Uint8Array | null>;
    }) => Promise<T>,
  ): Promise<T> {
    return this.run(() =>
      fn({
        write: (frame) => this.writeUnlocked(frame),
        read: (timeoutMs, featureLen) => this.readUnlocked(timeoutMs, featureLen),
        readInput: (timeoutMs) => this.readInputUnlocked(timeoutMs),
        request: (
          query,
          expectCommand,
          attempts = 3,
          perAttemptReads = 6,
          rejectEcho = false,
          accept,
        ) =>
          this.requestUnlocked(query, expectCommand, attempts, perAttemptReads, rejectEcho, accept),
      }),
    );
  }
}
