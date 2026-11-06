import type { FirmwareInfo, WriteResult } from '@shared/types/live';
import type { DpiStage, PowerSettings, SensorSettings } from '@shared/types/mouse-settings';
import { applicableDpiStages, clampActiveDpiStage } from '@shared/mouse-wire';
import { fromHex, toHex } from '../../hid/frame';
import { Driver, delay, type BackupPolicy } from './base';
import { kbWorst } from './compx-keyboard';

/**
 * Attack Shark's "JXC" mice on the Compx ODM's VID 0x373E: R5 ULTRA
 * (0046 cable / 0047 receiver), R6 (0021 / 0022), R8 (003A / 003B).
 *
 * 64-byte feature report 0 on usage page 0xFFFF, usage 0 — no checksum and no
 * handshake. A request is `[status 00, 00, target, length tag, category,
 * command, profile / argument, …]` (target 02 = the mouse, on its cable and
 * through its receiver alike); a read is the command | 0x80. The reply has the
 * same header with a status in byte 0: A1 ok, A0 only the receiver answered
 * (the mouse is asleep), A2 unsupported or empty, A3 rejected.
 *
 * The firmware is fragile: in an emulator about a quarter of random packets
 * rebooted it, and an older R6 crashed on an oversized one. So every frame
 * here is built from JXC_FRAMES — exact length tags, nothing composed freely —
 * and the bootloader (category 0xB0, `02 01 00 00 B0`) and the per-profile
 * reset (`02 01 00 0D`) are never sent.
 *
 * Not here yet: lighting (modes, brightness, stage colours — the colour read
 * layout is unknown, and the DPI indicator and "hyper" reads are refused on
 * an R5, so a backup could not hold them), buttons, macros, competitive mode.
 *
 * provenance: ported-from-vendor — the frames as Dorsal (MIT) documents them,
 * read and written on a real R5 ULTRA by its author, cross-checked against
 * OpenMouse (AGPL-3.0: facts only). Never on our hardware: `inferred` in
 * practice. Every write is read back.
 */

export const JXC_TARGET = { mouse: 0x02, receiver: 0x00 } as const;
export const JXC_STATUS = { OK: 0xa1, ASLEEP: 0xa0, UNSUPPORTED: 0xa2, REJECTED: 0xa3 } as const;

/** [length tag, category, command] for every frame this driver can send. */
export const JXC_FRAMES = {
  GET_FIRMWARE: [0x10, 0x00, 0x81],
  GET_BATTERY: [0x02, 0x00, 0x83],
  GET_PROFILE: [0x01, 0x00, 0x85],
  SET_PROFILE: [0x01, 0x00, 0x05],
  GET_DEBOUNCE: [0x02, 0x00, 0x88],
  SET_DEBOUNCE: [0x02, 0x00, 0x08],
  GET_SLEEP: [0x03, 0x00, 0x87],
  SET_SLEEP: [0x03, 0x00, 0x07],
  GET_POLL: [0x02, 0x01, 0x80],
  SET_POLL: [0x02, 0x01, 0x00],
  GET_DPI: [0x0a, 0x01, 0x81],
  GET_ACTIVE_STAGE: [0x02, 0x01, 0x82],
  SET_ACTIVE_STAGE: [0x02, 0x01, 0x02],
  GET_ANGLE: [0x02, 0x01, 0x84],
  SET_ANGLE: [0x02, 0x01, 0x04],
  GET_LOD: [0x02, 0x01, 0x88],
  SET_LOD: [0x02, 0x01, 0x08],
  GET_MOTION_SYNC: [0x02, 0x01, 0x89],
  SET_MOTION_SYNC: [0x02, 0x01, 0x09],
  GET_RIPPLE: [0x02, 0x01, 0x8a],
  SET_RIPPLE: [0x02, 0x01, 0x0a],
} as const satisfies Record<string, readonly [number, number, number]>;
type FrameName = keyof typeof JXC_FRAMES;

/** The DPI table write: its length tag is 2 + 4 x stages. */
const SET_DPI = { category: 0x01, command: 0x01 } as const;

