/**
 * Live device state: what the manager reports to the renderer, the UI bounds
 * that come with it, and the result shape every write returns.
 *
 * Split out of the former shared/types.ts.
 */
import type { Capability } from './capability';
import type {
  ButtonMapEntry,
  ConnectionType,
  DeviceColorVariant,
  DeviceKind,
  IdentityStatus,
  LayoutStatus,
  LodOption,
  MagneticSpec,
  Provenance,
} from './device';
import type { KeyLayoutEntry } from './keys';

export interface LiveDevice {
  /** unique per physical endpoint: `${model}:${serialOrPath}` */
  id: string;
  model: string;
  displayName: string;
  kind: DeviceKind;
  vid: number;
  pid: number;
  connection: ConnectionType;
  /**
   * true when the device runs off a battery over a radio link (any mouse, or a
   * keyboard that answered GET_RF_VERSION). Wired-only devices hide Power and
   * the battery pill.
   */
  wireless: boolean;
  /** true when the endpoint answers; a dongle can be present with device offline */
  online: boolean;
  /**
   * The device is unreachable but its receiver is still plugged in.
   *
   * Distinct from plain `online: false`, which also covers a wired device
   * that was unplugged. Here the dongle still enumerates and answers — the
   * mouse itself is off, asleep, flat, or unpaired — so the card greys out
   * rather than disappearing, and the hint can say which of those to check.
   */
  receiverOnline: boolean;
  /** 0..100, or null when unknown / not battery powered */
  battery: number | null;
  charging: boolean;
  /**
   * Diagnostic detail behind `battery`, so a mismatch against the vendor Hub
   * can be tracked down: the raw single-byte percent the firmware reports
   * (`reply[6]` of the `0x04` battery poll) and the cell voltage in
   * millivolts read from the same reply, which `battery` is derived from via
   * the vendor's own `BATTERY_CURVE`. Null on devices/drivers that don't
   * decode voltage.
   */
  batteryRaw: number | null;
  batteryMillivolts: number | null;
  /** active onboard profile index (1-based) or null if unread */
  activeProfile: number | null;
  /**
   * Live hardware state, refreshed while a device's config screen is open (see
   * `setLiveWatch` and `DeviceManager.readLiveState`). These exist because the
   * mouse's own buttons change them with no app involvement, so a value read
   * once when a tab mounted goes quietly out of date. Null until first read,
   * and on any device whose driver has no cheap probe for them.
   */
  activeDpiStage: number | null;
  /** The DPI of the active stage. Derived in the manager from the last stage
   *  table it read, so tracking it costs no extra frames. */
  activeDpi: number | null;
  /** Report rate in Hz as the device currently has it — distinct from
   *  `ui.pollRates`, which is the list of rates this model offers. */
  pollRate: number | null;
  /** user-given names for this model's onboard slots, sparse — an unset slot
   *  falls back to "Profile {n}" (see slotLabel() in renderer/state/ui.ts) */
  profileNames: Record<number, string>;
  firmware: FirmwareInfo | null;
  capabilities: Capability[];
  provenance: Provenance;
  art: string | null;
  /** the user's chosen cosmetic colour/edition id (DeviceColorVariant.id), or
   *  null if unset — always falls back to the generic silhouette until set */
  colorVariant: string | null;
  /** short human hint for the card tooltip, e.g. offline guidance */
  hint: string | null;
  /** true once a full config backup exists on disk for this endpoint */
  hasBackup: boolean;
  /**
   * Present while the device waits for the user's one-time OK before its
   * first write: it cannot report `unreadable` back, so a backup cannot hold
   * them (drivers/base.ts `BackupPolicy`). Cleared by `acknowledgeNoBackup`.
   */
  backupWaiver?: { unreadable: Capability[] };
  /** renderer-facing slice of the static spec — see DeviceUi */
  ui: DeviceUi;
}

export interface FirmwareInfo {
  device: string | null;
  receiver: string | null;
  latest?: string | null;
  /** raw uint16 as read off the wire — magnetism travel-step scaling keys on it */
  deviceRaw?: number;
  receiverRaw?: number;
  /** why `device` is null: 'noReply' = the device never answered the version
   *  query at all; 'asleep' = it is reachable but the query has to cross a
   *  wireless link the device is not currently listening on, so the answer is
   *  a wiggle away rather than unavailable. Absent/undefined means a
   *  successful read (or a driver that hasn't been updated to set this yet). */
  readState?: 'ok' | 'noReply' | 'asleep';
}

/**
 * The slice of a device's static `DeviceSpec` the renderer needs to drive its
 * controls. Copied onto `LiveDevice` in the manager so the renderer never has to
 * import `src/main` and never hard-codes profile/button/timer ranges.
 */
