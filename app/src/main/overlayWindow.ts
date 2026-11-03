import { BrowserWindow, Notification, app, nativeImage, screen } from 'electron';
import path from 'node:path';
import type { SwitchApplication } from '@shared/types/profiles';
import { getT } from '@shared/i18n';
import { getSettingsSync } from './settings';
import { pathForRunningExe } from './profiles/processScan';
import { bigIconFor, iconFor } from './profiles/processIcons';

/**
 * The profile-switch popup: a small always-on-top card, bottom-right of the
 * primary display, that stays for `DISPLAY_MS` then fades — modelled on
 * `legacy/attack-shark-profile-switcher/overlay.py`, but as a real Electron
 * `BrowserWindow` (mirroring how `main/crash.ts` uses a second window with
 * its own isolated preload) rather than a renderer-only card, because it
 * has to stay visible over a fullscreen game while the main SharkDeck window
 * is minimized — something a component inside the main window's React tree
 * cannot do.
 *
 * Deliberately bottom-left rather than the legacy tool's bottom-right, to
 * avoid the corner Windows uses for its own notifications. Like the legacy
 * popup, this never takes focus (`showInactive()` + a non-focusable window)
 * and only fires for a real game/desktop transition — see switcher.ts,
 * which gates `reason` to 'game'/'desktop' before calling this at all.
 */

/**
 * The window, in DIP: room for the card (a header line, then the game's icon
 * and two lines). Taller than the card needs: the page sizes the card to its
 * content and pins it to this box's bottom-right corner, and the rest is
 * transparent and click-through.
 */
const WIDTH = 300;
const HEIGHT = 160;
const MARGIN = 24;
/** Long enough to read without pausing what you are doing. */
const DISPLAY_MS = 10_000;
const FADE_STEPS = 10;
const FADE_INTERVAL_MS = 25;
/**
 * How often a showing card is put back on top. A game going fullscreen AFTER
 * the card appeared — cs2 creates its window a beat after its process starts,
 * which is exactly when the switch fires — lands above it, and the card then
 * spent its whole ten seconds underneath.
 */
const RAISE_MS = 1000;
/** How often the pointer is sampled for the proximity fade, while showing.
 *  The window ignores the mouse, so the page cannot track it itself. */
const PROX_MS = 50;

let win: BrowserWindow | null = null;
let hideTimer: ReturnType<typeof setTimeout> | null = null;
let fadeTimer: ReturnType<typeof setInterval> | null = null;
let raiseTimer: ReturnType<typeof setInterval> | null = null;
let proxTimer: ReturnType<typeof setInterval> | null = null;
/** overlay.html's `api.onContent` subscription only exists after the page has
 *  finished loading — a `send` before that is silently dropped, which is why
 *  the very first switch popup used to show an empty card. Hold the payload,
 *  and the show itself, until the page is ready. */
let overlayReady = false;
let pendingContent: OverlayContent | null = null;
let pendingShow: (() => void) | null = null;
/** Which switch the card is showing (`SwitchApplication.at`), so a late icon
 *  lookup only updates the card it was for. */
let showing: number | null = null;
let lastProx = '';

/** What the card shows — see overlay.html. */
interface OverlayContent {
  /** Which switch (`SwitchApplication.at`): a second message for the same
   *  card (a late icon) updates it without restarting its countdown. */
  id: number;
  /** A game started, or play went back to the desktop. */
  kind: 'game' | 'desktop';
  /** How long the card stays, for its countdown bar. */
  ms: number;
  /** Shark Deck's logo and name, for the card's header line. */
  logo: string;
  brand: string;
  /** "Gaming mode". */
  mode: string;
  /** "cs2.exe", or "Exited cs2.exe"; '' for no line. */
  exe: string;
  /** The game's own icon, the card's subject; null while it has none. */
  exeIcon: string | null;
}

/**
 * Linux as a native Wayland client — started without the launcher's
 * `--ozone-platform=x11` (from a terminal, say; see electron-builder.yml).
 * Wayland lets no window place itself, stay on top or let clicks through, so
 * the card would land mid-screen, take focus and sit in the taskbar; a desktop
 * notification says the same two facts instead.
 */
function nativeWayland(): boolean {
  return (
    process.platform === 'linux' &&
    process.env.XDG_SESSION_TYPE === 'wayland' &&
    app.commandLine.getSwitchValue('ozone-platform') !== 'x11'
  );
}

/** Only an inline image may reach the card: its CSP allows `data:` images
 *  and nothing else, and an icon is persisted user data. */
function safeIcon(icon: string | null | undefined): string | null {
  return typeof icon === 'string' && icon.startsWith('data:image/') ? icon : null;
}

