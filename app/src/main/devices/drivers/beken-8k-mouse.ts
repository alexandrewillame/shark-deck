import type { FirmwareInfo, WriteResult } from '@shared/types/live';
import type {
  ButtonMapping,
  DpiStage,
  PowerSettings,
  SensorSettings,
} from '@shared/types/mouse-settings';
import type { Capability } from '@shared/types/capability';
import { applicableDpiStages } from '@shared/mouse-wire';
import { toHex } from '../../hid/frame';
import { Driver, delay, fmtVersion, type BackupPolicy } from './base';

/**
 * The Attack Shark X8 PRO through its 8K receiver (1D57:FA65), on the Beken
 * platform — the one Beken endpoint Shark Deck drives
 * (docs/protocol/mouse-beken.md, "The X8 PRO's 8K receiver").
 *
 * Decoded from an owner's USB recording of the vendor's "Attack Shark
 * Software" 1.0.0.2, made with tools/SharkDeck-device-report.bat (78 steps):
 *
 * - Every setting goes out as output report 4 on the vendor collection
 *   FF01:0002, 64 bytes: `04 <len> 00 <cmd> <inner> 01 <body…> <sum>`.
 *   `<len>` counts the frame up to its checksum, `<inner>` the bytes from
 *   `<cmd>` to the end of the body, and `<sum>` is the 16-bit big-endian sum
 *   of every byte before it. A data block ends its body with its own 16-bit
 *   sum of its data bytes (the DPI, power and button blocks; not the poll).
 * - The receiver answers each frame with input report 4 `04 06 c0 01 00 cb`
 *   (it has the frame), then `04 06 c1 <s> 00 <sum>`: s = 01 when the mouse
 *   took it — within 10–700 ms in the recording — and 00 after about two
 *   seconds when it did not answer.
 * - Nothing is ever read. The vendor software keeps the settings itself and
 *   always writes whole blocks; so does this driver. Each block is kept per
 *   model as it last went out (`ctx.state`), a change patches that copy and
 *   sends it whole, and until a block has gone out once it is `SEED_*` below
 *   — which is why the backup policy is `partial` with nothing to read.
 *
 * Sent, exactly as recorded and at least a second apart (how the vendor paced
 * its bursts; on other Beken receivers faster writes froze the link): 0x04
 * (DPI stages + the sensor switches), 0x05 (sleep + key response, its other
 * bytes unchanged), 0x06 (polling), 0x08 (buttons). Never anything else: 0x09
 * is the macro upload (not decoded far enough), 0x0C goes out before a whole
 * profile (meaning unknown), and on other Beken firmware 0x10 is the
 * bootloader and 0x0B unpairs the receiver.
 *
 * provenance: ported-from-vendor — the frames below reproduce the recorded
 * ones byte for byte (beken-8k-mouse.test.ts), but no frame of Shark Deck's
 * has reached an X8 PRO yet. `inferred`: the stage mask for fewer than six
 * stages, DPI over 12000 other than 40000, the DPI-loop, scroll-down,
 * previous-track, stop and mute codes, and the 0.5–10 min / 4–8 ms ranges'
 * inner values.
 */

export const BEKEN_8K_CMD = { DPI: 0x04, POWER: 0x05, POLL: 0x06, BUTTONS: 0x08 } as const;
const SENT: ReadonlySet<number> = new Set(Object.values(BEKEN_8K_CMD));

const REPORT_ID = 0x04;
export const BEKEN_8K_FRAME_LEN = 64;

const sum16 = (bytes: ArrayLike<number>, from = 0, to = bytes.length): number => {
  let s = 0;
  for (let i = from; i < to; i++) s += bytes[i] ?? 0;
  return s & 0xffff;
};

/** A whole output report: `04 <len> 00 <cmd> <inner> 01 <body…> <sum16>`, zero-padded. */
export function bekenFrame(cmd: number, body: readonly number[]): Uint8Array {
  if (!SENT.has(cmd)) throw new Error(`0x${cmd.toString(16)} is never sent to a Beken receiver`);
  const inner = 3 + body.length;
  const len = 3 + inner + 2;
  if (len > BEKEN_8K_FRAME_LEN) throw new Error(`a ${len}-byte frame does not fit one report`);
  const f = new Uint8Array(BEKEN_8K_FRAME_LEN);
  f.set([REPORT_ID, len, 0x00, cmd, inner, 0x01, ...body]);
  const s = sum16(f, 0, len - 2);
  f[len - 2] = s >> 8;
  f[len - 1] = s & 0xff;
  return f;
}

