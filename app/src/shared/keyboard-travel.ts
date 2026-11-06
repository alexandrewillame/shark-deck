/**
 * Settable travel ranges for a Hall-effect keyboard, in millimetres.
 *
 * HAND-MAINTAINED. This used to live in the generated `keyboard-options.ts`,
 * but it was never actually extracted from anything — it was a string literal
 * typed into `scripts/extract-keyboard-protocol.mjs`, which is precisely how it
 * came to disagree with the hardware. Regenerating would have silently put the
 * wrong numbers back, so it lives here instead and the generator no longer
 * emits it.
 *
 * ## Provenance
 *
 * - The **resolution** is `verified-capture`. Travel is `mm x multiplier` and
 *   the multiplier is keyed on the raw firmware version (`<768 -> 10`,
 *   `[768,1280) -> 100`, `>=1280 -> 200`); the R85HE reports 1297, so one wire
 *   unit is 1/200 mm = **0.005 mm**. A real R85HE read decoded page 6 to
 *   exactly 0.3 mm, which is what confirms both the x200 scale and the
 *   two-byte width — see docs/protocol/keyboard-compx.md.
 * - The **bounds** are `ported-from-vendor`, corrected against a real board:
 *   rapid trigger is 0.005 / 2.0 / 0.2 mm, and the top dead zone defaults to
 *   0.3 mm like the bottom one, not to 0.
 * - The **actuation default** is `verified-capture`: a live read of an
 *   untouched R85HE decodes every populated key to 2.0 mm press against 2.8 mm
 *   release (docs/protocol/keyboard-compx.md, "Live read from an R85HE"). The
 *   vendor string said 2.5, and this table repeated it until the board was
 *   read — 2.5 mm was never what a factory key holds.
 *
 * ## Why rapid trigger has its own row
 *
 * It used to borrow the actuation row (as `firePress` / `fireLift`), which is
 * why its sliders read 0.01 min, 2.5 max and a 1.5 mm default — all three the
 * actuation point's numbers, none of them rapid trigger's. Those two keys are
 * gone; they were a duplicate of `travel`, not a separate setting.
 */
export interface TravelRange {
  min: number;
  max: number;
  /** Slider/typed-input increment. */
  step: number;
  default: number;
}

/** Widened deliberately, not `as const`: these feed `useState` and slider
 *  props, and literal types there make every derived value a single number. */
export const KB_TRAVEL_RANGE: Record<'travel' | 'rt' | 'deadzone', TravelRange> = {
  /** Actuation point and release point (magnetism pages 0 and 1). The default
   *  is the factory actuation; Reset writes it to both pages (linked). */
  travel: { min: 0.1, max: 3.4, step: 0.01, default: 2.0 },
  /** Rapid-trigger press and release sensitivity (pages 2 and 3). The step is
   *  one wire unit — the finest the hardware can express. */
  rt: { min: 0.005, max: 2.0, step: 0.005, default: 0.2 },
  /** Top (page 251) and bottom (page 6) dead zone. */
  deadzone: { min: 0, max: 1.0, step: 0.01, default: 0.3 },
};

/**
 * A board's own travel ranges: the model's declared limits (its descriptor's
 * `spec.magnetic.ranges`, from the vendor registry where it carries them) over
 * the R85HE-calibrated defaults above. A K85 whose firmware stops at 0.2 mm
 * must not be offered 0.1.
 */
export function travelRangesFor(magnetic?: {
  ranges?: Partial<Record<'travel' | 'rt' | 'deadzone', TravelRange>>;
}): Record<'travel' | 'rt' | 'deadzone', TravelRange> {
  return { ...KB_TRAVEL_RANGE, ...(magnetic?.ranges ?? {}) };
}

/**
 * The release point a factory key holds, in mm — NOT what Reset writes.
 *
 * `provenance: verified-capture`. A live read of an untouched R85HE decodes
 * page 1 to 2.8 mm on every populated key, against 2.0 mm on page 0
 * (docs/protocol/keyboard-compx.md, "Live read from an R85HE"). Reset writes
 * the release linked to the actuation (2.0 / 2.0), which is the vendor tool's
 * one-control model; so a key "at default" is at either release, and the
 * Actuation tab's Default group accepts both (`isFactoryDefault`).
 */
export const KB_FACTORY_RELEASE_MM = 2.8;

/**
 * The fastest live-travel cadence the app will ask a board for, in ms.
 *
 * It is a floor, not a target: one sample is a four-chunk paged magnetism read
 * paced by the driver's 30 ms settle, so a sample costs ~130 ms on the wire
 * whatever interval is requested. A view that wants the maximum refresh rate
 * asks for THIS rather than a smaller number that silently clamps — the
 * Actuation test view asked for 40 ms and ran at 150.
 *
 * `provenance: inferred` — measured against a real R85HE, not specified.
 */
export const TRAVEL_POLL_MIN_MS = 150;
