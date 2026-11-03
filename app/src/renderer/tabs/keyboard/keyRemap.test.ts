import { describe, expect, it } from 'vitest';
import type { KeyBinding, KeyLayoutEntry } from '@shared/types/keys';
import { KB_FN_DEFAULT_SLOTS } from '@shared/keyboard-fn-defaults';
import {
  comboAction,
  comboUsages,
  differsFromFactory,
  factoryBinding,
  factoryCode,
  isRemapped,
  resetCodeOf,
} from './keyRemapState';

/**
 * "Is this key remapped?" — the check that drives the board highlight, the
 * legend count, and which keys "Reset all remaps" rewrites.
 *
 * The trap it exists to pin: the shared key table spells usages without
 * leading zeros ("4" = A) while a decode off the wire pads to two ("04"), so a
 * string compare marks every key on the board as remapped and "reset all"
 * rewrites all 79.
 */
const entry = (code: number | null): KeyLayoutEntry => ({
  label: 'A',
  row: 0,
  col: 0,
  slot: 0,
  code,
  x: 0,
  y: 0,
});
const binding = (code: string | null, extra: Partial<KeyBinding> = {}): KeyBinding => ({
  slot: 0,
  code,
  kind: 'key',
  raw: [0, 0, 0, 0],
  provenance: 'device',
  ...extra,
});
/** A binding as the wire actually delivers it. On the Fn layer the quad IS the
 *  whole binding, so "has this changed" is a quad comparison — a usage compare
 *  cannot see one media key swapped for another (both decode to code null). */
const quad = (raw: [number, number, number, number]): KeyBinding => binding(null, { raw });

describe('isRemapped', () => {
  it('treats the padded and unpadded spellings of a usage as equal', () => {
    // Factory 'A' is 0x04; the table would spell it "4", the wire "04".
    expect(factoryCode(entry(0x04))).toBe('4');
    expect(isRemapped(binding('04'), entry(0x04), 'base', 0)).toBe(false);
  });

  it('flags a key bound to a different usage', () => {
    expect(isRemapped(binding('06'), entry(0x04), 'base', 0)).toBe(true);
  });

  it('counts a disabled key as remapped', () => {
    // Usage 0 is "this key does nothing" — very much not the factory state,
    // and the user needs to be able to find it and reset it.
    expect(isRemapped(binding(null), entry(0x04), 'base', 0)).toBe(true);
  });

  it('never flags a key with no factory usage', () => {
    // Fn and friends carry `code: null` — there is no default to differ from.
    expect(isRemapped(binding('06'), entry(null), 'base', 0)).toBe(false);
  });

  it('is false when nothing was read for the slot', () => {
    expect(isRemapped(undefined, entry(0x04), 'base', 0)).toBe(false);
  });
});

/**
 * The Fn layer is a different question with a different factory answer.
 *
 * `KeyLayoutEntry.code` is the key's BASE usage — F12 is 0x45 whichever layer
 * you are on — so comparing an Fn read against it asked "does Fn+F12 send
 * F12?". No, for every one of the ~50 slots the Fn layer ships doing nothing,
 * so most of the board was painted and tooltipped as "Remapped — sends nothing
 * (disabled)". The factory Fn layer is KB_FN_DEFAULT_SLOTS.
 */
