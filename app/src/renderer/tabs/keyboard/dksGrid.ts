import {
  type DksAction,
  type DksZone,
  EMPTY_DKS_ZONE,
  decodeDksZone,
  encodeDksZone,
} from '@shared/dks';
import type { TFunc } from '@shared/i18n';

/**
 * The DKS panel's grid: four actions down, four trigger points across, and in
 * each row the stretches of the stroke where that action fires.
 *
 * shared/dks.ts holds the firmware's encoding — one byte per action, a 2-bit
 * field per point that run-length encodes taps and holds. That is the wrong
 * shape to edit: what a person does is "fire here" and "hold from here to
 * there". So a row is edited as bars — `{from, to}`, a tap when they are the
 * same point — and every edit is checked against the encoding by a round
 * trip, so the grid can never offer an arrangement the board cannot store.
 *
 * Each point of a row is a menu of what can start there (`choicesAt`): the
 * menu lists only what the byte can hold beside the row's other bars, so a
 * choice is never refused after the fact.
 */

/** The four points of one press, in stroke order, as catalogue keys. `caption`
 *  is the short form under the column's name; `tip` the full sentence. */
export const DKS_POINTS = [
  {
    label: 'act.dks.pt.press',
    caption: 'act.dks.pt.press.caption',
    tip: 'act.dks.pt.press.tip',
  },
  {
    label: 'act.dks.pt.bottom',
    caption: 'act.dks.pt.bottom.caption',
    tip: 'act.dks.pt.bottom.tip',
  },
  {
    label: 'act.dks.pt.lift',
    caption: 'act.dks.pt.lift.caption',
    tip: 'act.dks.pt.lift.tip',
  },
  {
    label: 'act.dks.pt.release',
    caption: 'act.dks.pt.release.caption',
    tip: 'act.dks.pt.release.tip',
  },
] as const;

export type DksPoint = 0 | 1 | 2 | 3;
const POINTS: readonly DksPoint[] = [0, 1, 2, 3];

/** One stretch of a row: fires at `from` and is held until `to`. */
export interface DksBar {
  from: DksPoint;
  to: DksPoint;
}

const FIELD = ['a', 'b', 'c', 'd'] as const;
const END_OF: Record<DksAction, DksPoint> = {
  A: 0,
  'A-BS': 1,
  'A-CS': 2,
  'A-DS': 3,
  B: 1,
  'B-CS': 2,
  'B-DS': 3,
  C: 2,
  'C-DS': 3,
  D: 3,
};
const ACTION_FOR: Record<string, DksAction> = {
  '0-0': 'A',
  '0-1': 'A-BS',
  '0-2': 'A-CS',
  '0-3': 'A-DS',
  '1-1': 'B',
  '1-2': 'B-CS',
  '1-3': 'B-DS',
  '2-2': 'C',
  '2-3': 'C-DS',
  '3-3': 'D',
};

const byStart = (a: DksBar, b: DksBar) => a.from - b.from;

/** A row's bars, in stroke order. */
export function barsOf(z: DksZone): DksBar[] {
  const out: DksBar[] = [];
  FIELD.forEach((f, i) => {
    const action = z[f];
    if (action) out.push({ from: i as DksPoint, to: END_OF[action] });
  });
  return out;
}

/** The zone for a row's bars — or null when the firmware's byte cannot say
 *  exactly that (two bars from one point, a tap inside a hold, …). */
export function zoneOf(bars: readonly DksBar[]): DksZone | null {
  const z: DksZone = { ...EMPTY_DKS_ZONE };
  for (const b of bars) {
    const f = FIELD[b.from];
    const action = ACTION_FOR[`${b.from}-${b.to}`];
    if (!action || z[f] !== null) return null;
    z[f] = action;
  }
  // The encoder silently drops what it cannot hold — a tap under a hold comes
  // back as no tap — so only a byte that decodes to exactly this row counts.
  const byte = encodeDksZone(z);
  const back = byte === null ? null : decodeDksZone(byte);
  return back && FIELD.every((f) => back[f] === z[f]) ? z : null;
}

/** Whether a row does anything at all. */
export const rowFires = (z: DksZone): boolean => barsOf(z).length > 0;

// ---------------------------------------------------------------- choices

/** What one point of a row can be set to: nothing, a tap, or the start of a
 *  hold that lasts until a later point. */
export type DksChoice = 'none' | 'tap' | 'hold:1' | 'hold:2' | 'hold:3';

const ALL_CHOICES: readonly DksChoice[] = ['none', 'tap', 'hold:1', 'hold:2', 'hold:3'];

/** The point a hold choice ends at; null for anything else. */
const holdEnd = (c: DksChoice): DksPoint | null =>
  c.startsWith('hold:') ? (Number(c.slice(5)) as DksPoint) : null;

// A hold's `to` is past its `from`, so never 0 — which the template cannot know.
const choiceFor = (b: DksBar): DksChoice =>
  b.from === b.to ? 'tap' : (`hold:${b.to}` as DksChoice);

/** What starts at `p` in this row. */
export function choiceAt(z: DksZone, p: DksPoint): DksChoice {
  const b = barsOf(z).find((x) => x.from === p);
  return b ? choiceFor(b) : 'none';
}

