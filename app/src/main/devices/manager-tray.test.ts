import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The scan loop while the window is hidden. Every pass enumerates the HID bus
 * and pings each device; on screen that keeps the cards current every 1.25 s,
 * in the tray it is CPU spent for nobody, so the loop slows down there and
 * catches up the moment the window is shown again.
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

describe('the device scan in the tray', () => {
  let m: DeviceManager;
  const passes = () => mockDevicesAsync.mock.calls.length;

  beforeEach(() => {
    vi.useFakeTimers();
    mockDevicesAsync.mockClear();
    m = new DeviceManager();
  });
  afterEach(() => {
    m.stop();
    vi.useRealTimers();
  });

  it('passes every 1.25 s on screen, every 5 s hidden, and at once when shown again', async () => {
    m.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(passes()).toBe(1);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(passes()).toBe(5);

    // Hidden: the pass already due at 1.25 s still runs, then one every 5 s.
    m.setWindowVisible(false);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(passes()).toBe(7);

    // Shown: a pass right away, then the on-screen cadence again.
    m.setWindowVisible(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(passes()).toBe(8);
    await vi.advanceTimersByTimeAsync(2_500);
    expect(passes()).toBe(10);
  });

  it('starts nothing when shown before it was started, or after it stopped', async () => {
    m.setWindowVisible(false);
    m.setWindowVisible(true);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(passes()).toBe(0);
    m.start();
    await vi.advanceTimersByTimeAsync(0);
    m.stop();
    m.setWindowVisible(false);
    m.setWindowVisible(true);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(passes()).toBe(1);
  });
});
