/**
 * The dossier's "Shark Deck against this recording": what a recording still
 * leaves Shark Deck to do, decided by Shark Deck's own code rather than by a
 * maintainer reading frames. One recording is usually all an owner makes, so
 * whatever it shows has to come out here.
 *
 * Shark Deck's real driver runs on a channel that answers from the recording
 * (the board's own answers to the official software's reads), so it reads the
 * key map, the switch types and the rest exactly as it would from the device.
 * Each change the official software made is then made again by Shark Deck:
 *
 * - a setting held in one register (polling rate, lighting, side light, the
 *   keyboard options, the profile) is read back by Shark Deck's own reader
 *   from the official frame, written again by its own writer, and the two
 *   frames compared byte for byte;
 * - a remap, an Fn key, the key-mode zones, per-key colours and a macro are
 *   written again with the same bindings, colours or steps, and compared;
 * - the magnetic pages are compared by what they leave on the board: the
 *   official software rewrites whole pages where Shark Deck writes the keys
 *   that changed, so frames cannot match, but the board must end the same.
 *
 * A difference is a command Shark Deck shapes otherwise (the R98 HE's one-key
 * Fn write and its macro frame were found this way).
 *
 * ROYUAN keyboards for now: the family whose recordings drive this check.
 */
import type { DeviceDescriptor } from '@shared/types/device';
import type { PerKeyColor } from '@shared/types/lighting';
import type { MagneticKeySettings } from '@shared/types/keyboard-settings';
import type { KeyLayoutEntry } from '@shared/types/keys';
import { CAPABILITY_META } from '@shared/capabilities';
import { isStockSwitch } from '@shared/keyboard-switches';
import { KB_MAGNETISM_PAGE_CHUNKS } from '@shared/keyboard-options';
import type { Capability } from '@shared/types/capability';
import type { HidChannel } from '../../hid/transport';
import { DRIVERS, type Driver, type DriverContext } from '../drivers';
import { CompxKeyboard, KB_CMD, decodeMacro, macroPayloadOf } from '../drivers/compx-keyboard';
import { boardLayoutGeometry, KEYBOARDS_BY_ID, withBoardLayout } from '../catalog/keyboards';
import { deriveLayout, layoutAgreement } from '../layout-check';
import { CAPABILITY_STEPS } from '../recording-steps';
import type { ReportDevice } from '../deviceReport';
import type { HidMessage } from './hidMessages';
import type { RecordingStep } from './dossier';

const hex = (b: ArrayLike<number>) =>
  Array.from(b, (x) => x.toString(16).padStart(2, '0')).join(' ');
/** A frame as the dossier writes it: trailing zeros counted, not listed. */
const short = (b: ArrayLike<number>, n = 16) => {
  const a = Array.from(b);
  let end = a.length;
  while (end > 0 && a[end - 1] === 0) end--;
  const shown = a.slice(0, Math.max(Math.min(end, n), 8));
  return `${hex(shown)}${a.length > shown.length ? ` (+${a.length - shown.length} more)` : ''}`;
};

/** The official software's reads, each with the board's first answer: what
 *  the board said before any step changed it. */
function answersOf(messages: readonly HidMessage[]): Map<string, Uint8Array> {
  const out = new Map<string, Uint8Array>();
  let last: Uint8Array | null = null;
  for (const m of messages) {
    if (!m.out) continue;
    if (m.kind === 'set-feature') last = m.data;
    else if (m.kind === 'get-feature' && last) {
      const key = hex(last);
      if (!out.has(key)) out.set(key, m.data);
      last = null;
    }
  }
  return out;
}

// ---- The magnetic pages, as a board holds them --------------------------

/** Bytes per key on a magnetism page (compx-he-keyboard.ts `magWidth`). */
const magWidth = (page: number) =>
  page === MAG_PAGE.DKS_ACTIONS
    ? 4
    : Math.max(1, Math.round((KB_MAGNETISM_PAGE_CHUNKS[page] ?? 4) / 2));
