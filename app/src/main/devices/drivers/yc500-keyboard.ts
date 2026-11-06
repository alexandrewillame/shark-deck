import type { KeyBinding } from '@shared/types/keys';
import type { LightingSettings, SideLightingSettings } from '@shared/types/lighting';
import type { FirmwareInfo, WriteResult } from '@shared/types/live';
import type { PowerSettings } from '@shared/types/mouse-settings';
import {
  KB_LIGHT_EFFECTS,
  KB_LIGHT_EFFECTS_TABLE,
  currentEffectLabel,
  sideEffectName,
  sideEffectWire,
} from '@shared/lighting';
import { toHex } from '../../hid/frame';
import { Driver, delay, fmtVersion, type BackupPolicy } from './base';
import { decodeQuad, isEchoOf, kbWorst, quadFor } from './compx-keyboard';

/**
 * The older ROYUAN keyboards — the YC3121 lineage the vendor's registry calls
 * `yc500`: K75RGB, K85 (1466), K86 (1168), X85 PRO (1724), X86 (1967),
 * X98 PRO (1996), X65 HE (1025).
 *
 * Same transport as gen2 (the R85HE's): 64-byte feature report 0 on usage
 * page 0xFFFF, the `compx-fea` checksum at byte 8 (9 for 0x07/0x08). A
 * DIFFERENT opcode table, and the collisions are destructive: gen2's debounce
 * write (0x06) is this family's options register, gen2's options (0x09) is
 * its whole-layer keymap upload to flash, gen2's single Fn-key write (0x10)
 * its whole Fn-layer upload. So this class extends the bare `Driver`, not
 * CompxKeyboard: a method it does not implement keeps the base class's
 * "not supported" answer and sends nothing, instead of inheriting a gen2
 * frame. Every opcode it can send is in YC_CMD, and yc500-keyboard.test.ts
 * proves no other byte leaves it.
 *
 * Deliberately not here: report rate (the family has none), the options
 * register (its bits are known, but no menu maps onto them yet), macros,
 * per-key colours (each upload writes flash, and the read-back is stale), the
 * magnetic pages of the K85 1466 (different units and slot count — the
 * builder gives that board no actuation menu), and every flash-writing
 * whole-layer upload (YC_NEVER).
 *
 * provenance: ported-from-vendor for the opcode table and byte layouts, as
 * sharkfin's protocol notes document them (GPL-3.0-or-later; facts, not code
 * — see THIRD-PARTY-NOTICES.md) and dnim.dev's write-up. No yc500 board has
 * been on our hardware, so in practice every frame here is `inferred`;
 * every write is read back, and a backup is taken before the first one.
 */

/** Indexes are the opcode (frame byte 1); arguments start at byte 2. */
export const YC_CMD = {
  RESET: 0x02,
  SET_PROFILE: 0x05,
  SET_LEDPARAM: 0x07,
  SET_SLEDPARAM: 0x08,
  SET_DEBOUNCE: 0x11,
  SET_SLEEPTIME: 0x12,
  /** one base-layer slot — [profile, slot], the quad at frame bytes 9..12 */
  SET_KEY: 0x13,
  /** one Fn-layer slot, same shape */
  SET_FN_KEY: 0x15,
  GET_REVISION: 0x80,
  GET_PROFILE: 0x85,
  GET_LEDPARAM: 0x87,
  GET_SLEDPARAM: 0x88,
  /** a raw 64-byte keymap page — [profile, page 0..7], no echo */
  GET_KEYMATRIX: 0x89,
  GET_USB_VERSION: 0x8f,
  /** a raw 64-byte Fn page — [profile, page 0..7], no echo */
  GET_FN: 0x90,
  GET_DEBOUNCE: 0x91,
  GET_SLEEPTIME: 0x92,
} as const;

/**
 * Never sent, by this driver or as a probe: 0xAC erases the flash chip (about
 * a minute), 0x2C the display, 0x7F / 0x30 enter the bootloaders, and 0x09 /
 * 0x10 / 0x1A rewrite whole layers or the magnetic record in flash. 0xAC sits
 * in the 0x80+ "GET" range, which is why no GET is ever guessed at.
 */
export const YC_NEVER: readonly number[] = [0xac, 0x2c, 0x7f, 0x30, 0x09, 0x10, 0x1a];

