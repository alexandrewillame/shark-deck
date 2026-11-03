import { execFile, spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { existsSync } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { RunningProcess, ScannedGame } from '@shared/types/diagnostics';
import { iconFor } from '../profiles/processIcons';
import type { Platform } from './index';
import { openExternal } from './shared';

/** Noise every Linux desktop session has running that's never a game/app
 *  someone wants to trigger a profile from. Necessarily incomplete — desktop
 *  environments vary far more here than Windows/macOS do. */
const SYSTEM_NOISE = new Set([
  'systemd',
  'systemd-journald',
  'systemd-logind',
  'systemd-udevd',
  'systemd-resolved',
  'systemd-timesyncd',
  'dbus-daemon',
  'dbus-broker',
  'gnome-shell',
  'gnome-session-binary',
  'kwin_x11',
  'kwin_wayland',
  'plasmashell',
  'xfwm4',
  'xfdesktop',
  'xfce4-panel',
  'pipewire',
  'pipewire-pulse',
  'pulseaudio',
  'wireplumber',
  'polkitd',
  'udisksd',
  'upowerd',
  'networkmanager',
  'nm-applet',
  'ibus-daemon',
  'gvfsd',
  'gvfs-daemon',
  'at-spi-bus-launcher',
  'at-spi2-registryd',
  'xdg-desktop-portal',
  'xdg-desktop-portal-gtk',
  'xdg-desktop-portal-kde',
  'xdg-desktop-portal-wlr',
  'xorg',
  'xwayland',
  'bash',
  'sh',
  'cron',
  'sshd',
  'sharkdeck',
  // Wine's own processes, which every Proton game brings along. Named by the
  // Windows program each one runs (see procIdentity), they would otherwise
  // crowd the "running apps" picker with what reads like a Windows desktop.
  'wineserver',
  'services.exe',
  'winedevice.exe',
  'plugplay.exe',
  'svchost.exe',
  'explorer.exe',
  'rpcss.exe',
  'tabtip.exe',
  'conhost.exe',
  'start.exe',
  'steam.exe',
  'rundll32.exe',
  'winedbg.exe',
]);

/** Path fragments that suggest "a real installed application" rather than a
 *  background service — the closest Linux equivalent of Windows'
 *  `MainWindowHandle` check, applied to `guiOnly` filtering. */
const GUI_LIKE_PATH_HINTS = [
  '/usr/bin/',
  '/usr/games/',
  '/usr/local/bin/',
  '/opt/',
  '/snap/',
  '/.local/',
  '/steamapps/',
  '/.steam/',
  '/var/lib/flatpak/',
  '/.var/app/',
];

const STEAM_ROOTS = [
  path.join(os.homedir(), '.steam', 'steam'),
  path.join(os.homedir(), '.steam', 'root'),
  path.join(os.homedir(), '.local', 'share', 'Steam'),
  // Flatpak Steam keeps its own sandboxed data dir.
  path.join(os.homedir(), '.var', 'app', 'com.valvesoftware.Steam', 'data', 'Steam'),
  // So does Snap Steam (Ubuntu's software store).
  path.join(os.homedir(), 'snap', 'steam', 'common', '.local', 'share', 'Steam'),
];

/**
 * The loaders `/proc/<pid>/exe` names for every Windows program run under
 * Wine or Proton — `wine64-preloader` for a game, never the game itself. A
 * Steam game on Linux very often is one, so naming the process by its loader
 * meant no `.exe` trigger could ever fire: not the seeded Gaming list, not a
 * game from the Steam scan, not one typed in by hand.
 */
const WINE_LOADER = /^wine(64)?(-preloader)?$/;

function autostartDir(): string {
  return path.join(process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), '.config'), 'autostart');
}
function desktopFile(): string {
  return path.join(autostartDir(), 'sharkdeck.desktop');
}

/** Launch a settings binary detached, without waiting for its window to
 *  close. Resolves `false` fast (via the child's `error` event) if the
 *  binary doesn't exist; otherwise assumes success and detaches. */
function tryLaunchDetached(bin: string, arg?: string): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const child = spawn(bin, arg ? [arg] : [], { detached: true, stdio: 'ignore' });
    child.once('error', () => {
      if (!settled) {
        settled = true;
        resolve(false);
      }
    });
    setImmediate(() => {
      if (!settled) {
        settled = true;
        child.unref();
        resolve(true);
      }
    });
  });
}

/**
 * Whether this desktop shows tray icons at all.
 *
 * Electron's `new Tray()` does not fail without a tray host — it makes an
 * icon nothing draws. So on stock GNOME (Fedora, Debian, Arch; Ubuntu ships
 * the AppIndicator extension) closing the window hid it into a tray that
 * wasn't there, with no Quit anywhere. Linux trays speak StatusNotifierItem,
 * and the host owns `org.kde.StatusNotifierWatcher` on the session bus; that
 * is what is asked, with either of the two D-Bus tools desktops ship. If
 * neither exists to ask, a tray is assumed — the old behaviour.
 */
