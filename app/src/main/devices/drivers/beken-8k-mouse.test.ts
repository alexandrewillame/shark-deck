import { describe, expect, it, vi } from 'vitest';
import type { ButtonMapping, DpiStage } from '@shared/types/mouse-settings';

vi.mock('node-hid', () => ({
  default: { devicesAsync: async () => [], HIDAsync: { open: vi.fn() } },
}));

const {
  Beken8kCableMouse,
  Beken8kMouse,
  BekenX11Mouse,
  BEKEN_8K_POLL,
  SEED_BUTTONS,
  bekenFrame,
  decodeBekenButton,
  decodeBekenDpi,
  decodeX11Dpi,
  encodeBekenButton,
  encodeBekenDpi,
  encodeX11Dpi,
  parseX11Settings,
} = await import('./beken-8k-mouse');
const { bekenMouseRoster } = await import('../catalog/beken-mice');

/**
 * Every frame here is verbatim from the owner's recording of the vendor's
 * "Attack Shark Software" 1.0.0.2 against an X8 PRO on its 8K receiver
 * (1D57:FA65, 2026-11-16). Each write starts from the block as the recording
 * had it just before, so the frame Shark Deck builds must be that step's
 * frame byte for byte — encodings and both checksums included.
 */

const frame = (hex: string): Uint8Array => {
  const f = new Uint8Array(64);
  f.set(hex.split(' ').map((h) => parseInt(h, 16)));
  return f;
};
const hexOf = (f: Uint8Array) => [...f].map((b) => b.toString(16).padStart(2, '0')).join(' ');

const COLOURS_ETC =
  '00 00 00 00 00 00 00 01 00 00 01 ff 00 00 00 ff 00 00 00 ff ff ff 00 00 ff ff ff 00 ff ff 40 00 ff ff ff 02';
const REC = {
  dpiTour: `04 3d 00 04 38 01 01 01 3f 20 00 0e 0f 3f 6f 9f 8f ${COLOURS_ETC} 0f 91 00 00 00 00 10 af`,
  dpi400: `04 3d 00 04 38 01 01 01 3f 20 00 07 0f 3f 6f 9f 8f ${COLOURS_ETC} 0f 8a 00 00 00 00 10 a1`,
  dpi50: `04 3d 00 04 38 01 01 01 3f 20 00 00 0f 3f 6f 9f 8f ${COLOURS_ETC} 0f 83 00 00 00 00 10 93`,
  dpi12000: `04 3d 00 04 38 01 01 01 3f 20 00 ef 0f 3f 6f 9f 8f ${COLOURS_ETC} 10 72 00 00 00 00 11 72`,
  dpiMax:
    '04 3d 00 04 38 01 01 01 3f 21 00 8f 0f 3f 6f 9f 8f 00 00 01 00 00 00 00 01 00 00 01 ff 00 00 00 ff 00 00 00 ff ff ff 00 00 ff ff ff 00 ff ff 40 00 ff ff ff 02 10 14 00 00 00 00 10 b6',
  dpiS2_1200: `04 3d 00 04 38 01 01 01 3f 20 00 0e 17 3f 6f 9f 8f ${COLOURS_ETC} 0f 99 00 00 00 00 10 bf`,
  lodHigh: `04 3d 00 04 38 01 11 01 3f 20 00 0e 0f 3f 6f 9f 8f ${COLOURS_ETC} 0f a1 00 00 00 00 10 cf`,
  angleOn: `04 3d 00 04 38 01 01 11 3f 20 00 0e 0f 3f 6f 9f 8f ${COLOURS_ETC} 0f a1 00 00 00 00 10 cf`,
  rippleOff: `04 3d 00 04 38 01 00 01 3f 20 00 0e 0f 3f 6f 9f 8f ${COLOURS_ETC} 0f 90 00 00 00 00 10 ad`,
  motionOff: `04 3d 00 04 38 01 00 00 3f 20 00 0e 0f 3f 6f 9f 8f ${COLOURS_ETC} 0f 8f 00 00 00 00 10 ab`,
  powerTour: '04 14 00 05 0f 01 00 03 a8 00 ff 00 01 04 01 af 00 00 02 8c',
  powerDeb4: '04 14 00 05 0f 01 00 03 a8 00 ff 00 01 02 01 ad 00 00 02 88',
  powerSleep10: '04 14 00 05 0f 01 00 03 a8 00 ff 00 14 02 01 c0 00 00 02 ae',
};
const POLL_REC: Record<number, string> = {
  125: '04 0e 00 06 09 01 14 eb 00 00 00 00 01 21',
  250: '04 0e 00 06 09 01 24 db 00 00 00 00 01 21',
  500: '04 0e 00 06 09 01 34 cb 00 00 00 00 01 21',
  1000: '04 0e 00 06 09 01 44 bb 00 00 00 00 01 21',
  2000: '04 0e 00 06 09 01 54 ab 00 00 00 00 01 21',
  4000: '04 0e 00 06 09 01 64 9b 00 00 00 00 01 21',
  8000: '04 0e 00 06 09 01 74 8b 00 00 00 00 01 21',
};
/** The button block with slots 4 (Backward) and 5 (Forward) as given, and the recorded sums. */
const buttons = (slot4: string, slot5: string, sums: string) =>
  `04 40 00 08 3b 01 02 00 00 03 00 00 04 00 00 0d 00 00 ${slot4} ${slot5} 3c 00 00 ` +
  `${'01 00 00 '.repeat(9)}0a 00 00 09 00 00 ${sums}`;
