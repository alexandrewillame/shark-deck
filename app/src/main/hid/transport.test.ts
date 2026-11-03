import { beforeEach, describe, expect, it, vi } from 'vitest';

// `mock*` prefix is required for vitest to allow the reference inside the factory.
const mockDevicesAsync = vi.fn();
const mockOpen = vi.fn();

vi.mock('node-hid', () => ({
  default: {
    devicesAsync: (...args: unknown[]) => mockDevicesAsync(...args),
    HID: class {},
    HIDAsync: { open: (...args: unknown[]) => mockOpen(...args) },
  },
}));

import {
  enumerate,
  findVendorCollection,
  lastHidError,
  HidChannel,
  type HidCandidate,
} from './transport';

const SAMPLE = [
  // R85HE keyboard — vendor config collection + its plain keyboard collection
  {
    path: 'kb-cfg',
    vendorId: 0x3151,
    productId: 0x5029,
    usagePage: 0xffff,
    usage: 0x02,
    interface: 2,
    product: 'R85HE',
  },
  {
    path: 'kb-hid',
    vendorId: 0x3151,
    productId: 0x5029,
    usagePage: 0x0001,
    usage: 0x06,
    interface: 0,
    product: 'R85HE',
  },
  // V8 mouse dongle — vendor config collection
  {
    path: 'ms-cfg',
    vendorId: 0x3554,
    productId: 0xf517,
    usagePage: 0xff02,
    usage: 0x02,
    interface: 1,
    product: 'ATTACK SHARK Mouse',
  },
  // an unrelated device that must never leak through a VID filter
  {
    path: 'other',
    vendorId: 0x046d,
    productId: 0xc52b,
    usagePage: 0x0001,
    usage: 0x06,
    interface: 0,
    product: 'Unifying Receiver',
  },
];

beforeEach(() => {
  mockDevicesAsync.mockReset();
  mockDevicesAsync.mockResolvedValue(SAMPLE);
});

describe('enumerate()', () => {
  it('one-arg (vid only) — the call shape that used to throw — filters without passing args to node-hid', async () => {
    const out = await enumerate(0x3151);

    expect(out.map((c) => c.path)).toEqual(['kb-cfg', 'kb-hid']);
    expect(out.every((c) => c.vendorId === 0x3151)).toBe(true);
    // node-hid v3 only accepts zero args or (vid, pid); we must always call it with none.
    expect(mockDevicesAsync).toHaveBeenCalledTimes(1);
    expect(mockDevicesAsync).toHaveBeenCalledWith();
  });

  it('no args returns every collection on the bus', async () => {
    expect(await enumerate()).toHaveLength(SAMPLE.length);
  });

  it('(vid, pid) narrows to the exact device', async () => {
    const out = await enumerate(0x3554, 0xf517);
    expect(out).toHaveLength(1);
    expect(out[0]!.path).toBe('ms-cfg');
  });

  it('maps missing path / interface to safe defaults', async () => {
    mockDevicesAsync.mockResolvedValue([{ vendorId: 0x3151, productId: 0x5029 }]);
    const [c] = await enumerate(0x3151);
    expect(c).toMatchObject({ path: '', interface: -1 });
  });

  it('swallows a node-hid throw, returns [] and records lastHidError()', async () => {
    mockDevicesAsync.mockImplementation(() => {
      throw new Error('unexpected number of arguments to HID.devicesAsync() call');
    });

    expect(await enumerate(0x3151)).toEqual([]);
    expect(lastHidError()).toContain('unexpected number of arguments');
  });

  it('swallows a rejected devicesAsync() the same way', async () => {
    mockDevicesAsync.mockRejectedValue(new Error('boom-async'));
    expect(await enumerate()).toEqual([]);
    expect(lastHidError()).toBe('boom-async');
  });

  it('clears lastHidError() after a subsequent clean scan', async () => {
    mockDevicesAsync.mockImplementationOnce(() => {
      throw new Error('boom');
    });
    await enumerate();
    expect(lastHidError()).toBe('boom');

    await enumerate();
    expect(lastHidError()).toBeNull();
  });
});

describe('findVendorCollection()', () => {
  it('picks the usagePage+usage match from an already-fetched list, without calling node-hid again', () => {
    mockDevicesAsync.mockClear();
    const vc = findVendorCollection(SAMPLE, 0x3151, 0x5029, 0xffff, 0x02);
    expect(vc?.path).toBe('kb-cfg');
    expect(mockDevicesAsync).not.toHaveBeenCalled();
  });

  it('falls back to any usagePage match for the vid/pid if the exact usage is absent', () => {
    const vc = findVendorCollection(SAMPLE, 0x3151, 0x5029, 0xffff, 0x99);
    expect(vc?.path).toBe('kb-cfg');
  });

  it('returns null when nothing matches the vid/pid', () => {
    expect(findVendorCollection(SAMPLE, 0x9999, 0x1, 0, 0)).toBeNull();
  });
});

