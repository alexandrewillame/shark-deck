import { app } from 'electron';
import { exec, execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { RunningProcess, ScannedGame } from '@shared/types/diagnostics';
import { iconFor } from '../profiles/processIcons';
import type { Platform } from './index';
import { run, openExternal } from './shared';

/** Startup-folder shortcut target — a function, not a module-level constant,
 *  so it is never evaluated on an OS where `%APPDATA%` is meaningless. */
function startupDir(): string {
  return path.join(
    process.env.APPDATA ?? app.getPath('appData'),
    'Microsoft',
    'Windows',
    'Start Menu',
    'Programs',
    'Startup',
  );
}
/** Named as the app is named — "Shark Deck" is what Task Manager's Startup
 *  list and the Startup folder show. */
function shortcutPath(): string {
  return path.join(startupDir(), 'Shark Deck.lnk');
}
/** What the shortcut was called before the name got its space. Still counts
 *  as "on", and is replaced (or removed) the next time the setting is saved,
 *  so nobody ends up with two, or with start-at-login reading as off. */
function legacyShortcutPath(): string {
  return path.join(startupDir(), 'SharkDeck.lnk');
}

/** Noise every Windows session has running that's never a game/app someone
 *  wants to trigger a profile from — filtered out of the picker list. */
const SYSTEM_NOISE = new Set([
  'system',
  'system idle process',
  'registry',
  'memory compression',
  'svchost.exe',
  'dllhost.exe',
  'conhost.exe',
  'csrss.exe',
  'wininit.exe',
  'winlogon.exe',
  'services.exe',
  'lsass.exe',
  'smss.exe',
  'fontdrvhost.exe',
  'dwm.exe',
  'sihost.exe',
  'taskhostw.exe',
  'explorer.exe',
  'searchindexer.exe',
  'searchhost.exe',
  'runtimebroker.exe',
  'shellexperiencehost.exe',
  'startmenuexperiencehost.exe',
  'textinputhost.exe',
  'ctfmon.exe',
  'audiodg.exe',
  'sharkdeck.exe',
]);

const STEAM_ROOTS = [
  'C:\\Program Files (x86)\\Steam',
  'C:\\Program Files\\Steam',
  path.join(process.env.LOCALAPPDATA ?? os.homedir(), 'Steam'),
];

const EPIC_MANIFESTS = 'C:\\ProgramData\\Epic\\EpicGamesLauncher\\Data\\Manifests';

async function extraGameSources(): Promise<ScannedGame[]> {
  if (!existsSync(EPIC_MANIFESTS)) return [];
  const out: ScannedGame[] = [];
  for (const entry of await fs.readdir(EPIC_MANIFESTS).catch(() => [])) {
    if (!entry.endsWith('.item')) continue;
    try {
      const data = JSON.parse(await fs.readFile(path.join(EPIC_MANIFESTS, entry), 'utf8'));
      if (data.LaunchExecutable && data.DisplayName) {
        out.push({
          label: data.DisplayName,
          exe: path.basename(data.LaunchExecutable),
          source: 'epic',
        });
      }
    } catch {
      /* skip */
    }
  }
  return out;
}

/**
 * Windows process image-name snapshot via `tasklist`. Dependency-free stand-in
 * for the Python tool's psutil.process_iter(["name"]). Names are lower-cased,
 * de-duplicated, and matched without paths — same contract as the original.
 */
function runningProcessNames(): Promise<Set<string>> {
  return new Promise((resolve, reject) => {
    exec(
      'tasklist /fo csv /nh',
      { windowsHide: true, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout) => {
        // A failed scan is an error, not "nothing is running". Read as an
        // empty list it told auto-switch that every game had just quit: a
        // switch to the desktop and straight back, popups and all, for one
        // hiccup of `tasklist`. The switcher skips a poll that throws. (No
        // output at all is a failure too — there is always a System process.)
        if (err || !stdout) return reject(err ?? new Error('tasklist returned nothing'));
        const names = new Set<string>();
        for (const line of stdout.split(/\r?\n/)) {
          const m = /^"([^"]+)"/.exec(line);
          if (m) names.add(m[1]!.toLowerCase());
        }
        resolve(names);
      },
    );
  });
}

function pathForRunningProcess(exeName: string): Promise<string | null> {
  return new Promise((resolve) => {
    // `exeName` comes from a user-typed Auto-Switch trigger (AutoSwitch.tsx's
    // manual-add/rename) — it must never be interpolated into the PowerShell
    // *script text* the way it used to be here (`Name='${safe}'` inside a
    // string handed to `exec`, which runs through cmd.exe): only single
    // quotes were escaped, so a name containing `"`, `` ` ``, `$()`, or a
    // cmd.exe metacharacter like `&` broke out of the quoting and ran as an
    // arbitrary command the moment a process with that literal name existed.
    // The script below is a fixed string with no interpolation at all; the
    // name reaches PowerShell only as a plain runtime string via an
    // environment variable (set directly on the child process, never parsed
    // by any shell), then gets WQL-escaped (doubling `'`) before it's used
    // in the filter — so it's never re-parsed as PowerShell *or* WQL syntax.
    const script =
      '$n = $env:SD_EXE_NAME.Replace("\'", "\'\'"); ' +
      '(Get-CimInstance Win32_Process -Filter "Name=\'$n\'" | Select-Object -First 1 -ExpandProperty ExecutablePath)';
    execFile(
      'powershell',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      { windowsHide: true, maxBuffer: 1024 * 1024, env: { ...process.env, SD_EXE_NAME: exeName } },
      (err, stdout) => {
        if (err) return resolve(null);
        const p = (stdout ?? '').trim();
        resolve(p || null);
      },
    );
  });
}

