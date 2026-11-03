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
