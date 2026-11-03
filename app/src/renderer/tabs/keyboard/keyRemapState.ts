import { KB_FN_DEFAULT_SLOTS } from '@shared/keyboard-fn-defaults';
import { decodeKeyQuad, isModifierUsage } from '@shared/keyboard-fn-codes';
import { KEY_DISABLED_CODE } from '@shared/keys';
import type { KeyBinding, KeyLayoutEntry } from '@shared/types/keys';

export type RemapLayer = 'base' | 'fn';

/** What a slot the factory Fn layer never used looks like on the wire. Only
 *  28 of 128 slots ship with anything at all. */
const FN_UNUSED_QUAD: readonly number[] = [0, 0, 0, 0];

/**
 * What the factory layout has this slot doing ON THIS LAYER.
 *
 *  - `usage`  — a plain HID usage, so a live binding can be compared with it.
 *  - `quad`   — not a plain key: a consumer usage (Fn+F11 is Volume -), a
 *               lighting control, a firmware function. There is no usage to
 *               compare against, but the four bytes ARE writable, so Reset can
 *               put it back verbatim. This used to be `opaque`, which is why
 *               "Reset to default" was dead on every media and lighting key on
 *               the Fn layer — the whole F-row included.
 *  - `none`   — the factory leaves this key doing nothing here. Most of the
 *               Fn layer: only 28 of 128 slots ship with a function.
 *  - `opaque` — nothing this app can put back. Only where the layer itself has
 *               no factory table to consult.
 */
export type FactoryBinding =
  | { kind: 'usage'; code: string }
  | { kind: 'quad'; raw: readonly [number, number, number, number] }
  | { kind: 'none' }
  | { kind: 'opaque' };

/** The base layer's factory usage, in the lowercase-hex spelling
 *  `KeyBinding.code` uses. */
export const factoryCode = (k: KeyLayoutEntry | undefined): string | null =>
  k?.code == null ? null : k.code.toString(16);

/**
 * The factory binding for a slot on a layer.
 *
 * This is the whole reason the Fn layer used to render as a wall of colour.
 * `KeyLayoutEntry.code` is the key's BASE usage — F12 is 0x45 whichever layer
 * you are looking at — so comparing an Fn-layer read against it asked "does
 * Fn+F12 send F12?", the answer was no for every one of the ~50 slots the Fn
 * layer does not use, and all of them were painted and tooltipped as
 * "Remapped — sends nothing (disabled)". The factory Fn layer is
 * `KB_FN_DEFAULT_SLOTS`, and everything outside it ships sending nothing.
 */
export function factoryBinding(
  entry: KeyLayoutEntry | undefined,
  layer: RemapLayer,
  slot: number | null,
): FactoryBinding {
  if (layer === 'base') {
    const code = factoryCode(entry);
    return code === null ? { kind: 'opaque' } : { kind: 'usage', code };
  }
  if (slot === null) return { kind: 'opaque' };
  const def = KB_FN_DEFAULT_SLOTS[slot];
  if (!def) return { kind: 'none' };
  // Anything that is not a plain key goes back as the four bytes it is. The
  // driver takes an 8-hex-digit action for exactly this (see setKeyRemap).
  if (def.raw[0] !== 0) return { kind: 'quad', raw: def.raw };
  // Decoded the same way the live read is, so "what the factory put here" and
  // "what the board says is here" are spelled identically and can be compared
  // at all.
  const d = decodeKeyQuad(def.raw);
  if (d.kind !== 'key' || d.code === null) return { kind: 'opaque' };
  // A combo IS writable — `setKeyRemap` takes a 16-bit action and lays it out
  // as `[0, hi, lo, 0]`, which is the same shape a combo is read from (R-Alt+8
  // is `[0, 230, 37, 0]`, measured; see keyboard-fn-codes.test.ts). This used
  // to read bytes 2 and 3 and call every combo opaque, so Reset stayed
  // disabled on exactly the keys whose factory value is hardest to retype.
  // A plain-key quad goes back verbatim too. It used to be reduced to a single
  // usage, which could not express `[0, 0, 227, 7]` (the factory Fn+F3) at all
  // and left Reset disabled there; writing the bytes back needs no theory about
  // what each one means.
  return { kind: 'quad', raw: def.raw };
}

