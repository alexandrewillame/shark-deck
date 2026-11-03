import type {
  DpiLedSettings,
  ReceiverLedSettings,
  ReceiverLedValues,
} from '@shared/types/lighting';
import type { FirmwareInfo, LiveState, WriteResult } from '@shared/types/live';
import type { Macro } from '@shared/types/macros';
import type {
  ButtonMapping,
  DpiStage,
  PairingStatus,
  PowerSettings,
  SensorSettings,
} from '@shared/types/mouse-settings';
import { Driver, fmtVersion } from './base';
import type { HidChannel } from '../../hid/transport';
import { toHex } from '../../hid/frame';
import { pollRateFromWire, pollRateToWire, DPI_STAGE_COLORS } from '@shared/mouse-options';
import { batteryPercentFromCurve } from '@shared/battery';
import {
  V8_CMD,
  V8_BLOCK,
  V8_PROFILE_DUMP_LEN,
  companion,
  scalarBytes,
  rgbBytes,
  dpiRegBytes,
  dpiRegFromBytes,
  registerToDpi16,
  v8ButtonOffset,
  v8ButtonExtOffset,
  v8MacroOffset,
  V8_MACRO_SLOTS,
  V8_MACRO_STRIDE,
  RX_LED_COUNT,
  RX_LED_VALUES,
  dpiLedBrightToWire,
  dpiLedBrightFromWire,
  dpiLedSpeedToWire,
  dpiLedSpeedFromWire,
  angleToWire,
  angleFromWire,
  sleepSecToWire,
  sleepWireToSec,
  applicableDpiStages,
  clampActiveDpiStage,
} from '@shared/mouse-wire';
import { encodeMouseMacro, decodeMouseMacro, MOUSE_MACRO_MAX_BYTES } from './mouse-macro-codec';
import {
  BUTTON_ACTION_BY_KEY,
  encodeButtonRegionA,
  actionKeyFromWire,
} from '@shared/mouse-buttons';

/**
 * Attack Shark V8 family (Compx 8K wireless dongle, 17-byte `0x08` reports).
 *
 * Rewritten to the 2026-08-30 full-feature capture
 * (docs/reverse-engineering/FINDINGS.md). The headline correction over the old
 * driver: **the write command is `0x07`, not `0x09`** — `0x09` with zero args
 * is *restore factory defaults*, so every setting write the old driver made was
 * a reset opcode. Every scalar value carries a companion byte
 * `(0x55 - value) & 0xFF` (a per-field check, same rule as the frame checksum).
 *
 * VERIFIED (capture): the collection match + `(0x55 - Σ)` checksum,
 * `0x0F` set profile, `0x0E` get profile, `0x03` status, `0x04` battery,
 * `0x07` write-setting, `0x08` read-block, `0x09` restore, `0x16` long-range,
 * `0x2C` receiver LED, and the region-A offset map in `@shared/mouse-wire.ts`.
 *
 * The region-A offset map AND the DPI-register formula (`reg = dpi/50 - 1`,
 * with the smeared hi byte for >12800 DPI) are now verified byte-for-byte
 * against the vendor Hub — see docs/reverse-engineering/session-v8-verify.jsonl.
 *
 * INFERRED (guarded — every write is read back and a backup is taken first):
 * the region-B extended-button record layout, the region-C macro layout, and
 * the `0x05`/`0x06` pairing reply shapes.
 */

const MAX_BLOCK_CHUNK = 10; // 17-byte report, payload bytes 6..15

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * How long to let a `0x07` write settle before re-reading it, and how many
 * times to look.
 *
 * A region-A write and its read-back are two separate on-air exchanges: the
 * host hands `0x07` to the dongle, the dongle relays it, the mouse applies it
 * to its config RAM. Reading the same offset microseconds later can therefore
 * still answer with the PRE-write byte — a mismatch reported for a write that
 * worked perfectly. It is worst on the first write of a burst, when the link
 * has just come out of idle, which is exactly where `setDpiStages` puts its
 * `DPI_STAGE_COUNT` write and exactly the "sometimes" in the bug report.
 *
 * `writeVerified` in base.ts already learned this on the Compx keyboard (see
 * its `settleMs`); the mouse's own block-write path never got the same
 * treatment. The first read stays immediate, so nothing that already worked
 * gets slower — the delay is only paid on a near-miss.
 */
const WRITE_SETTLE_MS = 30;
const WRITE_READBACK_ATTEMPTS = 3;

export class CompxMouse8K extends Driver {
  private currentSlot = 1;

  lastAwake: boolean | null = null;

  // — verified reads --------------------------------------------------
  override async getActiveProfile(): Promise<number | null> {
    const reply = await this.ch.request(this.frame(V8_CMD.GET_PROFILE), V8_CMD.GET_PROFILE, 3, 6);
    if (reply && reply.length >= 7) {
      this.currentSlot = (reply[6] ?? 0) + 1;
      return this.currentSlot;
    }
    return null;
  }

  /**
   * Liveness probe — the `0x03` status poll the Hub itself sends ~1 Hz.
   * `online` = a well-formed reply arrived (the dongle can only answer for a
   * channel it has a peer on). `reply[6]` tracks the mouse's RF-active/awake
   * state: the capture's `11_*` offline steps show it drop `01 -> 00` when the
   * mouse is powered off, but the dongle keeps answering, so treat "no reply"
   * and "`reply[6] == 0`" the same for presence — keep the byte only as the
   * separate `lastAwake` hint. See docs/reverse-engineering/FINDINGS.md.
   */
  override async ping(): Promise<boolean> {
    const reply = await this.ch.request(this.frame(V8_CMD.STATUS), V8_CMD.STATUS, 3, 6);
    if (!reply || reply.length < 7) {
      this.lastAwake = null;
      return false;
    }
    this.lastAwake = (reply[6] ?? 0) > 0;
    return true;
  }

  override async getBattery(): Promise<{
    level: number | null;
    charging: boolean;
    raw: number | null;
    millivolts: number | null;
  }> {
    const reply = await this.ch.request(this.frame(V8_CMD.BATTERY), V8_CMD.BATTERY, 3, 8);
    if (reply && reply.length >= 10) {
      const raw = reply[6] ?? 0;
      // bytes 8-9 big-endian = cell millivolts (outside the reply's declared
      // length but present in every capture). reply[7] toggled 00/01 as the
      // 2026-08-30 session went on-cable — a candidate charging flag, not
      // confirmed; report it but keep the curve-derived percent as `level`.
      const millivolts = ((reply[8] ?? 0) << 8) | (reply[9] ?? 0);
      const level =
        millivolts > 0 ? batteryPercentFromCurve(millivolts) : raw >= 0 && raw <= 100 ? raw : null;
      const charging = (reply[7] ?? 0) === 0x01;
      return { level, charging, raw, millivolts: millivolts || null };
    }
    return { level: null, charging: false, raw: null, millivolts: null };
  }

