import type { KeyLayoutEntry } from '@shared/types/keys';
import { KB_LIGHT_EFFECTS_TABLE } from '@shared/lighting';

/**
 * What one key should look like, for one effect, at one moment.
 *
 * Split out of LightingTab.tsx: this is a table of ~20 independent little
 * animations, and having it inline made the pane's own layout impossible to
 * read past it.
 *
 * ## What these are and are not
 *
 * These are *illustrations of the vendor's effect names*, not simulations of
 * the firmware. Nothing here is derived from a capture — the board renders
 * these itself and reports nothing back — so every animation is `inferred`:
 * an interpretation of the vendor's own label plus what the effect visibly
 * does on hardware. They exist because names like "Mountain Wave" or "Snow
 * Trace" carry almost no information on their own.
 *
 * The previous version grouped all 20+ effects into eight generic families
 * (wave / ripple / sparkle / chase / …), which meant Snake, Train and Laser
 * all animated identically and none of the three looked like what the board
 * did. Each effect gets its own function here instead.
 */

/** Board bounds in key-units, so a preview works on the real 79-key layout
 *  and on the 6x3 abstract picker tile alike. */
export interface PreviewBounds {
  maxX: number;
  maxY: number;
}

export interface PreviewParams {
  /** 0..1, looping. */
  phase: number;
  bounds: PreviewBounds;
  /** The user's chosen colour, 0-255 per channel. */
  color: [number, number, number];
  /** 0-100. */
  brightness: number;
  /** Multi-colour mode: the effect paints its own hues, not `color`. */
  rainbow: boolean;
  /**
   * Which of the effect's own `options` is selected — the wire's direction /
   * variant nibble, indexing `KbLightEffect.options`.
   *
   * It used to stop at the driver: the board honoured it but nothing here
   * read it, so picking Left for Wave previewed exactly the same sweep as
   * Right and the control looked broken. Every renderer with an `options`
   * list in the vendor table reads it now; the rest ignore it.
   */
  option?: number;
  /**
   * Drawing the SIDE STRIP rather than the board.
   *
   * The two share effect names — Wave, Snake, Breath — and shared a renderer
   * because of it, which drew the strip as if it were a short keyboard. It is
   * one long diffused bar of far more LEDs than a key row, and some of these
   * effects look nothing alike on it. See `STRIP_RENDERERS`.
   */
  strip?: boolean;
}

type KeyLike = Pick<KeyLayoutEntry, 'x' | 'y'>;

/** A renderer returns a CSS colour for one key. */
type EffectRenderer = (k: KeyLike, p: PreviewParams) => string;

// ---------------------------------------------------------------- helpers

const clamp01 = (n: number) => (n < 0 ? 0 : n > 1 ? 1 : n);

/**
 * How bright the board draws a brightness setting, 0..100 -> a drive factor.
 *
 * The one rule for both lighting panes — Global through `tint` below, the
 * per-key board through `previewRgbCss` — so the same colour at the same
 * brightness looks the same on either.
 *
 * PERCEPTUAL, not linear. The board's levels are PWM duty, and an eye reads
 * light on a power curve: a diode at a quarter duty looks about half as bright,
 * not a quarter. Linear, level 1 of 4 drew every key at 25% — and `litCap`
 * then scaled the glow by that dimmed colour again — so the board at level 1
 * looked switched off while the real one showed every colour plainly
 * ("brightness 1 is displayed so dim you cannot really see anything"). This
 * is the sRGB encoding of the duty: levels 1-4 draw at 0.53, 0.73, 0.88, 1.
 *
 * And level 0 draws at 0. There is NO floor here: a board at brightness 0 is
 * switched off, and the preview has to say so. It used to bottom out at 12%
 * (the floor now kept only by `previewLevel`), so the Global pane showed
 * every effect glowing dimly at a setting that turns the real keyboard dark.
 */
export const boardLevel = (brightness: number) =>
  brightness <= 0 ? 0 : (brightness / 100) ** (1 / 2.2);
const bf = (p: PreviewParams) => boardLevel(p.brightness);

