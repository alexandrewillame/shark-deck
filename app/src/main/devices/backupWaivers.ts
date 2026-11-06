import { paths, readJson, withFileLock, writeJson } from '../store';

/**
 * The user's one-time OK to write to a device whose backup cannot hold every
 * setting (drivers/base.ts `BackupPolicy`, kind `partial`) — kept per model
 * and firmware, because a firmware update can change what the device reports
 * back, and so what a backup can hold.
 *
 * Keyed by model like every per-model store (colors.ts, deviceState.ts): two
 * units of one model share the answer. A simulated device never reaches here
 * (manager.ts `ensureBackup` returns before any store is touched).
 */
type Store = Record<string, number>;

const keyOf = (model: string, firmware: string | null): string =>
  `${model}@${firmware ?? 'unknown'}`;

export async function hasBackupWaiver(model: string, firmware: string | null): Promise<boolean> {
  const store = await readJson<Store>(paths.backupWaivers(), {});
  return keyOf(model, firmware) in store;
}

export async function recordBackupWaiver(model: string, firmware: string | null): Promise<void> {
  await withFileLock(paths.backupWaivers(), async () => {
    const store = await readJson<Store>(paths.backupWaivers(), {});
    store[keyOf(model, firmware)] = Date.now();
    await writeJson(paths.backupWaivers(), store);
  });
}
