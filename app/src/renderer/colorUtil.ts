/** `#rrggbb` <-> the `[r, g, b]` triplets every lighting/DPI-colour type uses on the wire. */

const clampByte = (n: number): number =>
  Number.isFinite(n) ? Math.max(0, Math.min(255, Math.round(n))) : 0;

export const hexToRgb = (h: string): [number, number, number] => {
  // Accept `#rgb` and `#rrggbb`; anything shorter/garbled would otherwise yield
  // NaN components. Fall back to black.
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(h.trim());
  if (!m) return [0, 0, 0];
  const s = m[1]!.length === 3 ? m[1]!.replace(/(.)/g, '$1$1') : m[1]!;
  return [parseInt(s.slice(0, 2), 16), parseInt(s.slice(2, 4), 16), parseInt(s.slice(4, 6), 16)];
};

export const rgbToHex = (c: [number, number, number]) =>
  `#${c.map((n) => clampByte(n).toString(16).padStart(2, '0')).join('')}`;

/**
 * Black or white text for a painted background, or `undefined` when the
 * background is not a literal colour we can measure.
 *
 * It measures the colour *behind the text*, so it belongs to boards that
 * PAINT a key - a key group, a remap, a DPI stage. A backlit board does not
 * go through here at all: there the legend is lit from behind rather than
 * printed on a surface, and `litCap` returns its colour directly.
 *
 * Why this exists: a painted key used to force `color: var(--on-accent)`,
 * which is `#ffffff` for over half the palette/mode combinations in
 * tokens.css. Paint a key white in the per-key lighting editor under one of
 * those and its label is white on white — the reported unreadable text.
 *
 * `undefined` for `var(--accent)`, gradients and anything else unparseable:
 * those are theme colours that the theme's own `--on-accent` is designed
 * against, so guessing at them would be worse than deferring. Only literal
 * `rgb()`/`hsl()`/hex values — which is what every device-colour path
 * produces — are measured here.
 *
 * The 0.55 threshold is on perceptual luminance (Rec. 709), slightly above
 * the midpoint so mid-tones land on white text, which stays legible against a
 * colour where black would start to muddy.
 */
export function readableTextOn(background: string): '#000' | '#fff' | undefined {
  const rgb = parseCssColor(background);
  if (!rgb) return undefined;
  const [r, g, b] = rgb.map((n) => {
    const c = n / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.55 * 0.55 ? '#000' : '#fff';
}

/** `rgb(r,g,b)` / `hsl(h,s%,l%)` / `#rgb` / `#rrggbb` -> bytes. Null otherwise. */
export function parseCssColor(css: string): [number, number, number] | null {
  const s = css.trim();
  if (s.startsWith('#')) return /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(s) ? hexToRgb(s) : null;
  const rgb = /^rgba?\(([^)]+)\)$/i.exec(s);
  if (rgb) {
    const p = rgb[1]!
      .split(/[,\s/]+/)
      .filter(Boolean)
      .map(Number);
    if (p.length < 3 || p.slice(0, 3).some((n) => !Number.isFinite(n))) return null;
    return [clampByte(p[0]!), clampByte(p[1]!), clampByte(p[2]!)];
  }
  const hsl = /^hsla?\(([^)]+)\)$/i.exec(s);
  if (hsl) {
    const p = hsl[1]!.split(/[,\s/]+/).filter(Boolean);
    const h = parseFloat(p[0] ?? '');
    const sat = parseFloat(p[1] ?? '') / 100;
    const l = parseFloat(p[2] ?? '') / 100;
    if (![h, sat, l].every(Number.isFinite)) return null;
    return hslToRgb(h, sat, l);
  }
  return null;
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const hp = (((h % 360) + 360) % 360) / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  const [r, g, b] =
    hp < 1
      ? [c, x, 0]
      : hp < 2
        ? [x, c, 0]
        : hp < 3
          ? [0, c, x]
          : hp < 4
            ? [0, x, c]
            : hp < 5
              ? [x, 0, c]
              : [c, 0, x];
  const m = l - c / 2;
  return [clampByte((r + m) * 255), clampByte((g + m) * 255), clampByte((b + m) * 255)];
}