/** Poll-rate codes. Reads have also been seen to answer 0x10 for 1000 Hz. */
export const JXC_POLL: Readonly<Record<number, number>> = {
  125: 0x08,
  250: 0x04,
  500: 0x02,
  1000: 0x01,
  2000: 0x20,
  4000: 0x40,
  8000: 0x80,
};
const POLL_FROM_WIRE: Record<number, number> = {
  ...Object.fromEntries(Object.entries(JXC_POLL).map(([hz, w]) => [w, +hz])),
  0x10: 1000,
};

/** 65535 s is "never"; the tools never write 0xFF00 and up otherwise. */
const SLEEP_NEVER = 0xffff;
const STAGES = 6;
/** "Dorsal waits 50 ms before reading (100 ms for battery / firmware)"; then up to ~1 s. */
const SETTLE_MS = [50, 30, 30, 100, 300, 300];

export class JxcMouse extends Driver {
  /** One request: the whitelisted header, then up to 8 argument bytes. */
  private request(name: FrameName | 'SET_DPI', args: number[], len?: number): Uint8Array {
    const [tag, cat, cmd] =
      name === 'SET_DPI' ? [len!, SET_DPI.category, SET_DPI.command] : JXC_FRAMES[name];
    const f = new Uint8Array(this.d.reportLength);
    // [report id, status, 00, target, length tag, category, command, …args]
    f.set([0x00, 0x00, 0x00, JXC_TARGET.mouse, tag, cat, cmd, ...args]);
    return f;
  }

  /** Send, then read until the mouse answers this exact request (status + echo). */
  private async exchange(frame: Uint8Array, slow = false): Promise<Uint8Array | null> {
    return this.ch.transaction(async (io) => {
      await io.write(frame);
      for (const [i, ms] of SETTLE_MS.entries()) {
        await delay(i === 0 && slow ? 100 : ms);
        const r = await io.read(250, this.d.reportLength);
        if (!r || r.length < 8) continue;
        const status = r[1];
        const echoes = r[3] === frame[3] && r[6] === frame[6];
        if (!echoes) continue;
        if (status === JXC_STATUS.OK) return r;
        if (status === JXC_STATUS.ASLEEP) continue; // only the receiver answered
        return null; // unsupported, or rejected
      }
      return null;
    });
  }

  private async read(name: FrameName, args: number[] = [], slow = false) {
    return this.exchange(this.request(name, args), slow);
  }

  /** A SET, then its GET compared against what was sent. */
  private async write(
    set: FrameName,
    args: number[],
    check: { get: FrameName; args: number[]; compare: (r: Uint8Array) => boolean },
  ): Promise<WriteResult> {
    const tx = this.request(set, args);
    const frames = [toHex(tx)];
    const ack = await this.exchange(tx);
    if (!ack)
      return { ok: false, verified: 'unverified', error: 'the mouse refused the setting', frames };
    const back = await this.read(check.get, check.args);
    if (!back) return { ok: true, verified: 'unverified', frames };
    frames.push(toHex(back));
    const match = check.compare(back);
    if (!match) this.warn('The mouse did not keep the setting as written.');
    return { ok: true, verified: match ? 'match' : 'mismatch', frames };
  }

  /** The active onboard profile, 1..3 (every profile setting is addressed by it). */
  private async profile(): Promise<number> {
    return (await this.getActiveProfile()) ?? 1;
  }

  // — device ----------------------------------------------------------------

  override async getFirmware(): Promise<FirmwareInfo> {
    const r = await this.read('GET_FIRMWARE', [], true);
    if (!r) return { device: null, receiver: null, readState: this.d.wired ? 'noReply' : 'asleep' };
    // body bytes 6..9 = a.b.c.d, frame bytes 7..10
    return {
      device: `v${[7, 8, 9, 10].map((i) => r[i] ?? 0).join('.')}`,
      receiver: null,
      readState: 'ok',
    };
  }