/** A data block: its bytes, their 16-bit sum, then `pad` zeros. */
const dataBlock = (data: readonly number[], pad: number): number[] => {
  const s = sum16(data);
  return [...data, s >> 8, s & 0xff, ...new Array<number>(pad).fill(0)];
};

// — the DPI block (0x04): 47 data bytes ------------------------------------

/** Data-byte offsets in the DPI block (frame byte = offset + 6). */
const D = {
  /** bit 4: lift-off 2 mm (clear: 1 mm); bit 0: ripple control */
  FLAGS_A: 0,
  /** bit 4: angle snapping; bit 0: motion sync */
  FLAGS_B: 1,
  /** one bit per enabled stage */
  MASK: 2,
  /** one bit per stage stored in 100-DPI steps */
  DOUBLED: 3,
  LOW: 5,
  HIGH: 13,
  /** 1-based; the DPI button changes it without a word on this collection */
  ACTIVE: 21,
  RGB: 22,
} as const;
/** Of the block's eight stage slots, the vendor software uses six. */
const STAGES = 6;
const LOD_2MM = 0x10;
const RIPPLE = 0x01;
const ANGLE = 0x10;
const MOTION = 0x01;

/**
 * One stage: `(raw + 1) × 50`, or `× 100` with its DOUBLED bit. Recorded: 50
 * (raw 0) to 12000 (239) in 50s, and 40000 as raw 399 doubled; above 12750 a
 * stage is sent doubled, so the 50-step form never needs its high bit.
 */
export function encodeBekenDpi(dpi: number): { raw: number; doubled: boolean } {
  const v = Math.max(50, Math.min(40000, Math.round(dpi)));
  if (v <= 12750) return { raw: Math.round(v / 50) - 1, doubled: false };
  return { raw: Math.round(v / 100) - 1, doubled: true };
}

export function decodeBekenDpi(raw: number, doubled: boolean): number {
  return (raw + 1) * (doubled ? 100 : 50);
}

const COLOURS = [
  [0xff, 0x00, 0x00],
  [0x00, 0xff, 0x00],
  [0x00, 0x00, 0xff],
  [0xff, 0xff, 0x00],
  [0x00, 0xff, 0xff],
  [0xff, 0x00, 0xff],
  [0xff, 0x40, 0x00],
  [0xff, 0xff, 0xff],
];

function dpiData(stages: number[], flagsA: number, flagsB: number): number[] {
  const d = new Array<number>(47).fill(0);
  d[D.FLAGS_A] = flagsA;
  d[D.FLAGS_B] = flagsB;
  d[D.MASK] = (1 << stages.length) - 1;
  stages.forEach((dpi, i) => {
    const { raw, doubled } = encodeBekenDpi(dpi);
    d[D.LOW + i] = raw & 0xff;
    d[D.HIGH + i] = raw >> 8;
    if (doubled) d[D.DOUBLED] = (d[D.DOUBLED] ?? 0) | (1 << i);
  });
  d[D.ACTIVE] = 1;
  COLOURS.forEach((c, i) => d.splice(D.RGB + 3 * i, 3, ...c));
  d[46] = 0x02;
  return d;
}

/**
 * Until Shark Deck has sent a block, it is these. The switches, colours and
 * the bytes Shark Deck never changes are the recording's first frames; the
 * stages are a guess — 3200 / 5600 / 8000 / 40000 were in both of the
 * owner's profiles, so likely the factory ones.
 */
export const SEED_DPI: readonly number[] = dpiData(
  [800, 1600, 3200, 5600, 8000, 40000],
  RIPPLE,
  MOTION,
);

// — the power block (0x05): 8 data bytes -----------------------------------

/** Data-byte offsets in the power block; bytes 0–5 are carried unchanged. */
const P = { SLEEP: 6, DEBOUNCE: 7 } as const;
/** Bytes 0–5 as recorded; sleep 1 min (half-minutes), key response 8 ms (÷ 2). */
export const SEED_POWER: readonly number[] = [0x00, 0x03, 0xa8, 0x00, 0xff, 0x00, 0x02, 0x04];

