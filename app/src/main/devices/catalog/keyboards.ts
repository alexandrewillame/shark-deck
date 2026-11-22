import type { DeviceDescriptor } from '@shared/types/device';
import type { KeyLayoutEntry } from '@shared/types/keys';
import { KEYBOARD_ROWS } from './generated/keyboard-rows';
import { FOREIGN_BRANDS, FOREIGN_IDS } from './generated/foreign-ids';
import { buildKeyboardDescriptor, slotLayoutFor } from './keyboard-builder';
import type { KeyboardRow } from './keyboard-row';
import { ATTACK_SHARK_R85HE } from './r85he';

/**
 * Hand-written descriptors that replace their generated row: details
 * verified on real hardware that the vendor registry does not carry (the
 * R85HE's debounce, keystroke, switch list and measured travel ranges).
 * `keyboard-builder.test.ts` pins how far each may differ from its row.
 */
const OVERLAYS: Record<number, DeviceDescriptor> = {
  3123: ATTACK_SHARK_R85HE,
};

/** Every Attack Shark keyboard, one descriptor per firmware model id. */
export const KEYBOARDS: DeviceDescriptor[] = KEYBOARD_ROWS.map(
  (row) => OVERLAYS[row.id] ?? buildKeyboardDescriptor(row),
);

export const KEYBOARDS_BY_ID: ReadonlyMap<number, DeviceDescriptor> = new Map(
  KEYBOARDS.map((d) => [d.modelId!, d]),
);

/** The registry row a descriptor was built from; none for a hand-written one. */
function builtFrom(d: DeviceDescriptor): KeyboardRow | undefined {
  if (d.kind !== 'keyboard' || d.modelId === undefined || OVERLAYS[d.modelId]) return undefined;
  return KEYBOARD_ROWS.find((r) => r.id === d.modelId && r.slug === d.model);
}

/**
 * The drawing to place on the board's own key map (devices/layout-check.ts
 * `deriveLayout`, manager.ts `checkLayout`): a gen2 board's, when the registry
 * has its drawing but no slot map. The line's gen2 boards share the R85 HE's
 * command set, matrix numbering and factory Fn layer, so what the board types
 * is where each key sits. Null for any other descriptor.
 */
export function boardLayoutGeometry(d: DeviceDescriptor): KeyLayoutEntry[] | null {
  const row = builtFrom(d);
  if (row?.family !== 'gen2') return null;
  const { layout, status } = slotLayoutFor(row);
  return status === 'none' && layout?.length ? layout : null;
}

/** The descriptor again with a layout placed from the board: every per-key menu its row has. */
export function withBoardLayout(d: DeviceDescriptor, layout: KeyLayoutEntry[]): DeviceDescriptor {
  const row = builtFrom(d);
  if (!row) return d;
  const built = buildKeyboardDescriptor(row, { layout, status: 'board' });
  return { ...d, capabilities: built.capabilities, spec: built.spec };
}

const FOREIGN: ReadonlyMap<number, string> = new Map(
  FOREIGN_IDS.map(([id, brand]) => [id, FOREIGN_BRANDS[brand] ?? 'another brand']),
);

/** The brand another maker's board with this model id is sold under, if known. */
export function foreignBrand(modelId: number): string | undefined {
  return FOREIGN.get(modelId);
}