const PAGES = 8;
const SLOTS_PER_PAGE = 16;
const SLOT_BYTES = 4;
/** Raw page replies carry no echo: 64 data bytes from frame byte 1. */
const PAGE_REPLY_OFFSET = 1;
/** "A reply is ready about 100 ms after sending" — tries at growing settle. */
const REPLY_SETTLE_MS = [40, 60, 100, 150, 250];
/** "the next packet is accepted about 70 ms after a write" */
const WRITE_GAP_MS = 80;
/** The family's main-zone speed runs 5 (slowest) .. 1 (fastest) on the wire. */
const LED_SPEED_MAX = 5;
const LED_LEVELS = 4;
/** sharkfin treats only these sleep times as real values. */
const SLEEP_MIN_S = 30;
const SLEEP_MAX_S = 36000;

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));
const step = (ui: number) => clamp(Math.round((ui / 100) * LED_LEVELS), 0, LED_LEVELS);
const ui = (s: number) => clamp(Math.round((s / LED_LEVELS) * 100), 0, 100);

/**
 * White goes out as FAFAFA, and a colour too dark to light (every channel
 * under 8) as 080808 — the family shows anything below that as unlit.
 */
function wireRgb(c: [number, number, number]): [number, number, number] {
  if (c[0] === 255 && c[1] === 255 && c[2] === 255) return [0xfa, 0xfa, 0xfa];
  if (c.every((v) => v < 8)) return [8, 8, 8];
  return [c[0] & 0xff, c[1] & 0xff, c[2] & 0xff];
}
const fromWireRgb = (r: number, g: number, b: number): [number, number, number] =>
  r === 0xfa && g === 0xfa && b === 0xfa ? [255, 255, 255] : [r, g, b];

const le16 = (v: number) => [v & 0xff, (v >> 8) & 0xff];

export class Yc500Keyboard extends Driver {
  protected readonly settleMs = WRITE_GAP_MS;

  /**
   * The profile byte. A magnetic yc500 board (the K85 1466) counts profiles
   * in fours — profile * 4 + sublayer — on the profile, keymap and key
   * commands alike (`spec.profileByteStride`).
   */
  private profileByte(slot1: number): number {
    return ((slot1 - 1) * (this.d.spec.profileByteStride ?? 1)) & 0xff;
  }

  /** The active profile's byte, for keymap reads and writes; profile 1 if unread. */
  private async activeProfileByte(): Promise<number> {
    return this.profileByte((await this.getActiveProfile()) ?? 1);
  }

  /**
   * One GET with this family's timing: written once, then read at growing
   * settle until an answer to THIS opcode arrives (Windows hands back our own
   * buffer when nothing has been answered yet).
   */
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

  /** One raw page (keymap / Fn): no echo to match, so only an echo of our own query is refused. */
  private async page(cmd: number, profile: number, page: number): Promise<number[] | null> {
    const query = this.frame(cmd, [profile, page]);
    return this.ch.transaction(async (io) => {
      await io.write(query);
      for (const ms of REPLY_SETTLE_MS) {
        await delay(ms);
        const r = await io.read(250, this.d.reportLength);
        if (r && r.length > PAGE_REPLY_OFFSET && !isEchoOf(r, query)) {
          return Array.from(r.subarray(PAGE_REPLY_OFFSET, PAGE_REPLY_OFFSET + 64));
        }
      }
      return null;
    });
  }

  /**
   * A SET, then a GET of the same setting compared against what was sent.
   * `verified: 'match'` only when the board reads back what it was given.
   */
  private async set(
    cmd: number,
    args: number[],
    check: { get: number; getArgs?: number[]; compare: (r: Uint8Array) => boolean },
  ): Promise<WriteResult> {
    const tx = this.frame(cmd, args);
    const frames = [toHex(tx)];
    try {
      await this.ch.write(tx);
    } catch (e) {
      return { ok: false, verified: 'unverified', error: String(e), frames };
    }
    await delay(WRITE_GAP_MS);
    const back = await this.get(check.get, check.getArgs);
    if (!back) return { ok: true, verified: 'unverified', frames };
    frames.push(toHex(back));
    const match = check.compare(back);
    if (!match) this.warn(`Setting 0x${cmd.toString(16)} did not read back as written.`);
    return { ok: true, verified: match ? 'match' : 'mismatch', frames };
  }

  // — identity and liveness -------------------------------------------------

  override async getFirmware(): Promise<FirmwareInfo> {
    // revision = (b2 << 8) | b1, i.e. frame bytes 3 and 2
    const r = await this.get(YC_CMD.GET_REVISION);
    if (!r) return { device: null, receiver: null, readState: 'noReply' };
    return {
      device: fmtVersion(((r[3] ?? 0) << 8) | (r[2] ?? 0)),
      receiver: null,
      readState: 'ok',
    };
  }