describe('HidChannel serializes concurrent operations', () => {
  it("never interleaves two concurrent request() calls' write/read pairs", async () => {
    const events: string[] = [];
    let pendingCommand = 0;
    const fakeDev = {
      write: vi.fn(async (bytes: number[]) => {
        pendingCommand = bytes[1]!;
        events.push(`write:${pendingCommand}`);
        // Delay so a broken (unlocked) implementation has room to let the
        // second call's write land before this call's read.
        await new Promise((r) => setTimeout(r, 5));
        return bytes.length;
      }),
      read: vi.fn(async () => {
        await new Promise((r) => setTimeout(r, 5));
        events.push(`read:${pendingCommand}`);
        return Buffer.from([0, pendingCommand]);
      }),
      sendFeatureReport: vi.fn(async () => 0),
      getFeatureReport: vi.fn(async () => Buffer.alloc(0)),
      close: vi.fn(async () => undefined),
    };
    mockOpen.mockResolvedValue(fakeDev);

    const candidate: HidCandidate = { path: 'p', vendorId: 1, productId: 2, interface: 0 };
    const ch = new HidChannel(candidate);
    const [r1, r2] = await Promise.all([
      ch.request(Uint8Array.from([0, 0xaa]), 0xaa, 1, 1),
      ch.request(Uint8Array.from([0, 0xbb]), 0xbb, 1, 1),
    ]);

    expect(r1 && Array.from(r1)).toEqual([0, 0xaa]);
    expect(r2 && Array.from(r2)).toEqual([0, 0xbb]);
    // The write/read pair for one request completes before the other's write
    // ever starts — never write,write,read,read.
    expect(events).toEqual(['write:170', 'read:170', 'write:187', 'read:187']);
  });

  it('transaction() runs a multi-frame sequence atomically against other calls', async () => {
    const events: string[] = [];
    const fakeDev = {
      write: vi.fn(async (bytes: number[]) => {
        events.push(`write:${bytes[1]}`);
        await new Promise((r) => setTimeout(r, 2));
        return bytes.length;
      }),
      read: vi.fn(async () => {
        await new Promise((r) => setTimeout(r, 2));
        return Buffer.from([0, 0]);
      }),
      sendFeatureReport: vi.fn(async () => 0),
      getFeatureReport: vi.fn(async () => Buffer.alloc(0)),
      close: vi.fn(async () => undefined),
    };
    mockOpen.mockResolvedValue(fakeDev);

    const candidate: HidCandidate = { path: 'p', vendorId: 1, productId: 2, interface: 0 };
    const ch = new HidChannel(candidate);

    await Promise.all([
      ch.transaction(async (io) => {
        await io.write(Uint8Array.from([0, 1]));
        await io.write(Uint8Array.from([0, 2]));
        await io.write(Uint8Array.from([0, 3]));
      }),
      ch.write(Uint8Array.from([0, 99])),
    ]);

    // The lone write() never lands between the transaction's three chunks.
    expect(events).toEqual(['write:1', 'write:2', 'write:3', 'write:99']);
  });
});

/**
 * These boards do not checksum their replies. Byte 8 of a reply is whatever our
 * query left in the buffer — our query's own checksum — unless the reply's data
 * runs past byte 8, in which case it is data. Recomputing a checksum over the
 * reply therefore rejects exactly the replies that carry information.
 *
 * This is not academic: rejecting `GET_USB_VERSION` made `getFirmware()` return
 * null forever, which pinned the magnetic travel multiplier at its 10 fallback
 * instead of 200 — every actuation value off by 20x in both directions. See
 * ENFORCE_COMPX_FEA_REPLY_CHECKSUM in transport.ts.
 */
