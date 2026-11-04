/**
 * App-side persistence: the JSON documents under `config/` (settings, the
 * macro / lighting / actuation libraries, onboard-profile names, …) and the
 * device backups under `backups/`.
 *
 * Host-neutral. The I/O is a `StorageBackend` the host installs once at
 * startup — files under Electron's userData folder on the desktop
 * (store-fs.ts, installed by bootstrapStorage.ts), IndexedDB in the browser
 * edition (src/web/host/storage-idb.ts). What lives here is the policy both
 * share: the key names, the per-file lock, and how backups are named,
 * listed and validated.
 */

export interface StorageBackend {
  /**
   * Where a key such as `config/settings.json` is kept: an absolute file path
   * on disk, the key itself in the browser. `''` is the root. Callers treat
   * the result as an opaque handle to pass back to the methods below.
   */
  locate(key: string): string;
  /** Prepare for a write (folders on disk; nothing in the browser). */
  ensureDirs(): void;
  /** A JSON document, or `fallback` when there is none. Recovering from a corrupt one is the backend's job. */
  readJson<T>(file: string, fallback: T): Promise<T>;
  /** Same, synchronously and never throwing — for the few callers that cannot await. */
  readJsonSync<T>(file: string, fallback: T): T;
  /** Replace a document atomically: a reader sees the old content or the new, never half of it. */
  writeJson(file: string, data: unknown): Promise<void>;
  /** Names (not paths) of everything in the backups area. */
  listBackups(): Promise<string[]>;
  readBackupText(name: string): Promise<string | null>;
  writeBackupText(name: string, body: string): Promise<void>;
  /** `false` when there was nothing to delete. */
  deleteBackup(name: string): Promise<boolean>;
}

let backend: StorageBackend | null = null;

/** Install the host's storage. Must run before anything reads or writes app data. */
export function installStorage(next: StorageBackend): void {
  backend = next;
}

function storage(): StorageBackend {
  if (!backend) {
    throw new Error(
      'No storage backend installed: the host must call installStorage() at startup ' +
        '(desktop: main/bootstrapStorage.ts, browser: web/main.ts).',
    );
  }
  return backend;
}

const at = (key: string): string => storage().locate(key);

export const paths = {
  root: () => at(''),
  config: () => at('config'),
  backups: () => at('backups'),
  profiles: () => at('config/profiles.json'),
  rules: () => at('config/rules.json'),
  settings: () => at('config/settings.json'),
  /** user-given names for a `profiles` device's onboard slots — see main/devices/profileNames.ts */
  onboardProfileNames: () => at('config/onboard-profile-names.json'),
  /** user-chosen colour/edition variant per device model — see main/devices/colors.ts */
  deviceColors: () => at('config/device-colors.json'),
  /** app-side macro library — see main/macros/store.ts */
  macroLibrary: () => at('config/macro-library.json'),
  /** app-side per-key lighting preset library — see main/lighting/store.ts */
  perKeyLightingLibrary: () => at('config/perkey-lighting-library.json'),
  /** app-side saved actuation layouts — see main/actuation/store.ts */
  actuationLayouts: () => at('config/actuation-layouts.json'),
  /** actuation key groups, per model and onboard profile — see main/actuation/store.ts */
  keyGroups: () => at('config/key-groups.json'),
  /** memoised exe -> icon data URL cache — see main/profiles/processIcons.ts */
  processIcons: () => at('config/process-icons.json'),
  /** per-model scratchpad for device state with no read-back (e.g. the V8's
   *  receiver LEDs) — see main/devices/deviceState.ts */
  deviceState: () => at('config/device-state.json'),
};

