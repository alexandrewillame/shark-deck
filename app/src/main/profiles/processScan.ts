import type { RunningProcess } from '@shared/types/diagnostics';
import { platform } from '../platform';

/**
 * Running-process snapshot, delegated to the OS-specific implementation (see
 * main/platform/). Kept as three separate exports (rather than importing
 * `platform` directly at each call site) so profiles/switcher.ts and
 * main/ipc.ts don't need to change when this moved behind the seam.
 */

/** The switcher's hot-loop check (every 1-5s, per `pollSeconds`) — the
 *  cheapest thing that answers "is this process running", no path needed. */
export function runningImageNames(): Promise<Set<string>> {
  return platform.runningProcessNames();
}

/** Full path for one already-known-running process name — used to backfill a
 *  manually-added trigger's icon the first time it's actually seen running. */
export function pathForRunningExe(exeName: string): Promise<string | null> {
  return platform.pathForRunningProcess(exeName);
}

/** On-demand, slower snapshot with real paths + icons, for the Auto-Switch
 *  "Refresh running apps" picker — never called from the poll loop. */
export function listRunningProcesses(guiOnly = true): Promise<RunningProcess[]> {
  return platform.listRunningProcesses(guiOnly);
}
