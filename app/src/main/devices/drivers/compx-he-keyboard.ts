import type {
  KeyZoneBindings,
  MagneticKeySettings,
  MagneticMode,
} from '@shared/types/keyboard-settings';
import type { TravelStreamResult, WriteResult } from '@shared/types/live';
import type { KeyBinding } from '@shared/types/keys';
import {
  CompxKeyboard,
  KB_CMD,
  type KeyQuad,
  decodeQuad,
  kbWorst,
  delay,
  isEchoOf,
  keymatrixArgs,
  quadFor,
} from './compx-keyboard';
import {
  MT_HOLD_ZONE,
  MT_TAP_ZONE,
  actionOfQuad,
  isModTapEntry,
  legacyModTapHold,
} from '@shared/key-zones';
import { toHex } from '../../hid/frame';
import { KB_MAGNETISM_PAGE_CHUNKS } from '@shared/keyboard-options';
import { KB_TRAVEL_RANGE } from '@shared/keyboard-travel';
import { dksZoneBytes, dksZonesFrom } from '@shared/dks';
import { layoutAddressable } from '@shared/menuGates';
import type { BackupPolicy, MagneticWriteOpts, TravelSample } from './base';
import { frameLog } from '../../diagnostics';

/**
 * Magnetic (Hall-effect) extension of the Compx keyboard family — the class
 * behind the Attack Shark R85HE, ported from vendor chunk 5e635fe2.js
 * (`setMultiMagnetismInfo`, `getMultiMagnetismInfo`, `_decodeMagnetismKeyModes`).
 *
 * Cross-checked against qmk.top ("GearHub-V5"), the vendor's own WebHID
 * configurator, whose `PARAMETER_磁轴` table names every page below —
 * see scripts/_raw/qmk-magnetism.json and `npm run extract:qmk`.
 *
 * `SET_MULTI_MAGNETISM` (101) writes either one key (`[page, 0, slot, commit]`
 * + value) or a whole page in chunks (`[page, 1, chunkIdx, isLast]` + 56 data
 * bytes). Reads are `GET_MULTI_MAGNETISM` (229) and come back as 64 raw data
 * bytes with no command echo and no checksum — see `readMagnetismPage`.
 *
 * A page is **128 slots** wide; `chunks / 2` gives the bytes per key. Travel is
 * `mm * stepMultiplier`, the multiplier (10 / 100 / 200) keyed on the firmware
 * version — see `travelMultiplier()`.
 *
 *   page 0    travel        press distance before the key registers   2 B/key
 *   page 1    release       distance at which it releases             2 B/key
 *   page 2    rt press      rapid-trigger re-press sensitivity        2 B/key
 *   page 3    rt release    rapid-trigger release sensitivity         2 B/key
 *   page 4    dks           dynamic-keystroke points                  2 B/key
 *   page 5    mt            mod-tap hold time (ms / 10)               1 B/key
 *   page 6    dead zone     BOTTOM dead zone                          2 B/key
 *   page 7    modes         bit7 RT, bit6 full bottom-out, 0..3 mode  1 B/key
 *   page 8    dks flags     per-zone trigger flags (written; read: 10) 4 B/key
 *   page 9    socd          partner slot for snap-tap pairs           1 B/key
 *   page 251  dead zone     TOP dead zone                             1 B/key
 *   page 252  switch type   installed switch id                       1 B/key
 */

/**
 * MULTI_MAGNETISM (cmd 0x65) pages — **verified from the 2515-frame capture**
 * (docs/reverse-engineering/FINDINGS-R85HE.md). Values are `mm × 200` (this
 * firmware), 16-bit little-endian.
 *
 * Single-key write: `00 65 <page> 00 <slot> <flag> 00 00 ck <valLo> <valHi>`.
 * Bulk write:       `00 65 <page> 01 <chunkIdx> 00 00 00 ck <56 payload bytes>`.
 */
const MM_PAGE = {
  TRAVEL: 0, // press actuation
  RELEASE: 1, // release point
  RT_PRESS: 2, // rapid-trigger press sensitivity  (vendor `RT按下行程`)
  RT_RELEASE: 3, // rapid-trigger release sensitivity (vendor `RT松开行程`)
  DKS_POINTS: 4,
  MT: 5,
  DEADZONE_BOTTOM: 6, // capture: page 6 = bottom dead zone (was mislabelled)
  MODES: 7, // 1 value/key: mode 0/2/3/4/5/7
  /**
   * DKS per-zone trigger flags, 4 bytes/key — WRITTEN to page 8.
   *
   * `verified-capture`: the vendor app configuring a DKS key on this R85HE
   * (session-r85he.jsonl, step `09_mode_dks`) sends the four `SET_KEYMATRIX`
   * bindings, then page 7 (mode 2), page 4 (the point), and last
   * `00 65 08 00 09 01 00 00 88 01 04 10 40` — page 8, with commit. This
   * driver wrote page 10, and a write there was measured to change nothing.
   */
  DKS_FLAGS: 8,
  /**
   * Where the flags are READ from — `inferred`. Page 8 answers no read on an
   * R85HE (fw v5.11): its only non-zero bytes are our own query checksum
   * echoed back. Page 10, which Driver v4's own table lists with 8 chunks,
   * returns 128 slots x 4 bytes with 0xFFFF sentinels at slots 31/63/95/127 —
   * real structure, decoded as the flags, but no capture shows the vendor
   * reading it, so a mismatch after a write here is not yet evidence of
   * anything.
   */
  DKS_FLAGS_READ: 10,
  SNAP: 9, // SOCD pairing — each key's value = its partner's slot
  DEADZONE_TOP: 251, // capture: page 251 (0xfb) = top dead zone
  SWITCH_TYPE: 252, // 0xfc
} as const;

/** how many 64-byte read chunks the vendor requests per page (default 4) */
const pageChunks = (page: number): number => KB_MAGNETISM_PAGE_CHUNKS[page] ?? 4;

/**
 * Bytes per key on a page. 128 slots x `width` bytes = `chunks` x 64 data
 * bytes, so `chunks / 2` is the width — 1 for modes/SOCD/mod-tap/switch type,
 * 2 for the travel pages, 4 for the DKS zone actions.
 */
const magWidth = (page: number): number =>
  // Page 8 is not in Driver v4's chunk table at all (it lists the read-side
  // page 10), but the vendor writes four bytes to it — see MM_PAGE.DKS_FLAGS.
  page === MM_PAGE.DKS_FLAGS ? 4 : Math.max(1, Math.round(pageChunks(page) / 2));

/**
 * Where a paged `GET_MULTI_MAGNETISM` reply's data starts: immediately after
 * the HID report id. These replies carry no command echo and no checksum — see
 * `readMagnetismPage`. `provenance: verified-capture` (R85HE, fw v5.11).
 */
const MM_REPLY_OFFSET = 1;

/**
 * How long to wait before each attempt at reading magnetism page 252 back after
 * writing it, and how many attempts.
 *
 * The page commits in about 100-140 ms on an R85HE (fw 5.11) — see
 * `setSwitchTypes`. Three tries at 120 ms covers that with room to spare while
 * still failing fast on a board that genuinely ignores the write.
 */
const SWITCH_READBACK_WAIT_MS = 120;
const SWITCH_READBACK_TRIES = 3;

/**
 * Mode-byte (page 7) bit layout, from qmk.top's `___utils_磁轴NumToOption` /
 * `___utils_磁轴OptionToNum`:
 *
 *   bit 7  rapid trigger armed        (independent of the mode below)
 *   bit 6  full bottom-out
 *   0..3   mode  (0 normal, 2 dks, 3 mt, 4 tgl_hold, 5 tgl_dots, 7 snap)
 *
 * qmk.top also names 8-10 (`snap-neutral`, `snap-priority`,
 * `snap-overridden`), snap-tap variants that say which key of a pair wins.
 * The R85HE stores them and ignores them — tried on hardware 2026-10-09
 * (`verify-he-writes`, "neither" and "A wins": the pair behaved as plain keys
 * while page 7 read back 8/8 and 9/10). Its own vendor app offers only 7. So
 * they are read as snap-tap, and never written.
 *
 * The mode occupies the low **nibble**, not the low seven bits: masking with
 * 0x7f leaves bit 6 in place and makes a full-bottom-out key decode as an
 * unknown mode.
 */
const RT_BIT = 0x80;
const FULL_BOTTOM_BIT = 0x40;
const MODE_MASK = 0x0f;

/**
 * Page 9's "no SOCD partner" value. Verified on hardware: every unpaired key
 * reads 0xFF, not 0 — writing 0 to clear a pairing would instead point the key
 * at slot 0 (Esc on the R85HE).
 */
const SOCD_NO_PARTNER = 0xff;

/** vendor key-mode enum (chunk 5e635fe2.js `_decodeMagnetismKeyModes`). */
const MODE_TO_NUM: Record<MagneticMode, number> = {
  normal: 0,
  dks: 2,
  mt: 3,
  tgl_hold: 4,
  tgl_dots: 5,
  snap: 7,
};
const NUM_TO_MODE: Record<number, MagneticMode> = {
  0: 'normal',
  2: 'dks',
  3: 'mt',
  4: 'tgl_hold',
  5: 'tgl_dots',
  7: 'snap',
  8: 'snap',
  9: 'snap',
  10: 'snap',
};

/**
 * Every mode value that means snap-tap: 7 (`verified-capture`, the vendor
 * pairing writes it) and the 8-10 the board stores but does not act on (see
 * the mode-byte notes above). All four READ as snap-tap — they used to decode
 * as "normal", so a pair read back as two plain keys and the next write
 * unpaired it — and a snap-tap key is always WRITTEN as 7.
 */