  /**
   * Two versions, two sources, and only one of them is a USB descriptor.
   *
   * - The **receiver** is the `bcdDevice` of whichever endpoint enumerated
   *   (`HidChannel.descriptorRelease`). That is what the vendor's
   *   `CS_UsbFinder_GetVersion` also reports for the dongle side.
   * - The **mouse** answers command `0x12` itself (see `V8_CMD.DEVICE_VERSION`),
   *   and it does so over the air as well as on the cable — so the version is
   *   readable on the dongle, which is what the Hub shows. Command `0x02` is
   *   still a pure ACK/echo and still carries nothing; it was simply never the
   *   command the Hub used.
   *
   * Because the `0x12` reply crosses the 2.4 GHz link, a dozing mouse does not
   * answer it. The version cannot change while the device stays attached, so
   * the first successful read is cached for the life of the driver and a later
   * doze keeps showing it instead of flipping the panel back to "unknown".
   */
  private deviceVersionRaw: number | null = null;

  private async readDeviceVersion(): Promise<number | null> {
    if (this.deviceVersionRaw !== null) return this.deviceVersionRaw;
    // Same bail-out as readLiveState: over the dongle this is an on-air
    // round trip, and a sleeping mouse costs the full retry budget to learn
    // nothing. The cable answers regardless, so only gate the wireless side.
    if (!this.d.wired && this.lastAwake === false) return null;
    const reply = await this.ch.request(
      this.frame(V8_CMD.DEVICE_VERSION),
      V8_CMD.DEVICE_VERSION,
      2,
      6,
    );
    // Byte 2 is `0x01` on the dongle's generic ACK and `0x00` on a real
    // payload — the same discriminator `rxTriple()` uses for `0x2D`.
    if (!reply || reply.length < 8 || (reply[2] ?? 0) !== 0x00 || (reply[5] ?? 0) < 2) return null;
    const raw = ((reply[6] ?? 0) << 8) | (reply[7] ?? 0);
    if (!raw) return null;
    this.deviceVersionRaw = raw;
    return raw;
  }

  override async getFirmware(): Promise<FirmwareInfo> {
    const endpoint = this.ch.descriptorRelease ?? 0;
    const wired = this.d.wired === true;
    // On the cable the endpoint IS the mouse, so its descriptor is a free
    // second source for the same number; over the dongle the descriptor
    // belongs to the receiver and only `0x12` can speak for the mouse.
    const deviceRaw = (await this.readDeviceVersion()) ?? (wired ? endpoint : 0);
    const receiverRaw = wired ? 0 : endpoint;
    return {
      device: deviceRaw ? fmtVersion(deviceRaw) : null,
      receiver: receiverRaw ? fmtVersion(receiverRaw) : null,
      deviceRaw: deviceRaw || undefined,
      receiverRaw: receiverRaw || undefined,
      // A wireless mouse that has not answered yet is asleep, not broken —
      // that distinction is the whole difference between "wake it" and "this
      // build cannot report a version".
      readState: deviceRaw ? 'ok' : wired ? 'noReply' : 'asleep',
    };
  }

  // — verified write: 0x0F set active profile -----------------------
  override async setActiveProfile(slot: number): Promise<WriteResult> {
    if (slot < 1 || slot > (this.d.spec.profileCount ?? 4)) {
      return { ok: false, verified: 'unverified', error: `profile out of range: ${slot}` };
    }
    const res = await this.writeVerified(V8_CMD.SET_PROFILE, [0x00, 0x00, 0x00, 0x01, slot - 1], {
      getCommand: V8_CMD.GET_PROFILE,
      compare: (p) => (p[4] ?? -1) === slot - 1,
    });
    if (res.ok) {
      this.currentSlot = slot;
      this.invalidateSnapshot();
    }
    return res;
  }

  // — config-block primitives -------------------------------------
  // Read: `08 08 00 <off_hi> <off_lo> <len>` (offset big-endian, len <= 10).
  // Write: `08 07 00 <off_hi> <off_lo> <len> <bytes…>` — the payload already
  // includes any companion byte. Both verified by the capture.
  /**
   * Is this `0x08` reply the answer to the read we actually issued?
   *
   * Every offset in region A is read with the SAME command byte, so
   * `request()`'s command-byte match cannot tell one read's answer from
   * another's — and a reply carries its offset (bytes 3-4) and length (byte 5)
   * echoed back precisely so it can be. Two things put foreign `0x08` replies
   * in our queue: our own concurrent reads (a 22-frame `regionA()` sweep next
   * to a write's read-back), and — because Windows delivers every input report
   * to every open handle, see `HidChannel.request` — the vendor Mouse Hub
   * polling the same device beside us. Without this check either one is
   * accepted as the answer to whatever we asked last, which is how a write
   * that landed perfectly gets reported as "did not read back as written".
   */
  private static blockReplyFor(offset: number, length: number) {
    return (r: Uint8Array): boolean =>
      (((r[3] ?? 0) << 8) | (r[4] ?? 0)) === offset && (r[5] ?? 0) === length;
  }

  private async readBlockRaw(offset: number, length: number): Promise<Uint8Array | null> {
    const frame = this.frame(V8_CMD.READ_BLOCK, [
      0x00,
      (offset >> 8) & 0xff,
      offset & 0xff,
      length & 0xff,
    ]);
    const reply = await this.ch.request(
      frame,
      V8_CMD.READ_BLOCK,
      3,
      6,
      false,
      CompxMouse8K.blockReplyFor(offset, length),
    );
    return reply ? reply.subarray(6, 6 + length) : null;
  }

  private async readBlock(offset: number, length: number): Promise<Uint8Array | null> {
    if (length <= MAX_BLOCK_CHUNK) return this.readBlockRaw(offset, length);
    const out = new Uint8Array(length);
    for (let done = 0; done < length;) {
      const n = Math.min(MAX_BLOCK_CHUNK, length - done);
      const chunk = await this.readBlockRaw(offset + done, n);
      if (!chunk) return null;
      out.set(chunk, done);
      done += n;
    }
    return out;
  }

