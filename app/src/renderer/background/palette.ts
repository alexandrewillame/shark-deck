import { parseCssColor } from '../colorUtil';

/** A colour as a shader takes it: three channels, 0..1. */
export type Rgb = [number, number, number];

/**
 * The theme, as the background needs it: the palette's two colours and the
 * page they are drawn over — always as the DARK theme has them. The background
 * is a night sky in both themes; the light theme lightens the panels in front
 * of it, not the sky (docs/design/background.md, "Light theme"). Painted onto
 * a light page, effects made of light could only be ink: faint, or muddy.
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
  /** `--night-bg`, the page colour every effect is drawn over. */
  base: Rgb;
}

const FALLBACK: BgPalette = {
  accent: [61 / 255, 248 / 255, 232 / 255],
  secondary: [139 / 255, 125 / 255, 1],
  base: [10 / 255, 12 / 255, 16 / 255],
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

/** The current palette's night colours — the same in either theme. */
export function readPalette(
  css: Pick<CSSStyleDeclaration, 'getPropertyValue'> = getComputedStyle(document.documentElement),
): BgPalette {
  return {
    accent: parseTriplet(css.getPropertyValue('--night-accent-rgb')) ?? FALLBACK.accent,
    secondary: parseTriplet(css.getPropertyValue('--night-violet-rgb')) ?? FALLBACK.secondary,
    base: parseColor(css.getPropertyValue('--night-bg')) ?? FALLBACK.base,
  };
}

const mixRgb = (a: Rgb, b: Rgb, t: number): Rgb =>
  [0, 1, 2].map((i) => a[i]! + (b[i]! - a[i]!) * t) as Rgb;

/**
 * Part of the way from one palette to the next — the background's half of the
 * palette cross-fade (`.theme-anim`): the tokens change at once, so without
 * this the canvas would snap while the panels in front of it fade. A light /
 * dark switch leaves the night colours as they are, so the sky stays put.
 */
export function mixPalette(a: BgPalette, b: BgPalette, t: number): BgPalette {
  const k = Math.min(1, Math.max(0, t));
  return {
    accent: mixRgb(a.accent, b.accent, k),
    secondary: mixRgb(a.secondary, b.secondary, k),
    base: mixRgb(a.base, b.base, k),
  };
}

export const samePalette = (a: BgPalette, b: BgPalette): boolean =>
  (['accent', 'secondary', 'base'] as const).every((k) =>
    a[k].every((v, i) => Math.abs(v - b[k][i]!) < 1e-4),
  );