const isSnapNum = (n: number): boolean => n >= 7 && n <= 10;

/** Where the zone bindings this board has been given are kept — see
 *  `readKeyZoneBindings`. */
const ZONE_BINDINGS_STATE_KEY = 'zoneBindings';
/** The same record, as a backup block. */
const ZONE_BINDINGS_BLOCK = 'zone_bindings';

/** Mod-tap hold time on the wire: one byte of 10 ms units. */
const MT_UNIT_MS = 10;
const MT_UNITS_MAX = 255;
/** Sanity gate for the live travel read — a decode this implausible is almost
 *  certainly a wrong offset/stride, not real data; the whole sample is
 *  discarded rather than painting garbage on the board. */
const TRAVEL_MAX_MM = 4.2;
const TRAVEL_MAX_ACTIVE_KEYS = 24;
/** Below this a key counts as at rest — sensor noise around the zero point
 *  would otherwise light up the whole board. `provenance: inferred`. */
const TRAVEL_REST_MM = 0.05;

/**
 * The live per-key travel channel is **magnetism page 254**, read with the
 * ordinary paged `GET_MULTI_MAGNETISM` frame — not a pushed input report.
 *
 * `provenance: verified-capture` for the frame: the *only*
 * `GET_MULTI_MAGNETISM` frame anywhere in the Driver-v4 capture is page 0xfe
 * (`00 e5 fe 01 <chunkIdx> 00 00 00 ck` — FINDINGS-R85HE.md's GET argument
 * table), which the vendor floods to watch travel during calibration.
 * qmk.top's `PARAMETER_磁轴` names page 254 `liveTravel` with the same
 * standard get frame (scripts/_raw/qmk-magnetism.json), and
 * docs/protocol/keyboard-compx.md lists it at 2 bytes/key.
 *
 * 2 bytes/key over 128 slots = 256 bytes = 4 chunks of 64.
 */
const TRAVEL_PAGE = 254;
const TRAVEL_PAGE_CHUNKS = 4;
/** How many leading slots to echo into the developer frame log's `raw` hex. */
const TRAVEL_RAW_SLOTS = 16;

/** A result with earlier frames (a zone write's) in front of its own. */
function withFrames(before: string[] | undefined, r: WriteResult): WriteResult {
  return before?.length ? { ...r, frames: [...before, ...(r.frames ?? [])] } : r;
}

/**
 * Why a batch's snap-tap pairs cannot be written, or null when they can.
 *
 * Both halves of a pair in one batch must name each other. Anything else
 * stored half of a pair, which the firmware ignores. A key whose partner is
 * not in the batch is not checked here — the planners always send both, and a
 * key edited on its own (its actuation, say) keeps the pairing it had.
 */
export function snapPairMismatch(keys: MagneticKeySettings[]): string | null {
  const id = (k: { row: number; col: number }) => `${k.row},${k.col}`;
  const byId = new Map(keys.map((k) => [id(k), k]));
  for (const k of keys) {
    if (k.mode !== 'snap' || !k.socdPartner) continue;
    const p = byId.get(id(k.socdPartner));
    if (!p) continue;
    if (p.mode !== 'snap' || !p.socdPartner || id(p.socdPartner) !== id(k)) {
      return `snap-tap: ${id(k)} pairs with ${id(p)}, which does not pair back`;
    }
  }
  return null;
}

/** One key magnetism is read and written for. */
interface MagKey {
  slot: number;
  row: number;
  col: number;
}

/**
 * The family's key matrix: 21 columns of 6 rows, slot = col * 6 + row — the
 * per-key LED map's size (126 slots x 3 bytes, see compx-keyboard.ts). The
 * magnetism pages have 128 slots; the last two are not keys (slot 126 holds a
 * constant word at rest on an R85HE, see readTravel).
 */
const MATRIX_ROWS = 6;
const MATRIX_SLOTS = 126;

export class CompxHeKeyboard extends CompxKeyboard {
  private _travelMult: number | null = null;
  /** The board's real key slots, built once from its layout — see readTravel. */
  private _keySlots: ReadonlySet<number> | null = null;
  /** The keys magnetism addresses, once resolved — see magneticKeys. */
  private _magKeys: MagKey[] | null = null;
  /** Off-layout travel slots already written to the frame log this session. */
  private readonly _travelNoted = new Set<number>();

  /**
   * Travel step multiplier — vendor `get磁轴行程步进倍数()`: keyed on the raw
   * uint16 firmware version (`<768 -> 10`, `768..1279 -> 100`, `>=1280 -> 200`).
   */
  /** `protected` so a test can pin the multiplier without a firmware read. */
  protected async travelMultiplier(): Promise<number> {
    if (this._travelMult !== null) return this._travelMult;
    const fw = await this.getFirmware().catch(() => null);
    // The KEYBOARD's own version decides the step, so a receiver version is a
    // last resort rather than an equal alternative: the rule's bands are
    // narrow (`[768,1280)` is 100, `>=1280` is 200), and a receiver answering
    // `0x04xx` while the device read merely missed would silently halve every
    // travel value for the rest of the session — the cached `_travelMult`
    // below means one unlucky read poisons all of it. A firmware version that
    // is not the board's is worth saying out loud.
    const raw = fw?.deviceRaw || 0;
    const fallback = raw ? 0 : fw?.receiverRaw || 0;
    if (fallback) {
      frameLog.push({
        deviceId: this.d.model,
        dir: 'rx',
        hex: '',
        note: `travelMultiplier: no device firmware version; using the receiver's (${fallback}). Travel values may be scaled wrong.`,
      });
    }
    const mult = (raw || fallback) < 768 ? 10 : (raw || fallback) < 1280 ? 100 : 200;
    // Only cache once we've actually read a version. A failed / not-yet-woken
    // firmware read returns 0, which would otherwise pin the multiplier at 10
    // for the whole session on a board whose real multiplier is 200 — every
    // mm<->units conversion then off by 20x (a 2.0 mm actuation written as
    // ~0.1 mm). Return the provisional value but retry next call.
    if (raw > 0) this._travelMult = mult;
    return mult;
  }

  /**
   * Wire units per millimetre on the rapid-trigger pages (2 and 3).
   *
   * `provenance: inferred`. Every other travel page is `mm * multiplier` and
   * this assumes the same — but it is the one scale in this driver with no
   * evidence behind it at all: pages 2 and 3 are zero in the only hardware
   * snapshot we have, the vendor app the protocol was reverse-engineered from
   * exposed no per-key RT sensitivity to capture, and the vendor's own code
   * does use different encodings per page elsewhere (DKS points are
   * `(mm - 0.2) * multiplier`, the bottom dead zone is inverted).
   *
   * It is a named function rather than an inline `mult` so that settling it
   * is a one-line change: a reading that comes back exactly 2x what the vendor
   * tool shows means this should be `mult * 2`. See docs/protocol/keyboard-compx.md.
   */
  private rtUnitsPerMm(mult: number): number {
    return mult;
  }

  /**
   * The conversions themselves are pure — only fetching the multiplier is
   * async. Anything converting more than one value MUST resolve the
   * multiplier once and call these, not the `await`-per-value wrappers below:
   * `travelMultiplier()` deliberately does not cache a failed read (see its
   * comment), so a loop of awaits re-issues `getFirmware()` once per value
   * whenever the board is asleep or its endpoint is busy. `readMagnetic()`
   * used to do exactly that — 7 awaits x 79 keys = 553 firmware reads, each up
   * to 24 feature transactions, on a firmware the capture notes say wedges
   * under bursts.
   */
  /**
   * `minMm` is per-page, not a single global floor. It used to be a hard
   * `Math.max(0.1, ...)`, which made two settings unreachable: a rapid-trigger
   * sensitivity of 0.005 mm (one wire unit at this board's x200 multiplier)
   * was written as 0.1 mm — twenty times what was asked for — and a deliberate
   * 0 mm dead zone became 0.1 mm. The pages have genuinely different floors,
   * so the caller names one; see `push()` in setMagneticKey.
   */
  private mmToUnitsWith(mm: number, mult: number, minMm = KB_TRAVEL_RANGE.travel.min): number {
    return Math.round(Math.max(minMm, Math.min(4, mm)) * mult);
  }

  /**
   * Rounded to the MULTIPLIER's own resolution, not to two decimal places.
   * At x200 one unit is 0.005 mm, and 2 dp collapsed every odd unit onto the
   * wrong 0.01 step — a 0.005 mm rapid trigger read back as 0.01, so the panel
   * disagreed with the board it had just written.
   */
  private unitsToMmWith(units: number, mult: number): number {
    if (!units) return 0;
    const f = mult >= 200 ? 1000 : 100;
    return Math.round((units / mult) * f) / f;
  }

  /** Single-value convenience wrapper. See the note above before looping. */
  private async mmToUnits(mm: number): Promise<number> {
    return this.mmToUnitsWith(mm, await this.travelMultiplier());
  }

