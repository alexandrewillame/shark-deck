import { describe, it, expect } from 'vitest';
import { KB_TRAVEL_RANGE as T } from '@shared/keyboard-travel';
import {
  ASSEMBLY_H,
  AXIS_BOTTOM,
  AXIS_TOP,
  STAGE_H,
  THUMB_PX,
  TOTAL_MM,
  dodgeLabels,
  mmToPx,
  sliderTrack,
  travelColumnLayout,
} from './switchGeometry';

/**
 * The Actuation tab's key viewer draws marker lines from `mmToPx` and lays
 * slider handles on the same rows. Two reported defects live in this file's
 * maths, so both get locked down here:
 *
 *  - marker labels printed on top of each other whenever two settings were
 *    within ~0.19 mm (stock actuation 1.50 / release 1.30 already collide,
 *    and the live "Now" marker crosses the actuation point constantly), and
 *  - slider handles sat up to 7px off the very line they control.
 */

describe('dodgeLabels', () => {
  const GAP = 13;

  it('leaves well-separated labels exactly where they are', () => {
    const ys = [60, 120, 200];
    expect(dodgeLabels(ys, GAP, 0, 400)).toEqual(ys);
  });

  it('separates the stock actuation/release pair', () => {
    // 1.50 mm and 1.30 mm are 12px apart at 60px/mm — under one line box.
    const ys = [mmToPx(1.5), mmToPx(1.3)];
    const out = dodgeLabels(ys, GAP, 0, 400);
    expect(Math.abs(out[0]! - out[1]!)).toBeGreaterThanOrEqual(GAP);
  });

  it('keeps results in the input order, not sorted order', () => {
    // Deepest value first: the returned array must still describe markers in
    // the order given, or every label lands on the wrong line.
    const [deep, shallow] = dodgeLabels([200, 100], GAP, 0, 400);
    expect(deep).toBeGreaterThan(shallow!);
  });

  it('separates every pair in a fully-collided cluster', () => {
    const out = dodgeLabels([100, 101, 102, 103, 104, 105, 106], GAP, 0, 400);
    const sorted = [...out].sort((a, b) => a - b);
    for (let i = 1; i < sorted.length; i++) {
      expect(sorted[i]! - sorted[i - 1]!).toBeGreaterThanOrEqual(GAP - 1e-9);
    }
  });

  it('pulls a cluster at the bottom edge back inside the canvas', () => {
    // All seven markers pinned at the deepest row — a real case, since mmToPx
    // clamps anything past TOTAL_MM onto AXIS_BOTTOM.
    const maxY = 380;
    const out = dodgeLabels(new Array(7).fill(AXIS_BOTTOM), GAP, 12, maxY);
    for (const y of out) {
      expect(y).toBeLessThanOrEqual(maxY);
      expect(y).toBeGreaterThanOrEqual(12);
    }
    const sorted = [...out].sort((a, b) => a - b);
    for (let i = 1; i < sorted.length; i++) {
      expect(sorted[i]! - sorted[i - 1]!).toBeGreaterThanOrEqual(GAP - 1e-9);
    }
  });

  it('pulls a cluster at the top edge down inside the canvas', () => {
    const out = dodgeLabels(new Array(5).fill(AXIS_TOP), GAP, 12, 380);
    for (const y of out) expect(y).toBeGreaterThanOrEqual(12);
    const sorted = [...out].sort((a, b) => a - b);
    for (let i = 1; i < sorted.length; i++) {
      expect(sorted[i]! - sorted[i - 1]!).toBeGreaterThanOrEqual(GAP - 1e-9);
    }
  });

  it('handles the empty and single cases', () => {
    expect(dodgeLabels([], GAP, 0, 400)).toEqual([]);
    expect(dodgeLabels([50], GAP, 0, 400)).toEqual([50]);
  });
});

