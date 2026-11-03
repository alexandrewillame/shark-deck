/**
 * The renderer-facing slice of a descriptor: `deviceUi()` plus the two tables
 * it reads.
 *
 * Split out of manager.ts because this is a register-here hub -- a capability
 * that needs per-model bounds (a range, an option list, a slot limit) has to
 * add a field here AND to DeviceUi in shared/types/live.ts. Finding it used to
 * mean opening a 1,200-line file that is otherwise all scan loop, hotplug and
 * timers.
 */
import type { DeviceDescriptor } from '@shared/types/device';
import type { DeviceUi, MacroLimits } from '@shared/types/live';
import { PERFORMANCE_TIMEOUTS } from '@shared/mouse-options';
import { SWITCH_CHOICES_DEFAULT } from '@shared/keyboard-switches';
import { KB_MACRO_MAX_STEPS } from './drivers/compx-keyboard';
import { V8_MACRO_MAX_STEPS, V8_MACRO_NAME_MAX, V8_MACRO_SLOTS } from '@shared/mouse-wire';

/**
 * The vendor's own sleep-timeout choices (Mouse Hub Language/en.json,
 * `ported-from-vendor` — see mouse-options.ts), converted from its
 * value-in-10s-units encoding to plain seconds: 10s, 30s, 1/2/3/5/10/15 min.
 */
export const SLEEP_PRESETS = PERFORMANCE_TIMEOUTS.map((o) => o.value * 10);

/**
 * Onboard macro-slot limits per driver, so the macro editor can show how much
 * of a slot a step list uses before the codec silently truncates it. Keyed by
 * `descriptor.driver` like everything else driver-shaped — the numbers belong
 * to the wire format, not to any one model, and both keyboard drivers share
 * CompxKeyboard's 256-byte payload (CompxHeKeyboard extends it).
 */
export const MACRO_LIMITS: Record<string, MacroLimits> = {
  // The V8 slot folds a step's preceding delay into that step's own record, so
  // a delay costs no record of its own; the keyboard spends a full record on
  // each one.
  'compx-mouse-8k': {
    maxSteps: V8_MACRO_MAX_STEPS,
    slots: V8_MACRO_SLOTS,
    nameMax: V8_MACRO_NAME_MAX,
    delaysConsumeSteps: false,
  },
  // One slot, and the payload has no name field at all — readMacros() always
  // reports it as "Onboard macro" (see compx-keyboard.ts), hence no nameMax.
  'compx-keyboard': { maxSteps: KB_MACRO_MAX_STEPS, slots: 1, delaysConsumeSteps: true },
  'compx-he-keyboard': { maxSteps: KB_MACRO_MAX_STEPS, slots: 1, delaysConsumeSteps: true },
};

/** The renderer-facing slice of a descriptor's static spec (see DeviceUi). */
export function deviceUi(d: DeviceDescriptor): DeviceUi {
  const s = d.spec;
  const radioRate = s.pollRates?.length ? s.pollRates : [125, 250, 500, 1000];
  return {
    profileCount: s.profileCount ?? 4,
    pollRates: radioRate,
    dpiRange: s.dpi
      ? { min: s.dpi.min, max: s.dpi.max, step: s.dpi.step, stages: s.dpi.stages }
      : undefined,
    buttons: s.buttons,
    buttonMap: s.buttonMap,
    keyMatrix: s.keyMatrix,
    supportedSwitches: d.capabilities.includes('replaceableSwitches')
      ? (s.supportedSwitches ?? SWITCH_CHOICES_DEFAULT)
      : undefined,
    lightZones: s.lighting?.zones ?? [],
    perKeyLighting: !!s.lighting?.perKey,
    colorVariants: d.colorVariants ?? [],
    sleepPresets: SLEEP_PRESETS,
    lodOptions: s.lodOptions,
    debounceRange: s.debounceRange,
    buttonSlotOrder: s.buttonSlotOrder,
    buttonActions: s.buttonActions,
    sensorModes: s.sensorModes,
    dpiDynamicModes: s.dpiDynamicModes,
    bodyLightZones: s.bodyLightZones,
    macroLimits: d.capabilities.includes('macros') ? MACRO_LIMITS[d.driver] : undefined,
  };
}