/**
 * The HID usages a plain-key quad holds, in wire order.
 *
 * Type 0 carries up to two, in bytes 1 and 2 — `[0, 230, 37, 0]` is R-Alt + 8,
 * measured off the board. Byte 3 is not part of a key binding (it is the high
 * byte of a consumer usage on type 3), so it is not read here.
 */
export function comboUsages(raw: readonly number[]): number[] {
  if (raw[0] !== 0) return [];
  return [raw[1] ?? 0, raw[2] ?? 0, raw[3] ?? 0].filter((u) => u !== 0);
}

/** How many usages one binding can hold — bytes 1, 2 and 3 of the quad. */
export const COMBO_MAX = 3;

/** The eight modifier keys by `KeyboardEvent.code`, as their HID usages. */
const MODIFIER_CODES: Record<string, number> = {
  ControlLeft: 0xe0,
  ShiftLeft: 0xe1,
  AltLeft: 0xe2,
  MetaLeft: 0xe3,
  ControlRight: 0xe4,
  ShiftRight: 0xe5,
  AltRight: 0xe6,
  MetaRight: 0xe7,
};
const R_ALT = 0xe6;
const L_CTRL = 0xe0;

/**
 * The modifier keys physically held, as HID usages in the order they went
 * down — what a typed remap combines with the key pressed (KeyRemapSection).
 *
 * Tracked by each modifier's own key code, because the event's flags cannot
 * say which side is held: `ctrlKey` is true for either Ctrl. And AltGr reads
 * differently on every OS — Linux reports it as no Alt at all (`AltGraph`),
 * Windows as a Left Ctrl it invents plus Right Alt — while its key code is
 * `AltRight` everywhere.
 */
export function heldModifiers() {
  /** usage → when its keydown arrived */
  const down = new Map<number, number>();
  return {
    track(e: { type: string; code: string; timeStamp: number }): void {
      const u = MODIFIER_CODES[e.code];
      if (u === undefined) return;
      if (e.type === 'keyup') {
        down.delete(u);
        return;
      }
      if (down.has(u)) return; // auto-repeat
      // Windows sends AltGr as a Left Ctrl it makes up, then Right Alt, in
      // the same instant: that Ctrl is no key anyone pressed.
      if (u === R_ALT) {
        const at = down.get(L_CTRL);
        if (at !== undefined && Math.abs(e.timeStamp - at) < 50) down.delete(L_CTRL);
      }
      down.set(u, e.timeStamp);
    },
    /**
     * The held modifiers, for an event. A modifier already down when the
     * listening began sent its keydown to nobody; the event's own flags still
     * show it, and it is taken as the left one. Not Ctrl alongside Right Alt:
     * on Windows that flag is AltGr's.
     */
    usages(e: {
      ctrlKey: boolean;
      shiftKey: boolean;
      altKey: boolean;
      metaKey: boolean;
    }): number[] {
      const out = [...down.keys()];
      const fill = (flag: boolean, left: number, right: number) => {
        if (flag && !out.includes(left) && !out.includes(right)) out.push(left);
      };
      if (!out.includes(R_ALT)) fill(e.ctrlKey, L_CTRL, 0xe4);
      fill(e.shiftKey, 0xe1, 0xe5);
      fill(e.altKey, 0xe2, R_ALT);
      fill(e.metaKey, 0xe3, 0xe7);
      return out;
    },
    clear(): void {
      down.clear();
    },
  };
}

/**
 * Usages -> the `action` string `setKeyRemap` takes.
 *
 * One usage is its own hex, which is the shape the base layer has always used.
 * Two or three go as the full quad `[0, u1, u2, u3]` — eight hex digits, which
 * the driver writes verbatim — with modifiers first, matching the quads the
 * board ships with. An empty list is "this key does nothing", which is a real
 * binding and not a no-op.
 */
export function comboAction(usages: readonly number[]): string {
  if (usages.length === 0) return KEY_DISABLED_CODE;
  if (usages.length === 1) return usages[0]!.toString(16);
  const ordered = [
    ...usages.filter(isModifierUsage),
    ...usages.filter((u) => !isModifierUsage(u)),
  ].slice(0, COMBO_MAX);
  return quadAction([0, ...ordered]);
}

