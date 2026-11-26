import { describe, expect, it } from 'vitest';
import { CompxKeyboard, fmtVersion, keymatrixArgs, quadFor } from './compx-keyboard';
import { buildFrame } from '../../hid/frame';
import { ATTACK_SHARK_R85HE } from '../catalog/r85he';

/**
 * The vendor renders a raw uint16 firmware value by reading its hex digits as a
 * decimal number (`0x0110` -> "110" -> shown v1.10). This is what replaced the
 * old `v0.00` (which was an echo of our own zero-padded query).
 */
describe('fmtVersion (vendor hex-digits-as-decimal scheme)', () => {
  const cases: Array<[raw: number, out: string]> = [
    [0x0110, 'v1.10'],
    [0x0400, 'v4.00'],
    [0x0300, 'v3.00'],
    [0x0125, 'v1.25'],
    [0x0007, 'v0.07'],
  ];
  for (const [raw, out] of cases) {
    it(`0x${raw.toString(16).padStart(4, '0')} -> ${out}`, () => {
      expect(fmtVersion(raw)).toBe(out);
    });
  }
});

/**
 * SET_USERPIC frame shape, locked against the real capture.
 *
 * These are the seven frames the vendor sent in `13_perkey_colour`
 * (docs/reverse-engineering/session-r85he.jsonl). The two bytes that were
 * missing — the per-chunk payload length at byte 5 and the last-chunk flag at
 * byte 6 — are why painting a key used to write all seven chunks and have the
 * board apply none of them.
 */
describe('SET_USERPIC frames match the R85HE capture', () => {
  // header bytes 0..8 of each captured frame, verbatim
  const CAPTURED = [
    '00 0c 00 ff 00 38 00 00 bc',
    '00 0c 00 ff 01 38 00 00 bb',
    '00 0c 00 ff 02 38 00 00 ba',
    '00 0c 00 ff 03 38 00 00 b9',
    '00 0c 00 ff 04 38 00 00 b8',
    '00 0c 00 ff 05 38 00 00 b7',
    '00 0c 00 ff 06 2a 01 00 c3',
  ];

  const build = (n: number, last: number, len: number, chunk: number[]) =>
    buildFrame({
      reportId: 0x00,
      command: 0x0c,
      args: [0, 0xff, n, len, last, 0, ...chunk],
      reportLength: 65,
      checksum: 'compx-fea',
    });

  it('produces the captured header for all seven chunks', () => {
    const BYTES = 378;
    const CHUNK = 56;
    const chunks = Math.ceil(BYTES / CHUNK);
    expect(chunks).toBe(7);

    for (let n = 0; n < chunks; n++) {
      const len = Math.min(CHUNK, BYTES - n * CHUNK);
      const last = n === chunks - 1 ? 1 : 0;
      const f = build(n, last, len, new Array(CHUNK).fill(0));
      const hdr = [...f.subarray(0, 9)].map((b) => b.toString(16).padStart(2, '0')).join(' ');
      expect(hdr, `chunk ${n}`).toBe(CAPTURED[n]);
    }
  });

  it('the last chunk carries the 42-byte remainder and the commit flag', () => {
    // 6 x 56 + 42 = 378. Getting either byte wrong is silent: the board takes
    // every frame and simply never applies the map.
    expect(6 * 56 + 42).toBe(378);
    const f = build(6, 1, 42, new Array(56).fill(0));
    expect(f[5]).toBe(0x2a); // length of this chunk
    expect(f[6]).toBe(0x01); // last-chunk / commit flag
  });

  it('the 56-byte payload lands at 9..64, clear of the checksum slot', () => {
    const chunk = Array.from({ length: 56 }, (_, i) => (i + 1) & 0xff);
    const f = build(0, 0, 56, chunk);
    expect(f).toHaveLength(65);
    expect(f[8]).toBe(0xbc); // checksum, not payload
    expect([...f.subarray(9, 65)]).toEqual(chunk);
  });
});

/**
 * `SET_KEYMATRIX` frames, byte for byte.
 *
 * The single-zone remap is verified on a real R85HE (layer 0, the quad at
 * frame bytes 9..12 — see docs/protocol/keyboard-compx.md, "Key matrix reads
 * and writes"). Mod-tap and DKS bindings are the same frame with a zone index,
 * so the shared helpers are pinned here first: the remap must not move by a
 * byte when they are reused.
 */
