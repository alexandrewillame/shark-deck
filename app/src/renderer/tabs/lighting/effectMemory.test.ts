import { describe, expect, it } from 'vitest';
import type { AppSettings } from '@shared/types/app-settings';
import type { LightingPreset } from '@shared/types/app-settings';
import type { LightingSettings } from '@shared/types/lighting';
import { applyPreset, presetKey, presetOf, recallPreset } from './effectMemory';

/**
 * Per-effect memory. The board holds one effect with one set of parameters, so
 * without this, tuning Wave and then trying Breath lost the Wave settings.
 */
const base: LightingSettings = {
  zone: 'keyboard',
  effect: 'Wave',
  brightness: 100,
  speed: 75,
  color: [255, 0, 0],
  enabled: true,
  option: 2,
};

describe('per-effect lighting memory', () => {
  it('keys on the vendor effect id, not the display label', () => {
    // Two labels have already been corrected once. A label key would have
    // orphaned every setting stored under the old name.
    expect(presetKey('r85he', 'keyboard', 'Press Ripple')).toBe('r85he/keyboard/LightRipple');
    expect(presetKey('r85he', 'keyboard', 'Wave')).toBe('r85he/keyboard/LightWave');
  });

  it('restores an effect its own remembered parameters', () => {
    const settings = {
      lightingPresets: {
        'r85he/keyboard/LightBreath': { brightness: 25, speed: 50, color: [0, 255, 0] },
      },
    } as unknown as AppSettings;
    const next = applyPreset(base, 'Breath', recallPreset(settings, 'r85he', 'keyboard', 'Breath'));
    expect(next.effect).toBe('Breath');
    expect(next.brightness).toBe(25);
    expect(next.color).toEqual([0, 255, 0]);
  });

  it('inherits the current values for an effect never set before', () => {
    // Picking an effect for the first time should behave exactly as it did
    // before this existed, not jump to some invented default.
    const next = applyPreset(base, 'Snake', undefined);
    expect(next.brightness).toBe(base.brightness);
    expect(next.speed).toBe(base.speed);
    expect(next.color).toEqual(base.color);
  });

  it('does not carry a direction index across effects', () => {
    // Option lists differ in length between effects, so slot 2 of one may not
    // exist on another.
    expect(applyPreset(base, 'Snake', undefined).option).toBe(0);
  });

  it('round-trips what it stores', () => {
    expect(applyPreset(base, 'Wave', presetOf(base))).toEqual(base);
  });
});

/**
 * The reported bug: "Circle Wave, Dazzling and Rain Down go black when I
 * apply them, and changing the colour makes no difference".
 *
 * It was not the firmware — a hardware sweep showed the board accepting all
 * three indices and reading them back unchanged. It was this module: those
 * three effects, and only those three, had a remembered brightness of 0 in
 * settings.json. Picking one restored 0, Apply wrote wire 0, board dark.
 * Colour and colour mode are different bytes, so neither helped.
 */
describe('a remembered brightness of zero', () => {
  const zeroed: LightingPreset = { brightness: 0, speed: 50, color: [1, 2, 3], dazzle: true };
  const at75: LightingSettings = { ...base, brightness: 75 };

  it('is never stored', () => {
    expect(presetOf({ ...at75, brightness: 0 }).brightness).toBeUndefined();
    // Every other level still is — 0 is the only one that is a trap.
    expect(presetOf({ ...at75, brightness: 25 }).brightness).toBe(25);
  });

  it('is ignored when one is already on disk, so it heals itself', () => {
    // No migration: the next time the effect is picked, the zero is dropped
    // and the current brightness carries over as it would for a new effect.
    expect(applyPreset(at75, 'Dazzling', zeroed).brightness).toBe(75);
    // …and everything else the preset remembers still applies.
    expect(applyPreset(at75, 'Dazzling', zeroed).color).toEqual([1, 2, 3]);
    expect(applyPreset(at75, 'Dazzling', zeroed).dazzle).toBe(true);
  });

  it('still lets you set the board to zero right now', () => {
    // Brightness 0 is a real wire value and the slider offers it. What must
    // not happen is it being remembered as this effect's own setting.
    expect(applyPreset({ ...at75, brightness: 0 }, 'Dazzling', undefined).brightness).toBe(0);
  });
});
