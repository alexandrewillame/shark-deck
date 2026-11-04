import type { StorageBackend } from '../../main/store';
import type { Kv } from './kv';

/**
 * The browser edition's `StorageBackend` (see main/store.ts), over a `Kv` —
 * IndexedDB in practice.
 *
 * The documents under config/ are all loaded into memory once, at boot, and
 * every write goes to the Kv first and to memory only once it has committed.
 * That is what lets `readJsonSync` answer without awaiting (settings are read
 * synchronously on every scan pass), and it keeps memory and storage from
 * disagreeing after a failed write. Backups can be large and are read on
 * demand instead.
 *
 * Keys are the logical names (`config/settings.json`); there are no folders,
 * so `ensureDirs` has nothing to do.
 */
export async function createWebStorage(kv: Kv): Promise<StorageBackend> {
  const docs = new Map(await kv.entries('docs'));

  const parse = <T>(raw: string | undefined, fallback: T): T => {
    if (raw === undefined) return fallback;
    try {
      return JSON.parse(raw) as T;
    } catch {
      // Unlike a file, an IndexedDB record is never half-written, so this is
      // not a crash mid-write — but it must not take settings down with it.
      return fallback;
    }
  };

  return {
    locate: (key) => key,
    ensureDirs: () => {},
    readJson: async (file, fallback) => parse(docs.get(file), fallback),
    readJsonSync: (file, fallback) => parse(docs.get(file), fallback),
    async writeJson(file, data) {
      const text = JSON.stringify(data);
      await kv.put('docs', file, text);
      docs.set(file, text);
    },
    listBackups: () => kv.keys('backups'),
    readBackupText: (name) => kv.get('backups', name),
    writeBackupText: (name, body) => kv.put('backups', name, body),
    async deleteBackup(name) {
      if ((await kv.get('backups', name)) === null) return false;
      await kv.delete('backups', name);
      return true;
    },
  };
}
