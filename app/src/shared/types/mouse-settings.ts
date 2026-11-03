/**
 * Per-profile mouse settings: DPI, sensor, power, buttons, performance.
 *
 * Split out of the former shared/types.ts.
 */

export interface DpiStage {
  index: number;
  dpi: number;
  color: [number, number, number];
  enabled: boolean;
}

/**
 * One pairing-progress probe. `null` means the receiver itself did not answer,
 * which is no evidence either way — only an observed `linked: false` followed
 * by `linked: true` says a pairing completed.
 */
export interface PairingStatus {
  /** The DEVICE is answering across the wireless link right now — not merely
   *  that the receiver is plugged in, which is all `LiveDevice.online` can
   *  attest for a dongle-attached mouse. */
  linked: boolean;
}

export interface SensorSettings {
  /** lift-off distance as the device WIRE value (see DeviceSpec.lodOptions), not mm */
  lod?: number;
  motionSync?: boolean;
  angleSnapping?: boolean;
  rippleControl?: boolean;
  highFpsScan?: boolean; // 20 kHz scanning
  longDistanceMode?: boolean;
  /** performance / "Select mode" wire value — 0 LP, 1 HP, 256 Corded
   *  (`SENSOR_MODES` in mouse-options.ts). Corded is cable-auto on the V8. */
  sensorMode?: number;
  /** Whether angle compensation is active at all. There is no such bit on the
   *  wire — the vendor Hub has only a slider, so the driver DERIVES this from
   *  `angleDegrees !== 0` on read and ignores it on write. The UI keeps it as
   *  its own enable toggle; the two must never disagree. */
  angleMode?: boolean;
  /** Degrees, `ANGLE_RANGE` (-30..30), default 0 = off. An ordinary verified
   *  scalar: `V8_BLOCK.ANGLE_DEGREES` (0xBD), signed two's-complement byte.
   *  See mouse-wire.ts for the captured frames behind both. */
  angleDegrees?: number;
}

export interface PowerSettings {
  /** idle seconds before light sleep; 0 = never */
  sleepTimerSec: number;
  /** idle seconds before deep sleep (radio fully off); 0 = never / unsupported */
  deepSleepSec?: number;
  /** convenience mirror of sleepTimerSec === 0 */
  never?: boolean;
}

/**
 * Per-key Hall-effect switch behaviour. `mode` is the vendor's key-mode enum
 * (normal / DKS / mod-tap / two toggle flavours / snap-tap); Rapid Trigger is
 * the orthogonal `rapidTrigger` flag layered on top of `mode: 'normal'`.
 */

export interface ButtonMapping {
  /** action key from `BUTTON_ACTIONS_TREE` (mouse-buttons.ts), e.g. 'dpiSwitch' */
  actionKey: string;
  /** region-A action byte (redundant with actionKey; kept for read-back decode) */
  action: number;
  /** vendor child value for button / dpi-switch / scroll sub-selection */
  param?: number;
  /** HID consumer usage for a multimedia binding */
  multimedia?: number;
  /** HID key usages for a combo (up to 3) */
  combo?: number[];
  /** onboard macro slot (1-based) + repeat byte, for a macro binding */
  macroSlot?: number;
  macroRepeat?: number;
  /** library macro id the UI bound (resolved to a slot on write) */
  macroId?: string;
  fire?: FireKeySettings;
}

/** Rapid-fire ("Firepower") parameters for a button set to the fire action. */
export interface FireKeySettings {
  /** clicks per press, 0-3 (0 = repeat while held) */
  times: number;
  /** ms between clicks, 10-255 */
  interval: number;
}

/**
 * "Highest performance" mode — the vendor keeps the sensor in a high-power
 * state and drops back to normal after `timeoutSec` idle. No wire path on the
 * V8 (the Hub greys it out); modelled for a future mouse that has it.
 */
export interface PerformanceSettings {
  enabled: boolean;
  /** idle seconds before dropping back to normal power (see PERFORMANCE_TIMEOUTS) */
  timeoutSec: number;
}

/**
 * DPI Dynamic Sensitivity — the sensor raises DPI as the mouse moves faster.
 * `mode` is the vendor `dpiModeOptions` value (1 Classic / 2 Natural / 3 Jump /
 * 0 Custom); `curve` is the 4-point custom profile. No V8 wire path yet.
 */
export interface DpiDynamicSettings {
  mode: number;
  curve?: number[];
}
