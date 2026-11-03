// AUTO-EXTRACTED from the vendor Mouse Hub (Language/en.json + usersetting/Config.ini).
// Do not edit. Regenerate: npm run extract
// Provenance: ported-from-vendor — these are the option sets and wire values
// the vendor software itself uses; confirm against a capture before trusting a write.
// Lives in shared/ (pure data, no Node) so the renderer can label controls with it.

import type { LodOption } from './types/device';

/** Lift-off distance: {wire value written to the device, mm label}. */
export const LOD_OPTIONS: LodOption[] = [{"mm":0.7,"wire":3},{"mm":1,"wire":1},{"mm":2,"wire":2}];

/** Polling rate: Hz <-> the bitmask value the device expects (NOT a list index). */
export const POLL_RATE_WIRE: { hz: number; wire: number }[] = [{"hz":125,"wire":8},{"hz":250,"wire":4},{"hz":500,"wire":2},{"hz":1000,"wire":1},{"hz":2000,"wire":16},{"hz":4000,"wire":32},{"hz":8000,"wire":64}];
export const pollRateToWire = (hz: number): number =>
  POLL_RATE_WIRE.find((r) => r.hz === hz)?.wire ?? POLL_RATE_WIRE[POLL_RATE_WIRE.length - 1]!.wire;
export const pollRateFromWire = (wire: number): number =>
  POLL_RATE_WIRE.find((r) => r.wire === wire)?.hz ?? 1000;

