// Must stay the first import — see bootstrapEnv.ts's doc comment on why.
import './bootstrapEnv';
// Second, before anything can touch app data — see bootstrapStorage.ts.
import './bootstrapStorage';
import {
  app,
  BrowserWindow,
  Tray,
  Menu,
  nativeImage,
  nativeTheme,
  shell,
  type NativeImage,
  type BrowserWindowConstructorOptions,
  type MenuItemConstructorOptions,
} from 'electron';
import path from 'node:path';
import { getT } from '@shared/i18n';
import { installCrashReporter, reportFatalBootstrap } from './crash';
import { registerIpc, requestQuitConfirmation, wireWindowChrome } from './ipc';
import { allowQuit, shouldAskBeforeQuit } from './quitGuard';
import { deviceManager } from './devices/manager';
import { switcher } from './profiles/switcher';
import { stopAllAmbient } from './lighting/ambient';
import { installDisplayMediaHandler } from './lighting/displayMedia';
import { getSettings, getSettingsSync, setSettings, settingsEvents } from './settings';
import { ensureDirs } from './store';
import {
  ensureDefaultProfile,
  listProfiles,
  migrateRulesToProfiles,
  seedDefaults,
} from './profiles/store';
import { showSwitchOverlay, destroySwitchOverlay } from './overlayWindow';
import { platform } from './platform';
import type { SwitchApplication, SwitcherState } from '@shared/types/profiles';
import type { AppSettings } from '@shared/types/app-settings';

const isDev = !app.isPackaged;
const appFlags = app as unknown as { isQuitting?: boolean };
let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
/** true once a system tray icon actually exists — the window-close-to-tray
 *  behaviour and `window-all-closed` staying alive both depend on there being
 *  a tray to get the window back from. */
let trayReady = false;
let cleanedUp = false;
let themeListenerBound = false;
/** `--hidden` (start-at-boot) should suppress only the FIRST window, not every
 *  window ever created — otherwise a later tray-click re-creates a window that
 *  never shows. */
let firstWindow = true;

// Trap unhandled main-process errors into a copy-pastable window (see crash.ts)
// before anything else can throw. On a fatal error the process has resumed past
// a throw in an unknown state — stop the workers that keep touching hardware.
installCrashReporter(() => {
  try {
    stopAllAmbient();
  } catch {
    /* ignore */
  }
  try {
    deviceManager.stop();
  } catch {
    /* ignore */
  }
  try {
    switcher.stop();
  } catch {
    /* ignore */
  }
  try {
    destroySwitchOverlay();
  } catch {
    /* ignore */
  }
});

/** The live main window, or null if it is missing or already destroyed. */
function getWindow(): BrowserWindow | null {
  return mainWindow && !mainWindow.isDestroyed() ? mainWindow : null;
}

function appIcon(): NativeImage {
  const file = process.platform === 'win32' ? 'logo.ico' : 'logo.png';
  // app.getAppPath() is the project root in dev and the asar root when packaged;
  // assets/** is bundled into the asar (see electron-builder.yml).
  const img = nativeImage.createFromPath(path.join(app.getAppPath(), 'assets', file));
  return img.isEmpty() ? nativeImage.createEmpty() : img;
}

/** `logo.png` is 1248x1248 — right for the window/dock icon, far too large
 *  for a tray/menu-bar glyph. Not a template image: the logo is colour art,
 *  and `setTemplateImage(true)` would render it as a solid black blob. */
function trayIcon(): NativeImage {
  const img = appIcon();
  if (img.isEmpty()) return img;
  if (process.platform === 'darwin') {
    // 18 pt in the menu bar, with the 2x bitmap a Retina display draws: one
    // 22 px bitmap was blurry there and as tall as the bar itself.
    const icon = img.resize({ width: 18, height: 18 });
    icon.addRepresentation({
      scaleFactor: 2,
      width: 36,
      height: 36,
      buffer: img.resize({ width: 36, height: 36 }).toPNG(),
    });
    return icon;
  }
  return img.resize({ width: 24, height: 24 });
}

/** Bring the main window to the front, creating it if it is gone. */
function showMainWindow(): void {
  const w = getWindow();
  if (w) {
    if (w.isMinimized()) w.restore();
    w.show();
    w.focus();
  } else {
    createWindow();
  }
}

/**
 * Hold a quit while the renderer reports a change nobody applied: bring the
 * window up and let it ask (see quitGuard.ts). False means there is nothing to
 * hold, or nothing to ask with, so the quit goes ahead.
 */
