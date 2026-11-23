import { describe, expect, it } from 'vitest';
import type { Macro } from '@shared/types/macros';
import type { DeviceDescriptor } from '@shared/types/device';
import type { HidChannel } from '../../hid/transport';
import { KEYBOARDS_BY_ID } from '../catalog/keyboards';
import {
  CompxKeyboard,
  KB_MACRO_MAX_STEPS,
  decodeMacro,
  encodeMacro,
  macroPayloadOf,
} from './compx-keyboard';

/**
 * The keyboard's macros, held to what Attack Shark Driver v4 wrote to an R98
 * HE (its owner's, 2026-11-22): the recording's "a" then "b", and the three
 * macros its owner made there afterwards and read back off the board.
 */
const hex = (s: string) => s.split(' ').map((h) => parseInt(h, 16));
const pad = (b: number[], n = 64) => [...b, ...new Array(n - b.length).fill(0)];
/** The recording's two SET_MACRO frames, report id off. */
const RECORDED_ONCE = pad(hex('0b 00 00 38 01 00 00 bb 01 00 04 be 04 64 05 bb 05 32'));
const RECORDED_THRICE = pad(hex('0b 00 00 38 01 00 00 bb 03 00 04 be 04 64 05 bb 05 32'));

/** Fn + N*: "a", then "b" held 1.6 s, then "c" held 1.7 s — long waits in two more bytes. */
const LONG = hex('01 00 04 80 f2 00 04 00 dd 04 05 80 32 06 05 00 68 07 06 80 90 06 06 32');
/** Fn + N-: "bababababa", typed rolling. */
const ROLLING = hex(
  '01 00 05 9a 04 b6 05 2c 04 00 af 00 05 b3 04 ae 05 2b 04 00 00 01 05 9f 04 bf 05 2c 04 00 d3 00 05 a2 04 c4 05 27 04 00 ce 00 05 97 04 b3 05 22 04 32',
);
/** Fn + N/: "This is a test. Will this work? Who knows!" — 198 bytes, Shift and all. */
const SENTENCE = hex(
  '01 00 e1 ce 17 db 17 47 e1 60 0b c1 0b 2b 0c d7 0c 1a 16 c6 16 30 2c dc 2c 78 0c d8 0c 1d 16 d1 16 18 2c e9 2c 22 04 c4 04 33 2c e0 2c 42 17 b9 08 bf 17 05 16 dc 08 01 17 88 16 50 17 68 37 c9 37 3e 2c ad e1 cb 2c 26 1a c7 1a 1d e1 5f 0c c3 0c 00 8b 00 0f b4 0f 38 0f c4 2c 81 0f 5b 17 81 2c 28 0b a2 17 21 0b 19 0c ce 0c 18 16 ca 16 10 2c cf 2c 31 1a ca 1a 08 12 c6 12 20 15 c6 15 0f 0e bb e1 91 0e 30 23 c8 23 00 9e 00 2c df 2c 00 4a 01 1a d2 1a 77 e1 00 8e 01 0b c2 0b 5f 12 b3 12 59 2c da 2c 10 0e cf 0e 48 11 d1 11 32 12 cd 12 0a 1a e2 1a 5f 16 d7 16 69 e1 80 c9 00 1e e6 1e 00 62 01 e1 32',
);

const key = (action: 'down' | 'up', value: string) => ({ type: 'key' as const, action, value });
const wait = (ms: number) => ({ type: 'delay' as const, ms });

const AB: Macro = {
  id: 'onboard',
  name: 'T1',
  repeatCount: 1,
  steps: [
    key('down', '04'),
    wait(62),
    key('up', '04'),
    wait(100),
    key('down', '05'),
    wait(59),
    key('up', '05'),
    wait(50),
  ],
};

