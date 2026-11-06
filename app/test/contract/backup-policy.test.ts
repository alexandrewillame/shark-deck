import { describe, expect, it, vi } from 'vitest';

// The driver modules reach the HID transport, and so node-hid; nothing here
// talks to a device, but the native module must not load in a test process.
vi.mock('node-hid', () => ({
  default: { devicesAsync: async () => [], HIDAsync: { open: vi.fn() } },
}));

const { DRIVERS } = await import('../../src/main/devices/drivers');
const { BACKUP_META_BLOCKS } = await import('../../src/main/devices/drivers/base');
const { CATALOG } = await import('../../src/main/devices/catalog');
const { KEYBOARDS } = await import('../../src/main/devices/catalog/keyboards');
const { hubMouseRoster } = await import('../../src/main/devices/catalog/hub-mice');
const { GEARHUB_MICE } = await import('../../src/main/devices/catalog/gearhub-mice');
const { jxcMouseRoster } = await import('../../src/main/devices/catalog/jxc-mice');

/**
 * CLAUDE.md invariant #1: a backup before the first write to any device.
 * `guardedWrite` (ipc-guarded-write.test.ts) proves every write asks for one;
 * this proves every driver says what one has to HOLD — `ensureBackup` refuses
 * the write until a backup does (drivers/base.ts `BackupPolicy`):
 *
 *  - `full`: at least one required block, and none of them a meta block that
 *    holds no setting (a backup of only `schema` + `firmware` used to count);
 *  - `partial`: the settings it cannot report are named, because the user is
 *    asked to accept exactly those before the first write.
 *
 * Checked for every descriptor each driver is used with, since a policy may
 * depend on the model (a PAW3955 mouse's DPI block, the profile count).
 */

/** Drivers that never write, with the reason; nothing else may skip a policy. */
const NEVER_WRITES: Record<string, string> = {
  'royuan-identify': 'sends only the identify command until the device says what it is',
  'hub-identify': 'sends only the identify command until the device says what it is',
  'no-io': 'a read-only card: no I/O at all',
};

const descriptors = [
  ...CATALOG,
  ...KEYBOARDS,
  ...hubMouseRoster(),
  ...GEARHUB_MICE.values(),
  ...jxcMouseRoster(),
].filter((d) => d.identity !== 'unsupported');

describe('backup policies', () => {
  it('covers a known set of drivers', () => {
    expect(Object.keys(DRIVERS).length).toBeGreaterThan(3);
    for (const key of Object.keys(NEVER_WRITES)) expect(DRIVERS, key).toHaveProperty(key);
  });

  it('gives every descriptor a registered driver', () => {
    for (const d of descriptors) expect(DRIVERS, d.model).toHaveProperty(d.driver);
  });

  for (const [key, Ctor] of Object.entries(DRIVERS)) {
    if (key in NEVER_WRITES) continue;
    const users = descriptors.filter((d) => d.driver === key);
    it(`${key}: is used by some descriptor`, () => {
      expect(users.length).toBeGreaterThan(0);
    });
    it(`${key}: says what a backup must hold, for every model it drives`, () => {
      for (const d of users) {
        const drv = new Ctor({ descriptor: d, channel: null as never, onWarning: () => undefined });
        const p = drv.backupPolicy();
        if (p.kind === 'full') {
          expect(
            p.required.length,
            `${d.model}: a full backup with nothing required`,
          ).toBeGreaterThan(0);
        } else {
          expect(p.unreadable?.length, `${d.model}: partial, but names nothing`).toBeGreaterThan(0);
        }
        for (const b of p.required) {
          expect(BACKUP_META_BLOCKS.has(b), `${d.model}: "${b}" holds no setting`).toBe(false);
        }
      }
    });
  }
});