function holdQuitForPrompt(): boolean {
  if (!shouldAskBeforeQuit()) return false;
  const w = getWindow();
  if (!w) return false;
  showMainWindow();
  requestQuitConfirmation(w);
  return true;
}

/** Window ground colour behind the app, matched to the active theme mode. */
function groundColor(): string {
  const s = getSettingsSync();
  const dark = s.themeMode === 'system' ? nativeTheme.shouldUseDarkColors : s.themeMode !== 'light';
  return dark ? '#0a0c10' : '#f5f7fb';
}

/**
 * The app draws its own titlebar (see renderer .topbar) on every OS. On
 * Windows/Linux that means a fully frameless window (`frame: false`) — the
 * renderer draws minimize/maximize/close too (see WindowControls).
 * On macOS, `frame: false` removes the traffic lights entirely, which reads
 * as broken to Mac users; `titleBarStyle: 'hidden'` keeps a frame (so the
 * traffic lights still exist and macOS still handles their behaviour) while
 * hiding the title bar itself, and `trafficLightPosition` re-homes them to
 * sit inside the custom topbar instead of a title bar that no longer shows.
 * See styles.css's `.platform-mac .topbar` for the matching space cleared
 * for them, and PlatformInfo.nativeTrafficLights for how the renderer knows
 * to skip drawing its own controls there.
 */
function windowChrome(): BrowserWindowConstructorOptions {
  if (process.platform === 'darwin') {
    return { frame: true, titleBarStyle: 'hidden', trafficLightPosition: { x: 14, y: 14 } };
  }
  return { frame: false };
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    // Sized so the Home grid fits 3 cards across at their full width:
    // 3 x 425 + 2 x 20 gap = 1315, plus `.content`'s 24px padding either side
    // and room for a scrollbar. Below this the cards shrink, then wrap to 2 —
    // see `.grid > .card` in styles.css. No bounds are persisted, so this is
    // simply the size every launch starts at.
    width: 1400,
    height: 820,
    minWidth: 940,
    minHeight: 640,
    show: false,
    ...windowChrome(),
    backgroundColor: groundColor(),
    title: 'Shark Deck',
    icon: appIcon(),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  });

  // Deny any attempt to navigate away or open external windows — this app
  // never loads remote content.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (e) => e.preventDefault());

  wireWindowChrome(mainWindow);

  mainWindow.once('ready-to-show', () => {
    // A login item gets no arguments on macOS (setLoginItemSettings' `args`
    // is Windows-only, and `openAsHidden` is gone since macOS 13), so a login
    // launch is recognised by how it was started instead.
    const startHidden =
      firstWindow &&
      (process.argv.includes('--hidden') ||
        (process.platform === 'darwin' && app.getLoginItemSettings().wasOpenedAtLogin));
    firstWindow = false;
    // Hidden explicitly, not just left unshown: a window made with
    // `show: false` counts as visible to its page until it is shown or
    // hidden, so a login start ran the renderer at full frame rate — the
    // background animating — in a window nobody could see.
    if (startHidden) getWindow()?.hide();
    else getWindow()?.show();
  });

  // Keep the ground colour in step with an OS light/dark flip while "system".
  // Bound once for the process, not per window — `createWindow` runs again on a
  // tray click / `activate`, and each re-binding was a permanent leaked listener.
  if (!themeListenerBound) {
    themeListenerBound = true;
    nativeTheme.on('updated', () => getWindow()?.setBackgroundColor(groundColor()));
  }

  // Auto-switch suspends while a device menu is the visible tab, but the
  // renderer reports that from its own active tab and keeps running when the
  // window is hidden to tray — so on its own the flag stayed set for a window
  // nobody could see, the tray menu read PAUSED forever, and nothing ever
  // switched. Bound to the window's own events rather than to the places that
  // call show()/hide(), so every route in and out of the tray is covered.
  // See Switcher.setWindowVisible.
  mainWindow.on('show', () => switcher.setWindowVisible(true));
  mainWindow.on('hide', () => switcher.setWindowVisible(false));
  mainWindow.on('minimize', () => switcher.setWindowVisible(false));
  mainWindow.on('restore', () => switcher.setWindowVisible(true));

  // Must be synchronous: event.preventDefault() only takes effect if it runs
  // before the handler yields, so the minimize-to-tray decision uses the
  // cached settings rather than an await.
  mainWindow.on('close', (e) => {
    if (appFlags.isQuitting) return;
    // Only hide-to-tray if there actually is a tray to restore from — with none
    // (see createTray's catch) closing must really close, so `window-all-closed`
    // can quit instead of leaving an invisible process.
    if (trayReady && getSettingsSync().minimizeToTray) {
      e.preventDefault();
      getWindow()?.hide();
      return;
    }
    // Closing for real, which quits (see 'closed'): a change nobody applied
    // is asked about first.
    if (holdQuitForPrompt()) e.preventDefault();
  });
  // A Windows session that is ending does not wait for a prompt.
  mainWindow.on('session-end', () => allowQuit());

  // Clear the reference as soon as the window is really gone, so nothing ever
  // calls a method on a destroyed BrowserWindow (this was the crash).
  mainWindow.on('closed', () => {
    mainWindow = null;
    // With no tray there is no way back to a closed window, so closing it is
    // quitting — said here rather than left to `window-all-closed`, which
    // never fires once the switch card's window exists (it is only hidden).
    if (!trayReady && !appFlags.isQuitting) app.quit();
  });

  if (isDev && process.env['ELECTRON_RENDERER_URL']) {
    void mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL']);
  } else {
    void mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));
  }
}