describe('macro wire encoding', () => {
  it('reads the recorded macro: key events with their waits, and the repeat count', () => {
    expect(decodeMacro('onboard', 'T1', macroPayloadOf([RECORDED_ONCE]))).toEqual(AB);
    expect(decodeMacro('onboard', 'T1', macroPayloadOf([RECORDED_THRICE])).repeatCount).toBe(3);
  });

  it('reads a long wait from the two bytes after an event whose own wait is 0', () => {
    expect(decodeMacro('m', 'm', LONG).steps).toEqual([
      key('down', '04'),
      wait(242),
      key('up', '04'),
      wait(1245),
      key('down', '05'),
      wait(1586),
      key('up', '05'),
      wait(1896),
      key('down', '06'),
      wait(1680),
      key('up', '06'),
      wait(50),
    ]);
  });

  it("writes the official software's macros back byte for byte", () => {
    for (const bytes of [LONG, ROLLING, SENTENCE, hex('01 00 04 be 04 64 05 bb 05 32')]) {
      expect(encodeMacro(decodeMacro('m', 'm', bytes))).toEqual(bytes);
    }
    expect(encodeMacro({ ...AB, repeatCount: 3 }).slice(0, 2)).toEqual([3, 0]);
    expect(encodeMacro({ ...AB, repeatCount: 0 }).slice(0, 2)).toEqual([1, 0]);
  });

  it('writes no wait, or one over 127 ms, in the two bytes after the event', () => {
    const buf = encodeMacro({
      ...AB,
      steps: [
        wait(40), // before any event: nowhere to go
        key('down', '04'),
        key('down', '05'), // no wait between: a two-byte 0, never an own-byte 0
        wait(30),
        wait(20),
        key('up', '04'),
        wait(3000),
        key('up', '05'),
      ],
    });
    expect(buf).toEqual(hex('01 00 04 80 00 00 05 b2 04 00 b8 0b 05 00 00 00'));
    expect(decodeMacro('m', 'm', buf).steps).toEqual([
      key('down', '04'),
      key('down', '05'),
      wait(50),
      key('up', '04'),
      wait(3000),
      key('up', '05'),
    ]);
  });

  // Pointer motion and mouse buttons have no event in this payload: left out,
  // never a phantom "press usage 0x00" the board would replay.
  it('leaves out a step it cannot write, rather than a phantom key', () => {
    const buf = encodeMacro({
      ...AB,
      steps: [
        key('down', '04'),
        { type: 'move', dx: 30, dy: -12 },
        { type: 'mouse', action: 'down', value: 1 },
        key('up', '04'),
        wait(5),
      ],
    });
    expect(decodeMacro('m', 'm', buf).steps).toEqual([key('down', '04'), key('up', '04'), wait(5)]);
  });

  it('stops reading at the end of the events, and at unwritten flash', () => {
    expect(decodeMacro('m', 'm', [1, 0, 4, 0x81, 0, 0, 5, 0x81]).steps).toHaveLength(2);
    expect(decodeMacro('m', 'm', [1, 0, 4, 0x81, 0xff, 0xff]).steps).toHaveLength(2);
  });

  it("never writes past its own slot's four chunks", () => {
    const steps = Array.from({ length: 300 }, (_, i) => [
      key(i % 2 ? 'up' : 'down', '04'),
      wait(500),
    ]).flat();
    expect(encodeMacro({ ...AB, steps }).length).toBeLessThanOrEqual(4 * 56);
    expect(KB_MACRO_MAX_STEPS).toBe(110);
  });
});

describe('saveMacro', () => {
  it('sends the frame the official software sends: one 56-byte chunk, flagged last', async () => {
    const sent: Uint8Array[] = [];
    const ch = {
      transaction: <T>(fn: (io: unknown) => Promise<T>) =>
        fn({ write: async (f: Uint8Array) => void sent.push(f), read: async () => null }),
      write: async (f: Uint8Array) => void sent.push(f),
      read: async () => null,
      request: async () => null,
    } as unknown as HidChannel;
    class Quiet extends CompxKeyboard {
      protected override readonly settleMs = 0;
    }
    const d = KEYBOARDS_BY_ID.get(3743) as DeviceDescriptor;
    const drv = new Quiet({ descriptor: d, channel: ch, onWarning: () => {} });
    await drv.saveMacro({ ...AB, repeatCount: 3 });
    const macros = sent.filter((f) => f[1] === 0x0b).map((f) => Array.from(f.subarray(1)));
    expect(macros).toEqual([RECORDED_THRICE]);
  });
});

describe('readMacros', () => {
  it('reads every macro on the board, each only as far as its events run', async () => {
    // The owner's R98 HE: three macros in slots 0-2 (the long one runs into
    // a fourth page), slot 3 empty, unwritten flash from slot 4.
    const SLOTS = [LONG, ROLLING, SENTENCE, []];
    const page = (n: number): number[] => {
      const slot = Math.floor(n / 4);
      if (slot >= SLOTS.length) return new Array(64).fill(0xff);
      const bytes = pad(SLOTS[slot]!, 256);
      return bytes.slice((n % 4) * 64, (n % 4) * 64 + 64);
    };
    const asked: number[] = [];
    let last: Uint8Array | null = null;
    const io = {
      write: async (f: Uint8Array) => {
        last = f;
        expect([f[1], f[2]]).toEqual([0x8b, 0]);
        asked.push(f[3]!);
      },
      read: async () => Uint8Array.from([0, ...page(last![3]!)]),
    };
    const ch = {
      transaction: <T>(fn: (x: unknown) => Promise<T>) => fn(io),
    } as unknown as HidChannel;
    class Quiet extends CompxKeyboard {
      protected override readonly settleMs = 0;
    }
    const drv = new Quiet({
      descriptor: KEYBOARDS_BY_ID.get(3743) as DeviceDescriptor,
      channel: ch,
      onWarning: () => {},
    });
    const macros = await drv.readMacros();
    expect(macros.map((m) => [m.id, m.name])).toEqual([
      ['onboard-0', 'Macro 1'],
      ['onboard-1', 'Macro 2'],
      ['onboard-2', 'Macro 3'],
    ]);
    expect(macros.map((m) => encodeMacro(m))).toEqual([LONG, ROLLING, SENTENCE]);
    // a page for each short macro, four for the 198-byte one, one for the
    // empty slot, one for the unwritten flash after it
    expect(asked).toEqual([0, 4, 8, 9, 10, 11, 12, 16]);
  });
});