const MAG_SLOTS = 128;
const MAG_PAGE = {
  TRAVEL: 0,
  RELEASE: 1,
  RT_PRESS: 2,
  RT_RELEASE: 3,
  DKS_POINT: 4,
  MT_HOLD: 5,
  DEAD_BOTTOM: 6,
  MODE: 7,
  DKS_ACTIONS: 8,
  SNAP: 9,
  /** Where Shark Deck reads the DKS actions back (compx-he-keyboard.ts `DKS_FLAGS_READ`). */
  DKS_ACTIONS_READ: 10,
  DEAD_TOP: 251,
  SWITCH: 252,
} as const;
const PAGE_NAME: Record<number, string> = {
  0: 'actuation',
  1: 'release',
  2: 'rapid trigger press',
  3: 'rapid trigger release',
  4: 'DKS point',
  5: 'mod-tap hold',
  6: 'bottom dead zone',
  7: 'mode',
  8: 'DKS actions',
  9: 'SnapKey partner',
  251: 'top dead zone',
  252: 'switch type',
};
/** Pages whose value is a travel, in wire units (mm × the firmware's multiplier). */
const TRAVEL_PAGES = new Set<number>([0, 1, 2, 3, 4, 6, 251]);

/**
 * The pages a key's mode makes count, as Shark Deck reads them
 * (compx-he-keyboard.ts `readMagnetic`): the rest hold whatever was there and
 * the board ignores them, so the official software and Shark Deck may leave
 * them differently.
 */
function livePages(mode: number): number[] {
  const pages: number[] = [
    MAG_PAGE.MODE,
    MAG_PAGE.TRAVEL,
    MAG_PAGE.RELEASE,
    MAG_PAGE.DEAD_BOTTOM,
    MAG_PAGE.DEAD_TOP,
    MAG_PAGE.SWITCH,
  ];
  if (mode & 0x80) pages.push(MAG_PAGE.RT_PRESS, MAG_PAGE.RT_RELEASE);
  const m = mode & 0x0f;
  if (m === 2) pages.push(MAG_PAGE.DKS_POINT, MAG_PAGE.DKS_ACTIONS);
  if (m === 3) pages.push(MAG_PAGE.MT_HOLD);
  if (m >= 7 && m <= 10) pages.push(MAG_PAGE.SNAP);
  return pages;
}

/**
 * The magnetism pages as bytes, `undefined` where nothing has said what the
 * board holds (the official software reads only some pages, and writes the
 * others whole only when it saves them).
 */
class MagBoard {
  private readonly pages = new Map<number, (number | undefined)[]>();

  private bytes(page: number): (number | undefined)[] {
    let b = this.pages.get(page);
    if (!b) {
      b = new Array<number | undefined>(MAG_SLOTS * magWidth(page)).fill(undefined);
      this.pages.set(page, b);
    }
    return b;
  }

  clone(): MagBoard {
    const c = new MagBoard();
    for (const [p, b] of this.pages) c.pages.set(p, [...b]);
    return c;
  }

  pageList(): number[] {
    return [...this.pages.keys()];
  }

  /** A `SET_MULTI_MAGNETISM` frame, report id off: one key, or a 56-byte chunk of a page. */
  write(f: ArrayLike<number>): void {
    const page = f[1]!;
    const b = this.bytes(page);
    if (f[2] === 1) {
      const at = f[3]! * 56;
      for (let i = 0; i < 56 && at + i < b.length; i++) b[at + i] = f[8 + i] ?? 0;
    } else {
      const w = magWidth(page);
      const at = f[3]! * w;
      for (let i = 0; i < w; i++) b[at + i] = f[8 + i] ?? 0;
    }
  }

  /** The board's answer to a page read (`e5 <page> 01 <chunk>`): fills what is not known yet. */
  read(query: ArrayLike<number>, answer: ArrayLike<number>): void {
    const b = this.bytes(query[1]!);
    const at = query[3]! * 64;
    for (let i = 0; i < 64 && at + i < b.length; i++)
      if (b[at + i] === undefined) b[at + i] = answer[i] ?? 0;
  }

