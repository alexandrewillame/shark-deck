/**
 * One Attack Shark keyboard as the vendor's own device registry describes it:
 * the input `buildKeyboardDescriptor` (keyboard-builder.ts) turns into a
 * `DeviceDescriptor`.
 *
 * The rows live in `generated/keyboard-rows.ts`, written by `npm run import:kb`
 * from sharkfin's registry (https://github.com/dniminenn/sharkfin,
 * GPL-3.0-or-later), which is itself extracted from the vendor app's device
 * table and firmware. Never hand-edit the generated file; change the importer
 * (`scripts/import-keyboard-registry.ts`) or its override tables instead.
 */

/**
 * The firmware command set. `gen2` is the R85HE's (Driver v4 class 5e635fe2,
 * keymap opcode 0x0A); `yc500` is the older YC3121 set (class 438d24dc, keymap
 * opcode 0x09). They share framing but NOT opcodes — several numbers mean
 * destructive, different things in the other family — so this is decided from
 * the row, never probed. `unknown` = the registry does not say which set the
 * board speaks (sharkfin keeps such boards read-only, and so do we).
 */
export type KeyboardFamily = 'gen2' | 'yc500' | 'unknown';

/** One travel-setting range, in millimetres. */
export interface TravelRange {
  min: number;
  max: number;
  step: number;
  default: number | null;
}

export interface KeyboardRow {
  /** firmware model id (identify 0x8F / GET_USB_VERSION) — the only reliable identity */
  id: number;
  /** stable per-model store key, from generated/slugs.lock.json; never renamed */
  slug: string;
  /** marketing name without the brand, e.g. "X68 PRO HE" */
  name: string;
  /** the vendor's display name, verbatim */
  vendorName: string;
  /** vendor internal name, e.g. "ry5088_sg9047_1m_8k"; its prefix is the firmware lineage */
  internalName: string;
  vid: number;
  pid: number;
  family: KeyboardFamily;
  /** vendor layout stem, e.g. "Common79_SG9047"; "Unknown" when the vendor has none */
  layout: string;
  /**
   * Key into `generated/vendor-layouts.ts` when this board's slot map is
   * known (every key addressable); null = whole-board settings only. Usually
   * the stem itself; `<stem>#<id>` when the slots came from this board's own
   * factory matrix rather than from the shared picture.
   */
  slotLayout: string | null;
  /** onboard profiles (vendor `layer`) */
  profiles: number;
  magnetic: boolean;
  /** vendor `other.travelSetting`, when the row carries one (few do) */
  travel: {
    travel?: TravelRange;
    firePress?: TravelRange;
    fireLift?: TravelRange;
    deadzone?: TravelRange;
  } | null;
  switchReplaceable: boolean;
  /** the vendor's switch menu for this board, in order; empty = none listed */
  switchTypes: { code: number; name: string }[];
  /** a display the protocol can upload to — recorded, not exposed (no protocol yet) */
  screen: { w: number; h: number } | null;
  /** a remappable knob — recorded, not exposed */
  knob: boolean;
  /** the vendor UI offers a debounce control */
  debounce: boolean;
  /** 2.4 GHz / Bluetooth sleep timers: the only reliable sign of a wireless board */
  sleep24: boolean;
  sleepBT: boolean;
  /** a physical edge light; the firmware answers its GET whether or not one is fitted */
  sideLight: boolean;
  /**
   * Max report rates parsed from the internal name's `_8k` / `_1k` tokens —
   * first = cable, second = 2.4 GHz. OUR inference from the naming pattern,
   * not a vendor field; null where the name carries no token.
   */
  rates: { cable: number | null; wireless: number | null };
  /** yc500 boards whose firmware drops single-slot keymap writes */
  bulkKeymap: boolean;
}