/**
 * `boardLevel`, floored at 0.12 — for the per-key pane's painted keys ONLY.
 *
 * That pane is an editor: a painted key still has to be seen to be selected,
 * compared and repainted, and at brightness 0 the true drive is black on
 * black. At every real level (1-4) this is exactly `boardLevel`, so a painted
 * colour looks the same as the Global pane's Always On in it; the two part
 * only at 0, where the board goes dark and the paint stays faintly visible.
 * Nothing that draws an EFFECT may use this — that is what `bf` is for.
 */
export const previewLevel = (brightness: number) => Math.max(0.12, boardLevel(brightness));

/**
 * A painted key's colour as the per-key pane draws it at `brightness`.
 *
 * Display only. What is stored, written, picked by the eyedropper or saved in
 * a layout stays the colour itself; this is how that colour looks at the
 * brightness the board will run it at — floored, see `previewLevel`, so the
 * paint stays editable when the board itself would be off.
 */
export function previewRgbCss(
  [r, g, b]: readonly [number, number, number],
  brightness: number,
): string {
  const f = previewLevel(brightness);
  return `rgb(${Math.round(r * f)}, ${Math.round(g * f)}, ${Math.round(b * f)})`;
}

/**
 * The user's colour at some intensity, or a hue when in rainbow mode.
 *
 * In rainbow mode `hueOffset` is the ONLY thing carrying colour, so it has to
 * vary — and it used to be the whole story. Every renderer that passed a
 * constant (Always On, Breath and the three press effects all passed 0.5)
 * therefore painted the board one flat cyan and looked identical to a static
 * colour. Two fixes, together: the phase is folded in here, so even a constant
 * offset drifts through the spectrum over time, and the renderers below pass a
 * *spatial* offset so it is spread across the board as well.
 */
function tint(p: PreviewParams, intensity: number, hueOffset = 0, drift = true): string {
  const f = clamp01(intensity) * bf(p);
  if (p.rainbow) {
    // `drift` folds the animation phase into the hue, which is what makes a
    // constant offset move through the spectrum. An effect whose hue is its
    // own business — a static one, or one that steps colour on its own beat —
    // passes false and keeps the offset it asked for.
    const base = drift ? hueOffset + p.phase : hueOffset;
    const hue = (((base * 360) % 360) + 360) % 360;
    // Lightness straight from the drive, no constant under it: at zero —
    // Breath's trough, brightness 0 — the key is black, as the diode under it
    // is. The old `12 + 46 * f` kept every "dark" rainbow key a dim grey hue.
    return `hsl(${hue}, 90%, ${Math.round(58 * f)}%)`;
  }
  const [r, g, b] = p.color;
  return `rgb(${Math.round(r * f)}, ${Math.round(g * f)}, ${Math.round(b * f)})`;
}

/** Off. Not the theme's background — a key that is dark in an effect should
 *  look dark, not look like a hole in the board. */
const dark = () => 'rgb(10, 10, 12)';

/** Stable pseudo-random in [0,1) from two ints — same key, same value, every
 *  frame, so a "random" effect glitters instead of flickering. */
function hash(a: number, b: number): number {
  const n = Math.sin(a * 127.1 + b * 311.7) * 43758.5453;
  return n - Math.floor(n);
}

/** Position along the board, 0..1. */
const nx = (k: KeyLike, p: PreviewParams) => (p.bounds.maxX ? k.x / p.bounds.maxX : 0);
const ny = (k: KeyLike, p: PreviewParams) => (p.bounds.maxY ? k.y / p.bounds.maxY : 0);
/**
 * Diagonal position, 0..1, in KEY units: 0 at the bottom-left corner, 1 at
 * the top-right (y grows downward). Every key with the same `x - y` gets the
 * same value, so a band of one hue is an exact 45° "\" line, top-left to
 * bottom-right, on any board. The default spatial hue for an effect whose own
 * shape suggests no particular axis: the spectrum once, corner to corner.
 *
 * It was `(nx + ny) / 2`, which normalises each axis before adding them. On a
 * board three times wider than it is tall that is a stripe rising to the
 * right at about 19°, which read as "nearly horizontal bands", not diagonals.
 */
const diag = (k: KeyLike, p: PreviewParams) => {
  const span = p.bounds.maxX + p.bounds.maxY;
  return span ? (k.x - k.y + p.bounds.maxY) / span : 0;
};

