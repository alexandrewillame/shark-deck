/**
 * Pure conversion from sharkfin's data files to Shark Deck's shapes. Used by
 * `scripts/import-keyboard-registry.ts` (which writes `generated/*`) and by the
 * converter proof in `generated/layout-convert.test.ts`. Nothing in the app
 * imports this at runtime.
 *
 * sharkfin (https://github.com/dniminenn/sharkfin, GPL-3.0-or-later) extracts
 * its registry and layouts from the vendor's own app and firmware. A layout
 * file is `{canvas, keys[]}`; each key carries pixel geometry on the vendor's
 * 46 px grid (a 1u cap is 40 px on a 46 px pitch with a 1 px origin — the same
 * grid `buildLayout` in scripts/extract-keyboard-protocol.mjs divided by 46 to
 * produce our hand-verified `ANSI_79_SG9047`), its factory 4-byte matrix entry,
 * and — only when the slot was confirmed against a firmware image or a real
 * board — its `matrixIndex` (the firmware slot every per-key write addresses).
 */
import type { KeyLayoutEntry } from '@shared/types/keys';
import type { TravelRange } from './keyboard-row';

export interface SharkfinKey {
  code: string;
  type: 'key' | 'knob';
  x: number;
  y: number;
  w: number;
  h: number;
  text?: string;
  matrixIndex: number | null;
  matrixEntry: number[];
  hidUsage: number | null;
  consumerUsage: number | null;
}

export interface SharkfinLayout {
  canvas: { width: number; height: number };
  keys: SharkfinKey[];
}

/** The vendor grid pitch, in pixels per key unit. */
export const PITCH = 46;

/** Pixels to key units, rounded exactly as `buildLayout` rounded the R85HE grid. */
export const toUnits = (px: number): number => +(px / PITCH).toFixed(2);

/** Firmware slots per layer (128 slots x 4 bytes = the 512-byte keymap layer). */
export const SLOTS_PER_LAYER = 128;

/**
 * Display labels in the convention `ANSI_79_SG9047` already uses (so a key's
 * legend, and the icon `KeyboardMap` draws for `Up` / `Enter` / `SHIFT`…, look
 * the same on every board). Keyed by the KeyboardEvent.code-style names
 * sharkfin's layouts use.
 */
const LABELS: Record<string, string> = {
  Escape: 'ESC',
  Backquote: '`~',
  Tab: 'TAB',
  CapsLock: 'CAPS',
  ShiftLeft: 'SHIFT',
  ShiftRight: 'SHIFT',
  ControlLeft: 'CTRL',
  ControlRight: 'CTRL',
  MetaLeft: 'WIN',
  MetaRight: 'WIN',
  AltLeft: 'ALT',
  AltRight: 'ALT',
  Space: 'Space',
  Fn: 'FN',
  Backspace: 'Bksp',
  Enter: 'Enter',
  ArrowUp: 'Up',
  ArrowDown: 'Down',
  ArrowLeft: 'Left',
  ArrowRight: 'Right',
  Delete: 'DEL',
  Insert: 'INS',
  Home: 'Home',
  End: 'End',
  PageUp: 'PgUp',
  PageDown: 'PgDn',
  PrintScreen: 'PrtSc',
  ScrollLock: 'ScrLk',
  Pause: 'Pause',
  ContextMenu: 'Menu',
  Minus: '-_',
  Equal: '=+',
  BracketLeft: '[{',
  BracketRight: ']}',
  Backslash: '\\|',
  IntlBackslash: '\\|',
  Semicolon: ';:',
  Quote: '\'"',
  Comma: ',<',
  Period: '.>',
  Slash: '/?',
  NumLock: 'Num',
  NumpadDivide: 'N/',
  NumpadMultiply: 'N*',
  NumpadSubtract: 'N-',
  NumpadAdd: 'N+',
  NumpadEnter: 'NEnt',
  NumpadDecimal: 'N.',
  AudioVolumeUp: 'Vol+',
  AudioVolumeDown: 'Vol-',
  AudioVolumeMute: 'Mute',
  MediaPlayPause: 'Play',
};

const DIGIT_LABELS = ['0)', '1!', '2@', '3#', '4$', '5%', '6^', '7&', '8*', '9('];

export function labelFor(key: Pick<SharkfinKey, 'code' | 'text'>): string {
  const c = key.code;
  if (LABELS[c]) return LABELS[c]!;
  const letter = /^Key([A-Z])$/.exec(c);
  if (letter) return letter[1]!;
  const digit = /^Digit([0-9])$/.exec(c);
  if (digit) return DIGIT_LABELS[Number(digit[1])]!;
  const numpad = /^Numpad([0-9])$/.exec(c);
  if (numpad) return `N${numpad[1]}`;
  if (/^F([1-9]|1[0-9]|2[0-4])$/.test(c)) return c;
  const text = (key.text ?? '').replace(/\s+/g, ' ').trim();
  return text || c;
}

