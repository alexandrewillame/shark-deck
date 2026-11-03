import type { TFunc } from './i18n';
import type { MessageKey } from './i18n/en';
import { labelForCode } from './keys';
import type { KeyBindingKind } from './types/keys';

/**
 * What one firmware matrix quad actually means.
 *
 * `provenance: inferred` — the quad's four bytes are the vendor's own shape
 * (`defaultMatrix` / `defaultFnMatrix` in `scripts/_raw/kb-r85he-matrix.json`
 * use it, and `GET_KEYMATRIX` / `GET_FN` answer in it), but the reading of
 * bytes 2 and 3 below is reconstructed from those tables plus a real R85HE,
 * not from a documented spec.
 *
 * The bug this module exists to fix: the previous decode kept byte 2 for a
 * plain key and threw the rest away, so a whole class of Fn bindings — every
 * media key, every brightness key, every two-key combo — came back with
 * `code: null` and no label, and the Remap board drew them as blank,
 * unmapped keys. Fn+F8 plays and pauses music on the real board and the app
 * said nothing was bound to it.
 */

/**
 * HID Consumer page (0x0C) usages, the subset these boards emit.
 *
 * Quad type 3 carries the usage little-endian across bytes 2 and 3 — every
 * value the R85HE's factory table uses fits in the low byte, but the high
 * byte is read anyway rather than assumed zero.
 */
export const CONSUMER_LABEL: Record<number, string> = {
  0x00b5: 'Next track',
  0x00b6: 'Previous track',
  0x00b7: 'Stop',
  0x00cd: 'Play / Pause',
  0x00e2: 'Mute',
  0x00e9: 'Volume +',
  0x00ea: 'Volume -',
  0x006f: 'Screen brightness +',
  0x0070: 'Screen brightness -',
  0x0183: 'Media player',
  0x018a: 'Mail',
  0x0192: 'Calculator',
  0x0194: 'My computer',
  0x0221: 'Search',
  0x0223: 'Home page',
  0x0224: 'Back',
  0x0225: 'Forward',
  0x0226: 'Stop browsing',
  0x0227: 'Refresh',
  0x022a: 'Favourites',
};

/**
 * The catalogue key for each name in CONSUMER_LABEL.
 *
 * The English table stays the decode's answer — it is what the main process
 * puts in `KeyBinding.label` and what the tests read — and the renderer shows
 * this instead (`quadLabel`), so a media key reads in the app's language on
 * the board's tooltips and in the Remap picker. keyboard-fn-codes.test.ts pins
 * every key here to the English it stands for, so the two cannot drift.
 */
export const CONSUMER_LABEL_KEY: Record<number, MessageKey> = {
  0x00b5: 'keyfn.nextTrack',
  0x00b6: 'keyfn.prevTrack',
  0x00b7: 'keyfn.stop',
  0x00cd: 'keyfn.playPause',
  0x00e2: 'keyfn.mute',
  0x00e9: 'keyfn.volumeUp',
  0x00ea: 'keyfn.volumeDown',
  0x006f: 'keyfn.screenBrightnessUp',
  0x0070: 'keyfn.screenBrightnessDown',
  0x0183: 'keyfn.mediaPlayer',
  0x018a: 'keyfn.mail',
  0x0192: 'keyfn.calculator',
  0x0194: 'keyfn.myComputer',
  0x0221: 'keyfn.search',
  0x0223: 'keyfn.homePage',
  0x0224: 'keyfn.back',
  0x0225: 'keyfn.forward',
  0x0226: 'keyfn.stopBrowsing',
  0x0227: 'keyfn.refresh',
  0x022a: 'keyfn.favourites',
};

/**
 * What fits ON a keycap.
 *
 * A 1u cap is ~29px wide at the board's default scale, which is five or six
 * characters at the legend's 8px — "Screen brightness -" renders as "Screen…"
 * on every key it applies to, which is worse than no legend at all. The full
 * name is still what the tooltip says.
 */
export const CONSUMER_SHORT: Record<number, string> = {
  0x00b5: 'Next',
  0x00b6: 'Prev',
  0x00b7: 'Stop',
  0x00cd: 'Play',
  0x00e2: 'Mute',
  0x00e9: 'Vol +',
  0x00ea: 'Vol -',
  0x006f: 'Br +',
  0x0070: 'Br -',
  0x0183: 'Media',
  0x018a: 'Mail',
  0x0192: 'Calc',
  0x0194: 'PC',
  0x0221: 'Find',
  0x0223: 'Home',
  0x0224: 'Back',
  0x0225: 'Fwd',
  0x0226: 'Stop',
  0x0227: 'Reload',
  0x022a: 'Faves',
};

