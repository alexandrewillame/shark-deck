import { describe, expect, it } from 'vitest';
import { BACKGROUND_EFFECTS } from '@shared/backgrounds';
import { en } from '@shared/i18n/en';
import { BACKGROUNDS, DRAWN_EFFECTS } from './registry';
import { COMMON } from './shaders/common';

/**
 * The backgrounds as the picker and the layer see them. Shaders cannot be
 * compiled here (no GPU in a unit test) — the scratch harness and a walk
 * through the app do that — but what can go wrong without one is pinned.
 */
describe('the background registry', () => {
  it('draws every background the settings file accepts, except none', () => {
    expect([...DRAWN_EFFECTS].sort()).toEqual(
      BACKGROUND_EFFECTS.filter((e) => e !== 'none').sort(),
    );
    for (const id of DRAWN_EFFECTS) expect(BACKGROUNDS[id].id).toBe(id);
  });

  it('names every one in the picker', () => {
    for (const id of DRAWN_EFFECTS) expect(en[BACKGROUNDS[id].labelKey]).toBeTruthy();
    expect(en['set.background.none']).toBeTruthy();
  });

  it('gives each one a main(), and its own natural colours for both kinds of page', () => {
    for (const id of DRAWN_EFFECTS) {
      const d = BACKGROUNDS[id];
      expect(d.frag, id).toMatch(/void main\(\)/);
      for (const pair of [d.natural.dark, d.natural.light]) {
        expect(pair).toHaveLength(2);
        for (const c of pair) for (const v of c) expect(v >= 0 && v <= 1, `${id} ${c}`).toBe(true);
      }
    }
  });

  it('keeps the frame rate and drawing scale where a background stays cheap', () => {
    // Every frame is also re-blurred behind every frosted panel.
    for (const id of DRAWN_EFFECTS) {
      const d = BACKGROUNDS[id];
      expect(d.fps, id).toBeLessThanOrEqual(30);
      expect(d.scale, id).toBeGreaterThan(0);
      expect(d.scale, id).toBeLessThanOrEqual(1);
    }
  });

  it('keeps every shader to plain ASCII, with no comments', () => {
    // WebGL implementations have rejected source outside the GLSL character
    // set, comments included — prose about a shader lives in the TypeScript.
    for (const src of [COMMON, ...DRAWN_EFFECTS.map((id) => BACKGROUNDS[id].frag)]) {
      expect(/^[\x09\x0a\x0d\x20-\x7e]*$/.test(src)).toBe(true);
      expect(src).not.toMatch(/\/\/|\/\*/);
    }
  });

  it('calls only helpers the shared header defines, and finishes every pixel', () => {
    const helpers = ['glow(', 'scene('];
    for (const id of DRAWN_EFFECTS) {
      const src = BACKGROUNDS[id].frag;
      expect(src, id).toContain('gl_FragColor = finish(');
      expect(
        helpers.some((h) => src.includes(h)),
        `${id} lands on the page through glow() or scene()`,
      ).toBe(true);
    }
  });
});
