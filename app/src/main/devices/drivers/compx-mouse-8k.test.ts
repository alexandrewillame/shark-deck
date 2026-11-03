import { describe, expect, it } from 'vitest';
import type { HidChannel } from '../../hid/transport';
import { ATTACK_SHARK_V8, ATTACK_SHARK_V8_WIRED } from '../catalog/v8';
import { V8_BLOCK, V8_CMD, companion, dpiLedSpeedToWire } from '@shared/mouse-wire';
import { CompxMouse8K } from './compx-mouse-8k';

/**
 * A stand-in for the V8's region-A memory, driven by the same `0x07` write /
 * `0x08` read frames the driver really emits.
 *
 * The one thing it can do that real hardware can't be asked to do on demand is
 * *refuse* a chosen offset — which is exactly the case these tests exist for:
 * an `inferred` offset the firmware may not own, sitting next to
 * `verified-capture` ones that work.
 */
function fakeChannel(
  opts: {
    rejects?: number[];
    seed?: Record<number, number>;
    /** Which command, if any, answers a receiver-LED read with a real triple.
     *  'none' makes both give the generic ACK the real 0x2C probe returns. */
    rxAnswers?: 'get' | 'echo' | 'none';
    /** What the receiver's LEDs are set to before anything is written. */
    rxState?: [number, number, number];
    /** Answer the LED read with something that is not a plausible triple. */
    rxGarbage?: boolean;
    /** `bcdDevice` from the USB descriptor — the RECEIVER's version when the
     *  dongle enumerated, the mouse's own when the cable did. */
    release?: number;
    /** What the mouse answers `0x12` with, as a raw uint16. `null` stands for
     *  a dozing mouse: the dongle ACKs the command but nothing comes back
     *  from the other side of the link. */
    deviceVersion?: number | null;
    /** Byte 6 of the `0x03` status reply — the "mouse is awake" bit. */
    awake?: boolean;
    /** Cell millivolts in the `0x04` reply. `null` = no reply at all, which
     *  is what the capture shows while the 2.4 GHz link is down: the dongle
     *  keeps ACKing its own commands but nothing comes back for this one. */
    batteryMillivolts?: number | null;
  } = {},
) {
  const rejects = new Set(opts.rejects ?? []);
  const mem = new Map<number, number>(
    Object.entries(opts.seed ?? {}).map(([k, v]) => [Number(k), v]),
  );
  const writes: { offset: number; bytes: number[] }[] = [];
  const rxAnswers = opts.rxAnswers ?? 'get';
  let rx: [number, number, number] = opts.rxState ?? [3, 0, 2]; // the capture's own triple

  const at = (offset: number) => mem.get(offset) ?? 0;

  /** `08 XX 01 00 00 00 …` — the generic ACK shape FINDINGS documents for a
   *  command the firmware does not answer with data. */
  const ack = (cmd: number) => {
    const out = new Uint8Array(17);
    out[0] = 0x08;
    out[1] = cmd;
    out[2] = 0x01;
    return out;
  };
  const triple = (cmd: number) => {
    const out = new Uint8Array(17);
    out[0] = 0x08;
    out[1] = cmd;
    out[5] = 0x0a;
    const vals = opts.rxGarbage ? [0x7f, 0x7f, 0x7f] : rx;
    out[6] = vals[0]!;
    out[7] = vals[1]!;
    out[8] = vals[2]!;
    return out;
  };

  const apply = (frame: Uint8Array) => {
    if (frame[1] === V8_CMD.RX_LED) {
      rx = [frame[6] ?? 0, frame[7] ?? 0, frame[8] ?? 0];
      return;
    }
    // `08 07 00 <off_hi> <off_lo> <len> <bytes…>`
    const offset = ((frame[3] ?? 0) << 8) | (frame[4] ?? 0);
    const len = frame[5] ?? 0;
    const bytes = Array.from(frame.subarray(6, 6 + len));
    writes.push({ offset, bytes });
    if (rejects.has(offset)) return; // firmware ignores it; the old value stands
    bytes.forEach((b, i) => mem.set(offset + i, b));
  };

  /** `08 12 00 00 00 02 <major> <minor>` — the mouse's own version reply. */
  const versionReply = (raw: number) => {
    const out = new Uint8Array(17);
    out[0] = 0x08;
    out[1] = V8_CMD.DEVICE_VERSION;
    out[5] = 0x02;
    out[6] = (raw >> 8) & 0xff;
    out[7] = raw & 0xff;
    return out;
  };

  const replyTo = (frame: Uint8Array): Uint8Array => {
    const cmd = frame[1] ?? 0;
    if (cmd === V8_CMD.RX_LED_GET) return rxAnswers === 'get' ? triple(cmd) : ack(cmd);
    if (cmd === V8_CMD.RX_LED) return rxAnswers === 'echo' ? triple(cmd) : ack(cmd);
    if (cmd === V8_CMD.DEVICE_VERSION) {
      const raw = opts.deviceVersion === undefined ? 0x303 : opts.deviceVersion;
      // A dozing mouse leaves the dongle to answer, and the dongle's answer to
      // a command it does not own is the generic ACK — which is precisely why
      // the driver discriminates on byte 2 rather than on getting a reply.
      return raw === null ? ack(cmd) : versionReply(raw);
    }
    if (cmd === V8_CMD.BATTERY) {
      const mv = opts.batteryMillivolts === undefined ? 4000 : opts.batteryMillivolts;
      if (mv === null) return ack(cmd);
      const out = new Uint8Array(17);
      out[0] = 0x08;
      out[1] = V8_CMD.BATTERY;
      out[5] = 0x08;
      out[6] = 80;
      out[8] = (mv >> 8) & 0xff;
      out[9] = mv & 0xff;
      return out;
    }
    if (cmd === V8_CMD.STATUS) {
      const out = new Uint8Array(17);
      out[0] = 0x08;
      out[1] = V8_CMD.STATUS;
      out[6] = opts.awake === false ? 0 : 1;
      return out;
    }
    // `08 08 00 <off_hi> <off_lo> <len>` -> echo header + `len` bytes at byte 6
    const offset = ((frame[3] ?? 0) << 8) | (frame[4] ?? 0);
    const len = frame[5] ?? 0;
    const out = new Uint8Array(6 + len);
    out[0] = 0x08;
    out[1] = V8_CMD.READ_BLOCK;
    out[3] = frame[3] ?? 0;
    out[4] = frame[4] ?? 0;
    out[5] = len;
    for (let i = 0; i < len; i++) out[6 + i] = at(offset + i);
    return out;
  };

  /**
   * Frames queued to be handed back INSTEAD of the real answer, once each —
   * how a foreign `0x08` reply (our own concurrent sweep, or the vendor Hub
   * on its own handle) is injected into the read stream. The real channel
   * treats a rejected frame as "no reply yet" and keeps polling, so the
   * fake does too: a stale frame delays the answer, never replaces it.
   */
  const intrude: Uint8Array[] = [];

  const answer = (query: Uint8Array, accept?: (r: Uint8Array) => boolean): Uint8Array | null => {
    while (intrude.length) {
      const stray = intrude.shift()!;
      if (!accept || accept(stray)) return stray;
    }
    return replyTo(query);
  };

  const io = {
    write: async (frame: Uint8Array) => void apply(frame),
    read: async () => null,
    readInput: async () => null,
    request: async (
      query: Uint8Array,
      _cmd?: number,
      _attempts?: number,
      _reads?: number,
      _rejectEcho?: boolean,
      accept?: (r: Uint8Array) => boolean,
    ) => answer(query, accept),
  };

  const ch = {
    request: async (
      query: Uint8Array,
      _cmd?: number,
      _attempts?: number,
      _reads?: number,
      _rejectEcho?: boolean,
      accept?: (r: Uint8Array) => boolean,
    ) => answer(query, accept),
    write: async (frame: Uint8Array) => void apply(frame),
    transaction: async <T>(fn: (x: typeof io) => Promise<T>) => fn(io),
    descriptorRelease: opts.release,
  } as unknown as HidChannel;

  /** Queue a well-formed region-A reply for a DIFFERENT offset. */
  const intrudeBlock = (offset: number, len: number, fill: number) => {
    const out = new Uint8Array(6 + len);
    out[0] = 0x08;
    out[1] = V8_CMD.READ_BLOCK;
    out[3] = (offset >> 8) & 0xff;
    out[4] = offset & 0xff;
    out[5] = len;
    out.fill(fill, 6);
    intrude.push(out);
  };

  return { ch, mem, writes, at, rxNow: () => rx, intrudeBlock };
}

