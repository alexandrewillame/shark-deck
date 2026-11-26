import { describe, expect, it } from 'vitest';
import type { MagneticKeySettings } from '@shared/types/keyboard-settings';
import { ATTACK_SHARK_R85HE } from '../catalog/r85he';
import { CompxHeKeyboard } from './compx-he-keyboard';

/**
 * A change to many keys goes as whole pages, in Driver v4's frames: an R98
 * HE's recording (2026-11-22) set every key's actuation with
 * `65 00 01 <chunk> 00 00 00 ck` + 56 bytes, chunks 0 to 4 for the two-byte
 * travel page, then the release page, the commit on its last chunk only:
 * `65 01 01 04 01 00 00 93`.
 */
class Board extends CompxHeKeyboard {
  protected override readonly settleMs = 0;
  readonly sent: string[] = [];
  /** Every slot at 2.0 mm (400 units), the factory travel. */
  protected override async readMagnetismPage(page: number): Promise<number[] | null> {
    return new Array(128).fill(page === 0 || page === 1 ? 400 : 0);
  }
  protected override async travelMultiplier(): Promise<number> {
    return 200;
  }
}

const rig = () => {
  const b: Board = new Board({
    descriptor: ATTACK_SHARK_R85HE,
    channel: {
      write: async (f: Uint8Array) =>
        void b.sent.push([...f].map((x) => x.toString(16).padStart(2, '0')).join(' ')),
    } as never,
    onWarning: () => undefined,
  });
  return b;
};

const keys = (mm: number): MagneticKeySettings[] =>
  ATTACK_SHARK_R85HE.spec.keyMatrix!.layout!.map((k) => ({
    row: k.row,
    col: k.col,
    actuationMm: mm,
    releaseMm: mm,
    rapidTrigger: false,
  }));

describe('a change to many keys, written page by page', () => {
  it('sends each page in 56-byte chunks, as Driver v4 does, the commit on the last', async () => {
    const b = rig();
    const r = await b.setMagneticKeys(keys(3.5), keys(2));
    expect(r.ok).toBe(true);
    const heads = b.sent.map((f) => f.split(' ').slice(1, 9).join(' '));
    // Travel, then release: five chunks each, the same headers and sums.
    expect(heads).toEqual([
      '65 00 01 00 00 00 00 99',
      '65 00 01 01 00 00 00 98',
      '65 00 01 02 00 00 00 97',
      '65 00 01 03 00 00 00 96',
      '65 00 01 04 00 00 00 95',
      '65 01 01 00 00 00 00 98',
      '65 01 01 01 00 00 00 97',
      '65 01 01 02 00 00 00 96',
      '65 01 01 03 00 00 00 95',
      '65 01 01 04 01 00 00 93',
    ]);
    // Esc (slot 0) at 3.5 mm = 700 units, little-endian; an unused slot keeps
    // what the board held.
    const travel = b.sent[0]!.split(' ').slice(9);
    expect(travel.slice(0, 2)).toEqual(['bc', '02']);
    expect(travel).toHaveLength(56);
  });

  it('keeps a few keys to their own frames', async () => {
    const b = rig();
    const few = keys(3.5).slice(0, 3);
    await b.setMagneticKeys(few, keys(2).slice(0, 3));
    // Three keys, two pages each: six single-key frames (`65 <page> 00 <slot>`).
    expect(b.sent.map((f) => f.split(' ').slice(1, 4).join(' '))).toHaveLength(6);
    expect(b.sent.every((f) => f.split(' ')[3] === '00')).toBe(true);
  });
});