/**
 * The unlit keycap — keep in sync with `--kbkey-unlit` in tokens.css.
 *
 * NEUTRAL, and ONE of them. Both of those are corrections:
 *
 *  - It was `#2b3140`, a blue. Tinting is a MIX, so every LED was dragged
 *    toward that blue on its way onto the cap: a white LED came out a muddy
 *    blue-grey and a blue one came out navy-on-navy. Reported as "white is
 *    not white" and "blue does not really seem blue". A neutral base is the
 *    only one that leaves a colour alone — the cap, its edge, the plate and
 *    the unlit legend are all true greys, and light is ADDED to them.
 *  - What white looks like is not the cap's job but the diode's: a neutral
 *    base still left a white key reading yellow, because the white itself
 *    was drawn neutral. See `LED_WHITE`.
 *  - There were TWO, a dark cap for the dark theme and a pale one for the
 *    light theme, and `litCap` returned a whole colour set for each. That let
 *    the app's own theme switch change the colour of a diode. A keyboard is a
 *    physical object and this board is a photograph of one; a photograph does
 *    not re-expose itself because the page around it went white. The board is
 *    a dark object in both themes now (`keyboard-map.css` gives it a frame so
 *    it sits ON a light page rather than being a hole in it), and what an LED
 *    looks like here depends on the LED alone.
 */
const UNLIT: [number, number, number] = [0x30, 0x30, 0x30];

/** What a legend is when nothing is shining through it — `--kbkey-unlit-text`
 *  in tokens.css, which is likewise one value for both themes. */
const LEGEND_OFF: [number, number, number] = [0xe8, 0xe8, 0xe8];

/**
 * A colour as it looks EMITTED through a keycap, rather than as a flat fill.
 *
 * The one correction in this file that moves a hue, and it is here because of
 * a real report: "blue seems purple".
 *
 * It is not a mistake in the model — sRGB's blue primary genuinely looks
 * violet. Its dominant wavelength is about 464nm, right at the edge of the
 * visible range, and a flat `#0000ff` rectangle reads as violet to most
 * people. But a photograph of a blue-backlit keyboard does not: it is azure.
 * Light scattering through a translucent cap is no longer monochromatic, the
 * die's spectral tail reaches the green cone response, and both a camera and
 * an eye report the result as a blue with green in it.
 *
 * So the green channel is lifted in proportion to how far blue is leading —
 * pure blue gains the most, and anything that is not blue-dominant gains
 * nothing at all. White, cyan and red are untouched to the byte, and a violet
 * the user actually chose stays violet, because there red is leading too.
 *
 * Applied only where light is DEPICTED (`litCap`, the effect thumbnails).
 * Never to a value on its way to the device: the board is told exactly the
 * colour that was picked. The same goes for the white point below.
 */
const BLUE_SPREAD = 0.34;

/**
 * The white an RGB diode makes — every die at full — as a colour on screen.
 *
 * Not `#ffffff`. Three dies at full power make a COOL white, bluish beside
 * daylight, and that is what a photograph of a white-lit board shows. Drawn
 * neutral, a white key was the one object on screen with no blue in it, in an
 * app whose surfaces and text are all a little blue — and beside them a
 * neutral reads warm. Reported again and again ("white still looks yellow"):
 * the cap, the plate and the legend were made true greys, and a true-grey
 * white key still read yellow-grey. This is a touch cooler than the app's own
 * text white (`--text`, `#e8edf4`), so the board's white and the page's white
 * read as the same white.
 *
 * It applies to the NEUTRAL part of a colour only — `min(r, g, b)` of the
 * colour picked — so a saturated colour is untouched to the byte and a pastel
 * is cooled by exactly as much white as it carries.
 */
export const LED_WHITE: readonly [number, number, number] = [236, 243, 255];

export function emittedRgb([r, g, b]: [number, number, number]): [number, number, number] {
  const lead = Math.max(0, b - Math.max(r, g)) / 255;
  /** How much white the colour carries, 0..1. */
  const white = Math.min(r, g, b) / 255;
  const cool = (n: number, i: number) => clampByte(n - white * (255 - LED_WHITE[i]!));
  return [cool(r, 0), cool(g + b * BLUE_SPREAD * lead, 1), cool(b, 2)];
}

/** `emittedRgb` for a CSS colour string, passing anything unparseable through
 *  untouched — the same contract as `readableTextOn` and `litCap`. */
export function emittedCss(css: string): string {
  const rgb = parseCssColor(css);
  if (!rgb) return css;
  const [r, g, b] = emittedRgb(rgb);
  return `rgb(${r}, ${g}, ${b})`;
}

export interface LitCap {
  /** What `accent` returned, untouched — the colour the device is being told.
   *  Also what a BARE board paints its keys with: a thumbnail is a diagram of
   *  a preset, not a photograph of one. */
  led: string;
  /** The cap face, lit in the diode's colour. */
  cap: string;
  /** Light escaping the gap between cap and plate: the cap's lit edge. */
  rim: string;
  /** The pool of light on the plate around the key. */
  glow: string;
  /** The legend: dark on a light face, light on a dark one. */
  legend: string;
  /** The legend's shadow — a lift for a light legend, none for a dark one. */
  legendShadow: string;
}