function driver(ch: HidChannel, warn: (m: string) => void = () => undefined) {
  return new CompxMouse8K({ descriptor: ATTACK_SHARK_V8, channel: ch, onWarning: warn });
}
function wiredDriver(ch: HidChannel) {
  return new CompxMouse8K({
    descriptor: ATTACK_SHARK_V8_WIRED,
    channel: ch,
    onWarning: () => undefined,
  });
}

/**
 * The bug this locks down: `setDpiLed` folded the speculative 0x50 write into
 * the same `worst()` as the capture-verified 0x4C/0x4E ones, so one byte the
 * firmware may not even own reported a *mismatch* for two writes that landed —
 * and did it while also emitting two `warn` toasts of its own, on top of the
 * renderer's. One action, three warnings, two of them false.
 */
describe('setDpiLed keeps speculative offsets out of the verdict', () => {
  it('reports match, one note, and no warnings when only 0x50 is refused', async () => {
    const warnings: string[] = [];
    const { ch, at, writes } = fakeChannel({
      rejects: [V8_BLOCK.DPI_LED_SPEED, V8_BLOCK.DPI_LED_FLAG],
    });
    const r = await driver(ch, (m) => warnings.push(m)).setDpiLed({
      effect: 2,
      brightness: 100,
      speed: 100,
    });

    expect(r.ok).toBe(true);
    expect(r.verified).toBe('match'); // 0x4C and 0x4E both landed
    expect(r.note).toMatch(/breathing speed/);
    expect(warnings).toEqual([]); // the driver no longer toasts for these
    // the confirmed fields really were written, not merely reported as written
    expect(at(V8_BLOCK.DPI_LED_EFFECT)).toBe(2);
    expect(at(V8_BLOCK.DPI_LED_BRIGHT)).toBe(255);
    // and the speculative ones were still attempted, with the diff still run
    expect(writes.some((w) => w.offset === V8_BLOCK.DPI_LED_SPEED)).toBe(true);
    expect(writes.some((w) => w.offset === V8_BLOCK.DPI_LED_FLAG)).toBe(true);
  });

  it('carries no note at all when the speculative offsets do stick', async () => {
    const { ch } = fakeChannel();
    const r = await driver(ch).setDpiLed({ effect: 2, brightness: 50, speed: 50 });
    expect(r.verified).toBe('match');
    expect(r.note).toBeUndefined();
  });

  it('stays silent about the 0x52 flag, which is not a setting anyone asked for', async () => {
    const warnings: string[] = [];
    const { ch } = fakeChannel({ rejects: [V8_BLOCK.DPI_LED_FLAG] });
    // no `speed` — so the ONLY refused write is the internal Hub-mirror flag
    const r = await driver(ch, (m) => warnings.push(m)).setDpiLed({ effect: 1, brightness: 80 });
    expect(r.verified).toBe('match');
    expect(r.note).toBeUndefined();
    expect(warnings).toEqual([]);
  });

  it('still reports a mismatch when a CONFIRMED offset is refused', async () => {
    const warnings: string[] = [];
    const { ch } = fakeChannel({ rejects: [V8_BLOCK.DPI_LED_BRIGHT] });
    const r = await driver(ch, (m) => warnings.push(m)).setDpiLed({ effect: 1, brightness: 80 });
    expect(r.verified).toBe('mismatch');
    // the generic warning is only suppressed for speculative offsets
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/0x4e/);
  });

  it('writes the speed through the shared codec, with its companion byte', async () => {
    const { ch, at } = fakeChannel();
    await driver(ch).setDpiLed({ effect: 2, brightness: 100, speed: 100 });
    const wire = at(V8_BLOCK.DPI_LED_SPEED);
    expect(wire).toBe(dpiLedSpeedToWire(100));
    expect(at(V8_BLOCK.DPI_LED_SPEED + 1)).toBe(companion(wire)); // per-field integrity byte
  });
});