  /**
   * Region A (0x0000..0xD7) with a short cache. A sleeping/dozing V8 drops
   * single-field `0x08` reads intermittently — but the Hub-style 10-byte
   * chunked sweep is reliable — so every `read*` method slices from one
   * snapshot rather than issuing its own tiny read. Invalidated after any
   * write / profile switch / restore.
   */
  private regionASnapshot: { at: number; bytes: Uint8Array } | null = null;
  private static readonly REGION_A_TTL = 600;

  private async regionA(force = false): Promise<Uint8Array | null> {
    const now = Date.now();
    if (
      !force &&
      this.regionASnapshot &&
      now - this.regionASnapshot.at < CompxMouse8K.REGION_A_TTL
    ) {
      return this.regionASnapshot.bytes;
    }
    // `tears` is counted separately from `attempt` on purpose: a torn sweep is
    // not a device that failed to answer, it is one that answered too well
    // while something else was writing, so it must not burn one of the three
    // retries reserved for a dozing mouse.
    for (let attempt = 0, tears = 0; attempt < 3;) {
      // A sweep is 22 separate `ch.request` calls (readBlock -> readBlockRaw),
      // each taking the channel gate on its own — so a write CAN land between
      // two chunks, and the result is then a mix of before and after. The
      // epoch, bumped by invalidateSnapshot(), is how that is detected:
      // without it a torn read got cached and served as fresh for the whole
      // REGION_A_TTL.
      const epoch = this.snapshotEpoch;
      const bytes = await this.readBlock(0, V8_PROFILE_DUMP_LEN);
      if (bytes && epoch === this.snapshotEpoch) {
        this.regionASnapshot = { at: Date.now(), bytes };
        return bytes;
      }
      if (bytes) {
        if (++tears > 3) return null; // a sustained write burst; let the caller retry later
        continue;
      }
      attempt++;
      await this.ch.request(this.frame(V8_CMD.STATUS), V8_CMD.STATUS, 2, 4);
      await new Promise((r) => setTimeout(r, 80));
    }
    return null;
  }

  /** Bumped on every invalidation so an in-flight sweep can tell that the
   *  bytes it is assembling no longer describe one consistent moment. */
  private snapshotEpoch = 0;

  private invalidateSnapshot(): void {
    this.regionASnapshot = null;
    this.snapshotEpoch++;
  }

  /** One region-A field byte, from the snapshot; null only if the whole sweep failed. */
  private async fieldByte(offset: number): Promise<number | null> {
    const snap = await this.regionA();
    return snap && offset < snap.length ? (snap[offset] ?? null) : null;
  }

  /** `len` region-A bytes from the snapshot. */
  private async fieldBytes(offset: number, len: number): Promise<Uint8Array | null> {
    const snap = await this.regionA();
    return snap && offset + len <= snap.length ? snap.subarray(offset, offset + len) : null;
  }

  /** Write `bytes` (payload incl. companion) at `offset` via `0x07`, then read
   *  the same span back and diff. One atomic transaction.
   *
   *  `quiet` suppresses only the generic mismatch *warning*, never the diff
   *  itself — the caller is a speculative offset that reports its own, more
   *  specific caveat (see `writeSpeculative`). Same option and same reasoning
   *  as `writeVerified`'s `quiet` in drivers/base.ts. */
  private async writeSettingRaw(
    offset: number,
    bytes: number[],
    opts: { quiet?: boolean } = {},
  ): Promise<WriteResult> {
    const setTx = this.frame(V8_CMD.WRITE_SETTING, [
      0x00,
      (offset >> 8) & 0xff,
      offset & 0xff,
      bytes.length & 0xff,
      ...bytes,
    ]);
    const readTx = this.frame(V8_CMD.READ_BLOCK, [
      0x00,
      (offset >> 8) & 0xff,
      offset & 0xff,
      bytes.length & 0xff,
    ]);
    return this.ch.transaction(async (io) => {
      const frames = [toHex(setTx)];
      let res: WriteResult;
      try {
        await io.write(setTx);
        res = { ok: true, verified: 'unverified', frames };
      } catch (e) {
        return { ok: false, verified: 'unverified', error: String(e), frames };
      }
      let back: Uint8Array | null = null;
      let match = false;
      for (let attempt = 0; attempt < WRITE_READBACK_ATTEMPTS && !match; attempt++) {
        if (attempt) await sleep(WRITE_SETTLE_MS);
        const backReply = await io.request(
          readTx,
          V8_CMD.READ_BLOCK,
          3,
          6,
          false,
          CompxMouse8K.blockReplyFor(offset, bytes.length),
        );
        if (!backReply) break;
        back = backReply.subarray(6, 6 + bytes.length);
        match = bytes.every((b, i) => back![i] === b);
      }
      if (!back) return { ...res, verified: 'unverified' };
      if (!match && !opts.quiet)
        this.warn(`Setting 0x${offset.toString(16)} did not read back as written.`);
      return { ...res, verified: match ? 'match' : 'mismatch', frames: [...frames, toHex(back)] };
    });
  }

  private async writeSetting(
    offset: number,
    bytes: number[],
    opts: { quiet?: boolean } = {},
  ): Promise<WriteResult> {
    this.invalidateSnapshot();
    let res: WriteResult;
    if (bytes.length <= MAX_BLOCK_CHUNK) {
      res = await this.writeSettingRaw(offset, bytes, opts);
    } else {
      const results: WriteResult[] = [];
      for (let done = 0; done < bytes.length; done += MAX_BLOCK_CHUNK) {
        results.push(
          await this.writeSettingRaw(
            offset + done,
            bytes.slice(done, done + MAX_BLOCK_CHUNK),
            opts,
          ),
        );
      }
      res = worst(results);
    }
    // Invalidate AFTER the write too, not only before it. A read that won the
    // channel gate between the pre-write invalidation and the write itself
    // repopulates the snapshot with pre-write bytes, and REGION_A_TTL then
    // serves them as fresh for up to 600ms — which is one of the ways the UI
    // ends up showing a value the device no longer has.
    this.invalidateSnapshot();
    return res;
  }