/**
 * On-demand, slower snapshot with real file paths (`tasklist` gives none),
 * for the Auto-Switch "Refresh running apps" picker — never called from the
 * poll loop. Shells PowerShell rather than `wmic` (deprecated / absent on
 * newer Windows). `guiOnly` restricts to processes with a visible top-level
 * window (`Get-Process`'s `MainWindowHandle`, joined back to `Win32_Process`
 * for the executable path).
 */
function listRunningProcesses(guiOnly = true): Promise<RunningProcess[]> {
  return new Promise((resolve) => {
    const script = guiOnly
      ? '$w = Get-Process | Where-Object { $_.MainWindowHandle -ne 0 -and $_.MainWindowTitle } | Select-Object -ExpandProperty Id; ' +
        'Get-CimInstance Win32_Process | Where-Object { $w -contains $_.ProcessId } | ' +
        'Select-Object Name,ExecutablePath | ConvertTo-Json -Compress'
      : 'Get-CimInstance Win32_Process | Select-Object Name,ExecutablePath | ConvertTo-Json -Compress';
    const cmd = `powershell -NoProfile -NonInteractive -Command "${script}"`;
    exec(cmd, { windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, async (err, stdout) => {
      if (err || !stdout) return resolve([]);
      let rows: { Name?: string; ExecutablePath?: string | null }[];
      try {
        const parsed = JSON.parse(stdout);
        rows = Array.isArray(parsed) ? parsed : [parsed];
      } catch {
        return resolve([]);
      }
      const byName = new Map<string, string | null>();
      for (const row of rows) {
        const name = row.Name?.toLowerCase();
        if (!name || SYSTEM_NOISE.has(name) || byName.has(name)) continue;
        if (!row.ExecutablePath) continue;
        byName.set(name, row.ExecutablePath);
      }
      const out: RunningProcess[] = [];
      for (const [name, p] of byName) {
        out.push({ name, path: p, iconDataUrl: p ? await iconFor(p) : null });
      }
      out.sort((a, b) => a.name.localeCompare(b.name));
      resolve(out);
    });
  });
}

export const win: Platform = {
  async setStartAtBoot(enabled) {
    // A Startup-folder shortcut, not a scheduled task or Run key — no admin
    // rights, and nothing left behind. Mirrors the Python tool's approach.
    const shortcut = shortcutPath();
    if (enabled) {
      // The shortcut path and the exe path are filesystem strings we do NOT
      // control (an account named `O'Brien`, an install dir with a quote) —
      // they must never be interpolated into the PowerShell *script text* (the
      // old code did exactly that inside single quotes, so one apostrophe
      // broke the quoting and the tail parsed as code). Same hardening as
      // `pathForRunningProcess` above: the script is a fixed string, the paths
      // reach PowerShell only as plain runtime strings via env vars set
      // directly on the child (never parsed by a shell).
      const script =
        '$s = (New-Object -ComObject WScript.Shell).CreateShortcut($env:SD_LNK); ' +
        '$s.TargetPath = $env:SD_TARGET; ' +
        "$s.Arguments = '--hidden'; " +
        '$s.WorkingDirectory = Split-Path -LiteralPath $env:SD_TARGET -Parent; ' +
        '$s.Save()';
      await new Promise<void>((resolve, reject) => {
        execFile(
          'powershell',
          ['-NoProfile', '-NonInteractive', '-Command', script],
          {
            windowsHide: true,
            // The portable build runs from a copy unpacked to a temp folder
            // that is gone by the next boot; electron-builder names the real
            // .exe in PORTABLE_EXECUTABLE_FILE (as $APPIMAGE does on Linux).
            env: {
              ...process.env,
              SD_LNK: shortcut,
              SD_TARGET: process.env.PORTABLE_EXECUTABLE_FILE ?? process.execPath,
            },
          },
          (err) => (err ? reject(err) : resolve()),
        );
      });
      if (existsSync(legacyShortcutPath())) {
        await fs.unlink(legacyShortcutPath()).catch(() => undefined);
      }
    } else {
      for (const lnk of [shortcut, legacyShortcutPath()]) {
        if (existsSync(lnk)) await fs.unlink(lnk).catch(() => undefined);
      }
    }
  },
  async isStartAtBoot() {
    return existsSync(shortcutPath()) || existsSync(legacyShortcutPath());
  },
  // The notification area is always there.
  async trayAvailable() {
    return true;
  },
  async openMouseSettings() {
    await run('rundll32.exe shell32.dll,Control_RunDLL main.cpl @0');
    return true;
  },
  openExternal,

  runningProcessNames,
  pathForRunningProcess,
  listRunningProcesses,
  systemNoise: () => SYSTEM_NOISE,

  steamRoots: () => STEAM_ROOTS,
  extraGameSources,
  async isGameExecutableCandidate(name) {
    return name.toLowerCase().endsWith('.exe');
  },

  info: () => ({
    os: 'win32',
    processSuffix: '.exe',
    processExample: 'cs2.exe',
    canOpenMouseSettings: true,
    nativeTrafficLights: false,
  }),
};
