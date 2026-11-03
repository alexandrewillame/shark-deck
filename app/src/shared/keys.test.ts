import { describe, expect, it } from 'vitest';
import { ALL_KEYS, CODE_LABEL, hidUsageForBrowserCode, labelForCode, normalizeUsage } from './keys';

/** Every physical key the macro recorder can observe on a normal keyboard. */
const ALL_BROWSER_CODES = [
  ...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('').map((c) => `Key${c}`),
  ...Array.from({ length: 10 }, (_, i) => `Digit${i}`),
  ...Array.from({ length: 24 }, (_, i) => `F${i + 1}`),
  'NumpadEqual',
  'NumpadComma',
  ...Array.from({ length: 10 }, (_, i) => `Numpad${i}`),
  'Enter',
  'Escape',
  'Backspace',
  'Tab',
  'Space',
  'CapsLock',
  'Insert',
  'Delete',
  'Home',
  'End',
  'PageUp',
  'PageDown',
  'ArrowRight',
  'ArrowLeft',
  'ArrowDown',
  'ArrowUp',
  'Minus',
  'Equal',
  'BracketLeft',
  'BracketRight',
  'Backslash',
  'Semicolon',
  'Quote',
  'Backquote',
  'Comma',
  'Period',
  'Slash',
  'IntlBackslash',
  'PrintScreen',
  'ScrollLock',
  'Pause',
  'ContextMenu',
  'NumLock',
  'NumpadDivide',
  'NumpadMultiply',
  'NumpadSubtract',
  'NumpadAdd',
  'NumpadEnter',
  'NumpadDecimal',
  'ControlLeft',
  'ShiftLeft',
  'AltLeft',
  'MetaLeft',
  'ControlRight',
  'ShiftRight',
  'AltRight',
  'MetaRight',
];

describe('hidUsageForBrowserCode', () => {
  it('maps the letter, digit, function and numpad ranges by arithmetic', () => {
    expect(hidUsageForBrowserCode('KeyA')).toBe('4');
    expect(hidUsageForBrowserCode('KeyZ')).toBe('1d');
    expect(hidUsageForBrowserCode('Digit1')).toBe('1e');
    expect(hidUsageForBrowserCode('Digit0')).toBe('27');
    expect(hidUsageForBrowserCode('F1')).toBe('3a');
    expect(hidUsageForBrowserCode('F12')).toBe('45');
    expect(hidUsageForBrowserCode('Numpad1')).toBe('59');
    expect(hidUsageForBrowserCode('Numpad9')).toBe('61');
    expect(hidUsageForBrowserCode('Numpad0')).toBe('62');
  });

  it('returns null for a code with no representation, rather than a wrong usage', () => {
    expect(hidUsageForBrowserCode('AudioVolumeUp')).toBeNull();
    expect(hidUsageForBrowserCode('BrowserBack')).toBeNull();
    expect(hidUsageForBrowserCode('F25')).toBeNull();
    expect(hidUsageForBrowserCode('Lang1')).toBeNull();
    expect(hidUsageForBrowserCode('')).toBeNull();
  });

  it('never collides — two physical keys never record as the same usage', () => {
    const seen = new Map<string, string>();
    for (const code of ALL_BROWSER_CODES) {
      const usage = hidUsageForBrowserCode(code);
      expect(usage, `${code} should be mappable`).not.toBeNull();
      expect(seen.has(usage!), `${code} collides with ${seen.get(usage!)} on usage ${usage}`).toBe(
        false,
      );
      seen.set(usage!, code);
    }
  });

  // The recorder writes whatever this returns into a MacroStep, and the step
  // list names it with labelForCode. A usage the recorder can produce but the
  // table cannot name would render as a bare "0x2f" in the editor.
  it('every usage it can produce has a human label in the key table', () => {
    for (const code of ALL_BROWSER_CODES) {
      const usage = hidUsageForBrowserCode(code)!;
      expect(CODE_LABEL.has(usage), `no label for ${code} -> ${usage}`).toBe(true);
      expect(labelForCode(usage)).not.toMatch(/^0x/);
    }
  });
});

describe('normalizeUsage / labelForCode', () => {
  // Both macro codecs decode a usage byte with padStart(2, '0'), so a macro
  // read back off a device arrives as "04" where the key table says "4". That
  // mismatch used to render a plain "0x04" in the macro step list.
  it('names a zero-padded usage the same as the table spelling', () => {
    expect(labelForCode('04')).toBe('A');
    expect(labelForCode('4')).toBe('A');
    expect(labelForCode('0e0')).toBe('Left Ctrl');
    expect(labelForCode('E0')).toBe('Left Ctrl');
  });

  it('strips leading zeros and lowercases', () => {
    expect(normalizeUsage('04')).toBe('4');
    expect(normalizeUsage('E0')).toBe('e0');
    expect(normalizeUsage('1D')).toBe('1d');
  });

  it('still falls back to raw hex for a usage the table does not name', () => {
    expect(labelForCode('7f')).toBe('0x7f');
  });

  it('leaves a non-hex string alone rather than turning it into NaN', () => {
    expect(normalizeUsage('zz')).toBe('zz');
  });
});

describe('the key table itself', () => {
  it('has no duplicate codes across groups', () => {
    const codes = ALL_KEYS.map((k) => k.code);
    expect(codes.length).toBe(new Set(codes).size);
  });

  it('stores every code as lowercase hex with no 0x prefix', () => {
    for (const k of ALL_KEYS) expect(k.code, k.label).toMatch(/^[0-9a-f]{1,2}$/);
  });
});