  /** 64 bytes of a page as the board answers them, unknown as 0. Shark Deck
   *  reads the DKS actions from page 10; the official software writes page 8. */
  answer(page: number, chunk: number): number[] {
    const b = this.bytes(page === MAG_PAGE.DKS_ACTIONS_READ ? MAG_PAGE.DKS_ACTIONS : page);
    return Array.from({ length: 64 }, (_, i) => b[chunk * 64 + i] ?? 0);
  }

  value(page: number, slot: number): number | undefined {
    const b = this.pages.get(page);
    if (!b) return undefined;
    const w = magWidth(page);
    let v = 0;
    for (let i = 0; i < w; i++) {
      const x = b[slot * w + i];
      if (x === undefined) return undefined;
      v |= x << (8 * i);
    }
    return v >>> 0;
  }
}

/**
 * The channel a driver talks to, answering from the recording: a query the
 * official software made gets the board's answer; any other gets itself back,
 * as Windows hands back a query the device never answered. What the driver
 * writes is kept, to compare.
 *
 * Two answers can be set for a moment: `override` answers one command with a
 * register as an official frame set it (so Shark Deck's reader decodes that
 * frame), and `board` answers the magnetism pages from a board state that
 * Shark Deck's own magnetism writes then change.
 */
class ReplayChannel {
  readonly sent: Uint8Array[] = [];
  readonly override = new Map<number, Uint8Array>();
  board: MagBoard | null = null;
  private last: Uint8Array | null = null;
  constructor(private readonly answers: Map<string, Uint8Array>) {}
  async open(): Promise<void> {}
  async close(): Promise<void> {}
  isOpen(): boolean {
    return true;
  }
  async relayStatus(): Promise<null> {
    return null;
  }
  async write(frame: Uint8Array): Promise<void> {
    this.sent.push(frame);
    this.last = frame;
    if (this.board && frame[1] === KB_CMD.SET_MULTI_MAGNETISM) this.board.write(frame.subarray(1));
  }
  async read(): Promise<Uint8Array | null> {
    if (!this.last) return null;
    const id = this.last[0]!;
    const cmd = this.last[1]!;
    const o = this.override.get(cmd);
    if (o) return Uint8Array.from([id, ...o]);
    if (this.board && cmd === KB_CMD.GET_MULTI_MAGNETISM)
      return Uint8Array.from([id, ...this.board.answer(this.last[2]!, this.last[4]!)]);
    // The driver's frames carry the report id first; the recording's do not.
    const a = this.answers.get(hex(this.last.subarray(1)));
    return a ? Uint8Array.from([id, ...a]) : Uint8Array.from(this.last);
  }
  async request(query: Uint8Array, expect: number): Promise<Uint8Array | null> {
    await this.write(query);
    const r = await this.read();
    return r && r[1] === expect && !sameBytes(r, query) ? r : null;
  }
  transaction<T>(fn: (io: unknown) => Promise<T>): Promise<T> {
    return fn({
      write: (f: Uint8Array) => this.write(f),
      read: () => this.read(),
      readFeature: () => this.read(),
      readInput: async () => null,
      request: (q: Uint8Array, e: number) => this.request(q, e),
    });
  }
  /** What the driver wrote since `from`, the report id taken off. */
  writes(from: number): Uint8Array[] {
    return this.sent.slice(from).map((f) => f.subarray(1));
  }
}

function sameBytes(a: ArrayLike<number>, b: ArrayLike<number>): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function memoryState() {
  const m = new Map<string, unknown>();
  return {
    get: async (k: string) => m.get(k),
    set: async (k: string, v: unknown) => void m.set(k, v),
  };
}

/** The model's real driver, unpaced: nothing real answers, and a paced replay
 *  of a whole-board write takes seconds a step. */
