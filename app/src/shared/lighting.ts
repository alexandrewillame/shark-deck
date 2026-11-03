/**
 * Lighting effect vocabularies, shared by the keyboard driver and the renderer
 * so the index <-> name mapping is defined exactly once.
 *
 * **Provenance.** The indexed list is the vendor's `LIGHT_LIST`, taken from
 * qmk.top's own bundle (`app/scripts/_raw/qmk-bundle.js`) — array position is
 * the wire value of `SET_LEDPARAM` byte `e[1]`, so the order IS the protocol
 * contract. `provenance: ported-from-vendor`.
 *
 * (This docstring used to credit "Driver v4 chunk 5e635fe2.js" and a
 * `LightList` symbol. There is no such symbol in any Driver-v4 artifact we
 * extract; what Driver v4 gives is `kb-lighting.json`'s unindexed 21-entry
 * object. The indexed table is traceable to qmk.top alone, and
 * `lighting.test.ts` now locks it against that bundle so the two cannot drift.)
 *
 * Per-effect parameters come from the same bundle's per-device `lightLayout`:
 * `maxValue` -> brightness, `maxSpeed` -> speed, `rgb` -> a single custom
 * colour, `dazzle` -> the multi-colour "rainbow" mode, `options` -> an
 * effect-specific direction/variant list. **The absence of `maxSpeed` means the
 * effect has no speed at all** — which is why a static effect must not show a
 * speed slider.
 */

export interface KbLightEffect {
  /** Vendor identifier (`LightWave`), the stable key across generations. */
  id: string;
  /** What SharkDeck shows. Descriptive; see `qmkLabel` for the vendor's own. */
  label: string;
  /** qmk.top's English label, surfaced in the tooltip so the two tools can be
   *  cross-referenced. Several are literal translations of Chinese marketing
   *  names, which is why they are not used as the primary label. */
  qmkLabel: string;
  /** Effect animates, so a speed control applies (vendor `maxSpeed`). */
  speed?: boolean;
  /** Brightness applies (vendor `maxValue`). */
  brightness?: boolean;
  /** Takes a single custom colour (vendor `rgb`). */
  colour?: boolean;
  /** Supports the multi-colour "rainbow" mode (vendor `dazzle`). */
  dazzle?: boolean;
  /** Direction / variant choices, in wire order (vendor `options`). */
  options?: string[];
  /** False for effects this board generation's `lightLayout` does not list —
   *  the wire value exists, but no captured device offers it. Filtered out of
   *  the picker unless a descriptor opts in. */
  listed?: boolean;
}

const A = { brightness: true, speed: true, colour: true, dazzle: true } as const;

/**
 * Wire index -> effect. **Order is the protocol; do not sort.**
 * Verified index-for-index against `LIGHT_LIST` in the vendor bundle.
 */
