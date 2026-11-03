import { KEY_GROUPS, normalizeUsage, type KeyGroup } from '@shared/keys';
import type { KeyLayoutEntry } from '@shared/types/keys';
import type { KeyRef } from './magneticModes';

/**
 * The keys of one board, as the picker names them.
 *
 * A snap-tap partner is a key on THIS keyboard — the firmware pairs two matrix
 * slots — so the chooser that picks it offers the board's keys and no others:
 * `KEY_GROUPS` cut down to the usages the layout has, in the picker's own
 * order, plus an "Other" group for any key the table does not know (named as
 * the layout names it). Fn sends no usage and is never offered, nor is the
 * key being paired.
 *
 * The other two translate between the chooser, which speaks HID usages, and
 * the plan, which speaks matrix positions. Pure, so it is tested without a
 * board.
 */

const at = (e: KeyLayoutEntry, k: KeyRef) => e.row === k.row && e.col === k.col;

/** A layout entry's usage, spelt as `KEY_GROUPS` spells it ("4" = A, not "04"). */
const spell = (code: number): string => normalizeUsage(code.toString(16));

export function boardKeyGroups(layout: readonly KeyLayoutEntry[], exclude: KeyRef): KeyGroup[] {
  /** Usage → the first key on the board that sends it, for its label. */
  const onBoard = new Map<string, KeyLayoutEntry>();
  for (const e of layout) {
    if (e.code == null || at(e, exclude)) continue;
    const usage = spell(e.code);
    if (!onBoard.has(usage)) onBoard.set(usage, e);
  }
  const out: KeyGroup[] = [];
  const placed = new Set<string>();
  for (const g of KEY_GROUPS) {
    const keys = g.keys.filter((k) => onBoard.has(normalizeUsage(k.code)));
    if (!keys.length) continue;
    for (const k of keys) placed.add(normalizeUsage(k.code));
    out.push({ label: g.label, labelKey: g.labelKey, keys });
  }
  const other = [...onBoard]
    .filter(([usage]) => !placed.has(usage))
    .map(([code, e]) => ({ label: e.label, code }));
  if (other.length) out.push({ label: 'Other', labelKey: 'keypick.group.other', keys: other });
  return out;
}

/** The first key on the board that sends `usage` — any spelling — or null.
 *  `exclude` skips one key, so a usage two keys share never resolves to the
 *  key being paired. */
export function keyForUsage(
  layout: readonly KeyLayoutEntry[],
  usage: string,
  exclude?: KeyRef,
): KeyRef | null {
  const wanted = normalizeUsage(usage);
  const e = layout.find(
    (e) => e.code != null && spell(e.code) === wanted && !(exclude && at(e, exclude)),
  );
  return e ? { row: e.row, col: e.col } : null;
}

/** What the key at `ref` sends, spelt as the picker spells it; null for Fn or
 *  a position the layout has no key at. */
export function usageOf(layout: readonly KeyLayoutEntry[], ref: KeyRef): string | null {
  const e = layout.find((e) => at(e, ref));
  return e?.code == null ? null : spell(e.code);
}
