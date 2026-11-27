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
 * So the green channel is lifted as blue leads — by the square of its lead, so
 * a pure blue gains the most and a violet, whose red is up too, little — and
 * anything that is not blue-dominant gains nothing at all. White, cyan and red
 * are untouched to the byte. It was 0.34 of a linear lead: set side by side
 * with the board, the blue still "is more blue in reality; you depict it more
 * violet" (2026-11-26).
 *
 * Applied only where light is DEPICTED (`litCap`, the effect thumbnails, the
 * colour picker). Never to a value on its way to the device: the board is
 * told exactly the colour that was picked. The same goes for everything below.
 */
const BLUE_SPREAD = 0.44;

/**
 * How far a diode's blue at full drive outweighs the red lit beside it.
 *
 * Red and blue together read bluer on the board than on a screen: set side by
 * side, magenta "looks more like your violet", and the violet "a bit more
 * blue" than it was drawn — while a pink, whose blue is low, was drawn "spot
 * on" (2026-11-26, both zones). So red is held back by the square of the
 * blue's share, and by the square of what green is missing: magenta and
 * violet move, a pink or a hot pink hardly, a lavender only so far.
 */
const RED_UNDER_BLUE = 0.62;

/**
 * Near-whites read as WHITES on the board: the eye takes a light that bright
 * and that pale as white light, a little tinted. Drawn as a flat swatch beside
 * the page's own white, the same colour read as a pastel — the warm white "more
 * orange-ish than in reality, where it looks grey-ish, a bit grey-yellow"
 * (2026-11-26). So below `hi` of chroma (Oklab) a tint fades towards white —
 * to `floor` of itself by `lo` — and a warm one leans yellow rather than
 * orange as it does. Pink, peach and every stronger colour are above `hi`
 * and keep their colour to the byte.
 */
const NEAR_WHITE = { lo: 0.09, hi: 0.115, floor: 0.6 } as const;

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

/** sRGB's transfer curve: a share of light (0..1) as a screen stores it. */
const srgbEncode = (x: number): number =>
  x <= 0.0031308 ? 12.92 * x : 1.055 * Math.pow(x, 1 / 2.4) - 0.055;
/** …and back: a stored screen value (0..1) as the share of light it is. */
const srgbDecode = (c: number): number =>
  c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);

/**
 * How a zone's diodes turn the numbers they are sent into light.
 *
 * `screen`: as a screen does — the firmware corrects for the eye, so a colour
 * sent as it was picked lights as it looked. A keyboard's main lighting (the
 * per-key matrix): on an R85 HE, #ff4d00 lit red, #ff7f32 orange, and a lime
 * of #79ff00 the same green as green, which is a screen's arithmetic.
 *
 * `linear`: half of a channel is half the light. A screen stores light
 * gamma-encoded — #80 is about a fifth of the light, not half — so a colour
 * sent as picked lights every channel below full much STRONGER than it
 * looked: #ff9500, an orange on screen, lights as #ffc900, a yellow; #ff8080,
 * a salmon, nearly white. A keyboard's side strip: on the same board #ff9500
 * was "pretty much yellow", #ffee80 white, #ff7f32 whitish and #ff4d00 a
 * proper orange — all of it what this predicts.
 *
 * Anything not known to be linear is `screen`, which is also how every colour
 * was sent before the two were told apart.
 */
export type LedResponse = 'screen' | 'linear';

/**
 * A colour as a LINEAR diode mixes it, at the brightness it was given: each
 * channel's share of the brightest one, shown as a screen would show that
 * much light. The brightest channel — and so how bright the colour is — stays
 * as it was: brightness is the drive's to depict (`litCap`), and a primary, a
 * white or a black come through to the byte.
 */
function asLit([r, g, b]: [number, number, number]): [number, number, number] {
  const peak = Math.max(r, g, b);
  if (peak <= 0) return [0, 0, 0];
  const lit = (n: number) => peak * srgbEncode(n / peak);
  return [lit(r), lit(g), lit(b)];
}

/** A colour as a zone's diodes light it, on screen: `emittedRgb`, after
 *  `asLit` on a linear zone. */
export function shownRgb(
  rgb: [number, number, number],
  response: LedResponse,
): [number, number, number] {
  return emittedRgb(response === 'linear' ? asLit(rgb) : rgb);
}

/** `shownRgb` for a CSS colour, passing anything unparseable through. */
export function shownCss(css: string, response: LedResponse): string {
  const rgb = parseCssColor(css);
  if (!rgb) return css;
  const [r, g, b] = shownRgb(rgb, response);
  return `rgb(${r}, ${g}, ${b})`;
}

/** What a zone's diodes must be told for a colour to LOOK like `look`: the
 *  reverse of `asLit` on a linear zone, the colour itself on the others. */
export function ledFor(look: string, response: LedResponse): string {
  if (response !== 'linear') return look.toLowerCase();
  return rgbToHex(hexToRgb(look).map((n) => 255 * srgbDecode(n / 255)) as [number, number, number]);
}

export function emittedRgb(rgb: [number, number, number]): [number, number, number] {
  const [r, g, b] = asSeen(rgb);
  const lead = Math.max(0, b - Math.max(r, g)) / 255;
  /** How much white the colour carries, 0..1. */
  const white = Math.min(r, g, b) / 255;
  const cool = (n: number, i: number) => clampByte(n - white * (255 - LED_WHITE[i]!));
  return [cool(r, 0), cool(g + b * BLUE_SPREAD * lead * lead, 1), cool(b, 2)];
}