  /**
   * Read one whole paged channel as a flat array of one value per firmware slot.
   *
   * **The reply carries neither a command byte nor a checksum.** It is 64 raw
   * data bytes starting at `frame[1]`. Verified on a real R85HE (fw v5.11,
   * model id 3123): eight consecutive reads after a single
   * `GET_MULTI_MAGNETISM(page 0)` all returned `00 90 01 90 01 …` and never
   * `0xe5` in byte 1, and byte 8 is data (`0x01`), not a checksum.
   *
   * That is why this cannot go through `ch.request()`: it filters on
   * `reply[1] === expectCommand` and verifies a reply checksum, so it rejects
   * every frame here and returns null. The previous implementation did exactly
   * that and additionally read from offset 8, so `readMagnetic()` silently fell
   * back to its hardcoded defaults and the Actuation tab never showed real
   * device state. Raw `write`/`read` inside one transaction is correct.
   *
   * Geometry, confirmed against the vendor's own chunk table
   * (`KB_MAGNETISM_PAGE_CHUNKS`) and the wire: **128 slots per page**, 64 data
   * bytes per chunk, so `chunks / 2` is the width in bytes per key —
   * 2 chunks = 1 byte/key (modes, SOCD, dead zone top, MT, switch type),
   * 4 chunks = 2 bytes/key little-endian (travel, release, RT press/release,
   * DKS points, dead zone bottom), 8 chunks = 4 bytes/key (DKS detail).
   */
  protected readMagnetismPage(page: number, chunks = pageChunks(page)): Promise<number[] | null> {
    const width = Math.max(1, Math.round(chunks / 2));
    return this.ch.transaction(async (io) => {
      const bytes: number[] = [];
      for (let c = 0; c < chunks; c++) {
        const query = this.frame(KB_CMD.GET_MULTI_MAGNETISM, [page, 1, c]);
        await io.write(query);
        // The firmware needs a moment; reading too eagerly returns the previous
        // chunk's buffer still sitting in the endpoint.
        await delay(this.settleMs);
        const back = await io.read(250, this.d.reportLength);
        // A page this firmware does not implement is not answered at all, and
        // Windows then hands back our own SetFeature buffer. Verified: page 200
        // returns `00 e5 c8 01 00 00 00 00 51` — the query verbatim. Without
        // this check that frame would be decoded as if it were key data.
        //
        // A SHORT reply is rejected the same way, and a page that fails
        // part-way through now fails entirely rather than returning the chunks
        // it did get: every slot is decoded at a fixed offset into this one
        // array, so a missing chunk does not drop the tail — it shifts every
        // slot after it onto another key's bytes, silently. The caller's
        // `?? []` then reads the remainder as zeros, which is how a key could
        // show one page's real value against another page's invented default.
        if (!back || back.length < this.d.reportLength || isEchoOf(back, query)) return null;
        bytes.push(...Array.from(back.subarray(MM_REPLY_OFFSET)));
      }
      const out: number[] = [];
      for (let i = 0; i + width <= bytes.length; i += width) {
        let v = 0;
        for (let b = 0; b < width; b++) v |= (bytes[i + b] ?? 0) << (8 * b);
        out.push(v >>> 0);
      }
      return out;
    });
  }

  /**
   * The keys magnetism is read and written for.
   *
   * A board whose layout names every key's slot (shared/menuGates.ts
   * `layoutAddressable`) uses its layout. Any other board — most of the line,
   * until its slot map is known — uses the slots its own base keymap binds: a
   * slot with a key on it is a key, wherever on the board it sits. Their
   * row/col are the slot's own matrix position (slot = col * 6 + row), which
   * is all a whole-board write needs; nothing per-key is offered for such a
   * board (handlers.ts refuses it). Never the layout array index: that is how
   * a write lands on the wrong key.
   *
   * A bound slot is not always a switch: a knob's turn and press are bound
   * too (Volume up / down / mute on an R85HE's slots 90-92). What tells them
   * apart is the magnetism: a real switch carries its factory dead zones and
   * rapid-trigger points even if nobody ever touched it, and a knob's slot is
   * 0 on every page, like an empty one. Read on an R85HE (fw 5.11): all 79
   * keys non-zero, the knob's three slots and every empty slot zero on all of
   * travel, release, RT press and bottom dead zone. A slot the travel page
   * marks with the "no switch" sentinel (0xFFFF) is dropped as well.
   *
   * `provenance: verified-capture` for that rule on the R85HE (the bound,
   * configured slots are exactly its verified layout's 79 — scripts/
   * verify-identity.ts); `inferred` for every board without a verified map.
   */
  protected async magneticKeys(): Promise<MagKey[] | null> {
    if (this._magKeys) return this._magKeys;
    const km = this.d.spec.keyMatrix;
    if (km?.layout && layoutAddressable({ keyMatrix: km })) {
      this._magKeys = km.layout.map((k) => ({ slot: k.slot!, row: k.row, col: k.col }));
      return this._magKeys;
    }
    const base = await this.readKeyBindings('base');
    // A sweep that stopped part way returns the chunks it got; a key list
    // built from it would leave the rest of the board out of every write.
    if (!base || Object.keys(base).length < MATRIX_SLOTS) return null;
    const travel = await this.readMagnetismPage(MM_PAGE.TRAVEL);
    if (!travel) return null;
    const pages = [travel];
    for (const page of [MM_PAGE.RELEASE, MM_PAGE.RT_PRESS, MM_PAGE.DEADZONE_BOTTOM]) {
      const values = await this.readMagnetismPage(page);
      if (values) pages.push(values);
    }
    const configured = (slot: number) =>
      pages.some((page) => {
        const v = page[slot] ?? 0;
        return v !== 0 && v !== 0xffff;
      });
    const keys: MagKey[] = [];
    for (const b of Object.values(base)) {
      if (b.slot >= MATRIX_SLOTS || b.kind === 'unused') continue;
      if ((travel[b.slot] ?? 0) === 0xffff || !configured(b.slot)) continue;
      keys.push({ slot: b.slot, row: b.slot % MATRIX_ROWS, col: Math.floor(b.slot / MATRIX_ROWS) });
    }
    // Bound slots, none of them configured: nothing tells keys from knobs, so
    // no key list — a whole-board write is refused rather than guessed.
    if (!keys.length) return null;
    keys.sort((a, b) => a.slot - b.slot);
    this._magKeys = keys;
    return keys;
  }

  override async readMagnetic(): Promise<MagneticKeySettings[]> {
    const keyList = await this.magneticKeys();
    if (!keyList?.length) return [];
    // MODES and TRAVEL are not optional extras: between them they ARE the key
    // — its mode, its rapid-trigger bit, its actuation point. Every other page
    // below is read only when some key's mode calls for it, so `?? []` there
    // means "nothing to read", which is true.
    //
    // Here it was a lie. `readMagnetismPage` returns null when the endpoint
    // did not answer (an echo, a short reply), and `?? []` turned that into an
    // empty page — so every slot decoded to `travel[i] ?? 0` -> the 2.5 mm
    // table default and `modes[i] ?? 0` -> plain normal mode, and the caller
    // got a complete, plausible board that was entirely fabricated. The
    // Actuation tab believed it: after a bulk write, when this endpoint is
    // still busy, the board went uniformly default and the user's key groups
    // vanished until they hit Read device. An empty list is the existing "I
    // could not read this" signal (see the layout check above) and callers
    // already have to handle it.
    const modes = await this.readMagnetismPage(MM_PAGE.MODES);
    const travel = await this.readMagnetismPage(MM_PAGE.TRAVEL);
    if (!modes || !travel) return [];
    const release = (await this.readMagnetismPage(MM_PAGE.RELEASE)) ?? [];
    const anyDks = modes.some((m) => (m & MODE_MASK) === MODE_TO_NUM.dks);
    const dksPoints = anyDks ? ((await this.readMagnetismPage(MM_PAGE.DKS_POINTS)) ?? []) : [];
    // Page 8 is 4 bytes per key; readMagnetismPage packs each key's four bytes
    // into one uint32, so unpack them back out per zone.
    const dksDetail = anyDks ? ((await this.readMagnetismPage(MM_PAGE.DKS_FLAGS_READ)) ?? []) : [];
    // Pages 2/3 only carry meaning once a key is armed — the vendor skips them
    // otherwise, and so do we, to save eight round trips on the common path.
    const anyRt = modes.some((m) => (m & RT_BIT) !== 0);
    const rtPress = anyRt ? ((await this.readMagnetismPage(MM_PAGE.RT_PRESS)) ?? []) : [];
    const rtRelease = anyRt ? ((await this.readMagnetismPage(MM_PAGE.RT_RELEASE)) ?? []) : [];
    // Snap/SOCD pairing (page 9) and mod-tap hold time (page 5) are 1 byte per
    // key and only meaningful for keys in those modes.
    const anySnap = modes.some((m) => isSnapNum(m & MODE_MASK));
    const anyMt = modes.some((m) => (m & MODE_MASK) === MODE_TO_NUM.mt);
    const socd = anySnap ? ((await this.readMagnetismPage(MM_PAGE.SNAP)) ?? []) : [];
    const mtHold = anyMt ? ((await this.readMagnetismPage(MM_PAGE.MT)) ?? []) : [];
    // slot -> key, for turning a partner slot back into a row/col
    const bySlot = new Map<number, { row: number; col: number }>();
    for (const e of keyList) bySlot.set(e.slot, { row: e.row, col: e.col });
    const dzTop = (await this.readMagnetismPage(MM_PAGE.DEADZONE_TOP)) ?? [];
    const dzBottom = (await this.readMagnetismPage(MM_PAGE.DEADZONE_BOTTOM)) ?? [];
    // Resolved ONCE for the whole sweep — see mmToUnitsWith's comment.
    const mult = await this.travelMultiplier();

    /**
     * Decode a page value where **zero is a real setting**, not "unset".
     *
     * The dead zones are the case: their range starts at 0, and 0 means "none"
     * — the write path has said so for as long as it has had a floor of
     * `KB_TRAVEL_RANGE.deadzone.min`. The read did not: it ended in
     * `|| undefined`, so a dead zone the user had deliberately set to 0 came
     * back as "no value", the panel substituted the 0.3 mm table default, and
     * leaving the tab and returning appeared to undo the change the board had
     * in fact accepted.
     *
     * "No value" now means only what it should: the page was not read, or is
     * shorter than this slot. Those stay `undefined` so the default still
     * stands in for a failed read rather than reading as a deliberate zero.
     */
    const settable = (page: number[], i: number): number | undefined =>
      page[i] === undefined ? undefined : this.unitsToMmWith(page[i]!, mult);

    const out: MagneticKeySettings[] = [];
    for (const k of keyList) {
      // page arrays are indexed by the firmware matrix slot, not the layout
      // array position — see ANSI_79_SG9047 in shared/layouts.ts.
      const i = k.slot;
      const modeByte = modes[i] ?? 0;
      const modeNum = modeByte & MODE_MASK;
      const snap = isSnapNum(modeNum);
      out.push({
        row: k.row,
        col: k.col,
        actuationMm: this.unitsToMmWith(travel[i] ?? 0, mult) || KB_TRAVEL_RANGE.travel.default,
        // A zero release page means "not set", and an unset release point IS
        // the actuation point — that is what "linked" means, and it is the
        // board's own resting state. It used to fall to `undefined` while
        // actuation fell to the table default, so a slot that read 0 on both
        // pages came out as 2.5 mm actuate against an undefined release, which
        // the Actuation tab could only render as two different things.
        releaseMm:
          this.unitsToMmWith(release[i] ?? 0, mult) ||
          this.unitsToMmWith(travel[i] ?? 0, mult) ||
          KB_TRAVEL_RANGE.travel.default,
        // Rapid trigger is bit 7 of the mode byte and is INDEPENDENT of the
        // mode in the low nibble — a key can be snap/SOCD with or without RT.
        // This previously read `(modeByte & 0x7f) === snap`, conflating the
        // two; qmk.top's own `___utils_磁轴NumToOption` unpacks it as
        // `isOpenRT = byte & 0x80`, `isFullBottom = byte & 0x40`,
        // `option = byte & 0x0f`.
        rapidTrigger: (modeByte & RT_BIT) !== 0,
        fullBottomOut: (modeByte & FULL_BOTTOM_BIT) !== 0,
        rtPressMm: this.unitsToMmWith(rtPress[i] ?? 0, this.rtUnitsPerMm(mult)) || undefined,
        rtReleaseMm: this.unitsToMmWith(rtRelease[i] ?? 0, this.rtUnitsPerMm(mult)) || undefined,
        deadZoneMm: settable(dzTop, i),
        deadZoneBottomMm: settable(dzBottom, i),
        // Page 4 is read when ANY key is in DKS; only a DKS key's entry means
        // anything, and handing every other key a stray point made two
        // otherwise identical keys read as different.
        dksPointMm:
          modeNum === MODE_TO_NUM.dks
            ? this.unitsToMmWith(dksPoints[i] ?? 0, mult) || undefined
            : undefined,
        dksZones:
          (modeByte & MODE_MASK) === MODE_TO_NUM.dks
            ? dksZonesFrom([
                (dksDetail[i] ?? 0) & 0xff,
                ((dksDetail[i] ?? 0) >>> 8) & 0xff,
                ((dksDetail[i] ?? 0) >>> 16) & 0xff,
                ((dksDetail[i] ?? 0) >>> 24) & 0xff,
              ])
            : undefined,
        socdPartner: snap ? (bySlot.get(socd[i] ?? -1) ?? null) : null,
        mtHoldMs: modeNum === MODE_TO_NUM.mt ? (mtHold[i] ?? 0) * MT_UNIT_MS : undefined,
        mode: NUM_TO_MODE[modeNum] ?? 'normal',
      });
    }
    return out;
  }

