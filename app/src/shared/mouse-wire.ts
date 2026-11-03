/**
 * V8 mouse wire-protocol constants that come from the 2026-08-30 Frida capture
 * (docs/reverse-engineering/FINDINGS.md), NOT from any vendor file — so they
 * live here, hand-maintained, rather than in the auto-generated
 * `mouse-options.ts` (which `npm run extract` overwrites wholesale).
 *
 * Provenance: `verified-capture` for the region-A offsets, the companion-byte
 * rule, the `0x07` write command and the `0x2C`/`0x16` command bytes;
 * `inferred` for the DPI register formula (pending the Step-0 mini-capture —
 * see the plan) and the region-C macro layout (one macro observed).
 */

import type { DpiStage } from './types/mouse-settings';

/** Per-field integrity byte the firmware stores right after a written value —
 *  the same `0x55 - Σ` rule as the frame checksum, scoped to that field. A
 *  1-byte setting goes on the wire as `[v, companion(v)]`. */
export const companion = (...bytes: number[]): number =>
  (0x55 - bytes.reduce((s, b) => s + (b & 0xff), 0)) & 0xff;

/** `[value, companion]` — the wire encoding of a 1-byte setting. */
export const scalarBytes = (v: number): number[] => [v & 0xff, companion(v)];

/** `[r, g, b, companion]` — the wire encoding of an RGB colour field. */
export const rgbBytes = (r: number, g: number, b: number): number[] => [
  r & 0xff,
  g & 0xff,
  b & 0xff,
  companion(r, g, b),
];

/**
 * DPI <-> sensor register for the PAW3950 — **fully decoded from the
 * 2026-08-30 verify capture** (`session-v8-verify.jsonl`, exact DPI targets
 * 400 / 800 / 1600 / 3200 / 6350 / 12800 / 20000 / 25950):
 *
 *   register = round(dpi / 50) - 1          (dpi = (register + 1) * 50)
 *   payload  = [lo, lo, hiWire, companion]  where
 *     lo     = register & 0xff              (X and Y written equal)
 *     hbits  = (register >> 8) & 0x03       (0..3 — max 42000 DPI -> reg 839)
 *     hiWire = (hbits << 2) | (hbits << 6)  (0->0x00, 1->0x44, 2->0x88, 3->0xCC)
 *     companion = (0x55 - lo - lo - hiWire) & 0xff
 *
 * Verified: 400 -> `07 07 00`, 800 -> `0f 0f 00`, 12800 -> `ff ff 00`,
 * 20000 -> `8f 8f 44`, 25950 -> `06 06 88`.
 */
export const DPI_STEP = 50;
export const DPI_MIN = 50;
export const DPI_MAX = 42000;

export const dpiToRegister16 = (dpi: number, step = DPI_STEP): number => {
  const clamped = Math.max(DPI_MIN, Math.min(DPI_MAX, Math.round(dpi / step) * step));
  return Math.max(0, Math.round(clamped / step) - 1);
};
export const registerToDpi16 = (reg: number, step = DPI_STEP): number => (reg + 1) * step;

/** Pack a register (0..839) into the wire hi byte's smeared 2-bit field. */
const dpiHiWire = (reg: number): number => {
  const hb = (reg >> 8) & 0x03;
  return (hb << 2) | (hb << 6);
};
/** Recover a register from a captured `[lo, lo, hi, …]` triple. */
export const dpiRegFromBytes = (lo: number, hi: number): number =>
  (lo & 0xff) | (((hi >> 2) & 0x03) << 8);

/** `[lo, lo, hiWire, companion]` — the wire encoding of one DPI stage register. */
export const dpiRegBytes = (dpi: number, step = DPI_STEP): number[] => {
  const reg = dpiToRegister16(dpi, step);
  const lo = reg & 0xff;
  const hi = dpiHiWire(reg);
  return [lo, lo, hi, companion(lo, lo, hi)];
};