export const SENSOR_MODES: { value: number; label: string }[] = [{"value":0,"label":"LP"},{"value":1,"label":"HP"},{"value":256,"label":"Corded"}];
export const PERFORMANCE_TIMEOUTS: { value: number; label: string }[] = [{"value":1,"label":"10sec"},{"value":3,"label":"30sec"},{"value":6,"label":"1min"},{"value":12,"label":"2min"},{"value":18,"label":"3min"},{"value":30,"label":"5min"},{"value":60,"label":"10min"},{"value":90,"label":"15min"}];
export const DPI_LED_EFFECTS: { value: number; label: string }[] = [{"value":0,"label":"Off"},{"value":1,"label":"Steady"},{"value":2,"label":"Breathing"}];
export const LIGHT_MODES: { value: number; label: string }[] = [{"value":0,"label":"Off"},{"value":1,"label":"Rainbow"},{"value":2,"label":"Single Color Breath"},{"value":3,"label":"Fixed Color"},{"value":4,"label":"Neon"},{"value":5,"label":"Rainbow Breath"},{"value":6,"label":"Fixed Rainbow"}];
export const LIGHT_OFF_TIMEOUTS: { value: number; label: string }[] = [{"value":1,"label":"10sec"},{"value":3,"label":"30sec"},{"value":6,"label":"1min"},{"value":12,"label":"2min"},{"value":18,"label":"3min"},{"value":30,"label":"5min"},{"value":60,"label":"10min"},{"value":90,"label":"15min"}];
export const RECEIVER_LED_INDICATION: { value: number; label: string }[] = [{"value":0,"label":"Always Off"},{"value":2,"label":"Mouse Battery Level"},{"value":3,"label":"Connection Quality"},{"value":1,"label":"Polling Rate"},{"value":4,"label":"DPI Level"}];
export const BUTTON_ACTIONS: { value: string; label: string }[] = [{"value":"1","label":"Button"},{"value":"7","label":"Polling rate switch"},{"value":"4","label":"Firepower Button"},{"value":"9","label":"Configuration Switch"},{"value":"10","label":"Undefined button"},{"value":"11","label":"Switch decorative lamp"},{"value":"12","label":"DPI Lock"},{"value":"13","label":"Turn on/off all decorative lights"},{"value":"14","label":"Turn on/off the DPI indicator light"},{"value":"15","label":"On/Off Light Strip"},{"value":"16","label":"Cyclic Switching of Light Strip Effect"},{"value":"5","label":"Combo key"},{"value":"0","label":"Disable"},{"value":"2","label":"DPI Switch"},{"value":"6","label":"Macro"}];
/** Full KeyOptions with the vendor's translated sub-action trees — see shared/mouse-buttons.ts. */
export const BUTTON_ACTION_TREE: { value: string; label: string; children: { value: string; label: string }[] }[] = [{"value":"1","label":"Button","children":[{"value":"0x0100","label":"Left Click"},{"value":"0x0200","label":"Right Click"},{"value":"0x0400","label":"Wheel Click"},{"value":"0x0800","label":"Backward"},{"value":"0x1000","label":"Forward"}]},{"value":"7","label":"Polling rate switch","children":[]},{"value":"4","label":"Firepower Button","children":[]},{"value":"9","label":"Configuration Switch","children":[]},{"value":"10","label":"Undefined button","children":[]},{"value":"11","label":"Switch decorative lamp","children":[]},{"value":"12","label":"DPI Lock","children":[]},{"value":"13","label":"Turn on/off all decorative lights","children":[]},{"value":"14","label":"Turn on/off the DPI indicator light","children":[]},{"value":"15","label":"On/Off Light Strip","children":[]},{"value":"16","label":"Cyclic Switching of Light Strip Effect","children":[]},{"value":"5","label":"Combo key","children":[]},{"value":"0","label":"Disable","children":[]},{"value":"3","label":"Scroll Left/Right","children":[{"value":"0x0100","label":"Scroll Left"},{"value":"0x0200","label":"Scroll Right"}]},{"value":"B","label":"Scroll Up/Down","children":[{"value":"0x0100","label":"Scroll Up"},{"value":"0x0200","label":"Scroll Down"}]},{"value":"2","label":"DPI Switch","children":[{"value":"0x0100","label":"DPI loop"},{"value":"0x0200","label":"DPI +"},{"value":"0x0300","label":"DPI -"}]},{"value":"1005","label":"Multimedia","children":[{"value":"0x0183","label":"Media player"},{"value":"0x00CD","label":"Play/Pause"},{"value":"0x00B5","label":"Next Track"},{"value":"0x00B6","label":"Previous Track"},{"value":"0x00B7","label":"Stop Playback"},{"value":"0x00E2","label":"Mute"},{"value":"0x00E9","label":"Volume+"},{"value":"0x00EA","label":"Volume-"},{"value":"0x018A","label":"Email"},{"value":"0x0192","label":"Calculator"},{"value":"0x0194","label":"My Computer"},{"value":"0x0223","label":"Homepage"},{"value":"0x0221","label":"Search"},{"value":"0x0225","label":"Next page"},{"value":"0x0224","label":"Previous page"},{"value":"0x0226","label":"Stop page"},{"value":"0x0227","label":"Refresh page"},{"value":"0x022A","label":"Favorites"}]},{"value":"6","label":"Macro","children":[]}];
export const DPI_DYNAMIC_MODE_LABELS: { value: number; label: string }[] = [{"value":1,"label":"Classic"},{"value":2,"label":"Natural"},{"value":3,"label":"Jump"},{"value":0,"label":"Custom"}];

/** V8 [Drive1] defaults. */
export const DPI_GRADE_DEFAULTS: number[] = [1200,2400,3200,5600,8000,42000,6000,8000];
export const DPI_STAGE_COLORS: [number, number, number][] = [[255,0,0],[0,255,0],[0,0,255],[255,255,0],[0,255,255],[255,0,255],[0,255,255],[255,255,255]];
export const DPI_MAX_GRADE = 6;
export const KEY_NUMBER = 6;
export const BATTERY_CURVE: number[] = [3050,3170,3230,3300,3600,3660,3720,3760,3800,3840,3880,3920,3940,3960,3980,4000,4020,4040,4060,4080,4110];

// `batteryPercentFromCurve()` moved to `@shared/battery` — it is not part of
// this generated file's template and `npm run extract` would delete it here.
