import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The Beken receiver several brands share (1D57:FA60) carries an X11 — or
 * another brand's mouse. Its endpoint attaches pending on the notification
 * collection (000A:0000), where the mouse says what it is unasked
 * (`03 <model> 40 …`, its battery every 2 s); only once it has said 0x55, the
 * X11, does the manager open the settings collection (000B:0000) and drive
 * it. Nothing is ever written before that, nor to another brand's mouse.
 */

const bus: Record<string, unknown>[] = [];
const opened: string[] = [];
const written: string[] = [];
let modelByte = 0x55;

vi.mock('node-hid', () => ({
  default: {
    devicesAsync: async () => bus,
    HID: class {},
    HIDAsync: {
      open: vi.fn(async (path: string) => {
        opened.push(path);
        const notifications = path.includes('Col03');
        return {
          close: vi.fn(async () => undefined),
          read: vi.fn(async () => (notifications ? [0x03, modelByte, 0x40, 0x02, 0x64] : [])),
          write: vi.fn(async (b: number[]) => {
            written.push(path);
            return b.length;
          }),
          sendFeatureReport: vi.fn(async (b: number[]) => {
            written.push(path);
            return b.length;
          }),
          getFeatureReport: vi.fn(async () => []),
        };
      }),
    },
  },
}));
vi.mock('electron', () => ({ app: { getPath: () => '/tmp/sharkdeck-test', isPackaged: false } }));

const mockSettings = { demoMode: false, language: 'en', batteryLowThreshold: 15 };
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

/** The receiver's interface 2, two of its collections (as Windows lists them). */
const collection = (col: string, usagePage: number) => ({
  path: `\\\\?\\HID#VID_1D57&PID_FA60&MI_02&${col}#rx`,
  vendorId: 0x1d57,
  productId: 0xfa60,
  usagePage,
  usage: 0x0000,
  serialNumber: 'RX-1',
  interface: 2,
  release: 0x1113,
  product: '2.4G Wireless Device',
});
const NOTIFY = collection('Col03', 0x000a);
const SETTINGS = collection('Col04', 0x000b);

const scanOnce = (m: DeviceManager) => (m as unknown as { scan(): Promise<void> }).scan();
/** The collection the one device's channel is on (HidChannel keeps it private). */
const channelPath = (m: DeviceManager) =>
  [...(m as unknown as { entries: Map<string, { channel: unknown }> }).entries.values()].map(
    (e) => (e.channel as { candidate: { path: string } }).candidate.path,
  )[0];

describe('the receiver several brands share', () => {
  beforeEach(() => {
    bus.length = 0;
    bus.push(NOTIFY, SETTINGS);
    opened.length = 0;
    written.length = 0;
  });

  it('names an X11 by listening, then drives it on its settings collection', async () => {
    modelByte = 0x55;
    const mgr = new DeviceManager();
    await scanOnce(mgr);
    expect(mgr.list()).toHaveLength(1);
    const d = mgr.list()[0]!;
    expect(d.displayName).toBe('Attack Shark X11');
    expect(d.connection).toBe('2.4g');
    // Its channel is now the settings collection (opened on its first read);
    // the notification one stays open beside it for its battery, read only.
    expect(channelPath(mgr)).toBe(SETTINGS.path);
    expect(new Set(opened)).toEqual(new Set([NOTIFY.path]));
    // Identifying sent nothing at all.
    expect(written).toEqual([]);
  });

  it('leaves another brand’s mouse alone: an unknown card, nothing written', async () => {
    modelByte = 0x33;
    const mgr = new DeviceManager();
    await scanOnce(mgr);
    expect(mgr.list()[0]!.ui.identity).toBe('unknown');
    expect(channelPath(mgr)).toBe(NOTIFY.path);
    expect(opened).toEqual([NOTIFY.path]);
    expect(written).toEqual([]);
  });
});
