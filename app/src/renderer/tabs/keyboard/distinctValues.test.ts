import { describe, expect, it } from 'vitest';
import type { MagneticKeySettings } from '@shared/types/keyboard-settings';
import { distinctValues, mixedFields } from './magneticSelection';

const key = (over: Partial<MagneticKeySettings> = {}): MagneticKeySettings => ({
  row: 0,
  col: 0,
  actuationMm: 1.5,
  rapidTrigger: false,
  ...over,
});

/**
 * `mixedFields` answers "do these disagree", which is enough to blank a number
 * and not enough to draw the control: the slider handle still had to sit
 * somewhere, and a handle parked at the first selected key's depth beside a
 * blanked number reads as "they are all set to this". They are not.
 */
describe('distinctValues', () => {
  it('says nothing about a single key', () => {
    expect(distinctValues([key()])).toEqual({});
  });

  it('says nothing where the selection agrees', () => {
    expect(distinctValues([key(), key(), key()])).toEqual({});
  });

  it('lists every value the selection holds, in order', () => {
    const d = distinctValues([
      key({ actuationMm: 2 }),
      key({ actuationMm: 0.5 }),
      key({ actuationMm: 1.2 }),
    ]);
    expect(d.actuationMm).toEqual([0.5, 1.2, 2]);
  });

  it('collapses duplicates — one marker per value, not per key', () => {
    const d = distinctValues([
      key({ actuationMm: 2 }),
      key({ actuationMm: 2 }),
      key({ actuationMm: 2 }),
      key({ actuationMm: 1 }),
    ]);
    expect(d.actuationMm).toEqual([1, 2]);
  });

  it('reports each field independently', () => {
    // Same actuation, different release: only release gets markers.
    const d = distinctValues([key({ releaseMm: 1 }), key({ releaseMm: 1.4 })]);
    expect(d.actuationMm).toBeUndefined();
    expect(d.releaseMm).toEqual([1, 1.4]);
  });

  it('agrees with mixedFields about which fields differ', () => {
    const sel = [
      key({ actuationMm: 1, releaseMm: 1, deadZoneMm: 0.2 }),
      key({ actuationMm: 2, releaseMm: 1, deadZoneMm: 0.3 }),
    ];
    const m = mixedFields(sel);
    const d = distinctValues(sel);
    for (const f of ['actuationMm', 'releaseMm', 'deadZoneMm'] as const) {
      expect(!!d[f], `${f}: markers disagree with mixedFields`).toBe(!!m[f]);
    }
  });

  it('ignores non-numeric fields, which have no position on the axis', () => {
    const d = distinctValues([key({ rapidTrigger: true }), key({ rapidTrigger: false })]);
    expect((d as Record<string, unknown>).rapidTrigger).toBeUndefined();
  });
});