  override async getBattery() {
    const r = await this.read('GET_BATTERY', [], true);
    if (!r) return { level: null, charging: false };
    const pct = r[8] ?? 0;
    return { level: pct > 0 && pct <= 100 ? pct : null, charging: (r[7] ?? 0) === 1 };
  }

  override async getActiveProfile(): Promise<number | null> {
    const r = await this.read('GET_PROFILE', [0]);
    const p = r?.[7];
    return p && p >= 1 && p <= (this.d.spec.profileCount ?? 3) ? p : null;
  }

  override async setActiveProfile(slot: number): Promise<WriteResult> {
    if (slot < 1 || slot > (this.d.spec.profileCount ?? 3)) {
      return { ok: false, verified: 'unverified', error: `profile out of range: ${slot}` };
    }
    return this.write('SET_PROFILE', [slot], {
      get: 'GET_PROFILE',
      args: [0],
      compare: (r) => r[7] === slot,
    });
  }

  override async readDebounce(): Promise<number | null> {
    const r = await this.read('GET_DEBOUNCE', [await this.profile()]);
    return r ? (r[8] ?? null) : null;
  }

  override async setDebounce(ms: number): Promise<WriteResult> {
    const range = this.d.spec.debounceRange ?? { min: 0, max: 20 };
    const v = Math.max(range.min, Math.min(range.max, Math.round(ms)));
    const pp = await this.profile();
    return this.write('SET_DEBOUNCE', [pp, v], {
      get: 'GET_DEBOUNCE',
      args: [pp],
      compare: (r) => r[8] === v,
    });
  }

  override async readPower(): Promise<PowerSettings> {
    const r = await this.read('GET_SLEEP', [await this.profile()]);
    if (!r) return { sleepTimerSec: 0, never: true };
    const s = ((r[8] ?? 0) << 8) | (r[9] ?? 0); // big-endian
    return s === SLEEP_NEVER
      ? { sleepTimerSec: 0, never: true }
      : { sleepTimerSec: s, never: false };
  }

  override async setPower(p: PowerSettings): Promise<WriteResult> {
    const s = p.never ? SLEEP_NEVER : Math.max(1, Math.min(0xfeff, Math.round(p.sleepTimerSec)));
    const pp = await this.profile();
    return this.write('SET_SLEEP', [pp, (s >> 8) & 0xff, s & 0xff], {
      get: 'GET_SLEEP',
      args: [pp],
      compare: (r) => (((r[8] ?? 0) << 8) | (r[9] ?? 0)) === s,
    });
  }

  // — profile settings ------------------------------------------------------

  override async readPollRate(): Promise<number | null> {
    const r = await this.read('GET_POLL', [await this.profile()]);
    return r ? (POLL_FROM_WIRE[r[8] ?? -1] ?? null) : null;
  }

  override async setPollRate(hz: number): Promise<WriteResult> {
    const code = JXC_POLL[hz];
    if (code === undefined || !(this.d.spec.pollRates ?? []).includes(hz)) {
      return { ok: false, verified: 'unverified', error: `poll rate not offered: ${hz} Hz` };
    }
    const pp = await this.profile();
    return this.write('SET_POLL', [pp, code], {
      get: 'GET_POLL',
      args: [pp],
      compare: (r) => POLL_FROM_WIRE[r[8] ?? -1] === hz,
    });
  }

  private async flag(get: FrameName, pp: number): Promise<boolean | undefined> {
    const r = await this.read(get, [pp]);
    return r ? (r[8] ?? 0) === 1 : undefined;
  }

  override async readSensor(): Promise<SensorSettings | null> {
    const pp = await this.profile();
    const lod = await this.read('GET_LOD', [pp]);
    if (!lod) return null;
    return {
      lod: lod[8] ?? undefined,
      motionSync: await this.flag('GET_MOTION_SYNC', pp),
      rippleControl: await this.flag('GET_RIPPLE', pp),
      angleSnapping: await this.flag('GET_ANGLE', pp),
    };
  }

