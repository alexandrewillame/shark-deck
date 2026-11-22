import type { KeyBinding, KeyLayoutEntry } from '@shared/types/keys';

/**
 * Is an imported layout really this board's?
 *
 * A layout imported as `certain` (catalog/generated/vendor-layouts.ts) names
 * a slot for every key, and every per-key write is addressed by those slots.
 * The import is firmware-anchored, but one model id can ship on more than one
 * PCB, so before any per-key menu is offered the layout is held to the board's
 * own base keymap: each key's slot must hold the HID code that key sends by
 * default. Below LAYOUT_AGREEMENT_MIN the layout is dropped for this board,
 * which then gets whole-board settings only (manager.ts `checkLayout`).
 *
 * The slack is for keys the owner remapped in the vendor's app — those read
 * as disagreements and are not evidence of a wrong layout.
 */
export const LAYOUT_AGREEMENT_MIN = 0.9;

export interface LayoutAgreement {
  /** keys whose slot holds the code the layout says */
  agree: number;
  /** keys the check could test (a slot and a HID code; Fn has no code) */
  checked: number;
  ratio: number;
}

export function layoutAgreement(
  layout: readonly KeyLayoutEntry[],
  base: Readonly<Record<number, KeyBinding>>,
): LayoutAgreement {
  let agree = 0;
  let checked = 0;
  for (const k of layout) {
    if (k.slot === undefined || typeof k.code !== 'number') continue;
    checked++;
    const b = base[k.slot];
    if (b?.kind === 'key' && b.code !== null && parseInt(b.code, 16) === k.code) agree++;
  }
  return { agree, checked, ratio: checked ? agree / checked : 0 };
}

/** Does the board's keymap bear the layout out? A layout with nothing to test does not. */
export function layoutHolds(a: LayoutAgreement): boolean {
  return a.checked > 0 && a.ratio >= LAYOUT_AGREEMENT_MIN;
}

/** The firmware's own Fn key: system function 1 (shared/keyboard-fn-codes.ts). */
const isFnQuad = (raw: readonly number[]) => raw[0] === 10 && raw[1] === 1;

/**
 * The key a base-layer binding types, when it is in the factory map's shape:
 * `[0, 0, usage, 0]`, as all 98 of the R98 HE's and all of the R85 HE's are.
 * The vendor app writes a remap one byte earlier (`[0, usage, 0, 0]` — the R98
 * HE owner's Del/Ins swap reads back so), and a combo fills more than one byte:
 * neither says where a key sits, so neither places one.
 */
const factoryUsage = (raw: readonly number[]) =>
  raw[0] === 0 && raw[1] === 0 && raw[3] === 0 ? (raw[2] ?? 0) : 0;

/**
 * A layout from the board itself, for a model whose drawing is known (the
 * vendor registry's geometry) but not the slot behind each key: every key is
 * placed on the slot whose base binding sends that key's code, the Fn key (no
 * code) on the slot the firmware holds Fn on. Nothing is guessed — the slot
 * that gets "A" is the one the board says types A. A code the drawing shows
 * on n keys (two Fn keys) is placed only where the board holds it on n slots,
 * left to right; any other mismatch, and any binding not in the factory
 * shape (`factoryUsage`: a key remapped in the vendor's app), leaves that key
 * out, so no write can reach it.
 *
 * The line's boards share one command set, one matrix numbering and one
 * factory Fn layer: the R98 HE's recording matches the R85 HE's slot for slot
 * (devices/r98he-keymap.fixture.ts). This is what lets the line's boards with
 * a drawing but no slot map get per-key settings without a recording each.
 *
 * Null when fewer than LAYOUT_AGREEMENT_MIN of the drawing's keys could be
 * placed: that drawing is not this board's.
 */
export function deriveLayout(
  geometry: readonly KeyLayoutEntry[],
  base: Readonly<Record<number, KeyBinding>>,
): KeyLayoutEntry[] | null {
  const FN = -1;
  const slotsOf = new Map<number, number[]>();
  for (const b of Object.values(base)) {
    const code = isFnQuad(b.raw) ? FN : factoryUsage(b.raw);
    if (code) slotsOf.set(code, [...(slotsOf.get(code) ?? []), b.slot]);
  }
  const codeOf = (k: KeyLayoutEntry) =>
    typeof k.code === 'number' ? k.code : /^fn$/i.test(k.label.trim()) ? FN : 0;
  const drawn = new Map<number, KeyLayoutEntry[]>();
  for (const k of geometry) {
    const code = codeOf(k);
    if (code) drawn.set(code, [...(drawn.get(code) ?? []), k]);
  }
  const placed = new Map<KeyLayoutEntry, number>();
  for (const [code, keys] of drawn) {
    const slots = [...(slotsOf.get(code) ?? [])].sort((a, b) => a - b);
    if (slots.length !== keys.length) continue;
    const ordered = [...keys].sort((a, b) => a.x - b.x || a.row - b.row);
    ordered.forEach((k, i) => placed.set(k, slots[i]!));
  }
  if (!geometry.length || placed.size / geometry.length < LAYOUT_AGREEMENT_MIN) return null;
  return geometry.filter((k) => placed.has(k)).map((k) => ({ ...k, slot: placed.get(k)! }));
}

/** What is kept of a placed layout: each drawn key's slot, by its place in the drawing. */
export type KeptLayout = Array<[row: number, col: number, slot: number]>;

export const keepLayout = (layout: readonly KeyLayoutEntry[]): KeptLayout =>
  layout.flatMap((k) => (k.slot === undefined ? [] : [[k.row, k.col, k.slot] as const]));

/**
 * A kept layout laid back on the drawing. Null when it does not fit the
 * drawing it came from (a later registry import redrew the board), so the
 * board is asked again rather than a stale slot believed.
 */
export function placeKept(
  geometry: readonly KeyLayoutEntry[],
  kept: unknown,
): KeyLayoutEntry[] | null {
  if (!Array.isArray(kept) || !kept.length) return null;
  const at = new Map<string, number>();
  for (const e of kept) {
    if (!Array.isArray(e) || e.length !== 3 || !e.every((n) => Number.isInteger(n))) return null;
    at.set(`${e[0]},${e[1]}`, e[2] as number);
  }
  const placed = geometry.flatMap((k) => {
    const slot = at.get(`${k.row},${k.col}`);
    return slot === undefined ? [] : [{ ...k, slot }];
  });
  if (placed.length !== at.size || new Set(placed.map((k) => k.slot)).size !== placed.length)
    return null;
  return placed.length / geometry.length < LAYOUT_AGREEMENT_MIN ? null : placed;
}
