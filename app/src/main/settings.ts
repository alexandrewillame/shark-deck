import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import type { AppSettings } from '@shared/types/app-settings';
import { BACKGROUND_INTENSITY_DEFAULT, toBackgroundEffect } from '@shared/backgrounds';
import { paths, readJson, withFileLock, writeJson } from './store';

/**
 * `'changed'` (next settings, the patch that made them) after every
 * `setSettings` — for main-process surfaces that render settings themselves,
 * like the tray menu, which is in the UI language and otherwise only redrew
 * when the switcher next had news.
 */
export const settingsEvents = new EventEmitter();

const DEFAULTS: AppSettings = {
  startAtBoot: false,
  minimizeToTray: true,
  language: 'en',
  palette: 'shark-cyan',
  themeMode: 'dark',
  background: 'none',
  backgroundPalette: true,
  backgroundIntensity: BACKGROUND_INTENSITY_DEFAULT,
  pollSeconds: 2,
  overlayEnabled: true,
  batteryLowThreshold: 15,
  railCollapsed: false,
  deviceOrder: [],
  devMode: false,
};

/** Fold forward pre-0.2 settings files (single `theme: 'shark-dark'` literal). */
function migrate(raw: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...raw };
  if ('theme' in out && !('palette' in out)) {
    out.palette = 'shark-cyan';
    out.themeMode = 'dark';
  }
  delete out.theme;
  // The "ember" palette was renamed "amber" (it was a dark red-orange despite
  // the name; the colours were reworked to an actual bright yellow-orange).
  if (out.palette === 'ember') out.palette = 'amber';
  return out;
}

/**
 * Coerce whatever is on disk (or whatever a renderer patch merged in — the IPC
 * boundary types the patch as `any`) into a valid `AppSettings`. Every field is
 * range-/type-checked against `DEFAULTS`; unknown keys are dropped. Without
 * this, a hand-edited or partially-written file with `pollSeconds: "2"` / `null`
 * / `NaN` reaches `switcher.setPollSeconds`, where `Math.max(1, NaN)` is `NaN`
 * and `setInterval(tick, NaN)` fires ~1000x/s, each tick spawning `tasklist`.
 */
function coerce(raw: Record<string, unknown>): AppSettings {
  const bool = (v: unknown, d: boolean): boolean => (typeof v === 'boolean' ? v : d);
  const int = (v: unknown, d: number, lo: number, hi: number): number => {
    const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
    return Number.isFinite(n) ? Math.round(Math.min(hi, Math.max(lo, n))) : d;
  };
  const str = <T extends string>(v: unknown, d: T): T =>
    typeof v === 'string' && v ? (v as T) : d;
  return {
    startAtBoot: bool(raw.startAtBoot, DEFAULTS.startAtBoot),
    minimizeToTray: bool(raw.minimizeToTray, DEFAULTS.minimizeToTray),
    language: str(raw.language, DEFAULTS.language),
    palette: str(raw.palette, DEFAULTS.palette),
    themeMode:
      raw.themeMode === 'light' || raw.themeMode === 'dark' || raw.themeMode === 'system'
        ? raw.themeMode
        : DEFAULTS.themeMode,
    // Checked against the list, unlike `palette`: an id the renderer has no
    // shader for must not reach it.
    background: toBackgroundEffect(raw.background),
    backgroundPalette: bool(raw.backgroundPalette, DEFAULTS.backgroundPalette),
    backgroundIntensity: int(raw.backgroundIntensity, DEFAULTS.backgroundIntensity, 0, 100),
    // Left unset rather than defaulted: unset, the system's reduced-motion
    // setting decides (renderer/background/motion.ts).
    backgroundAnimate:
      typeof raw.backgroundAnimate === 'boolean' ? raw.backgroundAnimate : undefined,
    pollSeconds: int(raw.pollSeconds, DEFAULTS.pollSeconds, 1, 60),
    overlayEnabled: bool(raw.overlayEnabled, DEFAULTS.overlayEnabled),
    batteryLowThreshold: int(raw.batteryLowThreshold, DEFAULTS.batteryLowThreshold, 0, 100),
    railCollapsed: bool(raw.railCollapsed, DEFAULTS.railCollapsed),
    deviceOrder: Array.isArray(raw.deviceOrder)
      ? raw.deviceOrder.filter((x): x is string => typeof x === 'string')
      : [...DEFAULTS.deviceOrder],
    devMode: bool(raw.devMode, DEFAULTS.devMode),
    // `coerce` is an allowlist — a field it does not name is dropped on every
    // write, so this has to be here or the per-effect lighting memory would
    // be discarded the moment anything else in settings changed.
    lightingPresets: lightingPresets(raw.lightingPresets),
  };
}

/**
 * Per-effect lighting parameters, validated shallowly.
 *
 * Deliberately permissive about which keys exist (they are
 * `model/zone/effectId`, open-ended by construction) but strict about the
 * shape of each value, so a hand-edited or truncated settings file cannot put
 * a NaN brightness onto a device.
 */
function lightingPresets(raw: unknown): AppSettings['lightingPresets'] {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const pct = (v: unknown): number | undefined =>
    typeof v === 'number' && Number.isFinite(v)
      ? Math.min(100, Math.max(0, Math.round(v)))
      : undefined;
  const out: NonNullable<AppSettings['lightingPresets']> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!value || typeof value !== 'object') continue;
    const v = value as Record<string, unknown>;
    const color =
      Array.isArray(v.color) && v.color.length === 3 && v.color.every((n) => typeof n === 'number')
        ? (v.color.map((n) => Math.min(255, Math.max(0, Math.round(n as number)))) as [
            number,
            number,
            number,
          ])
        : undefined;
    out[key] = {
      brightness: pct(v.brightness),
      speed: pct(v.speed),
      color,
      dazzle: typeof v.dazzle === 'boolean' ? v.dazzle : undefined,
      option:
        typeof v.option === 'number' && Number.isFinite(v.option)
          ? Math.min(15, Math.max(0, Math.round(v.option)))
          : undefined,
    };
  }
  return Object.keys(out).length ? out : undefined;
}

/**
 * Last known settings, kept so `getSettingsSync()` can answer without hitting
 * the event loop. Populated by every `getSettings()` / `setSettings()` call and
 * primed lazily from disk on the first synchronous read.
 */
let cache: AppSettings | null = null;

export async function getSettings(): Promise<AppSettings> {
  cache = coerce(migrate(await readJson<Record<string, unknown>>(paths.settings(), {})));
  return cache;
}

export async function setSettings(patch: Partial<AppSettings>): Promise<AppSettings> {
  return withFileLock(paths.settings(), async () => {
    const current = coerce(migrate(await readJson<Record<string, unknown>>(paths.settings(), {})));
    const next = coerce({ ...current, ...patch });
    await writeJson(paths.settings(), next);
    cache = next;
    settingsEvents.emit('changed', next, patch);
    return next;
  });
}

/**
 * Synchronous, best-effort settings read. For code paths that cannot await —
 * notably the BrowserWindow `close` handler, where `event.preventDefault()` only
 * works if called before the handler yields. Never throws.
 */
export function getSettingsSync(): AppSettings {
  if (cache) return cache;
  try {
    const raw = readFileSync(paths.settings(), 'utf8');
    cache = coerce(migrate(JSON.parse(raw) as Record<string, unknown>));
  } catch {
    cache = { ...DEFAULTS };
  }
  return cache;
}