describe('compx-fea replies are not checksummed', () => {
  const fakeWith = (reply: number[]) => ({
    write: vi.fn(async () => 0),
    read: vi.fn(async () => Buffer.alloc(0)),
    readTimeout: vi.fn(async () => Buffer.alloc(0)),
    sendFeatureReport: vi.fn(async () => 0),
    getFeatureReport: vi.fn(async () => Buffer.from(reply)),
    close: vi.fn(async () => undefined),
  });

  const candidate: HidCandidate = {
    path: 'kb-cfg',
    vendorId: 0x3151,
    productId: 0x5029,
    interface: 2,
  };

  it('accepts a real GET_USB_VERSION reply whose byte 8 is firmware data', async () => {
    // verbatim from an R85HE, fw v5.11: model id 0x0c33, version 0x0511.
    // A recomputed checksum would demand 0x31 at byte 8; the board sends 0x11.
    const reply = [0x00, 0x8f, 0x33, 0x0c, 0x00, 0x00, 0x00, 0x00, 0x11, 0x05];
    mockOpen.mockResolvedValue(fakeWith(reply));
    const ch = new HidChannel(candidate, undefined, 'feature-report', 'compx-fea');

    const got = await ch.request(Uint8Array.from([0x00, 0x8f]), 0x8f, 1, 1, true);

    expect(got).not.toBeNull();
    expect(got![2]! | (got![3]! << 8)).toBe(3123); // model id
    expect(got![8]! | (got![9]! << 8)).toBe(0x0511); // firmware
    await ch.close();
  });

  it('still filters on the command byte', async () => {
    mockOpen.mockResolvedValue(fakeWith([0x00, 0x84, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x7b]));
    const ch = new HidChannel(candidate, undefined, 'feature-report', 'compx-fea');
    // asking for 0x8f but the device answers 0x84 -> no match
    expect(await ch.request(Uint8Array.from([0x00, 0x8f]), 0x8f, 1, 1)).toBeNull();
    await ch.close();
  });
});

describe('HidChannel.close() is final', () => {
  const fakeDev = () => ({
    write: vi.fn(async (b: number[]) => b.length),
    read: vi.fn(async () => Buffer.from([0, 0])),
    sendFeatureReport: vi.fn(async () => 0),
    getFeatureReport: vi.fn(async () => Buffer.alloc(0)),
    close: vi.fn(async () => undefined),
  });
  const candidate: HidCandidate = { path: 'p', vendorId: 1, productId: 2, interface: 0 };

  beforeEach(() => mockOpen.mockClear());

  it('an operation queued before close() cannot re-open the handle afterwards', async () => {
    // The hot-unplug bug: the manager's prune sweep stopped the travel stream
    // (queueing a write), then fire-and-forget closed the channel and dropped
    // the entry. The queued write reached ensureOpen() *after* close() had
    // nulled the handle and re-opened one that nothing could ever close —
    // and on Windows that stale handle blocks the next open() on the same
    // path, so a replugged device was never picked up again.
    const dev = fakeDev();
    mockOpen.mockResolvedValue(dev);
    const ch = new HidChannel(candidate);
    await ch.open();
    expect(mockOpen).toHaveBeenCalledTimes(1);

    const queued = ch.write(Uint8Array.from([0, 1])).catch((e) => e as Error);
    await ch.close();
    await queued;

    expect(await queued).toBeInstanceOf(Error);
    expect(mockOpen).toHaveBeenCalledTimes(1); // never re-opened
    expect(ch.isDisposed()).toBe(true);
    expect(ch.isOpen()).toBe(false);
  });

  it('rejects every later operation instead of silently reconnecting', async () => {
    mockOpen.mockResolvedValue(fakeDev());
    const ch = new HidChannel(candidate);
    await ch.open();
    await ch.close();
    mockOpen.mockClear();

    await expect(ch.write(Uint8Array.from([0, 1]))).rejects.toThrow(/closed/);
    await expect(ch.read()).rejects.toThrow(/closed/);
    expect(mockOpen).not.toHaveBeenCalled();
  });

  it("returns even when node-hid's own close() never settles", async () => {
    const dev = { ...fakeDev(), close: vi.fn(() => new Promise<void>(() => undefined)) };
    mockOpen.mockResolvedValue(dev);
    const ch = new HidChannel(candidate);
    await ch.open();

    // Bounded by CLOSE_TIMEOUT_MS — a device yanked mid-operation must not
    // wedge the caller (the scan loop awaits this).
    await expect(
      Promise.race([
        ch.close().then(() => 'closed'),
        new Promise((r) => setTimeout(() => r('hung'), 3000)),
      ]),
    ).resolves.toBe('closed');
    expect(ch.isDisposed()).toBe(true);
  });

  it('is idempotent', async () => {
    const dev = fakeDev();
    mockOpen.mockResolvedValue(dev);
    const ch = new HidChannel(candidate);
    await ch.open();
    await ch.close();
    await ch.close();
    expect(dev.close).toHaveBeenCalledTimes(1);
  });
});