/** Keycap-sized forms of LIGHTING_LABEL, keyed the same way. */
export const LIGHTING_SHORT: Record<string, string> = {
  '1:*': 'Mode',
  '2:1': 'Br +',
  '2:2': 'Br -',
  '2:*': 'Bright',
  '3:1': 'Spd -',
  '3:2': 'Spd +',
  '3:*': 'Speed',
  '5:*': 'Preset',
  '8:*': 'Sub',
};

/**
 * Every non-usage quad qmk.top offers in its own key-assignment picker, by a
 * readable form of the name it gives it. `ported-from-vendor`.
 *
 * This is what separates "a binding that happens to be handled inside the
 * board" from "firmware behaviour with nothing to assign" — and it is a list,
 * not a rule. The app twice tried to derive it and got a different third of the
 * board wrong each time: "types 10 and 13 are reserved" made lighting mode and
 * brightness +/- unchangeable when the picker offers all three, and "nothing is
 * reserved" then presented `[13,3,…]` speed, `[13,5,…]` preset and `[13,8,…]`
 * sub-mode as bindings when they appear in no picker at all.
 *
 * Extracted from the bundle's action table, where `hidCode` is the quad packed
 * big-endian into a 32-bit int — `LEDBIRINC`'s 218235136 is 0x0D020100, byte
 * for byte the quad a real R85HE reports for Fn+Up.
 */
export const ASSIGNABLE_QUADS: Record<string, string> = {
  '10,1,0,0': 'Fn layer',
  '10,9,0,0': 'Lighting on / off',
  '10,12,0,0': 'Power save',
  '10,14,0,0': 'Volume / brightness',
  '10,24,0,0': 'AI',
  '10,32,0,0': 'Microphone',
  '10,36,0,0': 'Right Fn layer',
  '13,1,0,0': 'Lighting mode',
  '13,2,1,0': 'Lighting brightness +',
  '13,2,2,0': 'Lighting brightness -',
  '13,6,0,0': 'Lighting preset 1',
  '13,6,1,0': 'Lighting preset 2',
  '18,0,0,0': 'Open website',
  '19,0,0,0': 'Browser',
};

/** ASSIGNABLE_QUADS' names as catalogue keys — see CONSUMER_LABEL_KEY. */
export const ASSIGNABLE_QUAD_KEY: Record<string, MessageKey> = {
  '10,1,0,0': 'keyfn.fnLayer',
  '10,9,0,0': 'keyfn.lightingToggle',
  '10,12,0,0': 'keyfn.powerSave',
  '10,14,0,0': 'keyfn.volumeBrightness',
  '10,24,0,0': 'keyfn.ai',
  '10,32,0,0': 'keyfn.microphone',
  '10,36,0,0': 'keyfn.rightFnLayer',
  '13,1,0,0': 'keyfn.lightingMode',
  '13,2,1,0': 'keyfn.lightingBrightnessUp',
  '13,2,2,0': 'keyfn.lightingBrightnessDown',
  '13,6,0,0': 'keyfn.lightingPreset1',
  '13,6,1,0': 'keyfn.lightingPreset2',
  '18,0,0,0': 'keyfn.openWebsite',
  '19,0,0,0': 'keyfn.browser',
};

/**
 * Quad type 13 — a control the board acts on itself, never reaching the host.
 * Keyed `<byte1>:<byte2>`, with a `<byte1>:*` fallback.
 *
 * Measured on a real R85HE: Fn+Z/X/C/V are `[13,8,n]`, Fn+Enter `[13,5,1]`,
 * Fn+arrows `[13,3,n]` and `[13,2,n]`.
 */
export const LIGHTING_LABEL: Record<string, string> = {
  '1:*': 'Lighting mode',
  '2:1': 'Lighting brightness +',
  '2:2': 'Lighting brightness -',
  '2:*': 'Lighting brightness',
  '3:1': 'Lighting speed -',
  '3:2': 'Lighting speed +',
  '3:*': 'Lighting speed',
  '5:*': 'Lighting preset',
  '8:*': 'Lighting sub-mode',
};