const BTN_DEFAULT =
  '04 40 00 08 3b 01 02 00 00 03 00 00 04 00 00 0d 00 00 05 00 00 06 00 00 3c 00 00 01 00 00 01 00 00 01 00 00 01 00 00 01 00 00 01 00 00 01 00 00 01 00 00 01 00 00 0a 00 00 09 00 00 00 79 01 7a';

const ACK_GOT = frame('04 06 c0 01 00 cb');
const ACK_DONE = frame('04 06 c1 01 00 cc');
const ACK_REFUSED = frame('04 06 c1 00 00 cb');

/** A channel whose receiver answers every frame with `answers`, and a kept-state store. */
function rig(answers: Uint8Array[] = [ACK_GOT, ACK_DONE], kept: Record<string, number[]> = {}) {
  const sent: Uint8Array[] = [];
  const queue: Uint8Array[] = [];
  const io = {
    write: async (f: Uint8Array) => {
      sent.push(f);
      queue.push(...answers);
    },
    read: async () => queue.shift() ?? null,
    readInput: async () => null,
    request: async () => null,
  };
  const store = new Map<string, unknown>(Object.entries(kept).map(([k, v]) => [`beken8k.${k}`, v]));
  const state = {
    get: async (k: string) => store.get(k),
    set: async (k: string, v: unknown) => void store.set(k, v),
  };
  const channel = {
    transaction: <T>(fn: (x: typeof io) => Promise<T>) => fn(io),
    descriptorRelease: 0x0118,
  };
  const drv = new Beken8kMouse({
    descriptor: bekenMouseRoster()[0]!,
    channel: channel as never,
    onWarning: () => undefined,
    state,
  });
  Object.assign(drv as unknown as Record<string, number>, { minGapMs: 0, ackTimeoutMs: 40 });
  return { drv, sent, store, queue };
}

/** A block's data bytes as the recorded frame carries them. */
const dpiData = (hex: string) => [...frame(hex).subarray(6, 53)];
const powerData = (hex: string) => [...frame(hex).subarray(6, 14)];

const withStage = (stages: DpiStage[], i: number, dpi: number) =>
  stages.map((s) => (s.index === i ? { ...s, dpi } : s));

describe('Beken 8K receiver frames', () => {
  it('builds every recorded polling frame', () => {
    for (const [hz, hex] of Object.entries(POLL_REC)) {
      const code = BEKEN_8K_POLL[Number(hz)]!;
      expect(hexOf(bekenFrame(0x06, [code, 0xff - code, 0, 0, 0, 0])), `${hz} Hz`).toBe(
        hexOf(frame(hex)),
      );
    }
  });

  it('never builds a command the recording does not show', () => {
    for (const cmd of [0x09, 0x0b, 0x0c, 0x10, 0xa0]) {
      expect(() => bekenFrame(cmd, [])).toThrow(/never sent/);
    }
  });

  it('encodes DPI in 50s, and above 12750 in doubled 100s (40000 as recorded)', () => {
    expect(encodeBekenDpi(50)).toEqual({ raw: 0, doubled: false });
    expect(encodeBekenDpi(12000)).toEqual({ raw: 239, doubled: false });
    expect(encodeBekenDpi(40000)).toEqual({ raw: 399, doubled: true });
    expect(encodeBekenDpi(99999)).toEqual({ raw: 399, doubled: true });
    for (const dpi of [50, 750, 12750, 12800, 26000, 40000]) {
      const { raw, doubled } = encodeBekenDpi(dpi);
      expect(decodeBekenDpi(raw, doubled)).toBe(dpi);
    }
  });
});