describe('SET_KEYMATRIX frames', () => {
  const remapFrame = async (slot: number, action: string) => {
    const ch = {
      transaction: async (fn: (io: { write: (b: Uint8Array) => Promise<void> }) => unknown) =>
        fn({ write: async () => undefined }),
      write: async () => undefined,
    };
    const d = new CompxKeyboard({
      descriptor: ATTACK_SHARK_R85HE,
      channel: ch as never,
      onWarning: () => undefined,
    });
    const r = await d.setKeyRemap('base', slot, action);
    expect(r.ok, `${slot} ${action}`).toBe(true);
    return r.frames![0]!.split(' ').slice(0, 13).join(' ');
  };

  it.each([
    [9, '05', '00 0a 00 09 00 00 01 00 eb 00 00 05 00'], // A -> B, the hardware check
    [9, '04', '00 0a 00 09 00 00 01 00 eb 00 00 04 00'], // and back to A
    [71, '45', '00 0a 00 47 00 00 01 00 ad 00 00 45 00'], // F12, as captured
    [18, 'e5', '00 0a 00 12 00 00 01 00 e2 00 00 e5 00'],
    [36, '00e30007', '00 0a 00 24 00 00 01 00 d0 00 e3 00 07'], // a raw quad, verbatim
  ])('slot %i <- %s', async (slot, action, frame) => {
    expect(await remapFrame(slot, action)).toBe(frame);
  });

  // Each profile keeps its own base layer: Driver v4 reads an R98 HE's two
  // (`8a 00 ff …`, `8a 01 ff …`), and they differ exactly where its owner
  // swapped Insert and Delete on one (the 2026-11-22 recording). Shark Deck
  // read and wrote profile 0's, whatever the board was on.
  describe('the base layer of the profile the board is on', () => {
    class Board extends CompxKeyboard {
      protected override readonly settleMs = 0;
      protected override backupPaceMs = 0;
      override async readPerKeyLighting() {
        return null;
      }
      override async readMacros() {
        return [];
      }
    }
    const rig = (profile: number) => {
      const board = { profile, sent: [] as string[] };
      const hex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, '0')).join(' ');
      const answer = (cmd: number) =>
        cmd === 0x84 ? Uint8Array.from([0, 0x84, board.profile, 0, 0, 0, 0, 0, 0]) : null;
      const io = {
        write: async (b: Uint8Array) => {
          board.sent.push(hex(b.subarray(0, 13)));
          if (b[1] === 0x04) board.profile = b[2]!;
        },
        read: async () => new Uint8Array(65),
        request: async (_f: Uint8Array, cmd: number) => answer(cmd),
      };
      const ch = {
        ...io,
        transaction: async (fn: (x: typeof io) => unknown) => fn(io),
      };
      const d = new Board({
        descriptor: ATTACK_SHARK_R85HE,
        channel: ch as never,
        onWarning: () => undefined,
      });
      return { d, board };
    };

    it('reads and writes the base layer of profile 2 when the board is on it', async () => {
      const { d, board } = rig(1);
      await d.readKeyBindings('base');
      const reads = board.sent.filter((f) => f.startsWith('00 8a'));
      expect(reads).toHaveLength(8);
      expect(reads.every((f) => f.slice(6, 11) === '01 ff')).toBe(true);
      board.sent.length = 0;
      await d.setKeyRemap('base', 9, '05');
      expect(board.sent[0]).toBe('00 0a 01 09 00 00 01 00 ea 00 00 05 00');
    });

    it('follows a switch: the next remap goes to the profile switched to', async () => {
      const { d, board } = rig(1);
      expect((await d.setActiveProfile(1)).ok).toBe(true);
      board.sent.length = 0;
      await d.setKeyRemap('base', 9, '05');
      expect(board.sent[0]).toBe('00 0a 00 09 00 00 01 00 eb 00 00 05 00');
    });

    it('backs up every profile’s base layer and puts each back on its own', async () => {
      const { d, board } = rig(0);
      const blocks = await d.backup();
      // The R85HE keeps four.
      expect(Object.keys(blocks).filter((k) => k.startsWith('keymatrix_base'))).toEqual([
        'keymatrix_base',
        'keymatrix_base_2',
        'keymatrix_base_3',
        'keymatrix_base_4',
      ]);
      board.sent.length = 0;
      const key = (code: string) => JSON.stringify({ 9: { kind: 'key', code } });
      await d.restoreFromBackup({ keymatrix_base: key('05'), keymatrix_base_2: key('06') });
      expect(board.sent.filter((f) => f.startsWith('00 0a')).map((f) => f.slice(6, 11))).toEqual([
        '00 09',
        '01 09',
      ]);
    });
  });

  it('builds the zone frames of a multi-zone binding from the same pieces', () => {
    expect(quadFor('05')).toEqual([0, 0, 5, 0]);
    expect(quadFor('00e30007')).toEqual([0, 0xe3, 0, 7]);
    expect(quadFor('')).toBeNull();
    expect(quadFor('xyz')).toBeNull();
    expect(keymatrixArgs(9, [0, 0, 5, 0], { commit: false, zone: 2 })).toEqual([
      0, 9, 0, 0, 0, 2, 0, 0, 5, 0,
    ]);
  });
});
