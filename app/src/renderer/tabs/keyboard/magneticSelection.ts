import type { MagneticKeySettings } from '@shared/types/keyboard-settings';
import { KB_FACTORY_RELEASE_MM, KB_TRAVEL_RANGE } from '@shared/keyboard-travel';

/** The per-key settings a multi-key selection can disagree on. */
export const MIXABLE = [
  'actuationMm',
  'releaseMm',
  'deadZoneMm',
  'deadZoneBottomMm',
  'rtPressMm',
  'rtReleaseMm',
  'mode',
  'rapidTrigger',
  'mtHoldMs',
] as const;

export type MixableField = (typeof MIXABLE)[number];
export type MixedFields = Partial<Record<MixableField, boolean>>;

/**
 * The settings that decide which key group a key is in, as one string: two
 * keys are in the same group exactly when this matches.
 *
 * The MIXABLE fields, but only the ones that are IN FORCE. The rapid-trigger
 * sensitivities mean nothing while rapid trigger is off, and the mod-tap hold
 * means nothing outside mod-tap — yet both are still stored: a key the app has
 * Reset carries `rtPressMm: 0.2` with RT off, while an untouched key reads its
 * empty RT page as `undefined`. Compared raw, those two keys were two groups
 * for a difference neither the board nor the panel acts on. Numbers are
 * rounded to the thousandth so float noise from arithmetic (`2.5 - 0.5`)
 * cannot split a group either; the wire's own step is 0.005, so nothing real
 * is lost.
 */
export function groupingSignature(k: MagneticKeySettings): string {
  return MIXABLE.map((f) => {
    if ((f === 'rtPressMm' || f === 'rtReleaseMm') && !k.rapidTrigger) return '';
    if (f === 'mtHoldMs' && k.mode !== 'mt') return '';
    const v = k[f];
    if (typeof v === 'number') return String(Math.round(v * 1000) / 1000);
    return v === undefined || v === null ? '' : String(v);
  }).join('|');
}

/** Under one wire unit (0.005 mm on the R85HE): "the same value" for travel
 *  figures that are quantised on the board and arrive through float maths. */
const NEAR_MM = 0.005;
const near = (v: number, target: number) => Math.abs(v - target) < NEAR_MM;

/**
 * Is this key at the factory settings — what the Actuation tab's "Default"
 * group holds?
 *
 * Not "equal to what Reset writes": a factory key and a Reset key are not
 * byte-for-byte the same, and both must count. Field by field:
 *
 * - `mode` normal, rapid trigger off — the factory mode byte is 0.
 * - `actuationMm` at `KB_TRAVEL_RANGE.travel.default` (2.0 mm): what a factory
 *   board reads and what Reset writes.
 * - `releaseMm` is either linked to the actuation (Reset writes the two pages
 *   equal, and the driver reports an empty release page as the actuation) or
 *   the factory 2.8 mm (`KB_FACTORY_RELEASE_MM`, what an untouched board
 *   reads). Absent is the driver's "page not reported", i.e. linked.
 * - Top dead zone: absent (page 251 not reported), 0 (a factory board reads
 *   page 251 as all zeros) or 0.3 (what Reset writes — the firmware cannot
 *   store a 0 there, so Reset uses the documented default).
 * - Bottom dead zone: absent (page not reported) or 0.3 (the factory read and
 *   Reset agree).
 * - The RT sensitivities and the mod-tap hold are ignored: not in force while
 *   RT is off and the mode is normal (see `groupingSignature`).
 */
export function isFactoryDefault(k: MagneticKeySettings): boolean {
  if (k.mode !== 'normal' || k.rapidTrigger) return false;
  if (!near(k.actuationMm, KB_TRAVEL_RANGE.travel.default)) return false;
  if (
    k.releaseMm !== undefined &&
    !near(k.releaseMm, k.actuationMm) &&
    !near(k.releaseMm, KB_FACTORY_RELEASE_MM)
  )
    return false;
  if (
    k.deadZoneMm !== undefined &&
    !near(k.deadZoneMm, 0) &&
    !near(k.deadZoneMm, KB_TRAVEL_RANGE.deadzone.default)
  )
    return false;
  if (
    k.deadZoneBottomMm !== undefined &&
    !near(k.deadZoneBottomMm, KB_TRAVEL_RANGE.deadzone.default)
  )
    return false;
  return true;
}

/**
 * Which settings the selected keys do not agree on.
 *
 * The panel edits the first selected key and applies the same patch to all of
 * them, which is the right bulk-edit behaviour — but it also RENDERED the
 * first key's values as if they were the group's. A selection of keys at 1.2,
 * 2.0 and 2.8 mm showed "1.2 mm" and quietly flattened the other two the next
 * time anything was touched. Where the selection disagrees the control shows
 * no value at all instead; setting one still sets all of them.
 */
export function mixedFields(selected: MagneticKeySettings[]): MixedFields {
  if (selected.length < 2) return {};
  const first = selected[0]!;
  const out: MixedFields = {};
  for (const f of MIXABLE) out[f] = selected.some((s) => s[f] !== first[f]);
  return out;
}

/**
 * Every distinct value the selection holds for each mixable field.
 *
 * `mixedFields` answers "do these disagree", which is enough to blank a number
 * but not enough to draw the control: a slider with its handle parked at the
 * first selected key's value, while the number beside it reads "–", says the
 * setting is at that depth for all of them. It is not. One handle per distinct
 * value shows what the selection actually contains.
 */
export function distinctValues(
  selected: MagneticKeySettings[],
): Partial<Record<MixableField, number[]>> {
  const out: Partial<Record<MixableField, number[]>> = {};
  if (selected.length < 2) return out;
  for (const f of MIXABLE) {
    const seen = new Set<number>();
    for (const s of selected) {
      const v = s[f];
      if (typeof v === 'number') seen.add(v);
    }
    if (seen.size > 1) out[f] = [...seen].sort((a, b) => a - b);
  }
  return out;
}
