import { describe, expect, it } from 'vitest';
import { ANSI_75, ANSI_79_SG9047 } from './layouts';
import type { KeyLayoutEntry } from './types/keys';

/**
 * `ANSI_75` is the board the app DRAWS when a descriptor carries no matrix of
 * its own — the home card's keyboard art, and every synthetic family in
 * `registry.ts`. `ANSI_79_SG9047` is the real R85HE, extracted from the vendor.
 *
 * They have to look like the same kind of keyboard, because they sit next to
 * each other in the device grid. They did not: the generic one had a full-width
 * function row with no cluster gaps, a `Home`/`End` pair the real board does
 * not have, and no gap before the arrow cluster.
 */

const rowsOf = (keys: KeyLayoutEntry[]) => [...new Set(keys.map((k) => k.y))].sort((a, b) => a - b);
const widthsOf = (keys: KeyLayoutEntry[]) =>
  rowsOf(keys).map((y) => Math.max(...keys.filter((k) => k.y === y).map((k) => k.x + (k.w ?? 1))));

describe('the generic layout mirrors the real one', () => {
  it('has the same number of keys', () => {
    expect(ANSI_75).toHaveLength(ANSI_79_SG9047.length);
  });

  it('has the same number of rows, and the same keys per row', () => {
    const perRow = (keys: KeyLayoutEntry[]) =>
      rowsOf(keys).map((y) => keys.filter((k) => k.y === y).length);
    expect(perRow(ANSI_75)).toEqual(perRow(ANSI_79_SG9047));
  });

  it('has the same row-width pattern', () => {
    // Normalised per layout, since the vendor bakes its inter-key gutter into
    // `w` and this one does not — what has to match is the SHAPE: a short
    // function row, three full rows, a short shift row, a full bottom row.
    const norm = (keys: KeyLayoutEntry[]) => {
      const w = widthsOf(keys);
      const max = Math.max(...w);
      return w.map((v) => v / max);
    };
    const a = norm(ANSI_75);
    const b = norm(ANSI_79_SG9047);
    expect(a).toHaveLength(b.length);
    // Compared with a tolerance, not exactly: the two are in different unit
    // systems (the vendor's 1u key is 0.87 wide with the gutter baked in), so
    // demanding identical fractions would be pinning rounding, not shape.
    a.forEach((v, i) => expect(v).toBeCloseTo(b[i]!, 1));
  });

  it('puts the function row a quarter unit above the number row on both', () => {
    for (const keys of [ANSI_75, ANSI_79_SG9047]) {
      const rows = rowsOf(keys);
      expect(rows[1]! - rows[0]!).toBeGreaterThan(1);
      expect(rows[2]! - rows[1]!).toBeCloseTo(1, 2);
    }
  });
});

describe('ANSI_75 geometry', () => {
  it('starts every row at the same left edge', () => {
    for (const y of rowsOf(ANSI_75)) {
      expect(Math.min(...ANSI_75.filter((k) => k.y === y).map((k) => k.x))).toBeLessThan(0.1);
    }
  });

  it('gives every key a unique row/col identity', () => {
    // `slotOf` resolves a key by row/col before falling back to array position,
    // so a duplicate would silently address the wrong slot.
    const ids = new Set(ANSI_75.map((k) => `${k.row}:${k.col}`));
    expect(ids.size).toBe(ANSI_75.length);
  });
});
