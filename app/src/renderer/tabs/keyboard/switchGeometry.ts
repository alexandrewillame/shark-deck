/**
 * Shared mm <-> px mapping for the actuation stage — both `SwitchCrossSection`
 * (the switch illustration) and `SwitchTravelStage` (the illustration + its
 * four vertical sliders) import this so a marker drawn in the SVG and the
 * slider handle that controls it land on the exact same pixel row without
 * either side hand-tuning offsets to match the other. Same idea as
 * `.angle-mode-stage` in styles.css (the stage is sized to the illustration's
 * own rendered width so the slider's midpoint lands on the crosshair),
 * generalised to a vertical axis with a non-zero origin.
 */

/** Full Hall-effect key travel in millimetres — matches every depth slider's
 *  own `max`. */
export const TOTAL_MM = 4;

/**
 * y (px) of 0 mm (top of travel) in the stage's own coordinate space.
 *
 * 0 mm is the **magnet's bottom face at rest** — that is the surface the Hall
 * sensor actually measures, and therefore the only thing every marker on this
 * axis can honestly be referenced to. The datum used to be the keycap
 * underside, which sits a fixed distance above the magnet, so every line was
 * drawn against the wrong feature.
 *
 * The headroom above this row has to fit the whole moving assembly at rest —
 * magnet, stem and keycap, stacked upward from the datum (see ASSEMBLY below)
 * — plus the "0 mm" tick label. It was 48 when only the keycap had to fit.
 */
export const AXIS_TOP = 74;

/**
 * The moving assembly, measured UP from the magnet's bottom face (the datum).
 * Drawn in this order from the datum: magnet, then stem, then keycap.
 *
 * Kept here rather than in `SwitchCrossSection` because `AXIS_TOP` has to be
 * large enough to hold the total, and the two must not drift apart —
 * `switchGeometry.test.ts` asserts exactly that.
 */
export const ASSEMBLY = {
  magnetH: 10,
  stemH: 26,
  keycapH: 18,
  /** Gap between the housing's top lip and the keycap's underside at rest. */
  capGap: 4,
} as const;

/** Total px the assembly occupies above the datum when the key is at rest. */
export const ASSEMBLY_H = ASSEMBLY.magnetH + ASSEMBLY.stemH + ASSEMBLY.capGap + ASSEMBLY.keycapH;

/** Height (px) of the full 0 -> TOTAL_MM span. */
export const AXIS_H = 240;

/** y (px) of TOTAL_MM (bottom of travel / PCB line). */
export const AXIS_BOTTOM = AXIS_TOP + AXIS_H;

const clampMm = (mm: number) => Math.max(0, Math.min(TOTAL_MM, mm));

/** Millimetres of travel -> y in stage px. */
export function mmToPx(mm: number): number {
  return AXIS_TOP + (clampMm(mm) / TOTAL_MM) * AXIS_H;
}

/** Signed pixel span between two mm depths (positive = downward/deeper). */
export function spanPx(fromMm: number, toMm: number): number {
  return mmToPx(toMm) - mmToPx(fromMm);
}

/**
 * Diameter (px) of a `VerticalSlider` thumb. **Must stay equal to the
 * `width`/`height` of `.switch-stage-col-track input.vslider::-webkit-slider-thumb`
 * in styles.css** — `TravelSliderColumn` uses it to cancel Chromium's thumb
 * inset, and the two drifting apart puts every handle back off its own marker
 * line.
 *
 * Why it's needed: a range input centres its thumb at `thumb/2` from each end
 * of the track, so a track laid out to span exactly [fromMm, toMm] can only
 * reach `min` at `thumb/2` px in and `max` at `thumb/2` px short — up to 7px
 * (~0.12 mm here) of visible error against the SVG tick the handle is supposed
 * to sit on, worst at the two extremes and zero at the midpoint. Rendering the
 * input `THUMB_PX` taller and shifting it up by half that makes the thumb
 * *centre*, not its edge, sweep the true mm span.
 */
export const THUMB_PX = 14;

/**
 * Where to lay out a `VerticalSlider` so its thumb *centre*, not its edge,
 * sweeps the [fromMm, toMm] span — cancelling the inset described above.
 * `TravelSliderColumn` positions the input at `top` with height `height`;
 * everything else in the column (header, value) still keys off the true
 * `mmToPx(fromMm)`.
 */