  override async getActiveProfile(): Promise<number | null> {
    const r = await this.get(YC_CMD.GET_PROFILE);
    if (!r) return null;
    const stride = this.d.spec.profileByteStride ?? 1;
    return Math.floor((r[2] ?? 0) / stride) + 1;
  }

  override async setActiveProfile(slot: number): Promise<WriteResult> {
    const count = this.d.spec.profileCount ?? 1;
    if (slot < 1 || slot > count) {
      return { ok: false, verified: 'unverified', error: `profile out of range: ${slot}` };
    }
    const b = this.profileByte(slot);
    return this.set(YC_CMD.SET_PROFILE, [b], {
      get: YC_CMD.GET_PROFILE,
      compare: (r) => (r[2] ?? -1) === b,
    });
  }

  /** A board on its cable reports no battery; over the receiver, the receiver does. */
  override async getBattery(): Promise<{ level: number | null; charging: boolean }> {
    if (!this.relayed) return { level: null, charging: false };
    return { level: await this.relayBattery('keyboard'), charging: false };
  }

  // — whole-board settings ----------------------------------------------------

  /** Debounce 1..10 ms: SET [0, ms], read back at frame byte 3. */
  override async readDebounce(): Promise<number | null> {
    const r = await this.get(YC_CMD.GET_DEBOUNCE, [0]);
    return r ? (r[3] ?? null) : null;
  }

  override async setDebounce(ms: number): Promise<WriteResult> {
    const range = this.d.spec.debounceRange ?? { min: 1, max: 10 };
    const v = clamp(Math.round(ms), range.min, range.max);
    return this.set(YC_CMD.SET_DEBOUNCE, [0, v], {
      get: YC_CMD.GET_DEBOUNCE,
      getArgs: [0],
      compare: (r) => (r[3] ?? -1) === v,
    });
  }

  /**
   * Sleep: four u16 LE seconds — light sleep over Bluetooth and over 2.4 GHz,
   * then deep sleep the same way — read at frame bytes 2..9, written at 9..16.
   * The menu has one timer, so both radios are written alike and the 2.4 GHz
   * value is the one read.
   */
  override async readPower(): Promise<PowerSettings> {
    const r = await this.get(YC_CMD.GET_SLEEPTIME);
    if (!r || r.length < 10) return { sleepTimerSec: 0, never: true };
    const u16 = (i: number) => (r[i] ?? 0) | ((r[i + 1] ?? 0) << 8);
    const light = u16(4);
    const deep = u16(8);
    const real = (v: number) => (v >= SLEEP_MIN_S && v <= SLEEP_MAX_S ? v : 0);
    return {
      sleepTimerSec: real(light),
      deepSleepSec: real(deep) || undefined,
      never: real(light) === 0,
    };
  }

  override async setPower(p: PowerSettings): Promise<WriteResult> {
    // No "never" on this family: the longest real value stands in for it.
    const light = p.never
      ? SLEEP_MAX_S
      : clamp(Math.round(p.sleepTimerSec), SLEEP_MIN_S, SLEEP_MAX_S);
    const deep = clamp(Math.round(p.deepSleepSec ?? light * 2), SLEEP_MIN_S, SLEEP_MAX_S);
    const values = [...le16(light), ...le16(light), ...le16(deep), ...le16(deep)];
    return this.set(YC_CMD.SET_SLEEPTIME, [0, 0, 0, 0, 0, 0, ...values], {
      get: YC_CMD.GET_SLEEPTIME,
      compare: (r) => values.every((b, i) => r[2 + i] === b),
    });
  }

  // — lighting --------------------------------------------------------------

  /** Main zone: [mode, speed 5..1, brightness 0..4, option << 4 | colour mode, r, g, b]. */
  override async readLighting(): Promise<LightingSettings[]> {
    const r = await this.get(YC_CMD.GET_LEDPARAM);
    if (!r) return [];
    const mode = r[2] ?? 0;
    const opt = r[5] ?? 0;
    return [
      {
        zone: 'keyboard',
        effect: KB_LIGHT_EFFECTS[mode] ?? 'Always On',
        speed: ui(clamp(LED_SPEED_MAX - (r[3] ?? 3), 0, LED_LEVELS)),
        brightness: ui(clamp(r[4] ?? LED_LEVELS, 0, LED_LEVELS)),
        color: fromWireRgb(r[6] ?? 0, r[7] ?? 0, r[8] ?? 0),
        enabled: mode !== 0,
        dazzle: (opt & 0x0f) === 8,
        option: (opt >> 4) & 0x0f,
      },
    ];
  }

