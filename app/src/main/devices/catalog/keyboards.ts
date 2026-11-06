import type { DeviceDescriptor } from '@shared/types/device';
import { KEYBOARD_ROWS } from './generated/keyboard-rows';
import { FOREIGN_BRANDS, FOREIGN_IDS } from './generated/foreign-ids';
import { buildKeyboardDescriptor } from './keyboard-builder';
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

const FOREIGN: ReadonlyMap<number, string> = new Map(
  FOREIGN_IDS.map(([id, brand]) => [id, FOREIGN_BRANDS[brand] ?? 'another brand']),
);

/** The brand another maker's board with this model id is sold under, if known. */
export function foreignBrand(modelId: number): string | undefined {
  return FOREIGN.get(modelId);
}