describe('Beken8kMouse writes, against the recording', () => {
  it('sends each DPI step the vendor software sent', async () => {
    const cases: [number, number, string][] = [
      [0, 400, REC.dpi400],
      [0, 50, REC.dpi50],
      [0, 12000, REC.dpi12000],
      [0, 40000, REC.dpiMax],
      [1, 1200, REC.dpiS2_1200],
    ];
    for (const [stage, dpi, hex] of cases) {
      const { drv, sent } = rig(undefined, { dpi: dpiData(REC.dpiTour) });
      const stages = await drv.readDpiStages();
      expect(stages.map((s) => s.dpi)).toEqual([750, 800, 3200, 5600, 8000, 40000]);
      const r = await drv.setDpiStages(withStage(stages, stage, dpi));
      expect(r).toMatchObject({ ok: true, verified: 'match' });
      expect(hexOf(sent[0]!), `stage ${stage + 1} = ${dpi}`).toBe(hexOf(frame(hex)));
    }
  });

  it('sends the sensor switches as recorded', async () => {
    const cases: [Parameters<InstanceType<typeof Beken8kMouse>['setSensor']>[0], string][] = [
      [{ lod: 1 }, REC.lodHigh],
      [{ angleSnapping: true }, REC.angleOn],
      [{ rippleControl: false }, REC.rippleOff],
    ];
    for (const [s, hex] of cases) {
      const { drv, sent } = rig(undefined, { dpi: dpiData(REC.dpiTour) });
      await drv.setSensor(s);
      expect(hexOf(sent[0]!), JSON.stringify(s)).toBe(hexOf(frame(hex)));
    }
    const { drv, sent } = rig(undefined, { dpi: dpiData(REC.rippleOff) });
    await drv.setSensor({ motionSync: false });
    expect(hexOf(sent[0]!)).toBe(hexOf(frame(REC.motionOff)));
    expect(await drv.readSensor()).toEqual({
      lod: 0,
      rippleControl: false,
      angleSnapping: false,
      motionSync: false,
    });
  });

  it('sends key response and sleep as recorded, the other bytes unchanged', async () => {
    const a = rig(undefined, { power: powerData(REC.powerTour) });
    expect(await a.drv.readDebounce()).toBe(8);
    await a.drv.setDebounce(4);
    expect(hexOf(a.sent[0]!)).toBe(hexOf(frame(REC.powerDeb4)));

    const b = rig(undefined, { power: powerData(REC.powerDeb4) });
    await b.drv.setPower({ sleepTimerSec: 600 });
    expect(hexOf(b.sent[0]!)).toBe(hexOf(frame(REC.powerSleep10)));
    expect(await b.drv.readPower()).toEqual({ sleepTimerSec: 600, never: false });
  });

  it('sends every recorded polling step', async () => {
    for (const [hz, hex] of Object.entries(POLL_REC)) {
      const { drv, sent } = rig();
      await drv.setPollRate(Number(hz));
      expect(hexOf(sent[0]!)).toBe(hexOf(frame(hex)));
      expect(await drv.readPollRate()).toBe(Number(hz));
    }
  });

  it('remaps Forward (button 4, slot 5) to each recorded action', async () => {
    const cases: [ButtonMapping, string, string][] = [
      [{ actionKey: 'button', action: 1, param: 0x0400 }, '04 00 00', '00 77 01 76'],
      [{ actionKey: 'button', action: 1, param: 0x0200 }, '03 00 00', '00 76 01 74'],
      [{ actionKey: 'combo', action: 5, combo: [0x04] }, '11 00 04', '00 88 01 98'],
      [{ actionKey: 'combo', action: 5, combo: [0xe0, 0x06] }, '11 01 06', '00 8b 01 9e'],
      [{ actionKey: 'multimedia', action: 5, multimedia: 0xe9 }, '1b 00 00', '00 8e 01 a4'],
      [{ actionKey: 'multimedia', action: 5, multimedia: 0xea }, '1c 00 00', '00 8f 01 a6'],
      [{ actionKey: 'multimedia', action: 5, multimedia: 0xcd }, '18 00 00', '00 8b 01 9e'],
      [{ actionKey: 'multimedia', action: 5, multimedia: 0xb5 }, '17 00 00', '00 8a 01 9c'],
      [{ actionKey: 'dpiSwitch', action: 2, param: 0x0200 }, '0e 00 00', '00 81 01 8a'],
      [{ actionKey: 'dpiSwitch', action: 2, param: 0x0300 }, '0f 00 00', '00 82 01 8c'],
      [{ actionKey: 'scrollUD', action: 0x0b, param: 0x0100 }, '09 00 00', '00 7c 01 80'],
      [{ actionKey: 'disable', action: 0 }, '01 00 00', '00 74 01 70'],
      [{ actionKey: 'button', action: 1, param: 0x1000 }, '06 00 00', '00 79 01 7a'],
    ];
    expect(hexOf(frame(buttons('05 00 00', '06 00 00', '00 79 01 7a')))).toBe(
      hexOf(frame(BTN_DEFAULT)),
    );
    for (const [m, slot5, sums] of cases) {
      const { drv, sent } = rig();
      const r = await drv.setButtonMapping(3, m);
      expect(r.ok, JSON.stringify(m)).toBe(true);
      expect(hexOf(sent[0]!), JSON.stringify(m)).toBe(
        hexOf(frame(buttons('05 00 00', slot5, sums))),
      );
    }
  });

  it('remaps Backward (button 5, slot 4) as recorded', async () => {
    // Slot 4 is the rear side button (button 5): the tool called it "button 4
    // (Back)" then, and the owner's test of the first build showed it.
    const { drv, sent } = rig();
    await drv.setButtonMapping(4, { actionKey: 'combo', action: 5, combo: [0x05] });
    expect(hexOf(sent[0]!)).toBe(hexOf(frame(buttons('11 00 05', '06 00 00', '00 8a 01 9c'))));
  });

  it('reads back the default buttons as Shark Deck names them', async () => {
    const { drv } = rig();
    expect(await drv.readButtons()).toEqual({
      0: { actionKey: 'button', action: 0x02, param: 0x0100 },
      1: { actionKey: 'button', action: 0x03, param: 0x0200 },
      2: { actionKey: 'button', action: 0x04, param: 0x0400 },
      3: { actionKey: 'button', action: 0x06, param: 0x1000 },
      4: { actionKey: 'button', action: 0x05, param: 0x0800 },
      5: { actionKey: 'dpiSwitch', action: 0x0d, param: 0x0100 },
    });
    expect(SEED_BUTTONS.length).toBe(54);
    expect(decodeBekenButton([0x11, 0x01, 0x06])).toEqual({
      actionKey: 'combo',
      action: 0x11,
      combo: [0xe0, 0x06],
    });
  });
});

