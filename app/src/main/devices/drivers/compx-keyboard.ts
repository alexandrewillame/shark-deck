import type { KeyboardOptions } from '@shared/types/keyboard-settings';
import type { IdentityKey } from '../identity-key';
import type { KeyBinding } from '@shared/types/keys';
import type {
  LightingSettings,
  PerKeyColor,
  PerKeyLightingOpts,
  SideLightingSettings,
} from '@shared/types/lighting';
import type { FirmwareInfo, WriteResult } from '@shared/types/live';
import type { Macro } from '@shared/types/macros';
import type { PowerSettings } from '@shared/types/mouse-settings';
import { Driver, delay, fmtVersion, type BackupPolicy } from './base';
import { toHex } from '../../hid/frame';
import {
  KB_LIGHT_EFFECTS,
  KB_LIGHT_EFFECTS_TABLE,
  KB_PERKEY_EFFECT_INDEX,
  currentEffectLabel,
  sideEffectName,
  sideEffectWire,
} from '@shared/lighting';
import {
  asKeyboardStores,
  KB_MACRO_INLINE_WAIT_MS,
  KB_MACRO_MAX_WAIT_MS,
  macroSlotOf,
} from '@shared/keyboard-macro';
import { decodeKeyQuad } from '@shared/keyboard-fn-codes';

/**
 * Compx keyboard base family (Attack Shark Driver v4 `FEA_CMD_*` protocol,
 * chunk 5e635fe2.js). Frame = `[reportId 0, CMD, checksum, ...args]` — the
 * `compx-fea` scheme: checksum at **byte 2**, `(0xFF - Σ) & 0xFF`, args from
 * byte 3. **Verified** against the real R85HE (a frame with the wrong byte-2
 * value is rejected outright). See docs/reverse-engineering/FINDINGS-R85HE.md.
 *
 * Command *numbers* are ported verbatim from the vendor JS
 * (`provenance: ported-from-vendor`). Reply-payload offsets: the firmware
 * writes its answer starting at **byte 2** (over the echoed query checksum);
 * `GET_USB_VERSION` and the two LED GETs are confirmed against real replies,
 * the rest still need the guided vendor-app capture (CAPTURE-KEYBOARD.md).
 * Every write is read back; a full backup is taken before the first.
 */
export const KB_CMD = {
  SET_RESET: 1,
  SET_REPORT: 3,
  SET_PROFILE: 4,
  SET_DEBOUNCE: 6,
  SET_LEDPARAM: 7,
  SET_SLEDPARAM: 8,
  SET_KBOPTION: 9,
  SET_KEYMATRIX: 10,
  SET_MACRO: 11,
  SET_USERPIC: 12,
  SET_FN: 16,
  SET_SLEEPTIME: 17,
  SET_MULTI_MAGNETISM: 101,
  GET_RF_VERSION: 128,
  GET_REPORT: 131,
  GET_PROFILE: 132,
  GET_LEDONOFF: 133,
  GET_DEBOUNCE: 134,
  GET_LEDPARAM: 135,
  GET_SLEDPARAM: 136,
  GET_KBOPTION: 137,
  GET_KEYMATRIX: 138,
  GET_MACRO: 139,
  GET_USERPIC: 140,
  GET_USB_VERSION: 143,
  GET_FN: 144,
  GET_SLEEPTIME: 145,
  SET_MAGNETISM_REPORT: 27,
  GET_MULTI_MAGNETISM: 229,
  // -- present in the 5e635fe2 generation, recovered by `npm run extract:kb`
  //    but previously absent from this table (see keyboard-options.ts) --
  SET_MAGNETISM_CAL: 28,
  SET_MAGNETISM_MAXIMUM_CALIBRATION: 30,
  SET_CMD_AUTOOSEN: 23,
  GET_CMD_AUTOOSEN: 151,
  SET_SKU: 80,
  GET_SKU: 208,
} as const;

const RATE_TO_IDX: Record<number, number> = {
  8000: 0,
  4000: 1,
  2000: 2,
  1000: 3,
  500: 4,
  250: 5,
  125: 6,
};
const IDX_TO_RATE: Record<number, number> = {
  0: 8000,
  1: 4000,
  2: 2000,
  3: 1000,
  4: 500,
  5: 250,
  6: 125,
};

/** vendor MAXSPEED — LED speed is a 0..4 wire value (`e[2] = MAXSPEED - speed`). */
const LED_MAXSPEED = 4;
/** vendor sentinel: pure white is stored as 0xFAF0FA so it is distinguishable. */
const WHITE_SENTINEL = 0xfaf0fa;

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));
/**
 * UI 0..100 <-> wire 0..4 (both LED speed and brightness are 0..4 on the wire —
 * confirmed from the capture: `00 07 <effect> <0-4> <0-4> …`).
 *
 * **Speed is INVERTED on the wire**: the vendor sends
 * `a[2] = LIGHT_MAXSPEED - speed` (`setLightSetting` in the qmk.top bundle,
 * with `LIGHT_MAXSPEED = 4`), so wire **0 is fastest** and 4 is slowest. This
 * mapped UI 100% straight to wire 4, i.e. the speed slider ran backwards —
 * dragging it to "fast" made the animation as slow as it goes.
 * `provenance: ported-from-vendor`.
 */
const speedToWire = (ui: number) =>
  LED_MAXSPEED - clamp(Math.round((ui / 100) * LED_MAXSPEED), 0, LED_MAXSPEED);
const brightnessToWire = (ui: number) => clamp(Math.round((ui / 100) * 4), 0, 4);
const speedFromWire = (w: number) =>
  clamp(Math.round(((LED_MAXSPEED - clamp(w, 0, LED_MAXSPEED)) / LED_MAXSPEED) * 100), 0, 100);
/** Missing inverse of `brightnessToWire` — its absence (every read used to
 *  clamp the raw 0..4 wire byte as if it were already 0..100) is the actual
 *  cause of "brightness always reads ~0%"; see readLighting/readSideLighting. */
const brightnessFromWire = (w: number) => clamp(Math.round((w / 4) * 100), 0, 100);

/**
 * The SIDE strip's speed is **not** inverted, unlike the main zone's.
 *
 * `SET_SLEDPARAM` reused `speedToWire` on the assumption that both zones share
 * the vendor's `LIGHT_MAXSPEED - speed` convention. On hardware the side
 * slider then ran backwards: UI 0% gave the fastest animation, which is what
 * `speedToWire(0) = 4` means if wire 4 is the FAST end on this command. So the
 * side channel gets a direct mapping and the main one keeps the inversion.
 *
 * `provenance: inferred` — from an observed hardware behaviour that
 * contradicts the ported-from-vendor assumption, not from a capture. If a
 * capture later shows `SET_SLEDPARAM` is inverted after all, this is the one
 * place to change back.
 */
const sideSpeedToWire = (ui: number) =>
  clamp(Math.round((ui / 100) * LED_MAXSPEED), 0, LED_MAXSPEED);
const sideSpeedFromWire = (w: number) =>
  clamp(Math.round((clamp(w, 0, LED_MAXSPEED) / LED_MAXSPEED) * 100), 0, 100);
const numToRgb = (n: number): [number, number, number] => [
  (n >> 16) & 0xff,
  (n >> 8) & 0xff,
  n & 0xff,
];

/**
 * The firmware sometimes overwrites the echoed query checksum at byte 2 with
 * real reply data, and sometimes leaves it untouched — `getActiveProfile`/
 * `readDebounce` hardcoded `r[2]` (wrong per FINDINGS-R85HE.md's own captured
 * hex: `GET_PROFILE` -> `00 84 00 …`, byte 2 = 0, ambiguous with "slot 0", but
 * cross-referenced against `GET_LEDPARAM`'s `00 87 0d 04 01 00 00 c8 c8` where
 * byte 2 (`0d`) already IS the effect — the untouched-echo case is exactly
 * when byte 2 still equals the query's own checksum). `provenance: inferred`
 * — an educated reconstruction cross-referenced against captured hex, not a
 * rule observed directly.
 */
function feaPayloadStart(reply: Uint8Array, command: number): 2 | 3 {
  const echoedCk = (0xff - command) & 0xff;
  return reply[2] === echoedCk ? 3 : 2;
}

/**
 * Firmware matrix slot quad (4 bytes) -> a binding, including its human label.
 *
 * The decode itself lives in shared/keyboard-fn-codes.ts so the consumer-page
 * and lighting tables are testable without a driver, and so the renderer can
 * spell a binding the same way the driver read it. `GET_KEYMATRIX`/`GET_FN`
 * are assumed (UNCONFIRMED, see CAPTURE-KEYBOARD.md) to answer in the shape
 * the vendor's `defaultMatrix` / `defaultFnMatrix` tables use.
 */
export function decodeQuad(slot: number, raw: [number, number, number, number]): KeyBinding {
  const d = decodeKeyQuad(raw);
  return {
    slot,
    code: d.code,
    kind: d.kind,
    label: d.label || undefined,
    shortLabel: d.short || undefined,
    locked: d.locked || undefined,
    raw,
    provenance: 'device',
  };
}

const KEYMATRIX_CHUNKS = 8;

/**
 * How long a board takes to save a committed write before a paged read can be
 * trusted — measured on an R98 HE (firmware 5.06, 2026-11-22), one write and
 * one read at a time:
 *
 * - a key map write: a read within ~50 ms answered the OLD binding, or
 *   nothing; from 100 ms, the new one;
 * - a magnetism write: nothing answered for ~100 ms, then up to ~300 ms a page
 *   read answered WRONG values (Esc's 2.0 mm read as 138 and 0 units), and
 *   from ~400 ms the right ones.
 *
 * Paged replies carry no command echo to catch a wrong answer with, so a read
 * waits the board out (`untilSaved`). Writes need no wait: two committed
 * writes back to back both landed, at any spacing.
 */
export const KEYMATRIX_SAVE_MS = 120;
export const MAGNETISM_SAVE_MS = 450;
const KEYMATRIX_SLOT_STRIDE = 4;
/**
 * Reply payload offset for GET_KEYMATRIX/GET_FN's bulk chunk data —
 * **verified**, was 9.
 *
 * Like the paged magnetism reads, these replies carry no command echo and no
 * checksum: the 64 data bytes start right after the report id, giving exactly
 * 16 four-byte slots per chunk and 128 slots over 8 chunks.
 *
 * Settled on a real R85HE by brute-forcing the alignment against
 * `ANSI_79_SG9047`: offset 1 with the HID code at quad byte 2 matches **77 of
 * 77** layout entries; nothing else matches more than a handful. The old
 * value of 9 also broke the 4-byte alignment, since 65 - 9 = 56 bytes per
 * chunk is not a multiple of the stride.
 */
const KEYMATRIX_REPLY_OFFSET = 1;
/** The Fn layer's slots: 8 pages of 16, as GET_FN reads them. SET_FN writes one (setFnSlot). */
const FN_MATRIX_SLOTS = 128;

