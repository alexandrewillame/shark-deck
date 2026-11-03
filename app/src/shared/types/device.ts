/**
 * Static per-model facts: the descriptor a catalog entry declares, and its spec.
 *
 * Split out of the former shared/types.ts.
 */
import type { Capability } from './capability';
import type { KeyLayoutEntry } from './keys';

export type DeviceKind = 'mouse' | 'keyboard' | 'dongle' | 'unknown';

export type ConnectionType = 'usb' | 'bt' | '2.4g' | 'unknown';

export type Provenance = 'verified-capture' | 'ported-from-vendor' | 'inferred';

/** Static, code-defined description of a supported model. */
export interface DeviceDescriptor {
  /** stable slug, e.g. "attack-shark-v8" */
  model: string;
  displayName: string;
  vendor: string;
  kind: DeviceKind;
  vid: number;
  pid: number;
  /**
   * Model id the firmware reports via `GET_USB_VERSION`, when known.
   *
   * VID/PID does NOT identify these boards — ~99 keyboards share
   * `0x3151:0x5029` and the vendor tools disambiguate on this id. Set it and
   * `resolveModelId()` will correct a VID/PID mis-resolution once the device
   * answers. Omit it for descriptors that were never matched to a vendor row.
   */
  modelId?: number;
  /** HID usage page of the vendor config collection (matched, never the path) */
  usagePage: number;
  usage: number;
  /** output/input report length in bytes, including the leading report id */
  reportLength: number;
  /**
   * How the vendor collection is driven:
   *  - 'output-report'  : WriteFile / ReadFile (the V8 mouse dongle)
   *  - 'feature-report' : HidD_SetFeature / HidD_GetFeature (the R85HE keyboard)
   */
  transport: 'output-report' | 'feature-report';
  /** checksum scheme used on the vendor collection */
  checksum: ChecksumScheme;
  /** driver class key — see drivers/registry */
  driver: string;
  capabilities: Capability[];
  /** per-model tuning data (DPI range, button count, key matrix, …) */
  spec: DeviceSpec;
  /** how well the protocol for this model is trusted */
  provenance: Provenance;
  /**
   * This descriptor is the cable-attached variant of a device that also has a
   * wireless one.
   *
   * The Attack Shark V8 enumerates as `3554:F517` through its 8K dongle and as
   * `3554:F515` over USB-C — same vendor id, same vendor collection, same
   * protocol, same serial, but a genuinely different endpoint. Nothing about
   * the VID/PID pair says which is which, so the connection type and the
   * battery/power UI cannot be derived from it; this says so explicitly.
   *
   * It also decides which side `bcdDevice` describes: over the dongle that is
   * the receiver's firmware, over the cable it is the mouse's own. See
   * `CompxMouse8K.getFirmware`.
   */
  wired?: boolean;
  /** relative art path under assets/devices, or null for the generic silhouette */
  art: string | null;
  /** cosmetic colour/edition photos available for this model, if any — see DeviceColorVariant */
  colorVariants?: DeviceColorVariant[];
  /**
   * True only for descriptors synthesised by developer mode (see
   * main/devices/virtual.ts) — never a real device. Every path that would
   * write to a per-model on-disk store checks this first, so a simulated
   * device can never pollute the colours / profile names / software profiles
   * / backups belonging to real hardware of the same model.
   */
  simulated?: boolean;
}

/**
 * Trailing-byte schemes (`shark-sum` for the V8, the historical `bit7`/`bit8`
 * reconstructions) plus `compx-fea`, the **verified** Attack Shark keyboard
 * scheme: `frame[k] = (0xFF - Σ frame[1 .. k-1]) & 0xFF`, where `k` is 8 —
 * or 9 for SET_LEDPARAM (0x07) / SET_SLEDPARAM (0x08). Arguments are laid from
 * byte 2 and STEP OVER the checksum slot; bulk payload after `k` is not summed.
 *
 * Confirmed twice: verbatim frames from the 2515-frame R85HE capture
 * (hid/checksum.test.ts), and qmk.top's own `___encodeCmd`, which computes
 * `r[7] = 255 - (sum(r[0..6]) & 255)` over the 64-byte payload — the same byte
 * once the leading report id is counted. The vendor calls these `CheckSumType`
 * `Bit7` (k=8) and `Bit8` (k=9).
 */
