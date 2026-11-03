import { parseCssColor } from '../colorUtil';

/** A colour as a shader takes it: three channels, 0..1. */
export type Rgb = [number, number, number];

/**
 * The theme, as the background needs it: the palette's two colours, the page
 * it is drawn over, and which way round light goes.
 *
 * Read from the stylesheet rather than from a table of its own. tokens.css is
 * the one place a palette's colours live — `--accent-rgb` and `--violet-rgb`
 * (the "secondary accent", violet only in shark-cyan) are already the decimal
 * triplets for exactly this kind of use — so a palette added or retuned there
 * reaches the background with nothing to keep in step.
 */
export interface BgPalette {
  accent: Rgb;
  secondary: Rgb;
  /** `--bg`, the page colour every effect is drawn over. */
  base: Rgb;
  light: boolean;
}

const FALLBACK: BgPalette = {
  accent: [61 / 255, 248 / 255, 232 / 255],
  secondary: [139 / 255, 125 / 255, 1],
  base: [10 / 255, 12 / 255, 16 / 255],
  light: false,
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

/** Any CSS colour the stylesheet uses for `--bg` -> 0..1 channels. */
export function parseColor(s: string): Rgb | null {
  const rgb = parseCssColor(s);
  return rgb ? (rgb.map((n) => n / 255) as Rgb) : null;
}

/** The palette as the page is showing it right now. */
export function readPalette(root: HTMLElement = document.documentElement): BgPalette {
  const css = getComputedStyle(root);
  return {
    accent: parseTriplet(css.getPropertyValue('--accent-rgb')) ?? FALLBACK.accent,
    secondary: parseTriplet(css.getPropertyValue('--violet-rgb')) ?? FALLBACK.secondary,
    base: parseColor(css.getPropertyValue('--bg')) ?? FALLBACK.base,
    light: root.dataset.mode === 'light',
  };
}

const mixRgb = (a: Rgb, b: Rgb, t: number): Rgb =>
  [0, 1, 2].map((i) => a[i]! + (b[i]! - a[i]!) * t) as Rgb;

/**
 * Part of the way from one palette to the next — the background's half of the
 * theme cross-fade (`.theme-anim`): the tokens change at once, so without this
 * the canvas would snap while the panels in front of it fade.
 */
export function mixPalette(a: BgPalette, b: BgPalette, t: number): BgPalette {
  const k = Math.min(1, Math.max(0, t));
  return {
    accent: mixRgb(a.accent, b.accent, k),
    secondary: mixRgb(a.secondary, b.secondary, k),
    base: mixRgb(a.base, b.base, k),
    light: k < 0.5 ? a.light : b.light,
  };
}

export const samePalette = (a: BgPalette, b: BgPalette): boolean =>
  a.light === b.light &&
  (['accent', 'secondary', 'base'] as const).every((k) =>
    a[k].every((v, i) => Math.abs(v - b[k][i]!) < 1e-4),
  );
