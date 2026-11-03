/**
 * Perceptual colour distance, for the tests that assert two colours are
 * telling apart.
 *
 * Distance is measured in CIE Lab, not in the hex or HSL the colours are
 * written in. The difference is the whole point: `#f4562e` and `#ff3131` are
 * 12 degrees of hue apart and look like one colour, while two greens 12
 * degrees apart look like two greens. Only Lab says so.
 *
 * Shared by `useKeyGroups`' swatch grid (groupPalette.test.ts) and the eleven
 * accent palettes in tokens.css (palette-distance.test.ts), which had the same
 * bug for the same reason and were each about to grow their own copy of this.
 */

export type Rgb = [number, number, number];

export const hexToRgbTuple = (h: string): Rgb =>
  [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16)) as Rgb;

/** HSL as CSS means it, since that is how the group swatches are written. */
export const hslToRgb = (h: number, s: number, l: number): Rgb => {
  const S = s / 100;
  const L = l / 100;
  const k = (n: number) => (n + h / 30) % 12;
  const a = S * Math.min(L, 1 - L);
  const f = (n: number) => L - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return [f(0) * 255, f(8) * 255, f(4) * 255];
};

export const toLab = ([r, g, b]: Rgb): Rgb => {
  const lin = (c: number) => {
    const v = c / 255;
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  const [R, G, B] = [lin(r), lin(g), lin(b)];
  const f = (t: number) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  const x = f((R * 0.4124 + G * 0.3576 + B * 0.1805) / 0.95047);
  const y = f(R * 0.2126 + G * 0.7152 + B * 0.0722);
  const z = f((R * 0.0193 + G * 0.1192 + B * 0.9505) / 1.08883);
  return [116 * y - 16, 500 * (x - y), 200 * (y - z)];
};

/** CIE76. Coarse, but far closer to "do these look the same" than RGB. */
export const deltaE = (a: Rgb, b: Rgb): number => {
  const [l1, a1, b1] = toLab(a);
  const [l2, a2, b2] = toLab(b);
  return Math.hypot(l1 - l2, a1 - a2, b1 - b2);
};

/** Same, for two `#rrggbb` strings. */
export const deltaEHex = (a: string, b: string): number =>
  deltaE(hexToRgbTuple(a), hexToRgbTuple(b));