  /**
   * One key, one page:
   *   `00 65 <page> 00 <slot> <commit> 00 00 ck <value bytes…>`
   *
   * Two things here were wrong and are now taken from the vendor's own
   * `___cmdSetMagnetAxisSimple(param, pos, values, isLast)`:
   *
   * 1. Byte 5 is a **commit** flag, not a per-page constant. The vendor sets it
   *    on the LAST write of a batch and 0 on every earlier one — see
   *    `setDKSKeySimple`, which sends `false, false, true`. This previously
   *    keyed off the page (RELEASE / both dead zones), so a batch could commit
   *    three times in the middle and never at the end.
   * 2. The value is **as many bytes as the page is wide**, not always two.
   *    `chunks / 2` gives the width: writing 2 bytes to a 1-byte page (modes,
   *    mod-tap, SOCD, switch type) put a stray 0 into the NEXT slot.
   */
  /**
   * `verified: 'unverified'` is deliberate, not a gap: the only read-back
   * available is a whole-page sweep (`readMagnetismPage` = `pageChunks(page)`
   * GET requests), and this is called once per key per changed page — a
   * per-key page read would multiply every bulk actuation edit by dozens of
   * extra round trips and, per FINDINGS-R85HE.md's "endpoint lockup" note,
   * risks wedging the feature-report endpoint. The vendor Hub does not read
   * back per key either. The SET frame layout itself is capture-verified.
   */
  // `protected`, like readMagnetismPage above: this is the single choke point
  // every magnetism write funnels through, which makes it the seam a test can
  // record at to assert WHICH pages a setting produces, in what order, and
  // where the commit flag lands -- none of which needs a real wire frame.
  protected async writeMagKey(
    page: number,
    slot: number,
    value: number | number[],
    commit: boolean,
  ): Promise<WriteResult> {
    const width = magWidth(page);
    const bytes = Array.isArray(value)
      ? value.slice(0, width)
      : Array.from({ length: width }, (_, i) => (value >> (8 * i)) & 0xff);
    const args = [
      page & 0xff,
      0x00,
      slot & 0xff,
      commit ? 1 : 0,
      0,
      0,
      ...bytes.map((b) => b & 0xff),
    ];
    const tx = this.frame(KB_CMD.SET_MULTI_MAGNETISM, args);
    try {
      await this.ch.write(tx);
      return { ok: true, verified: 'unverified', frames: [toHex(tx)] };
    } catch (e) {
      return { ok: false, verified: 'unverified', error: String(e), frames: [toHex(tx)] };
    }
  }

  /**
   * Write the per-zone bindings of one key — the multi-frame `SET_KEYMATRIX`.
   *
   * A mod-tap or DKS key needs one `SET_KEYMATRIX` frame per zone, all
   * addressing the same slot and differing only in the zone index (frame byte
   * 7), with the commit flag on the last. From the vendor's `setDKSKeySimple`,
   * which loops `___setKeyConfigSimple(binding, profile, zoneIndex, isLast)`
   * over its bindings. Each frame is exactly the single-zone remap
   * `setKeyRemap` sends — hardware-verified, and pinned byte for byte in
   * compx-keyboard.test.ts — with the zone byte set: the same helpers build it.
   *
   * What goes where (shared/key-zones.ts): a DKS key's actions 2-4 in zones
   * 1-3, zone 0 left as the key's own binding (action 1); a mod-tap key's HOLD
   * in zone 0 and its own binding, the TAP, in zone 1 — the firmware fires
   * zone 0 on a hold, which a hardware check settled.
   *
   * Two rules keep a key's own binding recoverable, since zone 0 is the one
   * the Remap tab reads:
   *  - a write that sets zone 0 is a mod-tap hold, and must carry the tap in
   *    zone 1 — otherwise leaving mod-tap would have nothing to put back;
   *  - a write that leaves zone 0 alone, on a key whose zone 0 holds a mod-tap
   *    hold (mod-tap to DKS), puts the key's own binding back there first.
   *
   * `provenance: ported-from-vendor` for the frames. What was written is kept
   * (see `readKeyZoneBindings`): the zones past 0 have no read-back this app
   * understands.
   */
  override async setKeyZoneBindings(
    slot: number,
    zones: Array<string | null>,
  ): Promise<WriteResult> {
    if (zones.length < 1 || zones.length > 4) {
      return { ok: false, verified: 'unverified', error: 'a key has one to four zone bindings' };
    }
    if (zones[MT_HOLD_ZONE] != null && !zones[MT_TAP_ZONE]) {
      return {
        ok: false,
        verified: 'unverified',
        error: "a binding in zone 0 is a mod-tap hold, and needs the key's own binding in zone 1",
      };
    }
    const record = await this.zoneRecord();
    const sends: Array<{ zone: number; quad: KeyQuad }> = [];
    const cur = record[slot];
    if (zones[0] === null && isModTapEntry(cur)) {
      const own = quadFor(cur![MT_TAP_ZONE]!);
      if (own) sends.push({ zone: 0, quad: own });
    }
    for (const [zone, z] of zones.entries()) {
      // null: leave this zone as the board has it. '' is "nothing bound in
      // this zone" — an empty quad, on purpose.
      if (z === null) continue;
      const q = z === '' ? ([0, 0, 0, 0] as KeyQuad) : quadFor(z);
      if (!q) return { ok: false, verified: 'unverified', error: `not a binding: "${z}"` };
      sends.push({ zone, quad: q });
    }
    if (!sends.length) return { ok: false, verified: 'unverified', error: 'no zone to write' };
    const r = await this.sendZoneFrames(slot, sends);
    if (!r.ok) return r;
    await this.saveZoneRecord({ ...record, [slot]: [...zones] });
    return r;
  }

  /** One slot's zone frames, commit on the last, paced like every write here. */
  private async sendZoneFrames(
    slot: number,
    sends: Array<{ zone: number; quad: KeyQuad }>,
  ): Promise<WriteResult> {
    const frames: string[] = [];
    for (const [i, { zone, quad }] of sends.entries()) {
      const tx = this.frame(
        KB_CMD.SET_KEYMATRIX,
        keymatrixArgs(slot, quad, { commit: i === sends.length - 1, zone }),
      );
      try {
        await this.ch.write(tx);
        frames.push(toHex(tx));
      } catch (e) {
        return { ok: false, verified: 'unverified', error: String(e), frames };
      }
      if (this.settleMs) await delay(this.settleMs);
    }
    return { ok: true, verified: 'unverified', frames };
  }

