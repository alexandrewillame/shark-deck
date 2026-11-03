import { describe, expect, it } from 'vitest';
import { encodeMouseMacro, decodeMouseMacro } from './mouse-macro-codec';
import { V8_CMD, V8_MACRO_MAX_STEPS } from '@shared/mouse-wire';
import type { Macro } from '@shared/types/macros';

describe('V8 command bytes (regression guard for the 0x09 write bug)', () => {
  it('write is 0x07 and restore is 0x09 — never the other way round', () => {
    expect(V8_CMD.WRITE_SETTING).toBe(0x07);
    expect(V8_CMD.RESTORE).toBe(0x09);
    expect(V8_CMD.READ_BLOCK).toBe(0x08);
  });
});

describe('mouse macro codec', () => {
  const m: Macro = {
    id: 'onboard-0',
    name: 'test',
    repeatCount: 1,
    steps: [
      { type: 'key', action: 'down', value: '04' }, // a
      { type: 'delay', ms: 385 },
      { type: 'key', action: 'up', value: '04' },
      { type: 'key', action: 'down', value: '05' }, // b
      { type: 'key', action: 'up', value: '05' },
      { type: 'mouse', action: 'down', value: 1 },
      { type: 'mouse', action: 'up', value: 1 },
    ],
  };

  it('round-trips name and steps', () => {
    const bytes = encodeMouseMacro(m);
    const back = decodeMouseMacro('onboard-0', bytes);
    expect(back).not.toBeNull();
    expect(back!.name).toBe('test');
    // the delay folds onto the following step, so it re-emerges before "up a"
    const kinds = back!.steps.map((s) => `${s.type}:${s.action ?? ''}`);
    expect(kinds).toContain('key:down');
    expect(kinds).toContain('mouse:down');
    expect(back!.steps.some((s) => s.type === 'delay' && s.ms === 385)).toBe(true);
  });

  it('an all-0xFF (empty) slot decodes to null', () => {
    expect(decodeMouseMacro('onboard-1', new Array(0x180).fill(0xff))).toBeNull();
  });

  it('emits the name-length byte and 0xFF name padding', () => {
    const bytes = encodeMouseMacro(m);
    expect(bytes[0]).toBe(4); // "test"
    expect(bytes.slice(1, 5)).toEqual([0x74, 0x65, 0x73, 0x74]);
    expect(bytes[5]).toBe(0xff); // padding starts
  });

  it('replaces non-ASCII characters with "?" instead of a garbled low byte', () => {
    // é (U+00E9) and 日 (U+65E5) are outside the wire's printable-ASCII name
    // field; 😀 (U+1F600) is a surrogate pair — none of the three should
    // reach the device as a mangled/truncated byte.
    const bytes = encodeMouseMacro({ ...m, name: 'café日😀' });
    const back = decodeMouseMacro('onboard-0', bytes);
    expect(back!.name).toBe('caf???');
  });

  it('a macro longer than the slot writes an honest count — no phantom steps', () => {
    // Every step is a bare key-down (no delays), so one step == one record.
    const steps = Array.from({ length: V8_MACRO_MAX_STEPS + 20 }, () => ({
      type: 'key' as const,
      action: 'down' as const,
      value: '04',
    }));
    const bytes = encodeMouseMacro({ ...m, name: 'long', steps });
    // count byte sits at V8_MACRO_COUNT_OFF (0x1f)
    expect(bytes[0x1f]).toBe(V8_MACRO_MAX_STEPS);
    const back = decodeMouseMacro('onboard-0', bytes);
    expect(back).not.toBeNull();
    // no decoded step should be the 0xFF fill (flag 0xff -> key up, usage 0xff)
    expect(back!.steps.every((s) => !(s.type === 'key' && s.value === 'ff'))).toBe(true);
    expect(back!.steps.filter((s) => s.type === 'key').length).toBe(V8_MACRO_MAX_STEPS);
  });

  it('falls back to a placeholder name instead of an empty slot', () => {
    // nameLen 0 decodes to "no macro here" (see the all-0xFF test above) —
    // an empty/whitespace name must never round-trip to that.
    const bytes = encodeMouseMacro({ ...m, name: '   ' });
    const back = decodeMouseMacro('onboard-0', bytes);
    expect(back).not.toBeNull();
    expect(back!.name).toBe('Macro');
  });
});