function replayDriver(ctx: DriverContext): Driver {
  const Base = DRIVERS[ctx.descriptor.driver] as unknown as typeof CompxKeyboard;
  class Replay extends Base {
    protected override readonly settleMs = 0;
  }
  return new Replay(ctx);
}

/** The model the recording names: the report's identify answer, else the
 *  official software's own GET_USB_VERSION answer (model id at bytes 1–2). */
function modelIdOf(
  messages: readonly HidMessage[],
  devices: readonly ReportDevice[],
): number | null {
  // What the recorded device itself answered first: the report's own question
  // may have reached another board of the same USB id, plugged in beside it.
  for (const m of messages)
    if (m.kind === 'get-feature' && m.data[0] === KB_CMD.GET_USB_VERSION)
      return m.data[1]! | (m.data[2]! << 8);
  for (const d of devices) if (d.identify?.modelId) return d.identify.modelId;
  return null;
}

/**
 * Commands Shark Deck does not send that a recording showed what they are.
 * The two streams run while their effect is on, about 32 frames a second.
 */
const KNOWN_ELSEWHERE: Record<number, string> = {
  0x0d: 'streamed while Music Follow is on',
  0x0e: 'streamed while Light Shadow (screen colour) is on: `0e` and three colour bytes',
};

export interface StepMessages {
  step: RecordingStep;
  messages: HidMessage[];
}

