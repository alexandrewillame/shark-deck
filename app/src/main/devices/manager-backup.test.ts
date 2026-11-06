import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DeviceDescriptor } from '@shared/types/device';
import type { LiveDevice } from '@shared/types/live';

/**
 * What `ensureBackup` accepts as the backup before a first write (CLAUDE.md
 * invariant #1), against the driver's `backupPolicy()`. In-memory store; the
 * driver is a stub that returns whatever blocks a test hands it.
 */

vi.mock('node-hid', () => ({
  default: { devicesAsync: async () => [], HID: class {}, HIDAsync: { open: vi.fn() } },
}));
vi.mock('electron', () => ({ app: { getPath: () => '/tmp/sharkdeck-test', isPackaged: false } }));
vi.mock('../settings', () => {
  const s = { devMode: false, language: 'en', batteryLowThreshold: 15 };
  return { getSettingsSync: () => s, getSettings: async () => s, setSettings: async () => s };
});

const files = new Map<string, { model: string; blocks: Record<string, string> }>();
const json = new Map<string, unknown>();
let seq = 0;
vi.mock('../store', () => ({
  paths: {
    deviceState: () => 'device-state.json',
    deviceColors: () => 'device-colors.json',
    onboardProfileNames: () => 'onboard-names.json',
    backupWaivers: () => 'backup-waivers.json',
  },
  readJson: async (p: string, d: unknown) => (json.has(p) ? structuredClone(json.get(p)) : d),
  writeJson: async (p: string, v: unknown) => void json.set(p, structuredClone(v)),
  withFileLock: <T>(_p: string, fn: () => Promise<T>) => fn(),
  listBackupFiles: async (model: string) =>
    [...files.keys()]
      .filter((f) => f.startsWith(model + '-'))
      .sort()
      .reverse(),
  writeBackup: async (model: string, _serial: string, blocks: Record<string, string>) => {
    const f = `${model}-${String(++seq).padStart(4, '0')}.json`;
    files.set(f, { model, blocks: { ...blocks } });
    return f;
  },
  readBackup: async (f: string) => files.get(f) ?? null,
}));

import { DeviceManager } from './manager';
import type { BackupPolicy } from './drivers/base';

const MODEL = 'test-mouse';
const descriptor = {
  model: MODEL,
  displayName: 'Test mouse',
  vendor: 'Attack Shark',
  kind: 'mouse',
  vid: 0x3554,
  pid: 0xf517,
  usagePage: 0xff02,
  usage: 2,
  reportLength: 17,
  transport: 'output-report',
  checksum: 'shark-sum',
  driver: 'compx-mouse-8k',
  provenance: 'inferred',
  art: null,
  identity: 'class',
  capabilities: ['dpi'],
  spec: {},
} as DeviceDescriptor;

function attach(policy: BackupPolicy, blocks: Record<string, string>) {
  const mgr = new DeviceManager();
  const driver = {
    backupPolicy: () => policy,
    backup: vi.fn(async () => ({ ...blocks })),
    getFirmware: async () => ({ device: 'v1.00', receiver: null, readState: 'ok' as const }),
  };
  const live = {
    id: 'dev',
    model: MODEL,
    hasBackup: false,
    firmware: null,
  } as unknown as LiveDevice;
  (mgr as unknown as { entries: Map<string, unknown> }).entries.set('dev', {
    descriptor,
    channel: { deviceKey: 'serial' },
    driver,
    live,
  });
  return { mgr, driver, live };
}

const FULL: BackupPolicy = { kind: 'full', required: ['profile1', 'profile2'] };
const PARTIAL: BackupPolicy = { kind: 'partial', required: ['profile1'], unreadable: ['dpi'] };

beforeEach(() => {
  files.clear();
  json.clear();
});

describe('ensureBackup', () => {
  it('refuses a backup that read nothing but its meta blocks', async () => {
    const { mgr } = attach(FULL, { schema: '2', firmware: '{}' });
    expect(await mgr.ensureBackup('dev')).toBe(false);
    expect(files.size).toBe(0);
  });

  it('refuses a full backup missing a required block, and stores nothing', async () => {
    const { mgr } = attach(FULL, { schema: '2', profile1: 'aa' });
    expect(await mgr.ensureBackup('dev')).toBe(false);
    expect(files.size).toBe(0);
  });

  it('accepts a complete one, with an identity block beside it', async () => {
    const { mgr, live } = attach(FULL, { schema: '2', profile1: 'aa', profile2: 'bb' });
    expect(await mgr.ensureBackup('dev')).toBe(true);
    expect(live.hasBackup).toBe(true);
    const [stored] = [...files.values()];
    expect(JSON.parse(stored!.blocks.identity!)).toMatchObject({ model: MODEL, vid: 0x3554 });
  });

  it('takes a fresh backup when the stored one predates what the policy requires', async () => {
    files.set(`${MODEL}-0000.json`, { model: MODEL, blocks: { schema: '2', firmware: '{}' } });
    const { mgr, driver } = attach(FULL, { schema: '2', profile1: 'aa', profile2: 'bb' });
    expect(await mgr.ensureBackup('dev')).toBe(true);
    expect(driver.backup).toHaveBeenCalledTimes(1);
    expect(files.size).toBe(2);
    // …and does not re-read the device on the next write
    expect(await mgr.ensureBackup('dev')).toBe(true);
    expect(driver.backup).toHaveBeenCalledTimes(1);
  });

  it('holds a partial device until the user has said yes, once per model + firmware', async () => {
    const { mgr, live } = attach(PARTIAL, { profile1: 'aa' });
    expect(await mgr.ensureBackup('dev')).toBe(false);
    // the readable part is backed up straight away, and the question is up
    expect(files.size).toBe(1);
    expect(live.backupWaiver).toEqual({ unreadable: ['dpi'] });

    await mgr.acknowledgeNoBackup('dev');
    expect(live.backupWaiver).toBeUndefined();
    expect(await mgr.ensureBackup('dev')).toBe(true);

    // a second unit of the model on the same firmware is not asked again
    const other = attach(PARTIAL, { profile1: 'cc' });
    expect(await other.mgr.ensureBackup('dev')).toBe(true);
  });

  it('never backs up a device that has not identified, or another brand', async () => {
    for (const identity of ['pending', 'foreign', 'unknown', 'unsupported'] as const) {
      const { mgr, driver } = attach(FULL, { profile1: 'aa', profile2: 'bb' });
      const e = (
        mgr as unknown as { entries: Map<string, { descriptor: DeviceDescriptor }> }
      ).entries.get('dev')!;
      e.descriptor = { ...descriptor, identity };
      expect(await mgr.ensureBackup('dev'), identity).toBe(false);
      expect(driver.backup, identity).not.toHaveBeenCalled();
    }
  });
});
