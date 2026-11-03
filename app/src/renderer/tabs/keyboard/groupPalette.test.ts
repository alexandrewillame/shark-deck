import { describe, expect, it } from 'vitest';
import { SWATCH_HUES } from '../../colorUtil';
import {
  GROUP_COLORS,
  GROUP_HUES,
  GROUP_STRENGTHS,
  GROUP_SWATCH_ROWS,
  groupSwatchName,
} from './useKeyGroups';
import { deltaEHex } from '../../../../test/lib/colorDistance';

/**
 * The picker's colours have to be telling apart, which is not something you can
 * assert by looking at the hex.
 *
 * Two grids came before this one. The first had a light row whose greens and
 * blues converged on one pale colour; the second spread eight generated hues
 * so carefully it had no orange or pink, and still turned dark yellow olive.
 * This one is hand-picked shades, so the floor below is measured — in CIE Lab,
 * where distance is roughly perceptual, rather than in hex — and holds every
 * pair in every row. The maths is shared with the accent palettes' own distance
 * test (test/lib/colorDistance.ts).
 */

/** Below this two swatches side by side read as the same colour. The grid's
 *  closest pair is 26.9 (deep red/orange), with ten columns to fit. */
const MIN_HUE_DE = 25;
/** The depths of one hue are the secondary distinction, so they may sit
 *  closer — but a row must never be indistinguishable from the next. */
const MIN_STRENGTH_DE = 12;

describe('the group colour grid', () => {
  it('is every hue at every strength, each once', () => {
    expect(GROUP_SWATCH_ROWS).toHaveLength(GROUP_STRENGTHS.length);
    for (const row of GROUP_SWATCH_ROWS) expect(row).toHaveLength(GROUP_HUES.length);
    expect(new Set(GROUP_SWATCH_ROWS.flat()).size).toBe(GROUP_HUES.length * GROUP_STRENGTHS.length);
  });

  it('runs round the wheel, with orange and a pink in it, then slate', () => {
    expect(GROUP_HUES).toEqual([...SWATCH_HUES.map((h) => h.name), 'slate']);
    expect(GROUP_HUES).toEqual([
      'red',
      'orange',
      'yellow',
      'lime',
      'green',
      'cyan',
      'blue',
      'violet',
      'magenta',
      'slate',
    ]);
  });

  it('keeps every pair in a row apart', () => {
    for (const [r, strength] of GROUP_STRENGTHS.entries()) {
      const row = GROUP_SWATCH_ROWS[r]!;
      for (let i = 0; i < row.length; i++) {
        for (let j = i + 1; j < row.length; j++) {
          const d = deltaEHex(row[i]!, row[j]!);
          expect(
            d,
            `${strength} ${GROUP_HUES[i]} vs ${GROUP_HUES[j]} is only ${d.toFixed(1)}`,
          ).toBeGreaterThan(MIN_HUE_DE);
        }
      }
    }
  });

  it('keeps light green, light cyan and light blue apart specifically', () => {
    // The first grid's reported case: a pale green, a pale cyan and a pale
    // blue that all read as "pale". 44, 49 and 88 here.
    const light = GROUP_SWATCH_ROWS[0]!;
    const at = (name: string) => light[GROUP_HUES.indexOf(name as never)]!;
    for (const [a, b] of [
      ['green', 'cyan'],
      ['cyan', 'blue'],
      ['green', 'blue'],
    ] as const) {
      expect(deltaEHex(at(a), at(b)), `${a}/${b}`).toBeGreaterThan(40);
    }
  });

  it('keeps the three strengths of one hue apart', () => {
    for (const [col, hue] of GROUP_HUES.entries()) {
      for (let i = 0; i < GROUP_STRENGTHS.length; i++) {
        for (let j = i + 1; j < GROUP_STRENGTHS.length; j++) {
          const d = deltaEHex(GROUP_SWATCH_ROWS[i]![col]!, GROUP_SWATCH_ROWS[j]![col]!);
          expect(d, `${hue} ${GROUP_STRENGTHS[i]}/${GROUP_STRENGTHS[j]}`).toBeGreaterThan(
            MIN_STRENGTH_DE,
          );
        }
      }
    }
  });

  it('never approaches white, which is the selection ring', () => {
    for (const c of GROUP_SWATCH_ROWS.flat()) {
      expect(deltaEHex(c, '#ffffff'), c).toBeGreaterThan(30);
    }
  });

  it('gives the first groups the most different colours, not wheel neighbours', () => {
    // Red, blue, green and yellow first — the colours people ask for by name,
    // and far apart — rather than red, orange, yellow, lime.
    expect(GROUP_COLORS.slice(0, 4).map((c) => groupSwatchName(c))).toEqual([
      'vivid red',
      'vivid blue',
      'vivid green',
      'vivid yellow',
    ]);
    // …and every swatch the picker offers is in the order, once.
    expect([...GROUP_COLORS].sort()).toEqual([...GROUP_SWATCH_ROWS.flat()].sort());
  });

  it('names each swatch for its label', () => {
    expect(groupSwatchName(GROUP_SWATCH_ROWS[2]![0]!)).toBe('deep red');
    expect(groupSwatchName('hsl(10, 67%, 53%)')).toBeUndefined();
  });
});