export async function sharkDeckChecks(args: {
  messages: readonly HidMessage[];
  steps: readonly StepMessages[];
  devices: readonly ReportDevice[];
}): Promise<string[]> {
  const out: string[] = ['## Shark Deck against this recording', ''];
  const modelId = modelIdOf(args.messages, args.devices);
  const row = modelId === null ? undefined : KEYBOARDS_BY_ID.get(modelId);
  if (!row) {
    out.push('Not a keyboard of the catalogue (ROYUAN family): no check made here yet.', '');
    return out;
  }
  const answers = answersOf(args.messages);
  const ch = new ReplayChannel(answers);
  const channel = ch as unknown as HidChannel;
  let d: DeviceDescriptor = row;
  out.push(`${d.displayName} (model id ${modelId}).`, '');

  // ---- The key map, read as the driver reads it from the board.
  const geometry = boardLayoutGeometry(d);
  const probe = replayDriver({ descriptor: d, channel, onWarning: () => {}, state: memoryState() });
  const base = await probe.readKeyBindings('base');
  const slotMap = d.spec.keyMatrix?.layoutStatus !== 'none' ? d.spec.keyMatrix?.layout : undefined;
  if (slotMap?.length && base) {
    // A model with a slot map (the vendor's, a recording's): held to this board.
    const a = layoutAgreement(slotMap, base);
    const off = slotMap.filter((k) => {
      if (k.slot === undefined || typeof k.code !== 'number') return false;
      const b = base[k.slot];
      return !(b?.kind === 'key' && b.code !== null && parseInt(b.code, 16) === k.code);
    });
    out.push(
      `- Key map: ${a.agree} of ${a.checked} keys type what its slot map says` +
        (off.length ? `; not: ${off.map((k) => `${k.label} (slot ${k.slot})`).join(', ')}` : '') +
        '.',
    );
  } else if (geometry) {
    const layout = base ? deriveLayout(geometry, base) : null;
    if (!base) out.push('- Key map: the recording has no answer to the key map read.');
    else if (!layout) out.push(`- Key map: does not match the drawing's ${geometry.length} keys.`);
    else {
      const left = geometry.filter((g) => !layout.some((k) => k.row === g.row && k.col === g.col));
      out.push(
        `- Key map: ${layout.length} of ${geometry.length} drawn keys placed` +
          (left.length ? `; not placed: ${left.map((k) => k.label).join(', ')}` : ' (all)') +
          '.',
      );
      d = withBoardLayout(d, layout);
    }
  }
  const drv = replayDriver({ descriptor: d, channel, onWarning: () => {}, state: memoryState() });

  // ---- Values Shark Deck does not know.
  if (d.capabilities.includes('replaceableSwitches')) {
    const types = await drv.readSwitchTypes();
    const known = new Set(d.spec.supportedSwitches ?? []);
    // 0 and 255 are the stock switch (shared/keyboard-switches.ts `isStockSwitch`).
    const odd = types
      ? [...new Set(Object.values(types))].filter((v) => !known.has(v) && !isStockSwitch(v))
      : [];
    out.push(
      !types
        ? '- Switch types: the recording has no answer to their read.'
        : odd.length
          ? `- Switch types: values Shark Deck does not know: ${odd.join(', ')} (known: ${[...known].join(', ')}).`
          : '- Switch types: every value is one Shark Deck knows.',
    );
  }

  // ---- Commands Shark Deck does not send.
  const knownCmds = new Set<number>(Object.values(KB_CMD));
  const unknown = new Map<number, { n: number; answered: boolean }>();
  for (const m of args.messages) {
    if (!m.out || m.kind !== 'set-feature' || !m.data.length) continue;
    const c = m.data[0]!;
    if (knownCmds.has(c)) continue;
    const u = unknown.get(c) ?? { n: 0, answered: false };
    u.n++;
    const a = answers.get(hex(m.data));
    if (a && !sameBytes(a, m.data)) u.answered = true;
    unknown.set(c, u);
  }
  out.push(
    unknown.size
      ? `- Commands Shark Deck does not know: ${[...unknown]
          .map(
            ([c, u]) =>
              `0x${c.toString(16)} (${u.n}×, ${u.answered ? '**answered**' : 'not answered'}` +
              `${KNOWN_ELSEWHERE[c] ? `; ${KNOWN_ELSEWHERE[c]}` : ''})`,
          )
          .join(', ')}.`
      : '- Every command the official software sent is one Shark Deck knows.',
  );

  // ---- Coverage: what the model shows, and what this recording's steps did.
  const done = new Set(
    args.steps.filter((s) => s.step.status === 'done').map((s) => s.step.id.split('.')[0]!),
  );
  const asked = new Set(args.steps.map((s) => s.step.id.split('.')[0]!));
  const rows: string[] = [];
  for (const cap of d.capabilities) {
    const words = CAPABILITY_STEPS[cap as Capability];
    if (!Array.isArray(words)) continue;
    const state = words.some((w) => done.has(w))
      ? 'recorded'
      : words.some((w) => asked.has(w))
        ? 'asked, not in the software'
        : '**not asked**';
    rows.push(
      `| ${CAPABILITY_META[cap as Capability].label} (${cap}) | ${words.join(', ')} | ${state} |`,
    );
  }
  out.push('', '| Setting it shows | Steps | This recording |', '|---|---|---|', ...rows, '');

  // ---- Each change made again by Shark Deck, and compared.
  const compared: string[] = [];
  const layout = d.spec.keyMatrix?.layout ?? [];
  const mag = magnetismFeed(args.messages);
  for (const { step, messages } of args.steps) {
    if (step.status !== 'done' || !messages.length) continue;
    const sets = messages.filter((m) => m.out && m.kind === 'set-feature');

    // Registers: Shark Deck's reader decodes the official frame, its writer writes it again.
    for (const m of sets) {
      const reg = REGISTERS.find((r) => r.set === m.data[0]);
      if (!reg) continue;
      ch.override.set(reg.get, Uint8Array.from([reg.get, ...m.data.subarray(1)]));
      const from = ch.sent.length;
      const said = await reg.redo(drv);
      ch.override.delete(reg.get);
      compared.push(
        compare(
          step.id,
          `${reg.what}${said ? ` ${said}` : ''}`,
          [m.data],
          ch.writes(from),
          reg.set,
        ),
      );
    }

    // Key bindings: a plain remap is one frame, zone 0, committed; a key mode
    // (DKS, mod-tap) writes its zones one by one, committed on the last.
    const pending: Uint8Array[] = [];
    for (const m of sets.filter((x) => x.data[0] === KB_CMD.SET_KEYMATRIX)) {
      if (m.data[5] !== 1) {
        pending.push(m.data);
        continue;
      }
      const batch = [...pending.splice(0), m.data];
      const slot = m.data[2]!;
      const from = ch.sent.length;
      if (batch.length === 1 && m.data[6] === 0) {
        await drv.setKeyRemap('base', slot, hex(m.data.subarray(8, 12)).replace(/ /g, ''));
        compared.push(compare(step.id, 'remap', batch, ch.writes(from), KB_CMD.SET_KEYMATRIX));
        continue;
      }
      const zones: Array<string | null> = [];
      for (const f of batch) {
        while (zones.length <= f[6]!) zones.push(null);
        zones[f[6]!] = hex(f.subarray(8, 12)).replace(/ /g, '');
      }
      await drv.setKeyZoneBindings(slot, zones);
      compared.push(
        compare(step.id, 'key-mode zones', batch, ch.writes(from), KB_CMD.SET_KEYMATRIX),
      );
    }

    for (const m of sets.filter((x) => x.data[0] === KB_CMD.SET_FN && x.data[3] !== 0xff)) {
      const from = ch.sent.length;
      await drv.setKeyRemap('fn', m.data[3]!, hex(m.data.subarray(8, 12)).replace(/ /g, ''));
      compared.push(compare(step.id, 'Fn key', [m.data], ch.writes(from), KB_CMD.SET_FN));
    }

    const pic = sets.filter((x) => x.data[0] === KB_CMD.SET_USERPIC);
    if (pic.length) {
      const bytes: number[] = [];
      for (const c of pic)
        bytes.splice(c.data[3]! * 56, c.data[4]!, ...c.data.subarray(8, 8 + c.data[4]!));
      const colors: PerKeyColor[] = [];
      for (let i = 0; i + 2 < bytes.length; i += 3)
        colors.push({ index: i / 3, color: [bytes[i]!, bytes[i + 1]!, bytes[i + 2]!] });
      const from = ch.sent.length;
      await drv.setPerKeyLighting(colors);
      compared.push(
        compare(
          step.id,
          'per-key colours',
          pic.map((c) => c.data),
          ch.writes(from),
          KB_CMD.SET_USERPIC,
        ),
      );
    }

    const macro = sets.filter((x) => x.data[0] === KB_CMD.SET_MACRO);
    // One macro per slot (frame byte 1): Shark Deck's own decoder reads its
    // steps, its writer writes them again to the same slot.
    for (const slot of [...new Set(macro.map((x) => x.data[1]!))]) {
      const own = macro.filter((x) => x.data[1] === slot);
      const m = decodeMacro('onboard', 'Onboard macro', macroPayloadOf(own.map((x) => x.data)));
      const from = ch.sent.length;
      await drv.saveMacro(m, slot);
      const steps = m.steps.filter((s) => s.type !== 'delay').length;
      compared.push(
        compare(
          step.id,
          `macro ${slot + 1} (${steps} key steps, repeat ${m.repeatCount})`,
          own.map((x) => x.data),
          ch.writes(from),
          KB_CMD.SET_MACRO,
        ),
      );
    }

    if (sets.some((x) => x.data[0] === KB_CMD.SET_MULTI_MAGNETISM)) {
      const before = mag.until(messages[0]!.t);
      const after = mag.until(messages[messages.length - 1]!.t + 1);
      const official = sets.filter((x) => x.data[0] === KB_CMD.SET_MULTI_MAGNETISM).length;
      compared.push(await redoMagnetism(step.id, official, before, after, drv, ch, layout));
    }
  }
  if (compared.length) out.push('Each change made again by Shark Deck:', '', ...compared, '');
  return out;
}

