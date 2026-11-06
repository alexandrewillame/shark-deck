import { describe, expect, it, vi } from 'vitest';
import type { DeviceDescriptor } from '@shared/types/device';
import { KEYBOARDS_BY_ID } from '../catalog/keyboards';
import { YC_CMD, YC_NEVER, Yc500Keyboard } from './yc500-keyboard';

vi.mock('./base', async (orig) => {
  // No real waiting in tests: the family's reply settle is ~100 ms per GET.
  const m = await orig<typeof import('./base')>();
  return { ...m, delay: async () => undefined };
});

/**
 * The yc500 driver against a fake board that answers the frames sharkfin's
 * protocol notes document (see the driver's header). Two things matter most:
 *
 *  - nothing but this family's own opcodes ever leaves the driver — gen2's
 *    0x06 / 0x09 / 0x10 are this family's options register, whole-layer
 *    keymap upload and whole Fn-layer upload, all of them destructive here;
 *  - every write is read back against what the board then reports.
 */

/** A yc500 board's state, answering GETs from it and applying SETs to it. */
class FakeYc500 {
  profileByte = 0;
  debounce = 5;
  sleep = [300, 600, 1800, 3600]; // light BT, light 2.4G, deep BT, deep 2.4G
  led = [4, 3, 4, 0x07, 0xff, 0x00, 0x00]; // wave, fixed red
  sled = [1, 2, 4, 0x07, 0x00, 0xff, 0x00];
  /** 128 slots x 4 bytes per layer */
  base = new Array(512).fill(0);
  fn = new Array(512).fill(0);
  revision = 0x0814;
  sent: number[][] = [];
  private pending: number[] | null = null;

  constructor() {
    this.base[9 * 4 + 2] = 0x04; // A
    this.base[41 * 4 + 2] = 0x2c; // Space
  }

  write(frame: Uint8Array) {
    const f = Array.from(frame);
    this.sent.push(f);
    const cmd = f[1]!;
    const a = (i: number) => f[2 + i] ?? 0; // args before the checksum slot
    const tail = (n: number) => f.slice(9, 9 + n); // args after it
    switch (cmd) {
      case YC_CMD.SET_PROFILE:
        this.profileByte = a(0);
        break;
      case YC_CMD.SET_DEBOUNCE:
        this.debounce = a(1);
        break;
      case YC_CMD.SET_SLEEPTIME: {
        const v = tail(8);
        this.sleep = [0, 2, 4, 6].map((i) => v[i]! | (v[i + 1]! << 8));
        break;
      }
      case YC_CMD.SET_LEDPARAM:
        this.led = f.slice(2, 9);
        break;
      case YC_CMD.SET_SLEDPARAM:
        this.sled = f.slice(2, 9);
        break;
      case YC_CMD.SET_KEY:
      case YC_CMD.SET_FN_KEY: {
        const layer = cmd === YC_CMD.SET_KEY ? this.base : this.fn;
        layer.splice(a(1) * 4, 4, ...tail(4));
        break;
      }
      default:
        this.pending = f; // a GET: answered by the next read
    }
  }

  read(): Buffer | null {
    const q = this.pending;
    this.pending = null;
    if (!q) return null;
    const cmd = q[1]!;
    const reply = (data: number[]) =>
      Buffer.from([0x00, cmd, ...data, ...new Array(64).fill(0)]).subarray(0, 65);
    const page = (layer: number[]) => {
      const p = q[3]!;
      return Buffer.from([0x00, ...layer.slice(p * 64, p * 64 + 64)]);
    };
    switch (cmd) {
      case YC_CMD.GET_REVISION:
        return reply([this.revision & 0xff, this.revision >> 8]);
      case YC_CMD.GET_PROFILE:
        return reply([this.profileByte]);
      case YC_CMD.GET_DEBOUNCE:
        return reply([0, this.debounce]);
      case YC_CMD.GET_SLEEPTIME:
        return reply(this.sleep.flatMap((v) => [v & 0xff, v >> 8]));
      case YC_CMD.GET_LEDPARAM:
        return reply(this.led);
      case YC_CMD.GET_SLEDPARAM:
        return reply(this.sled);
      case YC_CMD.GET_KEYMATRIX:
        return page(this.base);
      case YC_CMD.GET_FN:
        return page(this.fn);
      default:
        return null;
    }
  }
}