  /**
   * A write to an offset whose role is INFERRED rather than capture-verified.
   *
   * Deliberately kept OUT of the caller's `worst()` fold: a byte we are not
   * sure the firmware even owns must never turn a write that demonstrably
   * landed into a reported mismatch. A miss becomes one `note` on the caller's
   * single result instead of two extra `warn` toasts on top of the renderer's.
   * The read-back diff still runs — the invariant is that every write is
   * verified, not that every write is reported as its own line.
   */
  private async writeSpeculative(
    offset: number,
    bytes: number[],
    caveat: string,
  ): Promise<{ ok: boolean; landed: boolean; note?: string; frames?: string[] }> {
    const r = await this.writeSetting(offset, bytes, { quiet: true });
    const landed = r.verified === 'match';
    return { ok: r.ok, landed, note: landed ? undefined : caveat, frames: r.frames };
  }

  /** Read one region-A scalar setting (value byte only) — from the snapshot. */
  private async readScalar(offset: number): Promise<number | null> {
    return this.fieldByte(offset);
  }

  // — DPI stages ------------------------------------------------
  override async readDpiStages(): Promise<DpiStage[] | null> {
    const countByte = await this.fieldBytes(V8_BLOCK.DPI_STAGE_COUNT, 1);
    if (!countByte) return null;
    const max = this.d.spec.dpi?.stages ?? 6;
    const count = Math.min(Math.max(countByte[0] || max, 1), max);
    const step = this.d.spec.dpi?.step ?? 50;
    const stages: DpiStage[] = [];
    for (let i = 0; i < count; i++) {
      const reg = await this.fieldBytes(
        V8_BLOCK.DPI_STAGE_REG + i * V8_BLOCK.DPI_STAGE_REG_STRIDE,
        3,
      );
      const col = await this.fieldBytes(
        V8_BLOCK.DPI_STAGE_COLOR + i * V8_BLOCK.DPI_STAGE_COLOR_STRIDE,
        3,
      );
      const fallback = DPI_STAGE_COLORS[i] ?? [61, 248, 232];
      const reg16 = reg ? dpiRegFromBytes(reg[0] ?? 0, reg[2] ?? 0) : 0;
      stages.push({
        index: i,
        dpi: registerToDpi16(reg16, step),
        color: col
          ? [col[0] ?? fallback[0], col[1] ?? fallback[1], col[2] ?? fallback[2]]
          : fallback,
        // The device only reports the stages it cycles — the loop is bounded by
        // DPI_STAGE_COUNT, so everything read back is by definition enabled.
        // There is no per-stage disable bit to recover; see setDpiStages.
        enabled: true,
      });
    }
    return stages;
  }

  override async setDpiStages(stages: DpiStage[]): Promise<WriteResult> {
    const step = this.d.spec.dpi?.step ?? 50;
    const results: WriteResult[] = [];
    // Region A has no per-stage disable — DPI_STAGE_COUNT (0x02) alone decides
    // which slots the mouse cycles. So a disabled stage has to be *dropped*
    // before it ever reaches a slot, not written and flagged off; otherwise the
    // mouse happily cycles into a stage the UI shows as off.
    const live = applicableDpiStages(stages);
    // Read the previous active stage *first*: the write below invalidates the
    // region-A snapshot, and a re-read against a dozing mouse can come back
    // null — which used to mean the restore was skipped entirely and the device
    // was left parked on the last slot the loop selected.
    const restore = await this.readScalar(V8_BLOCK.ACTIVE_DPI_STAGE);
    results.push(await this.writeSetting(V8_BLOCK.DPI_STAGE_COUNT, scalarBytes(live.length)));
    // Mirror the Hub: select each stage before writing its register + colour.
    for (let i = 0; i < live.length; i++) {
      const s = live[i]!;
      await this.writeSetting(V8_BLOCK.ACTIVE_DPI_STAGE, scalarBytes(i));
      results.push(
        await this.writeSetting(
          V8_BLOCK.DPI_STAGE_REG + i * V8_BLOCK.DPI_STAGE_REG_STRIDE,
          dpiRegBytes(s.dpi, step),
        ),
      );
      results.push(
        await this.writeSetting(
          V8_BLOCK.DPI_STAGE_COLOR + i * V8_BLOCK.DPI_STAGE_COLOR_STRIDE,
          rgbBytes(s.color[0], s.color[1], s.color[2]),
        ),
      );
    }
    // Always restore, never conditionally: the loop leaves the device selecting
    // the *last* slot, so skipping this is the bug. An unreadable `restore`, or
    // one that pointed at a stage this write just removed, clamps into range.
    results.push(
      await this.writeSetting(
        V8_BLOCK.ACTIVE_DPI_STAGE,
        scalarBytes(clampActiveDpiStage(restore, live.length)),
      ),
    );
    return worst(results);
  }

  override async setActiveDpiStage(i: number): Promise<WriteResult> {
    // Only slots below DPI_STAGE_COUNT are stages the mouse cycles — selecting
    // anything past it is how a removed/disabled stage got applied.
    const count = (await this.readScalar(V8_BLOCK.DPI_STAGE_COUNT)) || this.d.spec.dpi?.stages || 6;
    return this.writeSetting(V8_BLOCK.ACTIVE_DPI_STAGE, scalarBytes(clampActiveDpiStage(i, count)));
  }

  override async readActiveDpiStage(): Promise<number | null> {
    const v = await this.readScalar(V8_BLOCK.ACTIVE_DPI_STAGE);
    if (v === null) return null;
    // Clamped against the live stage count so a stale byte can never render as
    // a selection on a stage the list no longer has.
    const count = (await this.readScalar(V8_BLOCK.DPI_STAGE_COUNT)) || this.d.spec.dpi?.stages || 6;
    return clampActiveDpiStage(v, count);
  }

