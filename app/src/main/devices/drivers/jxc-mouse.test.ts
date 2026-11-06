import { describe, expect, it, vi } from 'vitest';
import { jxcDescriptorFor } from '../catalog/jxc-mice';
import { resolveDescriptor } from '../registry';
import { JXC_FRAMES, JXC_POLL, JXC_STATUS, JxcMouse } from './jxc-mouse';

vi.mock('./base', async (orig) => {
  const m = await orig<typeof import('./base')>();
  return { ...m, delay: async () => undefined };
});

/**
 * The JXC driver against a fake R5 ULTRA answering in the shape Dorsal records
 * from a real one: `[status, 00, target, length, category, command, …]`, status
 * A1 when it answers, A0 while only the receiver does.
 */

type Profile = {
  dpi: number[];
  active: number;
  poll: number;
  lod: number;
  motion: number;
  ripple: number;
  angle: number;
  debounce: number;
  sleep: number;
};

class FakeR5 {
  profile = 1;
  profiles: Profile[] = [1, 2, 3].map(() => ({
    dpi: [400, 800, 1600, 3200, 6400, 26000],
    active: 2,
    poll: JXC_POLL[1000]!,
    lod: 0x87,
    motion: 1,
    ripple: 0,
    angle: 0,
    debounce: 4,
    sleep: 300,
  }));
  /** replies to hand back, oldest first */
  private queue: number[][] = [];
  /** answer the next N reads with "only the receiver answered" */
  asleepReads = 0;
  sent: number[][] = [];

  write(frame: Uint8Array) {
    const f = Array.from(frame);
    this.sent.push(f);
    const [cat, cmd, a0 = 0, a1 = 0, a2 = 0] = [f[5]!, f[6]!, f[7], f[8], f[9]];
    const pp = this.profiles[(a0 || 1) - 1]!;
    const head = (data: number[]) => [JXC_STATUS.OK, 0x00, f[3]!, f[4]!, cat, cmd, ...data];
    const key = `${cat}:${cmd}`;
    switch (key) {
      case '0:129': // firmware
        return this.queue.push(head([0, 0, 12, 0]));
      case '0:131': // battery
        return this.queue.push(head([0, 76]));
      case '0:133': // profile
        return this.queue.push(head([this.profile]));
      case '0:5':
        this.profile = a0;
        return this.queue.push(head([]));
      case '0:136':
        return this.queue.push(head([a0, pp.debounce]));
      case '0:8':
        pp.debounce = a1;
        return this.queue.push(head([]));
      case '0:135':
        return this.queue.push(head([a0, pp.sleep >> 8, pp.sleep & 0xff]));
      case '0:7':
        pp.sleep = (a1 << 8) | a2;
        return this.queue.push(head([]));
      case '1:128':
        return this.queue.push(head([a0, pp.poll]));
      case '1:0':
        pp.poll = a1;
        return this.queue.push(head([]));
      case '1:129': {
        const data = pp.dpi.flatMap((v) => [v >> 8, v & 0xff, v >> 8, v & 0xff]);
        return this.queue.push(head([a0, pp.dpi.length, ...data]));
      }
      case '1:1': {
        const n = a1;
        pp.dpi = Array.from({ length: n }, (_, i) => (f[9 + 4 * i]! << 8) | f[10 + 4 * i]!);
        return this.queue.push(head([]));
      }
      case '1:130':
        return this.queue.push(head([a0, pp.active]));
      case '1:2':
        pp.active = a1;
        return this.queue.push(head([]));
      default: {
        const flags: Record<number, keyof Profile> = {
          0x84: 'angle',
          0x88: 'lod',
          0x89: 'motion',
          0x8a: 'ripple',
        };
        if (cat === 1 && flags[cmd]) return this.queue.push(head([a0, pp[flags[cmd]] as number]));
        if (cat === 1 && flags[cmd | 0x80]) {
          (pp[flags[cmd | 0x80]] as number) = a1;
          return this.queue.push(head([]));
        }
        return this.queue.push([JXC_STATUS.UNSUPPORTED, 0, f[3]!, f[4]!, cat, cmd]);
      }
    }
  }

  read(): Buffer | null {
    if (this.asleepReads > 0 && this.queue.length) {
      this.asleepReads--;
      const r = this.queue[0]!;
      return Buffer.from([0x00, JXC_STATUS.ASLEEP, ...r.slice(1)]);
    }
    const r = this.queue.shift();
    return r ? Buffer.from([0x00, ...r, ...new Array(64 - r.length).fill(0)]) : null;
  }
}

function driverFor(pid = 0x0047, mouse = new FakeR5()) {
  const io = { write: async (f: Uint8Array) => mouse.write(f), read: async () => mouse.read() };
  const channel = { write: io.write, transaction: <T>(fn: (x: typeof io) => Promise<T>) => fn(io) };
  const drv = new JxcMouse({
    descriptor: jxcDescriptorFor(pid),
    channel: channel as never,
    onWarning: () => undefined,
  });
  return { drv, mouse };
}