/** The selected option, clamped into an effect's own list. */
const opt = (p: PreviewParams, count: number): number => {
  const n = Math.trunc(p.option ?? 0);
  return n >= 0 && n < count ? n : 0;
};

/**
 * A travelling pulse: how close this position is to a band sweeping the board.
 * `width` is in normalised units; `trail` biases the falloff behind the band
 * so it reads as motion rather than a symmetric blob.
 */
function band(pos: number, at: number, width: number, trail = 1): number {
  const d = pos - at;
  const scale = d > 0 ? width : width * trail;
  return clamp01(1 - Math.abs(d) / scale);
}

/**
 * Which key a simulated keypress lands on, for the press-reactive effects.
 *
 * These effects only do anything when a key is struck, so a preview that sat
 * still would say nothing at all. The preview fakes a press every cycle at a
 * position that wanders, so the shape of the response is what you see.
 */
function pressPoint(p: PreviewParams): { x: number; y: number; age: number } {
  const beat = Math.floor(p.phase * 3); // three presses per loop
  const age = (p.phase * 3) % 1; // 0..1 since this press
  return {
    x: hash(beat, 7) * p.bounds.maxX,
    y: hash(beat, 13) * p.bounds.maxY,
    age,
  };
}

// ---------------------------------------------------------------- effects

/**
 * Always On — full brightness, and nothing moves. In rainbow mode: the
 * spectrum once across the board in 45° bands (`diag`), red at the
 * bottom-left corner round to red again at the top-right.
 *
 * It used to drift: `tint` folds the phase into the hue by default, so the
 * board's corner-to-corner spectrum crawled sideways through
 * red-green-blue-purple forever. An effect whose whole name is "always on"
 * must not animate; the spatial spread stays, the motion goes. (Line Wave is
 * this layout WITH the motion — see `lineWave`.)
 */
const alwaysOn: EffectRenderer = (k, p) => tint(p, 1, diag(k, p), false);

/** Colours a breath cycles through before repeating. */
const BREATH_STEPS = 4;

/**
 * Breath — the whole board one colour, fading right down to black, then back
 * up in a DIFFERENT colour.
 *
 * Three things were wrong with it. The intensity floor of 0.1 meant it never
 * actually reached black, so it read as a dim pulse rather than a breath; the
 * hue came from `diag`, painting a spatial gradient across a board that should
 * be one colour; and `tint`'s phase drift slid that gradient continuously, so
 * the colour changed DURING a breath instead of between breaths. Now the hue
 * is quantised to the cycle and only ever changes while the board is dark.
 */
const breath: EffectRenderer = (_k, p) => {
  const t = p.phase * BREATH_STEPS;
  const step = Math.floor(t);
  // sin over half a period: 0 at both ends, so consecutive colours are
  // separated by real black rather than crossfading into each other. That
  // claim was only true in single-colour mode until `tint` lost its 12%
  // rainbow lightness floor; in rainbow mode the trough was a dim grey hue.
  const intensity = Math.sin((t - step) * Math.PI);
  return tint(p, intensity, step / BREATH_STEPS, false);
};

/** Every key the same hue, cycling together. (Lightness `52 * bf`, like every
 *  hand-rolled `hsl()` below: the same 52% at full brightness as before, and
 *  0 — off — at brightness 0, where the old `20 + …` kept the board glowing.) */
const spectrum: EffectRenderer = (_k, p) =>
  `hsl(${p.phase * 360}, 90%, ${Math.round(52 * bf(p))}%)`;

/**
 * A wave travelling along one axis.
 *
 * In rainbow mode that is a hue sweep; with a colour chosen it is the same
 * motion expressed as brightness, because a "wave" in one colour still has to
 * be a wave. This used to be hue-only, so picking a colour did nothing at all
 * to the preview for Wave, Line Wave, Kaleidoscope and Circle Wave — all four
 * of which the vendor table marks colour-capable.
 */