/**
 * The receiver-LED read. The old code sent a zero-length `0x2C` probe and
 * accepted it only if it declared >= 3 bytes — but `0x2C` answers that probe
 * with the generic ACK (declared length 0) in every capture, so the check
 * failed 100% of the time and a cold start always fell through to `null`,
 * which the renderer renders as "Couldn't read this from the device". The
 * device was answering fine; the command was just the wrong one.
 */
describe('readReceiverLed', () => {
  it('reads the live triple from 0x2D, the command the Hub itself polls', async () => {
    const { ch } = fakeChannel({ rxAnswers: 'get', rxState: [3, 0, 2] });
    const r = await driver(ch).readReceiverLed();
    expect(r.indications).toEqual([3, 0, 2]);
    expect(r.source).toBe('device');
  });

  it('falls back to the 0x2C len-0x0a read shape when 0x2D stays quiet', async () => {
    const { ch } = fakeChannel({ rxAnswers: 'echo', rxState: [1, 2, 3] });
    const r = await driver(ch).readReceiverLed();
    expect(r.indications).toEqual([1, 2, 3]);
    expect(r.source).toBe('device');
  });

  it('rejects the generic ACK instead of decoding its zeroes as "all off"', async () => {
    const { ch } = fakeChannel({ rxAnswers: 'none' });
    const r = await driver(ch).readReceiverLed();
    expect(r.source).toBe('unreadable');
  });

  it('rejects a reply whose bytes are not plausible indications', async () => {
    const { ch } = fakeChannel({ rxAnswers: 'get', rxGarbage: true });
    expect((await driver(ch).readReceiverLed()).source).toBe('unreadable');
  });

  it('never returns null — an unreadable receiver is not a read failure', async () => {
    const { ch } = fakeChannel({ rxAnswers: 'none' });
    const r = await driver(ch).readReceiverLed();
    // `null` is precisely what useDeviceData registers as a failed read.
    expect(r).not.toBeNull();
    expect(r.indications).toEqual([0, 0, 0]);
  });

  it('reports this run’s own last write when nothing reads back', async () => {
    const { ch } = fakeChannel({ rxAnswers: 'none' });
    const d = driver(ch);
    await d.setReceiverLed({ indications: [2, 3, 4] });
    const r = await d.readReceiverLed();
    expect(r.indications).toEqual([2, 3, 4]);
    expect(r.source).toBe('lastWrite');
  });

  it('reports a previous run’s value from the scratchpad, labelled as such', async () => {
    const { ch } = fakeChannel({ rxAnswers: 'none' });
    const d = new CompxMouse8K({
      descriptor: ATTACK_SHARK_V8,
      channel: ch,
      onWarning: () => undefined,
      state: { get: async () => ({ indications: [1, 1, 1] }), set: async () => undefined },
    });
    const r = await d.readReceiverLed();
    expect(r.indications).toEqual([1, 1, 1]);
    expect(r.source).toBe('cache');
  });
});

