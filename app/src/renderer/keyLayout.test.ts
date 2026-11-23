import { describe, expect, it } from 'vitest';
import type { KeyLayoutEntry } from '@shared/types/keys';
import { withKnob } from './keyLayout';

/**
 * The Remap view's knob: its turns and press as three controls of the top
 * row, above the right-hand columns where those are free, each with the
 * binding it ships with, so Reset can put it back.
 */

const key = (label: string, row: number, x: number, slot: number): KeyLayoutEntry => ({
  label,
  row,
  col: Math.round(x),
  x,
  y: row,
  slot,
  code: 4,
});
const KNOB = { left: 120, right: 121, press: 122 };

describe('withKnob', () => {
  it('sets the knob above the right-hand columns, where the top row leaves them free', () => {
    // a top row of 3 keys over a row of 6: like an R98 HE's F-row over its numpad
    const layout = [
      ...[0, 1, 2].map((x) => key(`F${x}`, 0, x, x)),
      ...[0, 1, 2, 3, 4, 5].map((x) => key(`K${x}`, 1, x, 10 + x)),
    ];
    const knob = withKnob(layout, KNOB)!.slice(layout.length);
    expect(knob.map((k) => [k.label, k.x, k.y, k.slot, k.control])).toEqual([
      ['Knob −', 3, 0, 120, 'knob'],
      ['Knob +', 4, 0, 121, 'knob'],
      ['Knob press', 5, 0, 122, 'knob'],
    ]);
    // what each ships with: Volume -, Volume +, Mute
    expect(knob.map((k) => k.defaultQuad)).toEqual([
      [3, 0, 0xea, 0],
      [3, 0, 0xe9, 0],
      [3, 0, 0xe2, 0],
    ]);
    // an id of its own: no key of the drawing shares it
    for (const k of knob)
      expect(layout.some((l) => l.row === k.row && l.col === k.col)).toBe(false);
  });

  it('follows the top row where it spans the whole board', () => {
    const layout = [0, 1, 2].map((x) => key(`K${x}`, 0, x, x));
    expect(
      withKnob(layout, KNOB)!
        .slice(3)
        .map((k) => k.x),
    ).toEqual([3.25, 4.25, 5.25]);
  });

  it('leaves a board without a knob as it is', () => {
    const layout = [key('A', 0, 0, 0)];
    expect(withKnob(layout, undefined)).toBe(layout);
    expect(withKnob(undefined, KNOB)).toBeUndefined();
  });
});