/**
 * Nothing is bound here — the key does nothing on this layer.
 *
 * Distinct from "changed": clearing a remap on the Fn layer leaves a key that
 * differs from its factory value AND does nothing, and the two facts drive
 * different things. The board paints this one as unbound (an empty keycap is
 * what the key now is), while `differsFromFactory` keeps Reset available so
 * the factory function can be put back.
 */
export function isUnbound(binding: KeyBinding | undefined): boolean {
  return !binding || binding.kind === 'unused' || !binding.raw.some((b) => b !== 0);
}

/**
 * Is this slot bound to something other than what the factory put there?
 *
 * Compared numerically, not as strings: the shared key table spells usages
 * without leading zeros ("4" = A) while a decode from the wire pads to two
 * ("04"), so a string compare called every key remapped.
 */
export function isRemapped(
  binding: KeyBinding | undefined,
  entry: KeyLayoutEntry | undefined,
  layer: RemapLayer,
  slot: number | null,
): boolean {
  // Cleared, on a layer where the keycap says nothing about what Fn+it does:
  // the key now does NOTHING, and painting it "remapped" describes the history
  // of the slot rather than its state. An empty cap is what it is. (The base
  // layer is the other way round — a key whose legend says "F11" and which
  // sends nothing is very much worth flagging.)
  if (layer === 'fn' && isUnbound(binding)) return false;
  if (!binding) return false;

  /**
   * On the Fn layer, compare the RAW QUADS.
   *
   * `factoryBinding` answers a narrower question — "is there a single usage
   * Reset could write back" — and returns `opaque` for every consumer, system,
   * lighting and two-usage factory default. Routing "has this changed" through
   * it meant those slots could never be flagged, so an F-key whose factory
   * default is a media usage stayed an unhighlighted plain keycap no matter
   * what it had been reassigned to. That is the reported "F1-F12 are remapped
   * but not shown in blue".
   *
   * The quad is the whole binding, so comparing quads catches every kind of
   * change uniformly — including one media key swapped for another, which no
   * usage comparison could see (both decode to `code: null`). A slot the
   * factory table does not list ships as all zeros.
   */
  if (layer === 'fn') {
    if (slot === null) return false;
    const factory = KB_FN_DEFAULT_SLOTS[slot]?.raw ?? FN_UNUSED_QUAD;
    return binding.raw.some((b, i) => b !== factory[i]);
  }

  // The base layer's factory value is always a plain usage (KeyLayoutEntry.code
  // is the legend on the cap), so `quad` cannot arise here — but narrow it
  // rather than assert it.
  const factory = factoryBinding(entry, layer, slot);
  if (factory.kind === 'opaque' || factory.kind === 'quad') return false;
  // Bound to nothing. That is only a change where the factory sent something.
  if (!binding.code) return factory.kind === 'usage';
  if (factory.kind === 'none') return true;
  return parseInt(binding.code, 16) !== parseInt(factory.code, 16);
}

/**
 * What "Reset to default" writes to put this slot back.
 *
 * A usage for a plain base-layer key, the four quad bytes as 8 hex digits for
 * anything else, and usage 0 where the factory's answer is "this key does
 * nothing here" — which is a value, not an absence. `null` only where there is
 * genuinely nothing to write.
 */
export function resetCodeOf(factory: FactoryBinding): string | null {
  if (factory.kind === 'usage') return factory.code;
  if (factory.kind === 'quad') return quadAction(factory.raw);
  if (factory.kind === 'none') return KEY_DISABLED_CODE;
  return null;
}

/** Four quad bytes as the 8-hex-digit action `setKeyRemap` takes. */
export function quadAction(raw: readonly number[]): string {
  return [0, 1, 2, 3].map((i) => ((raw[i] ?? 0) & 0xff).toString(16).padStart(2, '0')).join('');
}

/** An 8-hex-digit action back to the four quad bytes it writes. */
export function quadBytes(action: string): [number, number, number, number] {
  const b = (i: number) => parseInt(action.slice(i * 2, i * 2 + 2), 16) || 0;
  return [b(0), b(1), b(2), b(3)];
}