/** This write had no read-back at all before — it always claimed success. */
describe('setReceiverLed verifies against the receiver', () => {
  it('confirms a write that the receiver reports back', async () => {
    const { ch, rxNow } = fakeChannel({ rxAnswers: 'get' });
    const r = await driver(ch).setReceiverLed({ indications: [4, 1, 0] });
    expect(r.verified).toBe('match');
    expect(rxNow()).toEqual([4, 1, 0]);
  });

  it('stays honestly unverified when no read answers', async () => {
    const { ch } = fakeChannel({ rxAnswers: 'none' });
    const r = await driver(ch).setReceiverLed({ indications: [4, 1, 0] });
    expect(r.ok).toBe(true);
    expect(r.verified).toBe('unverified');
  });
});

/**
 * Mouse angle mode — offset 0xBD, `verified-capture` 2026-09-10.
 *
 * Found by hooking the vendor Hub's own writes while its slider was dragged,
 * because no write/read-back sweep could have: 0xB3 (the earlier guess) and
 * every other unclaimed slot in that run accept a write and hand it straight
 * back while the mouse's angle never moves. The frames below are the ones the
 * Hub actually emitted, so they double as the encoding's provenance.
 */
describe('mouse angle mode', () => {
  // step -> [value, companion] exactly as captured in session-v8-angle.jsonl
  const CAPTURED: [number, number, number][] = [
    [15, 0x0f, 0x46],
    [30, 0x1e, 0x37],
    [-15, 0xf1, 0x64],
    [-30, 0xe2, 0x73],
    [0, 0x00, 0x55],
  ];

  it('writes the exact bytes the vendor Hub emitted for each slider position', async () => {
    for (const [deg, value, comp] of CAPTURED) {
      const { ch, writes } = fakeChannel();
      const r = await driver(ch).setSensor({ angleDegrees: deg });
      expect(writes, `${deg}deg`).toEqual([
        { offset: V8_BLOCK.ANGLE_DEGREES, bytes: [value, comp] },
      ]);
      expect(r.verified, `${deg}deg`).toBe('match');
      expect(r.note, `${deg}deg`).toBeUndefined();
    }
  });

  it('round-trips every position through a read', async () => {
    for (const [deg] of CAPTURED) {
      const { ch } = fakeChannel();
      await driver(ch).setSensor({ angleDegrees: deg });
      const sensor = (await driver(ch).readSensor())!;
      expect(sensor.angleDegrees, `${deg}deg`).toBe(deg);
      // angleMode is derived, not its own bit: "off" is just 0 degrees.
      expect(sensor.angleMode, `${deg}deg`).toBe(deg !== 0);
    }
  });

  it('reports a refused angle as a failure, not a footnote', async () => {
    // It is a verified offset now, so a mismatch is a real problem and must
    // reach `worst()` rather than being softened into a note the way the
    // speculative DPI-LED speed still is.
    const { ch } = fakeChannel({ rejects: [V8_BLOCK.ANGLE_DEGREES] });
    const r = await driver(ch).setSensor({ angleDegrees: 20 });
    expect(r.verified).toBe('mismatch');
  });

  it('clamps out-of-range degrees instead of wrapping the byte', async () => {
    const { ch, at } = fakeChannel();
    await driver(ch).setSensor({ angleDegrees: 99 });
    expect(at(V8_BLOCK.ANGLE_DEGREES)).toBe(0x1e); // +30, the slider maximum
    const { ch: ch2, at: at2 } = fakeChannel();
    await driver(ch2).setSensor({ angleDegrees: -99 });
    expect(at2(V8_BLOCK.ANGLE_DEGREES)).toBe(0xe2); // -30
  });

  it('does not touch the angle on a sensor write that did not include one', async () => {
    // The UI posts the whole merged object, so this is the common case: only
    // the toggle the user moved may reach the wire with a stale angle beside
    // it, and a seeded angle must survive untouched when omitted.
    const { ch, writes, at } = fakeChannel({ seed: { [V8_BLOCK.ANGLE_DEGREES]: 0x0f } });
    await driver(ch).setSensor({ motionSync: true });
    expect(writes.some((w) => w.offset === V8_BLOCK.ANGLE_DEGREES)).toBe(false);
    expect(at(V8_BLOCK.ANGLE_DEGREES)).toBe(0x0f);
  });
});

