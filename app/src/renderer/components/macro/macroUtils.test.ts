import { describe, expect, it } from 'vitest';
import type { MacroStep } from '@shared/types/macros';
import {
  canonicalSteps,
  encodedStepCount,
  fromGroups,
  groupsDuration,
  toGroups,
} from './macroUtils';

const round = (steps: MacroStep[]) => fromGroups(toGroups(steps));

// Usages are written in canonical form ("4" = A, "5" = B) wherever a test
// asserts an exact round-trip; the zero-padded spelling a device decode
// produces has its own block below.
describe('toGroups / fromGroups', () => {
  it('pairs an adjacent down/up of the same key into one tap', () => {
    const g = toGroups([
      { type: 'key', action: 'down', value: '4' },
      { type: 'key', action: 'up', value: '4' },
    ]);
    expect(g).toHaveLength(1);
    expect(g[0]!.kind).toBe('tap');
    expect(g[0]!.value).toBe('4');
    expect(g[0]!.holdMs).toBe(0);
  });

  it('reads the delay between a down and its up as the hold time, not a wait row', () => {
    const g = toGroups([
      { type: 'key', action: 'down', value: '4' },
      { type: 'delay', ms: 30 },
      { type: 'key', action: 'up', value: '4' },
    ]);
    expect(g).toHaveLength(1);
    expect(g[0]!.kind).toBe('tap');
    expect(g[0]!.holdMs).toBe(30);
  });

  it('gives the delay between two events a row of its own', () => {
    const g = toGroups([
      { type: 'key', action: 'down', value: '4' },
      { type: 'key', action: 'up', value: '4' },
      { type: 'delay', ms: 120 },
      { type: 'key', action: 'down', value: '5' },
      { type: 'key', action: 'up', value: '5' },
    ]);
    expect(g.map((x) => x.kind)).toEqual(['tap', 'wait', 'tap']);
    expect(g[1]!.ms).toBe(120);
  });

  it('merges consecutive delays into one wait row', () => {
    const g = toGroups([
      { type: 'delay', ms: 10 },
      { type: 'delay', ms: 20 },
      { type: 'key', action: 'down', value: '4' },
      { type: 'key', action: 'up', value: '4' },
    ]);
    expect(g.map((x) => x.kind)).toEqual(['wait', 'tap']);
    expect(g[0]!.ms).toBe(30);
  });

  it('keeps a pause the macro ends on', () => {
    const steps: MacroStep[] = [
      { type: 'key', action: 'down', value: '4' },
      { type: 'key', action: 'up', value: '4' },
      { type: 'delay', ms: 200 },
    ];
    expect(toGroups(steps).map((x) => x.kind)).toEqual(['tap', 'wait']);
    expect(round(steps)).toEqual(steps);
  });

  it('drops a 0 ms wait row rather than writing a 0 ms delay step', () => {
    expect(fromGroups(toGroups([{ type: 'delay', ms: 0 }]))).toEqual([]);
  });

  // The whole point of pairing is readability, so it must never merge two
  // different keys or an overlapping hold into one row.
  it('does not pair overlapping holds', () => {
    const steps: MacroStep[] = [
      { type: 'key', action: 'down', value: '4' },
      { type: 'key', action: 'down', value: '5' },
      { type: 'key', action: 'up', value: '4' },
      { type: 'key', action: 'up', value: '5' },
    ];
    const g = toGroups(steps);
    expect(g.map((x) => x.kind)).toEqual(['press', 'press', 'release', 'release']);
    expect(round(steps)).toEqual(steps);
  });

  it('does not pair a down with the up of a different key or a different type', () => {
    expect(
      toGroups([
        { type: 'key', action: 'down', value: '4' },
        { type: 'key', action: 'up', value: '5' },
      ]).map((x) => x.kind),
    ).toEqual(['press', 'release']);

    expect(
      toGroups([
        { type: 'key', action: 'down', value: 1 },
        { type: 'mouse', action: 'up', value: 1 },
      ]).map((x) => x.kind),
    ).toEqual(['press', 'release']);
  });

  it('round-trips a recorded-shape step list unchanged', () => {
    const steps: MacroStep[] = [
      { type: 'key', action: 'down', value: 'e1' },
      { type: 'delay', ms: 40 },
      { type: 'key', action: 'up', value: 'e1' },
      { type: 'delay', ms: 150 },
      { type: 'mouse', action: 'down', value: 1 },
      { type: 'mouse', action: 'up', value: 1 },
    ];
    expect(round(steps)).toEqual(steps);
  });

  // The dirty check compares both sides in canonical form (macroEquals), so a
  // second pass must not keep rewriting the list.
  it('canonicalises idempotently', () => {
    const steps: MacroStep[] = [
      { type: 'delay', ms: 25 },
      { type: 'key', action: 'down', value: '04' },
      { type: 'delay', ms: 12 },
      { type: 'key', action: 'up', value: '4' },
      { type: 'delay', ms: 90 },
    ];
    const once = canonicalSteps(steps);
    expect(canonicalSteps(once)).toEqual(once);
  });

  // Legacy library entries can still hold `move` steps: the old recorder
  // produced them even though neither codec can store them.
  it('keeps a legacy move step instead of dropping it on load', () => {
    const steps: MacroStep[] = [
      { type: 'key', action: 'down', value: '4' },
      { type: 'key', action: 'up', value: '4' },
      { type: 'move', dx: 12, dy: -4 },
    ];
    const g = toGroups(steps);
    expect(g.map((x) => x.kind)).toEqual(['tap', 'move']);
    expect(round(steps)).toEqual(steps);
  });
});