export type ChecksumScheme = 'shark-sum' | 'bit7' | 'bit8' | 'compx-fea' | 'none';

/**
 * One selectable cosmetic colour/edition of a model — purely a display
 * choice (which product photo to show), never written to the device. See
 * `main/devices/colors.ts` for where the user's pick is persisted and
 * `renderer/components/deviceArtAssets.ts` for the id -> image mapping.
 */
export interface DeviceColorVariant {
  /** stable slug matched against deviceArtAssets.ts, e.g. "black" */
  id: string;
  labelKey: string;
  /** CSS colour/gradient for the picker swatch */
  swatch: string;
}

export interface DeviceSpec {
  profileCount?: number;
  dpi?: { min: number; max: number; step: number; stages: number; sensor?: string };
  pollRates?: number[]; // Hz
  buttons?: number;
  /** keyboard physical layout for the interactive map */
  keyMatrix?: { rows: number; cols: number; layout?: KeyLayoutEntry[] };
  /** Magnetic switch model ids this board can be told it has, in the order the
   *  picker should offer them — see shared/keyboard-switches.ts. The first is
   *  the model's stock switch, which is also what a stored 0 resolves to.
   *  Absent means the canonical six. */
  supportedSwitches?: number[];
  lighting?: { zones: string[]; perKey?: boolean };
  screen?: { width: number; height: number; type: 'oled' | 'lcd' | 'tft' };
  sleepTimerRange?: { min: number; max: number }; // seconds
  /**
   * Lift-off-distance settings the sensor actually accepts, as {wire value, mm}.
   * The V8's PAW3950 does 0.7 / 1 / 2 mm (vendor Mouse Hub `LODOptions`), which
   * is NOT a plain 1/2 index. Absent means the model exposes no LOD control.
   */
  lodOptions?: LodOption[];
  /** key-response-time range in ms, if the mouse has the control */
  debounceRange?: { min: number; max: number };
  /** physical button index -> wire slot number (physical order != slot order
   *  on the V8). Absent means index === slot. */
  buttonSlotOrder?: number[];
  /** which BUTTON_ACTIONS_TREE keys this model offers; absent = the V8 set */
  buttonActions?: string[];
  /** true if the sensor exposes an LP/HP performance-mode select */
  sensorModes?: boolean;
  /** DPI dynamic-sensitivity curve modes, if the model has that pane */
  dpiDynamicModes?: { value: number; label: string }[];
  /** body-light-strip zones (future mice with `mouseLighting`) */
  bodyLightZones?: string[];
  /**
   * Physical position of each mouse button, for numbered badges laid over
   * the device's own product photo instead of a plain numbered list — see
   * components/PersistentDeviceArt.tsx, which draws them directly on the
   * one travelling photo. Optional — a model with `buttons` set but no
   * `buttonMap` still gets the numbered-list UI, it just can't show badges
   * on the photo.
   */
  buttonMap?: ButtonMapEntry[];
}

/** One selectable lift-off distance: the byte written to the device and its mm label. */
export interface LodOption {
  /** value written on the wire (0.7 mm is wire 3 on the V8, not 0) */
  wire: number;
  /** physical distance in millimetres, for the label */
  mm: number;
}

/** One physical mouse button's position, for the graphical button picker. */
export interface ButtonMapEntry {
  /** matches the index used by readButtons()/setButton() */
  index: number;
  /** display label, e.g. "Left", "Side 1" — untranslated fallback */
  label: string;
  /** i18n key for the label, preferred over `label` when present */
  labelKey?: string;
  /** position as a percentage of the device's product photo (0-100, top-down
   *  framing — see components/PersistentDeviceArt.tsx) */
  x: number;
  y: number;
  /** true if this button cannot be reassigned (e.g. left click). Falls back
   *  to "index === 0" when absent, for a model with no explicit buttonMap. */
  locked?: boolean;
  /** This button isn't visible in the top-down product photo (e.g. a DPI
   *  switch on the underside) — its badge is drawn at a best-guess spot on
   *  the shell, styled dashed/dimmed rather than solid. */
  notVisibleInPhoto?: boolean;
}