/** True when every key of a layout carries a distinct firmware slot. */
export function isCertain(layout: SharkfinLayout): boolean {
  const keys = layout.keys.filter((k) => k.type === 'key');
  if (!keys.length) return false;
  const slots = keys.map((k) => k.matrixIndex);
  if (slots.some((s) => s === null || s < 0 || s >= SLOTS_PER_LAYER)) return false;
  return new Set(slots).size === slots.length;
}

const sameEntry = (matrix: readonly number[], slot: number, entry: readonly number[]) =>
  entry.length === 4 && entry.every((b, i) => matrix[slot * 4 + i] === b);

/**
 * Convert a sharkfin layout to `KeyLayoutEntry[]`, sorted by slot.
 *
 * `slot` comes from the key's `matrixIndex` when it has one; otherwise, when a
 * board's factory matrix is supplied, from the ONE slot whose 4-byte value
 * equals the key's `matrixEntry`. Zero or several matches throws: guessing a
 * slot is how a per-key write lands on the wrong key.
 *
 * `geometryOnly` drops slots entirely (the drawing-only layouts): row/col are
 * then a draw-order id, never a wire address.
 */
export function convertLayout(
  layout: SharkfinLayout,
  opts: { defaultMatrix?: readonly number[]; geometryOnly?: boolean } = {},
): KeyLayoutEntry[] {
  const keys = layout.keys.filter((k) => k.type === 'key');
  const out: KeyLayoutEntry[] = [];

  if (opts.geometryOnly) {
    const ys = [...new Set(keys.map((k) => k.y))].sort((a, b) => a - b);
    const colInRow = new Map<number, number>();
    const sorted = [...keys].sort((a, b) => a.y - b.y || a.x - b.x);
    for (const k of sorted) {
      const row = ys.indexOf(k.y);
      const col = colInRow.get(row) ?? 0;
      colInRow.set(row, col + 1);
      out.push(entry(k, row, col, undefined));
    }
    return out;
  }

  for (const k of keys) {
    let slot = k.matrixIndex;
    if (slot === null) {
      if (!opts.defaultMatrix) throw new Error(`${k.code}: no matrixIndex and no default matrix`);
      const matches: number[] = [];
      for (let s = 0; s < SLOTS_PER_LAYER; s++) {
        if (sameEntry(opts.defaultMatrix, s, k.matrixEntry)) matches.push(s);
      }
      if (matches.length !== 1) {
        throw new Error(
          `${k.code} [${k.matrixEntry.join(',')}] matches ${matches.length} slots in the default matrix`,
        );
      }
      slot = matches[0]!;
    }
    out.push(entry(k, slot % 6, Math.floor(slot / 6), slot));
  }
  const seen = new Set<number>();
  for (const e of out) {
    if (seen.has(e.slot!)) throw new Error(`slot ${e.slot} is claimed by two keys`);
    seen.add(e.slot!);
  }
  return out.sort((a, b) => a.slot! - b.slot!);
}

function entry(k: SharkfinKey, row: number, col: number, slot: number | undefined): KeyLayoutEntry {
  const e: KeyLayoutEntry = {
    label: labelFor(k),
    ...(slot !== undefined ? { slot } : {}),
    code: k.hidUsage ?? null,
    row,
    col,
    x: toUnits(k.x),
    y: toUnits(k.y),
    w: toUnits(k.w),
  };
  // Only a cap taller than one unit (numpad + / Enter) records a height;
  // KeyboardMap draws every other key at the row height.
  if (k.h > PITCH + 4) e.h = toUnits(k.h);
  return e;
}

/**
 * The cable and 2.4 GHz report-rate ceilings encoded in a vendor internal
 * name: `ry5088_sg9047_1m_8k` -> 8000 / null, `ry5088_sg9047_3m_8k_8k` ->
 * 8000 / 8000, `yc3123_sg_sg8967_3m_1k` -> 1000 / null. Our reading of the
 * vendor's naming pattern, not a field it publishes.
 */
export function parseRates(internalName: string): {
  cable: number | null;
  wireless: number | null;
} {
  const tokens = internalName
    .split('_')
    .map((t) => /^(\d+)k$/.exec(t))
    .filter((m): m is RegExpExecArray => !!m)
    .map((m) => Number(m[1]) * 1000);
  return { cable: tokens[0] ?? null, wireless: tokens[1] ?? null };
}

/** sharkfin's `travel` block, with the ranges it actually carries. */
export function parseTravel(t: unknown): {
  travel?: TravelRange;
  firePress?: TravelRange;
  fireLift?: TravelRange;
  deadzone?: TravelRange;
} | null {
  if (!t || typeof t !== 'object') return null;
  const src = t as Record<string, unknown>;
  const out: Record<string, TravelRange> = {};
  for (const k of ['travel', 'firePress', 'fireLift', 'deadzone'] as const) {
    const r = src[k] as Partial<TravelRange> | undefined;
    if (r && typeof r.min === 'number' && typeof r.max === 'number' && typeof r.step === 'number') {
      out[k] = { min: r.min, max: r.max, step: r.step, default: r.default ?? null };
    }
  }
  return Object.keys(out).length ? out : null;
}