describe('the JXC endpoints', () => {
  it('attaches Attack Shark PIDs as their model, cable and receiver alike', () => {
    const rx = resolveDescriptor(0x373e, 0x0047)!;
    expect(rx.displayName).toBe('Attack Shark R5 ULTRA');
    expect(rx.driver).toBe('jxc-mouse');
    expect(Math.max(...rx.spec.pollRates!)).toBe(8000);
    const cable = resolveDescriptor(0x373e, 0x0046)!;
    expect(cable.model).toBe(rx.model);
    expect(cable.wired).toBe(true);
    expect(Math.max(...cable.spec.pollRates!)).toBe(1000);
  });

  it('gives other brands on the VID a card that is never written', () => {
    const lamzu = resolveDescriptor(0x373e, 0x001c)!;
    expect(lamzu.identity).toBe('foreign');
    expect(lamzu.identityNote).toBe('LAMZU');
    expect(lamzu.driver).toBe('no-io');
    // matched on the JXC configuration collection like the rest
    expect([lamzu.usagePage, lamzu.usage]).toEqual([0xffff, 0x0000]);
    // the M5 ULTRA's ids are also another brand's: named, not driven
    expect(resolveDescriptor(0x373e, 0x0051)!.identity).toBe('unknown');
  });
});

describe('JxcMouse', () => {
  it('builds each frame from the whitelist: header, target, exact length tag', async () => {
    const { drv, mouse } = driverFor();
    await drv.readPollRate();
    const get = mouse.sent.find((f) => f[6] === JXC_FRAMES.GET_POLL[2])!;
    // [report id, status, 00, target 02, length, category, command, profile]
    expect(get.slice(0, 8)).toEqual([0, 0, 0, 0x02, 0x02, 0x01, 0x80, 1]);
  });

  it('reads the profile settings of the active profile', async () => {
    const { drv } = driverFor();
    expect(await drv.getActiveProfile()).toBe(1);
    expect((await drv.readDpiStages())?.map((s) => s.dpi)).toEqual([
      400, 800, 1600, 3200, 6400, 26000,
    ]);
    expect(await drv.readActiveDpiStage()).toBe(1);
    expect(await drv.readPollRate()).toBe(1000);
    expect(await drv.readSensor()).toEqual({
      lod: 0x87,
      motionSync: true,
      rippleControl: false,
      angleSnapping: false,
    });
    expect(await drv.readDebounce()).toBe(4);
    expect(await drv.readPower()).toEqual({ sleepTimerSec: 300, never: false });
    expect((await drv.getFirmware()).device).toBe('v0.0.12.0');
    expect(await drv.getBattery()).toEqual({ level: 76, charging: false });
  });

  it('keeps polling while only the receiver answers', async () => {
    const mouse = new FakeR5();
    mouse.asleepReads = 2;
    const { drv } = driverFor(0x0047, mouse);
    expect(await drv.readDebounce()).toBe(4);
  });

  it('writes and reads back, verified', async () => {
    const { drv, mouse } = driverFor();
    expect(await drv.setPollRate(8000)).toMatchObject({ ok: true, verified: 'match' });
    expect(mouse.profiles[0]!.poll).toBe(0x80);
    expect(await drv.setDebounce(8)).toMatchObject({ verified: 'match' });
    expect(await drv.setPower({ sleepTimerSec: 600, never: false })).toMatchObject({
      verified: 'match',
    });
    expect(await drv.setSensor({ lod: 0x02, rippleControl: true })).toMatchObject({
      verified: 'match',
    });
    expect(mouse.profiles[0]).toMatchObject({ lod: 0x02, ripple: 1, debounce: 8, sleep: 600 });
  });

  it('writes a DPI table with its length tag and X = Y, and keeps the active stage in range', async () => {
    const { drv, mouse } = driverFor();
    mouse.profiles[0]!.active = 6;
    const r = await drv.setDpiStages(
      [800, 1600].map((dpi, index) => ({ index, dpi, color: [0, 0, 0], enabled: true })),
    );
    expect(r).toMatchObject({ ok: true, verified: 'match' });
    const set = mouse.sent.find((f) => f[5] === 0x01 && f[6] === 0x01)!;
    expect(set[4]).toBe(2 + 4 * 2); // length tag
    expect(set.slice(7, 17)).toEqual([1, 2, 0x03, 0x20, 0x03, 0x20, 0x06, 0x40, 0x06, 0x40]);
    expect(mouse.profiles[0]!.active).toBe(2); // pulled back into the two stages
  });

  it('refuses a poll rate its link does not carry, and a lift-off it does not have', async () => {
    const { drv, mouse } = driverFor(0x0046); // the cable: 1000 Hz at most
    const before = mouse.sent.length;
    expect((await drv.setPollRate(8000)).ok).toBe(false);
    expect((await drv.setSensor({ lod: 0x05 })).ok).toBe(false);
    expect(mouse.sent.length).toBe(before);
  });

  it('never sends the bootloader or the profile reset', async () => {
    const { drv, mouse } = driverFor();
    await drv.backup();
    await drv.setActiveProfile(2);
    await drv.setActiveDpiStage(0);
    for (const f of mouse.sent) {
      expect(f[5], 'category 0xB0 is the bootloader').not.toBe(0xb0);
      expect(f[6] === 0xb0 || (f[5] === 0 && f[6] === 0x0d)).toBe(false);
    }
  });

  it('backs up all three profiles and restores one', async () => {
    const { drv, mouse } = driverFor();
    const blocks = await drv.backup();
    for (const b of drv.backupPolicy().required) expect(blocks).toHaveProperty(b);
    mouse.profiles[1]!.debounce = 15;
    mouse.profiles[1]!.dpi = [12000];
    expect((await drv.restoreFromBackup(blocks)).ok).toBe(true);
    expect(mouse.profiles[1]).toMatchObject({
      debounce: 4,
      dpi: [400, 800, 1600, 3200, 6400, 26000],
    });
    expect(mouse.profile).toBe(1); // back on the profile it started on
  });
});
