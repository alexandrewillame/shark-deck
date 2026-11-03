import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * One physical device that enumerates on two endpoints must be one card.
 *
 * The Attack Shark V8 is `3554:F517` through its 8K dongle and `3554:F515`
 * over USB-C — same serial, same onboard memory. It used to produce two cards,
 * and because plugging the cable in stops the mouse talking to its dongle, one
 * of those two was a menu that showed nothing.
 */

const bus: Record<string, unknown>[] = [];
vi.mock('node-hid', () => ({
  default: {
    devicesAsync: async () => bus,
    HID: class {},
    HIDAsync: { open: vi.fn(async () => ({ close: vi.fn() })) },
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

import { DeviceManager } from './manager';

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

  it('keys a serial-bearing device on model+serial, not on the endpoint', async () => {
    setBus(DONGLE);
    await scanOnce(mgr);
    expect(mgr.list()[0]!.id).toBe(`attack-shark-v8:${SERIAL}`);
  });
});
