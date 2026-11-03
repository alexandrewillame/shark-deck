import { BATTERY_CURVE } from './mouse-options';

/**
 * Millivolts -> percent, the way the vendor Hub does it. `BATTERY_CURVE` is
 * `Config.ini`'s `BatteryParam`, 21 points 5% apart (0, 5, 10, … 100). Linear-
 * interpolate between the two bracketing points; clamp outside the table.
 * `provenance: ported-from-vendor` — the curve is copied verbatim from the
 * vendor `Config.ini`. Cross-checked against the Frida capture: ~3877 mV ->
 * ~50%, matching the raw percent byte in the same reply.
 *
 * Lives here, NOT in `mouse-options.ts`, because that file is regenerated
 * wholesale by `npm run extract` and this function is not in the generator
 * template — keeping it here means `extract` can't silently delete it.
 */
export function batteryPercentFromCurve(mv: number): number {
  const curve = BATTERY_CURVE;
  const steps = curve.length - 1; // 20 steps of 5% each
  if (mv <= curve[0]!) return 0;
  if (mv >= curve[steps]!) return 100;
  for (let i = 0; i < steps; i++) {
    const lo = curve[i]!;
    const hi = curve[i + 1]!;
    if (mv >= lo && mv <= hi) {
      const frac = hi > lo ? (mv - lo) / (hi - lo) : 0;
      return Math.round(((i + frac) / steps) * 100);
    }
  }
  return 100;
}
