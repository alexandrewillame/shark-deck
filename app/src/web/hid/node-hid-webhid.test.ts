import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The shim is only worth having if the REAL `HidChannel` behaves over it the
 * way it does over node-hid — so these tests mock `node-hid` with the shim
 * itself and drive transport.ts against a fake `navigator.hid`.
 */
const env = vi.hoisted(() => ({ hid: undefined as unknown }));

vi.mock('node-hid', async () => {
  const { createNodeHidShim } = await import('./node-hid-webhid');
  return { default: createNodeHidShim(() => env.hid as HID | undefined) };
});

import HIDModule from 'node-hid';
import { buildFrame } from '../../main/hid/frame';
import {
  enumerate,
  findVendorCollection,
  HidChannel,
  lastHidError,
  type HidCandidate,
} from '../../main/hid/transport';
import { normalizeFeature, reportBytes, type WebHidHandle } from './node-hid-webhid';
import { ATTACK_SHARK_R85HE } from '../../main/devices/catalog/r85he';
import { createDriver } from '../../main/devices/drivers';

const shim = HIDModule as unknown as {
  devicesAsync: () => Promise<{ path: string }[]>;
  HIDAsync: { open: (path: string) => Promise<WebHidHandle> };
};

const bytes = (n: number) => [{ reportSize: 8, reportCount: n }];

/** V8 interface 1: the vendor config collection plus a mouse collection that streams its own reports. */
const V8_COLLECTIONS: HIDCollectionInfo[] = [
  {
    usagePage: 0xff02,
    usage: 0x02,
    type: 1,
    children: [],
    inputReports: [{ reportId: 0x08, items: bytes(16) }],
    outputReports: [{ reportId: 0x08, items: bytes(16) }],
    featureReports: [],
  },
  {
    usagePage: 0x0001,
    usage: 0x0002,
    type: 1,
    children: [],
    inputReports: [{ reportId: 0x01, items: bytes(7) }],
    outputReports: [],
    featureReports: [],
  },
];

const R85HE_COLLECTIONS: HIDCollectionInfo[] = [
  {
    usagePage: 0xffff,
    usage: 0x02,
    type: 1,
    children: [],
    inputReports: [],
    outputReports: [],
    featureReports: [{ reportId: 0x00, items: bytes(64) }],
  },
];

const sharkSum = (b: ArrayLike<number>, n: number) => {
  let s = 0;
  for (let i = 0; i < n; i++) s += b[i] ?? 0;
  return (0x55 - s) & 0xff;
};

interface FakeOpts {
  /** Replies (as full frames, id at [0]) to an output report. */
  onOutput?: (frame: Uint8Array) => Uint8Array[];
  /** The feature buffer after a SET, as a full frame; null = firmware did not answer. */
  onFeature?: (frame: Uint8Array) => Uint8Array | null;
  /** Whether `receiveFeatureReport` hands back the id byte. Chromium's behaviour is per platform. */
  featureIncludesId?: boolean;
  openError?: Error;
  /** Holds `close()` open until released, to reproduce an open racing a pending close. */
  slowClose?: Promise<void>;
}

class FakeDevice extends EventTarget {
  opened = false;
  openCalls = 0;
  closeCalls = 0;
  private feature: Uint8Array | null = null;

  constructor(
    readonly vendorId: number,
    readonly productId: number,
    readonly productName: string,
    readonly collections: HIDCollectionInfo[],
    private readonly opts: FakeOpts = {},
  ) {
    super();
  }

  async open(): Promise<void> {
    if (this.opts.openError) throw this.opts.openError;
    if (this.opened) throw new DOMException('The device is already open.', 'InvalidStateError');
    this.openCalls++;
    this.opened = true;
  }

  async close(): Promise<void> {
    this.closeCalls++;
    if (this.opts.slowClose) await this.opts.slowClose;
    this.opened = false;
  }

  async forget(): Promise<void> {}

  async sendReport(reportId: number, data: Uint8Array): Promise<void> {
    if (!this.opened) throw new DOMException('closed', 'InvalidStateError');
    const frame = Uint8Array.from([reportId, ...data]);
    const replies = this.opts.onOutput?.(frame) ?? [];
    setTimeout(() => replies.forEach((r) => this.emit(r[0]!, r.subarray(1))), 1);
  }

  async sendFeatureReport(reportId: number, data: Uint8Array): Promise<void> {
    if (!this.opened) throw new DOMException('closed', 'InvalidStateError');
    const frame = Uint8Array.from([reportId, ...data]);
    // A firmware that does not answer leaves our own SET buffer behind — the
    // Windows behaviour `isEcho()` exists for.
    this.feature = this.opts.onFeature?.(frame) ?? frame;
  }