  /**
   * The cheap live probe (see `Driver.readLiveState`).
   *
   * Poll rate (0x00), DPI stage count (0x02) and active DPI stage (0x04) all
   * sit inside the first ten bytes of region A, so ONE `readBlockRaw` — a
   * single 17-byte request — answers all three. Going through `regionA()`
   * instead would cost the full 22-frame sweep, which is far too much to run
   * on a cadence.
   *
   * It deliberately neither reads, populates nor invalidates
   * `regionASnapshot`: a poll must never be able to serve a stale cache to a
   * real read, nor extend one past its TTL.
   */
  override async readLiveState(): Promise<LiveState | null> {
    // The dongle answers `0x03` even with the mouse powered off (see `ping`),
    // so `online` is not enough. Polling a dozing mouse costs three attempts
    // times the read timeout, per read, and blocks the scan chain for that
    // long — this bail-out is load-bearing, not an optimisation.
    if (this.lastAwake === false) return null;
    const b = await this.readBlockRaw(0x00, 10);
    if (!b) return null;
    const max = this.d.spec.dpi?.stages ?? 6;
    const count = Math.min(Math.max(b[V8_BLOCK.DPI_STAGE_COUNT] ?? max, 1), max);
    return {
      activeDpiStage: clampActiveDpiStage(b[V8_BLOCK.ACTIVE_DPI_STAGE] ?? null, count),
      dpiStageCount: count,
      pollRate: pollRateFromWire(b[V8_BLOCK.POLL_RATE] ?? 0),
    };
  }

  // — polling rate --------------------------------------------
  override async readPollRate(): Promise<number | null> {
    const v = await this.readScalar(V8_BLOCK.POLL_RATE);
    return v === null ? null : pollRateFromWire(v);
  }

  override async setPollRate(hz: number): Promise<WriteResult> {
    return this.writeSetting(V8_BLOCK.POLL_RATE, scalarBytes(pollRateToWire(hz)));
  }

  // — sensor (each toggle its own offset; long-range is command 0x16) —
  override async readSensor(): Promise<SensorSettings | null> {
    const motion = await this.readScalar(V8_BLOCK.MOTION_SYNC);
    if (motion === null) return null;
    const [angleSnap, ripple, highFps, lod, mode, angleWire] = await Promise.all([
      this.readScalar(V8_BLOCK.ANGLE_SNAP),
      this.readScalar(V8_BLOCK.RIPPLE),
      this.readScalar(V8_BLOCK.HIGH_FPS),
      this.readScalar(V8_BLOCK.LOD),
      this.readScalar(V8_BLOCK.SENSOR_MODE),
      this.readScalar(V8_BLOCK.ANGLE_DEGREES),
    ]);
    const longReply = await this.ch.request(
      this.frame(V8_CMD.LONG_RANGE, [0x00, 0x00, 0x00, 0x0a]),
      V8_CMD.LONG_RANGE,
      2,
      6,
    );
    // angleMode is DERIVED, not its own bit — the vendor Hub has no toggle
    // for it, only a slider, and "off" just means 0°.
    const angleDegrees = angleWire === null ? undefined : angleFromWire(angleWire);
    return {
      motionSync: !!motion,
      angleSnapping: !!angleSnap,
      rippleControl: !!ripple,
      highFpsScan: !!highFps,
      longDistanceMode: longReply ? (longReply[6] ?? 0) > 0 : undefined,
      sensorMode: mode ?? undefined,
      lod: lod ?? undefined,
      angleDegrees,
      angleMode: angleDegrees !== undefined ? angleDegrees !== 0 : undefined,
    };
  }

  override async setSensor(s: SensorSettings): Promise<WriteResult> {
    const results: WriteResult[] = [];
    if (s.motionSync !== undefined)
      results.push(
        await this.writeSetting(V8_BLOCK.MOTION_SYNC, scalarBytes(s.motionSync ? 1 : 0)),
      );
    if (s.angleSnapping !== undefined)
      results.push(
        await this.writeSetting(V8_BLOCK.ANGLE_SNAP, scalarBytes(s.angleSnapping ? 1 : 0)),
      );
    if (s.rippleControl !== undefined)
      results.push(await this.writeSetting(V8_BLOCK.RIPPLE, scalarBytes(s.rippleControl ? 1 : 0)));
    if (s.highFpsScan !== undefined)
      results.push(await this.writeSetting(V8_BLOCK.HIGH_FPS, scalarBytes(s.highFpsScan ? 1 : 0)));
    if (s.sensorMode !== undefined)
      results.push(await this.writeSetting(V8_BLOCK.SENSOR_MODE, scalarBytes(s.sensorMode & 0xff)));
    if (s.lod !== undefined)
      results.push(await this.writeSetting(V8_BLOCK.LOD, scalarBytes(s.lod & 0xff)));
    // An ordinary verified scalar now that 0xBD is the confirmed offset, so it
    // goes into `worst()` with the rest: a refused angle write is a real
    // failure to report, not a caveat to footnote.
    if (s.angleDegrees !== undefined) {
      results.push(
        await this.writeSetting(V8_BLOCK.ANGLE_DEGREES, scalarBytes(angleToWire(s.angleDegrees))),
      );
    }
    if (s.longDistanceMode !== undefined) {
      // dedicated command 0x16, mirrors the vendor CS_UsbFinder_SetLongRangeMode
      const f = this.frame(V8_CMD.LONG_RANGE, [0x00, 0x00, 0x00, 0x0a, s.longDistanceMode ? 1 : 0]);
      try {
        await this.ch.write(f);
        results.push({ ok: true, verified: 'unverified', frames: [toHex(f)] });
      } catch (e) {
        results.push({ ok: false, verified: 'unverified', error: String(e), frames: [toHex(f)] });
      }
    }
    return results.length ? worst(results) : { ok: true, verified: 'unverified' };
  }

  // — key-response-time (debounce) ---------------------------
  override async readDebounce(): Promise<number | null> {
    return this.readScalar(V8_BLOCK.DEBOUNCE);
  }

  override async setDebounce(ms: number): Promise<WriteResult> {
    return this.writeSetting(
      V8_BLOCK.DEBOUNCE,
      scalarBytes(Math.max(0, Math.min(255, Math.round(ms)))),
    );
  }

  // — power / sleep timer (1 byte = idle seconds / 10) ------
  override async readPower(): Promise<PowerSettings | null> {
    const v = await this.readScalar(V8_BLOCK.SLEEP);
    if (v === null) return null;
    const range = this.d.spec.sleepTimerRange;
    const sec = v <= 0 ? 0 : Math.min(sleepWireToSec(v), range?.max ?? 900);
    return { sleepTimerSec: sec, never: sec === 0 };
  }

  override async setPower(p: PowerSettings): Promise<WriteResult> {
    const wire = p.never || p.sleepTimerSec <= 0 ? 0 : sleepSecToWire(p.sleepTimerSec);
    return this.writeSetting(V8_BLOCK.SLEEP, scalarBytes(wire));
  }

