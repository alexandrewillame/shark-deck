import type { FirmwareInfo, WriteResult } from '@shared/types/live';
import type { DpiStage, PowerSettings, SensorSettings } from '@shared/types/mouse-settings';
import { applicableDpiStages, clampActiveDpiStage } from '@shared/mouse-wire';
import { toHex } from '../../hid/frame';
import { Driver, delay, type BackupPolicy } from './base';
import { isEchoOf, kbWorst } from './compx-keyboard';

/**
 * GearHub-V5 mice on the ROYUAN chip (VID 0x3151): the R2 (device ids 1893,
 * 3009), the R3 (1643, 3485; 3309 / 3310 its PAW3950 revision) and the
 * X3 PRO's second revision (1660). Cable 3151:4026; the receiver 3151:402D
 * carries the mouse's packets (hid/transport.ts relay, target 0x05).
 *
 * The same 64-byte feature report and `compx-fea` checksum (byte 8) as the
 * keyboards on this chip; opcode at frame byte 1, a GET is the SET | 0x80.
 * Almost every setting lives in ONE 64-byte options block, read with 0xD3
 * and written back whole with 0x53 — "settings only take effect that way" —
 * so a write here is always read, patch the known bytes, write, read back.
 * The DPI table is its own block (0xD4 / 0x54), with X and Y per stage (Shark
 * Deck writes them equal) and an RGB indicator colour each.
 *
 * Deliberately not here: profiles (the tools that drive these mice always use
 * profile 0; switching is unverified), button remapping (slot order differs
 * between models), macros, and the factory reset (0x02) — untested on Attack
 * Shark, so never sent. Neither is any opcode on GH_NEVER.
 *
 * provenance: ported-from-vendor — the frames as OpenMouse's GearHub driver
 * (AGPL-3.0: facts only, no code) and innox2-mac (MIT) document them, with
 * an R2 (1893) read and written on hardware by an OpenMouse contributor. No
 * GearHub mouse has been on our hardware, so in practice `inferred`. Every
 * write is read back.
 */

export const GH_CMD = {
  GET_FIRMWARE: 0x80,
  GET_ID: 0x8f,
  SET_OPTIONS: 0x53,
  GET_OPTIONS: 0xd3,
  SET_DPI: 0x54,
  GET_DPI: 0xd4,
} as const;

/**
 * Never sent: factory reset (0x02), pairing (0x01, 0x61 / 0xE1), the
 * mouse-MCU and OLED bootloaders (0x40 / 0x41 / 0xC0 / 0xC1, 0x30 / 0x31),
 * factory commands (0x7A–0x7D), rapid fire (0x55), recoil (0x60 / 0xE0), and
 * the keyboard family's bootloader / erase / calibration (0x7F, 0x2C / 0xAC,
 * 0x1C / 0x1E): opcode meanings differ between families on this chip.
 */
export const GH_NEVER: readonly number[] = [
  0x02, 0x01, 0x61, 0xe1, 0x40, 0x41, 0xc0, 0xc1, 0x30, 0x31, 0x7a, 0x7b, 0x7c, 0x7d, 0x55, 0x60,
  0xe0, 0x7f, 0x2c, 0xac, 0x1c, 0x1e,
];

/** Options block, by reply index (frame byte = body byte + 1). */
const OPT = {
  /** first byte of the 56-byte block written back with 0x53 */
  BLOCK: 9,
  POLL: 10,
  DEBOUNCE: 11,
  FLAGS: 13, // u16 LE; bit 2 = ripple
  SLEEP_BT: 41, // u16 LE seconds, 0 = never
  SLEEP_24: 45,
  LOD: 53,
  ANGLE: 54,
} as const;
const RIPPLE_BIT = 0x04;

/** DPI block, by reply index. */
const DPI = { ACTIVE: 3, COUNT: 4, X: 9, Y: 25, RGB: 41, SLOTS: 8 } as const;