  override async setSensor(s: SensorSettings): Promise<WriteResult> {
    // Refused before anything is sent — a profile read included.
    if (s.lod !== undefined && !(this.d.spec.lodOptions ?? []).some((o) => o.wire === s.lod)) {
      return {
        ok: false,
        verified: 'unverified',
        error: `lift-off code ${s.lod} is not one this sensor has`,
      };
    }
    const pp = await this.profile();
    const results: WriteResult[] = [];
    if (s.lod !== undefined) {
      results.push(
        await this.write('SET_LOD', [pp, s.lod], {
          get: 'GET_LOD',
          args: [pp],
          compare: (r) => r[8] === s.lod,
        }),
      );
    }
    const toggles: [boolean | undefined, FrameName, FrameName][] = [
      [s.motionSync, 'SET_MOTION_SYNC', 'GET_MOTION_SYNC'],
      [s.rippleControl, 'SET_RIPPLE', 'GET_RIPPLE'],
      [s.angleSnapping, 'SET_ANGLE', 'GET_ANGLE'],
    ];
    for (const [on, set, get] of toggles) {
      if (on === undefined) continue;
      const v = on ? 1 : 0;
      results.push(await this.write(set, [pp, v], { get, args: [pp], compare: (r) => r[8] === v }));
    }
    return results.length ? kbWorst(results) : { ok: true, verified: 'unverified' };
  }

  // — DPI -------------------------------------------------------------------

  /** Stages as [X hi, X lo, Y hi, Y lo] from frame byte 9; the count at byte 8. */
  override async readDpiStages(): Promise<DpiStage[] | null> {
    const r = await this.read('GET_DPI', [await this.profile(), STAGES]);
    if (!r) return null;
    const count = Math.max(1, Math.min(STAGES, r[8] ?? 1));
    return Array.from({ length: count }, (_, i) => ({
      index: i,
      dpi: ((r[9 + 4 * i] ?? 0) << 8) | (r[10 + 4 * i] ?? 0),
      color: [255, 255, 255] as [number, number, number],
      enabled: true,
    }));
  }

  override async readActiveDpiStage(): Promise<number | null> {
    const r = await this.read('GET_ACTIVE_STAGE', [await this.profile()]);
    const s = r?.[8];
    return s ? s - 1 : null; // 1-based on the wire
  }

  override async setDpiStages(stages: DpiStage[]): Promise<WriteResult> {
    const live = applicableDpiStages(stages).slice(0, STAGES);
    const { min, max, step } = this.d.spec.dpi ?? { min: 100, max: 42000, step: 50 };
    const values = live.map((s) => Math.max(min, Math.min(max, Math.round(s.dpi / step) * step)));
    const pp = await this.profile();
    const before = await this.readActiveDpiStage();
    const data = values.flatMap((v) => [(v >> 8) & 0xff, v & 0xff, (v >> 8) & 0xff, v & 0xff]);
    const tx = this.request('SET_DPI', [pp, values.length, ...data], 2 + 4 * values.length);
    const frames = [toHex(tx)];
    const ack = await this.exchange(tx);
    if (!ack)
      return {
        ok: false,
        verified: 'unverified',
        error: 'the mouse refused the DPI table',
        frames,
      };
    const back = await this.readDpiStages();
    const match =
      !!back && back.length === values.length && back.every((s, i) => s.dpi === values[i]);
    if (back) frames.push(back.map((s) => s.dpi).join(' '));
    // A table shorter than the stage the mouse sat on leaves it out of range.
    const active = clampActiveDpiStage(before, values.length);
    if (before !== null && before !== active) await this.setActiveDpiStage(active);
    if (!match) this.warn('The DPI table did not read back as written.');
    return { ok: true, verified: back ? (match ? 'match' : 'mismatch') : 'unverified', frames };
  }

  override async setActiveDpiStage(i: number): Promise<WriteResult> {
    const pp = await this.profile();
    return this.write('SET_ACTIVE_STAGE', [pp, i + 1], {
      get: 'GET_ACTIVE_STAGE',
      args: [pp],
      compare: (r) => r[8] === i + 1,
    });
  }

  // — backup ----------------------------------------------------------------