  // — buttons ---------------------------------------------
  override async readButtons(): Promise<Record<number, ButtonMapping> | null> {
    const count = this.d.spec.buttons ?? 6;
    const out: Record<number, ButtonMapping> = {};
    let any = false;
    for (let i = 0; i < count; i++) {
      const b = await this.fieldBytes(v8ButtonOffset(i), 3);
      if (!b) continue;
      any = true;
      const action = b[0] ?? 1;
      const key = actionKeyFromWire(action);
      const m: ButtonMapping = { actionKey: key, action, param: b[1] || undefined };
      if (key === 'firepower') m.fire = { interval: b[1] ?? 10, times: b[2] ?? 0 };
      else if (key === 'macro') {
        m.macroSlot = b[1] ?? 0;
        m.macroRepeat = b[2] ?? 0xfe;
      } else if (BUTTON_ACTION_BY_KEY[key]?.children && b[1]) {
        // reconstruct the vendor child value from its high byte
        m.param = (b[1] << 8) | (b[2] ?? 0);
      }
      out[i] = m;
    }
    return any ? out : null;
  }

  override async setButton(button: number, action: string): Promise<WriteResult> {
    const wire = /^\d+$/.test(action) ? parseInt(action, 10) & 0xff : 1;
    return this.setButtonMapping(button, { actionKey: actionKeyFromWire(wire), action: wire });
  }

  override async setButtonMapping(button: number, m: ButtonMapping): Promise<WriteResult> {
    const [action, p1, p2] = encodeButtonRegionA(m);
    const results: WriteResult[] = [
      await this.writeSetting(v8ButtonOffset(button), [action, p1, p2, companion(action, p1, p2)]),
    ];
    const def = BUTTON_ACTION_BY_KEY[m.actionKey];
    if (def?.combo || def?.multimedia) {
      // region-B record: [count, (flag, usage & 0xff, 0x00) × count, companion]
      // flag = (down?0x80:0x40) | page (1 keyboard / 2 consumer)
      const steps: { flag: number; usage: number }[] = [];
      if (def.multimedia && m.multimedia) {
        steps.push({ flag: 0x80 | 0x02, usage: m.multimedia });
        steps.push({ flag: 0x40 | 0x02, usage: m.multimedia });
      }
      for (const k of m.combo ?? []) steps.push({ flag: 0x80 | 0x01, usage: k });
      for (const k of [...(m.combo ?? [])].reverse()) steps.push({ flag: 0x40 | 0x01, usage: k });
      const rec: number[] = [steps.length & 0xff];
      for (const s of steps) rec.push(s.flag & 0xff, s.usage & 0xff, 0x00);
      rec.push(companion(...rec));
      results.push(await this.writeSetting(v8ButtonExtOffset(button), rec));
    } else {
      // non-extended action: clear the region-B record the vendor way
      results.push(await this.writeSetting(v8ButtonExtOffset(button), [0x00, 0xff]));
    }
    return worst(results);
  }

  // — DPI-indicator LED (effect + brightness/speed; brightness wire 0..255) —
  override async readDpiLed(): Promise<DpiLedSettings | null> {
    const eff = await this.readScalar(V8_BLOCK.DPI_LED_EFFECT);
    if (eff === null) return null;
    const brt = await this.readScalar(V8_BLOCK.DPI_LED_BRIGHT);
    const spd = await this.readScalar(V8_BLOCK.DPI_LED_SPEED);
    // Read the 0x52 flag and pass it up RAW. It is deliberately not allowed to
    // override `effect`: it reads 0 alongside a non-zero effect byte in every
    // factory profile, so "flag 0 means off" would misreport a brand-new V8.
    // See DpiLedSettings.flagRaw.
    const flag = await this.readScalar(V8_BLOCK.DPI_LED_FLAG);
    return {
      effect: eff,
      brightness: brt === null ? 100 : dpiLedBrightFromWire(brt),
      speed: spd === null ? undefined : dpiLedSpeedFromWire(spd),
      flagRaw: flag ?? undefined,
    };
  }

  override async setDpiLed(l: DpiLedSettings): Promise<WriteResult> {
    // 0x4C (effect) and 0x4E (brightness) are `verified-capture` — proven by
    // the pre/post image diff. They alone decide the reported verdict.
    const r1 = await this.writeSetting(V8_BLOCK.DPI_LED_EFFECT, scalarBytes(l.effect & 0xff));
    const r2 = await this.writeSetting(
      V8_BLOCK.DPI_LED_BRIGHT,
      scalarBytes(dpiLedBrightToWire(l.brightness)),
    );

    // 0x52 is NOT a confirmed on/off gate, despite the shape suggesting one.
    // Every factory profile in v8-preimage.json reads 0x52 = 00 while 0x4C
    // reads 02 (breathing), and the Hub wrote `01` there exactly once — in
    // 05_dpi_effect_steady — after which v8-postimage.json shows 0x52 back at
    // 00 while the effect/brightness writes beside it did survive. So it is
    // either a gate that happened to be off or a byte that does not stick.
    //
    // Mirroring the Hub is still the best available guess, so keep writing it
    // — but speculatively, and with NO user-facing caveat: this is an internal
    // mirror of vendor behaviour, not a setting anyone asked for, so a miss is
    // not something to interrupt them about. It shows in the frame log.
    // See FINDINGS.md "Still open" #9.
    await this.writeSpeculative(V8_BLOCK.DPI_LED_FLAG, scalarBytes(l.effect ? 1 : 0), '');

    const notes: string[] = [];
    if (l.speed !== undefined) {
      // INFERRED offset (V8_BLOCK.DPI_LED_SPEED) — see its comment. Only
      // meaningful for the breathing effect, but the driver writes whatever
      // it's given; the UI is what gates when the control is shown. Unlike the
      // flag above this IS something the user set, so a miss earns one note.
      const speed = await this.writeSpeculative(
        V8_BLOCK.DPI_LED_SPEED,
        scalarBytes(dpiLedSpeedToWire(l.speed)),
        "this mouse's firmware did not accept the breathing speed",
      );
      if (speed.note) notes.push(speed.note);
    }
    const res = worst([r1, r2]);
    return notes.length ? { ...res, note: notes.join('; ') } : res;
  }

