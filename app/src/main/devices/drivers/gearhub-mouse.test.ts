import { describe, expect, it, vi } from 'vitest';
import { GEARHUB_MICE, onGearhubEndpoint } from '../catalog/gearhub-mice';
import { resolveIdentity } from '../identity';
import { GH_CMD, GH_NEVER, GH_POLL, GearHubMouse } from './gearhub-mouse';

vi.mock('./base', async (orig) => {
  const m = await orig<typeof import('./base')>();
  return { ...m, delay: async () => undefined };
});

/**
 * The GearHub driver against a fake R2 that answers the way OpenMouse's notes
 * record a real one (the DPI table below is a live R2 reply, byte for byte).
 */

const hex = (s: string) => s.split(' ').map((h) => parseInt(h, 16));
/** A live R2 `0xD4` reply: active stage 3 (0-based 2), 6 stages, 400…26000 DPI. */
const R2_DPI = hex('d4 00 02 06 00 00 00 2b 90 01 20 03 40 06 80 0c 00 19 90 65');

class FakeR2 {
  /** body bytes p[0..63] of each block */
  options = new Array(64).fill(0);
  dpi = new Array(64).fill(0);
  sent: number[][] = [];
  private pending: number | null = null;

  constructor() {
    this.options[0] = 0xd3;
    this.options[9] = 0x01; // 1000 Hz
    this.options[10] = 4; // debounce
    this.options[12] = 0x04; // ripple on
    this.options[17] = 0xff; // a byte the writer must carry through untouched
    this.options[44] = 60; // 2.4 GHz sleep, 60 s
    this.options[52] = 1; // LOD index 1 (1 mm on a PAW3950)
    this.options[53] = 0; // angle snap off
    R2_DPI.forEach((b, i) => (this.dpi[i] = b));
    // Y = X, colours
    for (let i = 0; i < 8; i++) {
      this.dpi[24 + 2 * i] = this.dpi[8 + 2 * i]!;
      this.dpi[25 + 2 * i] = this.dpi[9 + 2 * i]!;
    }
  }

  write(frame: Uint8Array) {
    const f = Array.from(frame);
    this.sent.push(f);
    const cmd = f[1]!;
    const body = f.slice(1); // p[0..63]
    if (cmd === GH_CMD.SET_OPTIONS) {
      for (let i = 8; i < 64; i++) this.options[i] = body[i]!;
    } else if (cmd === GH_CMD.SET_DPI) {
      this.dpi[2] = body[2]!;
      this.dpi[3] = body[3]!;
      for (let i = 8; i < 64; i++) this.dpi[i] = body[i]!;
    } else this.pending = cmd;
  }

  read(): Buffer | null {
    const cmd = this.pending;
    this.pending = null;
    const wrap = (body: number[]) => Buffer.from([0x00, ...body.slice(0, 64)]);
    if (cmd === GH_CMD.GET_OPTIONS) return wrap([0xd3, ...this.options.slice(1)]);
    if (cmd === GH_CMD.GET_DPI) return wrap([0xd4, ...this.dpi.slice(1)]);
    if (cmd === GH_CMD.GET_FIRMWARE) return wrap([0x80, 0x01, 0x02, ...new Array(61).fill(0)]);
    return null;
  }
}

const R2 = GEARHUB_MICE.get(1893)!;

function driverFor(d = R2, mouse = new FakeR2()) {
  const io = { write: async (f: Uint8Array) => mouse.write(f), read: async () => mouse.read() };
  const channel = { write: io.write, transaction: <T>(fn: (x: typeof io) => Promise<T>) => fn(io) };
  const drv = new GearHubMouse({
    descriptor: d,
    channel: channel as never,
    onWarning: () => undefined,
  });
  return { drv, mouse };
}

describe('identifying a GearHub mouse', () => {
  it('names it by the device id its identify reply carries', () => {
    const rx = resolveIdentity({ vid: 0x3151, pid: 0x402d }, { family: 'royuan', modelId: 1893 });
    expect(rx.displayName).toBe('Attack Shark R2');
    expect(rx.driver).toBe('gearhub-mouse');
    expect(rx.kind).toBe('mouse');
    expect(Math.max(...rx.spec.pollRates!)).toBe(8000);
    // on its cable it is wired, and 1000 Hz at most
    const cable = resolveIdentity(
      { vid: 0x3151, pid: 0x4026 },
      { family: 'royuan', modelId: 1893 },
    );
    expect(cable.wired).toBe(true);
    expect(Math.max(...cable.spec.pollRates!)).toBe(1000);
    expect(onGearhubEndpoint(R2, 0x402d)).toBe(R2);
  });

  it('gives the newer R2 MCU a named card it never writes to', () => {
    const d = resolveIdentity({ vid: 0x3151, pid: 0x5043 }, { family: 'royuan', modelId: 3016 });
    expect(d.identity).toBe('unsupported');
    expect(d.displayName).toBe('Attack Shark R2');
    expect(d.driver).toBe('no-io');
  });
});