// — polling (0x06) ----------------------------------------------------------

/** `06 09 01 <code> <0xFF − code> 00 00 00 00`; the high nibble doubles from 125 Hz. */
export const BEKEN_8K_POLL: Readonly<Record<number, number>> = {
  125: 0x14,
  250: 0x24,
  500: 0x34,
  1000: 0x44,
  2000: 0x54,
  4000: 0x64,
  8000: 0x74,
};
const POLL_FROM_WIRE = Object.fromEntries(
  Object.entries(BEKEN_8K_POLL).map(([hz, w]) => [w, Number(hz)]),
);
const SEED_POLL = BEKEN_8K_POLL[1000]!;

// — buttons (0x08): 18 slots of [action, modifiers, usage] -----------------

/**
 * Shark Deck's button i -> its slot: Left, Right, Middle, Forward, Backward,
 * the vendor software's own five (it offers no other). Slot 3 is the DPI
 * button, 6 an unknown `3c`, 7–15 unused, 16–17 the wheel.
 */
export const BEKEN_8K_BUTTON_SLOTS = [0, 1, 2, 4, 5] as const;

/** The default map, as the recording restored it. */
export const SEED_BUTTONS: readonly number[] = [
  0x02, 0x03, 0x04, 0x0d, 0x05, 0x06, 0x3c, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01,
  0x0a, 0x09,
].flatMap((a) => [a, 0x00, 0x00]);

const ACT = { DISABLED: 0x01, KEY: 0x11 } as const;

/** `button` children (vendor values) <-> action byte. */
const MOUSE_BUTTON: ReadonlyMap<number, number> = new Map([
  [0x0100, 0x02], // left
  [0x0200, 0x03], // right
  [0x0400, 0x04], // wheel click
  [0x0800, 0x06], // backward
  [0x1000, 0x05], // forward
]);
/** `dpiSwitch`: DPI loop is the DPI button's own default (inferred), + and − recorded. */
const DPI_SWITCH: ReadonlyMap<number, number> = new Map([
  [0x0100, 0x0d],
  [0x0200, 0x0e],
  [0x0300, 0x0f],
]);
/** `scrollUD`: up recorded; down is the wheel's other default slot (inferred). */
const SCROLL: ReadonlyMap<number, number> = new Map([
  [0x0100, 0x09],
  [0x0200, 0x0a],
]);
/** Consumer usage <-> action byte: next, play, volume ± recorded; previous, stop, mute fill the run. */
const MEDIA: ReadonlyMap<number, number> = new Map([
  [0x00b6, 0x16],
  [0x00b5, 0x17],
  [0x00cd, 0x18],
  [0x00b7, 0x19],
  [0x00e2, 0x1a],
  [0x00e9, 0x1b],
  [0x00ea, 0x1c],
]);
const invert = (m: ReadonlyMap<number, number>) => new Map([...m].map(([k, v]) => [v, k]));
const MOUSE_BUTTON_FROM = invert(MOUSE_BUTTON);
const DPI_SWITCH_FROM = invert(DPI_SWITCH);
const SCROLL_FROM = invert(SCROLL);
const MEDIA_FROM = invert(MEDIA);

const isModifier = (usage: number) => usage >= 0xe0 && usage <= 0xe7;

/** A mapping as its slot's three bytes, or why this mouse cannot do it. */
export function encodeBekenButton(m: ButtonMapping): [number, number, number] | string {
  const pick = (table: ReadonlyMap<number, number>, v: number | undefined) =>
    v === undefined ? undefined : table.get(v);
  let action: number | undefined;
  switch (m.actionKey) {
    case 'button':
      action = pick(MOUSE_BUTTON, m.param);
      break;
    case 'dpiSwitch':
      action = pick(DPI_SWITCH, m.param);
      break;
    case 'scrollUD':
      action = pick(SCROLL, m.param);
      break;
    case 'multimedia':
      action = pick(MEDIA, m.multimedia ?? m.param);
      break;
    case 'disable':
      action = ACT.DISABLED;
      break;
    case 'combo': {
      const keys = (m.combo ?? []).filter((k) => !isModifier(k));
      if (keys.length !== 1) return 'A shortcut on this mouse is one key, with any modifiers.';
      const mods = (m.combo ?? [])
        .filter(isModifier)
        .reduce((bits, k) => bits | (1 << (k - 0xe0)), 0);
      return [ACT.KEY, mods, keys[0]! & 0xff];
    }
    default:
      return 'This mouse has no such button action.';
  }
  return action === undefined ? 'This mouse has no such button action.' : [action, 0x00, 0x00];
}