async function trayAvailable(): Promise<boolean> {
  const ask = (bin: string, args: string[]) =>
    new Promise<boolean | null>((resolve) => {
      execFile(bin, args, { timeout: 3000 }, (err, stdout) => {
        if (err) resolve((err as NodeJS.ErrnoException).code === 'ENOENT' ? null : false);
        else resolve(/\btrue\b/.test(String(stdout)));
      });
    });
  const watcher = 'org.kde.StatusNotifierWatcher';
  const viaGdbus = await ask('gdbus', [
    'call',
    '--session',
    '--dest',
    'org.freedesktop.DBus',
    '--object-path',
    '/org/freedesktop/DBus',
    '--method',
    'org.freedesktop.DBus.NameHasOwner',
    watcher,
  ]);
  if (viaGdbus !== null) return viaGdbus;
  const viaDbusSend = await ask('dbus-send', [
    '--session',
    '--print-reply',
    '--dest=org.freedesktop.DBus',
    '/org/freedesktop/DBus',
    'org.freedesktop.DBus.NameHasOwner',
    `string:${watcher}`,
  ]);
  return viaDbusSend ?? true;
}

async function procPids(): Promise<string[]> {
  // Throws when /proc cannot be listed — see runningProcessNames for why that
  // must not read as "nothing is running".
  return (await fs.readdir('/proc')).filter((e) => /^\d+$/.test(e));
}

async function readComm(pid: string): Promise<string | null> {
  try {
    const comm = (await fs.readFile(`/proc/${pid}/comm`, 'utf8')).trim();
    return comm || null;
  } catch {
    return null;
  }
}

/**
 * The Windows program a Wine/Proton process is running, by its own name —
 * `cs2.exe`, not `wine64-preloader`.
 *
 * Wine rewrites the process's argv so `argv[0]` is the Windows path of the
 * program (`Z:\home\…\cs2.exe`, or `C:\…` inside the prefix), and sets
 * `comm` to its file name cut to 15 characters. The command line comes first,
 * as the uncut name; `comm` is the fallback, and only when it still ends in
 * `.exe` (a longer name is cut short of it, and a guess would be wrong). The
 * path is mapped back to Linux only for Wine's `Z:` drive, which is `/` —
 * enough for an icon, and null otherwise.
 */
async function wineIdentity(pid: string): Promise<{ name: string; path: string | null } | null> {
  try {
    const argv0 = (await fs.readFile(`/proc/${pid}/cmdline`, 'utf8')).split('\0')[0] ?? '';
    if (/\.exe$/i.test(argv0)) {
      const unix = /^z:\\/i.test(argv0) ? '/' + argv0.slice(3).replace(/\\/g, '/') : null;
      return { name: path.win32.basename(argv0).toLowerCase(), path: unix };
    }
  } catch {
    // Not ours to read, or gone — try comm.
  }
  const comm = await readComm(pid);
  return comm && /\.exe$/i.test(comm) ? { name: comm.toLowerCase(), path: null } : null;
}

/** One process's name + path. `/proc/<pid>/exe` is preferred (a symlink to
 *  the real executable, not truncated); `comm` (15-char truncated, no path)
 *  is only a fallback for another user's process, where `exe` isn't
 *  readable. A Wine/Proton process is named by the Windows program it runs
 *  (see WINE_LOADER). */
async function procIdentity(pid: string): Promise<{ name: string; path: string | null } | null> {
  let exe: string;
  try {
    // A binary replaced while it runs (an update) reads back as
    // "<path> (deleted)" — still the same program.
    exe = (await fs.readlink(`/proc/${pid}/exe`)).replace(/ \(deleted\)$/, '');
  } catch {
    const comm = await readComm(pid);
    return comm ? { name: comm.toLowerCase(), path: null } : null;
  }
  const name = path.basename(exe).toLowerCase();
  if (WINE_LOADER.test(name)) return (await wineIdentity(pid)) ?? { name, path: exe };
  return { name, path: exe };
}

async function snapshot(): Promise<{ name: string; path: string | null }[]> {
  const out: { name: string; path: string | null }[] = [];
  for (const pid of await procPids()) {
    const id = await procIdentity(pid);
    if (id) out.push(id);
  }
  return out;
}

/**
 * A failed scan is an error, not "nothing is running". Read as an empty list,
 * it told auto-switch that every game had just quit — a switch to the desktop
 * and straight back, popups and all, for one bad read. The switcher skips a
 * poll that throws. (An empty list is a failure too: this process, at least,
 * is always running.) Same rule as win.ts and mac.ts.
 */
async function runningProcessNames(): Promise<Set<string>> {
  const snap = await snapshot();
  if (!snap.length) throw new Error('/proc listed no processes');
  return new Set(snap.map((p) => p.name));
}

async function pathForRunningProcess(name: string): Promise<string | null> {
  // Best-effort (an icon lookup): a failed scan is just "not found".
  const hit = (await snapshot().catch(() => [])).find((p) => p.name === name.toLowerCase());
  return hit?.path ?? null;
}

