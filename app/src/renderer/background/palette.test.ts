import { describe, expect, it } from 'vitest';
import { mixPalette, parseColor, parseTriplet, samePalette, type BgPalette } from './palette';

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

  it('reads `--bg` however the stylesheet writes it', () => {
    expect(parseColor(' #0a0c10')).toEqual([10 / 255, 12 / 255, 16 / 255]);
    expect(parseColor('rgb(255, 0, 0)')).toEqual([1, 0, 0]);
    expect(parseColor('var(--x)')).toBeNull();
  });
});

describe('the cross-fade', () => {
  const dark: BgPalette = {
    accent: [0, 1, 0],
    secondary: [0, 0, 1],
    base: [0, 0, 0],
    light: false,
  };
  const light: BgPalette = {
    accent: [1, 0, 0],
    secondary: [1, 1, 0],
    base: [1, 1, 1],
    light: true,
  };

  it('runs from one palette to the next', () => {
    expect(mixPalette(dark, light, 0)).toEqual(dark);
    expect(mixPalette(dark, light, 1)).toEqual(light);
    expect(mixPalette(dark, light, 0.5).accent).toEqual([0.5, 0.5, 0]);
  });

  it('turns the page light at the midpoint, and clamps', () => {
    expect(mixPalette(dark, light, 0.4).light).toBe(false);
    expect(mixPalette(dark, light, 0.6).light).toBe(true);
    expect(mixPalette(dark, light, 3)).toEqual(light);
  });

  it('knows when nothing changed', () => {
    expect(samePalette(dark, { ...dark })).toBe(true);
    expect(samePalette(dark, light)).toBe(false);
    expect(samePalette(dark, { ...dark, light: true })).toBe(false);
  });
});