/**
 * One LED colour, resolved into the layers a lit keycap is drawn with.
 *
 * THE FACE IS THE COLOUR. The board used to draw an opaque grey cap that only
 * picked up a third of the diode's colour, with the light itself in a halo
 * round it. It looked like a photograph and could not show a colour: a grey
 * cap plus a little yellow is olive, plus a little white is grey, and at a low
 * brightness the two came out as the same muddy khaki — "white is depicted as
 * yellow; put a yellow key next to a white one and they are too similar". A
 * colour only reads as itself when it is bright, so the face now carries it:
 * a translucent cap lit from below, in the diode's own colour, with the edge
 * and the pool on the plate around it.
 *
 * Brightness dims the face only a little and the edge and the pool a lot,
 * because that is what an eye does with a keyboard in a room: even at the
 * lowest level every colour on the real board is plainly itself. Below a
 * whisper of drive (`OFF_BELOW`) a key is off — an effect's dark keys and the
 * per-key editor's black stay unlit caps.
 *
 * The legend is printed, not lit: dark on a light face, light on a dark one,
 * whichever reads (`readableTextOn`).
 *
 * Null when the colour is not literal (`var(--accent)`, a gradient) — the
 * caller falls back to the flat fill, exactly as `readableTextOn` does.
 */
const OFF_BELOW = 0.05;
export function litCap(led: string): LitCap | null {
  const raw = parseCssColor(led);
  if (!raw) return null;
  // How hard the diode is driven, NOT its perceptual luminance. A saturated
  // blue at full power has a Rec. 709 luminance of 0.07 and is unmistakably
  // ON; scaling the light by luminance would leave every blue key looking
  // unlit. HSV value is the honest answer to "how much current".
  const peak = Math.max(raw[0], raw[1], raw[2]);
  /** The drive, 0..1, with the near-black that means "off" taken out. */
  const d = Math.min(1, Math.max(0, (peak / 255 - OFF_BELOW) / (1 - OFF_BELOW)));
  /**
   * WHAT the diode emits, apart from how hard: the colour at full power, as
   * it looks emitted (`emittedRgb`).
   *
   * Taken to full power BEFORE it is emitted, not after: `emittedRgb`'s azure
   * lift scales with how far blue leads, so applied to a dimmed blue it lifted
   * less — a blue at brightness 1 kept most of its violet ("the blue, 0-0-255,
   * is purple"). A diode's hue does not change with its current; neither does
   * this. And every layer takes the drive once: the colour used to arrive
   * dimmed and be dimmed again, so level 1 glowed at 6% of level 4.
   */
  const hue = emittedRgb(
    (peak > 0 ? raw.map((n) => (n * 255) / peak) : [0, 0, 0]) as [number, number, number],
  );
  /** How far the face goes from unlit plastic to the diode's colour: most of
   *  the way even at a low level, and nothing at all for a key that is off. */
  const k = d > 0 ? 0.92 * (1 - Math.exp(-3.4 * d)) : 0;
  const face = [0, 1, 2].map((i) => clampByte(UNLIT[i]! * (1 - k) + hue[i]! * k)) as [
    number,
    number,
    number,
  ];
  /** The colour, bleached toward the diode's white by `m` — what a bright
   *  emitter does at its core, and why the edge reads as light, not paint. */
  const hot = (m: number): [number, number, number] =>
    hue.map((n, i) => clampByte(n * (1 - m) + LED_WHITE[i]! * m)) as [number, number, number];
  const [hr, hg, hb] = hue.map(clampByte) as [number, number, number];
  const [rr, rg, rb] = hot(0.35);
  const capCss = `rgb(${face[0]}, ${face[1]}, ${face[2]})`;
  const dark = readableTextOn(capCss) === '#000';
  return {
    led,
    cap: capCss,
    rim: `rgba(${rr}, ${rg}, ${rb}, ${(0.85 * d).toFixed(3)})`,
    glow: `rgba(${hr}, ${hg}, ${hb}, ${(0.62 * d ** 0.75).toFixed(3)})`,
    legend: dark ? 'rgba(0, 0, 0, 0.78)' : `rgb(${LEGEND_OFF.join(', ')})`,
    legendShadow: dark ? 'none' : '0 1px 2px rgba(0, 0, 0, 0.55)',
  };
}

