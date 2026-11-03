/**
 * A curated HID keyboard-usage table, shared by the keyboard key-remap tab and
 * the macro editor so the label <-> code mapping is defined exactly once.
 *
 * `code` is the HID usage as a lowercase hex string (no `0x`), e.g. `"04"` = A,
 * `"e0"` = Left Ctrl. The keyboard driver's `setKeyRemap` parses the same form.
 *
 * `label` stays English on purpose: a key's name is its keycap legend, and the
 * group's is what callers match a group by (remapGroups.ts finds "Media" and
 * "System" that way) and key their React lists on. What a picker DRAWS is
 * `labelKey`, translated, where one is given.
 */
import type { MessageKey } from './i18n/en';

export interface KeyDef {
  label: string;
  code: string;
  /** The name to show instead of `label`, in the app's language — for a key
   *  whose name is a function rather than a legend ("Media player"). */
  labelKey?: MessageKey;
}

export interface KeyGroup {
  label: string;
  /** The heading as the picker shows it. */
  labelKey?: MessageKey;
  keys: KeyDef[];
}

export const KEY_GROUPS: KeyGroup[] = [
  {
    label: 'Letters',
    labelKey: 'keypick.group.letters',
    keys: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'
      .split('')
      .map((c, i) => ({ label: c, code: (0x04 + i).toString(16) })),
  },
  {
    label: 'Digits',
    labelKey: 'keypick.group.digits',
    keys: [
      ['1', '1e'],
      ['2', '1f'],
      ['3', '20'],
      ['4', '21'],
      ['5', '22'],
      ['6', '23'],
      ['7', '24'],
      ['8', '25'],
      ['9', '26'],
      ['0', '27'],
    ].map(([label, code]) => ({ label: label!, code: code! })),
  },
  {
    label: 'Function',
    labelKey: 'keypick.group.function',
    // F13–F24 too: a common target for a spare key (an app's hotkeys that
    // nothing else uses), and what macOS reports a PC keyboard's Print Screen,
    // Scroll Lock and Pause as — so a macro recorded there has them.
    keys: Array.from({ length: 24 }, (_, i) => ({
      label: `F${i + 1}`,
      code: (i < 12 ? 0x3a + i : 0x68 + i - 12).toString(16),
    })),
  },
  {
    label: 'Modifiers',
    labelKey: 'keypick.group.modifiers',
    keys: [
      ['Left Ctrl', 'e0'],
      ['Left Shift', 'e1'],
      ['Left Alt', 'e2'],
      ['Left Win', 'e3'],
      ['Right Ctrl', 'e4'],
      ['Right Shift', 'e5'],
      ['Right Alt', 'e6'],
      ['Right Win', 'e7'],
    ].map(([label, code]) => ({ label: label!, code: code! })),
  },
  {
    label: 'Editing',
    labelKey: 'keypick.group.editing',
    keys: [
      ['Enter', '28'],
      ['Esc', '29'],
      ['Backspace', '2a'],
      ['Tab', '2b'],
      ['Space', '2c'],
      ['Caps Lock', '39'],
      ['Insert', '49'],
      ['Delete', '4c'],
      ['Home', '4a'],
      ['End', '4d'],
      ['Page Up', '4b'],
      ['Page Down', '4e'],
    ].map(([label, code]) => ({ label: label!, code: code! })),
  },
  {
    label: 'Arrows',
    labelKey: 'keypick.group.arrows',
    keys: [
      ['Left', '50'],
      ['Right', '4f'],
      ['Up', '52'],
      ['Down', '51'],
    ].map(([label, code]) => ({ label: label!, code: code! })),
  },
  // Everything below the arrows exists so the macro recorder can name what it
  // captures: `hidUsageForBrowserCode` maps these physical keys, and a usage
  // it can produce that had no entry here would render as a raw `0x..` in the
  // step list (see the round-trip assertion in keys.test.ts).
  {
    label: 'Punctuation',
    labelKey: 'keypick.group.punctuation',
    keys: [
      ['- _', '2d'],
      ['= +', '2e'],
      ['[ {', '2f'],
      ['] }', '30'],
      ['Backslash', '31'],
      ['; :', '33'],
      ['\' "', '34'],
      ['` ~', '35'],
      [', <', '36'],
      ['. >', '37'],
      ['/ ?', '38'],
      ['ISO < >', '64'],
    ].map(([label, code]) => ({ label: label!, code: code! })),
  },
  {
    label: 'Numpad',
    labelKey: 'keypick.group.numpad',
    keys: [
      ['Num Lock', '53'],
      ['Num /', '54'],
      ['Num *', '55'],
      ['Num -', '56'],
      ['Num +', '57'],
      ['Num Enter', '58'],
      ...Array.from({ length: 9 }, (_, i) => [`Num ${i + 1}`, (0x59 + i).toString(16)]),
      ['Num 0', '62'],
      ['Num .', '63'],
      // A Mac keypad's = and a Brazilian/Japanese keypad's comma.
      ['Num =', '67'],
      ['Num ,', '85'],
    ].map(([label, code]) => ({ label: label!, code: code! })),
  },
  {
    label: 'System',
    labelKey: 'keypick.group.system',
    keys: [
      ['Print Screen', '46'],
      ['Scroll Lock', '47'],
      ['Pause', '48'],
      ['Menu', '65'],
    ].map(([label, code]) => ({ label: label!, code: code! })),
  },
  {
    label: 'Media',
    labelKey: 'keypick.group.media',
    keys: [
      ['Play/Pause', 'e8'],
      ['Next', 'ea'],
      ['Prev', 'eb'],
      ['Mute', 'ef'],
      ['Vol +', 'ed'],
      ['Vol -', 'ee'],
    ].map(([label, code]) => ({ label: label!, code: code! })),
  },
];