async function listRunningProcesses(guiOnly = true): Promise<RunningProcess[]> {
  const byName = new Map<string, string | null>();
  // The picker shows what it can; a failed scan is an empty list here.
  for (const { name, path: p } of await snapshot().catch(() => [])) {
    if (!name || SYSTEM_NOISE.has(name) || byName.has(name)) continue;
    if (guiOnly) {
      if (!p || !GUI_LIKE_PATH_HINTS.some((hint) => p.includes(hint))) continue;
    }
    byName.set(name, p);
  }
  const out: RunningProcess[] = [];
  for (const [name, p] of byName) {
    out.push({ name, path: p, iconDataUrl: p ? await iconFor(p) : null });
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

/**
 * One argument of a Desktop Entry `Exec=` line, quoted as the spec requires:
 * inside quotes, `"`, `` ` ``, `$` and `\` take a backslash; the value's own
 * string escaping then doubles every backslash; and `%` (a field code) is
 * written `%%`. A path is rarely any of these — but a downloaded
 * `Shark%20Deck.AppImage` is, and the bare quotes it had broke on it.
 */
export function desktopExecArg(arg: string): string {
  const quoted = arg.replace(/[\\"`$]/g, (c) => `\\${c}`).replace(/\\/g, '\\\\');
  return `"${quoted.replace(/%/g, '%%')}"`;
}

/** Native Linux game binaries named for their engine's target rather than
 *  left bare — Unity's `Game.x86_64`, Godot's `game.x86_64`, older `.x86`. */
const NATIVE_GAME_EXT = new Set(['.x86_64', '.x86', '.aarch64', '.arm64', '.bin']);

async function isElf(full: string): Promise<boolean> {
  let fh: FileHandle | undefined;
  try {
    fh = await fs.open(full, 'r');
    const buf = Buffer.alloc(4);
    await fh.read(buf, 0, 4, 0);
    return buf[0] === 0x7f && buf[1] === 0x45 && buf[2] === 0x4c && buf[3] === 0x46;
  } catch {
    return false;
  } finally {
    await fh?.close().catch(() => undefined);
  }
}

export const linux: Platform = {
  async setStartAtBoot(enabled) {
    const file = desktopFile();
    if (enabled) {
      await fs.mkdir(autostartDir(), { recursive: true }).catch(() => undefined);
      // Inside an AppImage, process.execPath points into a per-run temp
      // mount that's gone by next boot; $APPIMAGE (set by the AppImage
      // runtime) is the stable file path to relaunch.
      const target = process.env.APPIMAGE ?? process.execPath;
      const entry = [
        '[Desktop Entry]',
        'Type=Application',
        'Name=Shark Deck',
        // --ozone-platform=x11: as the menu entry starts it (see
        // electron-builder.yml `linux.executableArgs`), under XWayland.
        `Exec=${desktopExecArg(target)} --ozone-platform=x11 --hidden`,
        'X-GNOME-Autostart-enabled=true',
        'NoDisplay=true',
        '',
      ].join('\n');
      await fs.writeFile(file, entry, 'utf8');
    } else if (existsSync(file)) {
      await fs.unlink(file).catch(() => undefined);
    }
  },
  async isStartAtBoot() {
    return existsSync(desktopFile());
  },
  trayAvailable,
  async openMouseSettings() {
    const candidates: [string, string?][] = [
      ['gnome-control-center', 'mouse'],
      ['systemsettings6', 'kcm_mouse'],
      ['systemsettings5', 'kcm_mouse'],
      ['systemsettings', 'kcm_mouse'],
      ['xfce4-mouse-settings'],
    ];
    for (const [bin, arg] of candidates) {
      if (await tryLaunchDetached(bin, arg)) return true;
    }
    return false;
  },
  openExternal,

  runningProcessNames,
  pathForRunningProcess,
  listRunningProcesses,
  systemNoise: () => SYSTEM_NOISE,

  steamRoots: () => STEAM_ROOTS,
  async extraGameSources(): Promise<ScannedGame[]> {
    return []; // no Epic Games Store launcher on Linux
  },
  async isGameExecutableCandidate(name, full) {
    // Steam games on Linux are very often Windows binaries run under Proton,
    // so a literal ".exe" is still a legitimate hit. A native Linux build has
    // no extension at all — accept an executable-bit ELF instead.
    if (name.toLowerCase().endsWith('.exe')) return true;
    const ext = path.extname(name).toLowerCase();
    // .sh, .py, .txt, … — not a launcher. An engine's own suffix still is.
    if (ext && !NATIVE_GAME_EXT.has(ext)) return false;
    try {
      const st = await fs.stat(full);
      if (!st.isFile() || (st.mode & 0o111) === 0) return false;
    } catch {
      return false;
    }
    return isElf(full);
  },

  info: () => ({
    os: 'linux',
    processSuffix: '',
    processExample: 'cs2',
    canOpenMouseSettings: true,
    nativeTrafficLights: false,
  }),
};