/**
 * The bug behind "Setting 0x2 did not read back as written" on a write that
 * demonstrably landed.
 *
 * Region A is read with ONE command byte for every offset in it, and
 * `HidChannel.request` matched replies on that byte alone — so any other
 * `0x08` answer in the read queue was accepted as the answer to whatever we
 * asked last, and its bytes were then diffed against what we had just written.
 * Two sources put one there: our own concurrent reads (a 22-frame `regionA()`
 * sweep beside a write's read-back), and the vendor Mouse Hub polling the same
 * mouse — Windows hands every input report to every open handle, which the
 * user hits precisely because checking the Hub is how you confirm a change.
 * `DPI_STAGE_COUNT` is the offset it showed up on because `setDpiStages`
 * writes it first, when a sweep is most likely to still be in flight.
 */
describe('a region-A reply is matched by offset, not just by command byte', () => {
  it('does not report a mismatch when a foreign 0x08 reply arrives first', async () => {
    const warnings: string[] = [];
    const { ch, at, intrudeBlock } = fakeChannel({ seed: { [V8_BLOCK.DPI_STAGE_COUNT]: 6 } });
    // A well-formed answer for a different offset, carrying bytes that would
    // never match a stage-count write — exactly the shape a Hub sweep leaves.
    intrudeBlock(0x0060, 2, 0xff);
    const r = await new CompxMouse8K({
      descriptor: ATTACK_SHARK_V8,
      channel: ch,
      onWarning: (m) => warnings.push(m),
    }).setActiveDpiStage(1);

    expect(r.verified).toBe('match');
    expect(warnings).toEqual([]);
    expect(at(V8_BLOCK.ACTIVE_DPI_STAGE)).toBe(1);
  });

  it('still reports a real mismatch — the filter narrows, it does not excuse', async () => {
    const { ch } = fakeChannel({ rejects: [V8_BLOCK.POLL_RATE] });
    expect((await driver(ch).setPollRate(1000)).verified).toBe('mismatch');
  });

  it('does not let a stray reply feed the wrong bytes into a read', async () => {
    const { ch, intrudeBlock } = fakeChannel({ seed: { [V8_BLOCK.POLL_RATE]: 0x01 } });
    intrudeBlock(0x0100, 10, 0x40); // 0x40 would decode as 8000 Hz
    expect(await driver(ch).readPollRate()).toBe(1000);
  });

  it('accepts a reply that does echo the offset and length it asked for', async () => {
    const { ch } = fakeChannel({ seed: { [V8_BLOCK.POLL_RATE]: 0x20 } });
    expect(await driver(ch).readPollRate()).toBe(4000);
  });
});