/** `RED_UNDER_BLUE` and `NEAR_WHITE`, in linear light and Oklab. */
function asSeen([r8, g8, b8]: [number, number, number]): [number, number, number] {
  const g = srgbDecode(g8 / 255);
  const b = srgbDecode(b8 / 255);
  const r = srgbDecode(r8 / 255) * (1 - RED_UNDER_BLUE * b * b * (1 - g) ** 2);
  const [L, A, B] = linearToOklab(r, g, b);
  const C = Math.hypot(A, B);
  const { lo, hi, floor } = NEAR_WHITE;
  const t = Math.min(1, Math.max(0, (C - lo) / (hi - lo)));
  const keep = floor + (1 - floor) * t * t * (3 - 2 * t);
  let h = Math.atan2(B, A);
  if (keep < 1 && C > 1e-6) {
    // A warm tint (an orange to a yellow, about 30-110 degrees) leans yellow
    // as it fades, by as much as it fades.
    const deg = (h * 180) / Math.PI;
    const warm = Math.max(0, 1 - Math.abs(deg - 70) / 40);
    const toYellow = ((((95 - deg + 180) % 360) + 360) % 360) - 180;
    h += ((toYellow * Math.PI) / 180) * warm * ((1 - keep) / (1 - floor));
  }
  const [lr, lg, lb] = oklabToLinear(L, C * keep * Math.cos(h), C * keep * Math.sin(h));
  return [lr, lg, lb].map((x) => 255 * srgbEncode(Math.min(1, Math.max(0, x)))) as [
    number,
    number,
    number,
  ];
}

/** Linear sRGB -> Oklab (Björn Ottosson's matrices). */
function linearToOklab(r: number, g: number, b: number): [number, number, number] {
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

/** Oklab -> linear sRGB. */
function oklabToLinear(L: number, a: number, b: number): [number, number, number] {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
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

/** A preset's name: a hue's, or one of the palette's own. */
export type PresetName =
  | SwatchHueName
  | 'white'
  | 'off'
  | 'rose'
  | 'amber'
  | 'lemon'
  | 'lightLime'
  | 'spring'
  | 'turquoise'
  | 'azure'
  | 'purple'
  | 'hotPink'
  | 'warmWhite'
  | 'pink'
  | 'peach'
  | 'cream'
  | 'paleLime'
  | 'mint'
  | 'aqua'
  | 'periwinkle'
  | 'lavender'
  | 'orchid';

/**
 * The LED presets, as they should LOOK: one column per colour family, and
 * down each column the colour itself, then two other colours of its family —
 * a neighbour round the wheel, and a light one.
 *
 * Not three brightnesses of each colour, which is what the rows were: full,
 * then 72%, then half. Brightness is the effect's own setting already, and a
 * dimmer red is not another colour ("propose actually different colours, not
 * lower intensities").
 *
 * Spaced so that no two are closer than a plainly visible difference (ΔE2000
 * 8.5, the light lime and the cream): a first draft put a chartreuse beside
 * the green (2.2) and an indigo beside the blue (3.2), which on a diode are
 * the same colour twice. Every entry is at full value — a darker "teal" would
 * only be a dimmer cyan.
 */
export const LED_PALETTE: ReadonlyArray<ReadonlyArray<{ name: PresetName; look: string }>> = [
  [
    { name: 'red', look: '#ff0000' },
    { name: 'orange', look: '#ff8000' },
    { name: 'yellow', look: '#ffe000' },
    { name: 'lime', look: '#b4ff00' },
    { name: 'green', look: '#00ff00' },
    { name: 'cyan', look: '#00e5ff' },
    { name: 'blue', look: '#0000ff' },
    { name: 'violet', look: '#8800ff' },
    { name: 'magenta', look: '#ff00ff' },
    { name: 'white', look: '#ffffff' },
  ],
  [
    { name: 'rose', look: '#ff0055' },
    { name: 'amber', look: '#ffb000' },
    { name: 'lemon', look: '#f4ff3d' },
    { name: 'lightLime', look: '#d4ff8a' },
    { name: 'spring', look: '#00ff80' },
    { name: 'turquoise', look: '#00ffd0' },
    { name: 'azure', look: '#0099ff' },
    { name: 'purple', look: '#c400ff' },
    { name: 'hotPink', look: '#ff2a9d' },
    { name: 'warmWhite', look: '#ffcf9a' },
  ],
  [
    { name: 'pink', look: '#ff8095' },
    { name: 'peach', look: '#ffb07a' },
    { name: 'cream', look: '#fff4b3' },
    { name: 'paleLime', look: '#ecffc4' },
    { name: 'mint', look: '#a0ffc8' },
    { name: 'aqua', look: '#b8fbff' },
    { name: 'periwinkle', look: '#9db1ff' },
    { name: 'lavender', look: '#cfa3ff' },
    { name: 'orchid', look: '#ffa3e6' },
    // Black is "this key off" — the only way to switch a single key off in
    // the per-key editor, which is why it has to be reachable as a colour.
    { name: 'off', look: '#000000' },
  ],
];

/** One preset for a zone: what its diodes are told, and what it is called. */
export interface LedPreset {
  hex: string;
  name: PresetName;
}

/** The presets for a zone (`LedResponse`), row by row. */
export function ledPresets(response: LedResponse): LedPreset[][] {
  return LED_PALETTE.map((row) =>
    row.map((p) => ({ hex: ledFor(p.look, response), name: p.name })),
  );
}

/** The preset a colour is in a zone, if it is one — what its swatch is called. */
export function presetOf(hex: string, response: LedResponse): LedPreset | undefined {
  const h = hex.toLowerCase();
  for (const row of ledPresets(response)) for (const p of row) if (p.hex === h) return p;
  return undefined;
}

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