const wave =
  (axis: 'x' | 'y', reverse = false): EffectRenderer =>
  (k, p) => {
    const raw = axis === 'x' ? nx(k, p) : ny(k, p);
    const pos = reverse ? 1 - raw : raw;
    if (p.rainbow)
      // `phase * 360 - pos * 300`, not `+`. With the signs the same way round
      // a band of one hue sat at `pos = (hue - phase*360)/300`, which DROPS as
      // the phase advances — so in rainbow mode the wave crawled backwards
      // while the single-colour branch below crawled forwards. Reported as
      // "direction Right, and your animation goes left"; it was the same
      // effect disagreeing with itself.
      return `hsl(${(((p.phase * 360 - pos * 300) % 360) + 360) % 360}, 90%, ${Math.round(52 * bf(p))}%)`;
    return tint(p, 0.12 + 0.88 * (0.5 + 0.5 * Math.sin((pos - p.phase) * 2 * Math.PI)));
  };

/**
 * Wave's four directions, as the vendor lists them: right, left, down, up.
 *
 * `reverse` flips which end the band starts from, which for a travelling band
 * is what "the other direction" means.
 */
const WAVE_DIRS = [wave('x'), wave('x', true), wave('y'), wave('y', true)] as const;
const waveDirected: EffectRenderer = (k, p) => (WAVE_DIRS[opt(p, 4)] ?? WAVE_DIRS[0])(k, p);

/**
 * Kaleidoscope — Spectrum Cycle, but the colour change starts at the centre
 * of the board and spreads outward rather than every key turning together.
 */
const kaleidoscope: EffectRenderer = (k, p) => {
  const dist = Math.hypot(nx(k, p) - 0.5, ny(k, p) - 0.5) / 0.71;
  // Outward / inward: the sign of the radial lag is the whole difference —
  // whether the colour change reaches the rim before the centre or after it.
  const t = p.phase + dist * (opt(p, 2) === 1 ? 0.45 : -0.45);
  if (p.rainbow) return `hsl(${(((t * 360) % 360) + 360) % 360}, 90%, ${Math.round(52 * bf(p))}%)`;
  return tint(p, 0.12 + 0.88 * (0.5 + 0.5 * Math.sin(t * 2 * Math.PI)));
};

/**
 * Sine Wave — most of the board dark, with a travelling sine curve picked out
 * in colour. Previously every key was lit, which made it indistinguishable
 * from Wave.
 */
const sineWave: EffectRenderer = (k, p) => {
  const x = nx(k, p);
  const y = ny(k, p);
  const curve = 0.5 + 0.42 * Math.sin(x * Math.PI * 2 - p.phase * Math.PI * 2);
  const on = clamp01(1 - Math.abs(y - curve) / 0.22);
  return on <= 0.02 ? dark() : tint(p, on, x);
};

/**
 * Snake — ONE bright segment with a trail, walking the rows: along the top
 * row, down one, back the other way, and so on to the bottom, with every
 * other key dark.
 *
 * It used to give every row its own band, all sliding at once — six lines on
 * the real board, which is a wave with gaps, not a snake. A snake is a single
 * thing that is somewhere, and the dark board around it is most of the effect.
 */
const snake: EffectRenderer = (k, p) => {
  // Spiral: the same single segment winding out from the centre of the board
  // rather than running the rows. The vendor offers the two as options on one
  // effect, so they share a name and differ in path.
  if (opt(p, 2) === 1) {
    const dx = nx(k, p) - 0.5;
    const dy = ny(k, p) - 0.5;
    // Angle and radius together: a constant of `angle + radius` is a spiral,
    // and sweeping that constant is the band travelling along it. Scaled into
    // 0..1 over the whole board, NOT wrapped with `% 1`: wrapped, the sweep
    // lit one arm per turn of the spiral, three at once.
    const turn = (Math.atan2(dy, dx) / (2 * Math.PI) + 1) % 1;
    const r = Math.hypot(dx, dy) / 0.71;
    const on = band((turn + r * 1.5) / 2.5, p.phase, 0.06, 2.4);
    return on <= 0.02 ? dark() : tint(p, on, r);
  }
  // Rows sit a whole key unit apart (the real board's are at y = 0.02, 1.22,
  // … 5.22), so rounding buckets a key into its row and the bottom row's
  // index gives the count. The segment spends an equal share of the cycle in
  // each row and comes back the other way on the odd ones: a boustrophedon.
  const rowCount = Math.round(p.bounds.maxY) + 1;
  const pos = p.phase * rowCount;
  const active = Math.min(rowCount - 1, Math.max(0, Math.floor(pos)));
  if (Math.round(k.y) !== active) return dark();
  const along = clamp01(pos - active);
  // Mirroring the KEY on a right-to-left row, rather than the target, keeps
  // `band`'s trail behind the head whichever way it is going.
  const x = nx(k, p);
  const on = band(active % 2 === 1 ? 1 - x : x, along, 0.12, 2.2);
  // Hue along the row, so the trail is a gradient rather than one flat colour
  // — the same object the strip's Snake draws (`stripSnake`), on the board.
  return on <= 0.02 ? dark() : tint(p, on, x);
};

