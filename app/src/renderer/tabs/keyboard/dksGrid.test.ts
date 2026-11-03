import { describe, expect, it } from 'vitest';
import { type DksAction, type DksZone, EMPTY_DKS_ZONE, encodeDksZone } from '@shared/dks';
import { getT } from '@shared/i18n';
import {
  barsOf,
  choiceAt,
  choiceLabel,
  choiceTip,
  choicesAt,
  freePoints,
  rowSpans,
  seedRow,
  seedZones,
  withChoice,
  zoneOf,
  type DksBar,
  type DksChoice,
  type DksPoint,
} from './dksGrid';

/**
 * The DKS grid edits bars — "fire here", "hold from here to there" — over a
 * byte that run-length encodes them. These pin that the two agree, that no
 * menu offers a row the board cannot store, and that a fresh key starts as
 * the vendor app's does.
 */

const FIELD_OF: Record<string, 'a' | 'b' | 'c' | 'd'> = { A: 'a', B: 'b', C: 'c', D: 'd' };
const ALL_ACTIONS: DksAction[] = [
  'A',
  'A-BS',
  'A-CS',
  'A-DS',
  'B',
  'B-CS',
  'B-DS',
  'C',
  'C-DS',
  'D',
];
const POINTS: DksPoint[] = [0, 1, 2, 3];
const zone = (over: Partial<DksZone>): DksZone => ({ ...EMPTY_DKS_ZONE, ...over });

describe('dksGrid', () => {
  it('round-trips every single action the firmware has', () => {
    for (const action of ALL_ACTIONS) {
      const z = { ...EMPTY_DKS_ZONE, [FIELD_OF[action[0]!]!]: action };
      expect(zoneOf(barsOf(z)), action).toEqual(z);
    }
  });

  it('refuses what the byte cannot hold', () => {
    const tapUnderHold: DksBar[] = [
      { from: 0, to: 2 },
      { from: 1, to: 1 },
    ];
    expect(zoneOf(tapUnderHold)).toBeNull();
    expect(
      zoneOf([
        { from: 0, to: 0 },
        { from: 0, to: 1 },
      ]),
    ).toBeNull();
    // ...and a choice that would need it leaves the row as it was.
    const held = zone({ a: 'A-CS' });
    expect(withChoice(held, 1, 'tap')).toEqual(held);
  });

  it('offers a point everything it can take, and a last point only a tap', () => {
    expect(choicesAt(EMPTY_DKS_ZONE, 0)).toEqual(['none', 'tap', 'hold:1', 'hold:2', 'hold:3']);
    expect(choicesAt(EMPTY_DKS_ZONE, 3)).toEqual(['none', 'tap']);
  });

  it('never offers a choice the byte rejects, and always offers the current one', () => {
    for (const action of ALL_ACTIONS) {
      const z = zone({ [FIELD_OF[action[0]!]!]: action });
      for (const p of POINTS) {
        const offered = choicesAt(z, p);
        expect(offered, `${action} @${p}`).toContain('none');
        expect(offered, `${action} @${p}`).toContain(choiceAt(z, p));
        for (const c of offered) {
          // Taken, every offer sticks: the row then says exactly that at p.
          expect(choiceAt(withChoice(z, p, c), p), `${action} @${p} -> ${c}`).toBe(c);
        }
      }
    }
  });

  it('reads back what it was set to', () => {
    const choices: DksChoice[] = ['none', 'tap', 'hold:1', 'hold:2', 'hold:3'];
    for (const c of choices) expect(choiceAt(withChoice(EMPTY_DKS_ZONE, 0, c), 0)).toBe(c);
    expect(withChoice(withChoice(EMPTY_DKS_ZONE, 0, 'hold:2'), 0, 'none')).toEqual(EMPTY_DKS_ZONE);
    expect(withChoice(EMPTY_DKS_ZONE, 1, 'hold:3')).toEqual(zone({ b: 'B-DS' }));
  });

  it('draws a hold as one span and a tap as another, leaving the rest free', () => {
    const z = zone({ a: 'A-CS', d: 'D' });
    expect(rowSpans(z)).toEqual([
      { from: 0, to: 2, kind: 'hold' },
      { from: 3, to: 3, kind: 'tap' },
    ]);
    expect(freePoints(z)).toEqual([]);
    expect(freePoints(zone({ a: 'A' }))).toEqual([1, 2, 3]);
    expect(freePoints(zone({ b: 'B-CS' }))).toEqual([0, 3]);
  });

  it('shows a tap at the point a hold ends on the hold itself', () => {
    // A held to the bottom, and a separate tap at the bottom: the byte has
    // room for both, and the grid has one cell there — the hold's.
    expect(
      zoneOf([
        { from: 0, to: 1 },
        { from: 1, to: 1 },
      ]),
    ).toEqual(zone({ a: 'A-BS', b: 'B' }));
    expect(rowSpans(zone({ a: 'A-BS', b: 'B' }))).toEqual([
      { from: 0, to: 1, kind: 'hold', tapAtEnd: true },
    ]);
  });

  it('names the choices as the menu does', () => {
    const t = getT('en');
    expect(choiceLabel('none', t)).toBe('Nothing');
    expect(choiceLabel('tap', t)).toBe('Tap here');
    expect(choiceLabel('hold:1', t)).toBe('Hold until Bottom');
    expect(choiceLabel('hold:2', t)).toBe('Hold until Lift');
    expect(choiceLabel('hold:3', t)).toBe('Hold until Release');
  });

  it("explains a choice in the stroke's own words, point names filled in", () => {
    const t = getT('en');
    expect(choiceTip('none', 1, t)).toBe('Nothing happens at Bottom.');
    expect(choiceTip('tap', 0, t)).toBe('Fires once, going down, past the point.');
    expect(choiceTip('hold:3', 1, t)).toBe(
      'Pressed from Bottom (fully pressed) until Release (back above the point).',
    );
  });

  it("starts a key as the vendor app's: one action per point, 01 04 10 40", () => {
    expect(seedZones()).toEqual([zone({ a: 'A' }), EMPTY_DKS_ZONE, EMPTY_DKS_ZONE, EMPTY_DKS_ZONE]);
    expect(seedZones().map(encodeDksZone)).toEqual([0x01, 0, 0, 0]);
    expect([0, 1, 2, 3].map((r) => encodeDksZone(seedRow(r)))).toEqual([0x01, 0x04, 0x10, 0x40]);
  });
});