export function ensureDirs(): void {
  storage().ensureDirs();
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
 * Read a JSON store; `fallback` when it does not exist yet (normal first run).
 * A corrupt document is recovered by the backend — on disk from the `.bak`
 * `writeJson` keeps, with the bad file moved aside (see store-fs.ts).
 */
export function readJson<T>(file: string, fallback: T): Promise<T> {
  return storage().readJson(file, fallback);
}

/** Synchronous, best-effort `readJson`. Never throws. */
export function readJsonSync<T>(file: string, fallback: T): T {
  return storage().readJsonSync(file, fallback);
}

/** Atomic JSON write — see `StorageBackend.writeJson`. */
export function writeJson(file: string, data: unknown): Promise<void> {
  return storage().writeJson(file, data);
}

/** Reject anything that isn't a plain file name in the backups area. */
function safeBackupName(file: string): string | null {
  return /^[\w.-]+\.json$/.test(file) ? file : null;
}

export async function listBackupFiles(model: string): Promise<string[]> {
  return (await storage().listBackups())
    .filter((f) => f.startsWith(model + '-') && f.endsWith('.json'))
    .sort()
    .reverse();
}

/** `createdAt` defaults to now; an imported backup keeps the time it was taken. */
export async function writeBackup(
  model: string,
  serial: string,
  blocks: Record<string, string>,
  createdAt: number = Date.now(),
): Promise<string> {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const safeSerial = serial.replace(/[^\w-]/g, '_').slice(0, 32) || 'noserial';
  const file = `${model}-${safeSerial}-${stamp}.json`;
  await storage().writeBackupText(
    file,
    JSON.stringify({ model, serial, createdAt, blocks }, null, 2),
  );
  return file;
}

/** A backup's stored text, for export. Same name check as `readBackup`. */
export async function readBackupText(file: string): Promise<string | null> {
  const safe = safeBackupName(file);
  return safe ? storage().readBackupText(safe) : null;
}

/** Far above a real backup (tens of kB), far below anything that could hurt storage. */
export const MAX_BACKUP_IMPORT_CHARS = 4 * 1024 * 1024;

export interface ParsedBackup {
  model: string;
  serial: string;
  createdAt: number;
  blocks: Record<string, string>;
}

/**
 * Validate a backup file the user picked, before it is stored as one of their
 * backups. Accepts exactly what `writeBackup` produces: an object with a model
 * name, string-valued blocks and a timestamp. The block values themselves are
 * driver-specific (hex dumps on the mouse, JSON on the keyboards) and are
 * judged by that driver's `restoreFromBackup`, as for any stored backup; the
 * model is checked against the device by the caller.
 */
export function parseBackupFile(json: string): ParsedBackup | { error: string } {
  if (json.length > MAX_BACKUP_IMPORT_CHARS) return { error: 'file too large to be a backup' };
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return { error: 'not a Shark Deck backup (not JSON)' };
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { error: 'not a Shark Deck backup' };
  }
  const r = raw as Record<string, unknown>;
  // The model ends up in the stored file name, so hold it to the same
  // alphabet `safeBackupName` accepts.
  if (typeof r.model !== 'string' || !/^[\w.-]{1,64}$/.test(r.model)) {
    return { error: 'not a Shark Deck backup (no model)' };
  }
  const blocks = r.blocks;
  if (!blocks || typeof blocks !== 'object' || Array.isArray(blocks)) {
    return { error: 'not a Shark Deck backup (no blocks)' };
  }
  const entries = Object.entries(blocks as Record<string, unknown>);
  if (entries.length === 0 || entries.some(([, v]) => typeof v !== 'string')) {
    return { error: 'not a Shark Deck backup (bad blocks)' };
  }
  return {
    model: r.model,
    serial: typeof r.serial === 'string' ? r.serial : 'imported',
    createdAt:
      typeof r.createdAt === 'number' && Number.isFinite(r.createdAt) ? r.createdAt : Date.now(),
    blocks: Object.fromEntries(entries) as Record<string, string>,
  };
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
  return storage().deleteBackup(safe);
}

export async function readBackup(
  file: string,
): Promise<{ model: string; blocks: Record<string, string>; createdAt: number } | null> {
  const safe = safeBackupName(file);
  if (!safe) return null;
  const raw = await storage().readBackupText(safe);
  if (raw === null) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