/**
 * A mouse always runs at *some* DPI — a stage set with nothing enabled is not
 * a state the hardware can be in, and the UI it produces is inert (no ticks on
 * the track, every value field disabled, no stage selectable). Returns the
 * array untouched when at least one stage is enabled; otherwise re-enables
 * `prefer` (clamped into range, falling back to the first stage). Applied by
 * the DPI section on every enable/remove, and again on both main-process write
 * paths so a profile stored before the UI guard existed can't reintroduce it.
 */
export function withEnabledDpiStage(stages: DpiStage[], prefer = 0): DpiStage[] {
  if (!stages.length || stages.some((s) => s.enabled)) return stages;
  const i = Math.min(stages.length - 1, Math.max(0, Math.trunc(prefer) || 0));
  return stages.map((s, j) => (j === i ? { ...s, enabled: true } : s));
}

/**
 * The stages a device will actually cycle. The wire has no per-stage disable —
 * only `DPI_STAGE_COUNT`, which makes slots `0..count-1` the cycled set — so a
 * disabled stage is *dropped* here, never merely flagged, and the survivors are
 * renumbered into the slots the device will read. That is what stops a stage
 * the UI shows as off from being one the mouse can land on.
 *
 * Applied on every write path (ipc.ts, the switcher, and the drivers
 * themselves), so a profile captured before the per-stage toggle was removed
 * can't replay a disabled stage onto hardware. Never returns empty for a
 * non-empty input: a mouse always runs at *some* DPI, so an all-disabled set
 * keeps `prefer` (see `withEnabledDpiStage`).
 */
export function applicableDpiStages(stages: DpiStage[], prefer = 0): DpiStage[] {
  return withEnabledDpiStage(stages, prefer)
    .filter((s) => s.enabled)
    .map((s, i) => ({ ...s, index: i, enabled: true }));
}

/** Clamp an active-stage index into `[0, count-1]`; anything unusable becomes 0. */
export function clampActiveDpiStage(i: number | null | undefined, count: number): number {
  if (count <= 0) return 0;
  const n = Math.trunc(Number(i));
  return Number.isFinite(n) ? Math.min(Math.max(0, n), count - 1) : 0;
}

/**
 * Region A — the per-profile onboard config block (0x0000..0x00D8). Content
 * follows whichever profile is currently active; there is no per-slot stride.
 * Read with command `0x08`, written with command `0x07`. Offsets are
 * big-endian in the frame. Every offset here is `verified-capture` unless
 * noted.
 */
