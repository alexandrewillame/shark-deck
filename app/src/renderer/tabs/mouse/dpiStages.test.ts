import { describe, expect, it } from 'vitest';
import type { DpiStage } from '@shared/types/mouse-settings';
import {
  MAX_STAGES,
  MIN_STAGES,
  NEW_STAGE_COLORS,
  clamp01,
  colorDistance,
  computeDpiWindow,
  niceDpiStep,
  pickNewStageColor,
  snapDpi,
} from './dpiStages';

/**
 * These were buried in the middle of a 1,760-line sections.tsx, so they could
 * not be reached from a test without importing a file full of React. Pulling
 * them into their own module is most of what made this suite possible.
 *
 * All pure, all cheap, and all guarding real device writes: snapDpi is the
 * last thing between a half-typed number field and a value on the wire.
 */

const stage = (dpi: number, enabled = true): DpiStage =>
  ({ dpi, enabled, color: [255, 0, 0] }) as DpiStage;

describe('snapDpi', () => {
  const rng = { min: 50, max: 42000, step: 50 };

  it('snaps to the nearest whole step', () => {
    expect(snapDpi(823, rng)).toBe(800);
    expect(snapDpi(826, rng)).toBe(850);
    expect(snapDpi(800, rng)).toBe(800);
  });

  it('clamps to the device range rather than writing outside it', () => {
    expect(snapDpi(-5000, rng)).toBe(50);
    expect(snapDpi(99999, rng)).toBe(42000);
  });

  it('falls back to the minimum for a non-finite draft', () => {
    // The number field can legitimately hold a bare "-" or be emptied
    // mid-edit. Propagating NaN into a device write is the failure this
    // guards, so it must never come back as NaN.
    expect(snapDpi(NaN, rng)).toBe(50);
    // Infinity is non-finite too, so it takes the same rng.min fallback
    // rather than clamping to rng.max. Deliberate: the guard is about a
    // draft that is not a usable number at all, not about an out-of-range
    // one (which the clamp above handles).
    expect(snapDpi(Infinity, rng)).toBe(50);
    expect(snapDpi(-Infinity, rng)).toBe(50);
  });

  it('respects a coarser step', () => {
    expect(snapDpi(1234, { min: 100, max: 26000, step: 100 })).toBe(1200);
    expect(snapDpi(1250, { min: 100, max: 26000, step: 100 })).toBe(1300);
  });
});

describe('colorDistance', () => {
  it('is zero for identical colours and symmetric', () => {
    expect(colorDistance([10, 20, 30], [10, 20, 30])).toBe(0);
    expect(colorDistance([255, 0, 0], [0, 255, 0])).toBeCloseTo(
      colorDistance([0, 255, 0], [255, 0, 0]),
    );
  });

  it('measures Euclidean RGB distance', () => {
    expect(colorDistance([0, 0, 0], [3, 4, 0])).toBe(5);
  });

  it('keeps the palette above the collision threshold it is checked against', () => {
    // pickNewStageColor rejects candidates closer than 110. If the palette's
    // own closest pair ever fell below that, every add would hit the
    // fallback path instead of cycling.
    let closest = Infinity;
    for (let i = 0; i < NEW_STAGE_COLORS.length; i++) {
      for (let j = i + 1; j < NEW_STAGE_COLORS.length; j++) {
        closest = Math.min(closest, colorDistance(NEW_STAGE_COLORS[i], NEW_STAGE_COLORS[j]));
      }
    }
    expect(closest).toBeGreaterThan(110);
  });
});