/** A slot's bytes as a mapping the Buttons tab shows. */
export function decodeBekenButton([action, mods, usage]: number[]): ButtonMapping {
  const a = action ?? ACT.DISABLED;
  if (a === ACT.DISABLED) return { actionKey: 'disable', action: a };
  if (a === ACT.KEY) {
    const combo: number[] = [];
    for (let bit = 0; bit < 8; bit++) if (((mods ?? 0) >> bit) & 1) combo.push(0xe0 + bit);
    if (usage) combo.push(usage);
    return { actionKey: 'combo', action: a, combo };
  }
  const found: [string, number | undefined][] = [
    ['button', MOUSE_BUTTON_FROM.get(a)],
    ['dpiSwitch', DPI_SWITCH_FROM.get(a)],
    ['scrollUD', SCROLL_FROM.get(a)],
  ];
  for (const [actionKey, param] of found)
    if (param !== undefined) return { actionKey, action: a, param };
  const media = MEDIA_FROM.get(a);
  if (media !== undefined)
    return { actionKey: 'multimedia', action: a, multimedia: media, param: media };
  return { actionKey: 'undefined', action: a };
}

// — the driver --------------------------------------------------------------

type BlockKey = 'dpi' | 'power' | 'poll' | 'buttons';
const SEEDS: Record<BlockKey, readonly number[]> = {
  dpi: SEED_DPI,
  power: SEED_POWER,
  poll: [SEED_POLL],
  buttons: SEED_BUTTONS,
};

/** Read off an input report 4: `04 06 c0|c1 <status> <sum16>`, or null. */
function ackOf(r: Uint8Array): { stage: 'got' | 'done'; ok: boolean } | null {
  if (r[0] !== REPORT_ID || r[1] !== 0x06 || r.length < 6) return null;
  if (sum16(r, 0, 4) !== (((r[4] ?? 0) << 8) | (r[5] ?? 0))) return null;
  if (r[2] === 0xc0) return { stage: 'got', ok: r[3] === 0x01 };
  if (r[2] === 0xc1) return { stage: 'done', ok: r[3] === 0x01 };
  return null;
}

const NOT_CONFIRMED =
  'The mouse did not confirm the change. Move it to wake it, check it is on 2.4 GHz with this receiver, and try again.';

export class Beken8kMouse extends Driver {
  /** How long to wait for the mouse's answer (`c1`): its "no" came after ~2.1 s. */
  protected ackTimeoutMs = 3000;
  /** The least time between two frames. */
  protected minGapMs = 1000;
  private lastSentAt = 0;
  private readonly blocks = new Map<BlockKey, number[]>();

  /** A block as it last went out, else its seed. */
  private async block(key: BlockKey): Promise<number[]> {
    const have = this.blocks.get(key);
    if (have) return [...have];
    const seed = SEEDS[key];
    const kept = await this.state?.get(`beken8k.${key}`).catch(() => undefined);
    const ok =
      Array.isArray(kept) &&
      kept.length === seed.length &&
      kept.every((n) => Number.isInteger(n) && n >= 0 && n <= 255);
    const b = ok ? (kept as number[]) : [...seed];
    this.blocks.set(key, b);
    return [...b];
  }

  private frameFor(key: BlockKey, data: readonly number[]): Uint8Array {
    switch (key) {
      case 'dpi':
        return bekenFrame(BEKEN_8K_CMD.DPI, dataBlock(data, 4));
      case 'power':
        return bekenFrame(BEKEN_8K_CMD.POWER, dataBlock(data, 2));
      case 'buttons':
        return bekenFrame(BEKEN_8K_CMD.BUTTONS, dataBlock(data, 0));
      case 'poll': {
        const code = data[0] ?? SEED_POLL;
        return bekenFrame(BEKEN_8K_CMD.POLL, [code, 0xff - code, 0, 0, 0, 0]);
      }
    }
  }

