import { spawn } from 'node:child_process';
import { existsSync, promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { app } from 'electron';
import type { DeviceDescriptor, RecordingPlan } from '@shared/types/device';
import { deviceManager } from './devices/manager';
import { supportPlan } from './devices/support';

/**
 * Starting the device report tool for one device, from its "Help add it" /
 * "Help complete its support" invitation (renderer SupportInvite).
 *
 * The tools ship with the app (electron-builder.yml): on Windows the one that
 * records the official software, `SharkDeck-device-report.bat`; on macOS and
 * Linux the one that makes the report alone, `sharkdeck-device-report.sh`
 * (the official software runs on Windows only). The command line comes from
 * the catalogue — the device's USB ids and what it still lacks — never from
 * the renderer, which only names the device.
 */

export type ReportToolOs = 'win32' | 'darwin' | 'linux';

const TOOL = { win32: 'SharkDeck-device-report.bat', unix: 'sharkdeck-device-report.sh' } as const;

const hex4 = (n: number) => n.toString(16).toUpperCase().padStart(4, '0');

/**
 * The tool's arguments for a device: that device by its USB ids, and on
 * Windows what to record — everything (`--record`), only some steps
 * (`--steps deep,macro,specific`), or the report alone (`--no-record`).
 */
export function reportToolArgs(
  d: Pick<DeviceDescriptor, 'vid' | 'pid'>,
  plan: RecordingPlan,
  os: ReportToolOs,
): string[] {
  const args = ['--device', `${hex4(d.vid)}:${hex4(d.pid)}`];
  if (os !== 'win32') return args;
  if (plan === 'report') return [...args, '--no-record'];
  if (plan === 'all') return [...args, '--record'];
  const steps = (plan === 'specific' ? ['specific'] : plan).filter((w) => /^[a-z]+$/.test(w));
  return [...args, '--record', '--steps', steps.join(',')];
}

/** Where the tools are: beside the app's resources, or in the repository's tools/ when unpackaged. */
export function reportToolPath(os: ReportToolOs): string {
  const name = os === 'win32' ? TOOL.win32 : TOOL.unix;
  return app.isPackaged
    ? join(process.resourcesPath, 'tools', name)
    : join(app.getAppPath(), '..', 'tools', name);
}

/** The terminals tried on Linux, in order, and how each is told what to run. */
export const LINUX_TERMINALS: [string, string][] = [
  ['x-terminal-emulator', '-e'],
  ['gnome-terminal', '--'],
  ['konsole', '-e'],
  ['xfce4-terminal', '-x'],
  ['xterm', '-e'],
];

/** The report tool in a shell that waits for Enter at the end, so its last words stay on screen. */
export function unixToolCommand(tool: string, args: string[]): string[] {
  return [
    '/bin/sh',
    '-c',
    '/bin/sh "$0" "$@"; printf "\\n  Press Enter to close this window. "; read _',
    tool,
    ...args,
  ];
}

const onPath = (name: string) =>
  (process.env['PATH'] ?? '').split(delimiter).some((dir) => dir && existsSync(join(dir, name)));

export interface ReportToolResult {
  ok: boolean;
  error?: string;
  /** Windows: the app closes itself next, so only the official software talks to the device. */
  quitting?: boolean;
}

export async function openReportTool(deviceId: string): Promise<ReportToolResult> {
  const d = deviceManager.getDescriptor(deviceId);
  if (!d) return { ok: false, error: 'This device is not connected.' };
  if (d.simulated) return { ok: false, error: 'A demo device has nothing to record.' };
  const plan = supportPlan(d);
  if (!plan) return { ok: false, error: 'Shark Deck has nothing to ask about this device.' };
  const os = process.platform;
  if (os !== 'win32' && os !== 'darwin' && os !== 'linux') {
    return { ok: false, error: `No device report tool for ${os}.` };
  }
  const tool = reportToolPath(os);
  if (!existsSync(tool))
    return { ok: false, error: `The device report tool is missing (${tool}).` };
  const args = reportToolArgs(d, plan.record, os);
  try {
    if (os === 'win32') {
      // Its own console window: the tool asks its questions there, then opens
      // its recording window. Every word but the path is a fixed one.
      spawn(`"${tool}" ${args.join(' ')}`, [], {
        shell: true,
        detached: true,
        stdio: 'ignore',
        windowsHide: false,
      }).unref();
      return { ok: true, quitting: true };
    }
    const run = unixToolCommand(tool, args);
    if (os === 'darwin') {
      // A .command file opens in Terminal and runs; no permission to drive Terminal needed.
      const file = join(tmpdir(), 'SharkDeck-device-report.command');
      const quoted = run.map((a) => `'${a.replace(/'/g, `'\\''`)}'`).join(' ');
      await fs.writeFile(file, `#!/bin/sh\nexec ${quoted}\n`, { mode: 0o755 });
      spawn('open', [file], { detached: true, stdio: 'ignore' }).unref();
      return { ok: true };
    }
    const term = LINUX_TERMINALS.find(([name]) => onPath(name));
    if (!term) return { ok: false, error: 'No terminal program was found to run it in.' };
    spawn(term[0], [term[1], ...run], { detached: true, stdio: 'ignore' }).unref();
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String((e as Error)?.message ?? e) };
  }
}
