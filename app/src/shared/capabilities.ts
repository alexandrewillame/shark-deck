import type { Capability } from './types/capability';

/**
 * Human labels + grouping for capabilities. Lives in `shared/` so the renderer
 * (which cannot import from `src/main`) can drive its tab model from the same
 * predicate the rest of the app uses.
 */
export const CAPABILITY_META: Record<
  Capability,
  { label: string; group: 'core' | 'mouse' | 'keyboard' | 'advanced' }
> = {
  profiles: { label: 'Profiles', group: 'core' },
  firmwareUpdate: { label: 'Firmware', group: 'core' },
  restore: { label: 'Restore', group: 'core' },

  dpi: { label: 'DPI', group: 'mouse' },
  pollRate: { label: 'Polling Rate', group: 'mouse' },
  sensorTuning: { label: 'Sensor', group: 'mouse' },
  motionSync: { label: 'Sensor', group: 'mouse' },
  angleSnapping: { label: 'Sensor', group: 'mouse' },
  rippleControl: { label: 'Sensor', group: 'mouse' },
  lod: { label: 'Sensor', group: 'mouse' },
  highFpsScan: { label: 'Sensor', group: 'mouse' },
  longDistanceMode: { label: 'Wireless', group: 'mouse' },
  angleMode: { label: 'Sensor', group: 'mouse' },
  buttonRemap: { label: 'Buttons', group: 'mouse' },
  sleepTimer: { label: 'Power', group: 'mouse' },
  dpiIndicatorLed: { label: 'Lighting', group: 'mouse' },
  receiverLed: { label: 'Lighting', group: 'mouse' },
  mouseLighting: { label: 'Lighting', group: 'mouse' },
  pairing: { label: 'Pair', group: 'mouse' },
  sensorMode: { label: 'Sensor', group: 'mouse' },
  mouseDebounce: { label: 'Debounce', group: 'mouse' },
  perfMode: { label: 'Sensor', group: 'mouse' },
  dpiDynamic: { label: 'DPI', group: 'mouse' },

  magneticSwitches: { label: 'Magnetic', group: 'keyboard' },
  rapidTrigger: { label: 'Magnetic', group: 'keyboard' },
  dks: { label: 'Magnetic', group: 'keyboard' },
  socd: { label: 'Magnetic', group: 'keyboard' },
  modTap: { label: 'Magnetic', group: 'keyboard' },
  replaceableSwitches: { label: 'Switches', group: 'keyboard' },
  keyboardOptions: { label: 'Keyboard options', group: 'keyboard' },
  keyRemap: { label: 'Key Remap', group: 'keyboard' },
  fnLayer: { label: 'Fn Layer', group: 'keyboard' },
  perKeyLighting: { label: 'Lighting', group: 'keyboard' },
  sideLighting: { label: 'Lighting', group: 'keyboard' },
  screen: { label: 'Screen', group: 'keyboard' },
  debounce: { label: 'Debounce', group: 'keyboard' },
  keystroke: { label: 'Keystroke', group: 'keyboard' },

  macros: { label: 'Macros', group: 'advanced' },
  autoSwitch: { label: 'Auto-Switch', group: 'advanced' },
};

export function hasAll(device: readonly Capability[], required: readonly Capability[]): boolean {
  return required.every((c) => device.includes(c));
}

export function hasAny(device: readonly Capability[], required: readonly Capability[]): boolean {
  return required.some((c) => device.includes(c));
}