/**
 * The hues every swatch grid in the app is built from, round the wheel.
 *
 * ONE list, because there are two grids: the key-group picker on the
 * Actuation tab (`useKeyGroups.ts`, which offers each of these at three
 * depths, plus a slate) and the LED presets below. "That colour" names the
 * same colour on both tabs.
 *
 * Nine, in wheel order — red, orange, yellow, lime, green, cyan, blue,
 * violet, magenta — the selection any colour picker opens with. The last one
 * was eight in no order at all (red, green, blue, yellow, chartreuse, purple,
 * cyan, teal), with orange and pink taken out because on the LEDs they had
 * collapsed into red; a picker with no orange is not a good selection either.
 * The two problems are kept apart here instead: orange sits at 35°, yellow
 * enough to stay orange on a diode (at 30° the red channel won), and the
 * pink is a magenta (318°), well clear of red, where a hot pink at 325° read
 * as a second red.
 *
 * Green and blue are the PRIMARIES, 120° and 240°: `#00ff00` and `#0000ff`,
 * one die each, the way red is `#ff0000`. They were 128° and 218° — the set a
 * free search for distance picked — which left a picker with a pure red and no
 * pure green or blue ("you have a pure red but not a pure blue"). A diode's
 * own primary is what people reach for. That a flat `#0000ff` reads violet on
 * a screen is the board's problem, not the swatch's: `emittedRgb` shows it as
 * the azure a lit key actually is.
 *
 * Violet moves to 285° to make room — at 272° it sat 12.5 ΔE from the dark
 * blue in the bottom row. With these angles every pair in each LED row stays
 * at least 22 ΔE apart in CIE Lab (colorUtil.test.ts holds the floor of 20).
 */
export const SWATCH_HUES = [
  { name: 'red', h: 0 },
  { name: 'orange', h: 35 },
  { name: 'yellow', h: 52 },
  { name: 'lime', h: 77 },
  { name: 'green', h: 120 },
  { name: 'cyan', h: 185 },
  { name: 'blue', h: 240 },
  { name: 'violet', h: 285 },
  { name: 'magenta', h: 318 },
] as const;

export type SwatchHueName = (typeof SWATCH_HUES)[number]['name'];

/**
 * The preset grid, shared by every colour control that drives an LED.
 *
 * Same nine hues as the key-group picker, same rows-by-hue-columns shape —
 * but at LED levels rather than UI levels, which is the one place the two
 * grids part company. A group swatch is ink on a keycap in the app;
 * these values are written to a diode, and the group palette's `l: 36` red
 * would be handed to the keyboard as a dim red rather than as "red". So the
 * rows are what a diode can actually do with a hue: run it flat out, run it
 * softly (half white mixed in), or run it at half power.
 *
 * The last column is the neutral ramp, which has no hue to belong to:
 * white is "every channel at full", grey is the same thing dimmed, and black
 * is "this key off" — the only way to switch a single key off in the per-key
 * editor, which is why it has to be reachable as a colour.
 */
export const COLOR_PRESET_ROWS: readonly (readonly string[])[] = [
  [...SWATCH_HUES.map((c) => rgbToHex(hsvToRgb(c.h, 1, 1))), '#ffffff'],
  [...SWATCH_HUES.map((c) => rgbToHex(hsvToRgb(c.h, 0.5, 1))), '#8b93a1'],
  [...SWATCH_HUES.map((c) => rgbToHex(hsvToRgb(c.h, 1, 0.5))), '#000000'],
];

/** `[h 0..360, s 0..1, v 0..1]`. HSV, not HSL: a picker's square is
 *  saturation against value, and going through HSL would round-trip badly at
 *  the edges. */
export function rgbToHsv([r, g, b]: [number, number, number]): [number, number, number] {
  const [R, G, B] = [r / 255, g / 255, b / 255];
  const max = Math.max(R, G, B);
  const min = Math.min(R, G, B);
  const d = max - min;
  let h = 0;
  if (d !== 0) {
    if (max === R) h = ((G - B) / d) % 6;
    else if (max === G) h = (B - R) / d + 2;
    else h = (R - G) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  return [h, max === 0 ? 0 : d / max, max];
}

export function hsvToRgb(h: number, s: number, v: number): [number, number, number] {
  const c = v * s;
  const hp = (((h % 360) + 360) % 360) / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  const [r, g, b] =
    hp < 1
      ? [c, x, 0]
      : hp < 2
        ? [x, c, 0]
        : hp < 3
          ? [0, c, x]
          : hp < 4
            ? [0, x, c]
            : hp < 5
              ? [x, 0, c]
              : [c, 0, x];
  const m = v - c;
  return [clampByte((r + m) * 255), clampByte((g + m) * 255), clampByte((b + m) * 255)];
}
