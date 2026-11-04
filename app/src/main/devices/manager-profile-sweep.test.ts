import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `snapshotProfiles` / `copyProfile` — the two paths that drive the device
 * through every onboard slot, because no read in the protocol takes a profile
 * argument.
 *
 * Both have a correctness property that is invisible in the return value and
 * expensive to get wrong on real hardware:
 *
 *  - the device must end on the slot it started from, including when a slot
 *    fails partway through. Leaving someone's keyboard on a profile they did
 *    not choose is worse than the failed read.
 *  - the hops must be SILENT. `noteActiveProfile` emits `devices:changed`,
 *    which makes DeviceConfig drop the device cache and bump `configEpoch`;
 *    announcing each hop would remount every pane and start a cold re-read
 *    four times over, competing with the very reads the sweep is doing.
 *
 * Run against simulated devices, which already keep real per-slot state
 * (`virtual.ts`'s `slotStates`), so this needs no hardware.
 */

vi.mock('node-hid', () => ({
  default: {
    devicesAsync: async () => [],
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
vi.mock('../store', () => ({
  paths: {
    deviceState: () => '/tmp/device-state.json',
    deviceColors: () => '/tmp/device-colors.json',
    onboardProfileNames: () => '/tmp/onboard-names.json',
  },
  readJson: async (_p: string, d: unknown) => d,
  writeJson: async () => {},
  withFileLock: <T>(_p: string, fn: () => Promise<T>) => fn(),
  listBackupFiles: async () => [],
  writeBackup: async () => 'f.json',
}));

import { DeviceManager } from './manager';
import type { Driver } from './drivers';
import type { ProfileField } from '@shared/types/profiles';

const scanOnce = (m: DeviceManager) =>
  (m as unknown as { scan(): Promise<void> }).scan() as Promise<void>;

/**
 * ProfileField -> the argument-free Driver read the sweep uses for it.
 * `keyRemapBase` / `keyRemapFn` are absent on purpose: they share one method
 * that takes a layer, so they cannot be spied on by field alone.
 */
type DriverRead = {
  [K in keyof Driver]: Driver[K] extends () => Promise<unknown> ? K : never;
}[keyof Driver];

const READ_OF: Partial<Record<ProfileField, DriverRead>> = {
  pollRate: 'readPollRate',
  debounce: 'readDebounce',
  power: 'readPower',
  sensor: 'readSensor',
  dpiStages: 'readDpiStages',
  buttons: 'readButtons',
  lighting: 'readLighting',
  sideLighting: 'readSideLighting',
  perKeyLighting: 'readPerKeyLighting',
  magnetic: 'readMagnetic',
  switchTypes: 'readSwitchTypes',
};

/** The first simulated device with onboard profiles. */
function withProfiles(mgr: DeviceManager) {
  const d = mgr.list().find((x) => x.capabilities.includes('profiles'));
  if (!d) throw new Error('no simulated device with profiles');
  return d;
}

describe('sweeping every onboard profile', () => {
  let mgr: DeviceManager;

  beforeEach(async () => {
    mgr = new DeviceManager();
    mgr.configure({ allowSimulated: true }); // an unpackaged desktop build
    await scanOnce(mgr);
  });

  it('reads every slot and reports which fields it could compare', async () => {
    const dev = withProfiles(mgr);
    const snap = await mgr.snapshotProfiles(dev.id);

    expect(snap.slots).toHaveLength(mgr.getDescriptor(dev.id)!.spec.profileCount ?? 4);
    expect(snap.slots.map((s) => s.slot)).toEqual(snap.slots.map((_, i) => i + 1));
    expect(snap.fields.length).toBeGreaterThan(0);
    for (const s of snap.slots) {
      expect(s.error, `slot ${s.slot}`).toBeUndefined();
      // Every field the sweep claims to compare has to appear on every slot,
      // or the table has holes the UI would read as "differs".
      expect(Object.keys(s.values).sort()).toEqual([...snap.fields].sort());
    }
  });

  it('puts the device back on the slot it started from', async () => {
    const dev = withProfiles(mgr);
    const driver = mgr.getDriver(dev.id)!;
    await driver.setActiveProfile(3);

    const snap = await mgr.snapshotProfiles(dev.id);

    expect(snap.restoredTo).toBe(3);
    expect(await driver.getActiveProfile()).toBe(3);
  });

  it('puts it back even when a read fails partway through', async () => {
    const dev = withProfiles(mgr);
    const driver = mgr.getDriver(dev.id)!;
    await driver.setActiveProfile(2);

    // Break whichever read this device actually does — which fields exist
    // depends on the descriptor, so the test picks one rather than assuming.
    const field = (await mgr.snapshotProfiles(dev.id)).fields.find((f) => READ_OF[f]);
    if (!field) return; // this device only exposes the layered reads
    const method = READ_OF[field]!;
    let calls = 0;
    const real = (driver[method] as () => Promise<unknown>).bind(driver);
    vi.spyOn(driver, method).mockImplementation((async () => {
      if (++calls === 2) throw new Error('boom');
      return real();
    }) as never);

    const snap = await mgr.snapshotProfiles(dev.id);

    // The failure is contained to its own field: not the slot, not the sweep.
    expect(snap.slots).toHaveLength(4);
    expect(snap.slots[1]!.values[field]).toBeNull();
    expect(snap.slots[1]!.error).toBeUndefined();
    expect(snap.slots[0]!.values[field]).not.toBeNull();
    expect(await driver.getActiveProfile()).toBe(2);
  });

  it('makes no noise while it hops — no devices:changed, no epoch bump', async () => {
    const dev = withProfiles(mgr);
    // Drain the attach event first; only what the sweep itself emits counts.
    const emitted: unknown[] = [];
    mgr.on('devices:changed', (l) => emitted.push(l));

    await mgr.snapshotProfiles(dev.id);

    expect(emitted).toEqual([]);
    // And the manager's own idea of the active slot is untouched, since it is
    // what `DeviceConfig` watches.
    expect(mgr.getActiveProfile(dev.id)).toBe(1);
  });

  it('copies one field without touching the others', async () => {
    const dev = withProfiles(mgr);
    const driver = mgr.getDriver(dev.id)!;
    const snap = await mgr.snapshotProfiles(dev.id);
    const field = snap.fields.find((f) => f === 'lighting' || f === 'pollRate');
    if (!field) return; // no simulated device exposes either — nothing to assert

    const r = await mgr.copyProfile(dev.id, 1, 2, [field]);

    expect(r.ok, r.error).toBe(true);
    const after = await mgr.snapshotProfiles(dev.id);
    expect(JSON.stringify(after.slots[1]!.values[field])).toBe(
      JSON.stringify(after.slots[0]!.values[field]),
    );
    expect(await driver.getActiveProfile()).toBe(1);
  });

  it('refuses to copy a profile onto itself', async () => {
    const dev = withProfiles(mgr);
    const r = await mgr.copyProfile(dev.id, 2, 2);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/same/i);
  });

  it('is silent while copying too', async () => {
    const dev = withProfiles(mgr);
    const emitted: unknown[] = [];
    mgr.on('devices:changed', (l) => emitted.push(l));
    await mgr.copyProfile(dev.id, 1, 2);
    expect(emitted).toEqual([]);
  });

  it('compares and copies only actuation on a keyboard', async () => {
    // Everything else a keyboard reads is one register whatever the slot (see
    // profileFieldsFor), so comparing it would show the same value against
    // itself and copying it would rewrite it with its own contents.
    const kb = mgr
      .list()
      .find((x) => x.kind === 'keyboard' && x.capabilities.includes('magneticSwitches'));
    if (!kb) throw new Error('no simulated Hall-effect keyboard');
    const driver = mgr.getDriver(kb.id)!;

    expect((await mgr.snapshotProfiles(kb.id)).fields).toEqual(['magnetic']);

    const poll = vi.spyOn(driver, 'setPollRate');
    const light = vi.spyOn(driver, 'setLighting');
    const r = await mgr.copyProfile(kb.id, 1, 2);
    expect(r.ok, r.error).toBe(true);
    expect(poll).not.toHaveBeenCalled();
    expect(light).not.toHaveBeenCalled();
    expect(await driver.getActiveProfile()).toBe(1);
  });

  it('writes one key onto another slot and comes back, silently', async () => {
    // The comparator's per-key copy: the board is on slot 1, the key goes to
    // slot 2, and nothing may announce the hop (see the sweep tests above).
    const kb = mgr
      .list()
      .find((x) => x.kind === 'keyboard' && x.capabilities.includes('magneticSwitches'));
    if (!kb) throw new Error('no simulated Hall-effect keyboard');
    const driver = mgr.getDriver(kb.id)!;
    await driver.setActiveProfile(1);
    const before = await driver.readMagnetic();
    const key = { ...before[0]!, actuationMm: 3.7 };
    const emitted: unknown[] = [];
    mgr.on('devices:changed', (l) => emitted.push(l));

    const r = await mgr.setMagneticKeysOnProfile(kb.id, 2, [key]);

    expect(r.ok, r.error).toBe(true);
    expect(emitted).toEqual([]);
    expect(await driver.getActiveProfile()).toBe(1);
    expect((await driver.readMagnetic())[0]!.actuationMm).toBe(before[0]!.actuationMm);
    await driver.setActiveProfile(2);
    expect((await driver.readMagnetic())[0]!.actuationMm).toBe(3.7);
  });

  it('never writes a per-model store for a simulated device', async () => {
    // The same rule ensureBackup / the lighting library follow: these stores
    // are keyed by MODEL and shared with real hardware of the same model, so a
    // fake V8 must not write into the real V8's backups.
    const dev = withProfiles(mgr);
    const backup = vi.spyOn(mgr, 'ensureBackup');
    await mgr.snapshotProfiles(dev.id);
    expect(backup).not.toHaveBeenCalled();
  });
});
