import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Developer mode's *lifecycle* through the real DeviceManager scan loop: that
 * simulated devices attach when the setting is on, come up online (the config
 * screen disables every control on an offline device), and — the part with no
 * teardown code of its own — are removed by the ordinary prune sweep when the
 * setting goes off.
 *
 * node-hid is mocked to an empty bus, so this is also the assertion that dev
 * mode needs no hardware at all.
 */

const mockDevicesAsync = vi.fn(async () => [] as unknown[]);
vi.mock('node-hid', () => ({
  default: {
    devicesAsync: (...a: unknown[]) => mockDevicesAsync(...(a as [])),
    HID: class {},
    HIDAsync: { open: vi.fn(async () => ({ close: vi.fn() })) },
  },
}));

// The store/settings modules reach for Electron's userData dir; keep it all in
// memory so the test cannot touch the developer's real config.
vi.mock('electron', () => ({ app: { getPath: () => '/tmp/sharkdeck-test', isPackaged: false } }));

const mockSettings = { devMode: false, language: 'en', batteryLowThreshold: 15 };
vi.mock('../settings', () => ({
  getSettingsSync: () => mockSettings,
  getSettings: async () => mockSettings,
  setSettings: async () => mockSettings,
}));

// Per-model side stores: assert they are never written, rather than stubbing
// them out silently.
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
import { virtualDescriptors } from './virtual';

/** Drive one scan pass without waiting on the 2.5s timer chain. */
async function scanOnce(m: DeviceManager): Promise<void> {
  await (m as unknown as { scan(): Promise<void> }).scan();
}

describe('developer mode through the scan loop', () => {
  let mgr: DeviceManager;

  beforeEach(() => {
    writes.length = 0;
    mockSettings.devMode = false;
    mgr = new DeviceManager();
  });

  it('lists nothing with dev mode off and no hardware', async () => {
    await scanOnce(mgr);
    expect(mgr.list()).toEqual([]);
  });

  it('attaches one online device per supported shape when switched on', async () => {
    mockSettings.devMode = true;
    await scanOnce(mgr);

    const devices = mgr.list();
    expect(devices).toHaveLength(virtualDescriptors().length);
    for (const d of devices) {
      // DeviceConfig greys out its whole fieldset unless the device is online.
      expect(d.online, d.model).toBe(true);
      expect(d.capabilities.length, d.model).toBeGreaterThan(0);
      expect(d.hint, d.model).toBeTruthy();
      expect(mgr.getDescriptor(d.id)?.simulated, d.model).toBe(true);
      expect(mgr.getDriver(d.id), d.model).not.toBeNull();
    }
  });

  it('emits devices:changed on attach and again on removal', async () => {
    const seen: number[] = [];
    mgr.on('devices:changed', (list: unknown[]) => seen.push(list.length));

    mockSettings.devMode = true;
    await scanOnce(mgr);
    mockSettings.devMode = false;
    await scanOnce(mgr);

    expect(seen[0]).toBe(virtualDescriptors().length);
    expect(seen[seen.length - 1]).toBe(0);
  });

  it('is pruned by the ordinary sweep when switched off — no teardown of its own', async () => {
    mockSettings.devMode = true;
    await scanOnce(mgr);
    expect(mgr.list().length).toBeGreaterThan(0);

    mockSettings.devMode = false;
    await scanOnce(mgr);
    expect(mgr.list()).toEqual([]);
  });

  it('is stable across repeated passes — no duplicate cards', async () => {
    mockSettings.devMode = true;
    await scanOnce(mgr);
    await scanOnce(mgr);
    await scanOnce(mgr);
    expect(mgr.list()).toHaveLength(virtualDescriptors().length);
    expect(new Set(mgr.list().map((d) => d.id)).size).toBe(virtualDescriptors().length);
  });

  it('never writes to a per-model store, and takes no backup', async () => {
    mockSettings.devMode = true;
    await scanOnce(mgr);

    for (const d of mgr.list()) {
      expect(await mgr.ensureBackup(d.id), d.model).toBe(false);
      expect(d.hasBackup, d.model).toBe(false);
    }
    expect(writes).toEqual([]);
  });
});

describe('nudgeScan() does not fork a second scan-timer chain', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mockSettings.devMode = false;
  });
  afterEach(() => {
    vi.useRealTimers();
    mockDevicesAsync.mockImplementation(async () => []);
  });

  it('coalesces nudges made during an in-flight scan into a single reschedule', async () => {
    // Block the first scan inside HID enumeration so it stays "in flight".
    let release!: () => void;
    mockDevicesAsync.mockImplementation(
      () =>
        new Promise<unknown[]>((res) => {
          release = () => res([]);
        }),
    );

    const mgr = new DeviceManager();
    const priv = mgr as unknown as { timer: unknown; scanning: boolean; rescanRequested: boolean };
    mgr.start();

    await vi.advanceTimersByTimeAsync(1); // let the 0ms timer fire; scan now awaits devicesAsync
    expect(priv.scanning).toBe(true);
    expect(priv.timer).toBeNull(); // the firing timer cleared itself

    for (let i = 0; i < 5; i++) mgr.nudgeScan();
    expect(priv.timer).toBeNull(); // no new chain forked
    expect(priv.rescanRequested).toBe(true);

    release();
    // The scan's tail + its `.finally` reschedule are a microtask chain, not
    // timers — drain them.
    for (let i = 0; i < 30; i++) await Promise.resolve();
    expect(priv.scanning).toBe(false);
    expect(priv.rescanRequested).toBe(false);
    expect(priv.timer).not.toBeNull(); // exactly one pending timer

    mgr.stop();
  });
});
