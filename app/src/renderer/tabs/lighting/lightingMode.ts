import { useEffect, useRef, useState } from 'react';
import {
  currentEffectLabel,
  KB_LIGHT_EFFECTS,
  KB_LIGHT_EFFECTS_TABLE,
  KB_PERKEY_EFFECT_INDEX,
  kbEffect,
  type KbLightEffect,
} from '@shared/lighting';
import type { LightingSettings } from '@shared/types/lighting';
import type { LightingPreset } from '@shared/types/app-settings';
import { hostFeatures } from '../../state/host';
import { applyPreset } from './effectMemory';

export type LightingMode = 'global' | 'perkey';

/**
 * Effects the app itself feeds, frame by frame, from a screen or audio
 * capture (see useAmbientLighting) — not something the board runs alone.
 * Offered only where `hostFeatures.ambientLighting` says the host can keep
 * that capture going.
 */
export const HOST_FED_EFFECTS: ReadonlySet<string> = new Set([
  'LightScreenColor',
  'LightMusicFollow2',
  'LightMusicFollow3',
]);

/** The effects the Global picker offers: every listed one except per-key. */
export const GLOBAL_PICKER_EFFECTS: readonly KbLightEffect[] = KB_LIGHT_EFFECTS_TABLE.filter(
  (e, wire) =>
    wire !== KB_PERKEY_EFFECT_INDEX &&
    e.listed &&
    (hostFeatures.ambientLighting || !HOST_FED_EFFECTS.has(e.id)),
);
/** Board layers rather than effects: never a Global choice, listed or not. */
const NOT_GLOBAL = new Set(['LightUserPicture', 'LightUserColor']);
/** What Global shows when the board is on something it cannot offer. */
export const GLOBAL_FALLBACK_EFFECT = 'Always On';

/**
 * The picker's list for a given current effect: the listed effects, plus the
 * current one when it is a real global effect the list leaves out (Train,
 * Endless, Music (Spectrum) — the board can be on them, set by the vendor
 * tool or an Fn shortcut). Without that, the board previewed an effect no tile
 * was selected for.
 */
export function globalPickerList(current: string): readonly KbLightEffect[] {
  const label = currentEffectLabel(current);
  if (GLOBAL_PICKER_EFFECTS.some((e) => e.label === label)) return GLOBAL_PICKER_EFFECTS;
  const e = kbEffect(label);
  return e && !NOT_GLOBAL.has(e.id) ? [...GLOBAL_PICKER_EFFECTS, e] : GLOBAL_PICKER_EFFECTS;
}

const pickable = (label: string) =>
  globalPickerList(label).some((e) => e.label === currentEffectLabel(label));

/**
 * What the Global editor starts from, given a board read.
 *
 * The device wins when it is on an effect the picker can show. When it is not
 * — its per-key layer, which is an entry of the same effect list — Global
 * keeps the effect it was already editing, or falls back to Always On with its
 * own remembered colours. Seeding straight from the read previewed the
 * per-key entry (drawn as a rainbow, which reads as "Wave") with no tile
 * selected: two answers to "which effect" on one screen.
 */
export function seedGlobalDraft(
  read: LightingSettings,
  prev: LightingSettings | null,
  fallback: LightingPreset | undefined,
): LightingSettings {
  const effect = currentEffectLabel(read.effect);
  if (pickable(effect)) return { ...read, effect };
  if (prev && pickable(prev.effect)) return prev;
  return applyPreset(read, GLOBAL_FALLBACK_EFFECT, fallback);
}

/**
 * Which mode the DEVICE is in, by wire index, not by label.
 *
 * Global and per-key are not two independent states: per-key is one entry
 * (KB_PERKEY_EFFECT_INDEX) in the same KB_LIGHT_EFFECTS list a global effect
 * picks from. An earlier version compared the label against the literal
 * 'Custom'; renaming that entry (it is now "Custom (per-key)") silently broke
 * the detection and the tab always opened on Global even when the board was
 * showing a painted layer.
 */
export function derivedLightingMode(loaded: LightingSettings[]): LightingMode | null {
  const first = loaded[0];
  if (!first) return null;
  return first.effect === KB_LIGHT_EFFECTS[KB_PERKEY_EFFECT_INDEX] ? 'perkey' : 'global';
}

/**
 * The mode the pane should show: what the device reports, unless the user has
 * navigated somewhere else since the last read.
 *
 * These are two different things. Nothing is written until a pane's own Apply,
 * so picking "Per-key" has to stick even while the board still reports a global
 * effect. But that override must not outlive the read it was made against:
 * this used to be a single state latched behind `mode === null`, so a LATER
 * read never re-derived it — switch from a per-key profile to a global one and
 * the tab stayed on per-key, showing (and on the next Apply, writing) the
 * previous profile's picture onto the new slot.
 *
 * So the override is cleared whenever a new `loaded` array arrives: a profile
 * switch follows the device, while in-tab navigation still holds between reads.
 */
export function useLightingMode(loaded: LightingSettings[], perKeyLighting: boolean) {
  const [override, setOverride] = useState<LightingMode | null>(null);
  const lastLoaded = useRef(loaded);
  useEffect(() => {
    if (lastLoaded.current !== loaded) {
      lastLoaded.current = loaded;
      setOverride(null);
    }
  }, [loaded]);
  const mode: LightingMode = perKeyLighting
    ? (override ?? derivedLightingMode(loaded) ?? 'global')
    : 'global';
  return { mode, setMode: setOverride };
}