  override async setLighting(l: LightingSettings): Promise<WriteResult> {
    const mode = l.enabled
      ? Math.max(0, KB_LIGHT_EFFECTS.indexOf(currentEffectLabel(l.effect)))
      : 0;
    const id = KB_LIGHT_EFFECTS_TABLE[mode]?.id;
    const dir = (clamp(l.option ?? 0, 0, 15) << 4) & 0xf0;
    let option = dir | (l.dazzle ? 8 : 7);
    if (id === 'LightUserPicture') option = dir;
    else if (id === 'LightMusicFollow3' || id === 'LightMusicFollow2')
      option = dir | (l.dazzle ? 0 : 4);
    else if (id === 'LightScreenColor') option = 0;
    // Off is a zeroed frame, as on gen2: nothing else reads as "dark".
    const args =
      mode === 0
        ? [0, 0, 0, 0, 0, 0, 0]
        : [mode, LED_SPEED_MAX - step(l.speed), step(l.brightness), option, ...wireRgb(l.color)];
    return this.set(YC_CMD.SET_LEDPARAM, args, {
      get: YC_CMD.GET_LEDPARAM,
      compare: (r) => (r[2] ?? -1) === mode,
    });
  }

  /** Side strip: the same shape; its speed is not inverted. */
  override async readSideLighting(): Promise<SideLightingSettings | null> {
    const r = await this.get(YC_CMD.GET_SLEDPARAM);
    if (!r) return null;
    const mode = r[2] ?? 0;
    return {
      effect: sideEffectName(mode),
      speed: ui(clamp(r[3] ?? 2, 0, LED_LEVELS)),
      brightness: ui(clamp(r[4] ?? LED_LEVELS, 0, LED_LEVELS)),
      color: fromWireRgb(r[6] ?? 0, r[7] ?? 0, r[8] ?? 0),
      enabled: mode !== 0,
      dazzle: ((r[5] ?? 0) & 0x0f) === 8,
    };
  }

  override async setSideLighting(l: SideLightingSettings): Promise<WriteResult> {
    const mode = l.enabled ? sideEffectWire(l.effect) : 0;
    const args = [mode, step(l.speed), step(l.brightness), l.dazzle ? 8 : 7, ...wireRgb(l.color)];
    return this.set(YC_CMD.SET_SLEDPARAM, args, {
      get: YC_CMD.GET_SLEDPARAM,
      compare: (r) => (r[2] ?? -1) === mode,
    });
  }

  // — keys ------------------------------------------------------------------

  /** Eight raw pages of 16 slots x 4 bytes; a missing page fails the read. */
  private async readLayer(cmd: number, profile: number): Promise<number[] | null> {
    const bytes: number[] = [];
    for (let p = 0; p < PAGES; p++) {
      const page = await this.page(cmd, profile, p);
      if (!page) return null;
      bytes.push(...page);
    }
    return bytes;
  }

  override async readKeyBindings(layer: 'base' | 'fn'): Promise<Record<number, KeyBinding> | null> {
    const bytes = await this.readLayer(
      layer === 'base' ? YC_CMD.GET_KEYMATRIX : YC_CMD.GET_FN,
      await this.activeProfileByte(),
    );
    if (!bytes) return null;
    const out: Record<number, KeyBinding> = {};
    for (let slot = 0; (slot + 1) * SLOT_BYTES <= bytes.length; slot++) {
      const o = slot * SLOT_BYTES;
      out[slot] = decodeQuad(slot, [bytes[o]!, bytes[o + 1]!, bytes[o + 2]!, bytes[o + 3]!]);
    }
    return out;
  }

  override async readFnLayer(): Promise<Record<number, string>> {
    const fn = await this.readKeyBindings('fn');
    const out: Record<number, string> = {};
    for (const [slot, b] of Object.entries(fn ?? {})) if (b.code) out[Number(slot)] = b.code;
    return out;
  }

