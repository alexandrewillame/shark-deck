import { describe, expect, it } from 'vitest';
import { MIN_PANEL_HEIGHT, placeAnchored } from './usePortalPosition';

/**
 * Where every floating panel in the app ends up: tooltips, the language menu,
 * the device colour picker, the key-group colour popover, the All-keys menu.
 *
 * The case worth pinning is `maxHeight`. CSS can only cap a panel at some
 * fraction of the viewport — it has no idea how much room is left below the
 * button that opened it — so a panel taller than that room ran off the bottom
 * of the window with no way to reach its lower half, which is exactly what the
 * All-keys menu did on a short window.
 */
const base = {
  bubble: { width: 300, height: 400 },
  viewport: { width: 1280, height: 800 },
  gap: 8,
  margin: 8,
  align: 'start' as const,
  placement: 'bottom' as const,
};
const anchorAt = (top: number, height = 24) => ({
  top,
  bottom: top + height,
  left: 100,
  right: 400,
  width: 300,
});

describe('placeAnchored', () => {
  it('sits under the anchor when there is room', () => {
    const p = placeAnchored({ ...base, anchor: anchorAt(100) });
    expect(p.placement).toBe('bottom');
    expect(p.top).toBe(132); // 100 + 24 + gap
  });

  it('never runs past the bottom of the window', () => {
    // A 400px panel opened from a button 600px down a 800px window.
    const p = placeAnchored({ ...base, anchor: anchorAt(600) });
    expect(p.top + p.maxHeight).toBeLessThanOrEqual(base.viewport.height - base.margin);
  });

  it('caps the height to the room it actually has', () => {
    // Window shorter than the panel: it cannot fit, so it must be told how
    // tall it may be rather than silently overflowing.
    const p = placeAnchored({
      ...base,
      anchor: anchorAt(40),
      viewport: { width: 1280, height: 300 },
    });
    expect(p.top).toBeGreaterThanOrEqual(base.margin);
    expect(p.top + p.maxHeight).toBeLessThanOrEqual(300 - base.margin);
    expect(p.maxHeight).toBeLessThan(base.bubble.height);
  });

  it('gives a panel that fits its full height back', () => {
    // No scrolling when none is needed: the cap must not be so conservative
    // that a panel with room to spare still scrolls.
    const p = placeAnchored({ ...base, anchor: anchorAt(100) });
    expect(p.maxHeight).toBeGreaterThanOrEqual(base.bubble.height);
  });

  it('keeps a floor, so a tiny window does not squeeze a panel to nothing', () => {
    // Below this the panel would be too short to show anything useful, so it
    // is allowed to overflow rather than be squeezed into a slit. 130px of
    // window leaves 114px of room, which is under the floor.
    const p = placeAnchored({
      ...base,
      anchor: anchorAt(10),
      viewport: { width: 1280, height: 130 },
    });
    expect(p.maxHeight).toBe(MIN_PANEL_HEIGHT);
  });

  it('places above when asked, and caps to the room above', () => {
    const p = placeAnchored({ ...base, anchor: anchorAt(500), placement: 'top' });
    expect(p.placement).toBe('top');
    expect(p.top).toBeGreaterThanOrEqual(base.margin);
    expect(p.top + p.maxHeight).toBeLessThanOrEqual(base.viewport.height - base.margin);
  });

  it('flips above on auto when there is room there and not below', () => {
    const p = placeAnchored({ ...base, anchor: anchorAt(600), placement: 'auto' });
    expect(p.placement).toBe('top');
  });

  it('clamps horizontally to the viewport', () => {
    const wide = { ...base, anchor: { ...anchorAt(100), left: 1200, right: 1260 } };
    const p = placeAnchored(wide);
    expect(p.left).toBeLessThanOrEqual(1280 - 300 - 8);
    expect(p.left).toBeGreaterThanOrEqual(8);
  });

  it('honours the alignment', () => {
    const anchor = anchorAt(100);
    expect(placeAnchored({ ...base, anchor, align: 'start' }).left).toBe(100);
    expect(placeAnchored({ ...base, anchor, align: 'end' }).left).toBe(100);
    // Centre: anchor centre 250, bubble 300 wide -> 100.
    expect(placeAnchored({ ...base, anchor, align: 'center' }).left).toBe(100);
  });
});

describe('placeAnchored beside the anchor', () => {
  const side = {
    bubble: { width: 240, height: 80 },
    viewport: { width: 1280, height: 800 },
    gap: 8,
    margin: 8,
    align: 'start' as const,
  };
  const row = { top: 300, bottom: 330, left: 600, right: 800, width: 200 };

  it('sits to the right, tops level, when there is room', () => {
    const p = placeAnchored({ ...side, anchor: row, placement: 'right' });
    expect(p.placement).toBe('right');
    expect(p.left).toBe(808);
    expect(p.top).toBe(300);
  });

  it('moves to the left when the right would run off the window', () => {
    const p = placeAnchored({
      ...side,
      anchor: { ...row, left: 1000, right: 1200 },
      placement: 'right',
    });
    expect(p.placement).toBe('left');
    expect(p.left).toBe(1000 - 8 - 240);
  });

  it('honours left, and falls back to the right only when the left cannot fit', () => {
    expect(placeAnchored({ ...side, anchor: row, placement: 'left' }).placement).toBe('left');
    const p = placeAnchored({
      ...side,
      anchor: { ...row, left: 20, right: 220 },
      placement: 'left',
    });
    expect(p.placement).toBe('right');
  });

  it('stays inside the window vertically', () => {
    const p = placeAnchored({
      ...side,
      anchor: { ...row, top: 770, bottom: 795 },
      placement: 'right',
    });
    expect(p.top + side.bubble.height).toBeLessThanOrEqual(800 - 8);
  });
});
