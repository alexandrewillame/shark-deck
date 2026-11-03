import { describe, expect, it } from 'vitest';
import type { Macro } from '@shared/types/macros';
import { encodeMacro, decodeMacro, KB_MACRO_MAX_STEPS } from './compx-keyboard';

const macro: Macro = {
  id: 'm1',
  name: 'test',
  repeatCount: 3,
  steps: [
    { type: 'key', action: 'down', value: '04' }, // A down
    { type: 'delay', ms: 50 },
    { type: 'key', action: 'up', value: '04' }, // A up
    { type: 'mouse', action: 'down', value: 1 },
    { type: 'mouse', action: 'up', value: 1 },
  ],
};

describe('macro wire encoding', () => {
  it('produces a fixed 256-byte payload with a step-count + repeat header', () => {
    const buf = encodeMacro(macro);
    expect(buf).toHaveLength(256);
    expect(buf[1]).toBe(5); // 5 steps
    expect(buf[2]).toBe(3); // repeat count
  });

  it('round-trips through decode', () => {
    const back = decodeMacro('m1', 'test', encodeMacro(macro));
    expect(back.repeatCount).toBe(3);
    expect(back.steps).toEqual(macro.steps);
  });

  it('clamps repeat count to at least 1', () => {
    expect(encodeMacro({ ...macro, repeatCount: 0 })[2]).toBe(1);
  });

  it('encodes a delay as little-endian ms', () => {
    const buf = encodeMacro({ ...macro, steps: [{ type: 'delay', ms: 300 }] });
    // header is 4 bytes; first event kind=3 (delay), then ms LE
    expect(buf[4]).toBe(3);
    expect(buf[6]! | (buf[7]! << 8)).toBe(300);
  });

  // Pointer motion has no record kind in this payload. It used to fall through
  // to the key branch and encode as "press usage 0x00" — a phantom keystroke
  // the device would actually replay — instead of being left out.
  it('drops a move step rather than encoding it as a phantom key press', () => {
    const buf = encodeMacro({
      ...macro,
      steps: [
        { type: 'key', action: 'down', value: '04' },
        { type: 'move', dx: 30, dy: -12 },
        { type: 'key', action: 'up', value: '04' },
      ],
    });
    expect(buf[1]).toBe(2); // the move contributes no record
    expect(decodeMacro('m1', 'test', buf).steps).toEqual([
      { type: 'key', action: 'down', value: '04' },
      { type: 'key', action: 'up', value: '04' },
    ]);
  });

  it('truncates at the slot capacity KB_MACRO_MAX_STEPS advertises', () => {
    const steps = Array.from({ length: KB_MACRO_MAX_STEPS + 10 }, () => ({
      type: 'key' as const,
      action: 'down' as const,
      value: '04',
    }));
    expect(encodeMacro({ ...macro, steps })[1]).toBe(KB_MACRO_MAX_STEPS);
    expect(KB_MACRO_MAX_STEPS).toBe(63);
  });
});
