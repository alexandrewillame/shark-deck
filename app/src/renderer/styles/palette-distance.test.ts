import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { deltaEHex } from '../../../test/lib/colorDistance';

/**
 * The fourteen accent palettes have to be telling apart, and "crimson" proved
 * that reading the hex is not enough to know whether they are.
 *
 * Crimson shipped at `#f4562e` and red at `#ff3131`: 12 degrees of hue, the
 * same saturation, the same lightness, and 15.9 deltaE. A comment in
 * tokens.css records that crimson had ALREADY been moved once to fix exactly
 * this, from ~350 degrees to ~12, and it was still reported as
 * indistinguishable - because the move was along the one axis that had no
 * room left. Nothing caught either the original or the failed fix.
 *
 * So the distances are measured here, from tokens.css itself rather than from
 * a duplicated list, in both modes. A palette added or retuned without a look
 * at its neighbours fails here instead of being reported months later.
 */

const CSS = readFileSync(resolve(__dirname, 'tokens.css'), 'utf8');

/** `--accent` out of one `:root…{}` block. */
const accentOf = (block: string) => /--accent:\s*(#[0-9a-f]{6})/i.exec(block)?.[1];

function accents(mode: 'dark' | 'light'): Record<string, string> {
  const out: Record<string, string> = {};
  // Shark cyan is the default palette, so it has no [data-palette] block of
  // its own - it lives in the bare `:root` (and `:root[data-mode='light']`).
  const base =
    mode === 'dark'
      ? /:root\s*\{([\s\S]*?)\n\}/.exec(CSS)
      : /:root\[data-mode='light'\]\s*\{([\s\S]*?)\n\}/.exec(CSS);
  const baseAccent = base && accentOf(base[1]!);
  if (baseAccent) out['shark-cyan'] = baseAccent;

  const block = /:root(\[data-mode='light'\])?\[data-palette='([a-z-]+)'\]\s*\{([^}]*)\}/g;
  for (const m of CSS.matchAll(block)) {
    if (!!m[1] !== (mode === 'light')) continue;
    const accent = accentOf(m[3]!);
    if (accent) out[m[2]!] = accent;
  }
  return out;
}

/**
 * Below this, two accents side by side in the Appearance menu read as the
 * same swatch. Matches `MIN_HUE_DE` in the key-group palette's own test,
 * which was arrived at the same way and for the same reason.
 */
const MIN_ACCENT_DE = 28;

/**
 * Black-White, Grey and Grey-brown are the *neutral* palettes: being close to
 * one another in Lab is what makes them neutrals, and pushing them apart
 * would mean giving one of them a hue it is not supposed to have. They are
 * told apart by warmth and by their names, not by distance, so they are only
 * exempt from EACH OTHER - each still has to stay clear of every chromatic
 * palette.
 */
const NEUTRALS = new Set(['black', 'grey', 'grey-brown']);
const bothNeutral = (a: string, b: string) => NEUTRALS.has(a) && NEUTRALS.has(b);

describe.each(['dark', 'light'] as const)('the %s accent palettes', (mode) => {
  const byName = accents(mode);
  const names = Object.keys(byName);

  it('are all fourteen, and all parsed', () => {
    expect(names).toHaveLength(14);
    expect(names).toContain('crimson');
    expect(names).toContain('red');
  });

  it('are each far enough from every other to be told apart', () => {
    const tooClose: string[] = [];
    for (let i = 0; i < names.length; i++) {
      for (let j = i + 1; j < names.length; j++) {
        const [a, b] = [names[i]!, names[j]!];
        if (bothNeutral(a, b)) continue;
        const d = deltaEHex(byName[a]!, byName[b]!);
        if (d < MIN_ACCENT_DE) {
          tooClose.push(`${a} ${byName[a]} vs ${b} ${byName[b]} — ${d.toFixed(1)} ΔE`);
        }
      }
    }
    expect(tooClose).toEqual([]);
  });

  // The reported bug, called out by name so a regression says so directly
  // rather than as one line in the sweep above.
  it('keep crimson and red distinct', () => {
    expect(deltaEHex(byName['crimson']!, byName['red']!)).toBeGreaterThan(MIN_ACCENT_DE);
  });
});
