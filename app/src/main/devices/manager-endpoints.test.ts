import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * One physical device that enumerates on two endpoints must be one card.
 *
 * The Attack Shark V8 is `3554:F517` through its 8K dongle and `3554:F515`
 * over USB-C — same serial, same onboard memory. It used to produce two cards,
 * and because plugging the cable in stops the mouse talking to its dongle, one
 * of those two was a menu that showed nothing.
 *
 * Both endpoints attach as the Hub family, pending, and are bound to the V8
 * only by the identify answer (registry.ts, identity.ts) — so the fake
 * endpoints below answer the identify frame the way our V8 capture records
 * it, each with its own link type.
 */

const bus: Record<string, unknown>[] = [];
vi.mock('node-hid', () => ({
  default: {
    devicesAsync: async () => bus,
    HID: class {},
    HIDAsync: { open: vi.fn(async (path: string) => fakeEndpoint(path)) },
  },
}));
vi.mock('electron', () => ({ app: { getPath: () => '/tmp/sharkdeck-test', isPackaged: false } }));

const mockSettings = { devMode: false, language: 'en', batteryLowThreshold: 15 };
vi.mock('../settings', () => ({
  getSettingsSync: () => mockSettings,
  getSettings: async () => mockSettings,
  setSettings: async () => mockSettings,
}));
vi.mock('../store', () => ({
  paths: {
    deviceState: () => '/tmp/device-state.json',
    deviceColors: () => '/tmp/device-colors.json',
    onboardProfileNames: () => '/tmp/onboard-names.json',
  },
  readJson: async (_p: string, d: unknown) => d,
  writeJson: async () => undefined,
  withFileLock: <T>(_p: string, fn: () => Promise<T>) => fn(),
  listBackupFiles: async () => [],
  writeBackup: async () => 'f.json',
}));

import { appendChecksum } from '../hid/checksum';
import { DeviceManager } from './manager';

/**
 * The identify reply our V8 capture recorded (docs/reverse-engineering/
 * FINDINGS.md): `08 01 00 00 00 08 <nonce> 7c 05 05 …` — cid 124 (Attack
 * Shark), mid 5 (V8), then the link: 5 = 8K wireless on the dongle, 3 =
 * wired 8K on the cable.
 */
function identifyReply(query: number[], link: number): number[] {
  const r = new Uint8Array(17);
  r.set([0x08, 0x01, 0x00, 0x00, 0x00, 0x08, ...query.slice(6, 10), 124, 5, link]);
  return Array.from(appendChecksum(r, 'shark-sum'));
}

/** A V8 endpoint that answers identify and nothing else. */
function fakeEndpoint(path: string) {
  const link = path.includes('#cable') ? 3 : 5;
  let last: number[] | null = null;
  return {
    close: vi.fn(async () => undefined),
    write: vi.fn(async (bytes: number[]) => {
      last = bytes;
      return bytes.length;
    }),
    read: vi.fn(async () => {
      const q = last;
      last = null;
      return q && q[1] === 0x01 ? identifyReply(q, link) : [];
    }),
  };
}

const SERIAL = '541505796617';
/** The vendor config collection each endpoint exposes (MI_01 / 0xFF02 / 2). */
const endpoint = (pid: number, tag: string) => ({
  path: `\\?\HID#VID_3554&PID_${pid.toString(16)}&MI_01&Col05#${tag}`,
  vendorId: 0x3554,
  productId: pid,
  usagePage: 0xff02,
  usage: 0x02,
  serialNumber: SERIAL,
  interface: 1,
  release: pid === 0xf515 ? 0x303 : 0x300,
  product: pid === 0xf515 ? 'V8' : 'ATTACK SHARK Mouse',
});
const DONGLE = endpoint(0xf517, 'dongle');
const CABLE = endpoint(0xf515, 'cable');

const scanOnce = (m: DeviceManager) => (m as unknown as { scan(): Promise<void> }).scan();
const setBus = (...items: Record<string, unknown>[]) => {
  bus.length = 0;
  bus.push(...items);
};

