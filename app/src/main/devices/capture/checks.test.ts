import { describe, expect, it } from 'vitest';
import { buildFrame } from '../../hid/frame';
import { KB_CMD } from '../drivers/compx-keyboard';
import { R98HE_FN_PAGES, r98hePages } from '../r98he-keymap.fixture';
import type { HidMessage } from './hidMessages';
import type { RecordingStep } from './dossier';
import { sharkDeckChecks } from './checks';

/**
 * Shark Deck's driver, run on what an R98 HE recording holds (its key map and
 * Fn layer as the official software read them, then two of its changes), says
 * what is the same and what is not, with no one reading frames.
 */

let t = 0;
/** A frame as the recording holds it: 64 bytes, no report id. */
const frame = (command: number, args: number[], payload: number[] = []) => {
  const f = buildFrame({ reportId: 0, command, args, reportLength: 65, checksum: 'compx-fea' });
  f.set(payload, 9);
  return f.subarray(1);
};
const msg = (kind: HidMessage['kind'], data: Uint8Array): HidMessage => ({
  t: ++t,
  done: null,
  device: '3151:5029',
  iface: 2,
  kind,
  out: true,
  reportId: 0,
  data,
  failed: false,
});
/** The official software reads, and the board answers. */
const read = (query: Uint8Array, answer: number[]) => [
  msg('set-feature', query),
  msg('get-feature', Uint8Array.from([...answer, ...new Array(64 - answer.length).fill(0)])),
];
const step = (id: string, messages: HidMessage[]) => ({
  step: { id, status: 'done', start: '', end: '' } as unknown as RecordingStep,
  messages,
});

describe('sharkDeckChecks', () => {
  it("holds the key map, and makes the R98 HE's changes again frame for frame", async () => {
    const start = [
      ...read(frame(KB_CMD.GET_USB_VERSION, []), [0x8f, 0x9f, 0x0e, 0, 0, 0, 0, 6, 5]),
      ...r98hePages().flatMap((p, i) => read(frame(KB_CMD.GET_KEYMATRIX, [0, 0xff, i, 0]), p)),
      ...r98hePages(R98HE_FN_PAGES).flatMap((p, i) =>
        read(frame(KB_CMD.GET_FN, [0, 0, 0xff, i]), p),
      ),
    ];
    // A remapped to B (slot 9), then Fn + P (slot 62) given B: as the official software sent them.
    const remap = msg('set-feature', frame(KB_CMD.SET_KEYMATRIX, [0, 9, 0, 0, 1, 0], [0, 5, 0, 0]));
    const fn = msg('set-feature', frame(KB_CMD.SET_FN, [0, 0, 0x3e, 0, 0, 0], [0, 5, 0, 0]));
    // A probe the board does not answer: Windows hands the query back.
    const probe = frame(0xfd, []);
    const unknown = read(probe, [...probe]);
    const out = (
      await sharkDeckChecks({
        messages: [...start, remap, fn, ...unknown],
        steps: [step('key.a-b', [remap]), step('key.fn', [fn])],
        devices: [],
      })
    ).join('\n');
    expect(out).toContain('Attack Shark R98 HE (model id 3743).');
    // its slot map is this very recording's: every key types what it says
    expect(out).toContain('Key map: 97 of 97 keys type what its slot map says.');
    expect(out).toContain('key.a-b, remap: the same frame.');
    // one SET_FN frame naming the slot, as the official software sends it
    expect(out).toContain('key.fn, Fn key: the same frame.');
    expect(out).toContain('0xfd (1×, not answered)');
    expect(out).toMatch(/\| Key Remap \(keyRemap\) \| key, knob \| recorded \|/);
    expect(out).toMatch(/\| Macros \(macros\) \| macro \| \*\*not asked\*\* \|/);
  });

  it('says so for a recording of a device it has no check for', async () => {
    const out = await sharkDeckChecks({ messages: [], steps: [], devices: [] });
    expect(out.join('\n')).toContain('no check made here yet');
  });
});

