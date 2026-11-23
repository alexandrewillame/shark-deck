export { ANSI_75 } from '@shared/layouts';
import type { KeyLayoutEntry, KnobSlots } from '@shared/types/keys';

/** The knob's three controls: what each is called on its key, and its factory binding. */
const KNOB_KEYS: readonly [keyof KnobSlots, string, readonly [number, number, number, number]][] = [
  ['left', 'Knob \u2212', [3, 0, 0xea, 0]],
  ['right', 'Knob +', [3, 0, 0xe9, 0]],
  ['press', 'Knob press', [3, 0, 0xe2, 0]],
];

/**
 * The Remap view's layout: the board's keys, and its knob's turns and press
 * (`KnobSlots`) as three keys in the top row, above the board's three
 * right-most columns where those are free (over the numpad, where an R98 HE
 * has its knob), else after the row. Only that view draws them: a knob has no
 * light, no switch and no travel, so the other per-key views keep `layout`.
 */
export function withKnob(
  layout: KeyLayoutEntry[] | undefined,
  knob: KnobSlots | undefined,
): KeyLayoutEntry[] | undefined {
  if (!layout?.length || !knob) return layout;
  const top = Math.min(...layout.map((k) => k.y));
  const row = Math.min(...layout.map((k) => k.row));
  const topEnd = Math.max(...layout.filter((k) => k.y === top).map((k) => k.x + (k.w ?? 1)));
  const free = [...new Set(layout.map((k) => k.x))]
    .filter((x) => x >= topEnd - 0.01)
    .sort((a, b) => a - b)
    .slice(-3);
  const xs = free.length === 3 ? free : [0, 1, 2].map((i) => topEnd + 0.25 + i);
  return [
    ...layout,
    ...KNOB_KEYS.map(([part, label, defaultQuad], i) => ({
      label,
      row,
      // Out of the drawing's own columns: a stable id of its own.
      col: 1000 + i,
      x: xs[i]!,
      y: top,
      slot: knob[part],
      code: null,
      control: 'knob' as const,
      defaultQuad,
    })),
  ];
}

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
