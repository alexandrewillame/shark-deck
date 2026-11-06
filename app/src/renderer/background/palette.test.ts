import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  mixPalette,
  parseColor,
  parseTriplet,
  readPalette,
  samePalette,
  type BgPalette,
  type Rgb,
} from './palette';

describe('reading the palette from the stylesheet', () => {
  it('reads a `--*-rgb` triplet as 0..1 channels', () => {
    expect(parseTriplet(' 61, 248, 232')).toEqual([61 / 255, 248 / 255, 232 / 255]);
    expect(parseTriplet('255 0 0')).toEqual([1, 0, 0]);
  });

  it('refuses anything that is not three numbers', () => {
    expect(parseTriplet('')).toBeNull();
    expect(parseTriplet('1, 2')).toBeNull();
    expect(parseTriplet('red, green, blue')).toBeNull();
  });

  it('reads `--night-bg` however the stylesheet writes it', () => {
    expect(parseColor(' #0a0c10')).toEqual([10 / 255, 12 / 255, 16 / 255]);
    expect(parseColor('rgb(255, 0, 0)')).toEqual([1, 0, 0]);
    expect(parseColor('var(--x)')).toBeNull();
  });
});

describe('the night colours, in either theme', () => {
  // <html> in the light theme: the plain tokens are the light ones, the
  // night ones are still the dark theme's.
  const tokens: Record<string, string> = {
    '--night-accent-rgb': ' 61, 248, 232',
    '--night-violet-rgb': ' 139, 125, 255',
    '--night-bg': ' #0a0c10',
    '--accent-rgb': ' 11, 182, 168',
    '--violet-rgb': ' 109, 92, 255',
    '--bg': ' #eef1f6',
  };
  const css = { getPropertyValue: (n: string) => tokens[n] ?? '' };

  it('light a daylight scene too, over the light theme’s own page', () => {
    expect(readPalette(css, 'light')).toEqual({
      accent: [61 / 255, 248 / 255, 232 / 255],
      secondary: [139 / 255, 125 / 255, 1],
      base: [10 / 255, 12 / 255, 16 / 255],
      light: 1,
      day: [0xee / 255, 0xf1 / 255, 0xf6 / 255],
    });
  });

  it('are the night itself in the dark theme, where `--bg` is the night page', () => {
    const night = readPalette(css, 'dark');
    expect(night.light).toBe(0);
    expect(night.accent).toEqual([61 / 255, 248 / 255, 232 / 255]);
    // The dark theme's `--bg` is no day page: the default stands in.
    expect(night.day).toEqual([245 / 255, 247 / 255, 251 / 255]);
  });

  // tokens.css keeps them. A palette that set `--accent-rgb` in its dark block
  // the old way would still look right in the dark theme's panels — and draw
  // its background in shark cyan, in both themes.
  const CSS = readFileSync(resolve(__dirname, '../styles/tokens.css'), 'utf8');
  const blocks = [...CSS.matchAll(/^(:root[^{\n]*)\{([^}]*)\}/gm)].map((m) => ({
    sel: m[1]!.trim(),
    body: m[2]!,
  }));
  const NIGHT = ['--night-bg', '--night-accent-rgb', '--night-violet-rgb'];

  it('are set once for the default palette, and the plain tokens follow them', () => {
    const root = blocks.find((b) => b.sel === ':root')!;
    for (const n of NIGHT) expect(root.body, n).toMatch(new RegExp(`\\n\\s*${n}:`));
    for (const plain of ['--bg', '--accent-rgb', '--violet-rgb']) {
      expect(root.body, plain).toMatch(
        new RegExp(`\\n\\s*${plain}: var\\(--night-${plain.slice(2)}\\);`),
      );
    }
  });

  it('are set by every palette in its both-themes block, never by a theme', () => {
    const palettes = blocks.filter((b) => /^:root\[data-palette='[a-z-]+'\]$/.test(b.sel));
    expect(palettes).toHaveLength(13);
    for (const p of palettes) {
      expect(p.body, p.sel).toMatch(/--night-accent-rgb:/);
      expect(p.body, p.sel).toMatch(/--night-violet-rgb:/);
      expect(p.body, p.sel).not.toMatch(/\n\s*--(accent|violet)-rgb:/);
    }
    for (const b of blocks.filter((b) => b.sel.includes('data-mode'))) {
      expect(b.body, b.sel).not.toMatch(/--night-/);
      if (b.sel.includes(':not(')) expect(b.body, b.sel).not.toMatch(/\n\s*--bg:/);
    }
  });
});

describe('the cross-fade', () => {
  const day: Rgb = [1, 1, 1];
  const from: BgPalette = {
    accent: [0, 1, 0],
    secondary: [0, 0, 1],
    base: [0, 0, 0],
    light: 0,
    day,
  };
  const to: BgPalette = {
    accent: [1, 0, 0],
    secondary: [1, 1, 0],
    base: [0.2, 0.2, 0.2],
    light: 1,
    day: [0.9, 0.9, 0.9],
  };

  it('runs from one palette to the next, and clamps', () => {
    expect(mixPalette(from, to, 0)).toEqual(from);
    expect(mixPalette(from, to, 1)).toEqual(to);
    expect(mixPalette(from, to, 0.5).accent).toEqual([0.5, 0.5, 0]);
    expect(mixPalette(from, to, 3)).toEqual(to);
  });

  it('carries night into day as a number, for the shaders to turn halfway', () => {
    expect(mixPalette(from, to, 0.25).light).toBe(0.25);
  });

  it('knows when nothing changed', () => {
    expect(samePalette(from, { ...from })).toBe(true);
    expect(samePalette(from, to)).toBe(false);
    expect(samePalette(from, { ...from, light: 1 })).toBe(false);
  });
});
