import { describe, expect, it } from 'vitest';
import { iconPx } from './icons';

/**
 * Locks the one rule behind `iconPx`: no glyph in the UI renders smaller than
 * `ICON_MIN_PX`, whatever a call site asks for.
 *
 * Call sites size icons by eye against the text next to them, which is how ~55
 * of them ended up at 11-14px — too small for the 26-34px buttons most of them
 * actually sit alone inside. The scale lives in one place precisely so it
 * cannot drift back, and this is what says so.
 */
describe('iconPx', () => {
  it('never renders a glyph below the floor, however small the request', () => {
    for (const requested of [1, 4, 8, 10, 11, 12]) {
      expect(iconPx(requested)).toBeGreaterThanOrEqual(14);
    }
  });

  it('scales up rather than clamping, once past the floor', () => {
    expect(iconPx(13)).toBe(17);
    expect(iconPx(14)).toBe(18);
    expect(iconPx(16)).toBe(21);
  });

  it('is monotonic, so a call site asking for more never gets less', () => {
    const sizes = [11, 12, 13, 14, 16, 20, 24].map(iconPx);
    for (let i = 1; i < sizes.length; i++) expect(sizes[i]!).toBeGreaterThanOrEqual(sizes[i - 1]!);
  });
});