/** Windows truncates a tray tooltip past 127 characters (its 128-char
 *  NOTIFYICONDATA buffer); cut it ourselves so the cut is an ellipsis. */
const TRAY_TIP_MAX = 127;

/**
 * The mode line for the tray — the same words the topbar's tooltip uses:
 * "Mode: Gaming — cs2.exe", "Mode: Desktop", or a pinned one.
 * Null while SharkDeck is not choosing modes (auto-switch off, no pin).
 */
function trayModeLine(t: ReturnType<typeof getT>, s: SwitcherState): string | null {
  const cur = s.current;
  if (!cur) return null;
  if (cur.pinned) return t('tray.mode.pinned', { name: cur.profileName });
  return cur.exe
    ? t('as.mode.currentWith', { name: cur.profileName, exe: cur.exe })
    : t('as.mode.current', { name: cur.profileName });
}

/**
 * No tray: closing the window then quits (see the window's `closed`
 * handler), and the close-to-tray setting is turned off to say so.
 */
function noTray(): void {
  void getSettings().then((s) => {
    if (s.minimizeToTray) void setSettings({ minimizeToTray: false });
  });
}

async function createTray(): Promise<void> {
  // Asked first: on a Linux desktop with no tray host, `new Tray()` succeeds
  // and draws nothing (see platform/linux.ts trayAvailable).
  if (!(await platform.trayAvailable())) {
    noTray();
    return;
  }
  try {
    tray = new Tray(trayIcon());
    trayReady = true;
    tray.setToolTip('Shark Deck');
    // macOS: a click on a menu-bar item opens its menu (setContextMenu below),
    // whose first item is Open. Also showing the window on that click brought
    // it up behind the open menu — even when the click was on the way to Quit.
    if (process.platform !== 'darwin') tray.on('click', () => showMainWindow());

    const rebuild = () => {
      const t = getT(getSettingsSync().language);
      const s = switcher.getState();
      // A device config tab open in the main window suspends the poll loop
      // (see SwitcherState.suspended) — the tray label agrees with the topbar
      // pill's PAUSED state rather than just reading "on" while it's actually
      // doing nothing.
      const autoSwitch = !s.running
        ? t('tray.autoSwitchOff')
        : s.suspended
          ? t('tray.autoSwitchPaused')
          : t('tray.autoSwitchOn');
      const mode = trayModeLine(t, s);
      // What hovering the icon says: which mode the mice and keyboards are in
      // is the one thing worth knowing without opening anything.
      const tip = ['Shark Deck', autoSwitch, mode].filter(Boolean).join('\n');
      tray?.setToolTip(tip.length > TRAY_TIP_MAX ? `${tip.slice(0, TRAY_TIP_MAX - 1)}…` : tip);
      const quit: MenuItemConstructorOptions = {
        // "Exit" is the Windows word; macOS and Linux desktops say "Quit".
        label:
          process.platform === 'win32' ? t('tray.exit') : t('tray.quit', { name: 'Shark Deck' }),
        click: () => {
          appFlags.isQuitting = true;
          app.quit();
        },
      };
      const items: MenuItemConstructorOptions[] = [
        { label: t('tray.open'), click: () => showMainWindow() },
        {
          label: autoSwitch,
          click: () => {
            switcher.getState().running ? switcher.stop() : switcher.start();
            rebuild();
          },
        },
        // Information, not an action — greyed, like a menu's status line.
        ...(mode ? [{ label: mode, enabled: false }] : []),
      ];
      // Windows: Exit first, so the primary clickable item is closest to the
      // cursor (a right-click on the taskbar drops the menu upward, Exit
      // already under it). macOS and Linux menus drop DOWN from the top of the
      // screen, where Quit belongs last, after everything else.
      const menu = Menu.buildFromTemplate(
        process.platform === 'win32'
          ? [quit, { type: 'separator' }, ...items]
          : [...items, { type: 'separator' }, quit],
      );
      tray?.setContextMenu(menu);
    };
    rebuild();
    switcher.on('switcher:state', rebuild);
    // The menu is in the UI language: redraw it when that changes, not
    // whenever the switcher next happens to have news.
    settingsEvents.on('changed', (_next: AppSettings, patch: Partial<AppSettings>) => {
      if (patch.language !== undefined) rebuild();
    });
  } catch (err) {
    // A tray failure must never abort startup.
    // eslint-disable-next-line no-console
    console.error('SharkDeck: tray init failed (non-fatal):', err);
    tray = null;
    trayReady = false;
    noTray();
  }
}

