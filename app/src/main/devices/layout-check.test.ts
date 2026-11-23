import { describe, expect, it } from 'vitest';
import type { KeyBinding, KeyLayoutEntry } from '@shared/types/keys';
import { ANSI_79_SG9047 } from '@shared/layouts';
import { KB_FN_DEFAULT_SLOTS } from '@shared/keyboard-fn-defaults';
import { decodeQuad } from './drivers/compx-keyboard';
import { LAYOUT_GEOMETRY } from './catalog/generated/layout-geometry';
import {
  deriveLayout,
  findKnob,
  keepLayout,
  layoutAgreement,
  layoutHolds,
  placeKept,
} from './layout-check';
import { R98HE_FN_PAGES, r98hePages } from './r98he-keymap.fixture';

/** A recorded layer as the driver reads it: page p's quad q is slot p * 16 + q. */
function boardMap(pages: number[][]): Record<number, KeyBinding> {
  const out: Record<number, KeyBinding> = {};
  pages.forEach((bytes, p) => {
    for (let q = 0; q < 16; q++) {
      const raw = bytes.slice(q * 4, q * 4 + 4) as [number, number, number, number];
      out[p * 16 + q] = decodeQuad(p * 16 + q, raw);
    }
  });
  return out;
}

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

describe('deriveLayout', () => {
  const R98 = LAYOUT_GEOMETRY.Common98_SG9097_F!;
  const slotOf = (layout: readonly KeyLayoutEntry[], label: string) =>
    layout.filter((k) => k.label === label).map((k) => k.slot);

  it("places every key of the R98 HE's drawing on its recorded factory map", () => {
    const layout = deriveLayout(R98, boardMap(r98hePages()))!;
    expect(layout).toHaveLength(R98.length);
    // the 6-row column-major numbering the R85 HE's verified map has
    expect(slotOf(layout, 'ESC')).toEqual([0]);
    expect(slotOf(layout, 'CAPS')).toEqual([3]);
    expect(slotOf(layout, 'F1')).toEqual([6]);
    expect(slotOf(layout, 'A')).toEqual([9]);
    expect(slotOf(layout, 'Z')).toEqual([16]);
    expect(slotOf(layout, 'Space')).toEqual([41]);
    expect(slotOf(layout, 'FN')).toEqual([65]);
    expect(slotOf(layout, 'SHIFT')).toEqual([4, 76]);
    expect(slotOf(layout, 'NEnt')).toEqual([107]);
    expect(new Set(layout.map((k) => k.slot)).size).toBe(layout.length);
    // the knob's three bindings are not keys of the drawing
    expect(layout.some((k) => [120, 121, 122].includes(k.slot!))).toBe(false);
  });

  it('has the R85 HE factory Fn layer but for two keys', () => {
    const fn = boardMap(r98hePages(R98HE_FN_PAGES));
    const differ = Object.values(fn)
      .filter((b) => (KB_FN_DEFAULT_SLOTS[b.slot]?.raw ?? [0, 0, 0, 0]).join() !== b.raw.join())
      .map((b) => b.slot);
    // Fn+F4 is a plain Win+Tab here; slot 78 (Del here) has no Scroll Lock
    expect(differ).toEqual([24, 78]);
  });

  it('leaves out a key the owner remapped, and the key whose code it took', () => {
    const map = boardMap(r98hePages());
    map[3] = decodeQuad(3, [0, 0, 0xe0, 0]); // Caps Lock made a second left Ctrl
    const layout = deriveLayout(R98, map)!;
    expect(layout).toHaveLength(R98.length - 2);
    expect(slotOf(layout, 'CAPS')).toEqual([]);
    expect(layout.filter((k) => k.code === 0xe0)).toEqual([]);
  });

  it('leaves out keys swapped in the vendor app, rather than drawing them swapped', () => {
    // the R98 HE as it reads now: its owner swapped Del and Ins in the vendor
    // app during the recording, which writes the usage at byte 1
    const map = boardMap(r98hePages());
    map[78] = decodeQuad(78, [0, 73, 0, 0]);
    map[84] = decodeQuad(84, [0, 76, 0, 0]);
    const layout = deriveLayout(R98, map)!;
    expect(layout).toHaveLength(R98.length - 2);
    expect(slotOf(layout, 'DEL')).toEqual([]);
    expect(slotOf(layout, 'INS')).toEqual([]);
    expect(slotOf(layout, 'F12')).toEqual([72]);
  });

  it('places two keys of one code left to right, and only when the board has both', () => {
    const geometry: KeyLayoutEntry[] = [
      { label: 'Fn', code: null, row: 5, col: 9, x: 12, y: 5 },
      { label: 'A', code: 4, row: 3, col: 1, x: 1, y: 3 },
      { label: 'Fn', code: null, row: 5, col: 2, x: 3, y: 5 },
    ];
    const map: Record<number, KeyBinding> = {
      9: decodeQuad(9, [0, 0, 4, 0]),
      23: decodeQuad(23, [10, 1, 0, 0]),
      71: decodeQuad(71, [10, 1, 0, 0]),
    };
    expect(deriveLayout(geometry, map)!.map((k) => [k.col, k.slot])).toEqual([
      [9, 71],
      [1, 9],
      [2, 23],
    ]);
    delete map[71];
    expect(deriveLayout(geometry, map)).toBeNull();
  });

  it('refuses a drawing the board does not bear out', () => {
    // the R85 HE's drawing on the R98 HE's map: most codes are there, Ins is
    // not, and the arrows and the right-hand block sit elsewhere
    const r85 = ANSI_79_SG9047.map(({ slot: _slot, ...k }) => k);
    const map = boardMap(r98hePages());
    for (let s = 0; s < 128; s++) if (s % 3 === 0) map[s] = decodeQuad(s, [0, 0, 0, 0]);
    expect(deriveLayout(r85, map)).toBeNull();
    expect(deriveLayout([], boardMap(r98hePages()))).toBeNull();
  });
});

describe('keepLayout / placeKept', () => {
  const R98 = LAYOUT_GEOMETRY.Common98_SG9097_F!;
  const layout = deriveLayout(R98, boardMap(r98hePages()))!;

  it('lays a kept layout back on its drawing exactly', () => {
    const kept = JSON.parse(JSON.stringify(keepLayout(layout)));
    expect(placeKept(R98, kept)).toEqual(layout);
  });

  it('does not believe a record that no longer fits the drawing', () => {
    expect(placeKept(R98, undefined)).toBeNull();
    expect(placeKept(R98, [])).toBeNull();
    expect(placeKept(R98, [['a', 0, 1]])).toBeNull();
    // a key the drawing no longer has
    expect(placeKept(R98, [...keepLayout(layout), [9, 9, 127]])).toBeNull();
    // two keys on one slot
    const twice = keepLayout(layout).map(([r, c, s], i) => [r, c, i === 1 ? 0 : s]);
    expect(placeKept(R98, twice)).toBeNull();
  });
});

describe('findKnob', () => {
  const R98 = LAYOUT_GEOMETRY.Common98_SG9097_F!;

  it("finds the R98 HE's knob beside its keys: Volume -, Volume + and Mute", () => {
    const map = boardMap(r98hePages());
    expect(findKnob(map, deriveLayout(R98, map)!)).toEqual({ left: 120, right: 121, press: 122 });
  });

  it('does not guess at a knob its owner remapped', () => {
    const map = boardMap(r98hePages());
    map[122] = decodeQuad(122, [3, 0, 0xcd, 0]); // the press made Play / Pause
    expect(findKnob(map, deriveLayout(R98, map)!)).toBeNull();
  });
});