export const V8_BLOCK = {
  POLL_RATE: 0x00, // 1B bitmask (see POLL_RATE_WIRE in mouse-options.ts)
  DPI_STAGE_COUNT: 0x02, // 1B, 2..6
  ACTIVE_DPI_STAGE: 0x04, // 1B, 0-based
  HIGH_FPS: 0x08, // 1B bool — 20 kHz scan
  LOD: 0x0a, // 1B wire value (0.7mm=3, 1mm=1, 2mm=2)
  DPI_STAGE_REG: 0x0c, // 4B per stage (lo,lo,hi,companion), 6 stages -> 0x0c..0x24
  DPI_STAGE_REG_STRIDE: 4,
  DPI_STAGE_COLOR: 0x2c, // 4B per stage (r,g,b,companion), 6 stages -> 0x2c..0x40
  DPI_STAGE_COLOR_STRIDE: 4,
  DPI_LED_EFFECT: 0x4c, // 1B (0 off / 1 steady / 2 breathing)
  DPI_LED_BRIGHT: 0x4e, // 1B 0..255 (read back 135 on hardware, 2026-09-07)
  /**
   * INFERRED — never written by the vendor Hub in either 2026-08-30 session
   * (cross-referenced against every 0x07 write offset it ever emitted). 0x50
   * is chosen because it holds a valid, all-zero-profile-constant (03, 52)
   * value/companion pair in all four profiles and sits inside the DPI-LED
   * field group on the same 2-byte stride (0x4C effect / 0x4E brightness /
   * 0x50 ? / 0x52 flag). The light-strip-shaped block at 0x54..0x5F that the
   * V8 doesn't otherwise use decodes as [colour 0x54][effect 0x58]
   * [bright 0x5A][speed 0x5C = 03][flag 0x5E = 00] — a byte-for-byte
   * structural parallel of this group, with the same 03 in the speed slot.
   * That, not a general "shared firmware enum" hunch, is the actual argument.
   *
   * 2026-09-07 hardware sweep: the byte accepted and read back every value
   * 0..5, and the live default on that mouse was 2 (3 in the capture images).
   * So it is writable RAM at minimum — but accepting a value is not the same
   * as acting on it, and nothing has yet confirmed the breathing pace changes.
   * Still `inferred`; still written via `writeSpeculative`.
   * >>> NOT TRUSTED until scripts/verify-mouse.mjs confirms a write/read-back
   *     cycle AND a visual check that the breathing LED's pace changes. <<<
   */
  DPI_LED_SPEED: 0x50,
  /**
   * INFERRED — NOT a confirmed on/off gate, despite the shape suggesting one.
   * Reads 00 in all four factory profiles while 0x4C reads 02 (breathing), so
   * "flag 0 means the LED is off" cannot be assumed; and the one time the Hub
   * wrote 01 here (05_dpi_effect_steady) the post-capture image shows it back
   * at 00 while the effect/brightness writes beside it survived. A 2026-09-07
   * hardware round-trip settled half of that: the byte DOES stick (written 01,
   * read back 01), so it is not a write that fails — it is a byte whose effect
   * on the LED nobody has watched yet. The driver mirrors
   * the Hub and writes it speculatively, and never lets its value override the
   * effect byte when reading. FINDINGS.md "Still open" #9.
   */
  DPI_LED_FLAG: 0x52,
  BUTTON_BASE: 0x60, // 4B per slot (action,param1,param2,companion)
  BUTTON_STRIDE: 4,
  DEBOUNCE: 0xa9, // 1B ms
  MOTION_SYNC: 0xab, // 1B bool
  SLEEP: 0xad, // 1B = idle seconds / 10, range 1..90
  ANGLE_SNAP: 0xaf, // 1B bool
  RIPPLE: 0xb1, // 1B bool
  /**
   * Mouse angle mode, in degrees — `verified-capture`, 2026-09-10.
   *
   * Located by hooking the vendor Hub's own writes while its angle slider was
   * dragged (`capture-mouse.py --angle` -> `session-v8-angle.jsonl`), which is
   * the only method that could settle it: 0xB3 was an earlier gap-analysis
   * guess, and every unclaimed slot in this odd-offset run accepts a write and
   * hands it straight back, so no write/read-back sweep can tell the real one
   * from the four wrong ones.
   *
   * The five captured frames also pin the encoding — a signed byte, two's
   * complement, exactly what `angleToWire` / `angleFromWire` already assumed:
   *
   *     +15 -> 08 07 00 00 bd 02 0f 46
   *     +30 -> 08 07 00 00 bd 02 1e 37
   *     -15 -> 08 07 00 00 bd 02 f1 64
   *     -30 -> 08 07 00 00 bd 02 e2 73
   *       0 -> 08 07 00 00 bd 02 00 55
   *
   * Second byte is the ordinary `companion()`, so `scalarBytes(angleToWire(d))`
   * reproduces each of these byte for byte.
   */
  ANGLE_DEGREES: 0xbd,
  SENSOR_MODE: 0xb9, // 1B (0 LP / 1 HP; Corded is cable-auto)
} as const;

/** How much of region A to snapshot for backup — the full 216-byte block. */
export const V8_PROFILE_DUMP_LEN = 0xd8;

/**
 * Physical button index (0-based, as the UI numbers them) -> wire slot number.
 * From the capture: UI button 4 writes slot 4's address and button 5 writes
 * slot 3's — i.e. 4 and 5 are swapped relative to slot order. Buttons 1/2
 * (left/right) inferred at slots 0/1.
 */