/** Is this picker code a whole quad (8 hex digits) rather than a HID usage?
 *  No usage is that wide — the same test `setKeyRemap` applies. */
export const isQuadAction = (code: string): boolean => /^[0-9a-f]{8}$/i.test(code);

/** Quad type 3: a HID Consumer-page usage, little-endian in bytes 2 and 3. */
const CONSUMER_TYPE = 3;

/**
 * A Consumer-page binding — a media or launcher key — as the action
 * `setKeyRemap` writes verbatim: `[3, 0, lo, hi]`, the shape the board's own
 * Fn media keys ship in (Play / Pause is `[3, 0, 205, 0]`, Media player
 * `[3, 0, 0x83, 0x01]`) and the one `decodeKeyQuad` reads back.
 */
export const consumerAction = (usage: number): string =>
  quadAction([CONSUMER_TYPE, 0, usage & 0xff, (usage >> 8) & 0xff]);

/**
 * What the Remap picker is spelling out for one key: a combination of up to
 * `COMBO_MAX` HID usages, or one Consumer-page binding. A media or launcher
 * key is a whole quad of its own, with no room for a modifier, so the two
 * never mix: picking one replaces the other.
 */
export interface RemapPick {
  usages: number[];
  /** The consumer binding as an 8-hex-digit action, or null. */
  quad: string | null;
}

/** A binding as the picker shows it — its usages, or its consumer quad. Any
 *  other kind (a lighting control, a firmware function) lights nothing. */
export function pickOf(raw: readonly number[] | undefined): RemapPick {
  if (!raw) return { usages: [], quad: null };
  if (raw[0] === CONSUMER_TYPE) return { usages: [], quad: quadAction(raw) };
  return { usages: comboUsages(raw), quad: null };
}

/** The action `setKeyRemap` takes for a pick. */
export const pickAction = (p: RemapPick): string => p.quad ?? comboAction(p.usages);

/** Is this picker button part of the pick? */
export const pickHas = (p: RemapPick, code: string): boolean =>
  isQuadAction(code)
    ? p.quad === code.toLowerCase()
    : p.quad === null && p.usages.includes(parseInt(code, 16));

/**
 * One picker click.
 *
 * A consumer button replaces the whole pick (or clears it, when it already is
 * the pick). A usage joins the combination — three usages is the quad's whole
 * budget (`COMBO_MAX`): past it, a new NON-modifier replaces the old one, since
 * a binding fires one key, while a new modifier pushes out the oldest, so
 * Ctrl+Shift+Esc can be built up in any order without a click ever being
 * silently ignored. A usage picked over a consumer binding starts afresh.
 */
export function togglePick(p: RemapPick, code: string): RemapPick {
  if (isQuadAction(code)) {
    const q = code.toLowerCase();
    return { usages: [], quad: p.quad === q ? null : q };
  }
  const u = parseInt(code, 16);
  if (!Number.isFinite(u)) return p;
  const cur = p.quad === null ? p.usages : [];
  if (cur.includes(u)) return { usages: cur.filter((x) => x !== u), quad: null };
  const kept = isModifierUsage(u) ? cur : cur.filter((x) => isModifierUsage(x));
  const next = [...kept, u];
  return {
    usages: next.length > COMBO_MAX ? next.slice(next.length - COMBO_MAX) : next,
    quad: null,
  };
}

/**
 * Does this slot hold something other than its factory value?
 *
 * The question "Reset to default" asks, which is NOT the question the board's
 * colours ask. Clearing an Fn binding leaves a key that does nothing — so it is
 * painted unbound, not remapped — while still differing from the factory, so
 * Reset has to stay available to put the original function back. Routing both
 * through one predicate is what greyed Reset out on exactly the keys that
 * needed it.
 */
export function differsFromFactory(
  binding: KeyBinding | undefined,
  entry: KeyLayoutEntry | undefined,
  layer: RemapLayer,
  slot: number | null,
): boolean {
  if (!binding) return false;
  if (layer === 'fn') {
    if (slot === null) return false;
    const factory = KB_FN_DEFAULT_SLOTS[slot]?.raw ?? FN_UNUSED_QUAD;
    return binding.raw.some((b, i) => b !== factory[i]);
  }
  return isRemapped(binding, entry, layer, slot);
}