  // — receiver status LEDs: 0x2C sets all three, 0x2D reads them back ------
  /**
   * Decode a reply as an LED triple, or null if it isn't one.
   *
   * Both candidate commands can answer with the generic ACK shape FINDINGS
   * documents for unclaimed commands (`08 XX 01 00 00 00`, byte 2 = 0x01,
   * declared length 0) — which is precisely what the old zero-length 0x2C
   * probe was accepting nothing from. Require: not that shape, at least three
   * declared bytes, and three values the LEDs can actually hold.
   */
  private static rxTriple(reply: Uint8Array | null): [number, number, number] | null {
    if (!reply || reply.length < 9) return null;
    if ((reply[2] ?? 0) === 0x01) return null;
    if ((reply[5] ?? 0) < RX_LED_COUNT) return null;
    const t: [number, number, number] = [reply[6] ?? 0, reply[7] ?? 0, reply[8] ?? 0];
    return t.every((v) => RX_LED_VALUES.has(v)) ? t : null;
  }

  /** The two read shapes worth trying, best first. Shared by the read and the
   *  post-write verification so they can never disagree about what a valid
   *  answer looks like. */
  private async rxLedRead(io?: {
    request: HidChannel['request'];
  }): Promise<[number, number, number] | null> {
    const ch = io ?? this.ch;
    // 0x2D — answers a cold probe with the live triple; see V8_CMD.RX_LED_GET.
    const get = await ch.request(
      this.frame(V8_CMD.RX_LED_GET, [0x00, 0x00, 0x00, 0x00]),
      V8_CMD.RX_LED_GET,
      2,
      6,
    );
    const viaGet = CompxMouse8K.rxTriple(get);
    if (viaGet) return viaGet;
    // 0x2C with the len-0x0a read shape the capture's own replies used. The
    // old probe sent len 0 here, which only ever drew the generic ACK.
    const echo = await ch.request(
      this.frame(V8_CMD.RX_LED, [0x00, 0x00, 0x00, 0x0a]),
      V8_CMD.RX_LED,
      2,
      6,
    );
    return CompxMouse8K.rxTriple(echo);
  }

  override async readReceiverLed(): Promise<ReceiverLedSettings> {
    const live = await this.rxLedRead();
    if (live) {
      this.lastRxLed = { indications: live, source: 'device' };
      return this.lastRxLed;
    }
    // Fall back to the last value this process wrote, then to the persisted
    // one from a previous run (see main/devices/deviceState.ts).
    if (this.lastRxLed) return { ...this.lastRxLed, source: 'lastWrite' };
    const cached = (await this.state?.get('receiverLed')) as ReceiverLedSettings | undefined;
    if (cached?.indications) {
      this.lastRxLed = { indications: cached.indications, source: 'cache' };
      return { ...this.lastRxLed, source: 'cache' };
    }
    // Never `null`. A null here is what `useDeviceData` registers as a read
    // FAILURE, and this is not one — the receiver answered, it just has no
    // confirmed read on this firmware. `unreadable` says exactly that, and the
    // pane shows placeholders labelled as placeholders rather than a banner
    // claiming the device didn't respond.
    return { indications: [0, 0, 0], source: 'unreadable' };
  }

  private lastRxLed: ReceiverLedSettings | null = null;

  override async setReceiverLed(l: ReceiverLedValues): Promise<WriteResult> {
    const [a, b, c] = l.indications;
    const want: [number, number, number] = [a & 0xff, b & 0xff, c & 0xff];
    const f = this.frame(V8_CMD.RX_LED, [0x00, 0x00, 0x00, 0x0a, ...want]);
    try {
      // Write and read back in ONE transaction, like writeSettingRaw — this
      // path had no read-back at all before, so it always claimed success
      // whatever the hardware did.
      const back = await this.ch.transaction(async (io) => {
        await io.write(f);
        return this.rxLedRead(io);
      });
      this.lastRxLed = { indications: want, source: 'device' };
      void this.state?.set('receiverLed', { indications: want });
      const verified = back
        ? back.every((v, i) => v === want[i])
          ? 'match'
          : 'mismatch'
        : 'unverified';
      if (verified === 'mismatch')
        this.warn('Receiver LED: the receiver read back a different indication set.');
      return { ok: true, verified, frames: [toHex(f)] };
    } catch (e) {
      return { ok: false, verified: 'unverified', error: String(e), frames: [toHex(f)] };
    }
  }

  // — pairing (command 0x05 verified; completion is probed, not polled) ---
  override async startPairing(): Promise<WriteResult> {
    const f = this.frame(V8_CMD.PAIR_ENTER, [0x00, 0x00, 0x00, 0x02, 0x00, 0x00, 0x7c]);
    try {
      await this.ch.write(f);
      return { ok: true, verified: 'unverified', frames: [toHex(f)] };
    } catch (e) {
      return { ok: false, verified: 'unverified', error: String(e), frames: [toHex(f)] };
    }
  }

  /**
   * Is the mouse on the air right now?
   *
   * NOT `V8_CMD.PAIR_STATUS` (`0x06`). The Hub polls that command ~1 Hz while
   * its pair tool is open, but this receiver never answers it: the capture has
   * 17 `0x06` writes and zero replies (`v8-analysis.txt` PAIR_STATUS summary),
   * so `request()` burnt its whole read budget and returned `null` on every
   * poll — the old caller then fell back to `LiveDevice.online`, which for a
   * dongle-attached mouse only means "the receiver is plugged in" (see
   * `ping()` above) and reported a pairing complete the moment it was started.
   *
   * Two signals that can actually express the link, both from the capture:
   *
   * - `0x03` byte 6 is the mouse's RF-active bit — the `11_*` offline steps
   *   show it drop `01 -> 00` when the mouse is powered off while the dongle
   *   keeps answering. `inferred` for the unpaired case specifically: the
   *   capture proved powered-off, not unpaired.
   * - `0x04` battery goes silent while the link is down and starts answering
   *   again the instant it returns (replies resume mid-`09_pair_start`). A
   *   battery reading can only come from the mouse, so it corroborates the
   *   bit above rather than trusting it alone — which is what keeps a
   *   held-high status byte from reporting a link that isn't there.
   *
   * `null` = the receiver itself is silent, which is no evidence either way.
   */
  override async getPairingStatus(): Promise<PairingStatus | null> {
    const status = await this.ch.request(this.frame(V8_CMD.STATUS), V8_CMD.STATUS, 3, 6);
    if (!status || status.length < 7) return null;
    const awake = (status[6] ?? 0) > 0;
    this.lastAwake = awake;
    if (!awake) return { linked: false };
    const bat = await this.getBattery();
    return { linked: bat.millivolts !== null };
  }