/**
 * The Fn-layer freeze, as a test.
 *
 * hidapi's Windows feature-report path is structurally unbounded —
 * `hid_get_feature_report` waits on `GetOverlappedResult(…, TRUE)` with no
 * timeout to pass down — so a firmware that stops answering used to leave the
 * promise pending forever. node-hid serialises jobs per handle natively, so
 * everything queued behind it (the manager's ping, every other tab's read, the
 * write path, even `close()`) never ran either: one wedged read froze the whole
 * app, and the board needed a power-cycle.
 */
describe('a native op that never settles', () => {
  const candidate: HidCandidate = {
    path: 'kb-cfg',
    vendorId: 0x3151,
    productId: 0x5029,
    interface: 2,
  };
  const never = () => new Promise<never>(() => undefined);
  /** Small deadline so these run on real timers in milliseconds. */
  const opts = { opTimeoutMs: 25 };

  const wedgingDev = () => ({
    write: vi.fn(async () => 1),
    read: vi.fn(never),
    getFeatureReport: vi.fn(never),
    sendFeatureReport: vi.fn(async () => 1),
    close: vi.fn(async () => undefined),
  });

  it('rejects inside the deadline instead of hanging, and kills the channel', async () => {
    const dev = wedgingDev();
    mockOpen.mockResolvedValue(dev);
    const ch = new HidChannel(candidate, undefined, 'feature-report', 'compx-fea', opts);

    await expect(ch.read(250, 65)).rejects.toThrow(/wedged/);
    expect(ch.isWedged()).toBe(true);
    expect(ch.isDisposed()).toBe(true);
    // Fire-and-forget: node-hid queues CloseWorker behind the stuck job, so
    // awaiting it would hang exactly as the original bug did.
    expect(dev.close).toHaveBeenCalledTimes(1);
  });

  it('reports the wedge once, through onWedged', async () => {
    mockOpen.mockResolvedValue(wedgingDev());
    const onWedged = vi.fn();
    const ch = new HidChannel(candidate, undefined, 'feature-report', 'compx-fea', {
      ...opts,
      onWedged,
    });

    await expect(ch.read(250, 65)).rejects.toThrow(/wedged/);
    await expect(ch.read(250, 65)).rejects.toThrow(/closed/);
    expect(onWedged).toHaveBeenCalledTimes(1);
  });

  it('an 8-chunk sweep stops at the first chunk instead of queueing seven more', async () => {
    const dev = wedgingDev();
    mockOpen.mockResolvedValue(dev);
    const ch = new HidChannel(candidate, undefined, 'feature-report', 'compx-fea', opts);

    // The shape of `readMatrixChunks` — the Fn-layer read that froze the app.
    const results = await Promise.allSettled(Array.from({ length: 8 }, () => ch.read(250, 65)));

    expect(results.every((r) => r.status === 'rejected')).toBe(true);
    // Exactly one reached the device; the other seven short-circuit at ensureOpen()
    // on the poisoned channel rather than piling onto node-hid's queue.
    expect(dev.getFeatureReport).toHaveBeenCalledTimes(1);
  });

  it('does not poison an op that answers just inside the deadline', async () => {
    const dev = {
      ...wedgingDev(),
      getFeatureReport: vi.fn(async () => {
        await new Promise((r) => setTimeout(r, 5));
        return Buffer.from([0, 0x87, 1, 2]);
      }),
    };
    mockOpen.mockResolvedValue(dev);
    const ch = new HidChannel(candidate, undefined, 'feature-report', 'compx-fea', opts);

    expect(Array.from((await ch.read(250, 65))!)).toEqual([0, 0x87, 1, 2]);
    expect(ch.isWedged()).toBe(false);
  });

  it('a wedge aborts a transaction rather than being read as an empty reply', async () => {
    mockOpen.mockResolvedValue(wedgingDev());
    const ch = new HidChannel(candidate, undefined, 'feature-report', 'compx-fea', opts);

    // `readUnlocked` folds every other error into `null`, which callers treat
    // as a soft miss worth another frame. The wedge must be the one that
    // escapes, or a paged reader keeps sweeping a dead handle.
    await expect(
      ch.transaction(async (io) => {
        await io.write(Uint8Array.from([0, 0x90]));
        return io.read(250, 65);
      }),
    ).rejects.toThrow(/wedged/);
  });
});