/** LIGHTING_LABEL's names as catalogue keys — see CONSUMER_LABEL_KEY. */
export const LIGHTING_LABEL_KEY: Record<string, MessageKey> = {
  '1:*': 'keyfn.lightingMode',
  '2:1': 'keyfn.lightingBrightnessUp',
  '2:2': 'keyfn.lightingBrightnessDown',
  '2:*': 'keyfn.lightingBrightness',
  '3:1': 'keyfn.lightingSpeedDown',
  '3:2': 'keyfn.lightingSpeedUp',
  '3:*': 'keyfn.lightingSpeed',
  '5:*': 'keyfn.lightingPreset',
  '8:*': 'keyfn.lightingSubMode',
};

/**
 * Quad type 10 — an opaque firmware function. Keyed by byte 1.
 *
 * Only a few are identifiable; the rest keep a generic label rather than a
 * fabricated one, because guessing here would put a wrong sentence on a key
 * the user cannot change anyway.
 */
export const SYSTEM_LABEL: Record<number, string> = {
  1: 'Fn layer',
  3: 'Windows key lock',
};

/** SYSTEM_LABEL's names as catalogue keys — see CONSUMER_LABEL_KEY. */
export const SYSTEM_LABEL_KEY: Record<number, MessageKey> = {
  1: 'keyfn.fnLayer',
  3: 'keyfn.winLock',
};

/** HID usages 0xE0..0xE7 — the eight modifiers, in usage order. */
const MODIFIER_USAGE: Record<number, string> = {
  0xe0: 'L-Ctrl',
  0xe1: 'L-Shift',
  0xe2: 'L-Alt',
  0xe3: 'L-Win',
  0xe4: 'R-Ctrl',
  0xe5: 'R-Shift',
  0xe6: 'R-Alt',
  0xe7: 'R-Win',
};

export const isModifierUsage = (u: number) => u >= 0xe0 && u <= 0xe7;

const usageLabel = (u: number) => MODIFIER_USAGE[u] ?? labelForCode(u.toString(16));

export interface DecodedQuad {
  kind: KeyBindingKind;
  /** The host-visible HID usage as lowercase hex, or null when this binding is
   *  not a plain keyboard usage (consumer page, firmware function, unused). */
  code: string | null;
  /** What to show on the key. Empty string when there is nothing to say. */
  label: string;
  /**
   * `label` as a catalogue key, with its placeholders — for every quad whose
   * name is a function (media, launcher, lighting, firmware) rather than key
   * legends. Absent for a plain-key quad: "R-Alt + 8" is legends, which stay as
   * printed. See `quadLabel`.
   */
  labelKey?: MessageKey;
  labelVars?: Record<string, string>;
  /** The same thing, cut to fit a keycap legend. Equal to `label` when that
   *  is already short enough. */
  short: string;
  /**
   * Firmware behaviour with nothing to assign — not a binding anyone chose.
   *
   * Decided by membership of ASSIGNABLE_QUADS, which is qmk.top's own picker
   * list, because neither rule tried before survived contact with the board:
   * "types 10 and 13 are reserved" marked the brightness and mode-cycle keys
   * unchangeable when the picker offers all three, and "nothing is reserved"
   * then presented `[13,8,…]` sub-mode and `[13,3,…]` speed as bindings when
   * they are not in the picker at all. A type-0 or type-3 quad is always a
   * binding and is never locked.
   */
  locked: boolean;
}

/**
 * Decode one `[type, a, b, c]` matrix quad.
 *
 * Type byte: `0` plain HID usage(s) · `3` HID Consumer page · `10` opaque
 * firmware function · `13` a lighting control. All four are remappable — see
 * `locked`.
 *
 * **Bytes 1 and 2 of a type-0 quad are two independent HID usages**, not a
 * usage plus a modifier bitmask, and either position may hold either. Read off
 * a real R85HE (`npx vite-node --config vitest.config.ts
 * scripts/diag-fn-quads.ts`):
 *
 * ```
 * Fn+DEL   [0,  73,  0, 0]   Insert          — usage in byte 1, byte 2 empty
 * Fn+PgUp  [0,  74,  0, 0]   Home
 * Fn+8     [0, 230, 37, 0]   R-Alt + 8       — both filled
 * Fn+2     [0,   0,230, 0]   R-Alt           — usage in byte 2, byte 1 empty
 * Fn+F12   [0,   0, 70, 0]   Print Screen
 * base F12 [0,   0, 69, 0]   F12
 * ```
 *
 * The write path names them `usageHigh` / `usageLow` (see `setKeyRemap`), which
 * is right for a single usage below 256 and is why the base layer's "HID code
 * at byte 2" alignment held — but it cannot explain Fn+DEL, whose usage sits in
 * byte 1 with byte 2 empty. Two usage slots explains every row.
 *
 * Reading bytes 2 and 3 instead — which this did, extrapolating from the base
 * layer plus the vendor's static `defaultFnMatrix` — put Fn+DEL, Fn+PgUp and
 * Fn+PgDn at `[…,0,0]` and reported them as bound to nothing.
 */