describe('isRemapped on the Fn layer', () => {
  // Fixed points in the factory table this file depends on.
  const UNUSED_SLOT = 1;
  // A single-usage factory key. Slot 36 is raw [0, 0, 70, 0] — Print Screen.
  const KEY_SLOT = 36;
  // A two-usage COMBO: raw [0, 0, 227, 7] is L-Win + D (show desktop), not the
  // usage 0xe3 its second byte alone reads as.
  const COMBO_SLOT = 18;
  const OPAQUE_SLOT = 6; // kind 'consumer' — a different HID page
  it('has the factory table this test reasons about', () => {
    expect(KB_FN_DEFAULT_SLOTS[UNUSED_SLOT]).toBeUndefined();
    expect(KB_FN_DEFAULT_SLOTS[KEY_SLOT]?.raw).toEqual([0, 0, 70, 0]);
    expect(KB_FN_DEFAULT_SLOTS[COMBO_SLOT]?.raw).toEqual([0, 0, 227, 7]);
    expect(KB_FN_DEFAULT_SLOTS[OPAQUE_SLOT]?.kind).toBe('consumer');
  });

  it('leaves a slot the Fn layer never used alone', () => {
    // This is the bug: the key ships doing nothing here, reads as nothing,
    // and so is unchanged. It must render as an ordinary keycap.
    expect(factoryBinding(entry(0x45), 'fn', UNUSED_SLOT)).toEqual({ kind: 'none' });
    expect(isRemapped(binding(null), entry(0x45), 'fn', UNUSED_SLOT)).toBe(false);
  });

  it('flags a key the user gave an Fn binding it never had', () => {
    expect(isRemapped(quad([0, 0, 4, 0]), entry(0x45), 'fn', UNUSED_SLOT)).toBe(true);
  });

  it('compares against the factory Fn binding, not the base one', () => {
    // KeyLayoutEntry.code is the BASE usage — F12 is 0x45 whichever layer you
    // are on — so comparing an Fn read against it asked "does Fn+F12 send
    // F12?" and answered no for the ~50 slots that ship doing nothing.
    expect(factoryBinding(entry(0x45), 'fn', KEY_SLOT)).toEqual({
      kind: 'quad',
      raw: [0, 0, 70, 0],
    });
    // ...and Reset can put it back, byte for byte.
    expect(resetCodeOf(factoryBinding(entry(0x45), 'fn', KEY_SLOT))).toBe('00004600');
    expect(isRemapped(quad([0, 0, 70, 0]), entry(0x45), 'fn', KEY_SLOT)).toBe(false);
    expect(isRemapped(quad([0, 0, 4, 0]), entry(0x45), 'fn', KEY_SLOT)).toBe(true);
  });

  it('calls a cleared Fn key unbound, and still different from factory', () => {
    // Two questions, two answers. Clearing a remap leaves a key that does
    // NOTHING on a layer whose keycaps say nothing about it either, so the
    // board paints it as an empty cap — "Remapped" described the history of
    // the slot rather than its state. But it does still differ from what the
    // factory put there, so Reset has to stay available to put that back;
    // routing both through one predicate is what greyed Reset out on exactly
    // the keys that needed it.
    const cleared = quad([0, 0, 0, 0]);
    expect(isRemapped(cleared, entry(0x45), 'fn', KEY_SLOT)).toBe(false);
    expect(differsFromFactory(cleared, entry(0x45), 'fn', KEY_SLOT)).toBe(true);
    // A slot the factory never used is not "different" when it is empty.
    expect(differsFromFactory(cleared, entry(0x45), 'fn', UNUSED_SLOT)).toBe(false);
    // The base layer is the other way round: a key whose legend says F12 and
    // which now sends nothing is very much worth flagging.
    expect(isRemapped(quad([0, 0, 0, 0]), entry(0x45), 'base', KEY_SLOT)).toBe(true);
  });

  it('resets a factory combo to the exact bytes it shipped with', () => {
    // [0, 0, 227, 7] — the factory Fn+F3. Reducing it to a single usage could
    // not express it, so Reset used to be disabled on it; writing the four
    // bytes back needs no theory about what each one means, which is the point.
    expect(factoryBinding(entry(0x3c), 'fn', COMBO_SLOT)).toEqual({
      kind: 'quad',
      raw: [0, 0, 227, 7],
    });
    expect(resetCodeOf(factoryBinding(entry(0x3c), 'fn', COMBO_SLOT))).toBe('0000e307');
    // Unchanged is still unchanged, though — that is a quad comparison, and it
    // does not go through factoryBinding at all.
    expect(isRemapped(quad([0, 0, 227, 7]), entry(0x3c), 'fn', COMBO_SLOT)).toBe(false);
  });

  it('flags a changed slot whose factory binding has no single usage', () => {
    // The reported bug: an F-key whose factory default is a media usage could
    // never be highlighted, because "has this changed" was routed through
    // factoryBinding — which answers the narrower "what could Reset write
    // back" and says opaque for every consumer, system, lighting and combo
    // default. A whole row of remapped F-keys therefore drew as plain keycaps.
    // A consumer default — Fn+F1 is Screen brightness -, Fn+F11 is Volume -.
    // These are most of the F-row, and "Reset to default" was dead on all of
    // them because a consumer usage is not a HID keyboard usage and there was
    // no way to send one. The quad is the way.
    expect(factoryBinding(entry(0x45), 'fn', OPAQUE_SLOT)).toEqual({
      kind: 'quad',
      raw: [3, 0, 112, 0],
    });
    expect(resetCodeOf(factoryBinding(entry(0x45), 'fn', OPAQUE_SLOT))).toBe('03007000');
    expect(KB_FN_DEFAULT_SLOTS[OPAQUE_SLOT]?.raw).toEqual([3, 0, 112, 0]);
    // Still on its factory media usage.
    expect(isRemapped(quad([3, 0, 112, 0]), entry(0x45), 'fn', OPAQUE_SLOT)).toBe(false);
    // Reassigned to a plain key...
    expect(isRemapped(quad([0, 0, 70, 0]), entry(0x45), 'fn', OPAQUE_SLOT)).toBe(true);
    // ...and to a DIFFERENT media usage, which no usage comparison could see:
    // both sides decode to code null.
    expect(isRemapped(quad([3, 0, 205, 0]), entry(0x45), 'fn', OPAQUE_SLOT)).toBe(true);
  });

  it('flags a firmware or lighting binding that has been changed', () => {
    // These are remappable. qmk.top offers the backslash key (LEDMODELOOP)
    // and the arrows (LEDBIRINC / LEDBIRDEC) as ordinary bindings, and the
    // app was marking them Reserved and refusing to select them at all.
    const LIGHTING_SLOT = 80; // [13, 1, 0, 0] — lighting on/off
    expect(KB_FN_DEFAULT_SLOTS[LIGHTING_SLOT]?.raw).toEqual([13, 1, 0, 0]);
    expect(isRemapped(quad([13, 1, 0, 0]), entry(0x31), 'fn', LIGHTING_SLOT)).toBe(false);
    expect(isRemapped(quad([0, 0, 0x31, 230]), entry(0x31), 'fn', LIGHTING_SLOT)).toBe(true);
  });
});

