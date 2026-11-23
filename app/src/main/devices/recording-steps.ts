import type { Capability } from '@shared/types/capability';
import type { SupportTopic } from '@shared/types/device';

/** A capability with nothing on the device to record, and why. */
export interface NoSteps {
  none: string;
}

/**
 * The device report tool's steps that record each capability, as the words
 * that pick them: a step id's first segment (`light` picks light.red,
 * light.dim…; tools/SharkDeck-device-report.bat `StepTableFor`).
 *
 * A recording Shark Deck asks an owner for covers every capability the model
 * shows that no recording of it has confirmed (support.ts `supportPlan`), so
 * that one recording is enough to support the device fully. A capability with
 * no steps could never be confirmed that way:
 * test/contract/recording-coverage.test.ts fails for any model that shows one.
 */
export const CAPABILITY_STEPS: Record<Capability, readonly string[] | NoSteps> = {
  profiles: ['profile'],
  firmwareUpdate: {
    none: 'never done in a recording: the tool tells owners never to start a firmware update',
  },
  restore: ['end'],
  dpi: ['dpi'],
  pollRate: ['poll'],
  sensorTuning: ['lod', 'angle', 'ripple', 'motion'],
  motionSync: ['motion'],
  angleSnapping: ['angle'],
  rippleControl: ['ripple'],
  lod: ['lod'],
  highFpsScan: ['fps'],
  longDistanceMode: ['far'],
  angleMode: ['anglemode'],
  buttonRemap: ['btn', 'media'],
  sleepTimer: ['sleep', 'deep'],
  dpiIndicatorLed: ['dpi'],
  receiverLed: ['rled'],
  mouseLighting: ['light', 'side'],
  pairing: ['conn'],
  sensorMode: ['mode'],
  mouseDebounce: ['debounce'],
  perfMode: ['perf'],
  dpiDynamic: ['dyn'],
  magneticSwitches: ['act', 'dz', 'travel', 'calibrate'],
  rapidTrigger: ['rt'],
  // the modes are given to one key in turn, then reset once (modereset.a)
  dks: ['dks', 'modereset'],
  socd: ['snap'],
  modTap: ['mt', 'tgl', 'modereset'],
  replaceableSwitches: ['sw'],
  keyRemap: ['key', 'knob'],
  fnLayer: ['key', 'knob'],
  perKeyLighting: ['light', 'perkey'],
  sideLighting: ['side'],
  screen: { none: 'no model offers it yet' },
  debounce: ['debounce'],
  keyboardOptions: ['opt', 'winlock', 'rollover'],
  keystroke: { none: 'the R85 HE alone has it, checked on hardware' },
  macros: ['macro'],
  autoSwitch: { none: 'Shark Deck changes profiles itself: nothing new reaches the device' },
};

/** The topic an owner knows each word's steps under (SupportPlan.unconfirmed). */
export const WORD_TOPIC: Readonly<Record<string, SupportTopic | null>> = {
  start: null,
  end: null,
  profile: 'profiles',
  dpi: 'dpi',
  dyn: 'dpi',
  poll: 'pollRate',
  lod: 'sensor',
  angle: 'sensor',
  ripple: 'sensor',
  motion: 'sensor',
  mode: 'sensor',
  fps: 'sensor',
  far: 'sensor',
  perf: 'sensor',
  anglemode: 'sensor',
  btn: 'buttons',
  media: 'buttons',
  sleep: 'power',
  deep: 'power',
  rled: 'receiverLight',
  light: 'lighting',
  side: 'lighting',
  perkey: 'lighting',
  conn: 'pairing',
  debounce: 'response',
  act: 'actuation',
  dz: 'actuation',
  travel: 'actuation',
  calibrate: 'actuation',
  rt: 'actuation',
  dks: 'keyModes',
  snap: 'keyModes',
  mt: 'keyModes',
  tgl: 'keyModes',
  modereset: 'keyModes',
  sw: 'switches',
  key: 'keys',
  knob: 'knob',
  opt: 'options',
  winlock: 'options',
  rollover: 'options',
  macro: 'macros',
};

/** The topics these words record, each once, in the order given. */
export function topicsFor(words: readonly string[]): SupportTopic[] {
  const out: SupportTopic[] = [];
  for (const w of words) {
    const t = WORD_TOPIC[w];
    if (t && !out.includes(t)) out.push(t);
  }
  return out;
}

/** The words that record these capabilities, each once, in the order given. */
export function stepWordsFor(caps: readonly Capability[]): string[] {
  const out: string[] = [];
  for (const cap of caps) {
    const words = CAPABILITY_STEPS[cap];
    if (!Array.isArray(words)) continue;
    for (const w of words) if (!out.includes(w)) out.push(w);
  }
  return out;
}