/**
 * The application menu.
 *
 * macOS keeps a system menu bar even for a frameless-looking app, and without
 * an explicit menu falls back to Electron's own default (which advertises
 * dev-only items like "Toggle Developer Tools" in a production build). This
 * is the menu every Mac app has — in the app's language, under the brand
 * name (Electron's role labels said "About sharkdeck": the app's name is the
 * lowercase package name), with Close Window for ⌘W — so ⌘Q / ⌘W / ⌘C / ⌘V
 * behave the way every other Mac app's do.
 *
 * Windows and Linux have nowhere to show a menu in the frameless window, but
 * Electron's default one was still installed there with its accelerators
 * live: Ctrl+R reloaded the window (past any "unsaved work" prompt) and
 * Ctrl+Shift+I opened the developer tools in a packaged build. A packaged
 * build has no menu at all there; a development build keeps the default, for
 * its developer tools.
 */
function buildAppMenu(): void {
  if (process.platform !== 'darwin') {
    if (!isDev) Menu.setApplicationMenu(null);
    return;
  }
  const t = getT(getSettingsSync().language);
  const name = 'Shark Deck';
  // About took its name from the bundle (CFBundleName), which must stay
  // "SharkDeck" — see electron-builder.yml's mac.extendInfo.
  app.setAboutPanelOptions({ applicationName: name });
  const template: MenuItemConstructorOptions[] = [
    {
      label: name,
      submenu: [
        { role: 'about', label: t('menu.about', { name }) },
        { type: 'separator' },
        { role: 'services', label: t('menu.services') },
        { type: 'separator' },
        { role: 'hide', label: t('menu.hide', { name }) },
        { role: 'hideOthers', label: t('menu.hideOthers') },
        { role: 'unhide', label: t('menu.showAll') },
        { type: 'separator' },
        { role: 'quit', label: t('menu.quit', { name }) },
      ],
    },
    {
      label: t('menu.edit'),
      submenu: [
        { role: 'undo', label: t('common.undo') },
        { role: 'redo', label: t('common.redo') },
        { type: 'separator' },
        { role: 'cut', label: t('menu.cut') },
        { role: 'copy', label: t('menu.copy') },
        { role: 'paste', label: t('menu.paste') },
        { role: 'selectAll', label: t('menu.selectAll') },
      ],
    },
    {
      label: t('menu.window'),
      submenu: [
        { role: 'minimize', label: t('menu.minimize') },
        { role: 'zoom', label: t('menu.zoom') },
        // With no item holding a shortcut, only the green button reached full
        // screen (the topbar adapts to it — App.tsx). The role's own shortcut
        // is Apple's fn-F (macOS 15+); the hidden twin answers ⌃⌘F, the one
        // older Macs and most apps still use.
        { role: 'togglefullscreen', label: t('menu.fullScreen') },
        { role: 'togglefullscreen', accelerator: 'Control+Command+F', visible: false },
        { type: 'separator' },
        { role: 'close', label: t('menu.close') },
        { type: 'separator' },
        { role: 'front', label: t('menu.front') },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

/**
 * Native UI drawn by the OS — the dropdown of a `<select>`, the scrollbars,
 * the window's own frame on macOS — follows the app's light/dark choice
 * rather than the system's: with macOS in Light mode, a select in the dark
 * app opened a light system menu.
 */
function applyThemeSource(s: AppSettings): void {
  nativeTheme.themeSource = s.themeMode === 'system' ? 'system' : s.themeMode;
}

async function bootstrap(): Promise<void> {
  deviceManager.configure({
    allowSimulated: isDev,
    showDevNotes: isDev,
    os: process.platform,
    serialless: 'path',
  });
  buildAppMenu();
  ensureDirs();
  await seedDefaults(); // first-run only: "Desktop" / "Gaming" profiles
  await migrateRulesToProfiles(); // one-time upgrade: fold a pre-trigger-model rules.json in, if present
  await ensureDefaultProfile(); // one-time upgrade: flag the fallback profile on installs that predate isDefault
  registerIpc(() => BrowserWindow.getAllWindows(), getWindow);
  installDisplayMediaHandler();
  applyThemeSource(getSettingsSync());
  createWindow();
  await createTray();
  deviceManager.start();
  settingsEvents.on('changed', (next: AppSettings, patch: Partial<AppSettings>) => {
    // The Mac menu is in the UI language (the tray redraws its own).
    if (patch.language !== undefined) buildAppMenu();
    if (patch.themeMode !== undefined) applyThemeSource(next);
  });

  // The overlay only ever fires for a real game/desktop transition, never a
  // manual pin or a click on "Apply" — see the reason gate in switcher.ts's
  // applyProfileIfChanged() and the doc comment on SwitchApplication.
  switcher.on('switcher:applied', (applied: SwitchApplication) => {
    if (applied.reason === 'game' || applied.reason === 'desktop') showSwitchOverlay(applied);
  });

  const settings = await getSettings();
  switcher.setPollSeconds(settings.pollSeconds);
  // Linux's autostart entry names the program by path, and an AppImage is
  // versioned: after swapping in a new one, the entry pointed at a file that
  // was gone while the setting still read "on". Rewritten at every start
  // while it is on, it always names the copy actually running.
  if (process.platform === 'linux' && settings.startAtBoot) {
    void platform.setStartAtBoot(true).catch(() => undefined);
  }
  // Start the switcher automatically only if some profile already has an
  // enabled trigger process (there's nothing to switch to otherwise).
  const profiles = await listProfiles();
  if (profiles.some((p) => p.triggers.some((t) => t.enabled))) switcher.start();

  // Hidden self-test for the crash window: `SharkDeck.exe --selftest-crash`.
  if (process.argv.includes('--selftest-crash')) {
    setTimeout(() => {
      throw new Error('selftest-crash: intentional error to exercise the crash window');
    }, 1500);
  }
}

if (!app.requestSingleInstanceLock()) {
  // Another copy is already running; hand off and exit without touching anything.
  app.quit();
} else {
  app.on('second-instance', () => {
    showMainWindow();
  });

  // macOS: a click on the Dock icon (or opening the app again from Finder)
  // brings the window back. It used to only CREATE one when none existed —
  // but the window is usually just hidden (close goes to the menu bar), and
  // the switch card's window counts too, so the click did nothing at all.
  // Registered here rather than in bootstrap(), so a failed bootstrap
  // cannot leave the Dock dead as well.
  app.on('activate', () => {
    if (app.isReady()) showMainWindow();
  });

  void app.whenReady().then(bootstrap).catch(reportFatalBootstrap);

  app.on('window-all-closed', () => {
    // Stay alive in the tray; explicit Quit ends the process. But with NO tray
    // (bare GNOME etc. — see createTray's catch), there is no way to get a
    // window back, so closing the last one must actually quit or the app is an
    // invisible unkillable process.
    if (!trayReady) app.quit();
  });

  app.on('before-quit', (e) => {
    // The tray's Exit set the flag before calling app.quit(); a held quit is
    // not quitting, or the next close would skip hiding to the tray.
    if (holdQuitForPrompt()) {
      e.preventDefault();
      appFlags.isQuitting = false;
      return;
    }
    appFlags.isQuitting = true;
    if (cleanedUp) return;
    cleanedUp = true;
    // Before the device manager: this writes to the board several times a
    // second, and a frame queued after the channel starts closing is what
    // re-opens a HID handle behind the teardown.
    stopAllAmbient();
    deviceManager.stop();
    switcher.stop();
    destroySwitchOverlay();
    tray?.destroy();
    tray = null;
  });
}