export function decodeKeyQuad(raw: [number, number, number, number]): DecodedQuad {
  const [type, a, b, c] = raw;
  if (!raw.some((x) => x))
    return { kind: 'unused', code: null, label: '', short: '', locked: false };

  if (type === 0) {
    /**
     * Three usage slots, not two.
     *
     * Bytes 1, 2 and 3 each hold a HID usage, sparsely: Fn+DEL is
     * `[0, 73, 0, 0]`, the base layer's A is `[0, 0, 4, 0]`, R-Alt+8 is
     * `[0, 230, 37, 0]` — all measured — and the vendor's own factory table has
     * `[0, 0, 227, 7]`, which it labels "Key + modifier" and which is L-Win + D
     * read this way. Reading only bytes 1 and 2 dropped the second half of that
     * one, and made a three-key combination impossible to express at all.
     */
    const parts = [a, b, c].filter((u) => u !== 0);
    if (parts.length === 0)
      return { kind: 'unused', code: null, label: '', short: '', locked: false };
    // The primary usage is the one that is NOT a modifier, so a combo still
    // reports the key it fires; a pair of modifiers falls back to the first.
    const primary = parts.find((u) => !isModifierUsage(u)) ?? parts[0]!;
    const label = parts.map(usageLabel).join(' + ');
    return {
      kind: 'key',
      code: primary.toString(16).padStart(2, '0'),
      label,
      // A combo is shown by the key it fires; the modifiers are in the tooltip.
      short: usageLabel(primary),
      locked: false,
    };
  }

  if (type === 3) {
    const usage = b | (c << 8);
    const hex = `0x${usage.toString(16)}`;
    const named = CONSUMER_LABEL[usage];
    const label = named ?? `Media ${hex}`;
    return {
      kind: 'consumer',
      code: null,
      label,
      labelKey: named ? CONSUMER_LABEL_KEY[usage] : 'keyfn.mediaUnknown',
      labelVars: named ? undefined : { code: hex },
      short: CONSUMER_SHORT[usage] ?? label,
      locked: false,
    };
  }

  if (type === 13) {
    const quad = raw.join(',');
    const named = ASSIGNABLE_QUADS[quad];
    // The table entry that names it, exact before wildcard — one lookup for
    // the label and its key, so the two cannot pick different rows.
    const row = [`${a}:${b}`, `${a}:*`].find((k) => LIGHTING_LABEL[k] !== undefined);
    const label = named ?? (row ? LIGHTING_LABEL[row]! : 'Lighting control');
    const labelKey: MessageKey = named
      ? ASSIGNABLE_QUAD_KEY[quad]!
      : row
        ? LIGHTING_LABEL_KEY[row]!
        : 'keyfn.lightingControl';
    const short = LIGHTING_SHORT[`${a}:${b}`] ?? LIGHTING_SHORT[`${a}:*`] ?? 'Light';
    return { kind: 'lighting', code: null, label, labelKey, short, locked: !named };
  }

  if (type === 10) {
    const quad = raw.join(',');
    const named = ASSIGNABLE_QUADS[quad];
    const system = SYSTEM_LABEL[a];
    return {
      kind: 'system',
      code: null,
      label: named ?? system ?? 'Firmware function',
      labelKey: named
        ? ASSIGNABLE_QUAD_KEY[quad]!
        : system
          ? SYSTEM_LABEL_KEY[a]!
          : 'keyfn.firmwareFunction',
      short: 'Fw',
      locked: !named,
    };
  }

  return { kind: 'unknown', code: null, label: '', short: '', locked: false };
}

/**
 * What `decodeKeyQuad` calls a quad, in the app's language.
 *
 * The main process decodes bindings in English (`KeyBinding.label`), which is
 * right for the tables and the tests but not for the screen, so the renderer
 * names a binding from its `raw` quad through this instead. A plain-key quad
 * comes back exactly as decoded — its name is keycap legends.
 */
export function quadLabel(raw: [number, number, number, number], t: TFunc): string {
  const d = decodeKeyQuad(raw);
  return d.labelKey ? t(d.labelKey, d.labelVars) : d.label;
}