export function sliderTrack(fromMm: number, toMm: number): { top: number; height: number } {
  return { top: mmToPx(fromMm) - THUMB_PX / 2, height: spanPx(fromMm, toMm) + THUMB_PX };
}

/** Height (px) of a slider column's header box: up to two lines of a 10px
 *  label plus its info icon (`.switch-stage-col-label`). */
export const COL_HEADER_H = 44;
/** Gap (px) between a header box and what it sits on. */
export const COL_HEADER_GAP = 6;
/** Height (px) of a slider column's value box — one `EditableNumber`.
 *  **Must stay equal to `.switch-stage-col-value`'s `height` in
 *  device-art.css**, which pins it so the two cannot drift. */
export const COL_VALUE_H = 20;
/** Gap (px) between a track's end and its value box. */
export const COL_VALUE_GAP = 8;

interface Box {
  top: number;
  height: number;
}

/**
 * Where one slider column puts its three parts, in stage px: the header, the
 * range input (see `sliderTrack`), and the editable value.
 *
 * The value normally hangs below the track. `valueAbove` puts it between the
 * header and the track instead — for the bottom dead zone, whose track ends
 * on the very bottom of travel: a value under it hung below every other
 * column and was the only reason the stage needed room under the axis.
 */
export function travelColumnLayout(
  fromMm: number,
  toMm: number,
  valueAbove = false,
): { header: Box; track: Box; value: Box } {
  const trackTop = mmToPx(fromMm);
  const value: Box = valueAbove
    ? { top: trackTop - COL_VALUE_GAP - COL_VALUE_H, height: COL_VALUE_H }
    : { top: mmToPx(toMm) + COL_VALUE_GAP, height: COL_VALUE_H };
  const headerBottom = (valueAbove ? value.top : trackTop) - COL_HEADER_GAP;
  return {
    header: { top: headerBottom - COL_HEADER_H, height: COL_HEADER_H },
    track: sliderTrack(fromMm, toMm),
    value,
  };
}

/**
 * Room (px) the stage keeps below the bottom of travel: the "bottom" tick
 * label and the descent of a marker label dodged onto the lowest row. Nothing
 * in the slider columns goes below the axis — `switchGeometry.test.ts` checks
 * that, against every column's real range.
 */
export const STAGE_FOOT = 14;

/** Total height (px) of the actuation stage — the switch illustration's SVG
 *  and the slider columns beside it, which must match for every marker and
 *  its handle to share a pixel row. */
export const STAGE_H = AXIS_BOTTOM + STAGE_FOOT;

/**
 * Nudge a set of label rows apart so no two are closer than `minGap`, keeping
 * them inside [minY, maxY] and preserving their original order. Returns new
 * y's in the same order as `ys` — the caller draws each marker LINE at its
 * true y and only the label at the returned one, with a leader between them.
 *
 * Two sweeps, both needed. Downward alone cascades a cluster off the bottom of
 * the canvas (top dead zone 0.05 / actuate 0.10 / release 0.15 …); upward alone
 * has the mirror problem at the top. Overflow — more labels than the range can
 * hold at `minGap` — degrades to an even spread rather than throwing.
 */
export function dodgeLabels(ys: number[], minGap: number, minY: number, maxY: number): number[] {
  const order = ys.map((y, i) => ({ y, i })).sort((a, b) => a.y - b.y);
  const out = order.map((o) => o.y);

  for (let i = 1; i < out.length; i++) {
    if (out[i]! - out[i - 1]! < minGap) out[i] = out[i - 1]! + minGap;
  }
  for (let i = out.length - 1; i >= 0; i--) {
    if (out[i]! > maxY) out[i] = maxY;
    if (i > 0 && out[i]! - out[i - 1]! < minGap) out[i - 1] = out[i]! - minGap;
  }
  for (let i = 0; i < out.length; i++) {
    if (out[i]! < minY) out[i] = minY;
    if (i > 0 && out[i]! - out[i - 1]! < minGap) out[i] = out[i - 1]! + minGap;
  }

  const result = new Array<number>(ys.length);
  order.forEach((o, sorted) => {
    result[o.i] = out[sorted]!;
  });
  return result;
}