/** Meteor — one coloured line crossing left to right at a time. */
const meteor: EffectRenderer = (k, p) => {
  const at = p.phase * 1.25 - 0.15;
  // Hue by row, not by phase: keyed on the phase the whole line was one
  // colour at any instant, which in rainbow mode is a single-hue line.
  return tint(p, band(nx(k, p), at, 0.13, 3.2), ny(k, p));
};

/**
 * Line Wave / Train — Always On's layout sliding sideways.
 *
 * In rainbow mode it is EXACTLY Always On's 45° bands (`diag`), at full
 * brightness, shifted along x by the phase: Right moves the pattern toward
 * +x, Left toward -x. It used to be a brightness front that happened to carry
 * a hue per row, which is a different picture from the one the board shows.
 *
 * With a colour chosen there is no layout to slide, so the motion is a broad
 * bright band travelling one way, no trail bias. The band is over half the
 * strip wide. It was 0.3, which on the real board is visibly wrong: most of
 * the keyboard was dark between passes, where the hardware keeps most of it
 * lit and moves a broad bright front across it.
 */
const lineWave =
  (directed = false): EffectRenderer =>
  (k, p) => {
    // Line Wave lists right/left; Train has no options and always runs right.
    const left = directed && opt(p, 2) === 1;
    if (p.rainbow)
      // A band of hue H sits where `diag = phase + H`, so subtracting the
      // phase moves every band toward +x as it advances; adding it, toward
      // -x. `drift: false` — the phase is already in the offset, and at phase
      // 0 this has to BE Always On.
      return tint(p, 1, diag(k, p) + (left ? p.phase : -p.phase), false);
    const raw = nx(k, p);
    const pos = left ? 1 - raw : raw;
    return tint(p, band(pos, p.phase, 0.55, 1.6), ny(k, p));
  };

/**
 * Raindrop ("Starlight") — random dots lighting up and fading at random
 * places. The old version hashed the key position into a fixed phase offset,
 * which made the same keys pulse in the same order every loop: a visible
 * pattern rather than randomness.
 */
const raindrop: EffectRenderer = (k, p) => {
  // Each key gets its own cycle length and start, both from its position, so
  // the drops never line up into a repeating figure.
  const seed = hash(Math.round(k.x * 3), Math.round(k.y * 3));
  const rate = 0.6 + seed * 1.9;
  const t = (p.phase * rate + seed * 7.3) % 1;
  // Short bright flash, long dark gap: sparse, like actual starlight.
  const on = t < 0.28 ? Math.sin((t / 0.28) * Math.PI) : 0;
  return on <= 0.02 ? dark() : tint(p, on, seed);
};

/**
 * Rain Down ("Snow Fall") — drops falling top to bottom, each with a trail.
 *
 * Reported as not working: the board looked black. Three things together did
 * that, and none of them was one drop too few. The trail was 0.42 of the
 * board — two rows of six — and its falloff was then SQUARED, so the second
 * row of every trail was already at a quarter brightness and the third was
 * gone. One drop per column meant that at any instant a column was lit for
 * about a third of the loop and dark for the rest. And the columns run at
 * different rates, so those dark stretches do not line up into anything: the
 * board just read as a few stray keys.
 *
 * Two drops per column half a loop apart, a trail of over half the board, and
 * a linear falloff. Same effect, actually visible.
 */
