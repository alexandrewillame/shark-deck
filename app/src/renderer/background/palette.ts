import { parseCssColor } from '../colorUtil';

/** A colour as a shader takes it: three channels, 0..1. */
export type Rgb = [number, number, number];

/**
 * The theme, as the background needs it: the palette's two colours, the night
 * page and the day page, and which of the two is showing.
 *
 * The two colours are the dark theme's in both themes. A light theme is the
 * same scene in daylight (shaders/effects.ts: every effect re-lights its own
 * fields), and it is lit in the same vivid colours the night glows in — the
 * light theme's own accents are darkened for text on white, which is not what
 * a background needs.
 *
 * Read from the stylesheet rather than from a table of its own. tokens.css is
 * the one place a palette's colours live, and its `--night-*` tokens are the
 * dark theme's page and accent triplets under names the light theme leaves
 * alone — so a palette added or retuned there reaches the background, in
 * either theme, with nothing to keep in step.
 */
export interface BgPalette {
  /** `--night-accent-rgb`. */
  accent: Rgb;
  /** `--night-violet-rgb`, the "secondary accent" (violet only in shark-cyan). */
  secondary: Rgb;
  /** `--night-bg`, the page every effect glows over at night. */
  base: Rgb;
  /** 1 in the light theme. A number so the theme cross-fade can carry it. */
  light: number;
  /** `--bg` of the light theme: the page a daylight scene is drawn over. */
  day: Rgb;
}

const FALLBACK: BgPalette = {
  accent: [61 / 255, 248 / 255, 232 / 255],
  secondary: [139 / 255, 125 / 255, 1],
  base: [10 / 255, 12 / 255, 16 / 255],
  light: 0,
  day: [245 / 255, 247 / 255, 251 / 255],
};

/** `"61, 248, 232"` (a `--*-rgb` token) -> 0..1 channels. */
export function parseTriplet(s: string): Rgb | null {
  const p = s
    .split(/[,\s]+/)
    .filter(Boolean)
    .map(Number);
  if (p.length !== 3 || p.some((n) => !Number.isFinite(n))) return null;
  return p.map((n) => Math.min(1, Math.max(0, n / 255))) as Rgb;
}

/** Any CSS colour the stylesheet uses for `--night-bg` -> 0..1 channels. */
export function parseColor(s: string): Rgb | null {
  const rgb = parseCssColor(s);
  return rgb ? (rgb.map((n) => n / 255) as Rgb) : null;
}

/**
 * The palette as the page is showing it. The light page is read only in the
 * light theme, where `--bg` is it; in the dark one the default stands in,
 * which is what a cross-fade toward light starts from anyway.
 */
export function readPalette(
  css: Pick<CSSStyleDeclaration, 'getPropertyValue'> = getComputedStyle(document.documentElement),
  mode: string | undefined = document.documentElement.dataset.mode,
): BgPalette {
  const light = mode === 'light';
  return {
    accent: parseTriplet(css.getPropertyValue('--night-accent-rgb')) ?? FALLBACK.accent,
    secondary: parseTriplet(css.getPropertyValue('--night-violet-rgb')) ?? FALLBACK.secondary,
    base: parseColor(css.getPropertyValue('--night-bg')) ?? FALLBACK.base,
    light: light ? 1 : 0,
    day: (light && parseColor(css.getPropertyValue('--bg'))) || FALLBACK.day,
  };
}

const mixRgb = (a: Rgb, b: Rgb, t: number): Rgb =>
  [0, 1, 2].map((i) => a[i]! + (b[i]! - a[i]!) * t) as Rgb;

/**
 * Part of the way from one palette to the next — the background's half of the
 * theme cross-fade (`.theme-anim`): the tokens change at once, so without
 * this the canvas would snap while the panels in front of it fade. Night
 * turns to day halfway through (`uLight > 0.5` in each effect).
 */
export function mixPalette(a: BgPalette, b: BgPalette, t: number): BgPalette {
  const k = Math.min(1, Math.max(0, t));
  return {
    accent: mixRgb(a.accent, b.accent, k),
    secondary: mixRgb(a.secondary, b.secondary, k),
    base: mixRgb(a.base, b.base, k),
    light: a.light + (b.light - a.light) * k,
    day: mixRgb(a.day, b.day, k),
  };
}

export const samePalette = (a: BgPalette, b: BgPalette): boolean =>
  Math.abs(a.light - b.light) < 1e-4 &&
  (['accent', 'secondary', 'base', 'day'] as const).every((k) =>
    a[k].every((v, i) => Math.abs(v - b[k][i]!) < 1e-4),
  );