export const V8_BUTTON_SLOT_ORDER = [0, 1, 2, 4, 3, 5] as const;
export const v8ButtonOffset = (uiIndex: number): number =>
  V8_BLOCK.BUTTON_BASE + (V8_BUTTON_SLOT_ORDER[uiIndex] ?? uiIndex) * V8_BLOCK.BUTTON_STRIDE;

/**
 * Region B — extended button payloads (combo-key / multimedia HID-usage
 * records). Base 0x0100, stride 0x20, indexed by wire slot. Button 6 (slot 5)
 * -> 0x01A0, which is where the captured combo record landed. Record layout:
 * `[count, (flag, usage & 0xff, 0x00) × count, companion]` — flag high nibble
 * 0x80 press / 0x40 release, low nibble HID page 1 keyboard / 2 consumer /
 * 4 mouse. Clearing a record is the literal `[0x00, 0xFF]` (no companion).
 * `verified-capture` for both observed records.
 */
export const V8_BUTTON_EXT_BASE = 0x0100;
export const V8_BUTTON_EXT_STRIDE = 0x20;
export const v8ButtonExtOffset = (uiIndex: number): number =>
  V8_BUTTON_EXT_BASE + (V8_BUTTON_SLOT_ORDER[uiIndex] ?? uiIndex) * V8_BUTTON_EXT_STRIDE;
export const COMBO_FLAG_DOWN = 0x80;
export const COMBO_FLAG_UP = 0x40;
export const COMBO_PAGE = { key: 1, media: 2, mouse: 4 } as const;
export const BUTTON_EXT_CLEAR = [0x00, 0xff];

/**
 * Region C — macro storage, 16 slots of 0x180 bytes from 0x0480. Slot layout
 * (from the captured "test" macro, `verified-capture` for the arithmetic):
 *   base+0x00        name length
 *   base+0x01..0x1E  ASCII name, 0xFF-padded (30 bytes)
 *   base+0x1F        step count
 *   base+0x20 +      5-byte step records `[flag, usage, 0x00, delayHi, delayLo]`
 *                    (delay big-endian ms; flag = COMBO_FLAG_x | COMBO_PAGE_x)
 *   then a companion over [count .. last record byte].
 */
export const V8_MACRO_BASE = 0x0480;
export const V8_MACRO_STRIDE = 0x180;
export const V8_MACRO_SLOTS = 16;
export const V8_MACRO_NAME_LEN_OFF = 0x00;
export const V8_MACRO_NAME_OFF = 0x01;
export const V8_MACRO_NAME_MAX = 30;
export const V8_MACRO_COUNT_OFF = 0x1f;
export const V8_MACRO_BODY_OFF = 0x20;
export const V8_MACRO_STEP_BYTES = 5;
export const v8MacroOffset = (slot: number): number => V8_MACRO_BASE + slot * V8_MACRO_STRIDE;
/** Step records one slot holds: the body starts at V8_MACRO_BODY_OFF and is
 *  followed by a one-byte count and a one-byte companion checksum — the same
 *  arithmetic the encoder's own loop guard in mouse-macro-codec.ts enforces. */
export const V8_MACRO_MAX_STEPS = Math.floor(
  (V8_MACRO_STRIDE - V8_MACRO_BODY_OFF - 2) / V8_MACRO_STEP_BYTES,
);

/**
 * Command bytes on the 17-byte `0x08`-report channel. `WRITE_SETTING` (0x07)
 * and `RESTORE` (0x09) are the important correction over the pre-capture
 * driver, which used `0x09` for writes (it is a factory reset).
 */