/** One register, as Shark Deck reads it and writes it. `redo` says what it read. */
const REGISTERS: Array<{
  set: number;
  get: number;
  what: string;
  redo: (drv: Driver) => Promise<string | null>;
}> = [
  {
    set: KB_CMD.SET_REPORT,
    get: KB_CMD.GET_REPORT,
    what: 'polling rate',
    redo: async (drv) => {
      const hz = await drv.readPollRate();
      if (hz === null) return 'unreadable';
      await drv.setPollRate(hz);
      return `${hz} Hz`;
    },
  },
  {
    set: KB_CMD.SET_LEDPARAM,
    get: KB_CMD.GET_LEDPARAM,
    what: 'lighting',
    redo: async (drv) => {
      const [l] = await drv.readLighting();
      if (!l) return 'unreadable';
      await drv.setLighting(l);
      return l.effect;
    },
  },
  {
    set: KB_CMD.SET_SLEDPARAM,
    get: KB_CMD.GET_SLEDPARAM,
    what: 'side light',
    redo: async (drv) => {
      const l = await drv.readSideLighting();
      if (!l) return 'unreadable';
      await drv.setSideLighting(l);
      return l.enabled ? l.effect : 'Off';
    },
  },
  {
    set: KB_CMD.SET_KBOPTION,
    get: KB_CMD.GET_KBOPTION,
    what: 'keyboard options',
    redo: async (drv) => {
      const o = await drv.readKeyboardOptions();
      if (!o) return 'unreadable';
      await drv.setKeyboardOptions(o);
      return null;
    },
  },
  {
    set: KB_CMD.SET_PROFILE,
    get: KB_CMD.GET_PROFILE,
    what: 'profile',
    redo: async (drv) => {
      const p = await drv.getActiveProfile();
      if (p === null) return 'unreadable';
      await drv.setActiveProfile(p);
      return String(p);
    },
  },
];