/** Re-exported so this family's own modules keep importing it from here
 *  (compx-he-keyboard); it lives in base.ts because `writeVerified`'s
 *  settle needs it and base cannot import a concrete driver. */
export { delay };

/**
 * True when a reply is just our own query bounced back — what Windows hands
 * back from HidD_GetFeature when the firmware never populated the buffer (an
 * unsupported page, or a command it chose not to answer).
 *
 * The transport's `request()` has its own `isEcho`, but every paged read in
 * this family bypasses `request()` entirely — the replies carry no command
 * echo and no checksum — so they need their own check. Shared by
 * `readUserPicPaged` here and `readMagnetismPage` in the HE subclass.
 */
export function isEchoOf(reply: Uint8Array, query: Uint8Array): boolean {
  if (reply.length !== query.length) return false;
  for (let i = 0; i < query.length; i++) if (reply[i] !== query[i]) return false;
  return true;
}

// -- per-key ("user picture") lighting wire shape ------------------------
// Captured frame: `00 0c 00 ff <chunkIdx> 0x38 00 00 ck@8 <56 RGB bytes>` —
// 5 chunks x 56 = 280 bytes (not the old 7x56=378). Using the descriptor's
// default `compx-fea` checksum (no 'bit7' override) is what's actually
// verified against the R85HE — see FINDINGS-R85HE.md's SET_USERPIC note and
// buildFrame's arg-stepping, which places these 6 header args at bytes
// 2..7, the checksum at 8, then the 56-byte RGB payload at 9..64.
/**
 * `verified-capture` — decoded from the seven `SET_USERPIC` frames in
 * `session-r85he.jsonl` (step `13_perkey_colour`):
 *
 * ```
 * 00 0c 00 ff 00 38 00 00 bc <56 bytes>   chunk 0
 * ...                                      chunks 1..5, all len 0x38
 * 00 0c 00 ff 06 2a 01 00 c3 <42 bytes>   chunk 6 — len 0x2a, LAST flag 01
 * ```
 *
 * So byte 5 is **this chunk's payload length** and byte 6 is the **last-chunk
 * flag**, and the map is 6 x 56 + 42 = **378 bytes = 126 slots x 3 (RGB)**.
 *
 * Both of those were previously missing: the driver sent five chunks with a
 * hardcoded 0x38 length and a permanently-zero byte 6, so the firmware was
 * never told the transfer had finished and never committed the map — which is
 * why painting a key appeared to do nothing.
 */
const USERPIC_BYTES = 378;
const USERPIC_CHUNK = 56;
const USERPIC_WRITE_CHUNKS = Math.ceil(USERPIC_BYTES / USERPIC_CHUNK); // 7
/**
 * The read sweep is 6 chunks — what the vendor does immediately before the
 * write above, and what qmk.top's `___cmdGetCustomLightLayout` does too. Reads
 * come back as 64 data bytes per chunk (not the write's 56), so 6 x 64 = 384
 * covers the 378-byte map with 6 bytes of slop.
 */
const USERPIC_READ_CHUNKS = 6;
/**
 * Where a `GET_USERPIC` reply's data starts: immediately after the HID report
 * id, exactly like the other two paged reads in this family
 * (`KEYMATRIX_REPLY_OFFSET` above, `MM_REPLY_OFFSET` in compx-he-keyboard).
 *
 * Was 9, which was both the wrong offset and — because the read went through
 * `ch.request()` — guaranteed to reject every chunk: these replies carry no
 * command echo, and `request()` only accepts `reply[1] === expectCommand`.
 * Burning the full 3 x 6 attempt budget on all 6 chunks fired ~126 unpaced
 * feature reports, which is exactly the rate FINDINGS-R85HE.md's "Note —
 * endpoint lockup" says wedges the MI_02 endpoint until the board is
 * physically replugged.
 */
const USERPIC_REPLY_OFFSET = 1;

function decodeUserPicBytes(bytes: number[]): PerKeyColor[] {
  const out: PerKeyColor[] = [];
  // Stop at the real map size. A 6-chunk read returns 6 x 64 = 384 bytes but
  // the map is 378, so the tail is slop that would otherwise decode as two
  // extra "keys" past the end of the slot space.
  const end = Math.min(bytes.length, USERPIC_BYTES);
  for (let i = 0; i + 2 < end; i += 3) {
    const c: [number, number, number] = [bytes[i] ?? 0, bytes[i + 1] ?? 0, bytes[i + 2] ?? 0];
    if (c[0] || c[1] || c[2]) out.push({ index: i / 3, color: c });
  }
  return out;
}

// -- macro wire encoding ------------------------------------------------
/**
 * The keyboard's macros, as Attack Shark Driver v4 writes them to an R98 HE
 * (its owner's recording and its own macros read back, 2026-11-22): a
 * two-byte repeat count, then the key events — two bytes each, the usage and
 * a byte whose top bit says pressed and whose low seven bits are the wait
 * after it, 1-127 ms, or 0 with the wait in two more bytes (up to 65535 ms).
 * The rule and its examples: shared/keyboard-macro.ts.
 *
 * `provenance: verified-capture` for the frame and the events. This replaces
 * two guesses: a `[index, count, repeat, 0]` + `[kind, value, msLo, msHi]`
 * shape sent with the pre-capture `bit7` checksum (which the board drops),
 * then a seven-bit wait capped at 127 ms, which wrote a 0 ms wait as "two
 * wait bytes follow" — the next event read as a wait of up to 65 s.
 */
/**
 * The macros' room on the board: 256 bytes each, read as one run of 64-byte
 * pages — `GET_MACRO 8b 00 <page>`, macro n in pages 4n to 4n+3, unwritten
 * flash (0xFF) past the last. `provenance: verified-capture` for the read (an
 * R98 HE holding three macros of the official software's and one of ours);
 * the official software never reads a macro (it keeps its own copies).
 */
const MACRO_BYTES = 256;
const MACRO_READ_PAGES = 4;
/**
 * Macro slots a keyboard holds: 64 — the whole 16 KB a read reaches (pages
 * 0-255). On an R98 HE (2026-11-23) a macro written with the slot byte at 3,
 * 15, 31 and 63 landed in that slot and nowhere else, and read back.
 * `provenance: verified-capture` for writing and reading them; that a key
 * plays the top ones is the board's to show.
 */
export const KB_MACRO_SLOTS = 64;
const MACRO_REPLY_OFFSET = 1;
const MACRO_HEADER = 2;
/** Payload bytes per SET_MACRO frame, as the official software sends them. */
const MACRO_CHUNK = 56;
/**
 * The most a write may fill. Writes go in 56-byte chunks, so a fifth chunk
 * would run from byte 224 to 279 — 24 bytes into the next macro. Four chunks
 * keep every write inside macro 0's own 256 bytes.
 */
const MACRO_WRITE_BYTES = 4 * MACRO_CHUNK;
/**
 * The empty event that closes the events, always written. The board builds a
 * slot in a 256-byte buffer and saves all of it: bytes a write does not send
 * keep the last macro's (seen on an R98 HE), so a macro filling its chunks
 * exactly would run on into them.
 */
const MACRO_END = 2;
const MACRO_PRESSED = 0x80;
/**
 * Room one slot gives, in two-byte units — what the macro editor counts: a
 * key event takes one, and its wait one more when it is 0 or over 127 ms
 * (MacroLimits.inlineWaitMs).
 */
export const KB_MACRO_MAX_STEPS = Math.floor((MACRO_WRITE_BYTES - MACRO_HEADER - MACRO_END) / 2);

/** A step's `value` is a hex string for keys ("04"=A). */
function stepValue(v: number | string | undefined): number {
  if (typeof v === 'number') return v & 0xff;
  if (typeof v === 'string' && /^[0-9a-fA-F]{1,4}$/.test(v)) return parseInt(v, 16) & 0xff;
  return 0;
}

/**
 * The macro's payload: as many bytes as its events take, from the steps as
 * the keyboard holds them (shared/keyboard-macro.ts `asKeyboardStores`: a
 * wait rides on the key event before it; a mouse button or pointer motion is
 * left out, never written as a phantom key). Stops before an event that would
 * not fit the slot.
 */
export function encodeMacro(m: Macro): number[] {
  const stored = asKeyboardStores(m.steps);
  const repeat = Math.max(1, Math.min(0xffff, Math.round(m.repeatCount || 1)));
  const buf = [repeat & 0xff, (repeat >> 8) & 0xff];
  for (let i = 0; i < stored.length; i++) {
    const s = stored[i]!;
    if (s.type !== 'key') continue;
    const next = stored[i + 1];
    const wait = next?.type === 'delay' ? Math.min(KB_MACRO_MAX_WAIT_MS, next.ms ?? 0) : 0;
    const event = [stepValue(s.value), s.action === 'down' ? MACRO_PRESSED : 0];
    if (wait >= 1 && wait <= KB_MACRO_INLINE_WAIT_MS) event[1]! |= wait;
    else event.push(wait & 0xff, (wait >> 8) & 0xff);
    if (buf.length + event.length > MACRO_WRITE_BYTES - MACRO_END) break;
    buf.push(...event);
  }
  return buf;
}

/**
 * The events of a macro's bytes: where they end (the offset of the empty event
 * that closes them), or -1 when they run past what `buf` holds.
 */
function macroEnd(buf: readonly number[]): number {
  let o = MACRO_HEADER;
  while (o < Math.min(buf.length, MACRO_BYTES)) {
    const usage = buf[o]!;
    // The events end at an empty one; 0xFF is unwritten flash past them.
    if (usage === 0 || usage === 0xff) return o;
    if (o + 1 >= buf.length) return -1;
    o += (buf[o + 1]! & KB_MACRO_INLINE_WAIT_MS) === 0 ? 4 : 2;
  }
  return o >= MACRO_BYTES ? MACRO_BYTES : -1;
}

export function decodeMacro(id: string, name: string, buf: number[]): Macro {
  const repeatCount = (buf[0] ?? 0) | ((buf[1] ?? 0) << 8) || 1;
  const steps: Macro['steps'] = [];
  let o = MACRO_HEADER;
  while (o + 1 < Math.min(buf.length, MACRO_BYTES)) {
    const usage = buf[o]!;
    if (usage === 0 || usage === 0xff) break;
    const b = buf[o + 1]!;
    steps.push({
      type: 'key',
      action: b & MACRO_PRESSED ? 'down' : 'up',
      value: usage.toString(16).padStart(2, '0'),
    });
    let wait = b & KB_MACRO_INLINE_WAIT_MS;
    o += 2;
    if (!wait) {
      wait = (buf[o] ?? 0) | ((buf[o + 1] ?? 0) << 8);
      o += 2;
    }
    if (wait) steps.push({ type: 'delay', ms: wait });
  }
  return { id, name, repeatCount, steps };
}