describe('resetCodeOf', () => {
  it('writes usage 0 to restore a slot the factory left empty', () => {
    expect(resetCodeOf({ kind: 'none' })).toBe('00');
    expect(resetCodeOf({ kind: 'usage', code: 'e3' })).toBe('e3');
    expect(resetCodeOf({ kind: 'opaque' }), 'nothing to write back').toBeNull();
  });
});

/**
 * A remap can be a COMBINATION — the board ships with several (Fn+8 is
 * R-Alt + 8, measured off the hardware) and until now the app could read one
 * and not write one: the picker wrote on every click, so the first half landed
 * on the device before the second could be chosen.
 *
 * The wire has room for exactly two usages, in bytes 1 and 2 of a type-0 quad,
 * and `setKeyRemap` lays a 16-bit action out as `[0, hi, lo, 0]` — so the
 * action and the quad are the same two bytes, and these have to agree.
 */
describe('key combinations', () => {
  it('reads both usages out of a quad, in wire order', () => {
    expect(comboUsages([0, 0xe6, 0x25, 0])).toEqual([0xe6, 0x25]);
    expect(comboUsages([0, 0, 0x25, 0])).toEqual([0x25]);
    expect(comboUsages([0, 0, 0, 0])).toEqual([]);
  });

  it('reads nothing out of a quad that is not a plain key', () => {
    // Type 3 is a consumer usage whose byte 2 is the LOW half of it, not a
    // HID keyboard usage — reading it as one would offer "Play/Pause" as the
    // key `0xcd`.
    expect(comboUsages([3, 0, 205, 0])).toEqual([]);
  });

  /** The driver's own split: 8 hex digits are the four quad bytes verbatim. */
  const quadOf = (action: string) =>
    [0, 1, 2, 3].map((i) => parseInt(action.slice(i * 2, i * 2 + 2), 16));

  it('packs a combination the way the board stores one', () => {
    // R-Alt + 8 round-trips: the action the picker builds, split by the driver
    // into quad bytes, is the quad the board was read from.
    expect(quadOf(comboAction([0xe6, 0x25]))).toEqual([0, 0xe6, 0x25, 0]);
    expect(comboUsages(quadOf(comboAction([0xe6, 0x25])))).toEqual([0xe6, 0x25]);
  });

  it('holds three keys, which is the whole budget', () => {
    // Bytes 1, 2 and 3. Ctrl + Shift + Esc, say — two modifiers and a key,
    // which one modifier slot could not express.
    const action = comboAction([0xe0, 0xe1, 0x29]);
    expect(quadOf(action)).toEqual([0, 0xe0, 0xe1, 0x29]);
    expect(comboUsages(quadOf(action))).toEqual([0xe0, 0xe1, 0x29]);
  });

  it('puts the modifiers first whichever order they were picked in', () => {
    // The board keeps modifiers in the low bytes. Clicking "8" and then "Right
    // Alt" must not produce a key that fires Alt while holding 8.
    expect(comboAction([0x25, 0xe6])).toBe(comboAction([0xe6, 0x25]));
    expect(quadOf(comboAction([0x29, 0xe1, 0xe0]))).toEqual([0, 0xe1, 0xe0, 0x29]);
  });

  it('is its own hex for a single usage, modifier or not', () => {
    expect(comboAction([0x25])).toBe('25');
    expect(comboAction([0xe6])).toBe('e6');
  });

  it('calls an empty pick "this key does nothing", not a no-op', () => {
    // The difference matters: a write has to happen, or clearing a binding
    // would silently do nothing at all.
    expect(comboAction([])).toBe('00');
  });
});