function driverFor(d: DeviceDescriptor, board = new FakeYc500()) {
  const io = {
    write: async (f: Uint8Array) => board.write(f),
    read: async () => board.read(),
  };
  const channel = {
    write: io.write,
    transaction: <T>(fn: (x: typeof io) => Promise<T>) => fn(io),
  };
  const warnings: string[] = [];
  const drv = new Yc500Keyboard({
    descriptor: d,
    channel: channel as never,
    onWarning: (m) => warnings.push(m),
  });
  return { drv, board, warnings };
}

const X86 = KEYBOARDS_BY_ID.get(1967)!;
const K85 = KEYBOARDS_BY_ID.get(1466)!;

describe('the yc500 descriptors', () => {
  it('drive the yc500 boards with this driver, and offer only what it does', () => {
    for (const d of [X86, K85]) {
      expect(d.driver, d.model).toBe('yc500-keyboard');
      expect(d.identity, d.model).toBe('exact');
      for (const cap of ['pollRate', 'macros', 'keyboardOptions', 'magneticSwitches'] as const) {
        expect(d.capabilities, `${d.model}: ${cap}`).not.toContain(cap);
      }
      expect(d.spec.debounceRange).toEqual({ min: 1, max: 10 });
    }
    // the magnetic one counts profiles in fours
    expect(K85.spec.profileByteStride).toBe(4);
    expect(X86.spec.profileByteStride).toBeUndefined();
  });
});