/** A macro's payload put back together from its SET_MACRO frames (report id
 *  off): `0b <macro> <chunk> <length> <last> 00 00 <ck>`, then the bytes. */
export function macroPayloadOf(frames: readonly ArrayLike<number>[]): number[] {
  const bytes: number[] = [];
  for (const f of frames) {
    const at = (f[2] ?? 0) * MACRO_CHUNK;
    const len = Math.min(f[3] ?? 0, MACRO_CHUNK);
    for (let i = 0; i < len; i++) bytes[at + i] = f[8 + i] ?? 0;
  }
  return Array.from(bytes, (b) => b ?? 0);
}

/** Re-exported for the existing call sites and `compx-keyboard.test.ts`; the
 *  implementation moved to drivers/base.ts once the mouse needed it too. */
export { fmtVersion } from './base';

/** One key-matrix binding as the board stores it: `[type, sub, a, b]`. */
export type KeyQuad = [number, number, number, number];

/**
 * A binding action as the four quad bytes `SET_KEYMATRIX` carries.
 *
 * **1-4 hex digits** is a HID usage, laid out `[0, hi, lo, 0]` (A = `[0,0,4,0]`);
 * **exactly 8** is the quad verbatim, for bindings that are not a plain key
 * (a consumer usage, a lighting control). Anything else is null — never 0: a
 * malformed action quietly becoming usage 0 is a dead key, and a typo and a
 * deliberate "disable" must not be the same thing. Eight digits cannot be
 * mistaken for four: no HID usage is that wide.
 */
export function quadFor(action: string): KeyQuad | null {
  if (/^[0-9a-fA-F]{8}$/.test(action)) {
    return [
      parseInt(action.slice(0, 2), 16),
      parseInt(action.slice(2, 4), 16),
      parseInt(action.slice(4, 6), 16),
      parseInt(action.slice(6, 8), 16),
    ];
  }
  if (!/^[0-9a-fA-F]{1,4}$/.test(action)) return null;
  const usage = parseInt(action, 16);
  // quad = [tag, usageHigh, usageLow, 0]; `decodeQuad` reads the code from [2]
  // and a second usage from [1] (R-Alt+8 is `[0, 230, 37, 0]`).
  return [0, (usage >> 8) & 0xff, usage & 0xff, 0];
}

/**
 * `SET_KEYMATRIX` args for one zone of one slot: `[layer, slot, pad, pad,
 * commit, zone]` (frame bytes 2..7, checksum at 8), then the quad at frame
 * bytes 9..12, stored verbatim.
 *
 * Layer 0 — the layer the read uses; verified on an R85HE, where a write to
 * slot 9 at layer 0 changed that slot and no other. `zone` is 0 for a key's
 * ordinary binding; a mod-tap or DKS key carries one binding per zone, each a
 * frame of its own with `commit` on the last (the vendor's `setDKSKeySimple`).
 */
export function keymatrixArgs(
  slot: number,
  quad: KeyQuad,
  opts: { commit: boolean; zone: number },
): number[] {
  return [0x00, slot & 0xff, 0, 0, opts.commit ? 1 : 0, opts.zone & 0xff, ...quad];
}

export class CompxKeyboard extends Driver {
  // Annotated `number`, not left to infer the literal 30, so a subclass (or a
  // test) can pace itself differently.
  protected readonly settleMs: number = 30;

  /** When the board will have saved the last committed write (see KEYMATRIX_SAVE_MS). */
  private savedAt = 0;
  /** A committed write was just sent: the board is saving for `ms`. */
  protected savingFor(ms: number): void {
    this.savedAt = Math.max(this.savedAt, Date.now() + ms);
  }
  /** Wait until the board has saved, before a paged read. An unpaced driver
   *  (a test's, the recording check's) has nothing real to wait for. */
  protected async untilSaved(): Promise<void> {
    const wait = this.savedAt - Date.now();
    if (wait > 0 && this.settleMs) await delay(wait);
  }

  /**
   * This family's replies do NOT all start at a fixed offset — the firmware
   * sometimes leaves the echoed query checksum in byte 2 and sometimes
   * doesn't, so every reader here resolves the start per reply with
   * `feaPayloadStart`. The base class's fixed `subarray(2, len - 1)` therefore
   * disagreed with the matching reader whenever the echo was present
   * (`compare` saw the checksum byte, e.g. 0xff - 0x87 = 0x78, where it
   * expected the effect index) and reported "mismatch" on a write that had
   * landed. It also trimmed a trailing byte, which `parseFrame` deliberately
   * does not do for `compx-fea`.
   */
  protected override payloadOf(reply: Uint8Array, getCommand: number): Uint8Array {
    return reply.subarray(feaPayloadStart(reply, getCommand));
  }
  /**
   * This firmware wedges its vendor endpoint (Windows error 0x79, "the
   * semaphore timeout period has expired") under back-to-back feature-report
   * transactions, and only a replug clears it — see the warning in
   * scripts/dump-keyboard-state.mjs, which paces itself at 120 ms for exactly
   * this reason. `backup()` is the worst offender because `request()` retries
   * internally, so nine commands can mean well over a hundred reads with no
   * gap at all. Observed wedging a real R85HE mid-backup.
   */
  protected override backupPaceMs = 120;
  /** last-read KBOPTION register — all five switches share one frame */
  private _kbOptions: KeyboardOptions | null = null;

  // -- verified-shape reads -------------------------------------------
  /**
   * Firmware version — **verified** against the real R85HE. The `GET_USB_VERSION`
   * reply is `[00, 8f, <model id lo>, <model id hi>, 00, 00, 00, 00, <fw lo>,
   * <fw hi>, …]`: model `id` at bytes [2..3] LE (0x0c33 = 3123 on the R85HE),
   * firmware uint16 at bytes [8..9] LE (0x0511 = 1297). The vendor renders the
   * raw uint16's hex digits as a decimal string (`0x0511` -> "511" -> "v5.11").
   * `GET_RF_VERSION` returns nothing on a wired board. `rejectEcho` guards
   * against Windows handing back our own zero-padded query.
   */
  /**
   * Identify: the vendor model id in the `GET_USB_VERSION` reply, bytes
   * [2..3] LE — `verified-capture` (3123 on the R85HE). The same opcode on
   * both ROYUAN command sets (gen2 and yc500), so it is the one frame that is
   * safe to send before the family is known.
   */
  override async identify(): Promise<IdentityKey | null> {
    const usb = await this.ch.request(
      this.frame(KB_CMD.GET_USB_VERSION),
      KB_CMD.GET_USB_VERSION,
      2,
      6,
      true,
    );
    if (!usb) return null;
    const modelId = ((usb[3] ?? 0) << 8) | (usb[2] ?? 0);
    return modelId && modelId !== 0xffff ? { family: 'royuan', modelId } : null;
  }

  override async getFirmware(): Promise<FirmwareInfo & { modelId?: number }> {
    const usb = await this.ch.request(
      this.frame(KB_CMD.GET_USB_VERSION),
      KB_CMD.GET_USB_VERSION,
      2,
      6,
      true,
    );
    const rf = await this.ch.request(
      this.frame(KB_CMD.GET_RF_VERSION),
      KB_CMD.GET_RF_VERSION,
      2,
      6,
      true,
    );
    const usbRaw = usb ? ((usb[9] ?? 0) << 8) | (usb[8] ?? 0) : 0;
    const modelId = usb ? ((usb[3] ?? 0) << 8) | (usb[2] ?? 0) : 0;
    // RF version, when present, is uint16 LE right after the command byte.
    const rfRaw = rf ? ((rf[3] ?? 0) << 8) | (rf[2] ?? 0) : 0;
    return {
      device: usbRaw ? fmtVersion(usbRaw) : null,
      receiver: rfRaw ? fmtVersion(rfRaw) : null,
      deviceRaw: usbRaw || undefined,
      receiverRaw: rfRaw || undefined,
      modelId: modelId || undefined,
    };
  }

  /**
   * The `KBOPTION` register — five unrelated switches in one frame.
   *
   * Reply layout confirmed on an R85HE against qmk.top's
   * `___getKBOption_ry5088` (the "ry5088" in that name is this board's own
   * firmware family — `ry5088_sg9047_1m_8k`):
   *
   *   `00 89 <FnOS> <fnProfile> <antiMistouch> <RTStab/25> <swapWASD> 00 <ck>`
   *
   * Live read from a real board: `00 89 00 00 01 00 00 00 76`, i.e. Windows Fn
   * layout, profile 0, anti-mistouch on, no RT stabilisation, WASD not swapped.
   *
   * `provenance: ported-from-vendor`. The FnOS encoding (0 = Windows) is
   * `inferred` — the board reads 0 and is in Windows mode, but the mac value
   * has not been observed.
   */
  override async readKeyboardOptions(): Promise<KeyboardOptions | null> {
    const r = await this.ch.request(this.frame(KB_CMD.GET_KBOPTION), KB_CMD.GET_KBOPTION, 3, 6);
    if (!r) return null;
    // Resolve the reply offset like every other read here does. This was the
    // one keyboard read still hardcoding `r[2]`, and the firmware sometimes
    // leaves the echoed query checksum in that byte — in which case all five
    // fields were read one byte early, so `swapWasd` came back off the
    // RT-stabilisation byte. The toggle then round-tripped to its old value
    // (useKeyboardOptions re-reads and trusts the device over its own guess),
    // and the poisoned `_kbOptions` cache fed the NEXT write wrong values for
    // all five switches, since they share one frame.
    const off = feaPayloadStart(r, KB_CMD.GET_KBOPTION);
    const rtRaw = r[off + 3] ?? 0;
    const o: KeyboardOptions = {
      fnOs: (r[off] ?? 0) === 1 ? 'mac' : 'win',
      fnProfile: r[off + 1] ?? 0,
      antiMistouch: (r[off + 2] ?? 0) === 1,
      // the vendor treats anything above 5 as "off" rather than clamping
      rtStab: rtRaw > 5 ? 0 : rtRaw * 25,
      swapWasd: (r[off + 4] ?? 0) === 1,
    };
    this._kbOptions = o;
    return o;
  }