/**
 * Every factory Fn binding has to be one "Reset to default" can put back.
 *
 * Most of the Fn layer is NOT plain keys: Fn+F1 is Screen brightness -, Fn+F11
 * is Volume -, Fn+\ is Lighting on/off, Fn+Esc is a firmware function. Reset
 * took a single HID keyboard usage, which none of those is, so it was disabled
 * on the whole F-row and every lighting key — the keys whose factory value is
 * hardest to type back in by hand.
 */
describe('every factory Fn default can be restored', () => {
  /** A slot the factory table does not list. */
  const UNUSED_FN_SLOT = 1;
  const slots = Object.keys(KB_FN_DEFAULT_SLOTS).map(Number);

  it('covers the whole table', () => {
    expect(slots.length).toBeGreaterThan(20);
    for (const slot of slots) {
      const code = resetCodeOf(factoryBinding(undefined, 'fn', slot));
      expect(
        code,
        `slot ${slot} (${KB_FN_DEFAULT_SLOTS[slot]!.label}) has nothing to reset to`,
      ).not.toBeNull();
      // What the driver accepts: 1-4 hex digits, or exactly 8 for a raw quad.
      expect(code, `slot ${slot}`).toMatch(/^([0-9a-f]{1,4}|[0-9a-f]{8})$/);
    }
  });

  it('round-trips each one back to the bytes it came from', () => {
    for (const slot of slots) {
      const raw = KB_FN_DEFAULT_SLOTS[slot]!.raw;
      const code = resetCodeOf(factoryBinding(undefined, 'fn', slot))!;
      // The driver splits an 8-digit action into the four quad bytes verbatim.
      const back = [0, 1, 2, 3].map((i) => parseInt(code.slice(i * 2, i * 2 + 2), 16));
      expect(back, `slot ${slot} (${KB_FN_DEFAULT_SLOTS[slot]!.label})`).toEqual(raw);
    }
  });

  it('restores the media keys by name, not just by byte', () => {
    // Spot-checks against the reported case and its neighbours, so a table edit
    // that moved a slot would fail here rather than silently reassigning a key.
    const named = (label: string) => slots.find((s) => KB_FN_DEFAULT_SLOTS[s]!.label === label)!;
    expect(KB_FN_DEFAULT_SLOTS[named('Volume -')]!.raw).toEqual([3, 0, 234, 0]);
    expect(KB_FN_DEFAULT_SLOTS[named('Volume +')]!.raw).toEqual([3, 0, 233, 0]);
    expect(KB_FN_DEFAULT_SLOTS[named('Play / Pause')]!.raw).toEqual([3, 0, 205, 0]);
    expect(resetCodeOf(factoryBinding(undefined, 'fn', named('Volume -')))).toBe('0300ea00');
  });

  it('leaves a slot the factory never used resetting to nothing', () => {
    // "Nothing" is a value here, not an absence — the write still has to
    // happen, or clearing a key the user bound would do nothing at all.
    expect(resetCodeOf(factoryBinding(undefined, 'fn', UNUSED_FN_SLOT))).toBe('00');
  });
});