describe('sliderTrack', () => {
  /** Where Chromium puts a range thumb's centre for `value` on this track. */
  const thumbCentre = (
    track: { top: number; height: number },
    value: number,
    min: number,
    max: number,
  ) => track.top + THUMB_PX / 2 + ((value - min) / (max - min)) * (track.height - THUMB_PX);

  it('puts the thumb centre exactly on the marker line at both extremes', () => {
    // The actuation column: value range and axis range are the same here.
    const track = sliderTrack(0.1, TOTAL_MM);
    expect(thumbCentre(track, 0.1, 0.1, TOTAL_MM)).toBeCloseTo(mmToPx(0.1), 6);
    expect(thumbCentre(track, TOTAL_MM, 0.1, TOTAL_MM)).toBeCloseTo(mmToPx(TOTAL_MM), 6);
  });

  it('still agrees at the midpoint, which the old layout also got right', () => {
    const track = sliderTrack(0.1, TOTAL_MM);
    const mid = (0.1 + TOTAL_MM) / 2;
    expect(thumbCentre(track, mid, 0.1, TOTAL_MM)).toBeCloseTo(mmToPx(mid), 6);
  });

  it('is a strict improvement on laying the input out at the raw span', () => {
    // The old geometry, for comparison: top = mmToPx(from), height = span.
    const old = { top: mmToPx(0.1), height: mmToPx(TOTAL_MM) - mmToPx(0.1) };
    const oldErr = Math.abs(thumbCentre(old, 0.1, 0.1, TOTAL_MM) - mmToPx(0.1));
    expect(oldErr).toBeCloseTo(THUMB_PX / 2, 6); // 7px — the reported drift
    const now = Math.abs(thumbCentre(sliderTrack(0.1, TOTAL_MM), 0.1, 0.1, TOTAL_MM) - mmToPx(0.1));
    expect(now).toBeLessThan(1e-6);
  });

  it('works for the dead-zone columns, whose track is a sub-range of the axis', () => {
    const track = sliderTrack(TOTAL_MM - 1, TOTAL_MM);
    expect(track.height).toBeCloseTo(mmToPx(TOTAL_MM) - mmToPx(TOTAL_MM - 1) + THUMB_PX, 6);
    expect(track.top).toBeCloseTo(mmToPx(TOTAL_MM - 1) - THUMB_PX / 2, 6);
  });
});

describe('the drawn assembly fits the axis headroom', () => {
  it('leaves room above 0 mm for magnet + stem + keycap and the tick label', () => {
    // The datum is the magnet's bottom face, and everything above it is drawn
    // upward from there — so AXIS_TOP has to be at least the assembly height.
    // If someone grows the keycap or the stem without moving AXIS_TOP, the
    // cap is clipped off the top of the SVG; this is the guard.
    expect(AXIS_TOP).toBeGreaterThanOrEqual(ASSEMBLY_H);
    // …with a few px left for the "0 mm" numeral, which is drawn at that row.
    expect(AXIS_TOP - ASSEMBLY_H).toBeGreaterThanOrEqual(8);
  });

  it('puts the magnet face on the sensor line at full travel', () => {
    // 0 mm is the magnet face at rest and TOTAL_MM is the bottom of travel, so
    // a fully-pressed key must land the face exactly on the PCB row.
    expect(mmToPx(TOTAL_MM)).toBe(AXIS_BOTTOM);
    expect(mmToPx(0)).toBe(AXIS_TOP);
  });
});

describe('the stage fits its slider columns', () => {
  // Every column SwitchTravelStage draws, by the mm span its track covers.
  const columns = [
    { name: 'actuation / release', from: T.travel.min, to: T.travel.max, above: false },
    { name: 'rapid trigger', from: 0, to: T.rt.max, above: false },
    { name: 'top dead zone', from: 0, to: 1, above: false },
    { name: 'bottom dead zone', from: TOTAL_MM - 1, to: TOTAL_MM, above: true },
  ];
  const bottomOf = (b: { top: number; height: number }) => b.top + b.height;

  it('keeps every header, track and value inside the stage', () => {
    for (const c of columns) {
      const l = travelColumnLayout(c.from, c.to, c.above);
      expect(l.header.top, c.name).toBeGreaterThanOrEqual(0);
      expect(bottomOf(l.track), c.name).toBeLessThanOrEqual(STAGE_H);
      expect(bottomOf(l.value), c.name).toBeLessThanOrEqual(STAGE_H);
    }
  });

  it('never lays a value over its own slider', () => {
    for (const c of columns) {
      const l = travelColumnLayout(c.from, c.to, c.above);
      if (c.above) expect(bottomOf(l.value), c.name).toBeLessThanOrEqual(l.track.top);
      else expect(l.value.top, c.name).toBeGreaterThanOrEqual(bottomOf(l.track));
    }
  });

  it('stacks the two dead zones in their shared column without overlap', () => {
    const top = travelColumnLayout(0, 1);
    const bottom = travelColumnLayout(TOTAL_MM - 1, TOTAL_MM, true);
    expect(bottom.header.top).toBeGreaterThanOrEqual(bottomOf(top.value));
  });

  it('would not fit the bottom dead zone with its value underneath', () => {
    // Why that one column prints its value above the track: underneath, it was
    // the only thing on the stage below the bottom of travel, and the stage
    // was a whole value box taller than everything else needed.
    expect(bottomOf(travelColumnLayout(TOTAL_MM - 1, TOTAL_MM).value)).toBeGreaterThan(STAGE_H);
  });
});