  /**
   * All five switches live in one frame, so a partial change has to be merged
   * over the current state — writing just one field would zero the other four
   * (turning off anti-mistouch, resetting the Fn layout to Windows, and so on).
   * Reads the register first when we have not seen it this session.
   */
  override async setKeyboardOptions(o: Partial<KeyboardOptions>): Promise<WriteResult> {
    const cur = this._kbOptions ?? (await this.readKeyboardOptions());
    if (!cur) {
      return {
        ok: false,
        verified: 'unverified',
        error: 'could not read current keyboard options',
      };
    }
    const next: KeyboardOptions = { ...cur, ...o };
    const rt = Math.max(0, Math.min(5, Math.round(next.rtStab / 25)));
    const tx = this.frame(KB_CMD.SET_KBOPTION, [
      next.fnOs === 'mac' ? 1 : 0,
      next.fnProfile & 0xff,
      next.antiMistouch ? 1 : 0,
      rt,
      next.swapWasd ? 1 : 0,
    ]);
    try {
      await this.ch.write(tx);
    } catch (e) {
      return { ok: false, verified: 'unverified', error: String(e), frames: [toHex(tx)] };
    }
    this._kbOptions = next;
    const back = await this.readKeyboardOptions();
    // Name the field that disagreed rather than reporting a bare "mismatch".
    // These five switches share one frame, so "something did not stick" is
    // not actionable — which one did is.
    const disagreed: string[] = [];
    if (back) {
      if (back.fnOs !== next.fnOs) disagreed.push('Fn layout');
      if (back.antiMistouch !== next.antiMistouch) disagreed.push('anti-mistouch');
      if (back.rtStab !== next.rtStab) disagreed.push('RT stabilisation');
      if (back.swapWasd !== next.swapWasd) disagreed.push('swap WASD');
    }
    if (!back)
      return {
        ok: true,
        verified: 'unverified',
        frames: [toHex(tx)],
        note: 'the keyboard did not answer the read-back',
      };
    return {
      ok: true,
      verified: disagreed.length ? 'mismatch' : 'match',
      frames: [toHex(tx)],
      ...(disagreed.length ? { note: `the keyboard did not accept: ${disagreed.join(', ')}` } : {}),
    };
  }

  override async getActiveProfile(): Promise<number | null> {
    // reply data starts at byte 2 or 3 depending on whether the firmware
    // overwrote the echoed query checksum — see feaPayloadStart. `provenance:
    // ported-from-vendor` — confirm the exact offset in CAPTURE-KEYBOARD.md.
    const r = await this.ch.request(this.frame(KB_CMD.GET_PROFILE), KB_CMD.GET_PROFILE, 3, 6);
    if (!r) return null;
    return (r[feaPayloadStart(r, KB_CMD.GET_PROFILE)] ?? 0) + 1;
  }

  /**
   * `r[3]` is a guess — every other GET in this class decodes from a
   * *different* offset (profile at r[2], USB version at r[7..8], RF version
   * at r[1..2], sleep time at r[9..16]) and no reply to GET_REPORT was ever
   * captured, so this offset is `inferred` pending confirmation against
   * Driver v4. Previously this fabricated 1000 Hz on any no-reply/unknown-index
   * failure, which is exactly why a real read never surfaced as "unreadable" —
   * and if the index really is at r[2] (padding at r[3] reading back 0x00),
   * `IDX_TO_RATE[0]` is 8000, the wrong value users have reported seeing. Now
   * returns null on failure so `ReadFailed` can show for keyboards, and logs
   * the raw reply so the offset can be verified.
   */
  override async readPollRate(): Promise<number | null> {
    const r = await this.ch.request(this.frame(KB_CMD.GET_REPORT), KB_CMD.GET_REPORT, 3, 6);
    if (!r) return null;
    // Real R85HE reply: `00 83 7c 01` — byte 2 is the echoed query checksum,
    // the poll-rate code is at byte 3 (0x01 here). Whether that code is a list
    // index (this map) or the vendor mouse-style bitmask (1=1000Hz) is
    // unconfirmed — CAPTURE-KEYBOARD.md step 04 steps 125->8000 to settle it.
    const idx = r[3] ?? -1;
    return IDX_TO_RATE[idx] ?? null;
  }

  /**
   * Debounce time in milliseconds. `GET_DEBOUNCE` reply on the real R85HE is
   * `00 86 00 …` (currently 0). Value read from byte 2, the first data byte.
   * `ported-from-vendor` — confirm the write frame in CAPTURE-KEYBOARD.md step 03.
   */
  override async readDebounce(): Promise<number | null> {
    const r = await this.ch.request(this.frame(KB_CMD.GET_DEBOUNCE), KB_CMD.GET_DEBOUNCE, 3, 6);
    if (!r) return null;
    return r[feaPayloadStart(r, KB_CMD.GET_DEBOUNCE)] ?? 0;
  }

  override async setDebounce(ms: number): Promise<WriteResult> {
    return this.writeVerified(KB_CMD.SET_DEBOUNCE, [clamp(Math.round(ms), 0, 30)], {
      getCommand: KB_CMD.GET_DEBOUNCE,
      compare: (p) => (p[0] ?? -1) === clamp(Math.round(ms), 0, 30),
    });
  }

  /** True when this keyboard runs over a radio link (answered GET_RF_VERSION). */
  protected async isWireless(): Promise<boolean> {
    const rf = await this.ch.request(
      this.frame(KB_CMD.GET_RF_VERSION),
      KB_CMD.GET_RF_VERSION,
      2,
      6,
      true,
    );
    return !!rf && (((rf[2] ?? 0) << 8) | (rf[1] ?? 0)) > 0;
  }

  /**
   * Sleep timers, per vendor getSleepTime (chunk 5e635fe2.js):
   *   reply[9..10]=time_bt  reply[11..12]=time_24
   *   reply[13..14]=deepTime_bt  reply[15..16]=deepTime_24   (all uint16 LE)
   * We surface the field for the active radio; 0 / 0xFFFF both read as "never".
   */
  override async readPower(): Promise<PowerSettings> {
    const r = await this.ch.request(this.frame(KB_CMD.GET_SLEEPTIME), KB_CMD.GET_SLEEPTIME, 3, 6);
    if (!r || r.length < 13) return { sleepTimerSec: 0, never: true };
    const wireless = await this.isWireless();
    const u16 = (lo: number) => {
      const v = (r[lo] ?? 0) | ((r[lo + 1] ?? 0) << 8);
      return v === 0xffff ? 0 : v;
    };
    const light = wireless ? u16(11) : u16(9);
    const deep = r.length >= 17 ? (wireless ? u16(15) : u16(13)) : 0;
    return { sleepTimerSec: light, deepSleepSec: deep || undefined, never: light === 0 };
  }

  /**
   * Main keyboard lighting, decoded per vendor getLightSetting (chunk
   * 5e635fe2.js): [effect, wire speed 0..4, wire brightness 0..4,
   * option<<4|nibble (nibble 8 = "dazzle"), rgb] starting at `feaPayloadStart`
   * (2 or 3 depending on whether the firmware overwrote the echoed query
   * checksum — see that helper). Both the offset and the missing
   * brightness-scale inverse were the two compounding bugs behind
   * "brightness always reads ~0%"; an unread device now correctly falls back
   * to 100% (wire default 4).
   */
  override async readLighting(): Promise<LightingSettings[]> {
    const r = await this.ch.request(this.frame(KB_CMD.GET_LEDPARAM), KB_CMD.GET_LEDPARAM, 3, 6);
    if (!r) return [];
    const off = feaPayloadStart(r, KB_CMD.GET_LEDPARAM);
    const effIdx = r[off] ?? 1;
    const num = ((r[off + 4] ?? 0) << 16) | ((r[off + 5] ?? 0) << 8) | (r[off + 6] ?? 0);
    // The colour mode is the option's low nibble, read as setLighting writes
    // it: a music effect says rainbow with 0 (plain is 4), the others with 8.
    // Seen on an R98 HE: Music Follow from Driver v4 reads `option 00`.
    const id = KB_LIGHT_EFFECTS_TABLE[effIdx]?.id;
    const music = id === 'LightMusicFollow2' || id === 'LightMusicFollow3';
    const colourMode = (r[off + 3] ?? 0) & 0x0f;
    return [
      {
        zone: 'keyboard',
        effect: KB_LIGHT_EFFECTS[effIdx] ?? 'Always On',
        speed: speedFromWire(r[off + 1] ?? 2),
        brightness: brightnessFromWire(r[off + 2] ?? 4),
        color: numToRgb(num === WHITE_SENTINEL ? 0xffffff : num),
        enabled: effIdx !== 0,
        dazzle: music ? colourMode === 0 : colourMode === 8,
        option: ((r[off + 3] ?? 0) >> 4) & 0x0f,
      },
    ];
  }

  /**
   * Side / underglow strip — vendor getSideLightSetting, same shape as the
   * main zone (see readLighting). `effect`/`wire` now go through the
   * corrected `{name, wire}` table (shared/lighting.ts) instead of a flat
   * array index, since the old array had Snake at the wrong position.
   */
  override async readSideLighting(): Promise<SideLightingSettings | null> {
    const r = await this.ch.request(this.frame(KB_CMD.GET_SLEDPARAM), KB_CMD.GET_SLEDPARAM, 3, 6);
    if (!r) return null;
    const off = feaPayloadStart(r, KB_CMD.GET_SLEDPARAM);
    const effWire = r[off] ?? 1;
    const num = ((r[off + 4] ?? 0) << 16) | ((r[off + 5] ?? 0) << 8) | (r[off + 6] ?? 0);
    return {
      effect: sideEffectName(effWire),
      speed: sideSpeedFromWire(r[off + 1] ?? 2),
      brightness: brightnessFromWire(r[off + 2] ?? 4),
      color: numToRgb(num === WHITE_SENTINEL ? 0xffffff : num),
      enabled: effWire !== 0,
      dazzle: ((r[off + 3] ?? 0) & 0x0f) === 8,
    };
  }

  /**
   * Per-key ("user picture") colours — vendor `getLightPic`:
   * `USERPIC_READ_CHUNKS` GET_USERPIC reads concatenated, RGB triples indexed
   * by firmware matrix `slot` (not layout array position — see
   * shared/layouts.ts). `provenance: verified-capture` for the query frame
   * (FINDINGS-R85HE.md's GET argument table), `inferred` for the reply offset
   * — but the same offset is now verified for both sibling paged reads.
   */
  override async readPerKeyLighting(): Promise<PerKeyColor[] | null> {
    const bytes = await this.ch.transaction((io) =>
      this.readUserPicWith(io.write, io.read, USERPIC_READ_CHUNKS),
    );
    // null, not []: a read that got no answer used to come back as a picture
    // with every key off, so "Read from keyboard" blanked the board and said
    // nothing. The renderer tells the two apart (see PerKeyPane).
    return bytes ? decodeUserPicBytes(bytes) : null;
  }

