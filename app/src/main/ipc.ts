import { app, ipcMain, BrowserWindow, nativeTheme, dialog, screen } from 'electron';
import { basename } from 'node:path';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { IPC } from '@shared/ipc';
import type { DeviceAccessResult } from '@shared/types/diagnostics';
import type { AppProfile } from '@shared/types/profiles';
import { getT } from '@shared/i18n';
import { deviceManager } from './devices/manager';
import { switcher } from './profiles/switcher';
import * as pstore from './profiles/store';
import { scanGames } from './profiles/gameScan';
import { listRunningProcesses } from './profiles/processScan';
import { getSettingsSync, setSettings } from './settings';
import { platform } from './platform';
import { bundleExecutableName } from './platform/mac';
import {
  createDeviceHandlers,
  createDispatcher,
  wireDeviceEvents,
  type Handler,
  type HostMethods,
} from './handlers';

/**
 * The desktop host's side of the `Api`. The device-facing handlers — device
 * reads and writes, the libraries, backups, `guardedWrite` — are shared with
 * the browser edition and live in ./handlers.ts. What is here needs Electron
 * or the OS: auto-switch and app profiles, the native file picker,
 * start-at-login, the platform glue and the custom window chrome.
 */

/** Set by `registerIpc` — the real main window, so the titlebar controls never
 *  act on the overlay / crash window (which are also `BrowserWindow`s and can
 *  outlive a destroyed main window). */
let getMainWindow: () => BrowserWindow | null = () => null;

/**
 * Every `Api` method the shared table does not implement. The browser edition
 * fills the same set its own way (src/web/host/handlers.ts); the `satisfies`
 * below makes the compiler prove this table neither misses one nor redefines
 * a shared one.
 */