  async receiveFeatureReport(_reportId: number): Promise<DataView> {
    const full = this.feature ?? new Uint8Array(65);
    const out = this.opts.featureIncludesId === false ? full.slice(1) : full.slice();
    return new DataView(out.buffer);
  }

  emit(reportId: number, data: Uint8Array): void {
    const event = Object.assign(new Event('inputreport'), {
      device: this,
      reportId,
      data: new DataView(Uint8Array.from(data).buffer),
    });
    this.dispatchEvent(event);
  }
}

function fakeHid(devices: FakeDevice[]): HID {
  return { getDevices: async () => devices } as unknown as HID;
}

function v8Reply(cmd: number, payload: number[] = []): Uint8Array {
  const f = new Uint8Array(17);
  f[0] = 0x08;
  f[1] = cmd;
  payload.forEach((b, i) => (f[2 + i] = b));
  f[16] = sharkSum(f, 16);
  return f;
}

const v8Query = (cmd: number) =>
  buildFrame({ reportId: 0x08, command: cmd, reportLength: 17, checksum: 'shark-sum' });
const kbQuery = (cmd: number) =>
  buildFrame({ reportId: 0x00, command: cmd, reportLength: 65, checksum: 'compx-fea' });

async function candidateFor(vid: number, pid: number, page: number): Promise<HidCandidate> {
  const found = findVendorCollection(await enumerate(), vid, pid, page, 0x02);
  if (!found) throw new Error('vendor collection not found');
  return found;
}

beforeEach(() => {
  env.hid = undefined;
});

describe('devicesAsync', () => {
  it('lists one entry per top-level collection with a stable, non-empty path', async () => {
    env.hid = fakeHid([new FakeDevice(0x3554, 0xf517, 'ATTACK SHARK Mouse', V8_COLLECTIONS)]);
    const first = await enumerate();
    const second = await enumerate();

    expect(first.map((c) => [c.path, c.usagePage, c.usage])).toEqual([
      ['webhid:3554:f517:0:0', 0xff02, 0x02],
      ['webhid:3554:f517:0:1', 0x0001, 0x0002],
    ]);
    expect(second.map((c) => c.path)).toEqual(first.map((c) => c.path));
    // WebHID has none of these; transport.ts and the manager must cope.
    expect(first[0]).toMatchObject({ serialNumber: undefined, release: undefined, interface: -1 });
  });

  it('numbers identical devices apart', async () => {
    env.hid = fakeHid([
      new FakeDevice(0x3151, 0x5029, 'R85HE', R85HE_COLLECTIONS),
      new FakeDevice(0x3151, 0x5029, 'R85HE', R85HE_COLLECTIONS),
    ]);
    expect((await enumerate()).map((c) => c.path)).toEqual([
      'webhid:3151:5029:0:0',
      'webhid:3151:5029:1:0',
    ]);
  });

  it('reports a missing WebHID through lastHidError instead of throwing', async () => {
    env.hid = undefined;
    expect(await enumerate()).toEqual([]);
    expect(lastHidError()).toMatch(/WebHID is not available/);
  });
});

describe('output-report devices (V8)', () => {
  it('splits the report id off a write and hands the reply back with the id first', async () => {
    const dev = new FakeDevice(0x3554, 0xf517, 'ATTACK SHARK Mouse', V8_COLLECTIONS, {
      onOutput: (f) => (f[1] === 0x0e ? [v8Reply(0x0e, [0, 0, 0, 0, 1])] : []),
    });
    env.hid = fakeHid([dev]);
    const ch = new HidChannel(
      await candidateFor(0x3554, 0xf517, 0xff02),
      undefined,
      'output-report',
      'shark-sum',
    );

    const reply = await ch.request(v8Query(0x0e), 0x0e);
    expect(reply?.length).toBe(17);
    expect(reply?.[0]).toBe(0x08);
    expect(reply?.[6]).toBe(1);
    await ch.close();
  });

  it('ignores reports that belong to another collection on the same interface', async () => {
    // A report on the mouse collection's id that would pass the command-byte
    // AND checksum tests if it got through — only the collection filter stops it.
    const stray = v8Reply(0x0e, [0, 0, 0, 0, 9]);
    stray[0] = 0x01;
    stray[16] = sharkSum(stray, 16);
    const dev = new FakeDevice(0x3554, 0xf517, 'ATTACK SHARK Mouse', V8_COLLECTIONS, {
      onOutput: (f) => [stray, v8Reply(f[1]!, [0, 0, 0, 0, 1])],
    });
    env.hid = fakeHid([dev]);
    const ch = new HidChannel(
      await candidateFor(0x3554, 0xf517, 0xff02),
      undefined,
      'output-report',
      'shark-sum',
    );

    const reply = await ch.request(v8Query(0x0e), 0x0e);
    expect(reply?.[0]).toBe(0x08);
    expect(reply?.[6]).toBe(1);

    dev.emit(0x01, Uint8Array.from([0, 0, 0, 0, 0, 0, 0]));
    expect(await ch.read(30)).toBeNull();
    await ch.close();
  });

  it('times a silent read out as null', async () => {
    env.hid = fakeHid([new FakeDevice(0x3554, 0xf517, 'ATTACK SHARK Mouse', V8_COLLECTIONS)]);
    const ch = new HidChannel(await candidateFor(0x3554, 0xf517, 0xff02));
    expect(await ch.read(20)).toBeNull();
    await ch.close();
  });

  it('returns report id 0 input without a prefix, as hidapi does', async () => {
    const unnumbered: HIDCollectionInfo[] = [
      { usagePage: 0xff02, usage: 0x02, inputReports: [{ reportId: 0, items: bytes(4) }] },
    ];
    const dev = new FakeDevice(0x3554, 0xf599, 'Other', unnumbered);
    env.hid = fakeHid([dev]);
    await enumerate();
    const handle = await shim.HIDAsync.open('webhid:3554:f599:0:0');
    dev.emit(0, Uint8Array.from([0xaa, 0xbb, 0xcc, 0xdd]));
    expect(Array.from((await handle.read(50)) ?? [])).toEqual([0xaa, 0xbb, 0xcc, 0xdd]);
    await handle.close();
  });
});