/**
 * Where each firmware version actually comes from.
 *
 * Two sources, not one. The RECEIVER's version is `bcdDevice` off whichever
 * endpoint enumerated. The MOUSE's version is command `0x12`, which it answers
 * itself — on the cable and over the air alike, which is how the vendor Hub
 * shows a wireless mouse's version and what the 2026-09-08 hardware probe
 * confirmed (`08 12 …` -> `03 03` through a dongle whose own `bcdDevice` is
 * `0x300`). Command `0x02` still carries nothing and must never be decoded
 * again; it was simply never the command the Hub used.
 */
describe('getFirmware: the receiver from the descriptor, the mouse from 0x12', () => {
  it('reads the mouse over the 2.4G dongle, alongside the receiver descriptor', async () => {
    // 0x300 is what the real V8 dongle (3554:F517) reports; the mouse behind
    // it answers 0x303 — the two genuinely differ, which is the whole point.
    const { ch } = fakeChannel({ release: 0x300, deviceVersion: 0x303 });
    const fw = await driver(ch).getFirmware();
    expect(fw.receiver).toBe('v3.00');
    expect(fw.receiverRaw).toBe(0x300);
    expect(fw.device).toBe('v3.03');
    expect(fw.deviceRaw).toBe(0x303);
    expect(fw.readState).toBe('ok');
  });

  it('says "asleep", not "no reply", when the link has nobody listening on it', async () => {
    const { ch } = fakeChannel({ release: 0x300, deviceVersion: null });
    const fw = await driver(ch).getFirmware();
    expect(fw.receiver).toBe('v3.00'); // the dongle is still right there
    expect(fw.device).toBeNull();
    // The difference the UI hangs a "move the mouse" hint on.
    expect(fw.readState).toBe('asleep');
  });

  it('never mistakes the dongle generic ACK for a version of 0.00', async () => {
    // `08 12 01 00 …` has a reply and a plausible length; only byte 2 says it
    // is an ACK rather than a payload.
    const { ch } = fakeChannel({ release: 0x300, deviceVersion: null });
    expect((await driver(ch).getFirmware()).device).toBeNull();
  });

  it('caches the version so a later doze keeps showing it', async () => {
    const { ch } = fakeChannel({ release: 0x300, deviceVersion: 0x303 });
    const d = driver(ch);
    expect((await d.getFirmware()).device).toBe('v3.03');
    // The mouse goes to sleep: ping() latches lastAwake=false, which gates the
    // on-air read. The already-known version must survive that.
    const { ch: dozing } = fakeChannel({ release: 0x300, deviceVersion: null, awake: false });
    const d2 = new CompxMouse8K({
      descriptor: ATTACK_SHARK_V8,
      channel: dozing,
      onWarning: () => undefined,
    });
    await d2.ping();
    expect((await d2.getFirmware()).readState).toBe('asleep');
  });

  it('skips the on-air read entirely once ping() has seen the mouse dozing', async () => {
    const { ch, writes } = fakeChannel({ release: 0x300, awake: false });
    const d = driver(ch);
    await d.ping();
    const before = writes.length;
    await d.getFirmware();
    // Nothing sent: a sleeping mouse costs the full retry budget to learn
    // nothing, the same bail-out readLiveState() makes.
    expect(writes.length).toBe(before);
  });

  it('reports the cable endpoint as the DEVICE, with no receiver row to fill', async () => {
    // The same mouse on 3554:F515 reports 0x303 from its own descriptor.
    const { ch } = fakeChannel({ release: 0x303, deviceVersion: 0x303 });
    const fw = await wiredDriver(ch).getFirmware();
    expect(fw.device).toBe('v3.03');
    expect(fw.deviceRaw).toBe(0x303);
    expect(fw.receiver).toBeNull();
    expect(fw.readState).toBe('ok');
  });

  it('falls back to the cable descriptor when the wire read comes up empty', async () => {
    const { ch } = fakeChannel({ release: 0x303, deviceVersion: null });
    const fw = await wiredDriver(ch).getFirmware();
    expect(fw.device).toBe('v3.03'); // on the cable the endpoint IS the mouse
    expect(fw.readState).toBe('ok');
  });

  it('uses the vendor hex-digits-as-decimal scheme, not plain hex', async () => {
    const { ch } = fakeChannel({ release: 0x303, deviceVersion: 0x303 });
    expect((await wiredDriver(ch).getFirmware()).device).toBe('v3.03');
  });

  it('reports nothing rather than a fake version when neither source answers', async () => {
    const { ch } = fakeChannel({ deviceVersion: null });
    const fw = await driver(ch).getFirmware();
    expect(fw.receiver).toBeNull();
    expect(fw.device).toBeNull();
  });
});