export const KB_LIGHT_EFFECTS_TABLE: KbLightEffect[] = [
  { id: 'LightOff', label: 'Off', qmkLabel: 'Off', listed: true },
  {
    id: 'LightAlwaysOn',
    label: 'Always On',
    qmkLabel: 'Always On',
    brightness: true,
    colour: true,
    dazzle: true,
    listed: true,
  },
  { id: 'LightBreath', label: 'Breath', qmkLabel: 'Dynamic Breathing', ...A, listed: true },
  // No `rgb` in the vendor table — this one cycles the spectrum on its own.
  {
    id: 'LightNeon',
    label: 'Spectrum Cycle',
    qmkLabel: 'Spectrum Cycle',
    brightness: true,
    speed: true,
    listed: true,
  },
  {
    id: 'LightWave',
    label: 'Wave',
    qmkLabel: 'Wave',
    ...A,
    options: ['Right', 'Left', 'Down', 'Up'],
    listed: true,
  },
  { id: 'LightRipple', label: 'Press Ripple', qmkLabel: 'Ripple', ...A, listed: true },
  { id: 'LightRaindrop', label: 'Raindrop', qmkLabel: 'Starlight', ...A, listed: true },
  {
    id: 'LightSnake',
    label: 'Snake',
    qmkLabel: 'Stream',
    ...A,
    options: ['Zigzag', 'Spiral'],
    listed: true,
  },
  { id: 'LightPressAction', label: 'Press Action', qmkLabel: 'Shadow', ...A, listed: true },
  { id: 'LightConverage', label: 'Converge', qmkLabel: 'Mountain Wave', ...A, listed: true },
  { id: 'LightSineWave', label: 'Sine Wave', qmkLabel: 'Sine Wave', ...A, listed: true },
  {
    id: 'LightKaleidoscope',
    label: 'Kaleidoscope',
    qmkLabel: 'Color Spring',
    ...A,
    options: ['Outward', 'Inward'],
    listed: true,
  },
  {
    id: 'LightLineWave',
    label: 'Line Wave',
    qmkLabel: 'Flower Wave',
    ...A,
    options: ['Right', 'Left'],
    listed: true,
  },
  // The per-key layer. Brightness only — no speed, no single colour, since the
  // colours come from the painted map (SET_USERPIC).
  {
    id: 'LightUserPicture',
    label: 'Custom (per-key)',
    qmkLabel: 'Custom',
    brightness: true,
    options: ['Pattern 1', 'Pattern 2', 'Pattern 3', 'Pattern 4', 'Pattern 5'],
    listed: true,
  },
  { id: 'LightLaser', label: 'Press Laser', qmkLabel: 'Kill Two Birds', ...A, listed: true },
  {
    id: 'LightCircleWave',
    label: 'Circle Wave',
    qmkLabel: 'Circle Wave',
    ...A,
    options: ['Counter-clockwise', 'Clockwise'],
    listed: true,
  },
  { id: 'LightDazzing', label: 'Dazzling', qmkLabel: 'Colorful Cross', ...A, listed: true },
  { id: 'LightRainDown', label: 'Rain Down', qmkLabel: 'Snow Fall', ...A, listed: true },
  { id: 'LightMeteor', label: 'Meteor', qmkLabel: 'Meteor', ...A, listed: true },
  {
    id: 'LightPressActionOff',
    label: 'Press Action Off',
    qmkLabel: 'Snow Trace',
    ...A,
    listed: true,
  },
  // Music effects: not in this board generation's own lightLayout, so unlisted
  // until a descriptor says otherwise. Shape mirrors LightMusicFollow2, which
  // is listed.
  {
    id: 'LightMusicFollow3',
    label: 'Music (Spectrum)',
    qmkLabel: 'Music Follow Classic',
    brightness: true,
    colour: true,
    dazzle: true,
  },
  {
    id: 'LightScreenColor',
    label: 'Screen Colour',
    qmkLabel: 'Light Shadow',
    brightness: true,
    listed: true,
  },
  {
    id: 'LightMusicFollow2',
    label: 'Music (Level)',
    qmkLabel: 'Music Follow EDM',
    brightness: true,
    colour: true,
    dazzle: true,
    options: ['Upright', 'Separate', 'Intersect'],
    listed: true,
  },
  { id: 'LightTrain', label: 'Train', qmkLabel: 'Marquee', ...A },
  { id: 'LightFireWorks', label: 'Endless', qmkLabel: 'Endless', ...A },
  /**
   * `LightUserColor` — qmk.top calls this "Light Effect Edit" and it carries no
   * parameters at all. It was labelled "Solid Colour" here, which is simply the
   * wrong feature: it is the custom-light editing layer, not a fixed colour.
   *
   * NOTE (`unconfirmed`): which of index 13 / 25 the painted `SET_USERPIC` map
   * actually displays on the R85HE has not been checked on hardware. The
   * driver targets 13 (`KB_PERKEY_EFFECT_INDEX`), matching the command name;
   * index 25 is also generation-dependent — of the five `LIGHT_LIST` variants
   * in the vendor bundle three end at 25, one ends at 24, and one maps
   * `LightUserColor` to 66 — so writing it blind to the wrong generation is a
   * wrong-effect write.
   */
  { id: 'LightUserColor', label: 'Custom Colour Layer', qmkLabel: 'Light Effect Edit' },
];

/**
 * Labels that have been corrected, old -> new.
 *
 * `LightingSettings.effect` stores the display LABEL, and software profiles
 * and saved layouts on disk hold whatever label was current when they were
 * written. Renaming an entry above therefore orphans stored data unless it is
 * translated on read — a profile saved as "Ripple" must still resolve after
 * the entry became "Press Ripple".
 *
 * Both renames say the same thing: these two effects only do anything when a
 * key is struck, which "Ripple" and "Laser" gave no hint of.
 */