  /**
   * Read `chunks` GET_USERPIC pages as raw paced write/read pairs.
   *
   * **These replies carry no command echo and no checksum** — 64 data bytes
   * starting at `frame[1]`, the same shape as `GET_KEYMATRIX` and the paged
   * `GET_MULTI_MAGNETISM` reads. So this must NOT go through `ch.request()`,
   * which filters on `reply[1] === expectCommand`: it rejects every valid
   * chunk, and burning its full 3 x 6 attempt budget on each of 6 chunks fires
   * ~126 unpaced feature reports — the rate FINDINGS-R85HE.md's "Note —
   * endpoint lockup" says wedges the MI_02 vendor endpoint until the board is
   * physically replugged. That was the reported "reading colours freezes the
   * keyboard".
   *
   * Takes the *unlocked* `write`/`read` primitives so `setPerKeyLighting` can
   * reuse it to verify its own write inside the same transaction (the deadlock
   * `HidChannel.transaction`'s doc comment warns about), mirroring
   * `CompxHeKeyboard.readMagnetismPage`.
   */
  protected async readUserPicWith(
    write: (frame: Uint8Array) => Promise<void>,
    read: (timeoutMs?: number, featureLen?: number) => Promise<Uint8Array | null>,
    chunks: number,
  ): Promise<number[] | null> {
    const bytes: number[] = [];
    for (let n = 0; n < chunks; n++) {
      const query = this.frame(KB_CMD.GET_USERPIC, [0, 0xff, n]);
      await write(query);
      // The firmware needs a moment; reading too eagerly returns the previous
      // chunk's buffer still sitting in the endpoint. Same pacing as
      // `readMagnetismPage`, and what keeps this off the lockup threshold.
      if (this.settleMs) await delay(this.settleMs);
      const back = await read(250, this.d.reportLength);
      if (!back || isEchoOf(back, query)) return null;
      bytes.push(...Array.from(back.subarray(USERPIC_REPLY_OFFSET)));
    }
    return bytes;
  }

  /**
   * Every macro the board holds, slot by slot (see MACRO_BYTES), each read
   * only as far as its events run — one page for most — up to the first slot
   * of unwritten flash. An empty slot between two macros is skipped, not the
   * end. Each comes back as `onboard-<slot>`, named by its number: the board
   * keeps no names.
   *
   * The stop is what keeps this to a few pages: all 64 slots would be 64
   * paced reads, two seconds, on every open of the Macros or Keys tab. Shark
   * Deck itself only pushes to a slot in use or the first empty one, so it
   * leaves no macro past unwritten flash; one put there by other software is
   * missing from the list (a key bound to it still says "Macro 64"), never
   * written over — Push offers that first empty slot, which comes before it.
   */
  override async readMacros(): Promise<Macro[]> {
    await this.untilSaved();
    return this.ch.transaction(async (io) => {
      const out: Macro[] = [];
      for (let slot = 0; slot < KB_MACRO_SLOTS; slot++) {
        const bytes = await this.readMacroSlotWith(io, slot);
        if (!bytes) return out;
        if (bytes.slice(0, MACRO_HEADER + 2).every((b) => b === 0xff)) break;
        const m = decodeMacro(`onboard-${slot}`, `Macro ${slot + 1}`, bytes);
        if (m.steps.length) out.push(m);
      }
      return out;
    });
  }

  /** One slot's bytes, read only as far as its events run; null when a page goes unanswered. */
  protected async readMacroSlotWith(
    io: {
      write: (frame: Uint8Array) => Promise<void>;
      read: (timeoutMs?: number, featureLen?: number) => Promise<Uint8Array | null>;
    },
    slot: number,
  ): Promise<number[] | null> {
    const bytes: number[] = [];
    for (let p = 0; p < MACRO_READ_PAGES; p++) {
      const page = await this.readMacroWith(io.write, io.read, 1, slot * MACRO_READ_PAGES + p);
      if (!page) return null;
      bytes.push(...page);
      if (macroEnd(bytes) !== -1) break;
    }
    return bytes;
  }

  /**
   * Read `chunks` GET_MACRO pages as raw paced write/read pairs — the same
   * shape as `readUserPicWith`, and for the same reason.
   *
   * This used to go through `ch.request(…, KB_CMD.GET_MACRO, 3, 6)`, which
   * filters on `reply[1] === 139`. The captured reply's byte 1 is **data**
   * (`00 ff ff ff …`), never the command, so the filter could never match: the
   * call always returned `[]` after burning 5 chunks x 3 attempts x 6 reads =
   * 90 unpaced feature reports — the exact rate FINDINGS-R85HE.md's
   * "Note — endpoint lockup" blames — from both `ipc.readMacros` and
   * `saveMacro`'s read-back. `provenance: inferred` for the reply offset:
   * every sibling in this family (GET_KEYMATRIX / GET_USERPIC /
   * GET_MULTI_MAGNETISM) starts its data at byte 1, and the captured reply
   * agrees that byte 1 is not a command echo.
   *
   * The query is `[0, page]`. It was `[0, 0xff, page]`, the key map's shape,
   * which an R98 HE answers with 0xFF fill whatever it holds — so a macro
   * pushed and stored read back as an empty slot.
   */
  protected async readMacroWith(
    write: (frame: Uint8Array) => Promise<void>,
    read: (timeoutMs?: number, featureLen?: number) => Promise<Uint8Array | null>,
    chunks: number,
    first = 0,
  ): Promise<number[] | null> {
    const bytes: number[] = [];
    for (let n = first; n < first + chunks; n++) {
      const query = this.frame(KB_CMD.GET_MACRO, [0, n]);
      await write(query);
      if (this.settleMs) await delay(this.settleMs);
      const back = await read(250, this.d.reportLength);
      if (!back || isEchoOf(back, query)) return bytes.length ? bytes : null;
      bytes.push(...Array.from(back.subarray(MACRO_REPLY_OFFSET)));
    }
    return bytes;
  }

  // -- writes (ported frame layout, inferred checksum) --------------
  override async setActiveProfile(slot: number): Promise<WriteResult> {
    return this.writeVerified(KB_CMD.SET_PROFILE, [slot - 1], {
      getCommand: KB_CMD.GET_PROFILE,
      compare: (p) => (p[0] ?? -1) === slot - 1,
    });
  }

  override async setPollRate(hz: number): Promise<WriteResult> {
    const idx = RATE_TO_IDX[hz] ?? 3;
    // vendor: i[0]=CMD_SET_REPORT, i[2]=idx  => args = [0x00, idx]
    return this.writeVerified(KB_CMD.SET_REPORT, [0x00, idx], {
      getCommand: KB_CMD.GET_REPORT,
      compare: (p) => (p[1] ?? -1) === idx,
    });
  }

  override async setPower(p: PowerSettings): Promise<WriteResult> {
    const light = (p.never ? 0 : p.sleepTimerSec) & 0xffff;
    const deep = (p.deepSleepSec ?? 0) & 0xffff;
    // vendor setSleepTime: args[7..8]=time_bt, [9..10]=time_24,
    // [11..12]=deepTime_bt, [13..14]=deepTime_24 (args[i] == vendor e[i+1]).
    // Program both radios to the same value so the timer holds on either link.
    const le = (v: number) => [v & 0xff, (v >> 8) & 0xff];
    const args = [0, 0, 0, 0, 0, 0, 0, ...le(light), ...le(light), ...le(deep), ...le(deep)];
    return this.writeVerified(KB_CMD.SET_SLEEPTIME, args, { getCommand: KB_CMD.GET_SLEEPTIME });
  }

  /**
   * Whole-board lighting write — `SET_LEDPARAM` (0x07). Verified frame from the
   * capture: `00 07 <effect> <speed 0-4> <brightness 0-4> <option> <r> <g> <b>`
   * with the checksum at byte 9 (the `compx-fea` scheme places it there for
   * 0x07/0x08 automatically — no per-call override). `option` 0x08 = dazzle,
   * 0x07 = plain. `speed`/`brightness` are 0-4 wire values, NOT 0-100.
   */
  override async setLighting(
    l: LightingSettings,
    opts: { quiet?: boolean; streaming?: boolean } = {},
  ): Promise<WriteResult> {
    // Through `currentEffectLabel` so a profile or saved layout written under
    // a since-corrected label ("Ripple", "Laser") still resolves to its wire
    // index instead of falling back to 0 — which is Off, i.e. a stored effect
    // silently becoming "lights out".
    const effect = l.enabled
      ? Math.max(0, KB_LIGHT_EFFECTS.indexOf(currentEffectLabel(l.effect)))
      : 0;
    // Option byte = direction/variant in the HIGH nibble, colour mode in the
    // low one — vendor `setLightSetting`:
    //   o = option << 4 | (dazzle ? LIGHT_DAZZLE(8) : LIGHT_NORMAL(7))
    //   LightUserPicture      -> o = option << 4            (no colour nibble)
    //   LightMusicFollow2/3   -> o = option << 4 | (dazzle ? 0 : 4)
    //   LightScreenColor      -> o = 0
    // The direction half was never sent (always 0), so effects with a
    // direction — Wave, Snake, Kaleidoscope, Line Wave, Circle Wave — were
    // stuck on their first option.
    const dir = (clamp(l.option ?? 0, 0, 15) << 4) & 0xf0;
    const id = KB_LIGHT_EFFECTS_TABLE[effect]?.id;
    let option = dir | (l.dazzle ? 8 : 7);
    if (id === 'LightUserPicture') option = dir;
    else if (id === 'LightMusicFollow3' || id === 'LightMusicFollow2')
      option = dir | (l.dazzle ? 0 : 4);
    else if (id === 'LightScreenColor') option = 0;

    let rgb = l.color;
    if (effect === KB_PERKEY_EFFECT_INDEX) rgb = [0, 200, 200];

    /**
     * Off is effect 0 at the lowest speed and brightness, plain colour mode,
     * the colour kept — not merely effect 0.
     *
     * Selecting Off left `speed`, `brightness` and the option nibble at
     * whatever the previous effect had, so the board received "effect 0,
     * brightness 4". Reported symptom: choosing Off changes nothing — the
     * lights stay as they were.
     *
     * `provenance: verified-capture`: Attack Shark Driver v4 choosing Off on
     * an R98 HE (its owner's recording, 2026-11-22) sends
     * `07 00 04 00 07 fa ff fa` — speed 0 (wire 4: speed is inverted),
     * brightness 0, option 7, the colour it had. This sent all zeros, which
     * was reasoned from the effect table rather than seen.
     */
    const args =
      effect === 0
        ? [0, speedToWire(0), 0, 7, ...rgb]
        : [effect, speedToWire(l.speed), brightnessToWire(l.brightness), option, ...rgb];
    return this.writeVerified(KB_CMD.SET_LEDPARAM, args, {
      // A streaming frame skips the read-back: it is one of several a second
      // and the value is replaced before anyone could act on a mismatch.
      getCommand: opts.streaming ? undefined : KB_CMD.GET_LEDPARAM,
      compare: (p) => (p[0] ?? -1) === effect,
      // The board applies this asynchronously — an immediate GET can still
      // answer with the previous effect. Worst right after a burst, which is
      // exactly where ensureCustomEffect calls it (7 SET_USERPIC + 6
      // GET_USERPIC frames land immediately before).
      settleMs: this.settleMs,
      quiet: opts.quiet,
    });
  }