/**
 * "DPI level" (wire 4) is not offered in the Receiver LED picker, but a
 * receiver already set to it by the vendor tool must still decode — otherwise
 * removing it from the UI would turn a perfectly readable device into an
 * "unreadable" one. RX_LED_WIRE is the wire truth; the picker filters.
 */
describe('an indication the UI does not offer still decodes', () => {
  it('accepts wire value 4 from the device', async () => {
    const { ch } = fakeChannel({ rxAnswers: 'get', rxState: [4, 0, 2] });
    const r = await driver(ch).readReceiverLed();
    expect(r.source).toBe('device');
    expect(r.indications).toEqual([4, 0, 2]);
  });
});

/**
 * Pairing completion.
 *
 * The old implementation polled `0x06`, which this receiver never answers
 * (17 writes / 0 replies in the capture), so it returned `null` on every poll
 * and the pane fell back to `LiveDevice.online` — a dongle-presence signal
 * that says nothing about the link, and reported "Paired" about a second
 * after the button press whether or not anything had been paired.
 */
describe('getPairingStatus probes the link, not the dongle', () => {
  it('is null when the receiver itself does not answer 0x03', async () => {
    const { ch } = fakeChannel();
    const silent = { ...ch, request: async () => null } as unknown as HidChannel;
    expect(await driver(silent).getPairingStatus()).toBeNull();
  });

  it('reports the link down while the RF-active bit is clear', async () => {
    const { ch } = fakeChannel({ awake: false });
    expect(await driver(ch).getPairingStatus()).toEqual({ linked: false });
  });

  it('reports the link up only once the mouse itself answers', async () => {
    const { ch } = fakeChannel({ awake: true, batteryMillivolts: 3980 });
    expect(await driver(ch).getPairingStatus()).toEqual({ linked: true });
  });

  it('does not trust the status bit on its own', async () => {
    // Awake bit set but no battery reply: nothing has come back from the far
    // side of the link, so this must not read as a completed pairing.
    const { ch } = fakeChannel({ awake: true, batteryMillivolts: null });
    expect(await driver(ch).getPairingStatus()).toEqual({ linked: false });
  });

  it('never sends 0x06', async () => {
    const sent: number[] = [];
    const { ch } = fakeChannel({ awake: true, batteryMillivolts: 3980 });
    const spy = {
      ...ch,
      request: async (q: Uint8Array, ...rest: unknown[]) => {
        sent.push(q[1] ?? 0);
        return (ch.request as (...a: unknown[]) => Promise<Uint8Array | null>)(q, ...rest);
      },
    } as unknown as HidChannel;
    await driver(spy).getPairingStatus();
    expect(sent).not.toContain(V8_CMD.PAIR_STATUS);
    expect(sent).toContain(V8_CMD.STATUS);
  });
});
