import { promises as fs } from 'node:fs';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { StorageBackend } from './store';

/**
 * The desktop app's storage: JSON files under Electron's userData folder
 * (`root` is read on every call, so tests can point it at a fresh temp dir).
 * Installed by main/bootstrapStorage.ts; the browser edition has its own
 * backend over IndexedDB. The robustness rules below are the reason this file
 * exists rather than plain `readFile` / `writeFile`.
 */
export function createFsStorage(root: () => string): StorageBackend {
  const at = (key: string): string => (key ? path.join(root(), ...key.split('/')) : root());
  const backupsDir = (): string => at('backups');

  function ensureDirs(): void {
    for (const p of [at('config'), backupsDir()]) {
      if (!existsSync(p)) mkdirSync(p, { recursive: true });
    }
  }

  return {
    locate: at,
    ensureDirs,

    /**
     * Distinguishes "file does not exist yet" (return the fallback silently —
     * normal first run) from "file exists but is unparseable" (a truncated
     * write from a crash / sync interruption). In the corruption case the
     * primary is preserved aside as `<file>.corrupt-<ts>` and a one-time
     * sibling `<file>.bak` (written by `writeJson` before each overwrite) is
     * tried before giving up — so a mid-write crash can't silently wipe a
     * user's profiles by having a downstream `seedDefaults()` reseed an empty
     * array.
     */
    async readJson<T>(file: string, fallback: T): Promise<T> {
      let raw: string;
      try {
        raw = await fs.readFile(file, 'utf8');
      } catch {
        return fallback; // genuinely absent
      }
      try {
        return JSON.parse(raw) as T;
      } catch {
        // Unparseable. Try the last-good backup first.
        try {
          const bak = await fs.readFile(`${file}.bak`, 'utf8');
          const parsed = JSON.parse(bak) as T;
          console.error(`[store] ${path.basename(file)} was unparseable; recovered from .bak`);
          return parsed;
        } catch {
          /* no usable backup */
        }
        try {
          await fs.rename(file, `${file}.corrupt-${Date.now()}`);
          console.error(
            `[store] ${path.basename(file)} was unparseable; moved aside, using defaults`,
          );
        } catch {
          /* best-effort */
        }
        return fallback;
      }
    },

    /** Best-effort and never throws: an absent or unparseable file is `fallback`. */
    readJsonSync<T>(file: string, fallback: T): T {
      try {
        return JSON.parse(readFileSync(file, 'utf8')) as T;
      } catch {
        return fallback;
      }
    },

    /**
     * Atomic JSON write: serialise to `<file>.tmp`, keep the current file as
     * `<file>.bak`, then `rename` the temp over the target. `rename` within one
     * directory is atomic on NTFS and POSIX, so a reader never sees a
     * half-written file and a crash mid-write leaves either the old or the new
     * content intact, plus a `.bak` `readJson` can fall back to.
     */
    async writeJson(file: string, data: unknown): Promise<void> {
      ensureDirs();
      const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
      const body = JSON.stringify(data, null, 2);
      await fs.writeFile(tmp, body, 'utf8');
      try {
        await fs.copyFile(file, `${file}.bak`);
      } catch {
        /* no prior file to back up — fine on first write */
      }
      await fs.rename(tmp, file);
    },

    async listBackups(): Promise<string[]> {
      try {
        return await fs.readdir(backupsDir());
      } catch {
        return [];
      }
    },

    async readBackupText(name: string): Promise<string | null> {
      try {
        return await fs.readFile(path.join(backupsDir(), name), 'utf8');
      } catch {
        return null;
      }
    },

    async writeBackupText(name: string, body: string): Promise<void> {
      ensureDirs();
      const full = path.join(backupsDir(), name);
      const tmp = `${full}.tmp`;
      await fs.writeFile(tmp, body, 'utf8');
      await fs.rename(tmp, full);
    },

    async deleteBackup(name: string): Promise<boolean> {
      try {
        await fs.unlink(path.join(backupsDir(), name));
        return true;
      } catch {
        return false;
      }
    },
  };
}