describe('usage spelling', () => {
  // A macro decoded off a device spells usages zero-padded ("04"); the key
  // table and the recorder spell them "4". Both must group and label alike,
  // or the step list falls back to rendering a bare "0x04".
  it('canonicalises a zero-padded key usage on load', () => {
    const g = toGroups([
      { type: 'key', action: 'down', value: '04' },
      { type: 'key', action: 'up', value: '04' },
    ]);
    expect(g).toHaveLength(1);
    expect(g[0]!.kind).toBe('tap');
    expect(g[0]!.value).toBe('4');
  });

  it('pairs a tap even when the two halves are spelled differently', () => {
    const g = toGroups([
      { type: 'key', action: 'down', value: '04' },
      { type: 'key', action: 'up', value: '4' },
    ]);
    expect(g).toHaveLength(1);
    expect(g[0]!.kind).toBe('tap');
  });

  it('leaves mouse button values (plain numbers) untouched', () => {
    const g = toGroups([
      { type: 'mouse', action: 'down', value: 4 },
      { type: 'mouse', action: 'up', value: 4 },
    ]);
    expect(g[0]!.value).toBe(4);
  });
});

describe('encodedStepCount', () => {
  const kb = { maxSteps: 63, slots: 1, delaysConsumeSteps: true };
  const v8 = { maxSteps: 76, slots: 16, nameMax: 30, delaysConsumeSteps: false };

  const groups = toGroups([
    { type: 'key', action: 'down', value: '4' },
    { type: 'delay', ms: 30 },
    { type: 'key', action: 'up', value: '4' },
    { type: 'delay', ms: 120 },
    { type: 'key', action: 'down', value: '5' },
    { type: 'key', action: 'up', value: '5' },
  ]);

  it('charges the keyboard for each delay record as well as each event', () => {
    // 4 key events + the 30 ms hold + the 120 ms wait row
    expect(encodedStepCount(groups, kb)).toBe(6);
  });

  it('charges the V8 for events only, since a delay rides on the next record', () => {
    expect(encodedStepCount(groups, v8)).toBe(4);
  });

  it('does not charge for a 0 ms wait row, which encodes to nothing', () => {
    const withEmptyWait = toGroups([
      { type: 'key', action: 'down', value: '4' },
      { type: 'key', action: 'up', value: '4' },
    ]).concat({ uid: 'x', kind: 'wait', type: 'wait', ms: 0, holdMs: 0 });
    expect(encodedStepCount(withEmptyWait, kb)).toBe(2);
  });

  it('does not charge for move steps, which both codecs drop', () => {
    const withMove = toGroups([
      { type: 'key', action: 'down', value: '4' },
      { type: 'key', action: 'up', value: '4' },
      { type: 'move', dx: 5, dy: 5 },
    ]);
    expect(encodedStepCount(withMove, v8)).toBe(2);
    expect(encodedStepCount(withMove, kb)).toBe(2);
  });

  it('falls back to charging for delays when the device advertises no limits', () => {
    expect(encodedStepCount(groups, undefined)).toBe(6);
  });
});

describe('groupsDuration', () => {
  it('sums the wait rows and the holds', () => {
    const g = toGroups([
      { type: 'key', action: 'down', value: '4' },
      { type: 'delay', ms: 30 },
      { type: 'key', action: 'up', value: '4' },
      { type: 'delay', ms: 120 },
      { type: 'key', action: 'down', value: '5' },
      { type: 'key', action: 'up', value: '5' },
    ]);
    expect(groupsDuration(g)).toBe(150);
  });
});