  /** Send a block whole; it is kept only once the mouse has said it took it. */
  private async send(key: BlockKey, data: number[]): Promise<WriteResult> {
    const tx = this.frameFor(key, data);
    const frames = [toHex(tx)];
    const wait = this.lastSentAt + this.minGapMs - Date.now();
    if (wait > 0) await delay(wait);
    const result = await this.ch.transaction(async (io): Promise<WriteResult> => {
      // Answers to earlier frames (ours, or the vendor software's) may still
      // be queued, and every answer looks alike: drop them first.
      for (let i = 0; i < 64 && (await io.read(1, BEKEN_8K_FRAME_LEN)); i++);
      try {
        await io.write(tx);
      } catch (e) {
        return { ok: false, verified: 'unverified', error: String(e), frames };
      } finally {
        this.lastSentAt = Date.now();
      }
      const deadline = Date.now() + this.ackTimeoutMs;
      let got = false;
      while (Date.now() < deadline) {
        const r = await io.read(
          Math.max(1, Math.min(250, deadline - Date.now())),
          BEKEN_8K_FRAME_LEN,
        );
        const a = r && ackOf(r);
        if (!a) continue;
        frames.push(toHex(r));
        if (a.stage === 'got') {
          got = true;
          continue;
        }
        return a.ok
          ? { ok: true, verified: 'match', frames }
          : { ok: false, verified: 'unverified', error: NOT_CONFIRMED, frames };
      }
      return {
        ok: false,
        verified: 'unverified',
        error: got ? NOT_CONFIRMED : 'The receiver did not answer.',
        frames,
      };
    });
    if (result.ok) {
      this.blocks.set(key, [...data]);
      await this.state?.set(`beken8k.${key}`, [...data]).catch(() => undefined);
    }
    return result;
  }

  private refuse(error: string): WriteResult {
    return { ok: false, verified: 'unverified', error };
  }

  // — what a poll may ask: nothing goes out ---------------------------------

  /** The receiver is there; whether the mouse is awake shows only when a change goes out. */
  override async ping(): Promise<boolean> {
    return true;
  }

  override async getFirmware(): Promise<FirmwareInfo> {
    const release = this.ch.descriptorRelease;
    return {
      device: null,
      receiver: release === undefined ? null : fmtVersion(release),
      ...(release === undefined ? {} : { receiverRaw: release }),
    };
  }

  // — DPI ---------------------------------------------------------------------

  override async readDpiStages(): Promise<DpiStage[]> {
    const d = await this.block('dpi');
    const mask = d[D.MASK] ?? 0x3f;
    return Array.from({ length: STAGES }, (_, i) => ({
      index: i,
      dpi: decodeBekenDpi(
        (d[D.LOW + i] ?? 0) | ((d[D.HIGH + i] ?? 0) << 8),
        (((d[D.DOUBLED] ?? 0) >> i) & 1) === 1,
      ),
      color: [d[D.RGB + 3 * i] ?? 0, d[D.RGB + 3 * i + 1] ?? 0, d[D.RGB + 3 * i + 2] ?? 0],
      enabled: ((mask >> i) & 1) === 1,
    }));
  }

  override async setDpiStages(stages: DpiStage[]): Promise<WriteResult> {
    const live = applicableDpiStages(stages).slice(0, STAGES);
    if (!live.length) return this.refuse('At least one DPI stage has to stay on.');
    const d = await this.block('dpi');
    d[D.MASK] = (1 << live.length) - 1;
    live.forEach((s, i) => {
      const { raw, doubled } = encodeBekenDpi(s.dpi);
      d[D.LOW + i] = raw & 0xff;
      d[D.HIGH + i] = raw >> 8;
      d[D.DOUBLED] = doubled ? (d[D.DOUBLED] ?? 0) | (1 << i) : (d[D.DOUBLED] ?? 0) & ~(1 << i);
    });
    return this.send('dpi', d);
  }

  // — sensor switches (the DPI block's first two bytes) ----------------------