  /**
   * Side / edge lighting — `SET_SLEDPARAM` (0x08), same shape as SET_LEDPARAM.
   * Effect and colour-mode ("Shining" = dazzle multicolour vs a fixed custom
   * colour) are orthogonal, same `option = dazzle ? 8 : 7` convention the
   * main zone already uses — generalised here to every effect rather than
   * hardcoded to Neon only.
   *
   * **Speed does NOT share the main zone's inversion** — see
   * `sideSpeedToWire`. The effect table is different here too
   * (`SIDE_LIGHT_EFFECTS`, non-contiguous wire values).
   */
  override async setSideLighting(l: SideLightingSettings): Promise<WriteResult> {
    const effect = l.enabled ? sideEffectWire(l.effect) : 0;
    const option = l.dazzle ? 8 : 7;
    // Off as the official software sends it (R98 HE recording, 2026-11-22):
    // `08 00 00 00 07 fa ff fa` — speed and brightness 0, plain, colour kept.
    const args =
      effect === 0
        ? [0, sideSpeedToWire(0), 0, 7, ...l.color]
        : [effect, sideSpeedToWire(l.speed), brightnessToWire(l.brightness), option, ...l.color];
    return this.writeVerified(KB_CMD.SET_SLEDPARAM, args, {
      getCommand: KB_CMD.GET_SLEDPARAM,
      compare: (p) => (p[0] ?? -1) === effect,
    });
  }

  /**
   * Per-key colours — vendor _setLightPic. Captured frame:
   * `00 0c 00 ff <chunkIdx> 0x38 00 00 ck@8 <56 RGB bytes>` — **5 chunks x
   * 56 = 280 bytes**, using the descriptor's default `compx-fea` checksum
   * (dropping the old `'bit7'` override, which was the wrong scheme entirely
   * — a frame with the wrong checksum byte is rejected outright by the real
   * R85HE). `keys[].index` must already be the firmware matrix `slot` (see
   * shared/layouts.ts) — the caller resolves it via `slotOf()`, not layout
   * array position.
   *
   * Runs as one transaction (write all `USERPIC_WRITE_CHUNKS` chunks, then
   * read them back — 7 writes of 56 bytes for 378 bytes total, verified by 6
   * reads of 64; this comment used to say "5 chunks"/280 bytes, which never
   * matched either the code or the capture) so
   * nothing else on this channel can land a frame mid-sequence and corrupt
   * the assembled picture, and so the read-back genuinely reflects what was
   * just written rather than a stale unrelated poll. Switching the board's
   * main effect to "Custom" happens *after* this transaction resolves (it
   * would deadlock if attempted from inside — see `ensureCustomEffect`).
   */
  override async setPerKeyLighting(
    keys: PerKeyColor[],
    opts: PerKeyLightingOpts = {},
  ): Promise<WriteResult> {
    const km = this.d.spec.keyMatrix;
    const validSlots = km?.layout
      ? new Set(km.layout.map((e) => e.slot).filter((s): s is number => s !== undefined))
      : null;
    const buf = new Array(USERPIC_BYTES).fill(0);
    const wanted = new Map<number, [number, number, number]>();
    let skipped = 0;
    for (const k of keys) {
      if (validSlots && !validSlots.has(k.index)) {
        skipped++;
        continue;
      }
      const base = k.index * 3;
      if (base + 2 >= buf.length) {
        skipped++;
        continue;
      }
      buf[base] = k.color[0] & 0xff;
      buf[base + 1] = k.color[1] & 0xff;
      buf[base + 2] = k.color[2] & 0xff;
      wanted.set(k.index, k.color);
    }
    if (skipped)
      this.warn(`Per-key lighting: ${skipped} key(s) outside the addressable range were skipped.`);

    const frames: string[] = [];
    const result = await this.ch.transaction<WriteResult>(async (io) => {
      for (let n = 0; n < USERPIC_WRITE_CHUNKS; n++) {
        const chunk = buf.slice(n * USERPIC_CHUNK, n * USERPIC_CHUNK + USERPIC_CHUNK);
        // Byte 5 is THIS chunk's payload length, not a constant 56 — the final
        // chunk is the 42-byte remainder of the 378-byte map. Byte 6 is the
        // last-chunk flag, and it is what makes the firmware commit; without
        // it the board accepts every chunk and applies nothing.
        const len = Math.min(USERPIC_CHUNK, USERPIC_BYTES - n * USERPIC_CHUNK);
        const last = n === USERPIC_WRITE_CHUNKS - 1 ? 1 : 0;
        const tx = this.frame(KB_CMD.SET_USERPIC, [0, 0xff, n, len, last, 0, ...chunk]);
        frames.push(toHex(tx));
        try {
          await io.write(tx);
        } catch (e) {
          return { ok: false, verified: 'unverified', error: String(e), frames };
        }
        // Pace the chunks. FINDINGS-R85HE.md's "Note — endpoint lockup": rapid
        // back-to-back HidD_SetFeature calls wedge the MI_02 endpoint, and the
        // vendor app spaces its own vendor-channel writes out.
        if (this.settleMs) await delay(this.settleMs);
      }
      // A streaming repaint skips the read-back entirely — see
      // `PerKeyLightingOpts.streaming`. Reported as unverified, because it is.
      if (opts.streaming) return { ok: true, verified: 'unverified', frames };
      // The whole map was just written, so verify the whole map — the read's
      // chunks are 64 bytes, the write's 56, so this is 6 reads for 7 writes.
      const back = await this.readUserPicWith(io.write, io.read, USERPIC_READ_CHUNKS);
      if (!back) return { ok: true, verified: 'unverified', frames };
      const got = new Map(decodeUserPicBytes(back).map((c) => [c.index, c.color] as const));
      let mismatch = false;
      for (const [idx, color] of wanted) {
        const g = got.get(idx);
        if (!g || g[0] !== color[0] || g[1] !== color[1] || g[2] !== color[2]) {
          mismatch = true;
          break;
        }
      }
      return { ok: true, verified: mismatch ? 'mismatch' : 'match', frames };
    });
    if (result.verified === 'mismatch') {
      this.warn(
        'Per-key lighting: read-back did not match — the SET_USERPIC frame shape/offset is still unconfirmed (see FINDINGS-R85HE.md).',
      );
    }
    if (!result.ok) return result;
    // A streaming repaint has already been put on the per-key layer by
    // whoever started the sequence; re-asserting it costs a GET_LEDPARAM plus
    // possibly a SET per repaint.
    if (opts.streaming) return result;
    // Flipping the board to Custom is part of "paint a key", not a separate
    // user action, so its outcome folds into this one result instead of
    // raising its own toast (kbWorst keeps the worse of the two). Returns null
    // when the board is already on Custom, which is the common case.
    const effect = await this.ensureCustomEffect(opts.brightness);
    return effect ? kbWorst([result, effect]) : result;
  }

  /**
   * Ensures the board's main lighting effect is Custom (the per-key layer)
   * so painted colours actually display — the vendor UI does this
   * automatically whenever a per-key colour is applied. Always re-reads the
   * live effect (cheap — one GET) rather than caching a boolean, so a
   * change made elsewhere (the Global effect pane) is never missed; only
   * *writes* when the effect isn't already Custom, since `SET_LEDPARAM` is a
   * feature-report write and FINDINGS-R85HE.md's "endpoint lockup" note
   * warns rapid redundant writes can wedge the vendor endpoint — this is
   * called once per per-key write, which is already debounced upstream.
   */
  private async ensureCustomEffect(brightness?: number): Promise<WriteResult | null> {
    const customName = KB_LIGHT_EFFECTS[KB_PERKEY_EFFECT_INDEX] ?? 'Custom';
    const current = (await this.readLighting())[0];
    // Already on Custom and the caller has no opinion on brightness: nothing
    // to write. A caller that DOES pass one still writes, or the per-key
    // brightness control would be dead for exactly the state it applies to.
    if (current?.effect === customName && brightness === undefined) return null;
    /**
     * Brightness when switching the board onto the per-key layer.
     *
     * Order: what the caller asked for, else what the board already has, else
     * full. **The zero is deliberately not carried over.** Whatever the board
     * reports as 0 — lighting genuinely off, or a stale read right after the
     * 7-chunk SET_USERPIC burst this runs immediately behind — writing it back
     * means the picture the user just applied displays at zero brightness,
     * i.e. an apply that looks like it turned the lighting OFF. That was the
     * reported symptom.
     *
     * The vendor does the same thing and is even blunter about it: its own
     * per-key apply sends `bright: light.type === 'LightUserPicture' ?
     * light.bright : 4` — keep it only when already on this layer, otherwise
     * jump to max (wire 4 = 100%).
     */
    const bright = brightness ?? (current?.brightness || 100);
    // With no read we cannot know the board's current speed, and switching to
    // Custom still has to send a value for it — so that path writes a default
    // over whatever the user had. Still worth doing (the painted colours do
    // not display at all otherwise), but the result must NOT claim to be
    // confirmed: downgrade it so the toast says "sent (no read-back available
    // to confirm)" rather than "applied and confirmed".
    const next: LightingSettings = current
      ? { ...current, effect: customName, brightness: bright, enabled: true }
      : {
          zone: 'keyboard',
          effect: customName,
          brightness: bright,
          speed: 50,
          color: [0, 200, 200],
          enabled: true,
        };
    // `quiet`: the caller folds this into its own result, so a problem here
    // surfaces as "Per-key lighting: …" rather than a bare
    // "Read-back mismatch for command 0x7." toast for a command the user never
    // issued by name — the reported confusion when painting a key worked.
    const r = await this.setLighting(next, { quiet: true });
    return current || !r.ok ? r : { ...r, verified: 'unverified' };
  }

  override async setButton(key: number, action: string): Promise<WriteResult> {
    return this.setKeyRemap('base', key, action);
  }