describe('Yc500Keyboard', () => {
  it('sends nothing but its own opcodes, from every method it has', async () => {
    const { drv, board } = driverFor(X86);
    await drv.getFirmware();
    await drv.getActiveProfile();
    await drv.readDebounce();
    await drv.setDebounce(3);
    await drv.readPower();
    await drv.setPower({ sleepTimerSec: 600, never: false });
    const [light] = await drv.readLighting();
    await drv.setLighting(light!);
    const side = await drv.readSideLighting();
    await drv.setSideLighting(side!);
    await drv.readKeyBindings('base');
    await drv.readKeyBindings('fn');
    await drv.setKeyRemap('base', 9, '05');
    await drv.setKeyRemap('fn', 9, '05');
    await drv.backup();
    // …and the ones it does not implement send nothing at all
    const before = board.sent.length;
    expect(await drv.readPollRate()).toBeNull();
    expect((await drv.setPollRate(1000)).ok).toBe(false);
    expect(await drv.readMacros()).toEqual([]);
    expect((await drv.setPerKeyLighting([], {})).ok).toBe(false);
    expect(await drv.readMagnetic()).toEqual([]);
    expect(board.sent.length).toBe(before);

    const own = new Set<number>(Object.values(YC_CMD));
    for (const f of board.sent) {
      expect(own.has(f[1]!), `0x${f[1]!.toString(16)} is not a yc500 opcode`).toBe(true);
      expect(YC_NEVER).not.toContain(f[1]!);
    }
  });

  it('reads the board back the way the notes lay it out', async () => {
    const { drv } = driverFor(X86);
    expect((await drv.getFirmware()).device).toBe('v8.14');
    expect(await drv.readDebounce()).toBe(5);
    const p = await drv.readPower();
    expect(p.sleepTimerSec).toBe(600); // the 2.4 GHz value
    expect(p.deepSleepSec).toBe(3600);
    const [l] = await drv.readLighting();
    // wave, fixed red; speed wire 3 of 5..1 -> step 2 of 0..4 -> 50 %
    expect(l).toMatchObject({ enabled: true, color: [255, 0, 0], speed: 50, brightness: 100 });
    const keys = await drv.readKeyBindings('base');
    expect(keys?.[9]?.code).toBe('04');
    expect(keys?.[41]?.code).toBe('2c');
  });

  it('writes one key with its quad after the checksum, and reads its page back', async () => {
    const { drv, board } = driverFor(X86);
    const r = await drv.setKeyRemap('base', 9, '05');
    expect(r).toMatchObject({ ok: true, verified: 'match' });
    const set = board.sent.find((f) => f[1] === YC_CMD.SET_KEY)!;
    // [profile, slot] at bytes 2-3, checksum at 8, quad [0, 0, usage, 0] at 9-12
    expect(set.slice(2, 4)).toEqual([0, 9]);
    expect(set.slice(9, 13)).toEqual([0, 0, 0x05, 0]);
    expect(set[8]).toBe((0xff - set.slice(1, 8).reduce((s, b) => s + b, 0)) & 0xff);
    expect(board.base.slice(36, 40)).toEqual([0, 0, 0x05, 0]);
  });

  it('puts the debounce value second, after a zero', async () => {
    const { drv, board } = driverFor(X86);
    expect(await drv.setDebounce(7)).toMatchObject({ ok: true, verified: 'match' });
    const set = board.sent.find((f) => f[1] === YC_CMD.SET_DEBOUNCE)!;
    expect(set.slice(2, 4)).toEqual([0, 7]);
    // the family's range is 1..10
    await drv.setDebounce(30);
    expect(board.debounce).toBe(10);
  });

  it('writes both radios alike, and never "off" (the family has no never)', async () => {
    const { drv, board } = driverFor(X86);
    expect(await drv.setPower({ sleepTimerSec: 900, never: false })).toMatchObject({
      verified: 'match',
    });
    expect(board.sleep.slice(0, 2)).toEqual([900, 900]);
    await drv.setPower({ sleepTimerSec: 0, never: true });
    expect(board.sleep[1]).toBe(36000);
  });

  it('runs the main-zone speed 5..1 and sends white as FAFAFA', async () => {
    const { drv, board } = driverFor(X86);
    const [l] = await drv.readLighting();
    await drv.setLighting({ ...l!, speed: 100, color: [255, 255, 255], dazzle: false });
    expect(board.led[1]).toBe(1); // fastest
    expect(board.led.slice(4, 7)).toEqual([0xfa, 0xfa, 0xfa]);
    await drv.setLighting({ ...l!, speed: 0 });
    expect(board.led[1]).toBe(5); // slowest
  });

  it('counts profiles in fours on the K85 1466', async () => {
    const { drv, board } = driverFor(K85);
    const r = await drv.setActiveProfile(2);
    expect(r).toMatchObject({ ok: true, verified: 'match' });
    expect(board.profileByte).toBe(4);
    expect(await drv.getActiveProfile()).toBe(2);
    // and keymap reads go to that profile's byte
    await drv.readKeyBindings('base');
    const read = board.sent.filter((f) => f[1] === YC_CMD.GET_KEYMATRIX).at(-1)!;
    expect(read[2]).toBe(4);
  });

  it('refuses a profile the board does not have', async () => {
    const { drv, board } = driverFor(X86);
    const before = board.sent.length;
    expect((await drv.setActiveProfile(9)).ok).toBe(false);
    expect(board.sent.length).toBe(before);
  });

  it('backs up the base keymap the policy requires, and restores it', async () => {
    const { drv, board } = driverFor(X86);
    const blocks = await drv.backup();
    for (const b of drv.backupPolicy().required) expect(blocks).toHaveProperty(b);
    board.base.splice(36, 4, 0, 0, 0x1e, 0); // the owner remaps A
    expect((await drv.restoreFromBackup(blocks)).ok).toBe(true);
    expect(board.base.slice(36, 40)).toEqual([0, 0, 0x04, 0]);
  });
});
