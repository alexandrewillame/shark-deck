// AUTO-EXTRACTED from Attack Shark Driver v4 (dist/js chunks 5e635fe2.js,
// index.b078bf5f.js). Do not edit. Regenerate: npm run extract:kb
// Provenance: ported-from-vendor — option sets and wire values the vendor
// software itself uses. The checksum and every reply offset still need a
// capture — see docs/reverse-engineering/CAPTURE-KEYBOARD.md.
// Pure data, no Node, so the renderer can label controls with it.

export interface KbLightEffect {
  type: string;
  maxValue: number | null;
  maxSpeed: number | null;
  rgb: boolean;
  dazzle: boolean;
  options?: string[];
}

/** Per-key lighting effects (vendor `lightLayout`). */
export const KB_PERKEY_EFFECTS: KbLightEffect[] = [{"type":"LightWave","maxValue":4,"maxSpeed":4,"rgb":true,"dazzle":true,"options":["right","left","down","up"]},{"type":"LightRipple","maxValue":4,"maxSpeed":4,"rgb":true,"dazzle":true},{"type":"LightRaindrop","maxValue":4,"maxSpeed":4,"rgb":true,"dazzle":true},{"type":"LightSnake","maxValue":4,"maxSpeed":4,"rgb":true,"dazzle":true,"options":["zigzag","spiral"]},{"type":"LightPressAction","maxValue":4,"maxSpeed":4,"rgb":true,"dazzle":true},{"type":"LightConverage","maxValue":4,"maxSpeed":4,"rgb":true,"dazzle":true},{"type":"LightSineWave","maxValue":4,"maxSpeed":4,"rgb":true,"dazzle":true},{"type":"LightKaleidoscope","maxValue":4,"maxSpeed":4,"rgb":true,"dazzle":true,"options":["out","in"]},{"type":"LightPressActionOff","maxValue":4,"maxSpeed":4,"rgb":true,"dazzle":true},{"type":"LightLineWave","maxValue":4,"maxSpeed":4,"rgb":true,"dazzle":true,"options":["right","left"]},{"type":"LightLaser","maxValue":4,"maxSpeed":4,"rgb":true,"dazzle":true},{"type":"LightCircleWave","maxValue":4,"maxSpeed":4,"rgb":true,"dazzle":true,"options":["ccw","cw"]},{"type":"LightDazzing","maxValue":4,"maxSpeed":4,"rgb":true,"dazzle":true},{"type":"LightRainDown","maxValue":4,"maxSpeed":4,"rgb":true,"dazzle":true},{"type":"LightMeteor","maxValue":4,"maxSpeed":4,"rgb":true,"dazzle":true},{"type":"LightAlwaysOn","maxValue":4,"maxSpeed":null,"rgb":true,"dazzle":true},{"type":"LightBreath","maxValue":4,"maxSpeed":4,"rgb":true,"dazzle":true},{"type":"LightNeon","maxValue":4,"maxSpeed":4,"rgb":false,"dazzle":false},{"type":"LightUserPicture","maxValue":4,"maxSpeed":null,"rgb":false,"dazzle":false,"options":["pattern1","pattern2","pattern3","pattern4","pattern5"]},{"type":"LightMusicFollow2","maxValue":4,"maxSpeed":null,"rgb":true,"dazzle":true,"options":["upright","separate","intersect"]},{"type":"LightScreenColor","maxValue":4,"maxSpeed":null,"rgb":false,"dazzle":false}];

/** Side / edge lighting effects (vendor `sideLightLayout`). */
export const KB_SIDE_EFFECTS: KbLightEffect[] = [{"type":"LightWave","maxValue":4,"maxSpeed":4,"rgb":true,"dazzle":true},{"type":"LightSnake","maxValue":4,"maxSpeed":4,"rgb":true,"dazzle":true},{"type":"LightOff","maxValue":null,"maxSpeed":null,"rgb":false,"dazzle":false},{"type":"LightAlwaysOn","maxValue":4,"maxSpeed":null,"rgb":true,"dazzle":true},{"type":"LightBreath","maxValue":4,"maxSpeed":4,"rgb":true,"dazzle":true},{"type":"LightNeon","maxValue":4,"maxSpeed":4,"rgb":false,"dazzle":false}];

/** Magnetic key-mode enum (vendor `_decodeMagnetismKeyModes`). bit7 of the
 *  mode byte is the rapid-trigger ("fire") flag; bits0-6 are the mode. */
export const KB_MAGNETIC_MODES: { value: number; mode: string }[] = [{"value":0,"mode":"normal"},{"value":2,"mode":"dks"},{"value":3,"mode":"mt"},{"value":4,"mode":"tgl_hold"},{"value":5,"mode":"tgl_dots"},{"value":7,"mode":"snap"}];

/** Paged MULTI_MAGNETISM channels and how many 56-byte read chunks the
 *  vendor requests for each (SET_MULTI_MAGNETISM=101, GET=229). 2 bytes/key
 *  little-endian, indexed by the raw defaultMatrix slot, EXCEPT page 7 and
 *  page 10 (see notes). */
export const KB_MAGNETISM_PAGES = {
  MODES: 7,        // 1 byte/key: bit7 fire, bits0-6 mode
  TRAVEL: 0,       // press actuation
  RELEASE: 1,      // release point (normal mode)
  PAGE6: 6,        // third travel list (vendor 'r'); role TBD by capture
  RT_PRESS: 2,     // rapid-trigger re-press sensitivity (only if any key armed)
  RT_RELEASE: 3,   // rapid-trigger release sensitivity
  DKS_POINTS: 4,   // dynamic-keystroke actuation points
  DKS_DETAIL: 10,  // dynamic-keystroke per-zone key actions (4 bytes/key, 8 chunks)
  MT: 5,           // mode-tap data (only if any key in 'mt')
  SNAP: 9,         // SOCD / snap-tap data (only if any key in 'snap')
  DEADZONE: 251,   // top dead zone (only if supported)
  SWITCH_TYPE: 252,// installed switch id (only if switch is replaceable)
} as const;

/** Chunk counts the vendor reads per page. */
export const KB_MAGNETISM_PAGE_CHUNKS: Record<number, number> = {"0":4,"1":4,"2":4,"3":4,"4":4,"5":2,"6":4,"7":2,"9":2,"10":8,"251":2,"252":2};

export const KB_TRAVEL_MULTIPLIER_RULE = "<768 || undefined -> 10; [768,1280) -> 100; >=1280 -> 200";

/** HE command numbers not yet in compx-keyboard.ts KB_CMD (5e635fe2 gen). */
export const KB_HE_EXTRA_CMD = {
  SET_MAGNETISM_CAL: 28,
  SET_MAGNETISM_MAXIMUM_CALIBRATION: 30,
  SET_CMD_AUTOOSEN: 23,
  GET_CMD_AUTOOSEN: 151,
  SET_SKU: 80,
  GET_SKU: 208,
  GET_LEDONOFF: 133,
} as const;

/** SET_KEYSTROKE / GET_KEYSTROKE only exist in the c5a66cc9 generation, not
 *  in the R85HE's 5e635fe2 class. Kept here so the capture can check whether
 *  the R85HE firmware answers them anyway. */
export const KB_KEYSTROKE_CMD_C5 = { SET: 35, GET: 163 } as const;