  override async readSensor(): Promise<SensorSettings> {
    const d = await this.block('dpi');
    const a = d[D.FLAGS_A] ?? 0;
    const b = d[D.FLAGS_B] ?? 0;
    return {
      lod: a & LOD_2MM ? 1 : 0,
      rippleControl: (a & RIPPLE) !== 0,
      angleSnapping: (b & ANGLE) !== 0,
      motionSync: (b & MOTION) !== 0,
    };
  }

  override async setSensor(s: SensorSettings): Promise<WriteResult> {
    if (s.lod !== undefined && s.lod !== 0 && s.lod !== 1) {
      return this.refuse(`lift-off code ${s.lod} is not one this sensor has`);
    }
    const d = await this.block('dpi');
    const set = (at: number, bit: number, on: boolean | undefined) => {
      if (on !== undefined) d[at] = on ? (d[at] ?? 0) | bit : (d[at] ?? 0) & ~bit;
    };
    set(D.FLAGS_A, LOD_2MM, s.lod === undefined ? undefined : s.lod === 1);
    set(D.FLAGS_A, RIPPLE, s.rippleControl);
    set(D.FLAGS_B, ANGLE, s.angleSnapping);
    set(D.FLAGS_B, MOTION, s.motionSync);
    return this.send('dpi', d);
  }

  // — polling -------------------------------------------------------------------

  override async readPollRate(): Promise<number | null> {
    const [code] = await this.block('poll');
    return POLL_FROM_WIRE[code ?? SEED_POLL] ?? null;
  }

  override async setPollRate(hz: number): Promise<WriteResult> {
    const code = BEKEN_8K_POLL[hz];
    if (code === undefined) return this.refuse(`poll rate not offered: ${hz} Hz`);
    return this.send('poll', [code]);
  }

  // — sleep and key response (the power block) ----------------------------------

  override async readPower(): Promise<PowerSettings> {
    const p = await this.block('power');
    return { sleepTimerSec: (p[P.SLEEP] ?? 2) * 30, never: false };
  }

  /** In half-minutes, from 30 s; the vendor slider has no "never". */
  override async setPower(pw: PowerSettings): Promise<WriteResult> {
    const half = Math.max(1, Math.min(20, Math.round((pw.sleepTimerSec || 30) / 30)));
    const p = await this.block('power');
    p[P.SLEEP] = half;
    return this.send('power', p);
  }

  override async readDebounce(): Promise<number | null> {
    const p = await this.block('power');
    return (p[P.DEBOUNCE] ?? 4) * 2;
  }

  /** Sent as ms ÷ 2: 4–8 ms were recorded. */
  override async setDebounce(ms: number): Promise<WriteResult> {
    const r = this.d.spec.debounceRange ?? { min: 4, max: 8 };
    const v = Math.max(r.min, Math.min(r.max, Math.round(ms / 2) * 2));
    const p = await this.block('power');
    p[P.DEBOUNCE] = v / 2;
    return this.send('power', p);
  }

  // — buttons -------------------------------------------------------------------

  override async readButtons(): Promise<Record<number, ButtonMapping>> {
    const b = await this.block('buttons');
    const out: Record<number, ButtonMapping> = {};
    BEKEN_8K_BUTTON_SLOTS.forEach((slot, i) => {
      out[i] = decodeBekenButton(b.slice(3 * slot, 3 * slot + 3));
    });
    return out;
  }

  override async setButtonMapping(button: number, m: ButtonMapping): Promise<WriteResult> {
    const slot = BEKEN_8K_BUTTON_SLOTS[button];
    if (slot === undefined) return this.refuse(`no button ${button + 1}`);
    const bytes = encodeBekenButton(m);
    if (typeof bytes === 'string') return this.refuse(bytes);
    const b = await this.block('buttons');
    b.splice(3 * slot, 3, ...bytes);
    return this.send('buttons', b);
  }

  // — backup -------------------------------------------------------------------

  /** Nothing can be read, so nothing backs up: the user's one-time OK is the gate. */
  override backupPolicy(): BackupPolicy {
    const unreadable: Capability[] = [
      'dpi',
      'pollRate',
      'lod',
      'rippleControl',
      'angleSnapping',
      'motionSync',
      'sleepTimer',
      'mouseDebounce',
      'buttonRemap',
    ];
    return { kind: 'partial', required: [], unreadable };
  }

  override async backup(): Promise<Record<string, string>> {
    return {};
  }
}
