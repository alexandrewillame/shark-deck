import { describe, expect, it } from 'vitest';
import { LOD_OPTIONS, POLL_RATE_WIRE, pollRateFromWire, pollRateToWire } from './mouse-options';

/**
 * The V8's lift-off distance and polling rate are WIRE values from the vendor
 * Mouse Hub, not list indices. Regressions here mean the app writes the wrong
 * byte to the device (e.g. 0.7 mm silently truncating to 0).
 */
describe('LOD options (vendor Mouse Hub LODOptions)', () => {
  it('exposes 0.7 / 1 / 2 mm', () => {
    expect(LOD_OPTIONS.map((o) => o.mm)).toEqual([0.7, 1, 2]);
  });
  it('0.7 mm is wire value 3, not 0', () => {
    expect(LOD_OPTIONS.find((o) => o.mm === 0.7)?.wire).toBe(3);
  });
});

describe('poll-rate wire mapping (bitmask, not index)', () => {
  const pairs: Array<[hz: number, wire: number]> = [
    [125, 8],
    [250, 4],
    [500, 2],
    [1000, 1],
    [2000, 16],
    [4000, 32],
    [8000, 64],
  ];
  for (const [hz, wire] of pairs) {
    it(`${hz} Hz <-> wire ${wire}`, () => {
      expect(pollRateToWire(hz)).toBe(wire);
      expect(pollRateFromWire(wire)).toBe(hz);
    });
  }
  it('covers every rate the vendor lists', () => {
    expect(POLL_RATE_WIRE.map((r) => r.hz)).toEqual([125, 250, 500, 1000, 2000, 4000, 8000]);
  });
  it('an unknown rate falls back to the top wire value', () => {
    expect(pollRateToWire(999)).toBe(64);
  });
});
