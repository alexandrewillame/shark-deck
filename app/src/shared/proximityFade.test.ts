import { describe, expect, it } from 'vitest';
import { FADE_RADIUS_PX, distanceToRect, proximity } from './proximityFade';

const CARD = { left: 100, top: 100, right: 300, bottom: 160 };

describe('proximity fade', () => {
  it('is fully faded with the pointer on the card', () => {
    expect(distanceToRect(150, 120, CARD)).toBe(0);
    expect(proximity(150, 120, CARD)).toBe(0);
    // The edge counts as on it.
    expect(proximity(300, 160, CARD)).toBe(0);
  });

  it('measures to the nearest edge, or the corner', () => {
    expect(distanceToRect(50, 130, CARD)).toBe(50); // left of it
    expect(distanceToRect(200, 200, CARD)).toBe(40); // below it
    expect(distanceToRect(330, 200, CARD)).toBe(50); // off the corner: 30-40-50
  });

  it('comes back gradually, and is whole beyond the radius', () => {
    expect(proximity(100 - FADE_RADIUS_PX / 2, 130, CARD)).toBeCloseTo(0.5, 6);
    expect(proximity(100 - FADE_RADIUS_PX, 130, CARD)).toBe(1);
    expect(proximity(-1000, -1000, CARD)).toBe(1);
  });
});
