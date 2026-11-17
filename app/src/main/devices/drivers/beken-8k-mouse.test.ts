import { describe, expect, it, vi } from 'vitest';
import type { ButtonMapping, DpiStage } from '@shared/types/mouse-settings';

vi.mock('node-hid', () => ({
  default: { devicesAsync: async () => [], HIDAsync: { open: vi.fn() } },
}));

const {
  Beken8kMouse,
  BEKEN_8K_POLL,
  SEED_BUTTONS,
  bekenFrame,
  decodeBekenButton,
  decodeBekenDpi,
  encodeBekenButton,
  encodeBekenDpi,
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
/** The button block with slots 4 (Forward) and 5 (Backward) as given, and the recorded sums. */
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

  it('remaps Backward (button 5) to each recorded action', async () => {
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
      [{ actionKey: 'button', action: 1, param: 0x0800 }, '06 00 00', '00 79 01 7a'],
    ];
    expect(hexOf(frame(buttons('05 00 00', '06 00 00', '00 79 01 7a')))).toBe(
      hexOf(frame(BTN_DEFAULT)),
    );
    for (const [m, slot5, sums] of cases) {
      const { drv, sent } = rig();
      const r = await drv.setButtonMapping(4, m);
      expect(r.ok, JSON.stringify(m)).toBe(true);
      expect(hexOf(sent[0]!), JSON.stringify(m)).toBe(
        hexOf(frame(buttons('05 00 00', slot5, sums))),
      );
    }
  });

  it('remaps Forward (button 4) as recorded', async () => {
    const { drv, sent } = rig();
    await drv.setButtonMapping(3, { actionKey: 'combo', action: 5, combo: [0x05] });
    expect(hexOf(sent[0]!)).toBe(hexOf(frame(buttons('11 00 05', '06 00 00', '00 8a 01 9c'))));
  });

  it('reads back the default buttons as Shark Deck names them', async () => {
    const { drv } = rig();
    expect(await drv.readButtons()).toEqual({
      0: { actionKey: 'button', action: 0x02, param: 0x0100 },
      1: { actionKey: 'button', action: 0x03, param: 0x0200 },
      2: { actionKey: 'button', action: 0x04, param: 0x0400 },
      3: { actionKey: 'button', action: 0x05, param: 0x1000 },
      4: { actionKey: 'button', action: 0x06, param: 0x0800 },
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
    expect((await drv.setButtonMapping(5, { actionKey: 'disable', action: 0 })).ok).toBe(false);
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
