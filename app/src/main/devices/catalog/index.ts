import type { DeviceDescriptor } from '@shared/types/device';
import { ATTACK_SHARK_V8, ATTACK_SHARK_V8_WIRED } from './v8';
import { ATTACK_SHARK_R85HE } from './r85he';

/**
 * Exact, hand-authored model descriptors. Adding a new fully-supported device
 * is a single new file here plus one line in this array — nothing else in the
 * codebase changes.
 */
export const CATALOG: DeviceDescriptor[] = [
  ATTACK_SHARK_V8,
  ATTACK_SHARK_V8_WIRED,
  ATTACK_SHARK_R85HE,
];

export { ATTACK_SHARK_V8, ATTACK_SHARK_V8_WIRED, ATTACK_SHARK_R85HE };