describe('request() pacing in feature-report mode', () => {
  const candidate: HidCandidate = {
    path: 'kb-cfg',
    vendorId: 0x3151,
    productId: 0x5029,
    interface: 2,
  };

  const silentDev = () => ({
    write: vi.fn(async () => 1),
    read: vi.fn(async () => Buffer.alloc(0)),
    // A GET the firmware never answers — the shape that used to burn the full
    // 3 x 6 budget unpaced and trip the endpoint lockup.
    getFeatureReport: vi.fn(async () => Buffer.alloc(0)),
    sendFeatureReport: vi.fn(async () => 1),
    close: vi.fn(async () => undefined),
  });

  it('caps the reads per attempt once pacing is on', async () => {
    const dev = silentDev();
    mockOpen.mockResolvedValue(dev);
    const ch = new HidChannel(candidate, undefined, 'feature-report', 'compx-fea', {
      requestPaceMs: 1,
    });

    expect(await ch.request(Uint8Array.from([0, 0x80]), 0x80, 2, 6)).toBeNull();
    // 2 attempts x FEATURE_MAX_POLL_READS, not 2 x 6.
    expect(dev.getFeatureReport).toHaveBeenCalledTimes(4);
  });

  it('leaves the unpaced (output-report) path exactly as it was', async () => {
    const dev = silentDev();
    mockOpen.mockResolvedValue(dev);
    const ch = new HidChannel(candidate, undefined, 'output-report', 'none', { requestPaceMs: 1 });

    expect(await ch.request(Uint8Array.from([0, 0x80]), 0x80, 2, 6)).toBeNull();
    // An empty read breaks the inner loop in output-report mode: 1 read each.
    expect(dev.read).toHaveBeenCalledTimes(2);
  });
});

/**
 * `request()`'s `accept` predicate.
 *
 * Command-byte matching is not enough for a command that reads more than one
 * thing — the V8 reads every region-A offset with `0x08`, so an answer for a
 * different offset passes both the command-byte and checksum tests while
 * carrying the wrong bytes. And there really are foreign frames in the queue:
 * Windows delivers input reports to every open handle, so the vendor Hub
 * polling the same mouse is enough on its own.
 */
describe('request() can narrow beyond the command byte', () => {
  const candidate: HidCandidate = { path: 'v8', vendorId: 0x3554, productId: 0xf517, interface: 1 };

  /** `08 08 00 <off_hi> <off_lo> <len> <fill…>` with a valid shark checksum. */
  const blockReply = (offset: number, len: number, fill: number) => {
    const f = Buffer.alloc(17);
    f[0] = 0x08;
    f[1] = 0x08;
    f[3] = (offset >> 8) & 0xff;
    f[4] = offset & 0xff;
    f[5] = len;
    f.fill(fill, 6, 6 + len);
    let sum = 0;
    for (let i = 0; i < 16; i++) sum += f[i]!;
    f[16] = (0x55 - sum) & 0xff;
    return f;
  };
  const forOffset = (offset: number, len: number) => (r: Uint8Array) =>
    (((r[3] ?? 0) << 8) | (r[4] ?? 0)) === offset && (r[5] ?? 0) === len;

  const devReading = (frames: Buffer[]) => ({
    write: vi.fn(async () => 1),
    read: vi.fn(async () => frames.shift() ?? Buffer.alloc(0)),
    getFeatureReport: vi.fn(async () => Buffer.alloc(0)),
    sendFeatureReport: vi.fn(async () => 1),
    close: vi.fn(async () => undefined),
  });

  it('skips a reply for another offset and takes the one it asked for', async () => {
    const dev = devReading([blockReply(0x0060, 2, 0xff), blockReply(0x0002, 2, 0x03)]);
    mockOpen.mockResolvedValue(dev);
    const ch = new HidChannel(candidate, undefined, 'output-report', 'shark-sum');

    const reply = await ch.request(
      Uint8Array.from([0x08, 0x08]),
      0x08,
      3,
      6,
      false,
      forOffset(0x0002, 2),
    );
    expect(reply?.[6]).toBe(0x03);
  });

  it('accepts that same first frame when nothing narrows it — the old behaviour', async () => {
    const dev = devReading([blockReply(0x0060, 2, 0xff), blockReply(0x0002, 2, 0x03)]);
    mockOpen.mockResolvedValue(dev);
    const ch = new HidChannel(candidate, undefined, 'output-report', 'shark-sum');

    // This is the bug: bytes from 0x0060 returned as the answer about 0x0002.
    const reply = await ch.request(Uint8Array.from([0x08, 0x08]), 0x08, 3, 6);
    expect(reply?.[6]).toBe(0xff);
  });

  it('returns null rather than the wrong frame when the right one never comes', async () => {
    const dev = devReading([blockReply(0x0060, 2, 0xff)]);
    mockOpen.mockResolvedValue(dev);
    const ch = new HidChannel(candidate, undefined, 'output-report', 'shark-sum');

    expect(
      await ch.request(Uint8Array.from([0x08, 0x08]), 0x08, 2, 6, false, forOffset(0x0002, 2)),
    ).toBeNull();
  });
});
