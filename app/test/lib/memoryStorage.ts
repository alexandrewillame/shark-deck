import type { StorageBackend } from '../../src/main/store';

/**
 * A `StorageBackend` held in two Maps — for tests that need app data without
 * a temp dir. Documents are stored serialised, so a test sees the same
 * copy-on-write behaviour a real backend gives (mutating what `readJson`
 * returned changes nothing stored).
 */
export function createMemoryStorage(): StorageBackend & {
  docs: Map<string, string>;
  backups: Map<string, string>;
} {
  const docs = new Map<string, string>();
  const backups = new Map<string, string>();
  const parse = <T>(raw: string | undefined, fallback: T): T => {
    if (raw === undefined) return fallback;
    try {
      return JSON.parse(raw) as T;
    } catch {
      return fallback;
    }
  };
  return {
    docs,
    backups,
    locate: (key) => key,
    ensureDirs: () => {},
    readJson: async (file, fallback) => parse(docs.get(file), fallback),
    readJsonSync: (file, fallback) => parse(docs.get(file), fallback),
    writeJson: async (file, data) => {
      docs.set(file, JSON.stringify(data));
    },
    listBackups: async () => [...backups.keys()],
    readBackupText: async (name) => backups.get(name) ?? null,
    writeBackupText: async (name, body) => {
      backups.set(name, body);
    },
    deleteBackup: async (name) => backups.delete(name),
  };
}
