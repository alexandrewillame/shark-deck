/**
 * Lighting: per-key, side/underglow, receiver LED and DPI indicator.
 *
 * Split out of the former shared/types.ts.
 */

export interface PerKeyLightingPreset {
  id: string;
  name: string;
  createdAt: number;
  /** the device model this was captured from — slot spaces differ per board,
   *  so applying across models is a guess (the UI warns). */
  model?: string;
  /** slot-indexed, same shape as PerKeyColor[] */
  colors: PerKeyColor[];
}

// ---------------------------------------------------------------------------
// Runtime device state — what the manager reports to the UI.
// ---------------------------------------------------------------------------

export interface LightingSettings {
  /**
   * Direction / variant index into the effect's own `options` list
   * (KB_LIGHT_EFFECTS_TABLE). Rides in the HIGH NIBBLE of the wire's option
   * byte, with the dazzle flag in the low nibble — vendor
   * `setLightSetting`: `o = option << 4 | (dazzle ? 8 : 7)`.
   * Undefined means 0, which is every effect's first option.
   */
  option?: number;
  zone: string;
  effect: string;
  brightness: number; // 0..100 (UI scale; drivers map to the wire scale)
  speed: number; // 0..100 (UI scale)
  color: [number, number, number];
  enabled: boolean;
  dazzle?: boolean; // vendor "dazzle"/rainbow variant of the effect
  /** mouse body strip only — turn the strip off while the mouse is moving */
  offWhenMoving?: boolean;
  /** mouse body strip only — idle seconds before the strip turns off (see LIGHT_OFF_TIMEOUTS) */
  offTimeoutSec?: number;
}

/** Side / underglow strip — its own short effect list, distinct wire layout. */
export interface SideLightingSettings {
  effect: string;
  brightness: number; // 0..100
  speed: number; // 0..100
  color: [number, number, number];
  enabled: boolean;
  /** "Shining" (automatic multicolour scheme) vs a fixed user colour — same
   *  `option = dazzle ? 8 : 7` wire convention as the main lighting zone's
   *  own `dazzle`, orthogonal to which effect is selected. */
  dazzle?: boolean;
}

/**
 * Extras for a per-key lighting write.
 *
 * Applying a picture is really two wire writes: the colour map itself
 * (SET_USERPIC), then switching the board's main effect onto the per-key layer
 * so the map is what displays (SET_LEDPARAM). The second one has to carry a
 * brightness, and taking it from a fresh read of the board is what produced
 * "applying a layout turns the lighting off" — so the caller can state it
 * instead. Undefined means "keep whatever the board has".
 */
export interface PerKeyLightingOpts {
  /** 0-100, same scale as `LightingSettings.brightness`. */
  brightness?: number;
  /**
   * Repaint only: skip the read-back AND the flip onto the per-key effect.
   *
   * A normal per-key write is 7 chunked writes, 6 chunked reads and a
   * GET_LEDPARAM — fine once, far too much for something repainting as the
   * user presses keys. The calibration overlay puts the board on the per-key
   * layer once at the start and then only changes colours, so re-asserting
   * the effect and re-reading the whole map on every repaint is pure traffic
   * on an endpoint that wedges under exactly that.
   *
   * The result is `verified: 'unverified'` — nothing was read back, and it
   * must not claim otherwise.
   */
  streaming?: boolean;
}

/** One key's colour in a per-key ("user picture") lighting layer. */
export interface PerKeyColor {
  /** index into the device key matrix (layout order) */
  index: number;
  color: [number, number, number];
}

/**
 * The USB receiver's three status LEDs on a wireless mouse. Each is
 * independently set to one of a restricted subset of
 * `RECEIVER_LED_INDICATION` (mouse-options.ts) — off / connection quality /
 * battery / poll rate; "DPI Level" and the separate decorative-light block
 * the vendor also exposes aren't offered here (see LightingTab.tsx).
 */
export interface ReceiverLedSettings {
  /** one wire value per physical LED, left to right */
  indications: [number, number, number];
  /**
   * Where these values came from, so the UI never has to guess how much to
   * trust them:
   *  - `device`    — read back off the hardware just now.
   *  - `lastWrite` — this process's own last write; no read answered.
   *  - `cache`     — a previous run's last write, from the per-model
   *                  scratchpad (main/devices/deviceState.ts).
   *  - `unreadable` — nothing to show. The receiver answered nothing and this
   *                  install has never written it, so the values are
   *                  placeholders and the pane says so. Deliberately NOT a
   *                  read *failure*: the device is fine, the command simply
   *                  has no confirmed read on this firmware.
   */
  source: 'device' | 'lastWrite' | 'cache' | 'unreadable';
}

/**
 * The same LEDs as a value to *write*. Provenance is a read-time answer to
 * "where did this come from", so it has no meaning on the way in — and a
 * stored profile must not carry a marker describing the moment it was
 * captured, or replaying it would assert that again later.
 */
export type ReceiverLedValues = Omit<ReceiverLedSettings, 'source'>;

/**
 * The DPI-indicator LED on the mouse body. `effect` is the vendor
 * `DPI_LED_EFFECTS` wire value (0 Off / 1 Steady / 2 Breathing). The colour it
 * shows per DPI stage is `DpiStage.color` (DPI Setting owns that memory block
 * solely — see docs/roadmap.md — so it isn't duplicated here).
 */
export interface DpiLedSettings {
  effect: number;
  brightness: number; // 0..100
  /** breathing-effect cycle speed, 0..100 UI scale. `inferred` wire offset
   *  (V8_BLOCK.DPI_LED_SPEED) — absent on a device/profile written before
   *  this field existed. */
  speed?: number;
  /**
   * The raw 0x52 byte as read, reported and never interpreted.
   *
   * It looks like an on/off gate and the driver mirrors the Hub by writing it,
   * but it reads 0 in all four factory profiles while the effect byte reads 2
   * (breathing) — so treating 0 as "the LED is off" would make every V8 out of
   * the box report an effect it isn't showing, which is a *new* false claim
   * rather than a fix. Surfaced in a `DevNote` only, so the byte can be
   * watched on hardware without ever reaching someone's LED settings.
   * See V8_BLOCK.DPI_LED_FLAG and FINDINGS.md "Still open" #9.
   */
  flagRaw?: number;
}

/**
 * One mouse button's assignment. Supersedes the bare action-string the older
 * driver used. `action` is the vendor category byte (`BUTTON_ACTIONS` in
 * mouse-options.ts, parsed to a number); the rest are the payload for the
 * actions that need one:
 *  - simple button / DPI-switch / scroll: `param` = the sub-value (HID mask,
 *    DPI-loop / +/- selector, scroll direction).
 *  - `multimedia`: a HID consumer-usage code.
 *  - `combo`: up to 3 HID key usages.
 *  - `macro`: the library macro id; the driver resolves it to an onboard slot.
 *  - fire-key (turbo): `fire`.
 */