  /**
   * Key remap — verified frames from the capture:
   *   base:  `00 0a 03 <slot> 00 00 01 00 ck <hi> <lo>`   (SET_KEYMATRIX, layer 3)
   *   fn:    `00 10 00 00 <slot> 00 00 00 ck <hi> <lo>`   (SET_FN, slot at byte 4)
   * The target HID code is 16-bit big-endian in the bulk payload after the
   * checksum (F12 = `00 45`). `"00"` is the deliberate "disable this key";
   * anything that is not hex is REFUSED rather than quietly becoming 0 — see
   * below.
   *
   * `action` is either:
   *  - **1-4 hex digits** — a HID usage ("04" = A, "e0" = LCtrl), laid out as
   *    the quad `[0, hi, lo, 0]`; or
   *  - **exactly 8 hex digits** — the four quad bytes verbatim, written as they
   *    will be stored. That is how a binding that is not a plain key gets
   *    written at all: the factory Fn layer is full of consumer usages
   *    (`03 00 ea 00` is Volume -) and lighting controls (`0d 01 00 00`), and
   *    with only a usage to send, "Reset to default" could not put any of them
   *    back — it had nothing to say but "make this key do nothing".
   *
   * Eight digits is unambiguous against four: no HID usage is that wide.
   */
  override async setKeyRemap(
    layer: 'base' | 'fn',
    index: number,
    action: string,
  ): Promise<WriteResult> {
    // A malformed action used to resolve to usage 0, which is not "no change"
    // — it is "this key now does nothing". A typo and a deliberate disable
    // were indistinguishable, and the only outcome a remap must never produce
    // by accident is a dead key.
    const quad = quadFor(action);
    if (!quad) {
      return {
        ok: false,
        verified: 'unverified',
        error: `not a HID usage or quad: "${action}" (1-4 hex digits, or 8 for a raw quad)`,
      };
    }
    const slot = index & 0xff;
    if (layer === 'fn') return this.setFnSlot(slot, quad);
    // `[layer, slot, pad, pad, commit, zone]` -> bytes 2..7, ck@8, then the
    // 4-byte slot quad at bytes 9..12.
    //
    // The quad is stored VERBATIM and the HID code belongs at quad byte **2**,
    // not byte 1. Verified on a real R85HE: the factory quad for A (slot 9) is
    // `[0, 0, 4, 0]`, and reading the whole matrix that way matches all 77
    // layout entries. Writing `[0, 5, 0, 0]` stored exactly that and the app
    // then read the code back as 0 — `decodeQuad` takes raw[2].
    //
    // Layer is 0, matching the layer the read uses; a no-op write at layer 0
    // round-tripped, and a real remap at layer 0 changed slot 9 and nothing
    // else.
    //
    // NO `getCommand` HERE, deliberately.
    //
    // `writeVerified`'s read-back sends a bare `frame(getCommand)` — a
    // GET_KEYMATRIX with all-zero args. That is not the query this command
    // takes: the real one is `[0x00, 0xff, <chunk>, 0x00]`, the first frame of
    // an eight-chunk paged sweep. `readKeyBindings` above says what a
    // wrong-shaped matrix GET costs — "not a soft failure: the wrong shape
    // hangs the MCU on the very first frame" — and this fired it after every
    // single remap.
    //
    // That is the reported "applied and confirmed, then couldn't read the
    // base-layer bindings, then the key was dead": the write landed, the
    // stray GET left the firmware mid-sweep, the next real read came back as
    // an echo (so `null`), and the pane went blank. It reported `match`
    // throughout because with no `compare` any reply counts as one.
    //
    // The renderer re-reads the whole layer straight after this, which is the
    // honest verification — a paged sweep, in the shape the firmware expects.
    // The last four bytes ARE the quad, in order — so a raw quad goes on the
    // wire exactly as given, and a plain usage still produces `[0, hi, lo, 0]`.
    const r = await this.writeVerified(
      KB_CMD.SET_KEYMATRIX,
      keymatrixArgs(slot, quad, { commit: true, zone: 0 }),
    );
    // That re-read waits for the board to save it (KEYMATRIX_SAVE_MS).
    this.savingFor(KEYMATRIX_SAVE_MS);
    return r;
  }

  /**
   * Read every slot's current binding for one layer. `GET_KEYMATRIX` (base,
   * layer arg `0x03`) / `GET_FN` (Fn layer) chunked per FINDINGS-R85HE.md's
   * verified query shape (`00 8a 00 ff <chunkIdx> <layer> 00 00 ck`); the
   * reply's data offset and per-slot shape are `inferred` (see
   * KEYMATRIX_REPLY_OFFSET / decodeQuad) — never fabricated: a device that
   * doesn't answer returns `null`, not a guessed table.
   *
   * **Nothing from the vendor's factory tables is mixed in.** This used to
   * overlay KB_FN_DEFAULT_SLOTS on top of the live read — its label, its kind,
   * and a `locked` flag — so a board whose Fn layer differs from the table it
   * was decoded from was described by the table rather than by itself. The
   * reported symptom was Fn+F12 showing "Volume +" on a board where it prints
   * the screen. The factory table is now only consulted by the RENDERER, to
   * answer "has this been changed from stock", which is the one question it can
   * actually answer.
   */
  override async readKeyBindings(layer: 'base' | 'fn'): Promise<Record<number, KeyBinding> | null> {
    // GET_KEYMATRIX and GET_FN take DIFFERENT argument layouts — see
    // readMatrixChunks. Getting that wrong is not a soft failure: the wrong
    // shape hangs the MCU on the very first frame.
    const bytes =
      layer === 'base'
        ? await this.readMatrixChunks(KB_CMD.GET_KEYMATRIX, (chunk) => [0x00, 0xff, chunk, 0x00])
        : await this.readMatrixChunks(KB_CMD.GET_FN, await this.fnArgs());
    if (!bytes) return null;
    const out: Record<number, KeyBinding> = {};
    for (let slot = 0; slot * KEYMATRIX_SLOT_STRIDE + 3 < bytes.length; slot++) {
      const o = slot * KEYMATRIX_SLOT_STRIDE;
      const raw: [number, number, number, number] = [
        bytes[o] ?? 0,
        bytes[o + 1] ?? 0,
        bytes[o + 2] ?? 0,
        bytes[o + 3] ?? 0,
      ];
      out[slot] = decodeQuad(slot, raw);
    }
    return out;
  }

  /*
   * The two matrix GETs and their argument layouts, from the vendor bundle
   * (scripts/_raw/qmk-bundle.js — the generation whose GET_KEYMATRIX this board
   * demonstrably speaks). Frame byte 1 is the command, so vendor r[k] is our
   * frame byte k + 1; our args[] therefore starts at vendor r[1].
   *
   *   GET_KEYMATRIX (138)  r[1]=profile  r[2]=0xff       r[3]=chunk  r[4]=fnProfile
   *   GET_FN        (144)  r[1]=fnOS     r[2]=fnProfile  r[3]=0xff   r[4]=chunk
   *
   * The chunk index sits in a DIFFERENT slot in each. This driver used to send
   * [0, 0xff, chunk] for both, which as a GET_FN means fnProfile = 0xff with
   * the chunk left at 0 — an out-of-range profile. Verified on a real R85HE
   * (fw v5.11): the base sweep completes all 8 chunks and the board keeps
   * answering, while that GET_FN frame wedges the MCU on chunk 0 and needs a
   * replug. That is exactly the "a bare GET that actually needs a page/layer
   * argument hangs the whole keyboard MCU" case CAPTURE-KEYBOARD.md warns
   * about, and it was the reported "reading the Fn layer freezes the
   * keyboard". provenance: ported-from-vendor.
   */

  /**
   * The Fn read/write argument prefix, resolved from the board's own KBOPTION
   * register: [fnOS, fnProfile, 0xff, chunk]. Falls back to Windows /
   * profile 0 when the register cannot be read — the factory values, and what
   * the vendor itself sends with no cached answer (FnOSToNum(i ?? 'win')).
   */
  protected async fnArgs(): Promise<(chunk: number) => number[]> {
    const o = this._kbOptions ?? (await this.readKeyboardOptions().catch(() => null));
    const fnOs = o?.fnOs === 'mac' ? 1 : 0;
    const fnProfile = o?.fnProfile ?? 0;
    return (chunk) => [fnOs, fnProfile, 0xff, chunk];
  }

  protected async readMatrixChunks(
    cmd: number,
    args: (chunk: number) => number[],
  ): Promise<number[] | null> {
    // ONE transaction for the whole sweep, not one per chunk.
    //
    // This used to open a fresh `ch.transaction` inside the loop — the comment
    // below already claimed "one transaction, same as the paged magnetism
    // reads", but the code did not do it. Because the channel's serialization
    // gate is released at the end of each transaction, anything else queued on
    // the channel could run **between two chunks of the same sweep**: most
    // often the manager's 2.5s `ping()` (a GET_PROFILE), landing a foreign
    // command in the middle of a paged read the firmware expects to be
    // contiguous. Both sibling readers — `readUserPicWith` and
    // `CompxHeKeyboard.readMagnetismPage` — wrap all of their chunks in a
    // single transaction for exactly this reason, and `readUserPicWith`'s own
    // comment names the symptom it fixed there: "reading colours freezes the
    // keyboard".
    // One retry, behind a settle, when the sweep gets nothing at all.
    //
    // The renderer re-reads immediately after a remap write, and a board still
    // busy applying it answers the first chunk with our own buffer — which
    // `isEchoOf` correctly refuses, but "busy for another 30ms" then surfaced
    // to the user as "couldn't read the current base-layer bindings from the
    // device". Retrying the sweep once costs a beat and removes that.
    await this.untilSaved();
    const once = () => this.readMatrixChunksOnce(cmd, args);
    const first = await once();
    if (first) return first;
    if (this.settleMs) await delay(this.settleMs * 4);
    return once();
  }

  private async readMatrixChunksOnce(
    cmd: number,
    args: (chunk: number) => number[],
  ): Promise<number[] | null> {
    return this.ch.transaction(async (io) => {
      const bytes: number[] = [];
      for (let n = 0; n < KEYMATRIX_CHUNKS; n++) {
        const query = this.frame(cmd, args(n));
        // These bulk replies carry NO command echo and no checksum — the data
        // begins at byte 1. `ch.request()` filters on `reply[1] === cmd` and
        // verifies a reply checksum, so it rejected every valid chunk and this
        // returned null.
        await io.write(query);
        // The firmware needs a moment; reading too eagerly returns the previous
        // chunk's buffer still sitting in the endpoint.
        if (this.settleMs) await delay(this.settleMs);
        const r = await io.read(250, this.d.reportLength);
        // An unimplemented page/layer is not answered at all and Windows hands
        // back our own SetFeature buffer.
        if (!r || isEchoOf(r, query)) return bytes.length ? bytes : null;
        bytes.push(...Array.from(r.subarray(KEYMATRIX_REPLY_OFFSET, r.length)));
      }
      return bytes;
    });
  }