describe('GearHubMouse', () => {
  it('reads the live R2 DPI table', async () => {
    const { drv } = driverFor();
    const stages = await drv.readDpiStages();
    expect(stages?.map((s) => s.dpi)).toEqual([400, 800, 1600, 3200, 6400, 26000]);
    expect(await drv.readActiveDpiStage()).toBe(2);
  });

  it('reads the options block', async () => {
    const { drv } = driverFor();
    expect(await drv.readPollRate()).toBe(1000);
    expect(await drv.readDebounce()).toBe(4);
    expect(await drv.readSensor()).toEqual({ lod: 1, angleSnapping: false, rippleControl: true });
    expect(await drv.readPower()).toEqual({ sleepTimerSec: 60, never: false });
  });

  it('writes the whole block back, changing only what was asked', async () => {
    const { drv, mouse } = driverFor();
    const r = await drv.setPollRate(8000);
    expect(r).toMatchObject({ ok: true, verified: 'match' });
    expect(mouse.options[9]).toBe(GH_POLL[8000]);
    expect(mouse.options[10]).toBe(4); // untouched
    expect(mouse.options[17]).toBe(0xff); // an unknown byte, carried through
    const set = mouse.sent.find((f) => f[1] === GH_CMD.SET_OPTIONS)!;
    expect(set.slice(2, 8)).toEqual([0, 0, 0, 0, 0, 0]);
    expect(set[8]).toBe((0xff - set.slice(1, 8).reduce((s, b) => s + b, 0)) & 0xff);
  });

  it('sets both radios to the one sleep timer', async () => {
    const { drv, mouse } = driverFor();
    await drv.setPower({ sleepTimerSec: 300, never: false });
    expect(mouse.options[40] | (mouse.options[41] << 8)).toBe(300);
    expect(mouse.options[44] | (mouse.options[45] << 8)).toBe(300);
  });

  it('toggles ripple without touching the rest of the flags', async () => {
    const { drv, mouse } = driverFor();
    mouse.options[12] = 0x04 | 0x01;
    await drv.setSensor({ rippleControl: false });
    expect(mouse.options[12]).toBe(0x01);
  });

  it('refuses a lift-off code the sensor does not have', async () => {
    const { drv, mouse } = driverFor();
    const before = mouse.sent.length;
    expect((await drv.setSensor({ lod: 7 })).ok).toBe(false);
    expect(mouse.sent.length).toBe(before);
  });

  it('writes a DPI table with X = Y and reads it back', async () => {
    const { drv, mouse } = driverFor();
    const stages = (await drv.readDpiStages())!;
    const r = await drv.setDpiStages(stages.slice(0, 4).map((s) => ({ ...s, dpi: s.dpi * 2 })));
    expect(r).toMatchObject({ ok: true, verified: 'match' });
    expect(mouse.dpi[3]).toBe(4); // count
    expect(mouse.dpi[8] | (mouse.dpi[9] << 8)).toBe(800);
    expect(mouse.dpi[24] | (mouse.dpi[25] << 8)).toBe(800); // Y
  });

  it('sends nothing on the never-send list, and refuses a poll rate it does not offer', async () => {
    const { drv, mouse } = driverFor(onGearhubEndpoint(R2, 0x4026));
    expect((await drv.setPollRate(8000)).ok).toBe(false); // the cable stops at 1000
    await drv.backup();
    await drv.setDebounce(6);
    await drv.setActiveDpiStage(1);
    for (const f of mouse.sent) expect(GH_NEVER).not.toContain(f[1]!);
  });

  it('backs up both blocks and restores them', async () => {
    const { drv, mouse } = driverFor();
    const blocks = await drv.backup();
    for (const b of drv.backupPolicy().required) expect(blocks).toHaveProperty(b);
    mouse.options[10] = 9;
    mouse.dpi[8] = 0x20;
    expect((await drv.restoreFromBackup(blocks)).ok).toBe(true);
    expect(mouse.options[10]).toBe(4);
    expect(mouse.dpi[8]).toBe(0x90);
  });
});
