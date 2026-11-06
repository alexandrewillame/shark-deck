export { ANSI_75 } from '@shared/layouts';
import type { KeyLayoutEntry } from '@shared/types/keys';

/**
 * Every per-key wire operation (magnetic actuation, per-key lighting,
 * remap) addresses the firmware matrix `slot`, not this array's own index —
 * see `KeyLayoutEntry.slot`'s doc comment in shared/types.ts. Use these
 * wherever a per-key index crosses the IPC boundary instead of
 * `layout.indexOf(k)` / `layout.findIndex(...)`, which silently fall back to
 * array position (wrong on any layout whose slot order differs from render
 * order — the R85HE's ANSI_79_SG9047 is exactly that case).
 */
export function slotOf(
  layout: KeyLayoutEntry[] | undefined,
  k: { row: number; col: number },
): number | null {
  const entry = layout?.find((e) => e.row === k.row && e.col === k.col);
  // No array-position fallback: a key without a confirmed slot is not
  // addressable at all. Guessing its slot from where it sits in the drawing is
  // exactly how a per-key write lands on the wrong key (the generic layouts
  // and the drawing-only vendor layouts carry no slots).
  return entry?.slot ?? null;
}

export function bySlot(layout: KeyLayoutEntry[] | undefined): Map<number, KeyLayoutEntry> {
  const m = new Map<number, KeyLayoutEntry>();
  layout?.forEach((e) => {
    if (e.slot !== undefined) m.set(e.slot, e);
  });
  return m;
}
