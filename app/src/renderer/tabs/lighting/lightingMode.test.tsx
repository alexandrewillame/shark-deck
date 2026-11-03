import { act, renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { KB_LIGHT_EFFECTS, KB_PERKEY_EFFECT_INDEX } from '@shared/lighting';
import type { LightingSettings } from '@shared/types/lighting';
import {
  derivedLightingMode,
  GLOBAL_FALLBACK_EFFECT,
  GLOBAL_PICKER_EFFECTS,
  globalPickerList,
  seedGlobalDraft,
  useLightingMode,
} from './lightingMode';

/**
 * The reported bug: on profile 1 with per-key lighting, loading profile 2
 * (which has a global effect) left the tab on per-key — and applying anything
 * from there stamped profile 1's picture onto profile 2 and flipped the board
 * to the per-key layer. The cause was a one-time latch that never re-derived
 * the mode from a later read.
 */

const at = (effect: string): LightingSettings[] => [{ effect } as LightingSettings];
const PERKEY = KB_LIGHT_EFFECTS[KB_PERKEY_EFFECT_INDEX];

describe('derivedLightingMode', () => {
  it('reads the mode off the wire index, not the label', () => {
    expect(derivedLightingMode(at(PERKEY))).toBe('perkey');
    expect(derivedLightingMode(at(KB_LIGHT_EFFECTS[0]))).toBe('global');
    expect(derivedLightingMode([])).toBeNull();
  });
});

describe('useLightingMode', () => {
  it('follows the device when a new read lands', () => {
    const perkey = at(PERKEY);
    const { result, rerender } = renderHook(({ loaded }) => useLightingMode(loaded, true), {
      initialProps: { loaded: perkey },
    });
    expect(result.current.mode).toBe('perkey');

    // A profile switch: the panes remount and re-read, and this read says the
    // newly selected slot is on a global effect.
    rerender({ loaded: at(KB_LIGHT_EFFECTS[0]) });
    expect(result.current.mode, 'a later read must re-derive the mode').toBe('global');
  });

  it('keeps an in-tab selection until the next read', () => {
    const globalRead = at(KB_LIGHT_EFFECTS[0]);
    const { result, rerender } = renderHook(({ loaded }) => useLightingMode(loaded, true), {
      initialProps: { loaded: globalRead },
    });

    // Navigating to per-key writes nothing, so the device still reports
    // global — the choice has to stick anyway.
    act(() => result.current.setMode('perkey'));
    expect(result.current.mode).toBe('perkey');
    rerender({ loaded: globalRead });
    expect(result.current.mode, 'a re-render is not a re-read').toBe('perkey');

    rerender({ loaded: at(KB_LIGHT_EFFECTS[0]) });
    expect(result.current.mode, 'a fresh read outranks the stale choice').toBe('global');
  });

  it('is always global on a board with no per-key lighting', () => {
    const { result } = renderHook(() => useLightingMode(at(PERKEY), false));
    expect(result.current.mode).toBe('global');
  });
});

/**
 * Going from Per-Key to Global previewed the per-key entry — a rainbow that
 * reads as "Wave" — while no effect tile was selected. The editor now seeds
 * from something the picker can show, and the picker can show what it seeds.
 */
describe('the Global editor seed', () => {
  const read = (effect: string): LightingSettings =>
    ({
      zone: 'keyboard',
      effect,
      brightness: 75,
      speed: 50,
      color: [1, 2, 3],
      enabled: true,
    }) as LightingSettings;
  const labels = (l: readonly { label: string }[]) => l.map((e) => e.label);

  it('falls back to Always On, with its remembered colour, when the board is on per-key', () => {
    const d = seedGlobalDraft(read(PERKEY), null, { color: [9, 9, 9] });
    expect(d.effect).toBe(GLOBAL_FALLBACK_EFFECT);
    expect(d.color).toEqual([9, 9, 9]);
    expect(labels(globalPickerList(d.effect))).toContain(d.effect);
  });

  it('keeps the effect being edited when the board is on per-key', () => {
    const breath = read('Breath');
    expect(seedGlobalDraft(read(PERKEY), breath, undefined)).toBe(breath);
  });

  it('follows the board when it is on a pickable effect', () => {
    expect(seedGlobalDraft(read('Wave'), read('Breath'), undefined).effect).toBe('Wave');
  });

  it('offers a real effect the list leaves out, when the board is on it', () => {
    expect(labels(GLOBAL_PICKER_EFFECTS)).not.toContain('Train');
    const d = seedGlobalDraft(read('Train'), null, undefined);
    expect(d.effect).toBe('Train');
    expect(labels(globalPickerList('Train'))).toContain('Train');
  });

  it('never offers the per-key layer as a Global effect', () => {
    expect(labels(globalPickerList(PERKEY))).not.toContain(PERKEY);
  });
});
