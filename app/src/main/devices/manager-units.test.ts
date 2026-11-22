import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Two keyboards of one USB id on one PC — an R85 HE beside an R98 HE, both
 * 3151:5029 with no serial number — are two cards. The scan used to take the
 * first config collection of a USB id for every candidate, so the second board
 * never got one.
 */

const mockDevicesAsync = vi.fn(async () => [] as unknown[]);
vi.mock('node-hid', () => ({
  default: {
    devicesAsync: (...a: unknown[]) => mockDevicesAsync(...(a as [])),
    HID: class {},
    HIDAsync: { open: vi.fn(async () => ({ close: vi.fn() })) },
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
    keyGroups: () => '/tmp/key-groups.json',
  },
  readJson: async (_p: string, d: unknown) => d,
  writeJson: async () => undefined,
  withFileLock: <T>(_p: string, fn: () => Promise<T>) => fn(),
  listBackupFiles: async () => [],
  writeBackup: async () => 'f.json',
}));

import { DeviceManager } from './manager';

/** One board's HID collections, as Windows lists them: its own instance in every path. */
const board = (instance: string) =>
  [
    { usagePage: 0x0001, usage: 0x06, interface: 0 },
    { usagePage: 0x0001, usage: 0x02, interface: 1 },
    { usagePage: 0x000c, usage: 0x01, interface: 1 },
    { usagePage: 0xffff, usage: 0x01, interface: 1 },
    { usagePage: 0xffff, usage: 0x02, interface: 2 },
  ].map((c, i) => ({
    ...c,
    vendorId: 0x3151,
    productId: 0x5029,
    path: `\\\\?\\HID#VID_3151&PID_5029&MI_0${c.interface}#${instance}&${i}#{4d1e55b2}`,
    serialNumber: '',
    product: 'R98HE',
  }));

async function scanOnce(m: DeviceManager): Promise<void> {
  await (m as unknown as { scan(): Promise<void> }).scan();
}

describe('two boards of one USB id', () => {
  beforeEach(() => mockDevicesAsync.mockReset());

  it('are two cards, each on its own config collection', async () => {
    mockDevicesAsync.mockResolvedValue([...board('8&1aa'), ...board('8&2bb')]);
    const m = new DeviceManager();
    await scanOnce(m);
    const ids = m.list().map((d) => d.id);
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
    expect(ids.some((id) => id.includes('8&1aa&4'))).toBe(true);
    expect(ids.some((id) => id.includes('8&2bb&4'))).toBe(true);
    m.stop();
  });

  it('is still one card for one board, whichever collection the scan meets first', async () => {
    mockDevicesAsync.mockResolvedValue(board('8&1aa'));
    const m = new DeviceManager();
    await scanOnce(m);
    expect(m.list()).toHaveLength(1);
    m.stop();
  });
});
