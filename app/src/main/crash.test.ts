import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * When the crash window shows.
 *
 * A fatal main-process error shows it at once. A helper process Chromium
 * relaunches by itself — the GPU process, typically, under a graphics driver
 * or a game — used to as well, pulling focus out of whatever had it for a
 * crash the app had already recovered from. That report now waits for the
 * app to be in front.
 */

const h = vi.hoisted(() => ({
  dir: '',
  app: new Map<string, (...a: unknown[]) => void>(),
  appOnce: new Map<string, () => void>(),
  proc: new Map<string, (...a: unknown[]) => void>(),
  focused: null as object | null,
  windows: 0,
}));

vi.mock('electron', () => ({
  app: {
    getPath: () => h.dir,
    getVersion: () => '0.0.0',
    isPackaged: false,
    isReady: () => true,
    whenReady: async () => undefined,
    on: (ev: string, fn: (...a: unknown[]) => void) => h.app.set(ev, fn),
    once: (ev: string, fn: () => void) => h.appOnce.set(ev, fn),
  },
  BrowserWindow: class {
    static getFocusedWindow = () => h.focused;
    webContents = { setWindowOpenHandler: () => undefined, on: () => undefined };
    constructor() {
      h.windows++;
    }
    loadFile() {
      return Promise.resolve();
    }
  },
  dialog: { showErrorBox: () => undefined },
  shell: { openPath: async () => '' },
  ipcMain: { handle: () => undefined, on: () => undefined },
  clipboard: { writeText: () => undefined },
}));
vi.mock('./diagnostics', () => ({ frameLog: { all: () => [] } }));

const gpuGone = () =>
  h.app.get('child-process-gone')!({}, { type: 'GPU', reason: 'crashed', exitCode: 1 });

beforeEach(async () => {
  h.dir = mkdtempSync(path.join(os.tmpdir(), 'sd-crash-'));
  h.app.clear();
  h.appOnce.clear();
  h.proc.clear();
  h.focused = null;
  h.windows = 0;
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  // The real handlers would trap this worker's own errors.
  vi.spyOn(process, 'on').mockImplementation(((ev: string, fn: (...a: unknown[]) => void) => {
    h.proc.set(ev, fn);
    return process;
  }) as never);
  vi.resetModules();
  const { installCrashReporter } = await import('./crash');
  installCrashReporter();
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(h.dir, { recursive: true, force: true });
});

describe('the crash window', () => {
  it('shows at once for a fatal error, focused or not', () => {
    h.proc.get('uncaughtException')!(new Error('boom'));
    expect(h.windows).toBe(1);
  });

  it('waits for the app to be in front after a GPU-process crash', () => {
    gpuGone();
    expect(h.windows).toBe(0);
    // A second one while waiting does not queue a second window.
    gpuGone();
    h.appOnce.get('browser-window-focus')!();
    expect(h.windows).toBe(1);
  });

  it('shows a GPU-process crash at once when the app already has focus', () => {
    h.focused = {};
    gpuGone();
    expect(h.windows).toBe(1);
  });

  it('lets a fatal error that follows show at once, and only once', () => {
    gpuGone();
    h.proc.get('unhandledRejection')!(new Error('worse'));
    expect(h.windows).toBe(1);
    h.appOnce.get('browser-window-focus')!();
    expect(h.windows).toBe(1);
  });
});