const RAIN_TRAIL = 0.55;
const rainDown: EffectRenderer = (k, p) => {
  const col = Math.round(k.x);
  const seed = hash(col, 3);
  const rate = 0.7 + seed * 1.2;
  const y = ny(k, p);
  let on = 0;
  for (const offset of [0, 0.5]) {
    // -0.15..1.15, so a drop enters above the board and leaves below it
    // rather than appearing in the top row and vanishing from the bottom.
    const head = (((p.phase * rate + seed + offset) % 1) + 1) % 1;
    const d = head * 1.3 - 0.15 - y;
    // Only BEHIND the head (above it on screen) — that is the trail.
    if (d >= 0) on = Math.max(on, clamp01(1 - d / RAIN_TRAIL));
  }
  return on <= 0.02 ? dark() : tint(p, on, seed);
};

/**
 * Converge ("Mountain Wave") — two blooms travel in from opposite corners,
 * meet and rotate at the centre, then leave the way they came.
 */
const converge: EffectRenderer = (k, p) => {
  const x = nx(k, p);
  const y = ny(k, p);
  // 0 -> in, 1 -> rotating at the centre, 2 -> out.
  const leg = p.phase * 2;
  const travel = leg < 1 ? leg : 2 - leg;
  const spin = leg < 1 ? 0 : (leg - 1) * Math.PI * 2;
  const ease = travel * travel * (3 - 2 * travel);
  const r = 0.16 * Math.max(0.35, 1 - ease);
  const cx = 0.5 + Math.cos(spin) * (0.5 - ease * 0.5);
  const cy = 0.5 + Math.sin(spin) * (0.5 - ease * 0.5);
  const a = clamp01(1 - Math.hypot(x - (1 - cx), y - (1 - cy)) / (r + 0.18));
  const b = clamp01(1 - Math.hypot(x - cx, y - cy) / (r + 0.18));
  const on = Math.max(a, b);
  // Two blooms, two base hues — plus a radial term, or each bloom would be a
  // flat disc of one colour.
  return on <= 0.02 ? dark() : tint(p, on, (a > b ? 0.05 : 0.55) + ny(k, p) * 0.3);
};

/**
 * Dazzling ("Colorful Cross") — every LED its own colour, all drifting to
 * other colours. Not a single hue cycling across the whole board.
 */
const dazzling: EffectRenderer = (k, p) => {
  const seed = hash(Math.round(k.x * 5), Math.round(k.y * 5));
  if (p.rainbow)
    return `hsl(${((seed + p.phase * 0.6) * 360) % 360}, 92%, ${Math.round(52 * bf(p))}%)`;
  // Given a single colour there is no "all different colours" to show, so the
  // per-key scatter becomes brightness instead — the same restlessness in one
  // hue. Turning dazzle on is what makes this the multicolour effect its name
  // describes.
  return tint(p, 0.2 + 0.8 * (0.5 + 0.5 * Math.sin((seed + p.phase * 0.6) * 2 * Math.PI)));
};

/** Press Ripple — a ring expanding from the struck key. */
const pressRipple: EffectRenderer = (k, p) => {
  const { x, y, age } = pressPoint(p);
  const d = Math.hypot(k.x - x, k.y - y) / (Math.hypot(p.bounds.maxX, p.bounds.maxY) || 1);
  const on = clamp01(1 - Math.abs(d - age * 0.9) / 0.16) * (1 - age);
  // Hue by radius, so the expanding ring is a rainbow ring. On `age` the whole
  // ring shared one hue at any instant.
  return on <= 0.02 ? dark() : tint(p, on, d);
};

/** Press Action ("Shadow") — only the struck key lights. */
const pressAction: EffectRenderer = (k, p) => {
  const { x, y, age } = pressPoint(p);
  const hit = Math.abs(k.x - x) < 0.6 && Math.abs(k.y - y) < 0.6;
  const on = hit ? 1 - age : 0;
  // One key lights at a time, so the hue has to come from WHERE it is —
  // otherwise every press was the same colour.
  return on <= 0.02 ? dark() : tint(p, on, diag(k, p));
};

/**
 * Press Action Off ("Snow Trace") — the inverse: the board holds a static
 * colour and the struck key goes dark for a moment.
 */
