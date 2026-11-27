import { describe, expect, it } from 'vitest';
import { LED_PALETTE, SWATCH_HUES, hexToRgb, rgbToHex, shownRgb } from '../../colorUtil';
import {
  GROUP_COLORS,
  GROUP_HUES,
  GROUP_SWATCH_ROWS,
  currentGroupColor,
  groupSwatchName,
  reconcileGroups,
} from './useKeyGroups';
import { deltaEHex } from '../../../../test/lib/colorDistance';

/**
 * The key-group picker offers the lighting presets' colours, drawn as the
 * lighting picker draws them: "that colour" is the same colour on both tabs
 * (2026-11-26: "put the same colours that you made for the lighting colour
 * picker").
 *
 * The floors below are measured in CIE Lab, where distance is roughly
 * perceptual, rather than in hex — the maths is shared with the accent
 * palettes' own distance test (test/lib/colorDistance.ts).
 */
describe('the group colour grid', () => {
  it('is the lighting picker, as it draws it, without the white column', () => {
    expect(GROUP_SWATCH_ROWS).toHaveLength(LED_PALETTE.length);
    for (const [r, row] of GROUP_SWATCH_ROWS.entries()) {
      expect(row).toHaveLength(SWATCH_HUES.length);
      for (const [c, color] of row.entries()) {
        const preset = LED_PALETTE[r]![c]!;
        expect(color, preset.name).toBe(rgbToHex(shownRgb(hexToRgb(preset.look), 'screen')));
      }
    }
    expect(new Set(GROUP_SWATCH_ROWS.flat()).size).toBe(GROUP_SWATCH_ROWS.flat().length);
  });

  it('runs round the wheel, one column per family', () => {
    expect(GROUP_HUES).toEqual(SWATCH_HUES.map((h) => h.name));
  });

  it('keeps the colours of the first two rows well apart', () => {
    // The closest pair is the violet and the magenta, 20.4, now that they are
    // drawn as the board shows them.
    for (const row of GROUP_SWATCH_ROWS.slice(0, 2)) {
      for (let i = 0; i < row.length; i++) {
        for (let j = i + 1; j < row.length; j++) {
          const d = deltaEHex(row[i]!, row[j]!);
          expect(d, `${row[i]} vs ${row[j]} is only ${d.toFixed(1)}`).toBeGreaterThan(19);
        }
      }
    }
  });

  it('keeps the light row apart, if closer: its palest are near-whites', () => {
    // Cream and pale lime are the closest pair of the grid, 7.2.
    const row = GROUP_SWATCH_ROWS[2]!;
    for (let i = 0; i < row.length; i++) {
      for (let j = i + 1; j < row.length; j++) {
        expect(deltaEHex(row[i]!, row[j]!), `${row[i]} vs ${row[j]}`).toBeGreaterThan(6.5);
      }
    }
  });

  it('keeps the three colours of a family apart', () => {
    for (const [col, hue] of GROUP_HUES.entries()) {
      for (let i = 0; i < GROUP_SWATCH_ROWS.length; i++) {
        for (let j = i + 1; j < GROUP_SWATCH_ROWS.length; j++) {
          const d = deltaEHex(GROUP_SWATCH_ROWS[i]![col]!, GROUP_SWATCH_ROWS[j]![col]!);
          expect(d, `${hue} ${i}/${j}`).toBeGreaterThan(10);
        }
      }
    }
  });

  it('offers no white, which is the selection ring', () => {
    // The lighting's white column is left out; its palest tint stays 15 away.
    for (const c of GROUP_SWATCH_ROWS.flat()) {
      expect(deltaEHex(c, '#ffffff'), c).toBeGreaterThan(14);
    }
  });

  it('gives the first groups the most different colours, not wheel neighbours', () => {
    // Red, blue, green and yellow first — the colours people ask for by name,
    // and far apart — rather than red, orange, yellow, lime.
    expect(GROUP_COLORS.slice(0, 4).map((c) => groupSwatchName(c))).toEqual([
      'red',
      'blue',
      'green',
      'yellow',
    ]);
    // …and every swatch the picker offers is in the order, once.
    expect([...GROUP_COLORS].sort()).toEqual([...GROUP_SWATCH_ROWS.flat()].sort());
  });

  it('names each swatch by its preset, for its translated label', () => {
    expect(groupSwatchName(GROUP_SWATCH_ROWS[1]![0]!)).toBe('rose');
    expect(groupSwatchName(GROUP_SWATCH_ROWS[2]![8]!)).toBe('orchid');
    expect(groupSwatchName('hsl(10, 67%, 53%)')).toBeUndefined();
  });
});

describe('a group saved with an earlier colour', () => {
  it('takes its place in the new grid: vivid to the top, deep to the neighbours, light to the light row', () => {
    const red = GROUP_HUES.indexOf('red');
    expect(currentGroupColor('#e11d48')).toBe(GROUP_SWATCH_ROWS[0]![red]);
    expect(currentGroupColor('#9f1239')).toBe(GROUP_SWATCH_ROWS[1]![red]);
    expect(currentGroupColor('#fda4af')).toBe(GROUP_SWATCH_ROWS[2]![red]);
    // A colour of no earlier grid (a slate, a generated one) stays as it was.
    expect(currentGroupColor('#64748b')).toBe('#64748b');
  });

  it('is carried across as the groups are reconciled, and saved that way', () => {
    const key = { actuationMm: 1.2, releaseMm: 1.2, rapidTrigger: false, row: 0, col: 0 };
    const out = reconcileGroups(
      [{ id: 'g1', name: 'WASD', color: '#3b82f6', slots: [1, 2] }],
      [
        { slot: 1, settings: key },
        { slot: 2, settings: key },
      ],
    );
    expect(out).toEqual([
      {
        id: 'g1',
        name: 'WASD',
        color: GROUP_SWATCH_ROWS[0]![GROUP_HUES.indexOf('blue')],
        slots: [1, 2],
      },
    ]);
  });
});