/**
 * "Make this key send nothing", as an explicit constant rather than a group in
 * the picker above.
 *
 * It used to sit in `KEY_GROUPS` as a group headed "Off" with one key called
 * "Disabled", which reads like "remove the remap" and actually means "make
 * this key dead" — someone reaching for an undo found it, clicked it, and lost
 * the key. Undo is `KeyLayoutEntry.code` (the factory usage); this is a
 * separate, differently-named control. See KeyRemapSection.tsx.
 */
export const KEY_DISABLED_CODE = '00';

/** Every key flattened, for a searchable picker. */
export const ALL_KEYS: KeyDef[] = KEY_GROUPS.flatMap((g) => g.keys);

/** code -> human label (last definition wins on the rare duplicate). */
export const CODE_LABEL = new Map<string, string>(ALL_KEYS.map((k) => [k.code, k.label]));

/**
 * Canonical form of a HID usage string: lowercase hex with no leading zeros,
 * which is what this table's own `code` values use ("4" = A, not "04").
 *
 * Both macro codecs decode a usage byte with `.padStart(2, '0')`, so a macro
 * read back from a device arrives as "04" and used to miss every lookup here —
 * the step list rendered a plain "0x04" where it should have said "A". Encoding
 * is unaffected either way (both sides go through `parseInt(v, 16)`), so this
 * is purely about the two spellings agreeing.
 */
export function normalizeUsage(code: string): string {
  const n = parseInt(code, 16);
  return Number.isNaN(n) ? code.toLowerCase() : n.toString(16);
}

export const labelForCode = (code: string): string =>
  CODE_LABEL.get(normalizeUsage(code)) ?? `0x${code}`;

/**
 * A DOM `KeyboardEvent.code` -> the same lowercase-hex HID usage the rest of
 * this module speaks, for the macro recorder.
 *
 * `code` is used rather than `key` on purpose: it names the physical key
 * independently of layout and of which modifiers are held, which is what a
 * macro replays. That does mean the capture is reported in US-layout terms —
 * on an AZERTY keyboard the key that types "a" arrives as `KeyQ` and records
 * as usage `0x14` — but the device replays by usage too, so the same physical
 * key fires. Returns null for anything with no representation here (the media
 * usages above are vendor convention, not real keyboard usages, so no browser
 * code maps onto them), which the recorder counts and reports rather than
 * dropping silently.
 */
export function hidUsageForBrowserCode(code: string): string | null {
  if (/^Key[A-Z]$/.test(code)) return (0x04 + (code.charCodeAt(3) - 65)).toString(16);
  if (/^Digit[0-9]$/.test(code)) {
    const d = Number(code[5]);
    return (d === 0 ? 0x27 : 0x1d + d).toString(16);
  }
  if (/^F([1-9]|1[0-9]|2[0-4])$/.test(code)) {
    const n = Number(code.slice(1));
    // F1-F12 and F13-F24 are two separate runs of usages.
    return (n <= 12 ? 0x3a + n - 1 : 0x68 + n - 13).toString(16);
  }
  if (/^Numpad[1-9]$/.test(code)) return (0x59 + Number(code[6]) - 1).toString(16);
  return code in BROWSER_CODE_USAGE ? BROWSER_CODE_USAGE[code]!.toString(16) : null;
}

const BROWSER_CODE_USAGE: Record<string, number> = {
  // editing
  Enter: 0x28,
  Escape: 0x29,
  Backspace: 0x2a,
  Tab: 0x2b,
  Space: 0x2c,
  CapsLock: 0x39,
  Insert: 0x49,
  Delete: 0x4c,
  Home: 0x4a,
  End: 0x4d,
  PageUp: 0x4b,
  PageDown: 0x4e,
  // arrows
  ArrowRight: 0x4f,
  ArrowLeft: 0x50,
  ArrowDown: 0x51,
  ArrowUp: 0x52,
  // punctuation
  Minus: 0x2d,
  Equal: 0x2e,
  BracketLeft: 0x2f,
  BracketRight: 0x30,
  Backslash: 0x31,
  Semicolon: 0x33,
  Quote: 0x34,
  Backquote: 0x35,
  Comma: 0x36,
  Period: 0x37,
  Slash: 0x38,
  IntlBackslash: 0x64,
  // system
  PrintScreen: 0x46,
  ScrollLock: 0x47,
  Pause: 0x48,
  ContextMenu: 0x65,
  // numpad (Numpad1-9 are computed above)
  NumLock: 0x53,
  NumpadDivide: 0x54,
  NumpadMultiply: 0x55,
  NumpadSubtract: 0x56,
  NumpadAdd: 0x57,
  NumpadEnter: 0x58,
  Numpad0: 0x62,
  NumpadDecimal: 0x63,
  NumpadEqual: 0x67,
  NumpadComma: 0x85,
  // modifiers
  ControlLeft: 0xe0,
  ShiftLeft: 0xe1,
  AltLeft: 0xe2,
  MetaLeft: 0xe3,
  ControlRight: 0xe4,
  ShiftRight: 0xe5,
  AltRight: 0xe6,
  MetaRight: 0xe7,
};