  /**
   * The zone bindings SharkDeck has written to this board, by slot. A record,
   * not a read: `GET_KEYMATRIX` answers for zone 0 only, as far as anything
   * has shown. Empty when nothing has been written from this computer.
   */
  override async readKeyZoneBindings(): Promise<KeyZoneBindings | null> {
    return this.zoneRecord();
  }

  /**
   * The record, or an empty one — never a throw. The diagnostic scripts build
   * this driver with a bare `state: {}`, and a key binding read must not fail
   * because there is nowhere to keep a record.
   */
  private async zoneRecord(): Promise<KeyZoneBindings> {
    try {
      if (typeof this.state?.get !== 'function') return {};
      const kept = await this.state.get(ZONE_BINDINGS_STATE_KEY);
      return kept && typeof kept === 'object' ? { ...(kept as KeyZoneBindings) } : {};
    } catch {
      return {};
    }
  }

  private async saveZoneRecord(record: KeyZoneBindings): Promise<void> {
    try {
      if (typeof this.state?.set === 'function') {
        await this.state.set(ZONE_BINDINGS_STATE_KEY, record);
      }
    } catch {
      /* a record that cannot be kept is one this computer does not have */
    }
  }

  /**
   * A remap of a mod-tap key changes what it TAPS.
   *
   * The Remap tab edits "what the key types", which on a mod-tap key is its
   * tap — and that lives in zone 1 while the key is mod-tap. Written to zone
   * 0, as for any other key, it would replace the HOLD instead. The redirect
   * writes the same verified frame with the zone byte set, and keeps the
   * record in step.
   */
  override async setKeyRemap(
    layer: 'base' | 'fn',
    index: number,
    action: string,
  ): Promise<WriteResult> {
    if (layer === 'base') {
      const slot = index & 0xff;
      const record = await this.zoneRecord();
      const entry = record[slot];
      const quad = quadFor(action);
      if (quad && isModTapEntry(entry)) {
        const r = await this.writeVerified(
          KB_CMD.SET_KEYMATRIX,
          keymatrixArgs(slot, quad, { commit: true, zone: MT_TAP_ZONE }),
        );
        if (r.ok) {
          const next = [...entry!];
          next[MT_TAP_ZONE] = action;
          await this.saveZoneRecord({ ...record, [slot]: next });
        }
        return r;
      }
    }
    return super.setKeyRemap(layer, index, action);
  }

  /**
   * The base layer as the Remap tab should see it: a mod-tap key shows what
   * it types, its tap, rather than the hold sitting in zone 0. Only where the
   * board's zone 0 still holds the hold the record says — a record the board
   * has moved on from (a vendor-app edit, a factory reset) is not believed.
   */
  override async readKeyBindings(layer: 'base' | 'fn'): Promise<Record<number, KeyBinding> | null> {
    const out = await super.readKeyBindings(layer);
    if (!out || layer !== 'base') return out;
    const record = await this.zoneRecord();
    for (const [slotStr, entry] of Object.entries(record)) {
      if (!isModTapEntry(entry)) continue;
      const slot = Number(slotStr);
      const live = out[slot];
      const hold = quadFor(entry[MT_HOLD_ZONE]!);
      const tap = quadFor(entry[MT_TAP_ZONE]!);
      if (!live || !hold || !tap || hold.some((b, i) => b !== live.raw[i])) continue;
      out[slot] = decodeQuad(slot, tap);
    }
    return out;
  }

  /** A factory reset puts every binding back, so the record is history. */
  override async restoreDefaults(): Promise<WriteResult> {
    const r = await super.restoreDefaults();
    if (r.ok) await this.saveZoneRecord({});
    // A factory reset rewrites the keymap the key list came from.
    this._magKeys = null;
    return r;
  }

  override async setMagneticGlobal(mm: number): Promise<WriteResult> {
    const units = await this.mmToUnits(mm);
    // Every key the board has, layout or not — this used to take its slots
    // from the layout alone, and so wrote nothing at all to a board without one.
    const keyList = await this.magneticKeys();
    if (!keyList) {
      return {
        ok: false,
        verified: 'unverified',
        error: 'Could not read which keys the board has',
      };
    }
    const slots = keyList.map((k) => k.slot);
    const frames: string[] = [];
    for (const [i, slot] of slots.entries()) {
      // Paced, like every other multi-write path here (setMagneticKey,
      // setMagneticKeys, setDksBindings, setFnSlot, setPerKeyLighting). This
      // one was the exception: 79 back-to-back HidD_SetFeature calls, which
      // is precisely the burst shape the endpoint-lockup note blames.
      if (i > 0 && this.settleMs) await delay(this.settleMs);
      const r = await this.writeMagKey(MM_PAGE.TRAVEL, slot, units, i === slots.length - 1);
      frames.push(...(r.frames ?? []));
      if (!r.ok) return { ...r, frames };
    }
    return { ok: true, verified: 'unverified', frames };
  }

  /**
   * Which magnetic switch each key has fitted — magnetism page 252, one byte
   * per key, indexed by firmware matrix slot.
   *
   * `provenance: inferred`. The page number and its width are
   * `verified-capture` (the vendor's own `PARAMETER_磁轴` names 252
   * `轴体`/"switch type" with 2 chunks), and the id space is
   * `ported-from-vendor` (see `shared/keyboard-switches.ts`). What is NOT
   * confirmed is that an Attack Shark board acts on it at all: the only R85HE
   * snapshot this repo has reads page 252 as all zeros, which is also exactly
   * what "no switch has ever been assigned" looks like, so the read cannot
   * distinguish the two. Write one key and diff the read-back before trusting
   * it — see docs/protocol/keyboard-compx.md.
   */
  async readSwitchTypes(): Promise<Record<number, number> | null> {
    const page = await this.readMagnetismPage(MM_PAGE.SWITCH_TYPE);
    if (!page) return null;
    const out: Record<number, number> = {};
    for (const k of this.d.spec.keyMatrix?.layout ?? []) {
      if (k.slot == null) continue;
      out[k.slot] = page[k.slot] ?? 0;
    }
    return out;
  }

  /**
   * Assign a switch model to some keys.
   *
   * Paced and committed like every other per-key magnetism write: the commit
   * flag goes on the LAST frame of the batch and 0 on every earlier one (byte
   * 4 of a single-key write — the vendor's own `setDKSKeySimple` sends
   * `false, false, true`), so the board applies the batch once rather than
   * re-latching per key.
   */
  async setSwitchTypes(assignments: { slot: number; switchId: number }[]): Promise<WriteResult> {
    if (!assignments.length) return { ok: true, verified: 'unverified' };
    const frames: string[] = [];
    for (let i = 0; i < assignments.length; i++) {
      const a = assignments[i]!;
      const r = await this.writeMagKey(
        MM_PAGE.SWITCH_TYPE,
        a.slot,
        a.switchId & 0xff,
        i === assignments.length - 1,
      );
      frames.push(...(r.frames ?? []));
      if (!r.ok) return { ...r, frames };
    }
    /**
     * Read-back diff — but not immediately, and not only once.
     *
     * The board takes about a tenth of a second to commit this page. Measured
     * with scripts/diag-switch-write.ts on a real R85HE (fw 5.11): the write
     * returns, a read at +63 ms still shows the OLD value, and a read at
     * +140 ms shows the new one. Checking straight after the write therefore
     * reported `mismatch` on a write that had worked perfectly.
     *
     * That was not a cosmetic wrong warning. The Switches view took the
     * mismatch as proof the firmware ignored the page, said so, and disabled
     * itself — so keys that HAD been reassigned could not be put back. Poll
     * instead: a few short waits, stopping as soon as the page agrees.
     */
    let back: Record<number, number> | null = null;
    for (let attempt = 0; attempt < SWITCH_READBACK_TRIES; attempt++) {
      await delay(SWITCH_READBACK_WAIT_MS);
      back = await this.readSwitchTypes();
      if (!back) break;
      if (assignments.every((a) => (back![a.slot] ?? 0) === (a.switchId & 0xff)))
        return { ok: true, verified: 'match', frames };
    }
    if (!back) return { ok: true, verified: 'unverified', frames };
    const missed = assignments.find((a) => (back![a.slot] ?? 0) !== (a.switchId & 0xff))!;
    return {
      ok: true,
      verified: 'mismatch',
      frames,
      error: `slot ${missed.slot} read back as ${back[missed.slot] ?? 0}, not ${missed.switchId}`,
    };
  }

  /**
   * Recalibrate the Hall sensors. `zero` = re-zero the rest point
   * (`SET_MAGNETISM_CAL`=28), `max` = learn full travel
   * (`SET_MAGNETISM_MAXIMUM_CALIBRATION`=30). Sent with a single `0x01`
   * "start" arg; there is no read-back. `ported-from-vendor` — confirm the
   * exact payload in CAPTURE-KEYBOARD.md step 10.
   */
  override async setMagneticCalibration(scope: 'zero' | 'max'): Promise<WriteResult> {
    const cmd =
      scope === 'max' ? KB_CMD.SET_MAGNETISM_MAXIMUM_CALIBRATION : KB_CMD.SET_MAGNETISM_CAL;
    try {
      const tx = this.frame(cmd, [0x01]);
      await this.ch.write(tx);
      return { ok: true, verified: 'unverified', frames: [toHex(tx)] };
    } catch (e) {
      return { ok: false, verified: 'unverified', error: String(e) };
    }
  }