const RENAMED_LABELS: Record<string, string> = {
  Ripple: 'Press Ripple',
  Laser: 'Press Laser',
};

/** A stored effect label, mapped through any rename since it was written. */
export function currentEffectLabel(stored: string): string {
  return RENAMED_LABELS[stored] ?? stored;
}

/** Display names by wire index — array position is still the wire value. */
export const KB_LIGHT_EFFECTS: string[] = KB_LIGHT_EFFECTS_TABLE.map((e) => e.label);

/**
 * How many discrete brightness/speed levels the keyboard actually has,
 * counting 0 — so five: 0, 1, 2, 3, 4.
 *
 * Every entry in the vendor's own per-device `lightLayout` carries
 * `maxValue: 4` and `maxSpeed: 4` (see `KB_PERKEY_EFFECTS` in
 * shared/keyboard-options.ts), and the driver divides the UI's 0-100 by 25 on
 * the way to the wire. A percentage slider therefore offered 101 positions
 * over 5 real values: four moves out of five changed nothing on the board.
 *
 * The 0-100 scale stays on `LightingSettings` — it is shared with mouse
 * lighting and is the persisted shape in software profiles and backups — so
 * the conversion happens in the UI (`StepSlider`), not in the stored data.
 */
export const KB_LIGHT_STEPS = 5;

/** Wire index of the per-key ("user picture") layer within KB_LIGHT_EFFECTS. */
export const KB_PERKEY_EFFECT_INDEX = 13;

/** Look an effect up by its display label. */
export function kbEffect(label: string): KbLightEffect | undefined {
  const name = currentEffectLabel(label);
  return KB_LIGHT_EFFECTS_TABLE.find((e) => e.label === name);
}

/**
 * Side/underglow effect <-> wire value, from the vendor bundle's own
 * `SIDE_LIGUT_LIST` (the vendor's typo):
 *
 *   0 Off · 1 Always On · 2 Breath · 3 Neon · 4 Wave · 5 Snake
 *   20 Music (Spectrum) · 21 Screen Colour · 22 Music (Level)
 *
 * Snake was `7` here and tagged `inferred "pending a capture"` — it was carried
 * over from the main list, where Snake IS 7. The side list is a different,
 * shorter table and puts it at **5**; the answer was in the repo's own extract
 * the whole time. The three high entries were missing entirely.
 * `provenance: ported-from-vendor`.
 *
 * The bundle also confirms the option byte convention this driver already uses
 * (`NORMAL: 7`, `DAZZLE: 8`).
 */
export const SIDE_LIGHT_EFFECTS: { name: string; wire: number }[] = [
  { name: 'Off', wire: 0 },
  { name: 'Always On', wire: 1 },
  { name: 'Breath', wire: 2 },
  { name: 'Spectrum Cycle', wire: 3 },
  { name: 'Wave', wire: 4 },
  { name: 'Snake', wire: 5 },
  { name: 'Music (Spectrum)', wire: 20 },
  { name: 'Screen Colour', wire: 21 },
  { name: 'Music (Level)', wire: 22 },
];

export function sideEffectWire(name: string): number {
  const n = currentEffectLabel(name);
  return SIDE_LIGHT_EFFECTS.find((e) => e.name === n)?.wire ?? 0;
}

export function sideEffectName(wire: number): string {
  return SIDE_LIGHT_EFFECTS.find((e) => e.wire === wire)?.name ?? 'Off';
}

/**
 * Effects that carry no colour of their own.
 *
 * Derived from the vendor table's `rgb` flag rather than hand-listed. The old
 * hand-list included Wave, Kaleidoscope, Circle Wave and Dazzling — all four of
 * which the vendor marks `rgb:true`, so SharkDeck was hiding a colour picker
 * for effects the board will happily colour.
 */
export const RAINBOW_EFFECTS = new Set(
  KB_LIGHT_EFFECTS_TABLE.filter((e) => !e.colour && e.id !== 'LightOff').map((e) => e.label),
);
