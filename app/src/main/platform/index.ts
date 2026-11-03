import type { PlatformInfo } from '@shared/types/app-settings';
import type { RunningProcess, ScannedGame } from '@shared/types/diagnostics';
import { win } from './win';
import { mac } from './mac';
import { linux } from './linux';

/**
 * OS-specific glue. Everything platform-dependent — startup-on-login, the
 * system mouse-settings deep link, process/game scanning for auto-switch —
 * lives behind this interface so main/ipc.ts, profiles/processScan.ts and
 * profiles/gameScan.ts never branch on `process.platform` themselves.
 *
 * One implementation per OS (win.ts / mac.ts / linux.ts), selected once below
 * by `process.platform` and exported as the single `platform` singleton.
 */
export interface Platform {
  setStartAtBoot(enabled: boolean): Promise<void>;
  isStartAtBoot(): Promise<boolean>;
  /** Whether a tray icon would be shown at all — see linux.ts. Asked once,
   *  before the tray is made. */
  trayAvailable(): Promise<boolean>;
  /** Opens the OS's mouse-settings panel (pointer speed, double-click, …).
   *  Resolves false when nothing on this OS/DE could be launched, so the UI
   *  can decide whether to keep offering the button. */
  openMouseSettings(): Promise<boolean>;
  openExternal(url: string): Promise<void>;

  /** Cheap, frequent liveness check (the auto-switcher's poll loop) — lower-
   *  cased process/image names only, no paths. REJECTS when the scan fails:
   *  an empty set would tell auto-switch every game had just quit. */
  runningProcessNames(): Promise<Set<string>>;
  /** Full path for one already-known-running process name, used to backfill
   *  a manually-added trigger's icon the first time it's seen running. */
  pathForRunningProcess(name: string): Promise<string | null>;
  /** Slower, on-demand snapshot with paths + icons, for the Auto-Switch
   *  "Refresh running apps" picker. `guiOnly` restricts to processes that
   *  look like real applications rather than background services. */
  listRunningProcesses(guiOnly: boolean): Promise<RunningProcess[]>;
  /** Background noise this OS always has running, filtered out of the picker. */
  systemNoise(): ReadonlySet<string>;

  /** Candidate install roots for a local Steam library. */
  steamRoots(): string[];
  /** Other installed-game sources beyond Steam (Epic on Windows only). */
  extraGameSources(): Promise<ScannedGame[]>;
  /** Whether a file found while walking a game's install directory is a
   *  plausible launcher executable on this OS. */
  isGameExecutableCandidate(name: string, fullPath: string): Promise<boolean>;

  /** Static per-OS facts the renderer needs (see PlatformInfo). `isDev` is
   *  deliberately not one of them — it is a packaging fact, not an OS fact,
   *  and is added by the getPlatformInfo IPC handler. */
  /** Static per-OS facts. `isDev` and `appVersion` are filled in by ipc.ts —
   *  they are properties of this build, not of the platform. */
  info(): Omit<PlatformInfo, 'isDev' | 'appVersion'>;
}

function select(): Platform {
  if (process.platform === 'darwin') return mac;
  if (process.platform === 'linux') return linux;
  return win;
}

export const platform: Platform = select();