  /** Every onboard profile's settings — all of them read back (lighting is not offered). */
  override backupPolicy(): BackupPolicy {
    const n = this.d.spec.profileCount ?? 3;
    return { kind: 'full', required: Array.from({ length: n }, (_, i) => `profile${i + 1}`) };
  }

  override async backup(): Promise<Record<string, string>> {
    const out: Record<string, string> = { schema: '1' };
    const n = this.d.spec.profileCount ?? 3;
    for (let pp = 1; pp <= n; pp++) {
      const dpi = await this.read('GET_DPI', [pp, STAGES]);
      const poll = await this.read('GET_POLL', [pp]);
      const lod = await this.read('GET_LOD', [pp]);
      if (!dpi || !poll || !lod) continue;
      const block: Record<string, string> = { dpi: toHex(dpi), poll: toHex(poll), lod: toHex(lod) };
      for (const name of [
        'GET_ACTIVE_STAGE',
        'GET_MOTION_SYNC',
        'GET_RIPPLE',
        'GET_ANGLE',
        'GET_DEBOUNCE',
        'GET_SLEEP',
      ] as const) {
        const r = await this.read(name, [pp]);
        if (r) block[name] = toHex(r);
      }
      out[`profile${pp}`] = JSON.stringify(block);
    }
    out.firmware = JSON.stringify(await this.getFirmware());
    return out;
  }

  /**
   * Each profile's settings go back through the same verified setters, with
   * that profile made active for the duration — every profile command is
   * addressed to the active one here — and the original one restored after.
   */
  override async restoreFromBackup(blocks: Record<string, string>): Promise<WriteResult> {
    const results: WriteResult[] = [];
    const original = await this.getActiveProfile();
    const n = this.d.spec.profileCount ?? 3;
    for (let pp = 1; pp <= n; pp++) {
      let block: Record<string, string>;
      try {
        block = JSON.parse(blocks[`profile${pp}`] ?? 'null');
      } catch {
        continue;
      }
      if (!block?.dpi) continue;
      const at = (k: string, i: number) => fromHex(block[k] ?? '')[i];
      const switched = await this.setActiveProfile(pp);
      if (!switched.ok) {
        results.push(switched);
        continue;
      }
      const dpi = fromHex(block.dpi);
      const count = Math.max(1, Math.min(STAGES, dpi[8] ?? 1));
      const stages = Array.from({ length: count }, (_, i) => ({
        index: i,
        dpi: ((dpi[9 + 4 * i] ?? 0) << 8) | (dpi[10 + 4 * i] ?? 0),
        color: [255, 255, 255] as [number, number, number],
        enabled: true,
      }));
      results.push(await this.setDpiStages(stages));
      const hz = POLL_FROM_WIRE[at('poll', 8) ?? -1];
      if (hz && (this.d.spec.pollRates ?? []).includes(hz))
        results.push(await this.setPollRate(hz));
      const flag = (k: string) => (block[k] ? at(k, 8) === 1 : undefined);
      results.push(
        await this.setSensor({
          lod: at('lod', 8),
          motionSync: flag('GET_MOTION_SYNC'),
          rippleControl: flag('GET_RIPPLE'),
          angleSnapping: flag('GET_ANGLE'),
        }),
      );
      if (block.GET_DEBOUNCE) results.push(await this.setDebounce(at('GET_DEBOUNCE', 8) ?? 0));
      if (block.GET_SLEEP) {
        const s = ((at('GET_SLEEP', 8) ?? 0) << 8) | (at('GET_SLEEP', 9) ?? 0);
        results.push(
          await this.setPower(
            s === SLEEP_NEVER ? { sleepTimerSec: 0, never: true } : { sleepTimerSec: s },
          ),
        );
      }
      const stage = at('GET_ACTIVE_STAGE', 8);
      if (stage) results.push(await this.setActiveDpiStage(stage - 1));
    }
    if (original) await this.setActiveProfile(original);
    if (!results.length) return this.notSupported('Backup restore');
    return kbWorst(results);
  }
}
