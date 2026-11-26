import { describe, expect, it } from 'vitest';
import { KEYBOARD_ROWS } from './generated/keyboard-rows';
import { LAYOUT_GEOMETRY } from './generated/layout-geometry';
import { VENDOR_LAYOUTS } from './generated/vendor-layouts';
import { KEYBOARDS_BY_ID } from './keyboards';
import { RECORDED_KEYMAPS } from './recorded-keymaps';

/**
 * A board's factory key map from an owner's recording is its slot map, for
 * every model id of its firmware: every key placed, whatever an owner remaps.
 */
describe('recorded key maps', () => {
  it('give the R98 HE all 98 keys of its drawing, on the slots its recording read', () => {
    for (const id of [3743, 3903]) {
      const km = KEYBOARDS_BY_ID.get(id)!.spec.keyMatrix!;
      expect(km.layoutStatus, `${id}`).toBe('certain');
      expect(km.layout, `${id}`).toHaveLength(LAYOUT_GEOMETRY.Common98_SG9097_F!.length);
      const at = (label: string) => km.layout!.filter((k) => k.label === label).map((k) => k.slot);
      expect(at('DEL')).toEqual([78]);
      expect(at('INS')).toEqual([84]);
      expect(at('FN')).toEqual([65]);
      expect(at('ESC')).toEqual([0]);
      // and its knob, from the same recording
      expect(km.knobSlots).toEqual({ left: 120, right: 121, press: 122 });
    }
  });

  it('are kept only for a firmware the registry has, with its drawing', () => {
    for (const name of Object.keys(RECORDED_KEYMAPS)) {
      const rows = KEYBOARD_ROWS.filter((r) => r.internalName === name);
      expect(rows.length, name).toBeGreaterThan(0);
      for (const r of rows) expect(LAYOUT_GEOMETRY[r.layout], `${r.id}`).toBeDefined();
      expect(RECORDED_KEYMAPS[name]!.pages, name).toHaveLength(8);
    }
  });

  it('leave a board of the same drawing but another firmware to its own key map', () => {
    // The R98 PRO: the R98 HE's drawing, another firmware, nobody's recording.
    // Its slots come from its own factory matrix (Driver v4), never from the
    // R98 HE's recording.
    const row = KEYBOARD_ROWS.find((r) => r.id === 3754)!;
    expect(row.slotLayout).toBe('Common98_SG9097_F#3754');
    expect(KEYBOARDS_BY_ID.get(3754)!.spec.keyMatrix!.layout).toEqual(
      VENDOR_LAYOUTS[row.slotLayout!],
    );
  });
});
