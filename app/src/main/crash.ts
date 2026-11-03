import { app, BrowserWindow, dialog, shell, ipcMain, clipboard } from 'electron';
import { mkdirSync, appendFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { getT, localeMeta, type TFunc } from '@shared/i18n';
import { frameLog } from './diagnostics';
import { getSettingsSync } from './settings';

/**
 * Top-level error trap for the main process. Instead of Electron's built-in
 * modal (whose text cannot be selected or copied), every unhandled error is
 *   1. written to userData/logs/crash-<ts>.log, and
 *   2. shown in a small window with the full report in a read-only textarea
 *      plus Copy / Open-logs / Restart / Quit buttons.
 * The report includes app + Electron/Node/Chrome/OS versions and the last HID
 * frames — the context that actually matters for this app.
 */

let installed = false;
let windowShown = false;
/** A quiet report is waiting for the app to come to the front — see `report`. */
let waitingForFocus = false;
let fatalHandled = false;
let lastReport = '';

/** Set by `installCrashReporter`; lets `index.ts` funnel a rejection from the
 *  `app.whenReady().then(bootstrap)` chain through the same trap. */
export let reportFatalBootstrap: (err: unknown) => void = () => {};

const logDir = () => path.join(app.getPath('userData'), 'logs');

/** The UI language, read when a window opens. English if the settings cannot
 *  be read — this runs after something has already gone wrong. */
function crashLocale(): string {
  try {
    return localeMeta(getSettingsSync().language).code;
  } catch {
    return 'en';
  }
}

/**
 * What crash.html shows, in the app's language (`crash:get-strings`).
 *
 * `sub` keeps its `{copy}` placeholder and `loadFailed` its `{error}`: the page
 * fills them itself — the first with the Copy button's name in bold, wherever
 * the translation puts it. The report stays English: it is for a bug report.
 */
function crashStrings(t: TFunc = getT(crashLocale())) {
  return {
    lang: crashLocale(),
    title: t('crash.title'),
    heading: t('crash.heading'),
    sub: t('crash.sub'),
    loading: t('crash.loading'),
    copy: t('crash.copy'),
    logs: t('crash.openLogs'),
    copied: t('crash.copied'),
    restart: t('crash.restart'),
    quit: t('crash.quit'),
    loadFailed: t('crash.loadFailed'),
  };
}

function buildReport(kind: string, err: unknown): string {
  const e =
    err instanceof Error
      ? err
      : new Error(
          typeof err === 'string'
            ? err
            : (() => {
                try {
                  return JSON.stringify(err);
                } catch {
                  return String(err);
                }
              })(),
        );

  const frames =
    frameLog
      .all()
      .slice(-30)
      .map(
        (f) =>
          `  ${new Date(f.ts).toISOString()}  ${f.dir}  ${f.hex}${f.note ? '  ; ' + f.note : ''}`,
      )
      .join('\n') || '  (none)';

  return [
    'Shark Deck — main process error',
    '='.repeat(60),
    `when      : ${new Date().toISOString()}`,
    `kind      : ${kind}`,
    `message   : ${e.message}`,
    '',
    'stack:',
    e.stack ?? '(no stack)',
    '',
    `app       : ${app.getVersion()}   packaged=${app.isPackaged}`,
    `electron  : ${process.versions.electron}   chrome=${process.versions.chrome}`,
    `node      : ${process.versions.node}   v8=${process.versions.v8}`,
    `os        : ${os.type()} ${os.release()} ${process.arch}`,
    `argv      : ${process.argv.join(' ')}`,
    `userData  : ${app.getPath('userData')}`,
    '',
    'last HID frames:',
    frames,
    '',
  ].join('\n');
}

function persist(report: string): string | null {
  try {
    mkdirSync(logDir(), { recursive: true });
    const file = path.join(logDir(), `crash-${new Date().toISOString().replace(/[:.]/g, '-')}.log`);
    appendFileSync(file, report + '\n');
    return file;
  } catch {
    return null;
  }
}

function showWindow(report: string): void {
  const title = getT(crashLocale())('crash.title');
  try {
    const win = new BrowserWindow({
      width: 760,
      height: 620,
      title,
      backgroundColor: '#0a0c10',
      autoHideMenuBar: true,
      webPreferences: {
        preload: path.join(__dirname, '../preload/crash.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    // This app never loads remote content — deny navigation and popups here
    // too, not just on the main window.
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('will-navigate', (e) => e.preventDefault());
    void win.loadFile(path.join(__dirname, '../renderer/crash.html'));
  } catch {
    dialog.showErrorBox(title, report);
  }
}

/**
 * `onFatal` is invoked once, the first time an `uncaughtException` /
 * `unhandledRejection` reaches the trap — the main process is in an undefined
 * state at that point, so the caller uses it to stop the background machinery
 * (device scan loop, switcher poll) that would otherwise keep driving HID
 * writes with half-mutated state. The crash window is still shown so the user
 * can copy the report and choose Restart / Quit.
 */
export function installCrashReporter(onFatal?: () => void): void {
  if (installed) return;
  installed = true;

  ipcMain.handle('crash:get-report', () => lastReport);
  ipcMain.handle('crash:get-strings', () => crashStrings());
  ipcMain.handle('crash:copy', (_e, text: unknown) => {
    clipboard.writeText(typeof text === 'string' && text ? text : lastReport);
  });
  ipcMain.handle('crash:open-logs', () => shell.openPath(logDir()));
  ipcMain.on('crash:restart', () => {
    // An AppImage runs from a mount that goes away when this process exits;
    // relaunching that copy started nothing. $APPIMAGE is the file itself.
    // `--hidden` is dropped either way: a restart asked for from this window
    // should come back as a window.
    const args = process.argv.slice(1).filter((a) => a !== '--hidden');
    const appImage = process.env.APPIMAGE;
    app.relaunch(appImage ? { execPath: appImage, args } : { args });
    app.exit(0);
  });
  ipcMain.on('crash:quit', () => app.exit(1));

  /** @param quiet the app has already recovered: say so without taking focus. */
  const report = (kind: string, err: unknown, quiet = false): void => {
    const text = buildReport(kind, err);
    const file = persist(text);
    lastReport = file ? `${text}\nsaved to  : ${file}\n` : text;
    // eslint-disable-next-line no-console
    console.error('\n' + lastReport);

    // A main-process `uncaughtException` / `unhandledRejection` means execution
    // resumed past a throw with unknown state — stop the workers that keep
    // touching hardware and disk before they act on it again. (Recoverable
    // events like `render-process-gone` don't trigger this.)
    if (
      !fatalHandled &&
      (kind === 'uncaughtException' || kind === 'unhandledRejection' || kind === 'bootstrap')
    ) {
      fatalHandled = true;
      try {
        onFatal?.();
      } catch {
        /* never let teardown throw out of the trap */
      }
    }

    if (windowShown) return; // one window is enough; later errors only hit the log
    // A quiet report waits until the app is in front: at once if one of its
    // windows has focus, otherwise the next time one gets it. The window used
    // to jump up regardless, pulling focus out of a game for a GPU-process
    // crash the app had already recovered from. The report is on disk either
    // way, and a fatal error that follows still shows at once.
    const inFront = app.isReady() && BrowserWindow.getFocusedWindow() !== null;
    if (quiet && !inFront) {
      if (!waitingForFocus) {
        waitingForFocus = true;
        app.once('browser-window-focus', () => {
          waitingForFocus = false;
          if (windowShown) return;
          windowShown = true;
          showWindow(lastReport);
        });
      }
      return;
    }
    windowShown = true;
    if (app.isReady()) showWindow(lastReport);
    else void app.whenReady().then(() => showWindow(lastReport));
  };

  /** Route a bootstrap-chain rejection through the same reporter. */
  reportFatalBootstrap = (err: unknown) => report('bootstrap', err);

  process.on('uncaughtException', (err) => report('uncaughtException', err));
  process.on('unhandledRejection', (reason) => report('unhandledRejection', reason));
  app.on('render-process-gone', (_e, _wc, details) =>
    report(
      'render-process-gone',
      new Error(`renderer gone: ${details.reason} (exitCode ${details.exitCode})`),
    ),
  );
  // A helper process — the GPU process, most often, which can crash under a
  // graphics driver or a game — is relaunched by Chromium on its own, and the
  // app carries on. Worth a report; not worth taking focus for.
  app.on('child-process-gone', (_e, details) =>
    report(
      'child-process-gone',
      new Error(`${details.type} gone: ${details.reason} (exitCode ${details.exitCode})`),
      true,
    ),
  );
  app.on('web-contents-created', (_e, wc) => {
    wc.on('preload-error', (_ev, preloadPath, err) =>
      report('preload-error', new Error(`${preloadPath}: ${err.message}`)),
    );
  });
}