describe('a device on two endpoints is one device', () => {
  let mgr: DeviceManager;
  beforeEach(() => {
    mgr = new DeviceManager();
    setBus();
  });

  it('shows one card when only the dongle is present', async () => {
    setBus(DONGLE);
    await scanOnce(mgr);
    expect(mgr.list()).toHaveLength(1);
    expect(mgr.list()[0]!.connection).toBe('2.4g');
    expect(mgr.list()[0]!.wireless).toBe(true);
  });

  it('still shows ONE card when both endpoints enumerate', async () => {
    setBus(DONGLE, CABLE);
    await scanOnce(mgr);
    expect(mgr.list()).toHaveLength(1);
  });

  it('hands that card to the cable, which is the one actually carrying traffic', async () => {
    setBus(DONGLE, CABLE);
    await scanOnce(mgr);
    const d = mgr.list()[0]!;
    expect(d.pid).toBe(0xf515);
    expect(d.connection).toBe('usb');
    expect(d.wireless).toBe(false);
    // …and it is still recognised as the V8, not a generic mouse.
    expect(d.displayName).toBe('Attack Shark V8');
  });

  it('takes over even when the dongle was there first', async () => {
    setBus(DONGLE);
    await scanOnce(mgr);
    expect(mgr.list()[0]!.pid).toBe(0xf517);
    setBus(DONGLE, CABLE); // cable plugged in later
    await scanOnce(mgr);
    expect(mgr.list()).toHaveLength(1);
    expect(mgr.list()[0]!.pid).toBe(0xf515);
  });

  it('does not keep swapping back and forth once the cable has won', async () => {
    setBus(DONGLE, CABLE);
    await scanOnce(mgr);
    const first = mgr.list()[0]!;
    await scanOnce(mgr);
    await scanOnce(mgr);
    expect(mgr.list()).toHaveLength(1);
    expect(mgr.list()[0]!.pid).toBe(0xf515);
    expect(mgr.list()[0]!.id).toBe(first.id); // stable id: the open tab survives
  });

  it('keeps one stable id across the transport change', async () => {
    setBus(DONGLE);
    await scanOnce(mgr);
    const wirelessId = mgr.list()[0]!.id;
    setBus(DONGLE, CABLE);
    await scanOnce(mgr);
    // The id is keyed on model+serial, so the card the user already has open
    // becomes the USB one rather than vanishing and being replaced.
    expect(mgr.list()[0]!.id).toBe(wirelessId);
  });

  it('leaves a device with no serial on its old path-based key', async () => {
    // The R85HE reports an empty serial, so there is nothing to correlate two
    // endpoints on — it must not be swept into the model+serial scheme.
    setBus({
      path: '\\?\HID#VID_3151&PID_5029&MI_02#kb',
      vendorId: 0x3151,
      productId: 0x5029,
      usagePage: 0xffff,
      usage: 0x02,
      serialNumber: '',
      interface: 2,
      release: 0x511,
      product: 'R85HE',
    });
    await scanOnce(mgr);
    const kb = mgr.list()[0]!;
    expect(kb.id).toContain('3151:5029:');
    expect(kb.id).not.toContain(kb.model);
  });

  it('keys a serial-bearing device on family+serial, not on the endpoint', async () => {
    // The key is taken before the device identifies, so it is the family's
    // (registry.ts) — and it must not change once the V8 has said what it is,
    // or the card the user has open would vanish under them.
    setBus(DONGLE);
    await scanOnce(mgr);
    const d = mgr.list()[0]!;
    expect(d.displayName).toBe('Attack Shark V8');
    expect(d.id).toBe(`compx-hub:${SERIAL}`);
  });

  it('is identified as the V8 from the dongle, before any other command', async () => {
    setBus(DONGLE);
    await scanOnce(mgr);
    const d = mgr.list()[0]!;
    expect(d.model).toBe('attack-shark-v8');
    expect(d.capabilities).toContain('receiverLed');
  });

  it('re-identifies on the cable, which has no receiver to configure', async () => {
    setBus(DONGLE);
    await scanOnce(mgr);
    setBus(DONGLE, CABLE);
    await scanOnce(mgr);
    const d = mgr.list()[0]!;
    expect(d.displayName).toBe('Attack Shark V8');
    expect(d.capabilities).not.toContain('receiverLed');
    expect(d.capabilities).not.toContain('pairing');
  });
});