  // — macros (region C, 16 slots of 0x180 — layout inferred) -------
  override async readMacros(): Promise<Macro[]> {
    const out: Macro[] = [];
    for (let slot = 0; slot < V8_MACRO_SLOTS; slot++) {
      const buf = await this.readBlock(
        v8MacroOffset(slot),
        Math.min(MOUSE_MACRO_MAX_BYTES, V8_MACRO_STRIDE),
      );
      if (!buf) continue;
      if (buf.every((b) => b === 0x00 || b === 0xff)) continue; // empty slot
      const m = decodeMouseMacro(`onboard-${slot}`, buf);
      if (m) out.push(m);
    }
    return out;
  }

  override async saveMacro(m: Macro): Promise<WriteResult> {
    // pick the slot the macro already occupies, else the first empty one
    let target = -1;
    for (let slot = 0; slot < V8_MACRO_SLOTS; slot++) {
      const buf = await this.readBlock(v8MacroOffset(slot), 16);
      if (!buf) continue;
      if (buf.every((b) => b === 0x00 || b === 0xff)) {
        if (target < 0) target = slot;
      } else if (m.id === `onboard-${slot}`) {
        target = slot;
        break;
      }
    }
    if (target < 0)
      return { ok: false, verified: 'unverified', error: 'No free onboard macro slot' };
    const bytes = encodeMouseMacro(m);
    return this.writeSetting(v8MacroOffset(target), bytes);
  }

  override async deleteMacro(id: string): Promise<WriteResult> {
    const mm = /^onboard-(\d+)$/.exec(id);
    if (!mm) return { ok: false, verified: 'unverified', error: 'Not an onboard macro' };
    const slot = Number(mm[1]);
    // `writeSetting` masks the offset to 16 bits, so an out-of-range slot would
    // wrap and zero 16 bytes at an arbitrary device address.
    if (!Number.isInteger(slot) || slot < 0 || slot >= V8_MACRO_SLOTS) {
      return { ok: false, verified: 'unverified', error: `macro slot out of range: ${slot}` };
    }
    return this.writeSetting(v8MacroOffset(slot), new Array(16).fill(0));
  }

  // — restore factory defaults (command 0x09, zero args) ----------
  override async restoreDefaults(): Promise<WriteResult> {
    const f = this.frame(V8_CMD.RESTORE, [0x00, 0x00, 0x00, 0x00]);
    try {
      await this.ch.write(f);
      await new Promise((r) => setTimeout(r, 300));
      this.invalidateSnapshot();
      return { ok: true, verified: 'unverified', frames: [toHex(f)] };
    } catch (e) {
      return { ok: false, verified: 'unverified', error: String(e), frames: [toHex(f)] };
    }
  }

  // — backup / restore ------------------------------------
  protected override backupCommands(): number[] {
    return [];
  }

  override async backup(): Promise<Record<string, string>> {
    const out: Record<string, string> = { schema: '2' };
    const slots = this.d.spec.profileCount ?? 4;
    const savedSlot = this.currentSlot;
    for (let s = 1; s <= slots; s++) {
      const switched = await this.setActiveProfile(s);
      if (!switched.ok) continue;
      const block = await this.readBlock(0, V8_PROFILE_DUMP_LEN);
      if (block) out[`profile${s}`] = toHex(block);
    }
    if (savedSlot >= 1) await this.setActiveProfile(savedSlot);
    const rx = await this.readReceiverLed();
    // Store the values only — a backup replayed later must not carry a
    // provenance marker from the moment it was taken.
    if (rx.source !== 'unreadable')
      out['receiverLed'] = JSON.stringify({ indications: rx.indications });
    out['firmware'] = JSON.stringify(await this.getFirmware());
    return out;
  }

  override async restoreFromBackup(blocks: Record<string, string>): Promise<WriteResult> {
    const results: WriteResult[] = [];
    const savedSlot = this.currentSlot;
    const schema = Number(blocks['schema'] ?? '1');
    for (const [name, value] of Object.entries(blocks)) {
      const pm = /^profile(\d+)$/.exec(name);
      if (pm) {
        // schema 1 dumps were only 0x60 long and the write command was wrong —
        // replaying them via 0x07 is safe (same read-back diff) but incomplete.
        const bytes = parseHexBytes(value);
        // A truncated / hand-edited backup used to yield NaN entries here,
        // which Uint8Array coerces to 0 — silently zeroing the onboard profile
        // block. Refuse anything that isn't a run of valid bytes no longer
        // than one region-A dump.
        if (!bytes || bytes.length === 0 || bytes.length > V8_PROFILE_DUMP_LEN) {
          results.push({
            ok: false,
            verified: 'unverified',
            error: `backup block "${name}" is malformed`,
          });
          continue;
        }
        const switched = await this.setActiveProfile(Number(pm[1]));
        if (switched.ok) results.push(await this.writeSetting(0, bytes));
      } else if (name === 'receiverLed' && schema >= 2) {
        try {
          results.push(await this.setReceiverLed(JSON.parse(value)));
        } catch {
          /* ignore malformed */
        }
      }
      // schema-1 `receiver` (a raw 0x0300 hex block) is deliberately NOT replayed.
    }
    if (savedSlot >= 1) await this.setActiveProfile(savedSlot);
    if (results.length === 0) return this.notSupported('Backup restore');
    return worst(results);
  }
}

/** Parse a whitespace-separated hex-byte string, or null if any token is not a
 *  valid 0..255 byte (a corrupt/truncated backup). */
function parseHexBytes(value: string): number[] | null {
  const tokens = value.trim().split(/\s+/).filter(Boolean);
  const out: number[] = [];
  for (const tok of tokens) {
    if (!/^[0-9a-fA-F]{1,2}$/.test(tok)) return null;
    out.push(parseInt(tok, 16));
  }
  return out;
}

function worst(results: WriteResult[]): WriteResult {
  if (results.length === 0) return { ok: true, verified: 'unverified' };
  if (results.some((r) => !r.ok)) return results.find((r) => !r.ok)!;
  if (results.some((r) => r.verified === 'mismatch'))
    return { ...results[0]!, verified: 'mismatch' };
  if (results.every((r) => r.verified === 'match')) return { ...results[0]!, verified: 'match' };
  return { ...results[0]!, verified: 'unverified' };
}