export interface DeviceUi {
  profileCount: number;
  pollRates: number[];
  dpiRange?: {
    min: number;
    max: number;
    step: number;
    stages: number;
    colorPerStage?: boolean;
    /** above `dpi`, the sensor only stores multiples of `step` */
    coarseAbove?: { dpi: number; step: number };
  };
  buttons?: number;
  /** physical position per button, for the graphical picker — absent (or a
   *  model with `buttons` but no map) falls back to the numbered-list UI. */
  buttonMap?: ButtonMapEntry[];
  keyMatrix?: {
    rows: number;
    cols: number;
    layout?: KeyLayoutEntry[];
    layoutStatus?: LayoutStatus;
  };
  /** magnetic-switch limits (absent parts fall back to KB_TRAVEL_RANGE) */
  magnetic?: MagneticSpec;
  /** debounce choices in ms, when the model narrows the generic presets */
  debouncePresets?: number[];
  /** how the device was identified; absent = a named model (see IdentityStatus) */
  identity?: IdentityStatus;
  /** for a read-only card: what the device said it is */
  identityNote?: string;
  /** switch models this board offers, stock switch first (replaceableSwitches) */
  supportedSwitches?: number[];
  lightZones: string[];
  perKeyLighting: boolean;
  /** sleep-timer presets in seconds; 0 means "never" */
  sleepPresets: number[];
  /** lift-off-distance options for this model, or undefined if it has none */
  lodOptions?: LodOption[];
  /** key-response-time range in ms (mouse debounce), if any */
  debounceRange?: { min: number; max: number };
  /** physical button index -> wire slot number, if it differs from identity */
  buttonSlotOrder?: number[];
  /** which BUTTON_ACTIONS_TREE keys this model offers */
  buttonActions?: string[];
  /** true if the sensor exposes an LP/HP performance-mode select */
  sensorModes?: boolean;
  /** DPI dynamic-sensitivity modes, if the model has that pane */
  dpiDynamicModes?: { value: number; label: string }[];
  /** body-light-strip zones (future mice with `mouseLighting`) */
  bodyLightZones?: string[];
  /** cosmetic colour/edition photos available for this model, empty if none */
  colorVariants: DeviceColorVariant[];
  /** the photo set (shared/device-art.ts): `DeviceDescriptor.artKey`, else the model */
  artKey: string;
  /** onboard macro-slot limits, so the macro editor can show a capacity meter
   *  without the renderer knowing anything about either wire format. Absent on
   *  models without the `macros` capability. `delaysConsumeSteps` is the one
   *  thing that differs between the two codecs: the keyboard spends a whole
   *  step record on each delay, while the V8 folds a delay into the following
   *  record's own delay field, so the same step list costs a different number
   *  of slots on each. */
  macroLimits?: MacroLimits;
}

export interface MacroLimits {
  /** step records one onboard slot holds */
  maxSteps: number;
  /** how many macros the device stores onboard */
  slots: number;
  /** name-field length, or absent when the device stores no name at all */
  nameMax?: number;
  delaysConsumeSteps: boolean;
}

// ---------------------------------------------------------------------------
// Settings payloads — one shape per writable feature group.
// Each write returns a WriteResult with read-back verification status.
// ---------------------------------------------------------------------------

export interface WriteResult {
  ok: boolean;
  /** did a GET read-back confirm the value? 'unverified' = no GET available */
  verified: 'match' | 'mismatch' | 'unverified';
  error?: string;
  /** frame bytes sent, hex, for the developer log */
  frames?: string[];
  /**
   * A caveat about *part* of a multi-field write that otherwise succeeded —
   * one `inferred` offset that didn't read back, next to fields that did.
   *
   * `verified` stays the verdict for the CONFIRMED fields. This is what stops
   * a byte we are not certain the firmware even owns (the DPI-LED speed at
   * 0x50, the mouse angle at 0xB3) from reporting a failure for the writes
   * that demonstrably landed — and collapses what used to be three separate
   * warnings for one action into a single honest one. See
   * `CompxMouse8K.writeSpeculative` and `useWrite` in renderer/tabs/common.tsx.
   */
  note?: string;
}

/**
 * The answer to opening a live per-key travel stream.
 *
 * `unsupported` says the device has no such stream at all — as opposed to one
 * that failed to start (a refused or lost write), which is worth another try.
 * The Test view shows the two differently: one is a fact about the keyboard,
 * the other a moment.
 */
export interface TravelStreamResult {
  ok: boolean;
  error?: string;
  unsupported?: boolean;
}

/**
 * The slice of device state an ON-DEVICE button or shortcut can change behind
 * the app's back — so it is the slice worth re-reading on a cadence while
 * someone is looking at that device's screen.
 *
 * Deliberately tiny. A driver implementing `readLiveState` promises it is far
 * cheaper than the individual `read*` methods: on the V8 all three fields live
 * in the first ten bytes of region A, so one 17-byte request answers all of
 * them instead of the 22-frame sweep a `readPollRate()` + `readActiveDpiStage()`
 * pair would trigger. Each field is null when that particular value could not
 * be read.
 */
export interface LiveState {
  activeDpiStage: number | null;
  /** How many stages the device cycles right now. Lets the manager notice that
   *  the stage table changed without re-reading the table every poll. */
  dpiStageCount: number | null;
  pollRate: number | null;
}