describe('feature-report devices (R85HE)', () => {
  const usbVer = () => {
    const f = new Uint8Array(65);
    f.set([0x00, 0x8f, 0x33, 0x0c, 0, 0, 0, 0, 0x11]);
    return f;
  };

  for (const featureIncludesId of [true, false]) {
    it(`answers exactly 65 bytes, id first, when Chromium ${featureIncludesId ? 'keeps' : 'drops'} the id byte`, async () => {
      env.hid = fakeHid([
        new FakeDevice(0x3151, 0x5029, 'R85HE', R85HE_COLLECTIONS, {
          onFeature: (f) => (f[1] === 0x8f ? usbVer() : null),
          featureIncludesId,
        }),
      ]);
      const ch = new HidChannel(
        await candidateFor(0x3151, 0x5029, 0xffff),
        undefined,
        'feature-report',
        'compx-fea',
      );

      const reply = await ch.request(kbQuery(0x8f), 0x8f, 1, 2, true);
      expect(reply?.length).toBe(65);
      expect(Array.from(reply!.subarray(0, 4))).toEqual([0x00, 0x8f, 0x33, 0x0c]);
      await ch.close();
    });
  }

  it('lets the echo filter reject our own SET buffer coming back', async () => {
    env.hid = fakeHid([
      new FakeDevice(0x3151, 0x5029, 'R85HE', R85HE_COLLECTIONS, { onFeature: () => null }),
    ]);
    const ch = new HidChannel(
      await candidateFor(0x3151, 0x5029, 0xffff),
      undefined,
      'feature-report',
      'compx-fea',
    );

    // With the filter on, the echo is not an answer...
    expect(await ch.request(kbQuery(0x8f), 0x8f, 1, 2, true)).toBeNull();
    // ...and it is only the filter that says so: same bytes, same length.
    const echo = await ch.request(kbQuery(0x8f), 0x8f, 1, 2, false);
    expect(Array.from(echo ?? [])).toEqual(Array.from(kbQuery(0x8f)));
    await ch.close();
  });
});