/** Poll-rate codes in the options block. */
export const GH_POLL: Readonly<Record<number, number>> = {
  125: 0x08,
  250: 0x04,
  500: 0x02,
  1000: 0x01,
  2000: 0x84,
  4000: 0x82,
  8000: 0x81,
};
const POLL_FROM_WIRE = Object.fromEntries(Object.entries(GH_POLL).map(([hz, w]) => [w, +hz]));

const REPLY_SETTLE_MS = [20, 40, 80, 150];
const u16 = (r: ArrayLike<number>, i: number) => (r[i] ?? 0) | ((r[i + 1] ?? 0) << 8);

export class GearHubMouse extends Driver {
  /** A GET with a growing settle; the reply must echo the opcode. */
  private async get(cmd: number, args: number[] = []): Promise<Uint8Array | null> {
    const query = this.frame(cmd, args);
    return this.ch.transaction(async (io) => {
      await io.write(query);
      for (const ms of REPLY_SETTLE_MS) {
        await delay(ms);
        const r = await io.read(250, this.d.reportLength);
        if (r && r[1] === cmd && !isEchoOf(r, query)) return r;
      }
      return null;
    });
  }

  override async ping(): Promise<boolean> {
    return (await this.get(GH_CMD.GET_FIRMWARE)) !== null;
  }

  override async getFirmware(): Promise<FirmwareInfo> {
    const r = await this.get(GH_CMD.GET_FIRMWARE);
    if (!r) return { device: null, receiver: null, readState: this.relayed ? 'asleep' : 'noReply' };
    const minor = (r[2] ?? 0).toString(16).padStart(2, '0');
    return { device: `v${(r[3] ?? 0).toString(16)}.${minor}`, receiver: null, readState: 'ok' };
  }

  override async getBattery() {
    // The mouse reports none on its cable; the receiver reports it for the mouse.
    if (!this.relayed) return { level: null, charging: false };
    return { level: await this.relayBattery('mouse'), charging: false };
  }

  // — the options block -----------------------------------------------------

  private async readOptions(): Promise<Uint8Array | null> {
    const r = await this.get(GH_CMD.GET_OPTIONS);
    return r && r.length >= 65 ? r : null;
  }

  /** Read the block, patch it, write it whole, read it back and check the patched bytes. */
  private async patchOptions(patch: (b: Uint8Array) => void): Promise<WriteResult> {
    const current = await this.readOptions();
    if (!current) {
      return { ok: false, verified: 'unverified', error: 'the mouse did not report its settings' };
    }
    const next = new Uint8Array(current);
    patch(next);
    const changed: number[] = [];
    for (let i = OPT.BLOCK; i < 65; i++) if (next[i] !== current[i]) changed.push(i);
    const tx = this.frame(GH_CMD.SET_OPTIONS, [0, 0, 0, 0, 0, 0, ...next.subarray(OPT.BLOCK, 65)]);
    const frames = [toHex(tx)];
    try {
      await this.ch.write(tx);
    } catch (e) {
      return { ok: false, verified: 'unverified', error: String(e), frames };
    }
    await delay(60);
    const back = await this.readOptions();
    if (!back) return { ok: true, verified: 'unverified', frames };
    frames.push(toHex(back));
    const match = changed.every((i) => back[i] === next[i]);
    if (!match) this.warn('The mouse did not keep every setting as written.');
    return { ok: true, verified: match ? 'match' : 'mismatch', frames };
  }

  override async readPollRate(): Promise<number | null> {
    const b = await this.readOptions();
    return b ? (POLL_FROM_WIRE[b[OPT.POLL] ?? -1] ?? null) : null;
  }

  override async setPollRate(hz: number): Promise<WriteResult> {
    const code = GH_POLL[hz];
    if (code === undefined || !(this.d.spec.pollRates ?? []).includes(hz)) {
      return { ok: false, verified: 'unverified', error: `poll rate not offered: ${hz} Hz` };
    }
    return this.patchOptions((b) => {
      b[OPT.POLL] = code;
    });
  }

  override async readDebounce(): Promise<number | null> {
    const b = await this.readOptions();
    return b ? (b[OPT.DEBOUNCE] ?? null) : null;
  }