/**
 * The app icon as a data URI, read once.
 *
 * The overlay page is sandboxed with `default-src 'none'`, so it cannot load
 * an image off disk; handing it the bytes inline is the way to show real art
 * there. `logo.png` is 1248x1248, so it is resized first — sending a
 * megapixel PNG down an IPC channel eight times a session would be silly —
 * to twice the 36px it is drawn at, for a sharp logo on a high-DPI screen.
 */
let logoDataUrl: string | null = null;
function appLogo(): string {
  if (logoDataUrl !== null) return logoDataUrl;
  const img = nativeImage.createFromPath(path.join(app.getAppPath(), 'assets', 'logo.png'));
  logoDataUrl = img.isEmpty() ? '' : img.resize({ width: 72, height: 72 }).toDataURL();
  return logoDataUrl ?? '';
}

function pushContent(w: BrowserWindow, content: OverlayContent): void {
  if (overlayReady) {
    w.webContents.send('overlay:content', content);
  } else {
    pendingContent = content;
  }
}

function ensureWindow(): BrowserWindow {
  if (win && !win.isDestroyed()) return win;
  win = new BrowserWindow({
    width: WIDTH,
    height: HEIGHT,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    skipTaskbar: true,
    focusable: false,
    hasShadow: false,
    // macOS: a non-activating panel, the kind of window that may float over
    // another app's fullscreen space without the whole app being turned into
    // a Dock-less background agent (see setVisibleOnAllWorkspaces below).
    ...(process.platform === 'darwin' ? { type: 'panel' as const } : {}),
    show: false,
    webPreferences: {
      preload: path.join(__dirname, '../preload/overlay.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  // 'screen-saver' is the level that actually floats above a fullscreen (or
  // borderless-fullscreen) game on Windows — plain `alwaysOnTop: true` in
  // the constructor above is not enough for that case.
  win.setAlwaysOnTop(true, 'screen-saver');
  // `skipTransformProcessType`: without it, Electron makes the app a
  // background agent on macOS to float this over fullscreen apps — no Dock
  // icon, no menu bar, gone from Cmd+Tab for the rest of the session, from
  // the first switch card on. The panel type above floats it instead.
  win.setVisibleOnAllWorkspaces(true, {
    visibleOnFullScreen: true,
    skipTransformProcessType: true,
  });
  // Nothing on this card is clickable — never intercept the mouse.
  win.setIgnoreMouseEvents(true);
  // Never loads remote content — deny navigation and popups (defence-in-depth,
  // matching the main window).
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  overlayReady = false;
  win.webContents.on('did-finish-load', () => {
    overlayReady = true;
    if (win && !win.isDestroyed() && pendingContent) {
      win.webContents.send('overlay:content', pendingContent);
      pendingContent = null;
    }
    const show = pendingShow;
    pendingShow = null;
    show?.();
  });
  void win.loadFile(path.join(__dirname, '../renderer/overlay.html'));
  win.on('closed', () => {
    clearTimers();
    win = null;
    overlayReady = false;
    pendingContent = null;
    pendingShow = null;
    showing = null;
  });
  return win;
}

/**
 * Bottom-right, by request.
 *
 * This was deliberately bottom-LEFT to stay clear of Windows' own
 * notification corner. The user asked for bottom-right anyway, having lived
 * with both; a switch notification landing where notifications land is what
 * they expect, and the two rarely coincide.
 */
function positionBottomRight(w: BrowserWindow): void {
  const area = screen.getPrimaryDisplay().workArea;
  w.setBounds({
    x: area.x + area.width - WIDTH - MARGIN,
    y: area.y + area.height - HEIGHT - MARGIN,
    width: WIDTH,
    height: HEIGHT,
  });
}

function clearTimers(): void {
  if (hideTimer) clearTimeout(hideTimer);
  if (fadeTimer) clearInterval(fadeTimer);
  if (raiseTimer) clearInterval(raiseTimer);
  if (proxTimer) clearInterval(proxTimer);
  hideTimer = null;
  fadeTimer = null;
  raiseTimer = null;
  proxTimer = null;
}

/** Put the card above whatever has come up since — see RAISE_MS. */
function raise(w: BrowserWindow): void {
  if (w.isDestroyed() || !w.isVisible()) return;
  // Re-asserted, not just set once at creation: the level is what floats it
  // over a fullscreen game, and moveTop alone does not restore it.
  w.setAlwaysOnTop(true, 'screen-saver');
  w.moveTop();
}

/**
 * Send the pointer's position, in the card window's own coordinates, for the
 * page to fade the card by (shared/proximityFade.ts — the same rule as the
 * in-app toasts). Only when it moved: twenty identical messages a second
 * would be pure traffic.
 */
function sendPointer(w: BrowserWindow): void {
  if (w.isDestroyed() || !w.isVisible()) return;
  const p = screen.getCursorScreenPoint();
  const b = w.getBounds();
  const at = { x: p.x - b.x, y: p.y - b.y };
  const key = `${at.x},${at.y}`;
  if (key === lastProx) return;
  lastProx = key;
  w.webContents.send('overlay:pointer', at);
}

function beginFade(w: BrowserWindow): void {
  // setOpacity does nothing on Linux — Electron implements it on Windows and
  // macOS only — so there the card simply vanished. The page fades it itself,
  // over the same time, and the steps below still hide the window at the end.
  if (process.platform === 'linux') {
    w.webContents.send('overlay:fade', FADE_STEPS * FADE_INTERVAL_MS);
  }
  let step = FADE_STEPS;
  fadeTimer = setInterval(() => {
    step--;
    if (w.isDestroyed()) {
      clearTimers();
      return;
    }
    if (step <= 0) {
      clearTimers();
      w.hide();
      w.setOpacity(1);
      showing = null;
      return;
    }
    w.setOpacity(step / FADE_STEPS);
  }, FADE_INTERVAL_MS);
}

/**
 * Show the card for one profile switch. Caller (switcher.ts) already filters
 * to `reason: 'game' | 'desktop'`; this additionally checks the user's
 * "show profile-switch overlay" setting.
 *
 * Laid out like a gaming app's notification: a small header line saying
 * whose card it is (Shark Deck's logo and name), then the news — the game's
 * icon, the mode, the game ("Gaming mode", "cs2.exe") — and a thin bar
 * counting down its ten seconds. It was four rows once (the app's name,
 * "Auto-switch onboard", "Gaming Onboard Configuration activated", the
 * executable), most of which said the same thing twice; then the logo and the
 * game's icon shared one corner, which read as cramped. One brand mark, small,
 * apart from the one subject.
 */
export function showSwitchOverlay(app: SwitchApplication): void {
  const settings = getSettingsSync();
  if (!settings.overlayEnabled) return;
  const t = getT(settings.language);
  const exe =
    app.reason === 'game'
      ? (app.context ?? '')
      : app.context
        ? t('overlay.reason.exited', { exe: app.context })
        : '';
  const content: OverlayContent = {
    id: app.at,
    kind: app.reason === 'game' ? 'game' : 'desktop',
    ms: DISPLAY_MS,
    logo: appLogo(),
    brand: t('app.brand'),
    mode: t('overlay.mode', { name: app.profileName }),
    exe,
    exeIcon: exe ? safeIcon(app.exeIcon) : null,
  };

  if (nativeWayland()) {
    if (Notification.isSupported()) {
      new Notification({
        title: content.mode,
        body: content.exe,
        silent: true,
        ...(content.logo ? { icon: nativeImage.createFromDataURL(content.logo) } : {}),
      }).show();
    }
    return;
  }

  const w = ensureWindow();
  clearTimers();
  positionBottomRight(w);
  pushContent(w, content);
  showing = app.at;
  lastProx = '';

  const show = () => {
    if (w.isDestroyed()) return;
    w.setOpacity(1);
    w.showInactive();
    raise(w);
    raiseTimer = setInterval(() => raise(w), RAISE_MS);
    sendPointer(w);
    proxTimer = setInterval(() => sendPointer(w), PROX_MS);
    hideTimer = setTimeout(() => beginFade(w), DISPLAY_MS);
  };
  // A first card waits for its page: shown before then, it painted empty.
  if (overlayReady) show();
  else pendingShow = show;

  // The card draws the game's icon at 32px, and the icon the switcher keeps
  // is the 16px one its lists use — so look up the bigger one here, and update
  // the card if it is still this switch's. The same lookup covers a trigger
  // added by name, which has no icon at all until it has been seen running.
  if (app.reason === 'game' && app.context) {
    void (async () => {
      try {
        const where = await pathForRunningExe(app.context);
        if (!where) return;
        const icon = safeIcon(
          (await bigIconFor(where)) ?? (content.exeIcon ? null : await iconFor(where)),
        );
        if (!icon || showing !== app.at || w.isDestroyed()) return;
        pushContent(w, { ...content, exeIcon: icon });
      } catch {
        // best-effort: the row just has no icon
      }
    })();
  }
}

/** Called on app quit, alongside the tray/device-manager teardown. */
export function destroySwitchOverlay(): void {
  clearTimers();
  pendingShow = null;
  if (win && !win.isDestroyed()) win.destroy();
  win = null;
}