describe('macro slots', () => {
  const frames = () => {
    const sent: Uint8Array[] = [];
    const ch = {
      transaction: <T>(fn: (io: unknown) => Promise<T>) =>
        fn({ write: async (f: Uint8Array) => void sent.push(f), read: async () => null }),
      write: async (f: Uint8Array) => void sent.push(f),
      read: async () => null,
      request: async () => null,
    } as unknown as HidChannel;
    class Quiet extends CompxKeyboard {
      protected override readonly settleMs = 0;
    }
    const drv = new Quiet({
      descriptor: KEYBOARDS_BY_ID.get(3743) as DeviceDescriptor,
      channel: ch,
      onWarning: () => {},
    });
    const macroFrames = () =>
      sent.filter((f) => f[1] === 0x0b).map((f) => Array.from(f.subarray(1)));
    return { drv, macroFrames };
  };

  // An R98 HE (2026-11-23): written with the slot byte at 3, 15, 31 and 63, a
  // macro landed in that slot and nowhere else.
  it('writes the slot it is given in frame byte 1, and refuses one past the 64th', async () => {
    const { drv, macroFrames } = frames();
    await drv.saveMacro(AB, 3);
    expect(macroFrames().map((f) => f.slice(0, 5))).toEqual([[0x0b, 3, 0, 0x38, 1]]);
    expect((await drv.saveMacro(AB, 64)).ok).toBe(false);
  });

  it('checks a push by reading its own slot, even past unwritten ones', async () => {
    // The owner's R98 HE (2026-11-23): a macro in slot 1, unwritten flash
    // after it, a push to slot 64. The list stops at slot 2; the push's check
    // reads slot 64's own pages, and only them.
    const flash: number[] = new Array(64 * 256).fill(0xff);
    pad(LONG, 256).forEach((b, i) => (flash[i] = b));
    const asked: number[] = [];
    let last: Uint8Array | null = null;
    const io = {
      write: async (f: Uint8Array) => {
        last = f;
        if (f[1] === 0x8b) asked.push(f[3]!);
        // SET_MACRO: slot, chunk, then 56 bytes of data from byte 9
        if (f[1] === 0x0b)
          f.slice(9, 9 + 56).forEach((b, i) => (flash[f[2]! * 256 + f[3]! * 56 + i] = b));
      },
      read: async () => Uint8Array.from([0, ...flash.slice(last![3]! * 64, last![3]! * 64 + 64)]),
    };
    const ch = {
      transaction: <T>(fn: (x: unknown) => Promise<T>) => fn(io),
    } as unknown as HidChannel;
    class Quiet extends CompxKeyboard {
      protected override readonly settleMs = 0;
    }
    const drv = new Quiet({
      descriptor: KEYBOARDS_BY_ID.get(3743) as DeviceDescriptor,
      channel: ch,
      onWarning: () => {},
    });
    const r = await drv.saveMacro(AB, 63);
    expect(r.verified).toBe('match');
    expect(asked).toEqual([252]);
    expect((await drv.readMacros()).map((m) => m.id)).toEqual(['onboard-0']);
  });

  it('always closes the events, even when they fill a chunk exactly', async () => {
    // 27 events with short waits: 2 + 54 = 56 bytes, a whole chunk
    const steps = Array.from({ length: 27 }, (_, i) => [
      key(i % 2 ? 'up' : 'down', '04'),
      wait(5),
    ]).flat();
    const { drv, macroFrames } = frames();
    await drv.saveMacro({ ...AB, steps });
    const sent = macroFrames();
    expect(sent.map((f) => [f[2], f[4]])).toEqual([
      [0, 0],
      [1, 1],
    ]);
    // the second chunk starts with the empty event that ends them
    expect(sent[1]!.slice(8, 10)).toEqual([0, 0]);
  });

  it('empties a slot with an empty macro there', async () => {
    const { drv, macroFrames } = frames();
    await drv.deleteMacro('onboard-2');
    expect(macroFrames()).toEqual([pad(hex('0b 02 00 38 01 00 00 b9 01 00'))]);
    expect((await drv.deleteMacro('library-uuid')).ok).toBe(false);
  });
});