describe('open and close', () => {
  it('opens a device once for several handles and closes it with the last one', async () => {
    const dev = new FakeDevice(0x3151, 0x5029, 'R85HE', R85HE_COLLECTIONS);
    env.hid = fakeHid([dev]);
    await shim.devicesAsync();

    const a = await shim.HIDAsync.open('webhid:3151:5029:0:0');
    const b = await shim.HIDAsync.open('webhid:3151:5029:0:0');
    expect(dev.openCalls).toBe(1);

    await a.close();
    expect(dev.opened).toBe(true);
    await b.close();
    await b.close(); // idempotent
    expect(dev.closeCalls).toBe(1);
    expect(dev.opened).toBe(false);
  });

  it('waits for a pending close before reopening', async () => {
    let release!: () => void;
    const slowClose = new Promise<void>((r) => (release = r));
    const dev = new FakeDevice(0x3151, 0x5029, 'R85HE', R85HE_COLLECTIONS, { slowClose });
    env.hid = fakeHid([dev]);
    await shim.devicesAsync();

    const first = await shim.HIDAsync.open('webhid:3151:5029:0:0');
    const closing = first.close();
    const reopening = shim.HIDAsync.open('webhid:3151:5029:0:0');
    release();
    await closing;
    const second = await reopening; // would be InvalidStateError without the queue
    expect(dev.opened).toBe(true);
    expect(dev.openCalls).toBe(2);
    await second.close();
  });

  it('words an open failure so the manager shows its permission hint', async () => {
    env.hid = fakeHid([
      new FakeDevice(0x3151, 0x5029, 'R85HE', R85HE_COLLECTIONS, {
        openError: new DOMException('Failed to open the device.', 'NotAllowedError'),
      }),
    ]);
    const ch = new HidChannel(await candidateFor(0x3151, 0x5029, 0xffff));
    // The same pattern devices/manager.ts `looksLikePermissionError` applies.
    await expect(ch.open()).rejects.toThrow(
      /EACCES|permission|denied|insufficient|not permitted|privilege|exclusive access/i,
    );
    await expect(ch.open()).rejects.toThrow(/NotAllowedError/);
  });

  it('refuses a path that is no longer connected', async () => {
    env.hid = fakeHid([]);
    await shim.devicesAsync(); // the manager always enumerates before it opens
    await expect(shim.HIDAsync.open('webhid:3151:5029:0:0')).rejects.toThrow(/no longer connected/);
  });

  it('does not blame permissions when the device vanished between scan and open', async () => {
    env.hid = fakeHid([
      new FakeDevice(0x3151, 0x5029, 'R85HE', R85HE_COLLECTIONS, {
        openError: new DOMException('The device is not connected.', 'NotFoundError'),
      }),
    ]);
    await shim.devicesAsync();
    const open = shim.HIDAsync.open('webhid:3151:5029:0:0');
    await expect(open).rejects.toThrow(/no longer connected/);
    await expect(open).rejects.not.toThrow(/permission/);
  });
});

/**
 * The hardware probe, 2026-11-03: Chrome 157 on Windows 11, an R85HE on fw
 * v5.11. `receiveFeatureReport(0)` returned the 64-byte payload WITHOUT the
 * report-id byte, and a GET the firmware ignored came back as our own SET
 * buffer. These are its exact bytes — through the shim and the real driver
 * they must read as the desktop reads them.
 */
describe('R85HE over WebHID, from the bytes Chrome returned', () => {
  /** receiveFeatureReport(0) payloads as captured (no id byte), by command. */
  const CAPTURED: Record<number, number[]> = {
    0x84: [0x84, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x7b], // GET_PROFILE
    0x8f: [0x8f, 0x33, 0x0c, 0x00, 0x00, 0x00, 0x00, 0x11, 0x05], // GET_USB_VERSION
  };

  const capturedBoard = () =>
    new FakeDevice(0x3151, 0x5029, 'R85HE', R85HE_COLLECTIONS, {
      featureIncludesId: false,
      // A wired board leaves GET_RF_VERSION unanswered: the GET sees the echo.
      onFeature: (f) => {
        const payload = CAPTURED[f[1]!];
        if (!payload) return null;
        const full = new Uint8Array(65);
        full.set(payload, 1);
        return full;
      },
    });

  it('reads firmware v5.11, model id 3123 and profile 1 through the real driver', async () => {
    env.hid = fakeHid([capturedBoard()]);
    const channel = new HidChannel(
      await candidateFor(0x3151, 0x5029, 0xffff),
      undefined,
      ATTACK_SHARK_R85HE.transport,
      ATTACK_SHARK_R85HE.checksum,
    );
    const driver = createDriver({
      descriptor: ATTACK_SHARK_R85HE,
      channel,
      onWarning: () => {},
    });

    expect(await driver.getFirmware()).toMatchObject({
      device: 'v5.11',
      receiver: null, // wired: the RF GET only ever saw its own echo
      modelId: 3123,
    });
    expect(await driver.getActiveProfile()).toBe(1);
    await channel.close();
  });
});

describe('helpers', () => {
  it('sizes a report from its items', () => {
    expect(reportBytes({ reportId: 0, items: bytes(64) })).toBe(64);
    expect(reportBytes({ items: [{ reportSize: 1, reportCount: 3 }] })).toBe(1);
    expect(reportBytes({ items: [] })).toBeNull();
    expect(reportBytes(undefined)).toBeNull();
  });

  it('pads a short feature buffer and truncates a long one', () => {
    const short = normalizeFeature(new DataView(new Uint8Array([7, 8]).buffer), 0, 5, null);
    expect(Array.from(short)).toEqual([0, 7, 8, 0, 0]);
    const long = normalizeFeature(new DataView(new Uint8Array(70).fill(1).buffer), 0, 65, 64);
    expect(long.length).toBe(65);
    expect(long[0]).toBe(0);
  });
});
