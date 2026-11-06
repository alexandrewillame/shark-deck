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