  override async setDebounce(ms: number): Promise<WriteResult> {
    const r = this.d.spec.debounceRange ?? { min: 1, max: 10 };
    const v = Math.max(r.min, Math.min(r.max, Math.round(ms)));
    return this.patchOptions((b) => {
      b[OPT.DEBOUNCE] = v;
    });
  }

  override async readSensor(): Promise<SensorSettings | null> {
    const b = await this.readOptions();
    if (!b) return null;
    return {
      lod: b[OPT.LOD] ?? 0,
      angleSnapping: (b[OPT.ANGLE] ?? 0) === 1,
      rippleControl: (u16(b, OPT.FLAGS) & RIPPLE_BIT) !== 0,
    };
  }

  override async setSensor(s: SensorSettings): Promise<WriteResult> {
    if (s.lod !== undefined && !(this.d.spec.lodOptions ?? []).some((o) => o.wire === s.lod)) {
      return {
        ok: false,
        verified: 'unverified',
        error: `lift-off code ${s.lod} is not one this sensor has`,
      };
    }
    return this.patchOptions((b) => {
      if (s.lod !== undefined) b[OPT.LOD] = s.lod;
      if (s.angleSnapping !== undefined) b[OPT.ANGLE] = s.angleSnapping ? 1 : 0;
      if (s.rippleControl !== undefined) {
        b[OPT.FLAGS] = s.rippleControl
          ? (b[OPT.FLAGS] ?? 0) | RIPPLE_BIT
          : (b[OPT.FLAGS] ?? 0) & ~RIPPLE_BIT;
      }
    });
  }

  /** One timer in the menu: the 2.4 GHz value is read, both radios are written alike. */
  override async readPower(): Promise<PowerSettings> {
    const b = await this.readOptions();
    if (!b) return { sleepTimerSec: 0, never: true };
    const s = u16(b, OPT.SLEEP_24);
    return { sleepTimerSec: s, never: s === 0 };
  }

  override async setPower(p: PowerSettings): Promise<WriteResult> {
    const s = p.never ? 0 : Math.max(0, Math.min(0xffff, Math.round(p.sleepTimerSec)));
    return this.patchOptions((b) => {
      for (const at of [OPT.SLEEP_BT, OPT.SLEEP_24]) {
        b[at] = s & 0xff;
        b[at + 1] = (s >> 8) & 0xff;
      }
    });
  }

  // — DPI -------------------------------------------------------------------

  private async readDpiBlock(): Promise<Uint8Array | null> {
    const r = await this.get(GH_CMD.GET_DPI, [0]);
    return r && r.length >= 65 ? r : null;
  }

  override async readDpiStages(): Promise<DpiStage[] | null> {
    const b = await this.readDpiBlock();
    if (!b) return null;
    const count = Math.max(1, Math.min(DPI.SLOTS, b[DPI.COUNT] ?? 1));
    return Array.from({ length: count }, (_, i) => ({
      index: i,
      dpi: u16(b, DPI.X + 2 * i),
      color: [b[DPI.RGB + 3 * i] ?? 0, b[DPI.RGB + 3 * i + 1] ?? 0, b[DPI.RGB + 3 * i + 2] ?? 0],
      enabled: true,
    }));
  }

  override async readActiveDpiStage(): Promise<number | null> {
    const b = await this.readDpiBlock();
    return b ? (b[DPI.ACTIVE] ?? 0) : null;
  }

