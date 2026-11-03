import { describe, expect, it } from 'vitest';
import { KEY_GROUPS } from '@shared/keys';
import type { KeyLayoutEntry } from '@shared/types/keys';
import { boardKeyGroups, keyForUsage, usageOf } from './boardKeys';

/**
 * The snap-tap chooser offers this board's keys and nothing else, spelt the
 * way the picker spells them, and a pick comes back as a matrix position.
 */

const entry = (label: string, row: number, col: number, code: number | null): KeyLayoutEntry => ({
  label,
  row,
  col,
  slot: row * 20 + col,
  code,
  x: col,
  y: row,
});

const A = entry('A', 3, 1, 0x04);
const D = entry('D', 3, 3, 0x07);
const SPACE = entry('Space', 5, 4, 0x2c);
const LCTRL = entry('Ctrl', 5, 0, 0xe0);
// The Japanese Yen key (0x89): a real usage the picker has no button for.
const YEN = entry('¥', 4, 13, 0x89);
const FN = entry('Fn', 5, 10, null);
const LAYOUT = [A, D, SPACE, LCTRL, YEN, FN];

describe('boardKeyGroups', () => {
  const groups = boardKeyGroups(LAYOUT, A);
  const flat = groups.flatMap((g) => g.keys.map((k) => k.code));

  it("offers the board's keys, in the picker's groups and order", () => {
    expect(groups.map((g) => g.label)).toEqual(['Letters', 'Modifiers', 'Editing', 'Other']);
    expect(groups[0]!.keys).toEqual([{ label: 'D', code: '7' }]);
    expect(flat).toEqual(['7', 'e0', '2c', '89']);
  });

  it('leaves out the key being paired, Fn, and every key the board lacks', () => {
    expect(flat).not.toContain('4');
    expect(groups.every((g) => g.keys.every((k) => k.label !== 'Fn'))).toBe(true);
    expect(flat).not.toContain('5'); // B: in KEY_GROUPS, not on this board
    const all = KEY_GROUPS.flatMap((g) => g.keys).length;
    expect(flat.length).toBeLessThan(all);
  });

  it('names a key the picker has no entry for after the layout, under Other', () => {
    expect(groups.at(-1)).toEqual({
      label: 'Other',
      labelKey: 'keypick.group.other',
      keys: [{ label: '¥', code: '89' }],
    });
  });

  it("spells usages the way KEY_GROUPS does, so the picker's isOn/onPick match", () => {
    // "4", not "04": the picker's own code for A is `(0x04).toString(16)`.
    expect(boardKeyGroups(LAYOUT, D)[0]!.keys).toEqual([{ label: 'A', code: '4' }]);
  });

  it('is empty for a board with nothing else on it', () => {
    expect(boardKeyGroups([A, FN], A)).toEqual([]);
  });
});

describe('keyForUsage / usageOf', () => {
  it('finds a key by its usage, in either spelling', () => {
    expect(keyForUsage(LAYOUT, '7')).toEqual({ row: 3, col: 3 });
    expect(keyForUsage(LAYOUT, '07')).toEqual({ row: 3, col: 3 });
    expect(keyForUsage(LAYOUT, 'E0')).toEqual({ row: 5, col: 0 });
    expect(keyForUsage(LAYOUT, '5')).toBeNull();
  });

  it('can skip one key, for a usage two keys share', () => {
    const twin = entry('A', 4, 1, 0x04);
    expect(keyForUsage([A, twin], '4')).toEqual({ row: 3, col: 1 });
    expect(keyForUsage([A, twin], '4', A)).toEqual({ row: 4, col: 1 });
    expect(keyForUsage([A], '4', A)).toBeNull();
  });

  it('gives a key its usage, and nothing for Fn or an empty position', () => {
    expect(usageOf(LAYOUT, A)).toBe('4');
    expect(usageOf(LAYOUT, SPACE)).toBe('2c');
    expect(usageOf(LAYOUT, FN)).toBeNull();
    expect(usageOf(LAYOUT, { row: 9, col: 9 })).toBeNull();
  });
});
