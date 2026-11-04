import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The live-state poll: DPI stage and polling rate can be changed with the
 * mouse's own buttons, so the manager re-reads them while a device's screen is
 * open and publishes them on `LiveDevice`.
 *
 * Everything here runs against simulated devices on a mocked, empty node-hid
 * bus — same harness as manager-devmode.test.ts, including its assertion that
 * no per-model store is written (a poll reads; it must never write).
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

const mockSettings = { devMode: true, language: 'en', batteryLowThreshold: 15 };
vi.mock('../settings', () => ({
  getSettingsSync: () => mockSettings,
  getSettings: async () => mockSettings,
  setSettings: async () => mockSettings,
}));

const writes: string[] = [];
vi.mock('../store', () => ({
  paths: {
    deviceState: () => '/tmp/device-state.json',
    deviceColors: () => '/tmp/device-colors.json',
    onboardProfileNames: () => '/tmp/onboard-names.json',
  },
  readJson: async (_p: string, d: unknown) => d,
  writeJson: async (p: string) => void writes.push(`writeJson:${p}`),
  withFileLock: <T>(_p: string, fn: () => Promise<T>) => fn(),
  listBackupFiles: async () => [],
  writeBackup: async (m: string) => {
    writes.push(`writeBackup:${m}`);
    return 'f.json';
  },
}));

import { DeviceManager } from './manager';
import type { Driver } from './drivers';

const scanOnce = (m: DeviceManager) => (m as unknown as { scan(): Promise<void> }).scan();
/** Pretend LIVE_POLL_MS has elapsed, without waiting 3 real seconds. */
const makeDue = (m: DeviceManager, id: string) => {
  const e = (m as unknown as { entries: Map<string, { lastLivePoll: number }> }).entries.get(id)!;
  e.lastLivePoll = 0;
};
const mouseOf = (m: DeviceManager) =>
  m.list().find((d) => d.kind === 'mouse' && d.capabilities.includes('dpi'))!;

describe('live device-state poll', () => {
  let mgr: DeviceManager;

  beforeEach(async () => {
    writes.length = 0;
    mockSettings.devMode = true;
    mgr = new DeviceManager();
    mgr.configure({ allowSimulated: true }); // an unpackaged desktop build
    await scanOnce(mgr);
  });

  it('does not poll a device nobody is looking at', async () => {
    const id = mouseOf(mgr).id;
    const spy = vi.spyOn(mgr.getDriver(id) as Driver, 'readLiveState');
    makeDue(mgr, id);
    await scanOnce(mgr);
    expect(spy).not.toHaveBeenCalled();
    expect(mouseOf(mgr).pollRate).toBeNull();
  });

  it('fills in DPI stage, DPI value and poll rate once its screen is open', async () => {
    const id = mouseOf(mgr).id;
    mgr.setLiveWatch(id, true);
    await scanOnce(mgr);
    const d = mouseOf(mgr);
    expect(d.activeDpiStage).not.toBeNull();
    expect(d.pollRate).not.toBeNull();
    expect(d.activeDpi).toBeGreaterThan(0);
  });

  it('follows a change made on the device itself', async () => {
    const id = mouseOf(mgr).id;
    mgr.setLiveWatch(id, true);
    await scanOnce(mgr);
    // Writing straight to the driver is the stand-in for someone pressing the
    // mouse's own DPI button: the app never learns about it any other way.
    await mgr.getDriver(id)!.setActiveDpiStage(1);
    makeDue(mgr, id);
    await scanOnce(mgr);
    expect(mouseOf(mgr).activeDpiStage).toBe(1);
  });

  it('honours the cadence — a watched device is not read on every pass', async () => {
    const id = mouseOf(mgr).id;
    mgr.setLiveWatch(id, true);
    await scanOnce(mgr); // first poll (lastLivePoll was 0)
    const spy = vi.spyOn(mgr.getDriver(id) as Driver, 'readLiveState');
    await scanOnce(mgr);
    await scanOnce(mgr);
    expect(spy).not.toHaveBeenCalled(); // LIVE_POLL_MS has not elapsed
  });

  it('stands down while a write is in flight, and resumes after it', async () => {
    const id = mouseOf(mgr).id;
    mgr.setLiveWatch(id, true);
    await scanOnce(mgr);
    const spy = vi.spyOn(mgr.getDriver(id) as Driver, 'readLiveState');

    mgr.noteWriteStart(id);
    makeDue(mgr, id);
    await scanOnce(mgr);
    expect(spy).not.toHaveBeenCalled();

    // Ending the write starts the quiet window; only past it may polling run.
    mgr.noteWriteEnd(id);
    makeDue(mgr, id);
    await scanOnce(mgr);
    expect(spy).not.toHaveBeenCalled();

    const e = (mgr as unknown as { writeQuiet: Map<string, { at: number }> }).writeQuiet.get(id)!;
    e.at = Date.now() - 10_000;
    makeDue(mgr, id);
    await scanOnce(mgr);
    expect(spy).toHaveBeenCalled();
  });

  it('stops polling when the screen closes', async () => {
    const id = mouseOf(mgr).id;
    mgr.setLiveWatch(id, true);
    await scanOnce(mgr);
    mgr.setLiveWatch(id, false);
    const spy = vi.spyOn(mgr.getDriver(id) as Driver, 'readLiveState');
    makeDue(mgr, id);
    await scanOnce(mgr);
    expect(spy).not.toHaveBeenCalled();
  });

  it('clearLiveWatches() drops every watch, for a renderer that went away', async () => {
    const id = mouseOf(mgr).id;
    mgr.setLiveWatch(id, true);
    await scanOnce(mgr);
    mgr.clearLiveWatches();
    const spy = vi.spyOn(mgr.getDriver(id) as Driver, 'readLiveState');
    makeDue(mgr, id);
    await scanOnce(mgr);
    expect(spy).not.toHaveBeenCalled();
  });

  it('stops asking a driver whose very first answer is null — it has no probe', async () => {
    const id = mouseOf(mgr).id;
    const spy = vi.spyOn(mgr.getDriver(id) as Driver, 'readLiveState').mockResolvedValue(null);
    mgr.setLiveWatch(id, true);
    await scanOnce(mgr);
    expect(spy).toHaveBeenCalledTimes(1);
    makeDue(mgr, id);
    await scanOnce(mgr);
    expect(spy).toHaveBeenCalledTimes(1); // latched off, permanently
  });

  it('keeps asking a driver that answered once and then dozed', async () => {
    // A later null is a sleeping mouse, not a driver without a probe —
    // latching on that would silently kill monitoring for the rest of the run.
    const id = mouseOf(mgr).id;
    mgr.setLiveWatch(id, true);
    await scanOnce(mgr); // a real answer first
    const spy = vi.spyOn(mgr.getDriver(id) as Driver, 'readLiveState').mockResolvedValue(null);
    makeDue(mgr, id);
    await scanOnce(mgr);
    makeDue(mgr, id);
    await scanOnce(mgr);
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('writes nothing to any per-model store while polling', async () => {
    for (const d of mgr.list()) mgr.setLiveWatch(d.id, true);
    await scanOnce(mgr);
    await scanOnce(mgr);
    expect(writes).toEqual([]);
  });
});