describe('sharkDeckChecks, each change made again', () => {
  /** The board as the official software read it when it opened. */
  const opened = () => [
    ...read(frame(KB_CMD.GET_USB_VERSION, []), [0x8f, 0x9f, 0x0e, 0, 0, 0, 0, 6, 5]),
    ...r98hePages().flatMap((p, i) => read(frame(KB_CMD.GET_KEYMATRIX, [0, 0xff, i, 0]), p)),
  ];
  /** One magnetism page as the board answers its reads: `value` on every slot. */
  const page = (n: number, width: number, value: number) => {
    const bytes = Array.from(
      { length: 128 * width },
      (_, i) => (value >> (8 * (i % width))) & 0xff,
    );
    return Array.from({ length: (128 * width) / 64 }, (_, c) =>
      read(frame(KB_CMD.GET_MULTI_MAGNETISM, [n, 1, c]), bytes.slice(c * 64, c * 64 + 64)),
    ).flat();
  };
  const set = (command: number, args: number[], payload: number[] = []) =>
    msg('set-feature', frame(command, args, payload));
  /** The recording, its messages made in the order they happened. */
  const run = async (
    steps: () => Array<[string, HidMessage[]]>,
    extra: () => HidMessage[] = () => [],
  ) => {
    const start = [...opened(), ...extra()];
    const done = steps();
    return (
      await sharkDeckChecks({
        messages: [...start, ...done.flatMap(([, m]) => m)],
        steps: done.map(([id, m]) => step(id, m)),
        devices: [],
      })
    ).join('\n');
  };

  it('reads a register from the official frame and writes it again, byte for byte', async () => {
    // As Attack Shark Driver v4 sent them to an R98 HE (its owner's recording).
    const out = await run(() => [
      ['poll.back', [set(KB_CMD.SET_REPORT, [0, 2])]],
      ['light.off', [set(KB_CMD.SET_LEDPARAM, [0, 4, 0, 7, 0xfa, 0xff, 0xfa])]],
      ['light.music', [set(KB_CMD.SET_LEDPARAM, [0x16, 4, 4, 0, 0xfa, 0xff, 0xfa])]],
      ['side.off', [set(KB_CMD.SET_SLEDPARAM, [0, 0, 0, 7, 0xfa, 0xff, 0xfa])]],
      ['opt.mistouch', [set(KB_CMD.SET_KBOPTION, [0, 0, 1, 0, 0])]],
      ['profile.2', [set(KB_CMD.SET_PROFILE, [1])]],
    ]);
    expect(out).toContain('poll.back, polling rate 2000 Hz: the same frame.');
    // Off keeps its colour, at the lowest speed and brightness; Music Follow's rainbow is option 0
    expect(out).toContain('light.off, lighting Off: the same frame.');
    expect(out).toContain('light.music, lighting Music (Level): the same frame.');
    expect(out).toContain('side.off, side light Off: the same frame.');
    expect(out).toContain('opt.mistouch, keyboard options: the same frame.');
    expect(out).toContain('profile.2, profile 2: the same frame.');
  });

  it('writes the key-mode zones and the macro again, as the official software did', async () => {
    const out = await run(() => [
      [
        'mt.a',
        [
          set(KB_CMD.SET_KEYMATRIX, [0, 9, 0, 0, 0, 0], [0, 0x04, 0, 0]),
          set(KB_CMD.SET_KEYMATRIX, [0, 9, 0, 0, 1, 1], [0, 0xe0, 0, 0]),
        ],
      ],
      [
        'macro.assign',
        [set(KB_CMD.SET_MACRO, [0, 0, 0x38, 1, 0, 0], [1, 0, 4, 0xbe, 4, 0x64, 5, 0xbb, 5, 0x32])],
      ],
    ]);
    expect(out).toContain('mt.a, key-mode zones: the same 2 frames.');
    expect(out).toContain('macro.assign, macro 1 (4 key steps, repeat 1): the same frame.');
  });

  it('holds a magnetic change to the board it leaves, not to its frames', async () => {
    // The board at 2.0 mm (×200 = 400) everywhere, normal mode, 0.3 mm dead zones.
    const board = () => [
      ...page(7, 1, 0),
      ...page(0, 2, 400),
      ...page(1, 2, 400),
      ...page(6, 2, 60),
      ...page(251, 1, 60),
    ];
    const out = await run(
      () => [
        [
          'act.esc',
          [
            // Esc (slot 0) to 0.97 mm, one key at a time, committed on the last
            set(KB_CMD.SET_MULTI_MAGNETISM, [0, 0, 0, 0, 0, 0], [194, 0]),
            set(KB_CMD.SET_MULTI_MAGNETISM, [1, 0, 0, 1, 0, 0], [194, 0]),
          ],
        ],
        // The official software writing back what the board already holds
        ['act.same', [set(KB_CMD.SET_MULTI_MAGNETISM, [6, 0, 0, 1, 0, 0], [60, 0])]],
      ],
      board,
    );
    expect(out).toContain(
      'act.esc, magnetic settings: the same on the board (official 2 frames, Shark Deck 2).',
    );
    expect(out).toContain('act.same, magnetic settings: nothing changed on the drawn keys');
  });
});