/**
 * The magnetism pages as the official software left them, at any moment of
 * the recording: its page reads say what the board held, its writes what it
 * changed. `until(t)` feeds every message before `t`; times only go forward.
 */
function magnetismFeed(messages: readonly HidMessage[]) {
  const board = new MagBoard();
  let fed = 0;
  let query: Uint8Array | null = null;
  return {
    until(t: number): MagBoard {
      for (; fed < messages.length && messages[fed]!.t < t; fed++) {
        const m = messages[fed]!;
        if (!m.out) continue;
        if (m.kind === 'set-feature') {
          query = m.data;
          if (m.data[0] === KB_CMD.SET_MULTI_MAGNETISM) board.write(m.data);
        } else if (m.kind === 'get-feature' && query?.[0] === KB_CMD.GET_MULTI_MAGNETISM) {
          board.read(query, m.data);
          query = null;
        }
      }
      return board.clone();
    },
  };
}

/**
 * One step's magnetic change, made again by Shark Deck: its reader decodes
 * every key before and after, its writer writes the keys that changed, and
 * the board it leaves is held to the official one, key by key, on the pages
 * each key's mode makes count.
 */
async function redoMagnetism(
  id: string,
  officialFrames: number,
  before: MagBoard,
  after: MagBoard,
  drv: Driver,
  ch: ReplayChannel,
  layout: readonly KeyLayoutEntry[],
): Promise<string> {
  const keys = new Map(
    layout.filter((k) => k.slot !== undefined).map((k) => [k.slot!, k.label] as const),
  );
  const pages = [...new Set([...before.pageList(), ...after.pageList()])];
  const changed = [...keys.keys()].some((slot) =>
    pages.some((p) => {
      const a = after.value(p, slot);
      const b = before.value(p, slot);
      return a !== undefined && b !== undefined && a !== b;
    }),
  );
  if (!changed)
    return `- ${id}, magnetic settings: nothing changed on the drawn keys (the official software wrote back what it held).`;

  ch.board = after.clone();
  const keysAfter = await drv.readMagnetic();
  ch.board = before.clone();
  const keysBefore = await drv.readMagnetic();
  const differ = (a?: MagneticKeySettings, b?: MagneticKeySettings) =>
    JSON.stringify(a) !== JSON.stringify(b);
  const which = keysAfter.map((_, i) => i).filter((i) => differ(keysAfter[i], keysBefore[i]));

  // Shark Deck writes, onto the board as it was; its writes change it.
  ch.board = before.clone();
  const from = ch.sent.length;
  const errors: string[] = [];
  if (which.length) {
    const r = await drv.setMagneticKeys(
      which.map((i) => keysAfter[i]!),
      which.map((i) => keysBefore[i]!),
    );
    if (!r.ok) errors.push(r.error ?? 'refused');
  }
  const switches = [...keys.keys()].filter(
    (slot) => after.value(MAG_PAGE.SWITCH, slot) !== before.value(MAG_PAGE.SWITCH, slot),
  );
  if (switches.length) {
    const r = await drv.setSwitchTypes(
      switches.map((slot) => ({ slot, switchId: after.value(MAG_PAGE.SWITCH, slot) ?? 0 })),
    );
    if (!r.ok) errors.push(r.error ?? 'refused');
  }
  const ours = ch.board;
  ch.board = null;
  const ourFrames = ch.writes(from).filter((f) => f[0] === KB_CMD.SET_MULTI_MAGNETISM).length;

  // Key by key, the pages its mode makes count: the official value against Shark Deck's.
  const diffs = new Map<string, string[]>();
  for (const [slot, label] of keys) {
    const mode = after.value(MAG_PAGE.MODE, slot);
    if (mode === undefined) continue;
    for (const p of livePages(mode)) {
      const a = after.value(p, slot);
      const o = ours.value(p, slot);
      if (a === undefined || a === o) continue;
      // A page nothing had read, that Shark Deck did not write either: no telling.
      if (o === undefined) continue;
      const what = `${PAGE_NAME[p] ?? `page ${p}`}: official ${shown(p, a)}, Shark Deck ${shown(p, o)}`;
      diffs.set(what, [...(diffs.get(what) ?? []), label]);
    }
  }
  const counts = `official ${officialFrames} frame${officialFrames === 1 ? '' : 's'}, Shark Deck ${ourFrames}`;
  if (errors.length)
    return `- ${id}, magnetic settings: **Shark Deck refused**: ${errors.join('; ')}.`;
  if (!diffs.size) return `- ${id}, magnetic settings: the same on the board (${counts}).`;
  const named = (labels: string[]) =>
    labels.length > 6
      ? `${labels.slice(0, 6).join(', ')} and ${labels.length - 6} more`
      : labels.join(', ');
  return (
    `- ${id}, magnetic settings: **differs** (${counts}): ` +
    [...diffs].map(([what, labels]) => `${what} (${named(labels)})`).join('; ') +
    '.'
  );
}