describe('pickNewStageColor', () => {
  it('cycles from startAt when nothing collides', () => {
    expect(pickNewStageColor([], 0)).toEqual(NEW_STAGE_COLORS[0]);
    expect(pickNewStageColor([], 2)).toEqual(NEW_STAGE_COLORS[2]);
  });

  it('wraps around the palette', () => {
    expect(pickNewStageColor([], NEW_STAGE_COLORS.length)).toEqual(NEW_STAGE_COLORS[0]);
    expect(pickNewStageColor([], NEW_STAGE_COLORS.length + 1)).toEqual(NEW_STAGE_COLORS[1]);
  });

  it('skips a colour already on the device', () => {
    const picked = pickNewStageColor([NEW_STAGE_COLORS[0]], 0);
    expect(picked).not.toEqual(NEW_STAGE_COLORS[0]);
    expect(NEW_STAGE_COLORS).toContainEqual(picked);
  });

  it('skips a colour merely close to one in use', () => {
    // Not an exact match, but well inside the 110 threshold.
    const nearlyRed: [number, number, number] = [250, 8, 8];
    expect(pickNewStageColor([nearlyRed], 0)).not.toEqual(NEW_STAGE_COLORS[0]);
  });

  it('falls back to the furthest option when every palette entry collides', () => {
    // More stages than distinct palette colours: no candidate can clear the
    // threshold, so it must still return the least-bad one rather than
    // blindly repeating an exact match.
    const all = NEW_STAGE_COLORS.map((c) => [...c] as [number, number, number]);
    const picked = pickNewStageColor(all, 0);
    expect(NEW_STAGE_COLORS).toContainEqual(picked);
  });

  it('always returns a palette member', () => {
    for (let start = 0; start < 10; start++) {
      expect(NEW_STAGE_COLORS).toContainEqual(pickNewStageColor([[128, 128, 128]], start));
    }
  });
});

describe('clamp01', () => {
  it('clamps to the unit interval', () => {
    expect(clamp01(-1)).toBe(0);
    expect(clamp01(0.5)).toBe(0.5);
    expect(clamp01(2)).toBe(1);
  });
});

describe('niceDpiStep', () => {
  it('coarsens as the span grows', () => {
    expect(niceDpiStep(1000)).toBe(100);
    expect(niceDpiStep(4000)).toBe(100);
    expect(niceDpiStep(4001)).toBe(500);
    expect(niceDpiStep(20000)).toBe(500);
    expect(niceDpiStep(20001)).toBe(1000);
  });
});

describe('computeDpiWindow', () => {
  const rng = { min: 50, max: 42000 };

  it('brackets the enabled stages instead of showing the full device range', () => {
    // The whole point: most stages sit in 400-3200 of a 50-42000 range, so a
    // linear full-range track is nearly all dead space.
    const w = computeDpiWindow([stage(800), stage(1600), stage(3200)], rng);
    expect(w.min).toBeLessThanOrEqual(800);
    expect(w.max).toBeGreaterThanOrEqual(3200);
    expect(w.max - w.min).toBeLessThan(rng.max - rng.min);
  });

  it('ignores disabled stages', () => {
    const withDisabled = computeDpiWindow([stage(800), stage(30000, false)], rng);
    const withoutIt = computeDpiWindow([stage(800)], rng);
    expect(withDisabled).toEqual(withoutIt);
  });

  it('enforces a minimum span so a single stage is still draggable', () => {
    const w = computeDpiWindow([stage(1600)], rng);
    expect(w.max - w.min).toBeGreaterThanOrEqual(1600);
  });

  it('stays inside the device range', () => {
    const low = computeDpiWindow([stage(50)], rng);
    expect(low.min).toBeGreaterThanOrEqual(rng.min);
    const high = computeDpiWindow([stage(42000)], rng);
    expect(high.max).toBeLessThanOrEqual(rng.max);
  });

  it('snaps the bounds outward to a round step', () => {
    // Un-snapped bounds would visibly creep on every small drag.
    const w = computeDpiWindow([stage(830), stage(3170)], rng);
    const step = niceDpiStep(w.max - w.min);
    expect(w.min % step).toBe(0);
    expect(w.max % step).toBe(0);
  });

  it('falls back to the full range when no stage is enabled and the window degenerates', () => {
    const w = computeDpiWindow([stage(800, false)], rng);
    expect(w.min).toBeGreaterThanOrEqual(rng.min);
    expect(w.max).toBeGreaterThan(w.min);
  });

  it('handles an empty stage list', () => {
    const w = computeDpiWindow([], rng);
    expect(w.max).toBeGreaterThan(w.min);
  });
});

describe('stage-count bounds', () => {
  it('are a sane, ordered pair', () => {
    expect(MIN_STAGES).toBeGreaterThanOrEqual(1);
    expect(MAX_STAGES).toBeGreaterThan(MIN_STAGES);
  });
});
