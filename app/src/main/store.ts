import { app } from 'electron';
import { promises as fs } from 'node:fs';
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';

const root = () => app.getPath('userData');

export const paths = {
  root,
  config: () => path.join(root(), 'config'),
  backups: () => path.join(root(), 'backups'),
  profiles: () => path.join(root(), 'config', 'profiles.json'),
  rules: () => path.join(root(), 'config', 'rules.json'),
  settings: () => path.join(root(), 'config', 'settings.json'),
  /** user-given names for a `profiles` device's onboard slots — see main/devices/profileNames.ts */
  onboardProfileNames: () => path.join(root(), 'config', 'onboard-profile-names.json'),
  /** user-chosen colour/edition variant per device model — see main/devices/colors.ts */
  deviceColors: () => path.join(root(), 'config', 'device-colors.json'),
  /** app-side macro library — see main/macros/store.ts */
  macroLibrary: () => path.join(root(), 'config', 'macro-library.json'),
  /** app-side per-key lighting preset library — see main/lighting/store.ts */
  perKeyLightingLibrary: () => path.join(root(), 'config', 'perkey-lighting-library.json'),
  /** app-side saved actuation layouts — see main/actuation/store.ts */
  actuationLayouts: () => path.join(root(), 'config', 'actuation-layouts.json'),
  /** actuation key groups, per model and onboard profile — see main/actuation/store.ts */
  keyGroups: () => path.join(root(), 'config', 'key-groups.json'),
  /** memoised exe -> icon data URL cache — see main/profiles/processIcons.ts */
  processIcons: () => path.join(root(), 'config', 'process-icons.json'),
  /** per-model scratchpad for device state with no read-back (e.g. the V8's
   *  receiver LEDs) — see main/devices/deviceState.ts */
  deviceState: () => path.join(root(), 'config', 'device-state.json'),
};

export function ensureDirs(): void {
  for (const p of [paths.config(), paths.backups()]) {
    if (!existsSync(p)) mkdirSync(p, { recursive: true });
  }
}

/**
 * Per-file promise chain. Every read-modify-write cycle on a JSON store runs
 * as the next link so two callers (e.g. the switcher's icon backfill timer and
 * a renderer `saveProfile`) can't both read the same file, mutate their own
 * copy, and have the later `writeJson` silently discard the earlier one.
 * Same idiom as `HidChannel.run` in hid/transport.ts.
 */
const fileLocks = new Map<string, Promise<unknown>>();

export function withFileLock<T>(file: string, fn: () => Promise<T>): Promise<T> {
  const prev = fileLocks.get(file) ?? Promise.resolve();
  const result = prev.then(fn, fn);
  // Swallow so a rejection here doesn't poison later holders of the same lock;
  // the caller still sees the real rejection via `result`.
  fileLocks.set(
    file,
    result.catch(() => undefined),
  );
  return result;
}

/**
 * Read a JSON store, distinguishing "file does not exist yet" (return the
 * fallback silently — normal first run) from "file exists but is unparseable"
 * (a truncated write from a crash / sync interruption). In the corruption case
 * the primary is preserved aside as `<file>.corrupt-<ts>` and a one-time
 * sibling `<file>.bak` (written by `writeJson` before each overwrite) is tried
 * before giving up — so a mid-write crash can't silently wipe a user's
 * profiles by having a downstream `seedDefaults()` reseed an empty array.
 */
export async function readJson<T>(file: string, fallback: T): Promise<T> {
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
      console.error(`[store] ${path.basename(file)} was unparseable; moved aside, using defaults`);
    } catch {
      /* best-effort */
    }
    return fallback;
  }
}

/**
 * Atomic JSON write: serialise to `<file>.tmp`, keep the current file as
 * `<file>.bak`, then `rename` the temp over the target. `rename` within one
 * directory is atomic on NTFS and POSIX, so a reader never sees a
 * half-written file and a crash mid-write leaves either the old or the new
 * content intact, plus a `.bak` `readJson` can fall back to.
 */
export async function writeJson(file: string, data: unknown): Promise<void> {
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
}

/** Reject anything that isn't a plain filename in the backups directory. */
function safeBackupName(file: string): string | null {
  const base = path.basename(file);
  return base === file && /^[\w.-]+\.json$/.test(base) ? base : null;
}

export async function listBackupFiles(model: string): Promise<string[]> {
  try {
    const files = await fs.readdir(paths.backups());
    return files
      .filter((f) => f.startsWith(model + '-') && f.endsWith('.json'))
      .sort()
      .reverse();
  } catch {
    return [];
  }
}

export async function writeBackup(
  model: string,
  serial: string,
  blocks: Record<string, string>,
): Promise<string> {
  ensureDirs();
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const safeSerial = serial.replace(/[^\w-]/g, '_').slice(0, 32) || 'noserial';
  const file = `${model}-${safeSerial}-${stamp}.json`;
  const full = path.join(paths.backups(), file);
  const tmp = `${full}.tmp`;
  await fs.writeFile(
    tmp,
    JSON.stringify({ model, serial, createdAt: Date.now(), blocks }, null, 2),
    'utf8',
  );
  await fs.rename(tmp, full);
  return file;
}

/**
 * Delete one backup file. `false` = the name was rejected by
 * `safeBackupName` or the file is already gone; either way there is nothing
 * left to delete, so the caller treats both the same.
 *
 * Deleting the last backup for a model is allowed on purpose: `ensureBackup`
 * short-circuits on `listBackupFiles(model).length > 0`, so the next write to
 * that device takes a fresh snapshot and the "backup before the first write"
 * invariant heals itself. The UI warns before that happens.
 */
export async function deleteBackupFile(file: string): Promise<boolean> {
  const safe = safeBackupName(file);
  if (!safe) return false;
  try {
    await fs.unlink(path.join(paths.backups(), safe));
    return true;
  } catch {
    return false;
  }
}

export async function readBackup(
  file: string,
): Promise<{ model: string; blocks: Record<string, string>; createdAt: number } | null> {
  const safe = safeBackupName(file);
  if (!safe) return null;
  try {
    const raw = await fs.readFile(path.join(paths.backups(), safe), 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