  /**
   * Per-key write — one targeted `SET_MULTI_MAGNETISM` frame per affected page,
   * addressed by the firmware matrix `slot` (verified frame layout, see
   * `writeMagKey`). The vendor writes only the pages that changed; there is no
   * read-modify-write of a whole 128-slot page any more.
   */
  override async setMagneticKey(
    k: MagneticKeySettings,
    opts?: MagneticWriteOpts,
  ): Promise<WriteResult> {
    const built = await this.magKeyWrites(k, await this.travelMultiplier());
    if ('error' in built) return { ok: false, verified: 'unverified', error: built.error };
    const zones = await this.releaseModTap([k], opts);
    if (!zones.ok) return zones;
    return withFrames(zones.frames, await this.sendMagWrites(built.writes));
  }

  /**
   * Every page write one key's settings produce — built, not sent.
   *
   * Separated from sending because the commit flag belongs on the genuinely
   * last frame of a WHOLE operation, and a bulk write is one operation. Sent
   * per key, a 79-key restore asked the firmware to commit 79 times, which is
   * both why it took over a minute and why it could stop partway: FINDINGS'
   * "endpoint lockup" note is about exactly this kind of burst, and a batch
   * that dies in the middle leaves half the board on the old settings — the
   * reported "restore finished and every key was different".
   */
  private async magKeyWrites(
    k: MagneticKeySettings,
    mult: number,
    prev?: MagneticKeySettings,
  ): Promise<
    { writes: Array<{ page: number; slot: number; value: number | number[] }> } | { error: string }
  > {
    const keyList = await this.magneticKeys();
    if (!keyList) return { error: 'Could not read which keys the board has' };
    const at = (row: number, col: number) => keyList.find((e) => e.row === row && e.col === col);
    const entry = at(k.row, k.col);
    if (!entry) return { error: `key ${k.row},${k.col} not in matrix` };
    const slot = entry.slot;

    const writes: Array<{ page: number; slot: number; value: number | number[] }> = [];
    /** `minMm` defaults to the actuation floor; the two families that can go
     *  lower say so — see mmToUnitsWith. */
    /**
     * Skip a page the key already holds.
     *
     * Every setting used to go on the wire on every write — eight frames per
     * key, each paced by `settleMs` and costing a feature transaction on top,
     * so resetting sixty keys was some six hundred frames and took over a
     * minute. The vendor writes only what changed; with `prev` we can too.
     *
     * Compared in WIRE UNITS, not millimetres: 1.5 and 1.4999 are the same
     * frame, and a float that survived a round trip through the UI must not
     * count as a change.
     */
    const same = (
      a: number | undefined,
      b: number | undefined,
      toUnits: (mm: number) => number,
    ) => {
      if (!prev) return false;
      if (a === undefined || b === undefined) return a === b;
      return toUnits(a) === toUnits(b);
    };
    const push = (
      page: number,
      mm: number | undefined,
      minMm?: number,
      at = slot,
      was?: number,
    ) => {
      if (mm === undefined) return;
      const toUnits = (v: number) => this.mmToUnitsWith(v, mult, minMm);
      if (at === slot && same(mm, was, toUnits)) return;
      writes.push({ page, slot: at, value: toUnits(mm) });
    };
    /** Pages 2/3 — see rtUnitsPerMm for why they get their own scale hook. */
    const pushRt = (page: number, mm: number | undefined, was?: number) => {
      if (mm === undefined) return;
      const toUnits = (v: number) =>
        this.mmToUnitsWith(v, this.rtUnitsPerMm(mult), KB_TRAVEL_RANGE.rt.min);
      if (same(mm, was, toUnits)) return;
      writes.push({ page, slot, value: toUnits(mm) });
    };

    // Mode byte (page 7), one value per key: low nibble is the mode
    // (0 normal / 2 dks / 3 mt / 4 tgl_hold / 5 tgl_dots / 7 snap), bit 7 is
    // rapid trigger and bit 6 is full bottom-out. RT has to be packed in here
    // rather than written on its own page — writing the bare mode would clear
    // the key's RT flag.
    const modeByte = (x: MagneticKeySettings) =>
      (MODE_TO_NUM[x.mode ?? 'normal'] & MODE_MASK) |
      (x.rapidTrigger ? RT_BIT : 0) |
      (x.fullBottomOut ? FULL_BOTTOM_BIT : 0);
    const mode = modeByte(k);
    // A snap-tap key is always re-sent: one the board holds at 8-10 reads back
    // as snap-tap too, so comparing against `prev` would never rewrite it to
    // the 7 the firmware acts on.
    if (!prev || modeByte(prev) !== mode || k.mode === 'snap') {
      writes.push({ page: MM_PAGE.MODES, slot, value: mode });
    }

    push(MM_PAGE.TRAVEL, k.actuationMm, undefined, slot, prev?.actuationMm);
    push(MM_PAGE.RELEASE, k.releaseMm, undefined, slot, prev?.releaseMm);
    // Rapid-trigger sensitivity lives on its own two pages. Without these the
    // Actuation tab's RT sliders were bound to fields that never reached the
    // device — the mode bit armed RT, but at whatever sensitivity the board
    // already held.
    //
    // `provenance: inferred` — the vendor writes these only while RT is armed.
    // We write them whenever a value is present, because gating on the flag
    // made "Restore all keys to default" a lie: it sets RT off, so the two
    // pages were skipped and the board kept whatever sensitivity it had while
    // the panel showed the default. Confirm against a read-back diff.
    pushRt(MM_PAGE.RT_PRESS, k.rtPressMm, prev?.rtPressMm);
    pushRt(MM_PAGE.RT_RELEASE, k.rtReleaseMm, prev?.rtReleaseMm);
    // A dead zone of 0 is a real setting — "none" — so it has no floor.
    push(MM_PAGE.DEADZONE_TOP, k.deadZoneMm, KB_TRAVEL_RANGE.deadzone.min, slot, prev?.deadZoneMm);
    push(
      MM_PAGE.DEADZONE_BOTTOM,
      k.deadZoneBottomMm,
      KB_TRAVEL_RANGE.deadzone.min,
      slot,
      prev?.deadZoneBottomMm,
    );

    if (k.mode === 'dks') {
      push(MM_PAGE.DKS_POINTS, k.dksPointMm ?? 0.7);
      // Four bytes, one trigger byte per DKS zone, on page 8 — the vendor's
      // own write on this board (see MM_PAGE.DKS_FLAGS), after the bindings
      // (`setKeyZoneBindings`, which the Actuation tab sends first) and after
      // the mode and point, as here. The vendor always writes all four.
      //
      // `provenance: verified-capture` for the frame; that the board then
      // fires the actions is what the hardware check still has to show.
      writes.push({
        page: MM_PAGE.DKS_FLAGS,
        slot,
        value: dksZoneBytes(k.dksZones),
      });
    }

    // Mod-tap hold time (page 5), stored as ms / 10 in one byte — clamped to
    // what that byte can say. Masking instead made 3 s wrap round to 0.44 s,
    // and 0 is no hold time at all.
    if (k.mode === 'mt' && k.mtHoldMs !== undefined) {
      const units = Math.min(MT_UNITS_MAX, Math.max(1, Math.round(k.mtHoldMs / MT_UNIT_MS)));
      if (
        !prev ||
        prev.mode !== 'mt' ||
        prev.mtHoldMs === undefined ||
        Math.round(prev.mtHoldMs / MT_UNIT_MS) !== units
      ) {
        writes.push({ page: MM_PAGE.MT, slot, value: units });
      }
    }

    // SOCD / snap-tap (page 9): each key holds its partner's slot, 0xFF when
    // it has none. A pair is two keys naming each other, so pairing is a batch
    // carrying BOTH keys, each with its own settings — the renderer's planners
    // build it (tabs/keyboard/magneticModes.ts) and `setMagneticKeys` refuses a
    // batch whose two halves disagree.
    //
    // This used to write the partner's half itself: its page 9, and its mode
    // byte stamped with THIS key's rapid-trigger bit and no bottom-out bit, so
    // pairing A with D quietly changed D's other settings. And re-pairing A
    // never released A's previous partner, which went on naming it.
    let partnerSlot: number = SOCD_NO_PARTNER;
    if (k.mode === 'snap' && k.socdPartner) {
      const p = at(k.socdPartner.row, k.socdPartner.col);
      if (p?.slot === undefined) {
        return {
          error: `snap-tap partner ${k.socdPartner.row},${k.socdPartner.col} not in matrix`,
        };
      }
      if (p.slot === slot) return { error: `key ${k.row},${k.col} cannot pair with itself` };
      partnerSlot = p.slot;
    }
    const prevPartnerSlot = (() => {
      if (!prev || prev.mode !== 'snap' || !prev.socdPartner) return SOCD_NO_PARTNER;
      const p = at(prev.socdPartner.row, prev.socdPartner.col);
      return p?.slot ?? SOCD_NO_PARTNER;
    })();
    // Without a previous state, write it: a key that was paired in the vendor
    // app and is now meant to be plain must not keep naming its partner. And
    // always on the way out of snap-tap — a partner slot outside the layout
    // reads back as "none", so comparing would skip the one clear it needs.
    const leavingSnap = prev?.mode === 'snap' && k.mode !== 'snap';
    if (!prev || leavingSnap || partnerSlot !== prevPartnerSlot) {
      writes.push({ page: MM_PAGE.SNAP, slot, value: partnerSlot & 0xff });
    }

    return { writes };
  }