  /**
   * One slot: SET [profile, slot] with the quad at frame bytes 9..12, then the
   * slot's own page read back and compared — sharkfin's check, three tries.
   * Never the whole-layer upload (0x09 / 0x10), which rewrites flash.
   */
  override async setKeyRemap(
    layer: 'base' | 'fn',
    index: number,
    action: string,
  ): Promise<WriteResult> {
    const quad = quadFor(action);
    if (!quad) {
      return { ok: false, verified: 'unverified', error: `not a HID usage or quad: "${action}"` };
    }
    const slot = index & 0xff;
    if (slot >= PAGES * SLOTS_PER_PAGE) {
      return { ok: false, verified: 'unverified', error: `slot out of range: ${slot}` };
    }
    const profile = await this.activeProfileByte();
    const setCmd = layer === 'base' ? YC_CMD.SET_KEY : YC_CMD.SET_FN_KEY;
    const getCmd = layer === 'base' ? YC_CMD.GET_KEYMATRIX : YC_CMD.GET_FN;
    const tx = this.frame(setCmd, [profile, slot, 0, 0, 0, 0, ...quad]);
    const frames = [toHex(tx)];
    try {
      await this.ch.write(tx);
    } catch (e) {
      return { ok: false, verified: 'unverified', error: String(e), frames };
    }
    const at = (slot % SLOTS_PER_PAGE) * SLOT_BYTES;
    for (const ms of [WRITE_GAP_MS, 50, 150]) {
      await delay(ms);
      const page = await this.page(getCmd, profile, Math.floor(slot / SLOTS_PER_PAGE));
      if (!page) continue;
      if (quad.every((b, i) => page[at + i] === b)) return { ok: true, verified: 'match', frames };
    }
    this.warn(`Key slot ${slot} did not read back as written.`);
    return { ok: true, verified: 'mismatch', frames };
  }

  /** Factory reset (0x02 here; 0x01 is gen2's). The board takes about 4 s to come back. */
  override async restoreDefaults(): Promise<WriteResult> {
    if (this.relayed) return this.notSupported('A factory reset over the receiver (use the cable)');
    const tx = this.frame(YC_CMD.RESET);
    try {
      await this.ch.write(tx);
      await delay(4000);
      return { ok: true, verified: 'unverified', frames: [toHex(tx)] };
    } catch (e) {
      return { ok: false, verified: 'unverified', error: String(e), frames: [toHex(tx)] };
    }
  }

  // — backup ----------------------------------------------------------------

  /** The base keymap is what a restore puts back; the rest is taken when it answers. */
  override backupPolicy(): BackupPolicy {
    return { kind: 'full', required: ['keymatrix_base'] };
  }

  override async backup(): Promise<Record<string, string>> {
    const out: Record<string, string> = { schema: '1' };
    for (const layer of ['base', 'fn'] as const) {
      const b = await this.readKeyBindings(layer);
      if (b) out[`keymatrix_${layer}`] = JSON.stringify(b);
    }
    const lighting = await this.readLighting();
    if (lighting.length) out.lighting = JSON.stringify(lighting[0]);
    if (this.d.capabilities.includes('sideLighting')) {
      const side = await this.readSideLighting();
      if (side) out.sideLighting = JSON.stringify(side);
    }
    const debounce = await this.readDebounce();
    if (debounce !== null) out.debounce = String(debounce);
    if (this.d.capabilities.includes('sleepTimer'))
      out.power = JSON.stringify(await this.readPower());
    out.firmware = JSON.stringify(await this.getFirmware());
    return out;
  }

  /** Replays the key layers slot by slot, then the whole-board settings. */
  override async restoreFromBackup(blocks: Record<string, string>): Promise<WriteResult> {
    const results: WriteResult[] = [];
    const parse = <T>(k: string): T | null => {
      try {
        return blocks[k] ? (JSON.parse(blocks[k]!) as T) : null;
      } catch {
        return null;
      }
    };
    for (const layer of ['base', 'fn'] as const) {
      const table = parse<Record<string, KeyBinding>>(`keymatrix_${layer}`);
      for (const [slotStr, b] of Object.entries(table ?? {})) {
        if (b.kind !== 'key' || !b.raw) continue;
        const hex = b.raw.map((x) => x.toString(16).padStart(2, '0')).join('');
        results.push(await this.setKeyRemap(layer, Number(slotStr), hex));
      }
    }
    const lighting = parse<LightingSettings>('lighting');
    if (lighting) results.push(await this.setLighting(lighting));
    const side = parse<SideLightingSettings>('sideLighting');
    if (side) results.push(await this.setSideLighting(side));
    if (blocks.debounce) results.push(await this.setDebounce(Number(blocks.debounce)));
    const power = parse<PowerSettings>('power');
    if (power) results.push(await this.setPower(power));
    if (!results.length) return this.notSupported('Backup restore');
    return kbWorst(results);
  }
}
