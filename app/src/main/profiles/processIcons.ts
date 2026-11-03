import { app } from 'electron';
import { paths, readJson, withFileLock, writeJson } from '../store';

type Store = Record<string, string | null>;

/** Hard cap on cached entries — one base64 PNG data URL each, and the file was
 *  previously unbounded (one entry per exe path ever seen, never evicted). */
const MAX_ENTRIES = 400;

let cache: Store | null = null;
let loading: Promise<Store> | null = null;
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let dirty = false;

async function load(): Promise<Store> {
  if (cache) return cache;
  if (!loading) loading = readJson<Store>(paths.processIcons(), {});
  cache = await loading;
  return cache;
}

/** Coalesce the many writes a single "Refresh running apps" sweep would
 *  otherwise make (it calls `iconFor` once per running process) into one
 *  debounced, file-locked write of the whole cache. */
function schedulePersist(): void {
  dirty = true;
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    void flushIcons();
  }, 500);
}

export async function flushIcons(): Promise<void> {
  if (!dirty || !cache) return;
  dirty = false;
  const snapshot = cache;
  await withFileLock(paths.processIcons(), () => writeJson(paths.processIcons(), snapshot));
}

/** FIFO-evict down to the cap (string keys keep insertion order). */
function evictIfFull(store: Store): void {
  const keys = Object.keys(store);
  if (keys.length < MAX_ENTRIES) return;
  for (const k of keys.slice(0, keys.length - MAX_ENTRIES + 1)) delete store[k];
}

/**
 * Does `app.getFileIcon` show a program's OWN icon here? On Windows and macOS
 * it reads the icon out of the program. On Linux it asks the icon theme for
 * one by file type, so every executable — and every Proton game's `.exe` —
 * came back as the same generic icon, which, cached as the program's own, hid
 * the letter avatar that at least tells two programs apart.
 */
const OWN_ICONS = process.platform !== 'linux';

/**
 * A bigger icon (32px) for the switch card, which draws the game's icon as its
 * subject — the 16px list icon blurs at that size. In memory only: one per
 * game a session, and never wanted by the lists the persisted store serves.
 */
const bigIcons = new Map<string, string | null>();
export async function bigIconFor(exePath: string): Promise<string | null> {
  if (!OWN_ICONS) return null;
  const key = exePath.toLowerCase();
  if (bigIcons.has(key)) return bigIcons.get(key)!;
  let url: string | null = null;
  try {
    const img = await app.getFileIcon(exePath, { size: 'normal' });
    url = img.isEmpty() ? null : img.toDataURL();
  } catch {
    url = null;
  }
  bigIcons.set(key, url);
  return url;
}

/**
 * Extracts a small icon for an exe path via Electron's `app.getFileIcon`,
 * memoised in memory and persisted to `config/process-icons.json` (keyed by
 * lowercase image name) so re-opening the Auto-Switch Processes picker, or
 * showing a profile's trigger icon, doesn't re-extract every time. Returns
 * null (and caches the miss) if extraction fails — a missing icon just means
 * the caller falls back to a letter avatar.
 */
export async function iconFor(exePath: string): Promise<string | null> {
  if (!OWN_ICONS) return null;
  const key = exePath.toLowerCase();
  const store = await load();
  if (key in store) return store[key]!;
  try {
    const img = await app.getFileIcon(exePath, { size: 'small' });
    const url = img.isEmpty() ? null : img.toDataURL();
    evictIfFull(store);
    store[key] = url;
    schedulePersist();
    return url;
  } catch {
    evictIfFull(store);
    store[key] = null;
    schedulePersist();
    return null;
  }
}