  /**
   * Write one Fn-layer slot, as the official software does: one SET_FN frame
   * naming the slot, `[fnOS, fnProfile, slot, 0, 0, 0]`, then its four bytes.
   *
   * `verified-capture`: the frame Attack Shark Driver v4 sent an R98 HE to
   * give Fn + P a new action (its owner's recording), byte for byte the one
   * this builds (capture/checks.ts makes it again and compares). This used to
   * be a read-modify-write of the whole 128-slot table in ten chunks
   * (`r[3] = 0xff`, the shape of qmk.top's ___cmdSetFnKeyConfig): eight reads
   * and ten writes for one key, and as many again for each Fn key a profile
   * changed. The page holding the slot is read back to confirm it.
   */
  protected async setFnSlot(
    slot: number,
    quad: readonly [number, number, number, number],
  ): Promise<WriteResult> {
    if (slot < 0 || slot >= FN_MATRIX_SLOTS) {
      return {
        ok: false,
        verified: 'unverified',
        error: 'Fn slot ' + slot + ' is outside the matrix.',
      };
    }
    const args = await this.fnArgs();
    const [fnOs = 0, fnProfile = 0] = args(0);
    // Verbatim: the quad the caller built is the quad that gets stored, media
    // keys and lighting controls included.
    const q = this.frame(KB_CMD.SET_FN, [
      fnOs,
      fnProfile,
      slot,
      0,
      0,
      0,
      ...quad.map((b) => b & 0xff),
    ]);
    const frames = [toHex(q)];
    const write = await this.ch.transaction(async (io) => {
      try {
        await io.write(q);
      } catch (e) {
        return { ok: false, verified: 'unverified' as const, error: String(e), frames };
      }
      // A flash write: the vendor waits its defaultVendorSleepTime (100 ms)
      // before any further traffic, or the read below answers nothing.
      await delay(this.backupPaceMs);
      return { ok: true, verified: 'unverified' as const, frames };
    });
    if (!write.ok) return write;
    this.savingFor(KEYMATRIX_SAVE_MS);
    const page = await this.readMatrixPage(KB_CMD.GET_FN, args, Math.floor(slot / 16));
    const o = (slot % 16) * KEYMATRIX_SLOT_STRIDE;
    // All four bytes, not the two a plain usage happens to occupy.
    const match = !!page && quad.every((b, i) => page[o + i] === (b & 0xff));
    return { ...write, verified: page ? (match ? 'match' : 'mismatch') : 'unverified' };
  }

  /** One page of a GET_KEYMATRIX / GET_FN sweep (`readMatrixChunks`): 16 slots. */
  protected async readMatrixPage(
    cmd: number,
    args: (chunk: number) => number[],
    page: number,
  ): Promise<number[] | null> {
    await this.untilSaved();
    return this.ch.transaction(async (io) => {
      const query = this.frame(cmd, args(page));
      await io.write(query);
      if (this.settleMs) await delay(this.settleMs);
      const r = await io.read(250, this.d.reportLength);
      if (!r || isEchoOf(r, query)) return null;
      return Array.from(r.subarray(KEYMATRIX_REPLY_OFFSET, r.length));
    });
  }

  /** Back-compat thin alias — prefer `readKeyBindings('fn')`. */
  override async readFnLayer(): Promise<Record<number, string>> {
    const bindings = await this.readKeyBindings('fn');
    if (!bindings) return {};
    const out: Record<number, string> = {};
    for (const [slot, b] of Object.entries(bindings)) if (b.code) out[Number(slot)] = b.code;
    return out;
  }

  /**
   * Write the macro to the onboard slot: 256-byte payload (see `encodeMacro`)
   * split into 56-byte chunks, each `SET_MACRO [0, 0xFF, chunkIdx, len, last]` +
   * data, signed Bit7. Ported frame shape, inferred checksum.
   */
  /** Write a macro into `slot` (0-based; the first unless named), replacing it. */
  override async saveMacro(m: Macro, slot = 0): Promise<WriteResult> {
    if (!Number.isInteger(slot) || slot < 0 || slot >= KB_MACRO_SLOTS) {
      return { ok: false, verified: 'unverified', error: `macro slot out of range: ${slot + 1}` };
    }
    const buf = encodeMacro(m);
    // As many chunks as the events take, each 56 bytes, the last one flagged:
    // `0b 00 <chunk> 38 <last> 00 00 <ck>` + data, the official software's
    // frame (see the macro encoding above), checksum the family's own.
    const chunks = Math.max(1, Math.ceil((buf.length + MACRO_END) / MACRO_CHUNK));
    const frames: string[] = [];
    // Same reasoning as setPerKeyLighting: these chunks are one logical write
    // (assembled by `chunkIdx` + the final chunk's `lastFlag`) and must not
    // interleave with anything else on this channel.
    const writeResult = await this.ch.transaction<WriteResult | null>(async (io) => {
      for (let n = 0; n < chunks; n++) {
        const data = buf.slice(n * MACRO_CHUNK, n * MACRO_CHUNK + MACRO_CHUNK);
        while (data.length < MACRO_CHUNK) data.push(0);
        const last = n === chunks - 1 ? 1 : 0;
        const tx = this.frame(KB_CMD.SET_MACRO, [slot, n, MACRO_CHUNK, last, 0, 0, ...data]);
        frames.push(toHex(tx));
        try {
          await io.write(tx);
        } catch (e) {
          return { ok: false, verified: 'unverified', error: String(e), frames };
        }
      }
      return null;
    });
    if (writeResult) return writeResult;
    // Not measured for the macro; the key map's wait, the nearer kind of save.
    this.savingFor(KEYMATRIX_SAVE_MS);
    // A real read-back check, not just "some macro now exists": what the slot
    // written holds now against what was written, byte for byte as the board
    // stores it (a slot too small cuts the events, so the written ones are
    // counted from the payload itself). Only that slot is read — the list's
    // stop at unwritten flash would miss a slot past it. An empty-macro write
    // (deleteMacro) legitimately reads back as nothing.
    const wrote = decodeMacro('', '', buf);
    await this.untilSaved();
    const bytes = await this.ch.transaction((io) => this.readMacroSlotWith(io, slot));
    const back = bytes ? decodeMacro(`onboard-${slot}`, '', bytes) : null;
    const same = (x: Macro) =>
      x.repeatCount === wrote.repeatCount &&
      JSON.stringify(x.steps) === JSON.stringify(wrote.steps);
    const verified: WriteResult['verified'] = !back
      ? 'unverified'
      : !wrote.steps.length
        ? back.steps.length
          ? 'mismatch'
          : 'match'
        : same(back)
          ? 'match'
          : 'mismatch';
    return { ok: true, verified, frames };
  }

  /** Empty a slot: `onboard-<slot>` from readMacros (the first when unnamed). */
  override async deleteMacro(id?: string): Promise<WriteResult> {
    const slot = id === undefined ? 0 : macroSlotOf(id);
    if (slot === null)
      return { ok: false, verified: 'unverified', error: 'Not a macro on the keyboard' };
    return this.saveMacro({ id: 'onboard', name: '', repeatCount: 1, steps: [] }, slot);
  }

  override async restoreDefaults(): Promise<WriteResult> {
    if (this.relayed) return this.notSupported('A factory reset over the receiver (use the cable)');
    return this.writeVerified(KB_CMD.SET_RESET, [0x01]);
  }

  /** A board on its cable reports no battery; over the receiver, the receiver does. */
  override async getBattery(): Promise<{ level: number | null; charging: boolean }> {
    if (!this.relayed) return { level: null, charging: false };
    return { level: await this.relayBattery('keyboard'), charging: false };
  }

  protected override backupCommands(): number[] {
    // ONLY commands that answer a bare GET belong here — the base backup()
    // sends each one with no arguments.
    //
    // GET_KEYMATRIX / GET_FN / GET_USERPIC / GET_MACRO all need a chunk (and
    // sometimes layer) argument to answer at all, so sending them bare backed
    // up nothing; worse, CAPTURE-KEYBOARD.md warns that "a bare GET that
    // actually needs a page/layer argument hangs the whole keyboard MCU", and
    // backup() runs on the FIRST write from any tab via guardedWrite ->
    // ensureBackup(). All four are captured properly in the backup() override
    // below, through their paged readers.
    return [
      KB_CMD.GET_REPORT,
      KB_CMD.GET_PROFILE,
      KB_CMD.GET_DEBOUNCE,
      KB_CMD.GET_LEDPARAM,
      KB_CMD.GET_SLEDPARAM,
      KB_CMD.GET_KBOPTION,
      KB_CMD.GET_SLEEPTIME,
    ];
  }

  /**
   * The base key matrix is what a restore puts back, so a backup without it
   * is no backup. (The Fn layer and the rest are taken when they answer.)
   */
  override backupPolicy(): BackupPolicy {
    return { kind: 'full', required: ['keymatrix_base'] };
  }

  override async backup(): Promise<Record<string, string>> {
    const out = await super.backup();
    for (const layer of ['base', 'fn'] as const) {
      const bindings = await this.readKeyBindings(layer);
      if (bindings) out[`keymatrix_${layer}`] = JSON.stringify(bindings);
    }
    // Paced like the magnetism sweep in CompxHeKeyboard.backup(), for the same
    // endpoint-lockup reason.
    await delay(this.backupPaceMs);
    const perKey = await this.readPerKeyLighting().catch(() => null);
    if (perKey && perKey.length) out.userpic = JSON.stringify(perKey);
    await delay(this.backupPaceMs);
    const macros = await this.readMacros().catch(() => null);
    if (macros && macros.length) out.macros = JSON.stringify(macros);
    return out;
  }

  /**
   * Replay a backup. Only the parts written through a frame VERIFIED against
   * the real R85HE are replayed — the key-remap layers, via `setKeyRemap`
   * (whose SET frame is capture-verified and whose GET is read back). The raw
   * `0x<cmd>` GET-reply blocks that `backup()` also stores are NOT replayed as
   * SETs: several of those commands' payload offsets are still `inferred`, so a
   * blind SET could write the wrong field. `provenance: ported-from-vendor`.
   * `CompxHeKeyboard` extends this for the magnetism pages.
   */
  override async restoreFromBackup(blocks: Record<string, string>): Promise<WriteResult> {
    const results: WriteResult[] = [];
    for (const layer of ['base', 'fn'] as const) {
      const raw = blocks[`keymatrix_${layer}`];
      if (!raw) continue;
      let table: Record<string, { kind?: string; code?: string | null; locked?: boolean }>;
      try {
        table = JSON.parse(raw);
      } catch {
        continue;
      }
      for (const [slotStr, b] of Object.entries(table)) {
        const slot = Number(slotStr);
        // A firmware-locked Fn slot, an unused slot, or anything that isn't a
        // plain key binding has no safe SET here.
        if (!Number.isInteger(slot) || b.locked || b.kind !== 'key' || !b.code) continue;
        results.push(await this.setKeyRemap(layer, slot, b.code));
      }
    }
    if (results.length === 0) return this.notSupported('Backup restore');
    return kbWorst(results);
  }
}

/** Combine several write results into the most severe one — same policy as the
 *  mouse driver's `worst()`. */
export function kbWorst(results: WriteResult[]): WriteResult {
  if (results.length === 0) return { ok: true, verified: 'unverified' };
  const failed = results.find((r) => !r.ok);
  if (failed) return failed;
  if (results.some((r) => r.verified === 'mismatch'))
    return { ...results[0]!, verified: 'mismatch' };
  if (results.every((r) => r.verified === 'match')) return { ...results[0]!, verified: 'match' };
  return { ...results[0]!, verified: 'unverified' };
}
