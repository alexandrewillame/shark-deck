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
    backupWaivers: () => '/tmp/backup-waivers.json',
  },
  readJson: async (_p: string, d: unknown) => d,
  writeJson: async () => undefined,
  withFileLock: <T>(_p: string, fn: () => Promise<T>) => fn(),
  listBackupFiles: async () => [],
  writeBackup: async () => 'f.json',
}));

import { frameLog } from '../diagnostics';
import { DeviceManager } from './manager';

/**
 * The receiver's interface 2, two of its collections, as node-hid lists them
 * on Windows: with no `usage` at all, since theirs is 0 (seen 2026-11-25).
 */
const collection = (col: string, usagePage: number) => ({
  path: `\\\\?\\HID#VID_1D57&PID_FA60&MI_02&${col}#rx`,
  vendorId: 0x1d57,
  productId: 0xfa60,
  usagePage,
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

  it('asks for the OK on the first look, on its cable as through the receiver (issue #2)', async () => {
    modelByte = 0x55;
    const mgr = new DeviceManager();
    await scanOnce(mgr);
    expect(mgr.list()[0]!.backupWaiver?.unreadable).toContain('mouseLighting');

    // On its cable it is known by its USB id alone, and asked all the same:
    // it used to ask only once its first change had been refused.
    const cable = (col: string, usagePage: number) => ({
      ...collection(col, usagePage),
      path: `\\?\HID#VID_1D57&PID_FA55&MI_02&${col}#cable`,
      productId: 0xfa55,
      serialNumber: '',
      product: 'X11 Mouse',
    });
    bus.length = 0;
    bus.push(cable('Col03', 0x000a), cable('Col04', 0x000b));
    written.length = 0;
    const wired = new DeviceManager();
    await scanOnce(wired);
    const d = wired.list()[0]!;
    expect([d.displayName, d.connection]).toEqual(['Attack Shark X11', 'usb']);
    expect(d.backupWaiver?.unreadable).toContain('mouseLighting');
    expect(written).toEqual([]);
  });

  // The X8 PRO's cable, and the X11 on either link, announce their battery on
  // 000A:0000 beside the settings: matching node-hid's missing usage as 0 used
  // to fail, and the cable showed "?%" through 0.3.8 (its owner's log, 11-25).
  it('hears the battery beside the settings: the X11 through the receiver, the X8 PRO on its cable', async () => {
    modelByte = 0x55;
    const rx = new DeviceManager();
    await scanOnce(rx); // named by listening, then driven on 000B:0000
    await scanOnce(rx); // its first pass as an X11: the battery it announced
    expect(rx.list()[0]!.battery).toBe(100);

    const x8 = (col: string, usagePage: number) => ({
      ...collection(col, usagePage),
      path: `\\?\HID#VID_1D57&PID_2126&MI_02&${col}#cable`,
      productId: 0x2126,
      serialNumber: '',
      product: 'X8PRO Mouse',
    });
    bus.length = 0;
    bus.push(x8('Col03', 0x000a), x8('Col04', 0x000b));
    modelByte = 0x08;
    const cable = new DeviceManager();
    await scanOnce(cable);
    const d = cable.list()[0]!;
    expect([d.displayName, d.connection, d.battery]).toEqual(['Attack Shark X8 PRO', 'usb', 100]);
    expect(written).toEqual([]);
  });

  it('says in the device log when the announcement collection is not there', async () => {
    bus.length = 0;
    bus.push({
      ...collection('Col04', 0x000b),
      path: `\\?\HID#VID_1D57&PID_2126&MI_02&Col04#cable`,
      productId: 0x2126,
      serialNumber: '',
    });
    frameLog.clear();
    const mgr = new DeviceManager();
    await scanOnce(mgr);
    const id = mgr.list()[0]!.id;
    expect(
      frameLog
        .all()
        .filter((e) => e.deviceId === id)
        .map((e) => e.note),
    ).toContain('announcements: no 000a:0000 collection (it has 000b:0000)');
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