const desktopHandlers = {
  // node-hid sees every device; there is no per-device permission to grant or
  // take back, so the browser edition's picker has nothing to do here.
  requestDeviceAccess: (): DeviceAccessResult => ({ status: 'not-needed' }),
  forgetDevice: (_id: string): DeviceAccessResult => ({ status: 'not-needed' }),

  checkFirmwareFile: async (_id: string, p: string) => {
    try {
      const st = await fs.stat(p);
      return { valid: st.size > 0 && /\.(bin|hex|img)$/i.test(p), version: undefined };
    } catch {
      return { valid: false, error: 'file not readable' };
    }
  },

  listProfiles: () => pstore.listProfiles(),
  saveProfile: (p: AppProfile) => pstore.saveProfile(p),
  deleteProfile: (pid: string) => pstore.deleteProfile(pid),
  applyProfile: async (pid: string) => {
    const p = (await pstore.listProfiles()).find((x) => x.id === pid);
    if (!p) return [];
    return switcher.applyProfile(p);
  },
  // TODO: links are keyed by dev.model — promoting a generic-PID keyboard to
  // an exact catalog entry changes the model slug and orphans links captured
  // here (same caveat the old per-device snapshot capture had).
  //
  // A general profile is a pure link, so "capture" now means: for every
  // connected device, point this new profile at whichever onboard slot it is
  // currently on. It does NOT snapshot settings - there are no settings to
  // snapshot any more; the slot IS where they live.
  captureProfileFromDevices: async (name: string) => {
    const links: AppProfile['links'] = {};
    for (const dev of deviceManager.list()) {
      if (dev.capabilities.includes('profiles')) {
        links[dev.model] = { slot: dev.activeProfile ?? 1 };
      }
    }
    const profile: AppProfile = { id: randomUUID(), name, triggers: [], links };
    const saved = await pstore.saveProfile(profile);
    // saveProfile may have disambiguated the name ("gaming" -> "gaming 2");
    // hand back the stored record, not the requested one.
    return saved.find((p) => p.id === profile.id) ?? profile;
  },

  getSwitcherState: () => switcher.getState(),
  setSwitcherRunning: (running: boolean) => {
    // `start()` clears any pinned mode itself (see switcher.ts) — the
    // renderer confirms that with the user before ever calling here.
    running ? switcher.start() : switcher.stop();
    return switcher.getState();
  },
  setSwitcherSuspended: (suspended: boolean) => {
    switcher.setMenuOpen(suspended);
    return switcher.getState();
  },
  pinProfile: (pid: string | null) => switcher.pin(pid),
  scanGames: () => scanGames(),
  listRunningProcesses: (guiOnly?: boolean) => listRunningProcesses(guiOnly ?? true),
  pickExecutable: async () => {
    const isMac = platform.info().os === 'darwin';
    // Windows/Linux: filter on this OS's process suffix, if it has one
    // ('.exe' on Windows; Linux binaries have none). macOS: `.app` bundles —
    // Electron's native panel lets openFile select one as a package.
    const suffix = platform.info().processSuffix.replace('.', '');
    // A native dialog, so its words come from here rather than the renderer.
    const t = getT(getSettingsSync().language);
    const all = { name: t('dlg.filter.all'), extensions: ['*'] };
    const opts = {
      title: t('dlg.pickExe.title'),
      // A macOS open panel shows no title — its `message` is the line it
      // shows — and starts where the apps are.
      ...(isMac ? { message: t('dlg.pickExe.title'), defaultPath: '/Applications' } : {}),
      properties: ['openFile' as const],
      filters: isMac
        ? [{ name: t('dlg.filter.applications'), extensions: ['app'] }, all]
        : suffix
          ? [{ name: t('dlg.filter.programs'), extensions: [suffix] }, all]
          : [all],
    };
    const w = mainWin();
    const res = await (w ? dialog.showOpenDialog(w, opts) : dialog.showOpenDialog(opts));
    const picked = res.filePaths[0];
    if (res.canceled || !picked) return null;
    // macOS: the name the app RUNS under — its bundle's CFBundleExecutable,
    // what the running-process scan reports — rather than the bundle's own
    // name, which often differs (Steam.app runs as `steam_osx`), so a trigger
    // picked here never fired. The bundle name only when the plist can't be
    // read.
    if (isMac && picked.toLowerCase().endsWith('.app'))
      return (await bundleExecutableName(picked)) ?? basename(picked, '.app').toLowerCase();
    return basename(picked).toLowerCase();
  },

  setSettings: async (patch: any) => {
    // Apply the OS-level change FIRST and let a failure propagate — otherwise
    // the setting is persisted (and the toggle reads "on") even when creating
    // the login item actually failed.
    if (patch.startAtBoot !== undefined) await platform.setStartAtBoot(patch.startAtBoot);
    const next = await setSettings(patch);
    if (patch.pollSeconds !== undefined) switcher.setPollSeconds(patch.pollSeconds);
    // Developer mode adds/removes simulated devices on the next scan pass;
    // nudge it so the grid reacts immediately instead of up to 2.5s later.
    if (patch.devMode !== undefined) deviceManager.nudgeScan();
    return next;
  },
  openMouseSettings: () => platform.openMouseSettings(),
  openExternal: (url: string) => platform.openExternal(url),
  getSystemDark: () => nativeTheme.shouldUseDarkColors,
  getPlatformInfo: () => ({
    ...platform.info(),
    isDev: !app.isPackaged,
    appVersion: app.getVersion(),
  }),

  windowMinimize: () => mainWin()?.minimize(),
  windowToggleMaximize: () => {
    const w = mainWin();
    if (!w) return;
    w.isMaximized() ? w.unmaximize() : w.maximize();
  },
  windowClose: () => mainWin()?.close(),
  windowIsMaximized: () => mainWin()?.isMaximized() ?? false,
  windowStartDrag: () => startWindowDrag(),
  windowEndDrag: () => stopWindowDrag(),
} satisfies { [K in HostMethods]: Handler };

const handlers = {
  ...createDeviceHandlers({ onDeviceWrite: () => switcher.noteDeviceWrite() }),
  ...desktopHandlers,
};

/** The real main window, for the custom titlebar controls — NOT just "the first
 *  live window", which could be the overlay or crash window. */
function mainWin(): BrowserWindow | null {
  const w = getMainWindow();
  return w && !w.isDestroyed() ? w : null;
}