const pressActionOff: EffectRenderer = (k, p) => {
  const { x, y, age } = pressPoint(p);
  const hit = Math.abs(k.x - x) < 0.6 && Math.abs(k.y - y) < 0.6;
  // `drift: false`, so an untouched key is EXACTLY what Always On paints. It
  // drifted, which in rainbow mode slid the whole board through the spectrum
  // — the one thing this effect must not do, since the only motion in it is
  // supposed to be the key you just hit going out and coming back.
  return tint(p, hit ? Math.min(1, age * 1.6) : 1, diag(k, p), false);
};

/**
 * Press Laser ("Kill Two Birds") — light leaves the struck key to the left
 * AND to the right along its row.
 */
const pressLaser: EffectRenderer = (k, p) => {
  const { x, y, age } = pressPoint(p);
  if (Math.abs(k.y - y) > 0.7) return dark();
  const reach = age * (p.bounds.maxX || 1);
  const d = Math.abs(k.x - x);
  const on = clamp01(1 - Math.abs(d - reach) / 1.2) * (1 - age * 0.7);
  // Hue along the beam, so the two arms are a gradient rather than one colour.
  return on <= 0.02 ? dark() : tint(p, on, d / (p.bounds.maxX || 1));
};

/** Circle Wave — a ring sweeping out from the centre, continuously. */
const circleWave: EffectRenderer = (k, p) => {
  const dx = nx(k, p) - 0.5;
  const dy = ny(k, p) - 0.5;
  const d = Math.hypot(dx, dy) / 0.71;
  // The ring is the effect; the OPTION is which way it turns, so the ring
  // carries an angular lag whose sign the option picks. Without it the two
  // choices drew the identical expanding circle.
  const turn = (Math.atan2(dy, dx) / (2 * Math.PI) + 1) % 1;
  const lag = turn * 0.3 * (opt(p, 2) === 1 ? 1 : -1);
  const at = (((p.phase * 1.3 + lag) % 1) + 1) % 1;
  const on = clamp01(1 - Math.abs(d - at) / 0.22);
  return on <= 0.02 ? dark() : tint(p, on, d);
};

/**
 * Music (Level) — a level meter: bars rising and falling from the bottom of
 * the board, each column its own level.
 */
const musicLevel: EffectRenderer = (k, p) => {
  const col = Math.round(k.x);
  const seed = hash(col, 21);
  // Two detuned oscillators per column so neighbouring bars move together
  // roughly but never in lockstep, the way a spectrum actually behaves.
  const level =
    0.5 +
    0.32 * Math.sin((p.phase * 2 + seed) * 2 * Math.PI) +
    0.18 * Math.sin((p.phase * 5.3 + seed * 3) * 2 * Math.PI);
  const h = clamp01(level);
  const y = ny(k, p);
  // The vendor's three variants, which decide where a bar GROWS FROM.
  //   upright   — from the bottom of the board (y grows downward)
  //   separate  — from both edges toward the middle
  //   intersect — from the middle outward
  const mode = opt(p, 3);
  const filled =
    mode === 1
      ? y <= h / 2 || y >= 1 - h / 2
      : mode === 2
        ? Math.abs(y - 0.5) <= h / 2
        : y >= 1 - h;
  return filled ? tint(p, 1, y) : dark();
};

/** Music (Spectrum) — the same idea with a wider, smoother envelope. */
const musicSpectrum: EffectRenderer = (k, p) => {
  const x = nx(k, p);
  const level = 0.45 + 0.4 * Math.sin((p.phase + x * 0.8) * 2 * Math.PI);
  return ny(k, p) >= 1 - clamp01(level) ? tint(p, 1, x) : dark();
};

/** Screen Colour — the board takes one colour from the desktop. */
const screenColour: EffectRenderer = (_k, p) =>
  `hsl(${(p.phase * 90 + 200) % 360}, 55%, ${Math.round(50 * bf(p))}%)`;

/** Endless / fireworks — bursts at random points. */
const endless: EffectRenderer = (k, p) => {
  const { x, y, age } = pressPoint(p);
  const d = Math.hypot(k.x - x, k.y - y) / (Math.hypot(p.bounds.maxX, p.bounds.maxY) || 1);
  const on = clamp01(1 - d / (0.1 + age * 0.5)) * (1 - age);
  // A hue per burst, spread across the burst itself by its radius.
  return on <= 0.02 ? dark() : tint(p, on, hash(Math.floor(p.phase * 3), 5) + d);
};