  /** The whole table: 8 X, 8 Y (u16 LE), 8 RGB — stages past `count` keep what they held. */
  private async writeDpiBlock(stages: DpiStage[], active: number): Promise<WriteResult> {
    const before = await this.readDpiBlock();
    const data = before ? Array.from(before.subarray(9, 65)) : new Array(56).fill(0);
    const { min, max, step } = this.d.spec.dpi ?? { min: 50, max: 42000, step: 50 };
    stages.slice(0, DPI.SLOTS).forEach((s, i) => {
      const dpi = Math.max(min, Math.min(max, Math.round(s.dpi / step) * step));
      for (const base of [DPI.X - 9, DPI.Y - 9]) {
        data[base + 2 * i] = dpi & 0xff;
        data[base + 2 * i + 1] = (dpi >> 8) & 0xff;
      }
      data.splice(DPI.RGB - 9 + 3 * i, 3, ...s.color.map((c) => c & 0xff));
    });
    const count = Math.min(DPI.SLOTS, stages.length);
    const tx = this.frame(GH_CMD.SET_DPI, [0, active, count, 0, 0, 0, ...data]);
    const frames = [toHex(tx)];
    try {
      await this.ch.write(tx);
    } catch (e) {
      return { ok: false, verified: 'unverified', error: String(e), frames };
    }
    await delay(60);
    const back = await this.readDpiBlock();
    if (!back) return { ok: true, verified: 'unverified', frames };
    frames.push(toHex(back));
    const match =
      back[DPI.COUNT] === count &&
      back[DPI.ACTIVE] === active &&
      data.slice(0, 16 + 16 + 3 * count).every((v, i) => back[9 + i] === v);
    if (!match) this.warn('The DPI table did not read back as written.');
    return { ok: true, verified: match ? 'match' : 'mismatch', frames };
  }

  override async setDpiStages(stages: DpiStage[]): Promise<WriteResult> {
    const live = applicableDpiStages(stages);
    const active = clampActiveDpiStage(await this.readActiveDpiStage(), live.length);
    return this.writeDpiBlock(live, active);
  }

  override async setActiveDpiStage(i: number): Promise<WriteResult> {
    const stages = await this.readDpiStages();
    if (!stages)
      return { ok: false, verified: 'unverified', error: 'the mouse did not report its DPI' };
    if (i < 0 || i >= stages.length) {
      return { ok: false, verified: 'unverified', error: `no DPI stage ${i + 1}` };
    }
    return this.writeDpiBlock(stages, i);
  }

  // — backup ----------------------------------------------------------------

  override backupPolicy(): BackupPolicy {
    return { kind: 'full', required: ['options', 'dpi'] };
  }

  override async backup(): Promise<Record<string, string>> {
    const out: Record<string, string> = { schema: '1' };
    const options = await this.readOptions();
    if (options) out.options = toHex(options);
    const dpi = await this.readDpiBlock();
    if (dpi) out.dpi = toHex(dpi);
    out.firmware = JSON.stringify(await this.getFirmware());
    return out;
  }

  /** Both blocks go back whole, as they were read. */
  override async restoreFromBackup(blocks: Record<string, string>): Promise<WriteResult> {
    const bytes = (k: string) => {
      const v = blocks[k]
        ?.trim()
        .split(/\s+/)
        .map((h) => parseInt(h, 16));
      return v && v.length >= 65 && v.every((n) => n >= 0 && n <= 255) ? Uint8Array.from(v) : null;
    };
    const results: WriteResult[] = [];
    const options = bytes('options');
    if (options)
      results.push(
        await this.patchOptions((b) => b.set(options.subarray(OPT.BLOCK, 65), OPT.BLOCK)),
      );
    const dpi = bytes('dpi');
    if (dpi) {
      const count = Math.max(1, Math.min(DPI.SLOTS, dpi[DPI.COUNT] ?? 1));
      const stages: DpiStage[] = Array.from({ length: count }, (_, i) => ({
        index: i,
        dpi: u16(dpi, DPI.X + 2 * i),
        color: [
          dpi[DPI.RGB + 3 * i] ?? 0,
          dpi[DPI.RGB + 3 * i + 1] ?? 0,
          dpi[DPI.RGB + 3 * i + 2] ?? 0,
        ],
        enabled: true,
      }));
      results.push(await this.writeDpiBlock(stages, Math.min(dpi[DPI.ACTIVE] ?? 0, count - 1)));
    }
    if (!results.length) return this.notSupported('Backup restore');
    return kbWorst(results);
  }
}
