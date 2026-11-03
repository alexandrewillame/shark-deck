import type { AppSettings, LightingPreset } from '@shared/types/app-settings';
import type { LightingSettings, SideLightingSettings } from '@shared/types/lighting';
import { KB_LIGHT_EFFECTS_TABLE } from '@shared/lighting';

/**
 * Per-effect memory for the lighting panes.
 *
 * The board holds one effect with one brightness/speed/colour, so switching
 * effect and back used to hand the new effect whatever the previous one was
 * set to — pick Wave, tune it, try Breath, come back to Wave and its settings
 * were gone. Each effect keeps its own here.
 *
 * Keyed on the vendor effect **id**, never the display label: two labels have
 * already been corrected once, and a label key would have silently orphaned
 * every setting stored under the old name.
 */

const idOf = (label: string): string =>
  KB_LIGHT_EFFECTS_TABLE.find((e) => e.label === label)?.id ?? label;

export const presetKey = (model: string, zone: string, effectLabel: string): string =>
  `${model}/${zone}/${idOf(effectLabel)}`;

/** What this effect was last set to, if anything. */
export function recallPreset(
  settings: AppSettings | null,
  model: string,
  zone: string,
  effectLabel: string,
): LightingPreset | undefined {
  return settings?.lightingPresets?.[presetKey(model, zone, effectLabel)];
}

/**
 * A brightness worth remembering.
 *
 * ZERO IS NOT ONE. It is a real wire value — the slider offers it and the
 * board honours it — but as a per-effect *memory* it is poison: picking the
 * effect then means "and also switch the lights off", every time, for good.
 *
 * It got banked by accident, and reliably. `applyPreset` inherits the current
 * brightness for an effect it has never seen, and `withEffect` banks the
 * OUTGOING effect on the way out — so landing on the tab while the board
 * happened to read 0 (lighting off, or a short answer behind a write burst)
 * and then clicking along the picker banks 0 onto each effect in turn. That
 * is what "Circle Wave, Dazzling and Rain Down go black and nothing I change
 * helps" was: three neighbours in the picker, each holding a remembered
 * brightness of 0, with colour and colour-mode irrelevant because neither of
 * them is brightness.
 *
 * Dropped on the way IN as well as on the way out, so a settings file that
 * already carries a zero heals itself the next time the effect is picked
 * rather than needing a migration. Turning the lights off has its own entry
 * in the effect list, which is the honest way to ask for it.
 */
const remembered = (b: number | undefined): number | undefined => (b ? b : undefined);

/**
 * `cur`, switched to another effect, with that effect's remembered parameters
 * applied over the top.
 *
 * Anything the effect has never been given keeps the current value, so
 * picking an effect for the first time behaves exactly as it did before —
 * it inherits, rather than jumping to some arbitrary default.
 */
export function applyPreset(
  cur: LightingSettings,
  effectLabel: string,
  preset: LightingPreset | undefined,
): LightingSettings {
  return {
    ...cur,
    effect: effectLabel,
    brightness: remembered(preset?.brightness) ?? cur.brightness,
    speed: preset?.speed ?? cur.speed,
    color: preset?.color ?? cur.color,
    dazzle: preset?.dazzle ?? cur.dazzle,
    // Direction is per effect and the lists differ in length between effects,
    // so an unremembered effect starts at its first option rather than
    // carrying over an index that may not exist.
    option: preset?.option ?? 0,
  };
}

/**
 * The same, for the side strip.
 *
 * Its own function rather than a generic one, because the two zones really do
 * differ: `SET_SLEDPARAM`'s option byte is colour-mode ONLY — the strip has no
 * direction to remember — so there is no `option` here to get wrong. What they
 * share is the zero-brightness rule above, which is the part that mattered.
 */
export function applySidePreset(
  cur: SideLightingSettings,
  effectLabel: string,
  preset: LightingPreset | undefined,
): SideLightingSettings {
  return {
    ...cur,
    effect: effectLabel,
    brightness: remembered(preset?.brightness) ?? cur.brightness,
    speed: preset?.speed ?? cur.speed,
    color: preset?.color ?? cur.color,
    dazzle: preset?.dazzle ?? cur.dazzle,
  };
}

/** The parameters worth remembering for whatever `l` is currently set to. */
export function presetOf(l: LightingSettings): LightingPreset {
  return {
    // `undefined`, not 0 — see `remembered` above. An effect the board is
    // currently showing at zero brightness is not an effect you want to come
    // back to at zero brightness.
    brightness: remembered(l.brightness),
    speed: l.speed,
    color: l.color,
    dazzle: l.dazzle,
    option: l.option ?? 0,
  };
}