// ---------------------------------------------------------------- the table

/**
 * Keyed on the vendor `id`, never the display label.
 *
 * Two of these labels have been corrected already ("Laser" -> "Press Laser",
 * "Ripple" -> "Press Ripple"), and a name-keyed table silently reclassifies an
 * effect the moment that happens — the id is the stable key.
 */
const RENDERERS: Record<string, EffectRenderer> = {
  LightOff: dark,
  LightAlwaysOn: alwaysOn,
  LightBreath: breath,
  LightNeon: spectrum,
  LightWave: waveDirected,
  LightRipple: pressRipple,
  LightRaindrop: raindrop,
  LightSnake: snake,
  LightPressAction: pressAction,
  LightConverage: converge,
  LightSineWave: sineWave,
  LightKaleidoscope: kaleidoscope,
  LightLineWave: lineWave(true),
  LightUserPicture: alwaysOn,
  LightLaser: pressLaser,
  LightCircleWave: circleWave,
  LightDazzing: dazzling,
  LightRainDown: rainDown,
  LightMeteor: meteor,
  LightPressActionOff: pressActionOff,
  LightMusicFollow3: musicSpectrum,
  LightScreenColor: screenColour,
  LightMusicFollow2: musicLevel,
  LightTrain: lineWave(),
  LightFireWorks: endless,
  LightUserColor: alwaysOn,
};

// ------------------------------------------------------- the side strip
/**
 * The side strip is not a short keyboard.
 *
 * It is one continuous diffused bar with far more emitters than a key row, so
 * an effect that is a per-key pattern on the board is a per-millimetre one
 * here. Only the effects that actually differ are listed; anything else falls
 * through to the board's own renderer, which is right for Breath (the whole
 * bar pulsing) and Spectrum Cycle (the whole bar one hue) and close enough
 * for Wave.
 *
 * Both entries below are from watching the hardware, not from a capture:
 * `provenance: inferred`, like everything else in this file.
 */

/** How many times the spectrum repeats along the bar. Counted off the strip. */
const STRIP_REPEATS = 6;

/**
 * Always On, on the strip — the spectrum repeated along the bar.
 *
 * Not one gradient end to end, which is what it drew while it shared the
 * board's renderer: the strip packs several full colour cycles into its
 * length. With a colour chosen there is nothing to repeat and the whole bar
 * is that colour, which is what Always On means.
 */
const stripAlwaysOn: EffectRenderer = (k, p) => {
  if (!p.rainbow) return tint(p, 1);
  const hue = (((nx(k, p) * STRIP_REPEATS * 360) % 360) + 360) % 360;
  return `hsl(${hue}, 92%, ${Math.round(52 * bf(p))}%)`;
};

/**
 * Snake, on the strip — ONE point of light crossing it, slowly.
 *
 * The board's Snake slides whole rows back and forth, which on a bar came out
 * as the entire strip lit the whole time. What the hardware does is a single
 * bright dot running end to end, and the dark bar around it is most of the
 * effect.
 */
const stripSnake: EffectRenderer = (k, p) => {
  const on = band(nx(k, p), p.phase, 0.05, 2.2);
  return on <= 0.02 ? dark() : tint(p, on, nx(k, p));
};

const STRIP_RENDERERS: Record<string, EffectRenderer> = {
  LightAlwaysOn: stripAlwaysOn,
  LightSnake: stripSnake,
};

/** Effects with nothing to animate — the pane hides the speed control and
 *  says the preview shows colour and brightness only. */
const STATIC_IDS = new Set(['LightOff', 'LightAlwaysOn', 'LightUserPicture', 'LightUserColor']);

const idOf = (label: string): string | undefined =>
  KB_LIGHT_EFFECTS_TABLE.find((e) => e.label === label)?.id;

export function isStaticEffect(label: string): boolean {
  const id = idOf(label);
  return !id || STATIC_IDS.has(id);
}

/** Colour for one key of one effect at the current phase. */
export function effectColor(label: string, k: KeyLike, p: PreviewParams): string {
  const id = idOf(label);
  const render =
    (id && p.strip ? STRIP_RENDERERS[id] : undefined) ??
    (id ? RENDERERS[id] : undefined) ??
    alwaysOn;
  return render(k, p);
}
