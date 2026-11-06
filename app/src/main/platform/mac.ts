import { app } from 'electron';
import { exec, execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { RunningProcess, ScannedGame } from '@shared/types/diagnostics';
import { iconFor } from '../profiles/processIcons';
import type { Platform } from './index';
import { runChecked, openExternal } from './shared';

/** Noise every macOS session has running that's never a game/app someone
 *  wants to trigger a profile from. */
const SYSTEM_NOISE = new Set([
  'windowserver',
  'finder',
  'dock',
  'loginwindow',
  'systemuiserver',
  'controlcenter',
  'notificationcenter',
  'coreservicesuiagent',
  'universalaccessd',
  'launchd',
  'launchservicesd',
  'cfprefsd',
  'distnoted',
  'usernoted',
  'trustd',
  'nsurlsessiond',
  'mds',
  'mds_stores',
  'mdworker',
  'spindump',
  'diagnosticd',
  'logd',
  'wifiagent',
  'bluetoothd',
  'coreaudiod',
  'sharkdeck',
]);

const STEAM_ROOTS = [path.join(os.homedir(), 'Library', 'Application Support', 'Steam')];

/**
 * One `ps` snapshot: pid + `comm` (full executable path on macOS — BSD `ps`
 * does not truncate `comm` the way Linux's `/proc/<pid>/comm` does).
 *
 * Rejects when `ps` fails. A failed scan is an error, not "nothing is
 * running": read as an empty list, it told auto-switch that every game had
 * just quit — a switch to the desktop and straight back for one bad read. The
 * switcher skips a poll that throws; the best-effort callers (icon lookup, the
 * process picker) catch it themselves. Same rule as win.ts and linux.ts.
 */
function psSnapshot(): Promise<{ pid: number; comm: string }[]> {
  return new Promise((resolve, reject) => {
    exec('ps -axo pid=,comm=', { maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
      if (err || !stdout) return reject(err ?? new Error('ps returned nothing'));
      const out: { pid: number; comm: string }[] = [];
      for (const line of stdout.split('\n')) {
        const m = /^\s*(\d+)\s+(.+?)\s*$/.exec(line);
        if (m) out.push({ pid: Number(m[1]), comm: m[2]! });
      }
      resolve(out);
    });
  });
}

/**
 * The name a `.app` bundle runs under — the Mach-O binary its Info.plist
 * names as `CFBundleExecutable` — which is what the running-process scan
 * reports, and so what a trigger has to say. The bundle's own name often
 * differs (Steam.app runs as `steam_osx`), and a trigger taken from it never
 * fired. `plutil` reads the plist whether it is XML or binary. Null when it
 * can't be read.
 */
export function bundleExecutableName(appPath: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      'plutil',
      [
        '-extract',
        'CFBundleExecutable',
        'raw',
        '-o',
        '-',
        path.join(appPath, 'Contents', 'Info.plist'),
      ],
      { timeout: 3000 },
      (err, stdout) => {
        const name = err ? '' : String(stdout).trim();
        resolve(name ? name.toLowerCase() : null);
      },
    );
  });
}

/** Walk a running binary's path back up to its `.app` bundle root, if any —
 *  nicer to display and resolves a far better icon than the raw Mach-O
 *  binary inside `Contents/MacOS/`. */
function resolveAppBundle(comm: string): string {
  const parts = comm.split('/');
  const idx = parts.findIndex((p) => p.endsWith('.app'));
  return idx === -1 ? comm : parts.slice(0, idx + 1).join('/');
}

async function runningProcessNames(): Promise<Set<string>> {
  const snap = await psSnapshot();
  return new Set(snap.map((p) => path.basename(p.comm).toLowerCase()));
}

async function pathForRunningProcess(name: string): Promise<string | null> {
  const snap = await psSnapshot().catch(() => []);
  const hit = snap.find((p) => path.basename(p.comm).toLowerCase() === name.toLowerCase());
  return hit ? resolveAppBundle(hit.comm) : null;
}

/**
 * `guiOnly` has no single macOS API as clean as Windows' `MainWindowHandle`;
 * the practical proxy is "the running binary lives inside a `.app` bundle" —
 * background daemons and CLI tools don't. That alone let through the couple of
 * dozen agents macOS keeps running as `.app` bundles of its own (AirPlayUIAgent,
 * XProtect, WindowManager… under /System/Library and /Library/Apple), and the
 * helper apps every Electron or Chromium app nests inside its bundle — Shark
 * Deck's own `SharkDeck Helper (Renderer).app` included: on a fresh Mac they were
 * the whole list. /System/Applications (Chess, Calculator…) stays, and so does a
 * Steam game under ~/Library/Application Support. Best-effort, not exhaustive.
 */
export function isUserApp(comm: string): boolean {
  if (!comm.includes('.app/Contents/MacOS/')) return false;
  if (comm.startsWith('/System/Library/') || comm.startsWith('/Library/Apple/')) return false;
  // A bundle inside another bundle is that app's helper.
  return comm.split('.app/').length === 2;
}

async function listRunningProcesses(guiOnly = true): Promise<RunningProcess[]> {
  const snap = await psSnapshot().catch(() => []);
  const byName = new Map<string, string>();
  for (const { comm } of snap) {
    if (guiOnly && !isUserApp(comm)) continue;
    const name = path.basename(comm).toLowerCase();
    if (!name || SYSTEM_NOISE.has(name) || byName.has(name)) continue;
    byName.set(name, resolveAppBundle(comm));
  }
  const out: RunningProcess[] = [];
  for (const [name, p] of byName) {
    out.push({ name, path: p, iconDataUrl: await iconFor(p) });
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

export const mac: Platform = {
  async setStartAtBoot(enabled) {
    app.setLoginItemSettings({ openAtLogin: enabled, openAsHidden: true, args: ['--hidden'] });
  },
  async isStartAtBoot() {
    return app.getLoginItemSettings().openAtLogin;
  },
  // The menu bar is always there.
  async trayAvailable() {
    return true;
  },
  async openMouseSettings() {
    if (await runChecked("open 'x-apple.systempreferences:com.apple.Mouse-Settings.extension'"))
      return true;
    return runChecked('open -b com.apple.systempreferences');
  },
  openExternal,

  runningProcessNames,
  pathForRunningProcess,
  listRunningProcesses,
  systemNoise: () => SYSTEM_NOISE,

  steamRoots: () => STEAM_ROOTS,
  async extraGameSources(): Promise<ScannedGame[]> {
    return []; // no Epic Games Store launcher on macOS
  },
  async isGameExecutableCandidate(_name, full) {
    const normalized = full.replace(/\\/g, '/');
    if (!normalized.includes('/Contents/MacOS/')) return false;
    try {
      const st = await fs.stat(full);
      return st.isFile() && (st.mode & 0o111) !== 0;
    } catch {
      return false;
    }
  },

  info: () => ({
    os: 'darwin',
    processSuffix: '',
    processExample: 'cs2',
    canOpenMouseSettings: true,
    nativeTrafficLights: true,
  }),
};