describe('Beken8kMouse: what it keeps, and when', () => {
  it('keeps a block only once the mouse confirmed it', async () => {
    const ok = rig();
    await ok.drv.setPollRate(500);
    expect(ok.store.get('beken8k.poll')).toEqual([0x34]);

    const refused = rig([ACK_GOT, ACK_REFUSED]);
    const r = await refused.drv.setPollRate(500);
    expect(r).toMatchObject({ ok: false, verified: 'unverified' });
    expect(r.error).toMatch(/did not confirm/);
    expect(refused.store.has('beken8k.poll')).toBe(false);
    expect(await refused.drv.readPollRate()).toBe(1000);

    const silent = rig([]);
    expect((await silent.drv.setPollRate(500)).error).toMatch(/receiver did not answer/);
  });

  it('drops answers still queued from earlier frames before sending', async () => {
    const { drv, queue } = rig([ACK_GOT, ACK_REFUSED]);
    queue.push(ACK_DONE);
    expect((await drv.setPollRate(250)).ok).toBe(false);
  });

  it('paces frames at least the gap apart', async () => {
    const { drv } = rig();
    Object.assign(drv as unknown as Record<string, number>, { minGapMs: 60 });
    const t0 = Date.now();
    await drv.setPollRate(500);
    await drv.setPollRate(1000);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(55);
  });

  it('refuses what this mouse cannot do, without sending anything', async () => {
    const { drv, sent } = rig();
    expect((await drv.setPollRate(300)).ok).toBe(false);
    expect(
      (await drv.setButtonMapping(4, { actionKey: 'multimedia', action: 5, multimedia: 0x0183 }))
        .ok,
    ).toBe(false);
    expect(
      (await drv.setButtonMapping(4, { actionKey: 'combo', action: 5, combo: [0x04, 0x05] })).ok,
    ).toBe(false);
    expect((await drv.setButtonMapping(4, { actionKey: 'combo', action: 5, combo: [] })).ok).toBe(
      false,
    );
    expect((await drv.setButtonMapping(4, { actionKey: 'macro', action: 6 })).ok).toBe(false);
    expect((await drv.setButtonMapping(6, { actionKey: 'disable', action: 0 })).ok).toBe(false);
    expect((await drv.setSensor({ lod: 2 })).ok).toBe(false);
    expect(sent).toEqual([]);
    expect(encodeBekenButton({ actionKey: 'firepower', action: 4 })).toMatch(/no such/);
  });

  it('turns stages off with the mask, and reads them back off', async () => {
    const { drv, sent } = rig();
    const stages = await drv.readDpiStages();
    expect(stages.map((s) => s.dpi)).toEqual([800, 1600, 3200, 5600, 8000, 40000]);
    await drv.setDpiStages(stages.map((s) => ({ ...s, enabled: s.index < 4 })));
    expect(sent[0]![8]).toBe(0x0f);
    expect((await drv.readDpiStages()).map((s) => s.enabled)).toEqual([
      true,
      true,
      true,
      true,
      false,
      false,
    ]);
  });

  it('backs up nothing, names everything it cannot read, and sends nothing to poll', async () => {
    const { drv, sent } = rig();
    expect(await drv.backup()).toEqual({});
    const p = drv.backupPolicy();
    expect(p).toMatchObject({ kind: 'partial', required: [] });
    expect(p.unreadable).toEqual(expect.arrayContaining(['dpi', 'pollRate', 'buttonRemap']));
    expect(await drv.ping()).toBe(true);
    expect(await drv.getFirmware()).toEqual({
      device: null,
      receiver: 'v1.18',
      receiverRaw: 0x0118,
    });
    expect(sent).toEqual([]);
  });
});

/**
 * The cable (1D57:2126), from its owner's second recording (2026-11-19): the
 * same blocks as feature reports, readable. The rig answers each read the way
 * the mouse did: `a0 01` to the request, then the block as it was just before
 * the recorded step.
 */