/** A page value as a person reads it: travel in mm (at the ×200 these boards
 *  use), the rest as the byte it is. */
function shown(page: number, v: number): string {
  if (TRAVEL_PAGES.has(page)) return `${Math.round((v / 200) * 1000) / 1000} mm`;
  return `0x${v.toString(16)}`;
}

/** The official frames of one change beside Shark Deck's of the same command. */
function compare(
  step: string,
  what: string,
  official: readonly Uint8Array[],
  sharkDeck: readonly Uint8Array[],
  cmd: number,
): string {
  const ours = sharkDeck.filter((f) => f[0] === cmd);
  if (!ours.length) return `- ${step}, ${what}: **Shark Deck sends no such command for it**.`;
  if (ours.length === official.length && ours.every((f, i) => sameBytes(f, official[i]!)))
    return `- ${step}, ${what}: the same ${official.length === 1 ? 'frame' : `${official.length} frames`}.`;
  const first = ours.findIndex((f, i) => !official[i] || !sameBytes(f, official[i]!));
  const at = Math.max(0, Math.min(first, official.length - 1));
  return (
    `- ${step}, ${what}: **differs**. Official, ${official.length} frame${official.length === 1 ? '' : 's'}: \`${short(official[at]!)}\`; ` +
    `Shark Deck, ${ours.length} frame${ours.length === 1 ? '' : 's'}: \`${short(ours[Math.min(at, ours.length - 1)]!)}\`.`
  );
}
