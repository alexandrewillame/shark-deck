import type { DpiStage } from '@shared/types/mouse-settings';

// ---------------------------------------------------------------- DPI
export const MIN_STAGES = 1;
export const MAX_STAGES = 6;
/** Cycled for a freshly-added stage — same palette order as the vendor's own
 * DPI_STAGE_COLORS (mouse-options.ts), just not importing the mouse-only
 * table's 8-entry duplicate-cyan quirk into a generic UI default. */
export const NEW_STAGE_COLORS: [number, number, number][] = [
  [255, 0, 0],
  [0, 255, 0],
  [0, 0, 255],
  [255, 255, 0],
  [255, 0, 255],
  [61, 248, 232],
];

/** Below this Euclidean RGB distance, two colours read as "basically the
 *  same" for a small swatch — the palette's own six entries sit well above
 *  it (their closest pair is ~240 apart), so this only ever rejects a
 *  candidate that collides with a colour already on the device (e.g. its
 *  one existing stage happens to already be the exact shade `addStage`
 *  would otherwise have picked next). */
const MIN_STAGE_COLOR_DISTANCE = 110;

export function colorDistance(
  a: readonly [number, number, number],
  b: readonly [number, number, number],
): number {
  const dr = a[0] - b[0];
  const dg = a[1] - b[1];
  const db = a[2] - b[2];
  return Math.sqrt(dr * dr + dg * dg + db * db);
}

/**
 * A colour for a freshly-added stage that isn't the same as (or too close
 * to) any colour already in use — `startAt` just rotates where in the
 * palette we start looking, so successive additions still cycle through it
 * rather than always preferring the front. Falls back to whichever palette
 * entry is furthest from its nearest existing colour if every entry
 * collides (more stages than distinct palette colours, or an unlucky
 * device-read colour sitting close to several of them at once) — so it
 * never blindly repeats an exact match when a better option exists.
 */
export function pickNewStageColor(
  existing: [number, number, number][],
  startAt: number,
): [number, number, number] {
  const n = NEW_STAGE_COLORS.length;
  for (let offset = 0; offset < n; offset++) {
    const candidate = NEW_STAGE_COLORS[(startAt + offset) % n]!;
    if (existing.every((c) => colorDistance(c, candidate) >= MIN_STAGE_COLOR_DISTANCE))
      return candidate;
  }
  let best = NEW_STAGE_COLORS[startAt % n]!;
  let bestMinDist = -1;
  for (let offset = 0; offset < n; offset++) {
    const candidate = NEW_STAGE_COLORS[(startAt + offset) % n]!;
    const minDist = existing.length
      ? Math.min(...existing.map((c) => colorDistance(c, candidate)))
      : Infinity;
    if (minDist > bestMinDist) {
      bestMinDist = minDist;
      best = candidate;
    }
  }
  return best;
}

export const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

/** A DPI value must be a whole multiple of the device's step, within its
 *  declared range — never negative, zero, or fractional. `dpiFromClientX`
 *  and `EditableNumber`'s commit already enforce this for the track's drag
 *  gestures; this is the same rule for the plain number field, applied on
 *  blur rather than every keystroke so typing isn't fought mid-edit. Falls
 *  back to `rng.min` for a non-finite draft (e.g. the field was left on a
 *  bare "-" or emptied), rather than propagating NaN into a device write. */
export function snapDpi(value: number, rng: { min: number; max: number; step: number }): number {
  if (!Number.isFinite(value)) return rng.min;
  const stepped = Math.round(value / rng.step) * rng.step;
  return Math.min(rng.max, Math.max(rng.min, stepped));
}

/**
 * The DPI slider's visible window — most users' stages sit in a narrow band
 * (400-3200) of the device's full 50-42000 range, so a linear full-range
 * track leaves nearly all of it as dead space. Bounds of the *enabled*
 * stages, padded, widened to a minimum span, then snapped outward to a round
 * step so small drags don't cause the window to visibly creep. Always
 * clamped inside the device's real range.
 */
const DPI_WINDOW_PAD_FRAC = 0.12;
const DPI_WINDOW_MIN_SPAN = 1600;
export function niceDpiStep(span: number): number {
  return span > 20000 ? 1000 : span > 4000 ? 500 : 100;
}
export function computeDpiWindow(
  stages: DpiStage[],
  rng: { min: number; max: number },
): { min: number; max: number } {
  const values = stages.filter((s) => s.enabled).map((s) => s.dpi);
  const lowRaw = values.length ? Math.min(...values) : rng.min;
  const highRaw = values.length
    ? Math.max(...values)
    : Math.min(rng.max, rng.min + DPI_WINDOW_MIN_SPAN);
  const pad = Math.max((highRaw - lowRaw) * DPI_WINDOW_PAD_FRAC, DPI_WINDOW_MIN_SPAN * 0.1);
  let lo = lowRaw - pad;
  let hi = highRaw + pad;
  if (hi - lo < DPI_WINDOW_MIN_SPAN) {
    const mid = (hi + lo) / 2;
    lo = mid - DPI_WINDOW_MIN_SPAN / 2;
    hi = mid + DPI_WINDOW_MIN_SPAN / 2;
  }
  const step = niceDpiStep(hi - lo);
  lo = Math.max(rng.min, Math.floor(lo / step) * step);
  hi = Math.min(rng.max, Math.ceil(hi / step) * step);
  return hi > lo ? { min: lo, max: hi } : { min: rng.min, max: rng.max };
}