describe('Beken8kCableMouse, against the cable recording', () => {
  const bytes = (hex: string) => Uint8Array.from(hex.split(' ').map((h) => parseInt(h, 16)));
  const READY = bytes('a0 01 00 00 00 00 00 00');
  const DPI_400_BEFORE =
    '04 38 01 11 00 3f 10 00 1f 0e ae c7 8f 05 00 00 00 00 00 00 01 00 00 00 01 ff 00 00 00 ff 00 00 00 ff ff ff 00 00 ff ff ff 00 ff ff 40 00 ff ff ff 02 0f cd 00 00 00 00';
  const DPI_400 =
    '04 38 01 11 00 3f 10 00 07 0e ae c7 8f 05 00 00 00 00 00 00 01 00 00 00 01 ff 00 00 00 ff 00 00 00 ff ff ff 00 00 ff ff ff 00 ff ff 40 00 ff ff ff 02 0f b5';
  const btn = (slot4: string, slot5: string, sum: string) =>
    `08 3b 01 02 00 00 03 00 00 04 00 00 0d 00 00 ${slot4} ${slot5} 3c 00 00 ` +
    `${'01 00 00 '.repeat(9)}0a 00 00 09 00 00 ${sum}`;

  function cableRig(blocks: Record<number, string>) {
    const sent: Uint8Array[] = [];
    const io = {
      write: async (f: Uint8Array) => void sent.push(f),
      read: async () => null,
      readFeature: async (id: number) =>
        id === 0xa0 ? READY : blocks[id] ? bytes(blocks[id]!) : null,
      readInput: async () => null,
      request: async () => null,
    };
    const channel = {
      transaction: <T>(fn: (x: typeof io) => Promise<T>) => fn(io),
      write: io.write,
      descriptorRelease: 0x1103,
    };
    const store = new Map<string, unknown>();
    const drv = new Beken8kCableMouse({
      descriptor: bekenMouseRoster()[1]!,
      channel: channel as never,
      onWarning: () => undefined,
      state: {
        get: async (k: string) => store.get(k),
        set: async (k: string, v: unknown) => void store.set(k, v),
      },
    });
    /** The blocks written, read requests left out. */
    const writes = () => sent.filter((f) => f[0] !== 0xa0).map(hexOf);
    return { drv, sent, writes };
  }

  it('is the same model on its cable, read through feature reports', () => {
    const [receiver, cable] = bekenMouseRoster();
    expect(cable!.model).toBe(receiver!.model);
    expect([cable!.pid, cable!.usagePage, cable!.usage, cable!.transport]).toEqual([
      0x2126,
      0x000b,
      0x0000,
      'feature-report',
    ]);
    expect(cable!.spec.pollRates).toEqual([125, 250, 500, 1000]);
  });

  it('reads the DPI block the way the vendor software does, and sends the recorded DPI step', async () => {
    const { drv, sent, writes } = cableRig({ 0x04: DPI_400_BEFORE });
    const stages = await drv.readDpiStages();
    expect(hexOf(sent[0]!)).toBe('a0 04 38 00 01 00 00 00');
    expect(stages.map((s) => s.dpi)).toEqual([1600, 750, 8750, 10000, 40000, 300]);
    // Stage 1 is green on the mouse, stage 6 orange-red (colour entries 1–6).
    expect(stages[0]!.color).toEqual([0x00, 0xff, 0x00]);
    expect(stages[5]!.color).toEqual([0xff, 0x40, 0x00]);
    const r = await drv.setDpiStages(withStage(stages, 0, 400));
    expect(writes()).toEqual([DPI_400]);
    expect(r.ok).toBe(true);
  });

  it('keeps the active stage the mouse reports, where the receiver could only resend its own', async () => {
    // Stage 2 active on the mouse (byte 24): a sensor change must not move it back to 1.
    const active2 = DPI_400_BEFORE.replace(
      '00 00 00 01 ff 00 00 00 ff',
      '00 00 00 02 ff 00 00 00 ff',
    ).replace(' 02 0f cd ', ' 02 0f ce ');
    const { drv, writes } = cableRig({ 0x04: active2 });
    await drv.setSensor({ motionSync: true });
    expect(writes()[0]!.split(' ')[24]).toBe('02');
  });

  it('sends sleep, key response and polling as recorded', async () => {
    const a = cableRig({ 0x05: '05 0f 01 00 06 b8 00 ff 00 09 02 01 c8 00 00' });
    await a.drv.setPower({ sleepTimerSec: 30 });
    expect(a.writes()).toEqual(['05 0f 01 00 06 b8 00 ff 00 01 02 01 c0']);
    const b = cableRig({ 0x05: '05 0f 01 00 06 b8 00 ff 00 01 02 01 c0 00 00' });
    await b.drv.setDebounce(50);
    expect(b.writes()).toEqual(['05 0f 01 00 06 b8 00 ff 00 01 19 01 d7']);
    const c = cableRig({ 0x06: '06 09 01 74 8b 00 00 00 00' });
    expect(await c.drv.readPollRate()).toBe(1000);
    await c.drv.setPollRate(125);
    expect(c.writes()).toEqual(['06 09 01 71 8e 00 00 00 00']);
  });

  it('remaps Forward (slot 5) and Backward (slot 4) as recorded', async () => {
    const a = cableRig({});
    await a.drv.setButtonMapping(3, { actionKey: 'button', action: 1, param: 0x0400 });
    expect(a.writes()).toEqual([btn('05 00 00', '04 00 00', '00 77')]);
    const b = cableRig({});
    await b.drv.setButtonMapping(4, { actionKey: 'combo', action: 5, combo: [0x05] });
    expect(b.writes()).toEqual([btn('11 00 05', '06 00 00', '00 8a')]);
  });

  it('names the release the mouse firmware', async () => {
    const { drv } = cableRig({});
    expect(await drv.getFirmware()).toEqual({ device: 'v11.03', receiver: null });
  });
});

/**
 * The X11 on its cable (1D57:FA55), from its owner's recording of the vendor
 * software (2026-11-19, issue #2). Every frame expected here is verbatim from
 * it. The software read the mouse once (report 10, AT_START); each recorded
 * change then sent a block that differs from that read only by the change, so
 * the same change made from the same read must send that frame byte for byte.
 */
