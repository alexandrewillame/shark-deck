/**
 * Per-key magnetic actuation and board-wide keyboard options.
 *
 * Split out of the former shared/types.ts.
 */

export type MagneticMode = 'normal' | 'dks' | 'mt' | 'tgl_hold' | 'tgl_dots' | 'snap';

/**
 * The per-zone bindings of a mod-tap or DKS key, by matrix slot. Index = the
 * zone byte of `SET_KEYMATRIX`; each entry is what `setKeyRemap` takes — 1-4
 * hex digits (a HID usage) or 8 (a raw quad) — '' is nothing bound there, and
 * null is a zone left as the board has it (never sent).
 *
 * Zone 0 is the key's own binding, the one the Remap tab edits. A DKS key
 * leaves it alone (null) — it is the first action — and adds up to three more
 * in zones 1-3. A MOD-TAP key is the exception: the firmware fires zone 0 on a
 * HOLD, so its entry is `[hold, tap]`, the key's own binding moved to zone 1
 * as the tap (shared/key-zones.ts). An entry with something in zone 0 is
 * therefore always a mod-tap key's, and the driver puts the tap back in zone 0
 * when the key leaves mod-tap. `[null, hold]` is the old, inverted shape.
 *
 * The board offers no read-back for the zones past 0 that this app
 * understands, so these are what SharkDeck last wrote, kept on this computer.
 */
export type KeyZoneBindings = Record<number, Array<string | null>>;

/** One key's zone bindings by position, the way a saved layout keeps them —
 *  beside `keys`, which are by position too. */
export interface KeyZoneBindingEntry {
  row: number;
  col: number;
  zones: Array<string | null>;
}

export interface MagneticKeySettings {
  row: number;
  col: number;
  actuationMm: number; // press travel before the key registers
  releaseMm?: number; // travel at which it releases (normal mode)
  rapidTrigger: boolean;
  rtPressMm?: number; // rapid-trigger re-press sensitivity
  rtReleaseMm?: number; // rapid-trigger release sensitivity
  deadZoneMm?: number; // top dead zone
  /** bottom dead zone — travel at the very bottom of the stroke that is
   *  ignored (MM_PAGE.DEADZONE_BOTTOM on the R85HE). */
  deadZoneBottomMm?: number;
  /** bit 6 of the firmware mode byte: the key only reports at full bottom-out.
   *  Read back and written through so a value set in the vendor app survives an
   *  edit here; no UI yet. */
  fullBottomOut?: boolean;
  mode?: MagneticMode;
  /** dynamic-keystroke actuation point in mm (mode 'dks'); the per-zone key
   *  actions (vendor page 8) are not modelled yet. */
  dksPointMm?: number;
  /**
   * SOCD / snap-tap partner (mode 'snap'). On the wire each key of a pair holds
   * the other's matrix slot in page 9, so a pair is two keys that name each
   * other. Null/absent leaves the pairing untouched.
   */
  socdPartner?: { row: number; col: number } | null;
  /** mod-tap hold time in ms (mode 'mt'); stored on the wire as `ms / 10`. */
  mtHoldMs?: number;
  /**
   * Dynamic-keystroke zones (mode 'dks') — exactly four, one per action bound
   * to a different depth of the same press. Magnetic page 8 holds them as four
   * bytes per key; see shared/dks.ts for the encoding.
   */
  dksZones?: import('../dks').DksZone[];
}

/**
 * The keyboard's `KBOPTION` register (`SET_KBOPTION` 0x09 / `GET_KBOPTION` 0x89),
 * one frame holding five unrelated switches. Decoded from qmk.top's
 * `___getKBOption_ry5088` and confirmed against an R85HE: the reply is
 * `[FnOS, fnProfile, anti-mistouch, RTStab/25, swapWASD]` from byte 2.
 *
 * Because it is a single register, changing one field means writing all five —
 * `setKeyboardOptions` merges over the last read rather than defaulting the
 * others to zero.
 */
export interface KeyboardOptions {
  /** Fn layout the board is in: Windows or macOS */
  fnOs: 'win' | 'mac';
  /** which Fn profile slot is live */
  fnProfile: number;
  /** vendor "防误触": ignores implausibly fast repeat presses */
  antiMistouch: boolean;
  /**
   * Rapid-trigger stabilisation, 0..125 in steps of 25 (the wire value is
   * `n / 25`, and anything above 5 reads back as 0). Damps jitter around the
   * reversal point; only meaningful with rapid trigger armed.
   */
  rtStab: number;
  /**
   * Swap WASD with the arrow cluster in hardware — byte 6 of the register.
   *
   * **Read and preserved, never offered as a control.** The toggle was removed
   * after it made no difference on an R85HE: the frame we send is right (the
   * register layout is `verified-capture` and the checksum checks out), so the
   * firmware stores the bit and does not act on it. Exposing a switch that
   * does nothing is worse than not having one.
   *
   * The field stays because all five switches share one wire frame: dropping
   * it would make every write send 0 here and silently clear a swap someone
   * had set in the vendor software. Round-tripping the board's own value
   * leaves it alone.
   */
  swapWasd: boolean;
}

/**
 * A named set of keys that share one set of actuation settings.
 *
 * The Actuation tab edits whatever is selected on the board, which means the
 * selection has to be rebuilt by hand every time — and a board whose keys have
 * been tuned in three or four clusters (WASD, the number row, the modifiers)
 * gives no indication of which keys belong together. A group makes that
 * durable: name it, colour it, and the board says at a glance which keys it
 * covers.
 *
 * `slots` are firmware matrix slots (`KeyLayoutEntry.slot`) — the same index
 * every per-key wire operation uses — so a group survives a layout change the
 * way `PerKeyLightingPreset.colors` does. A key belongs to at most one group;
 * adding it to a second removes it from the first (see `assignToGroup`).
 */
export interface KeyGroup {
  id: string;
  name: string;
  /** CSS colour, painted as a stripe on each member key. */
  color: string;
  slots: number[];
}

/**
 * A saved actuation layout: every key's settings plus the groups that
 * organised them.
 *
 * The same shape and the same load/apply split as `PerKeyLightingPreset` —
 * `model` is recorded for the same reason, since both are slot-indexed and
 * applying one board's layout to another silently addresses the wrong keys.
 */
export interface ActuationLayout {
  id: string;
  name: string;
  createdAt: number;
  model?: string;
  keys: MagneticKeySettings[];
  groups: KeyGroup[];
  /**
   * The Mod-tap holds and DKS actions of the layout's keys in those modes.
   * They are key bindings, not magnetism pages, so `keys` cannot carry them —
   * and a layout without them put a key back into Mod-tap with whatever hold
   * the board happened to have. Absent in layouts saved before they were
   * kept, and when no key uses them.
   */
  zoneBindings?: KeyZoneBindingEntry[];
}