  /** Send a built batch, committing once on the last frame. */
  private async sendMagWrites(
    writes: Array<{ page: number; slot: number; value: number | number[] }>,
  ): Promise<WriteResult> {
    const frames: string[] = [];
    try {
      for (const [i, w] of writes.entries()) {
        const r = await this.writeMagKey(w.page, w.slot, w.value, i === writes.length - 1);
        frames.push(...(r.frames ?? []));
        if (!r.ok) throw new Error(r.error || 'write failed');
        // Pace: this firmware wedges its endpoint under back-to-back frames.
        if (this.settleMs) await delay(this.settleMs);
      }
    } catch (e) {
      return { ok: false, verified: 'unverified', error: String(e), frames };
    }
    return { ok: true, verified: 'unverified', frames };
  }

  /**
   * Bulk write for a multi-key selection (the Actuation tab's "select many
   * keys, edit together" mode). Sequential per key (same shape as
   * `setMagneticKey`) but paced by `settleMs` between keys so a large
   * selection doesn't flood the feature-report endpoint the way FINDINGS'
   * "endpoint lockup" note warns rapid back-to-back writes can.
   */
  override async setMagneticKeys(
    keys: MagneticKeySettings[],
    previous?: MagneticKeySettings[],
    opts?: MagneticWriteOpts,
  ): Promise<WriteResult> {
    const mismatch = snapPairMismatch(keys);
    if (mismatch) return { ok: false, verified: 'unverified', error: mismatch };
    const mult = await this.travelMultiplier();
    const all: Array<{ page: number; slot: number; value: number | number[] }> = [];
    for (const [i, k] of keys.entries()) {
      const prev = previous?.[i];
      // Positional, and only trusted when it is about the same key — a
      // mismatched pair would suppress a page the board has not got.
      const built = await this.magKeyWrites(
        k,
        mult,
        prev && prev.row === k.row && prev.col === k.col ? prev : undefined,
      );
      // A key the matrix does not have is the caller's mistake, not a reason to
      // half-write the rest of the board.
      if ('error' in built) return { ok: false, verified: 'unverified', error: built.error };
      all.push(...built.writes);
    }
    const zones = await this.releaseModTap(keys, opts);
    if (!zones.ok) return zones;
    return withFrames(zones.frames, await this.sendMagWrites(all));
  }

  /**
   * Give a key leaving mod-tap its own binding back.
   *
   * A mod-tap key's hold sits in zone 0, where its own binding was — the
   * firmware fires zone 0 on a hold (see shared/key-zones.ts) — and its own
   * binding waits in zone 1 as the tap. Put back to Normal (or Toggle, or
   * snap-tap) with nothing more, the key would go on typing its HOLD: an `A`
   * that types Ctrl. So for every key in the batch that is not mod-tap but
   * whose recorded entry is, the tap goes back into zone 0 — before any page,
   * the vendor's bindings-first order — and the entry is dropped.
   *
   * Driven by the record, not by the key's previous mode: every path that
   * changes a mode lands here (the Actuation tab, a saved layout, a profile
   * copy), and not all of them know what the key was. A write to another
   * profile (`keepZoneBindings`) leaves the bindings alone — they are not that
   * profile's.
   */
  private async releaseModTap(
    keys: MagneticKeySettings[],
    opts?: MagneticWriteOpts,
  ): Promise<WriteResult> {
    const ok: WriteResult = { ok: true, verified: 'unverified', frames: [] };
    if (opts?.keepZoneBindings) return ok;
    const layout = this.d.spec.keyMatrix?.layout;
    if (!layout) return ok;
    const leaving = keys.filter((k) => k.mode !== 'mt');
    if (!leaving.length) return ok;
    const record = await this.zoneRecord();
    const frames: string[] = [];
    let changed = false;
    for (const k of leaving) {
      const slot = layout.find((e) => e.row === k.row && e.col === k.col)?.slot;
      if (slot === undefined) continue;
      const entry = record[slot];
      if (!isModTapEntry(entry)) continue;
      const quad = quadFor(entry![MT_TAP_ZONE]!);
      if (!quad) continue;
      const r = await this.sendZoneFrames(slot, [{ zone: 0, quad }]);
      frames.push(...(r.frames ?? []));
      if (!r.ok) return { ...r, frames };
      delete record[slot];
      changed = true;
    }
    if (changed) await this.saveZoneRecord(record);
    return { ...ok, frames };
  }