describe('BekenX11Mouse, against the X11 recording', () => {
  const bytes = (hex: string) => Uint8Array.from(hex.split(' ').map((h) => parseInt(h, 16)));
  const READY = bytes('a0 01 00 00 00 00 00 00');
  /** Report 10 as the mouse answered at start.open. */
  const AT_START =
    '0a 80 01 01 fe 00 00 3f 20 20 12 25 38 4b 75 81 01 01 00 00 00 00 00 01 00 00 01 ff 00 00 00 ff 00 00 00 ff ff ff 00 00 ff ff ff 00 ff ff 40 00 ff ff ff 02 00 68 0f 30 01 38 ff 78 00 02 02 e4 01 02 00 00 03 00 00 04 00 00 00 00 00 00 00 00 0d 00 00 06 00 00 05 00 00 ' +
    '00 '.repeat(24) +
    '09 00 00 0a 00 00 34' +
    ' 00'.repeat(8);
  const RGB = 'ff 00 00 00 ff 00 00 00 ff ff ff 00 00 ff ff ff 00 ff ff 40 00 ff ff ff 02';
  /** A recorded DPI frame: its first 22 data bytes (switches to active stage), the colours, its sum. */
  const dpi = (head: string, sum: string) => `04 38 01 ${head} ${RGB} ${sum}`;
  /** A recorded button frame: slots 6 and 7 as given, the rest as the software sends them. */
  const btn = (slot6: string, slot7: string, sum: string) =>
    `08 3b 01 02 00 00 03 00 00 04 00 00 01 00 00 01 00 00 0d 00 00 ${slot6} ${slot7} ` +
    `${'01 00 00 '.repeat(8)}09 00 00 0a 00 00 ${sum}`;

  /** Report 10 from its blocks, laid out as AT_START is (the first test holds it to that). */
  function report10(poll: number, d: number[], p: number[], b: number[]): string {
    const le = (x: number[]) => {
      const s = x.reduce((a, v) => a + v, 0) & 0xffff;
      return [s & 0xff, s >> 8];
    };
    const r = [0x0a, 0x80, 0x01, poll, 0xff - poll, ...d, 0x00, ...le(d), ...p, ...le(p)];
    r.push(...b, ...le(b));
    return hexOf(Uint8Array.from([...r, ...new Array<number>(128 - r.length).fill(0)]));
  }
  const START = parseX11Settings(bytes(AT_START));

  /**
   * A mouse that answers report 10 with `answer` and keeps every block it is
   * sent (null: one that never answers). `refuseFirstAsk` turns down the first
   * read request, as the mouse did the vendor software's.
   */
  function x11Rig(answer: string | null, refuseFirstAsk = false) {
    const sent: Uint8Array[] = [];
    let refused = !refuseFirstAsk;
    let now = answer;
    const io = {
      write: async (f: Uint8Array) => {
        if (f[0] === 0xa0 && !refused) {
          refused = true;
          throw new Error('could not send feature report to device');
        }
        sent.push(f);
        if (!now || f[0] === 0xa0) return;
        const m = parseX11Settings(bytes(now));
        const data = (n: number) => [...f.subarray(3, 3 + n)];
        if (f[0] === 0x04) m.dpi = data(47);
        if (f[0] === 0x05) m.power = data(8);
        if (f[0] === 0x08) m.buttons = data(54);
        if (f[0] === 0x06) m.poll = [f[3]!];
        now = report10(m.poll![0]!, m.dpi!, m.power!, m.buttons!);
      },
      read: async () => null,
      readFeature: async (id: number) =>
        id === 0xa0 ? READY : id === 0x0a && now ? bytes(now) : null,
      readInput: async () => null,
      request: async () => null,
    };
    const channel = {
      transaction: <T>(fn: (x: typeof io) => Promise<T>) => fn(io),
      write: io.write,
      descriptorRelease: 0x0110,
    };
    const store = new Map<string, unknown>();
    const drv = new BekenX11Mouse({
      descriptor: bekenMouseRoster().find((d) => d.model === 'attack-shark-x11')!,
      channel: channel as never,
      onWarning: () => undefined,
      state: {
        get: async (k: string) => store.get(k),
        set: async (k: string, v: unknown) => void store.set(k, v),
      },
    });
    Object.assign(drv as unknown as Record<string, number>, { readWaitMs: 0 });
    const writes = () => sent.filter((f) => f[0] !== 0xa0).map(hexOf);
    const asks = () => sent.filter((f) => f[0] === 0xa0).map(hexOf);
    return { drv, writes, asks };
  }
  /** AT_START with one button slot changed, its sum fixed. */
  const startWithSlot = (slot: number, hex: string) => {
    const b = [...START.buttons!];
    b.splice(3 * slot, 3, ...bytes(hex));
    return report10(START.poll![0]!, START.dpi!, START.power!, b);
  };

  it('is the X11 on its cable, driven through feature reports', () => {
    const x11 = bekenMouseRoster().find((d) => d.model === 'attack-shark-x11')!;
    expect([x11.vid, x11.pid, x11.usagePage, x11.usage, x11.transport, x11.driver]).toEqual([
      0x1d57,
      0xfa55,
      0x000b,
      0x0000,
      'feature-report',
      'beken-x11-mouse',
    ]);
    expect(x11.spec.dpi).toMatchObject({ min: 50, max: 22000, stages: 6 });
    expect(x11.spec.pollRates).toEqual([125, 250, 500, 1000]);
  });

  it('reads every block out of report 10, its sums low byte first', () => {
    expect(START.poll).toEqual([0x01]);
    expect(hexOf(Uint8Array.from(START.dpi!))).toBe(
      `00 00 3f 20 20 12 25 38 4b 75 81 01 01 00 00 00 00 00 01 00 00 01 ${RGB}`,
    );
    expect(hexOf(Uint8Array.from(START.power!))).toBe('30 01 38 ff 78 00 02 02');
    // The slots the mouse holds as 00 00 00 come back off (01), as the software sends them.
    expect(hexOf(Uint8Array.from(START.buttons!))).toBe(
      '02 00 00 03 00 00 04 00 00 01 00 00 01 00 00 0d 00 00 06 00 00 05 00 00 ' +
        '01 00 00 '.repeat(8) +
        '09 00 00 0a 00 00',
    );
    // The helper the other tests build answers with lays report 10 out as the mouse did.
    const raw = [...bytes(AT_START).subarray(65, 119)];
    expect(report10(1, START.dpi!, START.power!, raw)).toBe(AT_START);
  });

  it('leaves out a block it cannot trust', () => {
    // Cut at 64 bytes: polling and the DPI block only.
    expect(Object.keys(parseX11Settings(bytes(AT_START).subarray(0, 64))).sort()).toEqual([
      'dpi',
      'poll',
    ]);
    const bad = bytes(AT_START);
    bad[60] = 0x77; // a power byte, its sum unchanged
    expect(parseX11Settings(bad).power).toBeUndefined();
    expect(parseX11Settings(new Uint8Array(128))).toEqual({});
  });

  it('asks once, as the vendor software asks, for a first look at every setting', async () => {
    const { drv, asks } = x11Rig(AT_START);
    const stages = await drv.readDpiStages();
    await Promise.all([drv.readSensor(), drv.readPollRate(), drv.readPower(), drv.readButtons()]);
    expect(asks()).toEqual(['a0 0a 80 00 01 00 00 00']);
    expect(stages.map((s) => s.dpi)).toEqual([800, 1600, 2400, 3200, 5000, 22000]);
    expect(await drv.readPollRate()).toBe(1000);
    expect(await drv.readDebounce()).toBe(4);
    expect(await drv.readPower()).toMatchObject({ sleepTimerSec: 60 });
    expect(await drv.readSensor()).toEqual({ angleSnapping: false, rippleControl: false });
  });

  it('asks again when the mouse turns the first request down', async () => {
    const { drv, asks } = x11Rig(AT_START, true);
    expect((await drv.readDpiStages()).map((s) => s.dpi)[0]).toBe(800);
    expect(asks()).toEqual(['a0 0a 80 00 01 00 00 00']);
  });

  it.each([
    [400, dpi('00 00 3f 20 20 09 25 38 4b 75 81 01 01 00 00 00 00 00 01 00 00 01', '0f 5f')],
    [1600, dpi('00 00 3f 20 20 25 25 38 4b 75 81 01 01 00 00 00 00 00 01 00 00 01', '0f 7b')],
    [3200, dpi('00 00 3f 20 20 4b 25 38 4b 75 81 01 01 00 00 00 00 00 01 00 00 01', '0f a1')],
    [50, dpi('00 00 3f 20 20 01 25 38 4b 75 81 01 01 00 00 00 00 00 01 00 00 01', '0f 57')],
    [1000, dpi('00 00 3f 20 20 17 25 38 4b 75 81 01 01 00 00 00 00 00 01 00 00 01', '0f 6d')],
    [6400, dpi('00 00 3f 20 20 96 25 38 4b 75 81 01 01 00 00 00 00 00 01 00 00 01', '0f ec')],
    [12000, dpi('00 00 3f 20 20 8d 25 38 4b 75 81 01 01 01 00 00 00 00 01 00 00 01', '0f e4')],
    [22000, dpi('00 00 3f 21 21 81 25 38 4b 75 81 01 01 01 00 00 00 00 01 00 00 01', '0f da')],
  ])('sends stage 1 at %i DPI as recorded', async (value, recorded) => {
    const { drv, writes } = x11Rig(AT_START);
    const r = await drv.setDpiStages(withStage(await drv.readDpiStages(), 0, value));
    expect(writes()).toEqual([recorded]);
    expect(r).toMatchObject({ ok: true, verified: 'match' });
    expect((await drv.readDpiStages())[0]!.dpi).toBe(value);
  });

  it('brings a stage back down from the top, and sends stage 2 as recorded', async () => {
    const a = x11Rig(AT_START);
    await a.drv.setDpiStages(withStage(await a.drv.readDpiStages(), 0, 22000));
    await a.drv.setDpiStages(withStage(await a.drv.readDpiStages(), 0, 800));
    expect(a.writes()[1]).toBe(
      dpi('00 00 3f 20 20 12 25 38 4b 75 81 01 01 00 00 00 00 00 01 00 00 01', '0f 68'),
    );
    for (const [value, recorded] of [
      [1200, dpi('00 00 3f 20 20 12 1c 38 4b 75 81 01 01 00 00 00 00 00 01 00 00 01', '0f 5f')],
      [2400, dpi('00 00 3f 20 20 12 38 38 4b 75 81 01 01 00 00 00 00 00 01 00 00 01', '0f 7b')],
    ] as const) {
      const b = x11Rig(AT_START);
      await b.drv.setDpiStages(withStage(await b.drv.readDpiStages(), 1, value));
      expect(b.writes()).toEqual([recorded]);
    }
  });

  it('keeps the stage the mouse has active (byte 24, counted from 1)', async () => {
    const d = [...START.dpi!];
    d[21] = 0x02;
    const { drv, writes } = x11Rig(report10(1, d, START.power!, START.buttons!));
    await drv.setDpiStages(await drv.readDpiStages());
    // dpi.active.2: the software made stage 2 active.
    expect(writes()).toEqual([
      dpi('00 00 3f 20 20 12 25 38 4b 75 81 01 01 00 00 00 00 00 01 00 00 02', '0f 69'),
    ]);
  });

  it('turns angle snapping and ripple control on as recorded', async () => {
    const a = x11Rig(AT_START);
    await a.drv.setSensor({ angleSnapping: true });
    expect(a.writes()).toEqual([
      dpi('01 00 3f 20 20 12 25 38 4b 75 81 01 01 00 00 00 00 00 01 00 00 01', '0f 69'),
    ]);
    const b = x11Rig(AT_START);
    await b.drv.setSensor({ rippleControl: true });
    expect(b.writes()).toEqual([
      dpi('00 01 3f 20 20 12 25 38 4b 75 81 01 01 00 00 00 00 00 01 00 00 01', '0f 69'),
    ]);
  });

  it('sends polling as 1000 ÷ the rate', async () => {
    for (const [hz, recorded] of [
      [125, '06 09 01 08 f7 00 00 00 00'],
      [250, '06 09 01 04 fb 00 00 00 00'],
      [500, '06 09 01 02 fd 00 00 00 00'],
      [1000, '06 09 01 01 fe 00 00 00 00'],
    ] as const) {
      const { drv, writes } = x11Rig(AT_START);
      await drv.setPollRate(hz);
      expect(writes()).toEqual([recorded]);
      expect(await drv.readPollRate()).toBe(hz);
    }
  });

  it('sends key response and sleep as recorded, the lighting in their block kept', async () => {
    const cases: [(d: InstanceType<typeof BekenX11Mouse>) => Promise<unknown>, string][] = [
      [(d) => d.setDebounce(50), '05 0f 01 30 01 38 ff 78 00 02 19 01 fb'],
      [(d) => d.setDebounce(8), '05 0f 01 30 01 38 ff 78 00 02 04 01 e6'],
      [(d) => d.setPower({ sleepTimerSec: 30 }), '05 0f 01 30 01 38 ff 78 00 01 02 01 e3'],
      [(d) => d.setPower({ sleepTimerSec: 1800 }), '05 0f 01 30 01 38 ff 78 00 3c 02 02 1e'],
      [(d) => d.setPower({ sleepTimerSec: 600 }), '05 0f 01 30 01 38 ff 78 00 14 02 01 f6'],
    ];
    for (const [change, recorded] of cases) {
      const { drv, writes } = x11Rig(AT_START);
      await change(drv);
      expect(writes()).toEqual([recorded]);
    }
  });

  it('leaves sleep and key response alone when the mouse does not report them', async () => {
    const { drv, writes } = x11Rig(null);
    expect((await drv.setDebounce(8)).ok).toBe(false);
    expect((await drv.setPower({ sleepTimerSec: 600 })).ok).toBe(false);
    expect(writes()).toEqual([]);
    // What it shows until then: the vendor software's factory settings.
    expect((await drv.readDpiStages()).map((s) => s.dpi)).toEqual([
      800, 1600, 2400, 3200, 5000, 22000,
    ]);
  });

  it('reads button 4 as Forward (slot 6, the front button) and button 5 as Backward (slot 7)', async () => {
    const { drv } = x11Rig(AT_START);
    const b = await drv.readButtons();
    expect(b[3]).toMatchObject({ actionKey: 'button', param: 0x1000 }); // Forward
    expect(b[4]).toMatchObject({ actionKey: 'button', param: 0x0800 }); // Backward
    expect(b[5]).toMatchObject({ actionKey: 'dpiSwitch', param: 0x0100 });
    expect(Object.keys(b)).toHaveLength(6);
  });

  // btn.b4.*: slot 6 changed each time, slot 7 left at Middle click (04) by the step before.
  it.each([
    ['Right click', { actionKey: 'button', action: 1, param: 0x0200 }, '03 00 00', '00 3a'],
    ['key A', { actionKey: 'combo', action: 5, combo: [0x04] }, '11 00 04', '00 4c'],
    ['Ctrl + C', { actionKey: 'combo', action: 5, combo: [0xe0, 0x06] }, '11 01 06', '00 4f'],
    ['Volume up', { actionKey: 'multimedia', action: 4, multimedia: 0xe9 }, '1b 00 00', '00 52'],
    ['Volume down', { actionKey: 'multimedia', action: 4, multimedia: 0xea }, '1c 00 00', '00 53'],
    ['Play / Pause', { actionKey: 'multimedia', action: 4, multimedia: 0xcd }, '18 00 00', '00 4f'],
    ['Next track', { actionKey: 'multimedia', action: 4, multimedia: 0xb5 }, '17 00 00', '00 4e'],
    ['DPI up', { actionKey: 'dpiSwitch', action: 2, param: 0x0200 }, '0e 00 00', '00 45'],
    ['DPI down', { actionKey: 'dpiSwitch', action: 2, param: 0x0300 }, '0f 00 00', '00 46'],
    ['Scroll up', { actionKey: 'scrollUD', action: 3, param: 0x0100 }, '09 00 00', '00 40'],
    ['Disabled', { actionKey: 'disable', action: 0 }, '01 00 00', '00 38'],
    ['Forward', { actionKey: 'button', action: 1, param: 0x1000 }, '06 00 00', '00 3d'],
  ] as [string, ButtonMapping, string, string][])(
    'sends button 4 (front) as %s, in slot 6',
    async (_, mapping, slot6, sum) => {
      const { drv, writes } = x11Rig(startWithSlot(7, '04 00 00'));
      const r = await drv.setButtonMapping(3, mapping);
      expect(writes()).toEqual([btn(slot6, '04 00 00', sum)]);
      expect(r).toMatchObject({ ok: true, verified: 'match' });
    },
  );

  it('sends button 5 (rear) in slot 7: Middle click, then Backward again', async () => {
    const { drv, writes } = x11Rig(AT_START);
    await drv.setButtonMapping(4, { actionKey: 'button', action: 1, param: 0x0400 });
    await drv.setButtonMapping(4, { actionKey: 'button', action: 1, param: 0x0800 });
    // btn.b4.middle (that step named the rear button "Back"), then btn.b4.default's second
    // frame. The owner's btn.b5.key-b went to slot 6, the front button: not a slot 7 frame.
    expect(writes()).toEqual([
      btn('06 00 00', '04 00 00', '00 3d'),
      btn('06 00 00', '05 00 00', '00 3e'),
    ]);
  });

  it('names the release the mouse firmware', async () => {
    const { drv } = x11Rig(AT_START);
    expect(await drv.getFirmware()).toEqual({ device: 'v1.10', receiver: null });
  });

  it('encodes DPI in steps of 42.5, doubled and doubled again near the top', () => {
    const recorded: [number, number, boolean, boolean][] = [
      [50, 0x01, false, false],
      [400, 0x09, false, false],
      [800, 0x12, false, false],
      [1000, 0x17, false, false],
      [1200, 0x1c, false, false],
      [1600, 0x25, false, false],
      [2400, 0x38, false, false],
      [3200, 0x4b, false, false],
      [5000, 0x75, false, false],
      [6400, 0x96, false, false],
      [12000, 0x8d, true, false],
      [22000, 0x81, true, true],
    ];
    for (const [value, raw, double, quad] of recorded) {
      expect(encodeX11Dpi(value)).toEqual({ raw, double, quad });
      expect(decodeX11Dpi(raw, double, quad)).toBe(value);
    }
    // Below the first doubling, every value the 50-step slider offers comes back as itself.
    for (let v = 50; v < 10880; v += 50) {
      const e = encodeX11Dpi(v);
      expect(decodeX11Dpi(e.raw, e.double, e.quad)).toBe(v);
    }
  });
});