export const V8_CMD = {
  GET_VERSION: 0x02,
  STATUS: 0x03,
  /**
   * The MOUSE's own firmware version — `verified-capture`, confirmed on
   * hardware 2026-09-08.
   *
   * `08 12 00 00 00 00` answers `08 12 00 00 00 02 <major> <minor>`; declared
   * length 2, and the pair reads in the same hex-digits-as-decimal scheme as
   * every other version here (`03 03` -> v3.03, i.e. the `0x303` the vendor's
   * `CS_UsbFinder_GetVersion` returns).
   *
   * It is answered by the mouse, not the dongle, and that is the whole point:
   * over 2.4 GHz it crosses the air, so a dozing mouse simply does not reply
   * while the dongle keeps ACKing its own commands (`0x11`/`0x13`/`0x14`/
   * `0x1a` all come back `08 xx 01 ...`, the generic-ACK shape, awake or not).
   * A real reply is therefore distinguishable by byte 2 being `0x00`.
   *
   * This is what supersedes the old "the mouse's firmware is not obtainable
   * over the air" conclusion: `GET_VERSION` (0x02) genuinely carries nothing,
   * but the vendor never used it for this — the capture's `GetVersion` call
   * wraps a `0x12` exchange on the DONGLE's path (`pid_f517`) and returns
   * `0x303`, while that same dongle's own `bcdDevice` is `0x300`.
   */
  DEVICE_VERSION: 0x12,
  BATTERY: 0x04,
  PAIR_ENTER: 0x05,
  /** `CS_UsbServer_ReadDonglePairStatus`, which the Hub polls ~1 Hz while its
   *  pair tool is open. Kept for the record only: this receiver never answers
   *  it (17 writes, 0 replies in the capture), so pairing completion is probed
   *  with `STATUS` + `BATTERY` instead — see `getPairingStatus`. */
  PAIR_STATUS: 0x06,
  WRITE_SETTING: 0x07,
  READ_BLOCK: 0x08,
  RESTORE: 0x09,
  GET_PROFILE: 0x0e,
  SET_PROFILE: 0x0f,
  LONG_RANGE: 0x16,
  /** SET the three receiver status LEDs — `verified-capture`. */
  RX_LED: 0x2c,
  /**
   * GET the three receiver status LEDs — **`verified-capture`, confirmed on
   * hardware 2026-09-07**: `08 2d 00 00 00 00` answered
   * `08 2d 00 00 00 0a 03 00 02`, and after writing a different triple via
   * 0x2C the same probe reported the new values back.
   *
   * This is the read that 0x2C never had. A zero-length 0x2C probe answers
   * `08 2c 01 …` with declaredLen 0 — the generic-ACK shape FINDINGS documents
   * for unclaimed commands — which is why the old probe failed 100% of the
   * time rather than intermittently, and why the Receiver LED pane always
   * showed a read failure on a cold start. (The len-0x0a read shape against
   * 0x2C, tried as a fallback, drew no reply at all on hardware.) The Hub
   * itself reads 0x2D at 01_open_device and at every one of the 12
   * profile-open steps, while never reading 0x2C — same get/set adjacency as
   * 0x0E/0x0F and 0x14/0x15.
   *
   * It can still answer with the generic ACK (`08 2d 01 00 00 00` appears once
   * in the capture), so a reply is only accepted when it is not that shape,
   * declares at least RX_LED_COUNT bytes, and holds three plausible values.
   */
  RX_LED_GET: 0x2d,
} as const;

/**
 * Receiver status-LED indication wire values, from the capture — these OVERRIDE
 * the display order in `RECEIVER_LED_INDICATION` (mouse-options.ts), which the
 * capture contradicts. `0x2C` is ONE frame carrying all three LED bytes:
 * `08 2c 00 00 00 0a <led1> <led2> <led3>`. Value meanings still need the
 * hardware checklist (three vendor tables disagree).
 */
export const RX_LED_WIRE: { value: number; labelKey: string }[] = [
  { value: 0, labelKey: 'rxLed.opt.off' },
  { value: 2, labelKey: 'rxLed.opt.battery' },
  { value: 1, labelKey: 'rxLed.opt.connQuality' },
  { value: 3, labelKey: 'rxLed.opt.pollRate' },
  { value: 4, labelKey: 'rxLed.opt.dpi' },
];
export const RX_LED_COUNT = 3;
/** The wire values a receiver-LED byte can legitimately hold — used as a
 *  plausibility gate on a reply from the `inferred` GET, so an unrelated
 *  command's payload can never be decoded as LED state. */
