import { describe, expect, it } from 'vitest';
import type { KeyBinding, KeyLayoutEntry } from '@shared/types/keys';
import { ANSI_79_SG9047 } from '@shared/layouts';
import { decodeQuad } from './drivers/compx-keyboard';
import { layoutAgreement, layoutHolds } from './layout-check';

/** The base keymap a board with this layout reports: each key's code at its slot. */
function keymapOf(layout: readonly KeyLayoutEntry[]): Record<number, KeyBinding> {
  const out: Record<number, KeyBinding> = {};
  for (let slot = 0; slot < 128; slot++) out[slot] = decodeQuad(slot, [0, 0, 0, 0]);
  for (const k of layout) {
    if (k.slot === undefined || typeof k.code !== 'number') continue;
    // a plain key is `[0, 0, usage, 0]` on the base layer (keyboard-fn-codes.ts)
    out[k.slot] = decodeQuad(k.slot, [0, 0, k.code, 0]);
  }
  return out;
}

describe('layoutAgreement', () => {
  it('holds the R85HE layout against a keymap shaped like it', () => {
    const a = layoutAgreement(ANSI_79_SG9047, keymapOf(ANSI_79_SG9047));
    expect(a.checked).toBeGreaterThan(70);
    expect(a.agree).toBe(a.checked);
    expect(layoutHolds(a)).toBe(true);
  });

  it('tolerates a few keys the owner remapped', () => {
    const map = keymapOf(ANSI_79_SG9047);
    const keyed = ANSI_79_SG9047.filter((k) => k.slot !== undefined && typeof k.code === 'number');
    // swap three keys' codes, as a vendor-app remap would
    for (const k of keyed.slice(0, 3)) map[k.slot!] = decodeQuad(k.slot!, [0, 0, 0x04, 0]);
    expect(layoutHolds(layoutAgreement(ANSI_79_SG9047, map))).toBe(true);
  });

  it('rejects a layout whose slots hold other keys', () => {
    // the same keys, every slot shifted by one: a different PCB
    const shifted = ANSI_79_SG9047.map((k) =>
      k.slot === undefined ? k : { ...k, slot: (k.slot + 1) % 126 },
    );
    const a = layoutAgreement(shifted, keymapOf(ANSI_79_SG9047));
    expect(a.ratio).toBeLessThan(0.5);
    expect(layoutHolds(a)).toBe(false);
  });

  it('does not count a layout with nothing to test as holding', () => {
    const a = layoutAgreement([], keymapOf(ANSI_79_SG9047));
    expect(a.checked).toBe(0);
    expect(layoutHolds(a)).toBe(false);
  });
});
