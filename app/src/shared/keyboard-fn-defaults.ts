import type { KeyBindingKind } from './types/keys';

/**
 * The R85HE's factory Fn-layer defaults (vendor `defaultFnMatrix`, 128 slots
 * x 4 bytes, `app/scripts/_raw/kb-r85he-matrix.json`) — decoded by hand this
 * session (not yet folded into `npm run extract:kb`'s output, since that
 * script needs the vendor app installed to re-run; see the TODO below).
 * `provenance: ported-from-vendor`.
 *
 * Only 28 of the 128 slots are non-zero — those are the keys the Fn layer
 * actually does something with. `KeyRemapSection.tsx` uses this to show
 * which Fn shortcuts are hard-wired (matching what the Attack Shark V4
 * interface itself marks as fixed) rather than leaving them blank, per the
 * user's explicit request.
 *
 * Quad type byte (first of the 4): `0` = plain HID usage at [2] (modifier/
 * extra at [3], semantics unconfirmed); `3` = HID Consumer-page usage at
 * [2]; `10` = opaque firmware/system function; `13` = a lighting control
 * (on/off, brightness +/-, speed +/-); `19,3,x,0` = the extractor's existing
 * "unused" marker (not present among these 28 — kept here for completeness).
 *
 * Labels are plain English, matching the existing untranslated-vendor-data
 * convention elsewhere in the app (see `mouse-buttons.ts`'s `labelEn`).
 *
 * TODO: fold this into `scripts/extract-keyboard-protocol.mjs`'s
 * `defaultFnMatrix` decode so a future `npm run extract:kb` regenerates it
 * instead of this being hand-maintained.
 */
export interface KbFnDefaultSlot {
  slot: number;
  raw: [number, number, number, number];
  kind: KeyBindingKind;
  label: string;
}

export const KB_FN_DEFAULT_SLOTS: Record<number, KbFnDefaultSlot> = {
  0: { slot: 0, raw: [10, 2, 0, 0], kind: 'system', label: 'Firmware function' },
  6: { slot: 6, raw: [3, 0, 112, 0], kind: 'consumer', label: 'Screen brightness -' },
  9: { slot: 9, raw: [10, 5, 1, 0], kind: 'system', label: 'Firmware function' },
  11: { slot: 11, raw: [10, 3, 0, 0], kind: 'system', label: 'Windows key lock' },
  12: { slot: 12, raw: [3, 0, 111, 0], kind: 'consumer', label: 'Screen brightness +' },
  15: { slot: 15, raw: [10, 5, 0, 0], kind: 'system', label: 'Firmware function' },
  16: { slot: 16, raw: [13, 8, 1, 0], kind: 'lighting', label: 'Lighting sub-mode' },
  18: { slot: 18, raw: [0, 0, 227, 7], kind: 'key', label: 'Key + modifier' },
  22: { slot: 22, raw: [13, 8, 2, 0], kind: 'lighting', label: 'Lighting sub-mode' },
  24: { slot: 24, raw: [10, 33, 227, 43], kind: 'system', label: 'Firmware combo' },
  28: { slot: 28, raw: [13, 8, 0, 0], kind: 'lighting', label: 'Lighting sub-mode' },
  30: { slot: 30, raw: [0, 0, 227, 55], kind: 'key', label: 'Key + modifier' },
  34: { slot: 34, raw: [13, 8, 3, 0], kind: 'lighting', label: 'Lighting sub-mode' },
  36: { slot: 36, raw: [0, 0, 70, 0], kind: 'key', label: 'Print Screen' },
  42: { slot: 42, raw: [3, 0, 182, 0], kind: 'consumer', label: 'Previous track' },
  48: { slot: 48, raw: [3, 0, 205, 0], kind: 'consumer', label: 'Play / Pause' },
  54: { slot: 54, raw: [3, 0, 181, 0], kind: 'consumer', label: 'Next track' },
  60: { slot: 60, raw: [3, 0, 226, 0], kind: 'consumer', label: 'Mute' },
  66: { slot: 66, raw: [3, 0, 234, 0], kind: 'consumer', label: 'Volume -' },
  72: { slot: 72, raw: [3, 0, 233, 0], kind: 'consumer', label: 'Volume +' },
  74: { slot: 74, raw: [10, 12, 0, 0], kind: 'system', label: 'Firmware function' },
  77: { slot: 77, raw: [13, 3, 1, 0], kind: 'lighting', label: 'Lighting speed -' },
  78: { slot: 78, raw: [0, 0, 71, 0], kind: 'key', label: 'Scroll Lock' },
  80: { slot: 80, raw: [13, 1, 0, 0], kind: 'lighting', label: 'Lighting on/off' },
  81: { slot: 81, raw: [13, 5, 1, 0], kind: 'lighting', label: 'Lighting mode' },
  82: { slot: 82, raw: [13, 2, 1, 0], kind: 'lighting', label: 'Lighting brightness +' },
  83: { slot: 83, raw: [13, 2, 2, 0], kind: 'lighting', label: 'Lighting brightness -' },
  89: { slot: 89, raw: [13, 3, 2, 0], kind: 'lighting', label: 'Lighting speed +' },
};