export const RX_LED_VALUES: ReadonlySet<number> = new Set(RX_LED_WIRE.map((o) => o.value));

/** DPI-indicator LED brightness is a 0..255 wire value (UI shows 0..100). */
export const DPI_LED_BRIGHT_MAX = 255;
export const dpiLedBrightToWire = (ui: number): number =>
  Math.round((Math.max(0, Math.min(100, ui)) / 100) * DPI_LED_BRIGHT_MAX);
export const dpiLedBrightFromWire = (wire: number): number =>
  Math.round((Math.max(0, Math.min(255, wire)) / DPI_LED_BRIGHT_MAX) * 100);

/**
 * DPI-indicator LED breathing speed — wire band for the `inferred` offset 0x50
 * (see V8_BLOCK.DPI_LED_SPEED). UI is 0..100 like every other speed control.
 *
 * 0..4, mirroring the keyboard's LED_MAXSPEED convention. A 2026-09-07
 * hardware sweep (`scripts/verify-mouse.mjs`) wrote 0, 1, 2, 3, 4 and 5 to
 * 0x50 and **every one of them read back**, so the earlier theory that a
 * rejected out-of-range value explained the mismatch reports is wrong — the
 * byte accepts anything. What is still unknown is whether the firmware *acts*
 * on it; a byte that reads back is not proof of that. Until a visual check on
 * a breathing LED says otherwise this stays a guess, which is why the write
 * goes through `writeSpeculative` and is kept out of the reported verdict.
 */
export const DPI_LED_SPEED_WIRE = { min: 0, max: 4 } as const;
const SPEED_SPAN = DPI_LED_SPEED_WIRE.max - DPI_LED_SPEED_WIRE.min;
export const dpiLedSpeedToWire = (ui: number): number =>
  DPI_LED_SPEED_WIRE.min + Math.round((Math.max(0, Math.min(100, ui)) / 100) * SPEED_SPAN);
export const dpiLedSpeedFromWire = (wire: number): number => {
  const clamped = Math.max(DPI_LED_SPEED_WIRE.min, Math.min(DPI_LED_SPEED_WIRE.max, wire));
  return Math.round(((clamped - DPI_LED_SPEED_WIRE.min) / SPEED_SPAN) * 100);
};

/** Mouse angle-mode degrees <-> signed wire byte (two's complement, -30..30).
 *  `verified-capture` — the range is the vendor slider's own, and the byte
 *  values are the ones it wrote. See V8_BLOCK.ANGLE_DEGREES. */
export const ANGLE_RANGE = { min: -30, max: 30 } as const;
export const angleToWire = (deg: number): number => {
  const clamped = Math.max(ANGLE_RANGE.min, Math.min(ANGLE_RANGE.max, Math.round(deg)));
  return clamped < 0 ? (clamped + 256) & 0xff : clamped & 0xff;
};
export const angleFromWire = (wire: number): number => {
  const b = wire & 0xff;
  return b & 0x80 ? b - 256 : b;
};

/** Key-response-time (mouse debounce) range in ms, from the capture. */
export const DEBOUNCE_RANGE = { min: 0, max: 15 } as const;

/** DPI Dynamic Sensitivity modes — vendor `dpiModeOptions` (future mice). */
export const DPI_DYNAMIC_MODES: { value: number; labelKey: string }[] = [
  { value: 1, labelKey: 'dpidyn.mode.classic' },
  { value: 2, labelKey: 'dpidyn.mode.natural' },
  { value: 3, labelKey: 'dpidyn.mode.jump' },
  { value: 0, labelKey: 'dpidyn.mode.custom' },
];

/** Sleep-timer wire value <-> seconds (1 unit = 10 s, 1..90 => 10 s..15 min). */
export const sleepSecToWire = (sec: number): number =>
  Math.max(1, Math.min(90, Math.round(sec / 10)));
export const sleepWireToSec = (wire: number): number => wire * 10;