  // -- live per-key travel --------------------------------------------------
  /**
   * Arm the firmware's travel reporting. qmk.top's `switchTravelSimulation`
   * sends exactly `[SET_MAGNETISM_REPORT, enable]` and then sleeps before
   * doing anything else, so settle afterwards rather than reading straight
   * into the enable.
   */
  override async startTravelStream(): Promise<TravelStreamResult> {
    // The stream is pushed input reports, which a receiver does not carry.
    if (this.relayed) return { ok: false, unsupported: true, error: 'needs the cable' };
    try {
      await this.ch.write(this.frame(KB_CMD.SET_MAGNETISM_REPORT, [1]));
      if (this.settleMs) await delay(this.settleMs);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: String(e) };
    }
  }

  override async stopTravelStream(): Promise<void> {
    try {
      await this.ch.write(this.frame(KB_CMD.SET_MAGNETISM_REPORT, [0]));
    } catch {
      /* ignore */
    }
  }

  /**
   * One sample of live per-key travel, read as magnetism page 254 (see
   * TRAVEL_PAGE) and mm-scaled server-side with this board's own
   * `travelMultiplier()` — slot-indexed like every other per-key wire
   * operation, so the renderer never has to guess at a layout.
   *
   * This replaces an input-report `readStream()` poll whose byte layout was
   * never captured and which, on a feature-report-only vendor collection like
   * the R85HE's MI_02, only ever returned stale endpoint bytes — the reported
   * "live monitor does nothing". The frame shape here is `verified-capture`;
   * the rest-threshold is `inferred`, and the sanity gate still discards an
   * implausible sample rather than painting garbage on the board.
   *
   * Only the board's own key slots are reported. The page has 128 slots but
   * the family's matrix is 126 (21 x 6, the per-key LED map's size), and on
   * an R85HE fw 5.11 slot 126 holds a constant non-sentinel word at rest —
   * reported as a key, it sat between the default 2.5 mm actuation and the
   * 4.2 mm gate, so the Test view showed "126" permanently pressed, the live
   * monitor's "deepest key" kept snapping back to it, and calibration could
   * count it as a key seen. Off-layout slots are dropped BEFORE the sanity
   * gate, too: one above 4.2 mm would otherwise mark every sample incomplete
   * and silently kill the stream.
   */
  override async readTravel(): Promise<TravelSample | null> {
    const units = await this.readMagnetismPage(TRAVEL_PAGE, TRAVEL_PAGE_CHUNKS);
    if (!units) return null;
    const mult = await this.travelMultiplier();
    const keySlots = this.keySlots();
    const keys: { slot: number; mm: number }[] = [];
    for (let slot = 0; slot < units.length; slot++) {
      const raw = units[slot] ?? 0;
      // 0xffff is the firmware's "no switch here" sentinel, same as the
      // configuration pages.
      if (raw === 0xffff) continue;
      const mm = raw / mult;
      if (mm <= TRAVEL_REST_MM) continue;
      if (keySlots && !keySlots.has(slot)) {
        this.noteOffLayoutTravel(slot, raw);
        continue;
      }
      keys.push({ slot, mm });
    }
    // `raw` is only the developer frame log's diagnostic hex — re-encode the
    // leading slots as the uint16-LE pairs they arrived as, so the log shows
    // wire-shaped bytes rather than a lossy cast of the decoded values.
    const raw = new Uint8Array(TRAVEL_RAW_SLOTS * 2);
    for (let i = 0; i < TRAVEL_RAW_SLOTS; i++) {
      const v = units[i] ?? 0;
      raw[i * 2] = v & 0xff;
      raw[i * 2 + 1] = (v >> 8) & 0xff;
    }
    // A tripped sanity gate is reported as an INCOMPLETE sample, not as an
    // empty one. Since a released key is expressed by absence from `keys`,
    // returning `[]` here told the renderer "every key just came up" — which
    // is exactly the "key I am still holding jumps back to 0" report.
    const implausible =
      keys.some((k) => k.mm > TRAVEL_MAX_MM) || keys.length > TRAVEL_MAX_ACTIVE_KEYS;
    return implausible ? { raw, keys: [], complete: false } : { raw, keys, complete: true };
  }

  /**
   * Slots that are keys on this board, as `readMagnetic` resolves them
   * (`slot ?? layout index`). Null when the descriptor has no layout, in
   * which case nothing can be filtered and every slot is reported as before.
   */
  private keySlots(): ReadonlySet<number> | null {
    if (this._keySlots) return this._keySlots;
    const layout = this.d.spec.keyMatrix?.layout;
    if (!layout) return null;
    const slots = layout.map((e) => e.slot).filter((x): x is number => x !== undefined);
    // A layout without slots names no keys; the stream then reports every slot.
    if (!slots.length) return null;
    this._keySlots = new Set(slots);
    return this._keySlots;
  }

  /**
   * What an ignored off-layout slot actually held, once per slot per session.
   * Nobody has seen slot 126's value before — the `raw` echo only carries
   * the first TRAVEL_RAW_SLOTS — so this is how its meaning gets captured.
   */
  private noteOffLayoutTravel(slot: number, raw: number): void {
    if (this._travelNoted.has(slot)) return;
    this._travelNoted.add(slot);
    frameLog.push({
      deviceId: this.d.model,
      dir: 'rx',
      hex: '',
      note: `readTravel: page ${TRAVEL_PAGE} slot ${slot} is not a key on this layout but reads 0x${raw.toString(16).padStart(4, '0')} — ignored.`,
    });
  }

  protected override backupCommands(): number[] {
    // Deliberately adds nothing. A bare `GET_MULTI_MAGNETISM` was listed here,
    // but it needs a `[page, 1, chunk]` argument: backup()'s bare send only
    // ever captured the first ~56-byte chunk of page 0 (this class's own
    // backup() comment says so), making it dead weight — and it is precisely
    // the "bare GET that needs a page argument" CAPTURE-KEYBOARD.md says hangs
    // the MCU, fired by ensureBackup() before the first write from any tab.
    // Every page is captured properly by the backup() override below.
    return super.backupCommands();
  }

  /** …and every key's mode and actuation point, which between them are the key. */
  override backupPolicy(): BackupPolicy {
    return {
      kind: 'full',
      required: [
        ...super.backupPolicy().required,
        `magnetism_page_${MM_PAGE.MODES}`,
        `magnetism_page_${MM_PAGE.TRAVEL}`,
      ],
    };
  }

  override async backup(): Promise<Record<string, string>> {
    const base = await super.backup();
    let firstPage = true;
    for (const page of Object.values(MM_PAGE)) {
      // Page 8 is write-only: a read returns our own query checksum echoed
      // back (see MM_PAGE.DKS_FLAGS), and restoring that wrote junk zone flags
      // to whatever keys it landed on. The flags are kept from page 10, where
      // they are read.
      if (page === MM_PAGE.DKS_FLAGS) continue;
      // Same reason as backupPaceMs: sweeping 12 pages x up to 8 chunks
      // back-to-back is exactly the burst that wedges this endpoint.
      if (!firstPage) await delay(this.backupPaceMs);
      firstPage = false;
      // Store the FULLY decoded per-slot array (JSON), not `toHex` of a single
      // bare `GET_MULTI_MAGNETISM [page]` reply — that only ever captured the
      // first ~56-byte chunk of each page, so the backup was incomplete and
      // could not be replayed. `readMagnetismPage` sweeps every chunk.
      const values = await this.readMagnetismPage(page).catch(() => null);
      if (values && values.length) base[`magnetism_page_${page}`] = JSON.stringify(values);
    }
    // The Mod-tap holds and DKS actions SharkDeck has written. The board has
    // no read-back for them, so this record is the only copy there is.
    const zones = await this.readKeyZoneBindings().catch(() => null);
    if (zones && Object.keys(zones).length) base[ZONE_BINDINGS_BLOCK] = JSON.stringify(zones);
    return base;
  }

  /**
   * Replay a backup: the base class handles the key-remap layers, then every
   * stored magnetism page is written back per slot through `writeMagKey` (the
   * capture-verified single-key `SET_MULTI_MAGNETISM` frame). Legacy backups
   * that stored a page as raw hex (pre-decoded-array) are skipped — they only
   * ever held one chunk. `provenance: ported-from-vendor`; verify on a real
   * R85HE (smoke-hid + frame log) before trusting it.
   *
   * Mod-tap and DKS keys come back whole, in the vendor's order: their zone
   * bindings (from the backup's record — the board has no read-back) before
   * the pages that put the keys in those modes, and a DKS key's zone flags
   * last, to page 8, from the page-10 read the backup holds. Only for keys the
   * backup has in those modes: nothing else uses either.
   *
   * The order around the bindings matters because a mod-tap key keeps its own
   * binding in zone 1 and its hold in zone 0 (shared/key-zones.ts): a key that
   * is mod-tap NOW but not in the backup gets its own binding back first; the
   * record then becomes the backup's, BEFORE the base class replays the remap
   * layers, so a remap of a mod-tap key lands in its tap zone; then the zones,
   * then the pages — page 7 included for a key leaving mod-tap, even where the
   * backup holds 0.
   *
   * Pages 8 and 10 are never replayed as they stand. Page 8 cannot be read —
   * a backup taken before it was skipped holds our own echoed checksum, which
   * this used to write back as DKS flags — and page 10 is the read side, where
   * a write changes nothing.
   */
  override async restoreFromBackup(blocks: Record<string, string>): Promise<WriteResult> {
    const results: WriteResult[] = [];

    // The same keys every other magnetism path addresses — a board without a
    // layout restored nothing at all when this took them from the layout.
    const slots = ((await this.magneticKeys()) ?? []).map((k) => k.slot);

    const pages = new Map<number, unknown[]>();
    for (const [name, value] of Object.entries(blocks)) {
      const pm = /^magnetism_page_(\d+)$/.exec(name);
      if (!pm) continue;
      let arr: unknown;
      try {
        arr = JSON.parse(value);
      } catch {
        continue; // legacy hex block — incomplete, don't half-restore it
      }
      if (Array.isArray(arr)) pages.set(Number(pm[1]), arr);
    }
    const valueAt = (page: number, slot: number): number => {
      const v = Number(pages.get(page)?.[slot] ?? 0);
      return Number.isFinite(v) ? v : 0;
    };
    const modeAt = (slot: number) => valueAt(MM_PAGE.MODES, slot) & MODE_MASK;
    const dksSlots = slots.filter((slot) => modeAt(slot) === MODE_TO_NUM.dks);
    const zonedSlots = slots.filter(
      (slot) => modeAt(slot) === MODE_TO_NUM.mt || modeAt(slot) === MODE_TO_NUM.dks,
    );

    let record: KeyZoneBindings = {};
    try {
      const parsed: unknown = JSON.parse(blocks[ZONE_BINDINGS_BLOCK] ?? '{}');
      if (parsed && typeof parsed === 'object') record = parsed as KeyZoneBindings;
    } catch {
      /* no record: the keys keep the bindings the board has */
    }
    // The base layer as the backup has it, for a legacy mod-tap entry's tap.
    let baseLayer: Record<string, { raw?: number[] }> = {};
    try {
      const parsed: unknown = JSON.parse(blocks.keymatrix_base ?? '{}');
      if (parsed && typeof parsed === 'object') baseLayer = parsed as typeof baseLayer;
    } catch {
      /* no base layer: legacy entries stay as they are */
    }
    /** The backup's own entry for a zoned slot, a legacy mod-tap one turned
     *  the right way round with the key's own binding as its tap. */
    const entryFor = (slot: number): Array<string | null> | null => {
      const zones = record[slot];
      if (!Array.isArray(zones) || !zones.some((z) => z !== null)) return null;
      const hold = modeAt(slot) === MODE_TO_NUM.mt ? legacyModTapHold(zones) : null;
      if (!hold) return [...zones];
      const raw = baseLayer[String(slot)]?.raw;
      return Array.isArray(raw) ? [hold, actionOfQuad(raw)] : null;
    };

    // A key that is mod-tap NOW but not in the backup gets its own binding
    // back in zone 0 first — the base restore below writes zone 0 too, but
    // only for plain keys, and the modes loop further down only writes what
    // the backup holds. Its mode byte is forced below for the same reason.
    const local = await this.zoneRecord();
    const leaving: number[] = [];
    for (const [slotStr, entry] of Object.entries(local)) {
      const slot = Number(slotStr);
      if (!isModTapEntry(entry)) continue;
      if (zonedSlots.includes(slot) && isModTapEntry(entryFor(slot))) continue;
      const own = quadFor(entry[MT_TAP_ZONE]!);
      if (!own) continue;
      results.push(await this.sendZoneFrames(slot, [{ zone: 0, quad: own }]));
      leaving.push(slot);
    }
    // The record becomes the backup's — BEFORE the base restore, whose remaps
    // of mod-tap keys go to their tap zone by it (see `setKeyRemap`).
    const next: KeyZoneBindings = {};
    for (const slot of zonedSlots) {
      const e = entryFor(slot);
      if (e) next[slot] = e;
    }
    await this.saveZoneRecord(next);

    const baseResult = await super.restoreFromBackup(blocks).catch(() => null);
    // `notSupported` comes back as `ok:false` — only fold in a real outcome.
    if (baseResult && baseResult.ok) results.push(baseResult);

    for (const slot of zonedSlots) {
      const zones = next[slot];
      if (zones) results.push(await this.setKeyZoneBindings(slot, zones));
    }

    for (const page of pages.keys()) {
      if (page === MM_PAGE.DKS_FLAGS || page === MM_PAGE.DKS_FLAGS_READ) continue;
      // Commit on the last slot of the page, not on every write — see
      // `writeMagKey`.
      // Skip empty slots — writing 0 back is a no-op at best and, on the
      // modes page, would force every key to "normal". Except a key leaving
      // mod-tap above: there "normal" is exactly the point.
      const live = slots.filter(
        (slot) => valueAt(page, slot) > 0 || (page === MM_PAGE.MODES && leaving.includes(slot)),
      );
      for (const [i, slot] of live.entries()) {
        results.push(
          await this.writeMagKey(page, slot, valueAt(page, slot), i === live.length - 1),
        );
        if (this.settleMs) await delay(this.settleMs);
      }
    }

    const flagged = dksSlots.filter((slot) => valueAt(MM_PAGE.DKS_FLAGS_READ, slot) > 0);
    for (const [i, slot] of flagged.entries()) {
      results.push(
        await this.writeMagKey(
          MM_PAGE.DKS_FLAGS,
          slot,
          valueAt(MM_PAGE.DKS_FLAGS_READ, slot),
          i === flagged.length - 1,
        ),
      );
      if (this.settleMs) await delay(this.settleMs);
    }

    if (results.length === 0) return this.notSupported('Backup restore');
    return kbWorst(results);
  }
}