/** The bar a choice puts at `p`: none for 'none', and none for a hold that
 *  would end where it starts or earlier — that is a tap, or nothing. */
function barFor(p: DksPoint, c: DksChoice): DksBar | null | 'invalid' {
  if (c === 'none') return null;
  if (c === 'tap') return { from: p, to: p };
  const to = holdEnd(c)!;
  return to > p ? { from: p, to } : 'invalid';
}

/**
 * Every choice for `p` the board can store beside the row's other bars, in
 * menu order — "nothing" and whatever is there now always among them, so the
 * menu can always show its own value and always offers a way out.
 */
export function choicesAt(z: DksZone, p: DksPoint): DksChoice[] {
  const current = choiceAt(z, p);
  const others = barsOf(z).filter((b) => b.from !== p);
  return ALL_CHOICES.filter((c) => {
    if (c === 'none' || c === current) return true;
    const bar = barFor(p, c);
    return bar !== null && bar !== 'invalid' && zoneOf([...others, bar]) !== null;
  });
}

/** The row with `p` set to `c` — or unchanged, when the byte cannot hold that
 *  (the menu never offers such a choice; this is the belt to its braces). */
export function withChoice(z: DksZone, p: DksPoint, c: DksChoice): DksZone {
  const bar = barFor(p, c);
  if (bar === 'invalid') return z;
  const others = barsOf(z).filter((b) => b.from !== p);
  return zoneOf(bar ? [...others, bar].sort(byStart) : others) ?? z;
}

// ---------------------------------------------------------------- drawing

/**
 * One element of a row as drawn: a tap at one point, or a hold across the
 * points it covers. The byte allows a tap at the very point a hold ends on
 * (A held to Bottom, and B tapped at Bottom); the grid has no cell of its own
 * for that point, so the tap is shown on the hold — `tapAtEnd` — and can be
 * taken off by taking the hold off.
 */
export interface DksSpan {
  from: DksPoint;
  to: DksPoint;
  kind: 'tap' | 'hold';
  tapAtEnd?: boolean;
}

export function rowSpans(z: DksZone): DksSpan[] {
  const bars = barsOf(z);
  const holdEndingAt = (p: DksPoint) => bars.some((h) => h.from < h.to && h.to === p);
  const tapAt = (p: DksPoint) => bars.some((t) => t.from === t.to && t.from === p);
  const out: DksSpan[] = [];
  for (const b of bars) {
    if (b.from === b.to) {
      if (!holdEndingAt(b.from)) out.push({ from: b.from, to: b.to, kind: 'tap' });
      continue;
    }
    const span: DksSpan = { from: b.from, to: b.to, kind: 'hold' };
    if (tapAt(b.to)) span.tapAtEnd = true;
    out.push(span);
  }
  return out;
}

/** The points no bar reaches: each gets an empty cell of its own. A point
 *  inside a hold, or at its end, has none — the hold is the cell there. */
export function freePoints(z: DksZone): DksPoint[] {
  const covered = new Set<number>();
  for (const b of barsOf(z)) for (let p = b.from; p <= b.to; p++) covered.add(p);
  return POINTS.filter((p) => !covered.has(p));
}

/** A choice as the cell's menu lists it. */
export function choiceLabel(c: DksChoice, t: TFunc): string {
  if (c === 'none') return t('act.dks.choice.none');
  if (c === 'tap') return t('act.dks.choice.tap');
  return t('act.dks.choice.hold', { point: t(DKS_POINTS[holdEnd(c)!].label) });
}

/** What a choice at `p` does, in the stroke's own words — the option's tip. */
export function choiceTip(c: DksChoice, p: DksPoint, t: TFunc): string {
  const here = DKS_POINTS[p];
  if (c === 'none') return t('act.dks.choice.none.tip', { point: t(here.label) });
  if (c === 'tap') return t('act.dks.choice.tap.tip', { caption: t(here.caption) });
  const to = DKS_POINTS[holdEnd(c)!];
  return t('act.dks.choice.hold.tip', {
    from: t(here.label),
    fromCaption: t(here.caption),
    to: t(to.label),
    toCaption: t(to.caption),
  });
}

// ---------------------------------------------------------------- seeds

/**
 * A new DKS key's rows: the key itself taps at Press, as a plain key would,
 * and the other three actions wait to be bound. Binding one seeds `seedRow`,
 * a tap at the row's own point, so a key with all four bound does what the
 * vendor app's does — one action per point, `01 04 10 40` on the wire
 * (docs/protocol/keyboard-compx.md). An empty grid used to be the start, and
 * a key applied as-is did nothing at all.
 */
export function seedZones(): DksZone[] {
  return [seedRow(0), { ...EMPTY_DKS_ZONE }, { ...EMPTY_DKS_ZONE }, { ...EMPTY_DKS_ZONE }];
}

export function seedRow(row: number): DksZone {
  const p = Math.min(Math.max(row, 0), 3) as DksPoint;
  return zoneOf([{ from: p, to: p }]) ?? { ...EMPTY_DKS_ZONE };
}
