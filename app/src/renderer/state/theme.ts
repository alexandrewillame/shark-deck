import type { AppSettings, ThemeMode, ThemePalette } from '@shared/types/app-settings';

import { sd } from './bridge';

/** Resolve `system` to a concrete light/dark using the last known OS preference. */
let systemDark = true;
export function setSystemDark(dark: boolean) {
  systemDark = dark;
}

function effectiveDark(mode: ThemeMode): boolean {
  return mode === 'system' ? systemDark : mode !== 'light';
}

/** How long the cross-fade between palette/mode tokens runs — see `.theme-anim`
 * in styles.css. Kept in sync with `--dur-theme` there. */
const THEME_ANIM_MS = 400;
let themeAnimTimer: ReturnType<typeof setTimeout> | null = null;
/** Set once the first `applyTheme()` has run, so boot never fades in from the
 * (transient) default palette/mode. */
let booted = false;
/** What the last call put on <html>, so a call that changes none of it (a
 *  background-intensity save, say) does not run the cross-fade. */
let applied = '';

/**
 * Push the palette + light/dark choice onto <html> as `data-palette` /
 * `data-mode`, which styles.css keys its token blocks off — and the app
 * background as `data-bg`, present only while one is on, which turns the
 * panels frosted (styles/background.css). Called on boot, on every settings
 * change, and on an OS theme flip while `themeMode: 'system'`.
 *
 * Also toggles a `.theme-anim` class around the swap so the colour tokens
 * cross-fade instead of snapping (see `.theme-anim` in styles.css) — skipped
 * on the very first call so the app doesn't visibly fade in on launch, and
 * on any call that changes none of the three.
 */
export function applyTheme(
  settings: Pick<AppSettings, 'palette' | 'themeMode'> & Partial<Pick<AppSettings, 'background'>>,
) {
  const root = document.documentElement;
  const palette = (settings.palette ?? 'shark-cyan') as ThemePalette;
  const mode = effectiveDark(settings.themeMode ?? 'dark') ? 'dark' : 'light';
  const bg = settings.background && settings.background !== 'none' ? settings.background : '';
  const next = `${palette}|${mode}|${bg}`;
  if (booted && next !== applied) {
    if (themeAnimTimer) clearTimeout(themeAnimTimer);
    root.classList.add('theme-anim');
    themeAnimTimer = setTimeout(() => {
      root.classList.remove('theme-anim');
      themeAnimTimer = null;
    }, THEME_ANIM_MS);
  }
  root.dataset.palette = palette;
  root.dataset.mode = mode;
  if (bg) root.dataset.bg = bg;
  else delete root.dataset.bg;
  applied = next;
  booted = true;
}

/** Wire the OS theme feed; re-applies `system` mode live. Returns an
 *  unsubscribe — the caller MUST add it to its effect cleanup, or (under
 *  StrictMode's double-invoke, and on every App remount) a `nativeTheme:changed`
 *  listener leaks and `applyTheme` runs once per stale listener. */
export function initSystemThemeFeed(getSettings: () => AppSettings | null): () => void {
  sd.getSystemDark().then((dark) => {
    setSystemDark(dark);
    const s = getSettings();
    if (s) applyTheme(s);
  });
  return sd.on('nativeTheme:changed', ({ dark }) => {
    setSystemDark(dark);
    const s = getSettings();
    if (s) applyTheme(s);
  });
}
