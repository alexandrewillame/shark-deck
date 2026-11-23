/**
 * Key layout and per-key bindings.
 *
 * Split out of the former shared/types.ts.
 */

export interface KeyLayoutEntry {
  /** display label, e.g. "Esc", "A" */
  label: string;
  /** row/col in the device key matrix (render grid; also a stable key id) */
  row: number;
  col: number;
  /**
   * Firmware matrix slot — the index every per-key wire operation (magnetic
   * actuation, per-key lighting, remap) addresses. For the R85HE this is the
   * column-major `defaultMatrix` position, NOT the array index of this entry.
   * Absent on layouts whose slot order was never confirmed (the array index is
   * then used as a best guess).
   */
  slot?: number;
  /** HID usage code this key sends by default, or null for a firmware key (Fn) */
  code?: number | null;
  /** grid units for rendering */
  x: number;
  y: number;
  w?: number;
  h?: number;
  /** Not a key of the drawing but a control beside it: a volume knob's turn
   *  or press (`KnobSlots`), drawn and remapped in the Remap view only. */
  control?: 'knob';
  /** The factory binding of a control with no HID usage of its own (the
   *  knob's Volume -), so Reset can put it back and a change shows. */
  defaultQuad?: readonly [number, number, number, number];
}

/** Where a volume knob's three bindings sit in the key matrix. */
export interface KnobSlots {
  /** turned left: Volume - from the factory */
  left: number;
  /** turned right: Volume + */
  right: number;
  /** pressed: Mute */
  press: number;
}

/**
 * One firmware-matrix slot's current binding, read from the device (base or
 * Fn layer). See `readKeyBindings` (shared/ipc.ts) and `KeyRemapSection.tsx`.
 */
export type KeyBindingKind =
  'key' | 'consumer' | 'system' | 'lighting' | 'macro' | 'unused' | 'unknown';

export interface KeyBinding {
  /** firmware matrix slot (see KeyLayoutEntry.slot), not the layout array index */
  slot: number;
  /** HID usage as lowercase hex ("04" = A), or null when this isn't a plain key */
  code: string | null;
  kind: KeyBindingKind;
  /** best-effort display label ("Vol +", "Backlight +", "Print Screen") — plain
   *  English, matching the existing untranslated-vendor-data convention (see
   *  mouse-buttons.ts's `labelEn`) */
  label?: string;
  /** the same label cut to fit a keycap legend ("Vol +", "Play", "Br -") —
   *  a 1u cap holds about six characters, so the full name is tooltip-only */
  shortLabel?: string;
  /** raw 4-byte vendor quad, for the tooltip / diagnostics */
  raw: [number, number, number, number];
  /** true when the firmware owns this binding and the UI should treat it as
   *  non-remappable (a vendor-UI-parity guess, not a confirmed firmware
   *  refusal — see KB_FN_DEFAULT_SLOTS) */
  locked?: boolean;
  /** 'device' = decoded from a live GET reply that matched the vendor
   *  defaults well enough to trust the offset guess; 'vendor-default' = we
   *  couldn't confirm the live decode and fell back to the known factory
   *  table; 'unknown' = neither */
  provenance: 'device' | 'vendor-default' | 'unknown';
}

/** One saved static per-key lighting layout — see main/lighting/store.ts. */