// ---------------------------------------------------------------------------
// Manual titlebar drag — see Api.windowStartDrag's doc comment. Nearly every
// topbar element (Home, auto-switch toggle, language, settings, the window
// buttons) needs to both be clickable AND move the window on a press-drag,
// which a native `-webkit-app-region: drag` region can't do (it swallows all
// mouse input on Windows, so a button inside one never fires `click`). Driven
// from the OS cursor position rather than renderer pointermove deltas: once
// the window starts following the cursor, the pointer barely moves relative
// to the button any more, so screen-coordinate polling is what actually
// tracks a drag reliably.
// ---------------------------------------------------------------------------
let dragTimer: ReturnType<typeof setInterval> | null = null;
let dragWatchdog: ReturnType<typeof setTimeout> | null = null;

function stopWindowDrag(): void {
  if (dragTimer) clearInterval(dragTimer);
  if (dragWatchdog) clearTimeout(dragWatchdog);
  dragTimer = null;
  dragWatchdog = null;
}

function startWindowDrag(): void {
  const w = mainWin();
  if (!w) return;
  stopWindowDrag();
  const start = screen.getCursorScreenPoint();
  let offX: number;
  let offY: number;
  if (w.isMaximized()) {
    // Native Windows titlebar behaviour: restore-and-follow. Land the
    // restored window under the cursor at the same fractional X position it
    // had across the maximized width, then track from there.
    const maximizedBounds = w.getBounds();
    const frac = maximizedBounds.width
      ? (start.x - maximizedBounds.x) / maximizedBounds.width
      : 0.5;
    w.unmaximize();
    const restored = w.getBounds();
    offX = Math.round(frac * restored.width);
    offY = start.y - maximizedBounds.y;
    w.setPosition(start.x - offX, start.y - offY);
  } else {
    const b = w.getBounds();
    offX = start.x - b.x;
    offY = start.y - b.y;
  }
  dragTimer = setInterval(() => {
    const win = mainWin();
    if (!win || win.isDestroyed()) return stopWindowDrag();
    const p = screen.getCursorScreenPoint();
    // setPosition, not setBounds — avoids a DPI-mismatch resize when the
    // drag crosses a monitor with a different scale factor.
    win.setPosition(p.x - offX, p.y - offY);
  }, 16);
  // Belt-and-braces: a renderer crash or a missed pointerup would otherwise
  // leave the window following the cursor forever.
  dragWatchdog = setTimeout(stopWindowDrag, 30_000);
}

export function registerIpc(
  getWindows: () => BrowserWindow[],
  mainWindow: () => BrowserWindow | null = () => getWindows()[0] ?? null,
): void {
  getMainWindow = mainWindow;
  const dispatch = createDispatcher(handlers);
  ipcMain.handle(IPC.invoke, (_e, method: string, ...args: unknown[]) => dispatch(method, args));

  const push = (channel: string, payload: unknown) => {
    // Device/switcher events fire on a timer; a window may be mid-teardown.
    for (const w of getWindows()) {
      if (w.isDestroyed() || w.webContents.isDestroyed()) continue;
      w.webContents.send(IPC.event, channel, payload);
    }
  };

  wireDeviceEvents(push);
  switcher.on('switcher:state', (s) => push('switcher:state', s));
  switcher.on('appProfiles:changed', () => push('appProfiles:changed', undefined));

  nativeTheme.on('updated', () =>
    push('nativeTheme:changed', { dark: nativeTheme.shouldUseDarkColors }),
  );
}

/**
 * Per-window main-side wiring. Called from index.ts once the window exists.
 *
 * 1. Custom titlebar: tell the renderer when the OS (double-click, snap,
 *    Win+Up) changes the maximize state so its glyph stays in sync.
 * 2. Drop every live-state watch when the renderer goes away. A watch is armed
 *    by a mounted screen (see `setLiveWatch`), so one that outlives its
 *    renderer would keep polling a device with nothing on screen to show it.
 *    Whatever is actually open re-arms itself on the next render.
 */
export function wireWindowChrome(w: BrowserWindow): void {
  const send = () =>
    !w.isDestroyed() && w.webContents.send(IPC.event, 'window:maximized', w.isMaximized());
  w.on('maximize', send);
  w.on('unmaximize', send);
  w.webContents.on('did-start-loading', () => deviceManager.clearLiveWatches());
  w.on('closed', () => deviceManager.clearLiveWatches());
}
