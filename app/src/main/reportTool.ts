import { spawn } from 'node:child_process';
import { existsSync, promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, delimiter, join } from 'node:path';
import { app } from 'electron';
import type { DeviceDescriptor, RecordingPlan } from '@shared/types/device';
import type { ReportTarget, UsbHidDevice } from '@shared/types/diagnostics';
import { deviceManager } from './devices/manager';
import { supportPlan } from './devices/support';
import { enumerate, type HidCandidate } from './hid/transport';

/**
 * Starting the device report tool for one device, from its "Help add it" /
 * "Help complete its support" invitation (renderer SupportInvite).
 *
 * The tools ship with the app (electron-builder.yml): on Windows
 * `SharkDeck-device-report.bat`, on macOS and Linux
 * `sharkdeck-device-report.sh`. Both record the official software where they
 * can — Windows with USBPcap, Linux with the kernel's USB monitor, the
 * software then in a Windows virtual machine or Wine — and macOS makes the
 * report alone. A demo device opens the tool on the steps the real device's
 * owner would walk, recording nothing. The command line comes from the
 * catalogue — the device's USB ids and what it still lacks — never from the
 * renderer, which only names the device.
 */

export type ReportToolOs = 'win32' | 'darwin' | 'linux';

const TOOL = { win32: 'SharkDeck-device-report.bat', unix: 'sharkdeck-device-report.sh' } as const;

const hex4 = (n: number) => n.toString(16).toUpperCase().padStart(4, '0');

/** The step words of a plan: plain words only, never empty. */
function stepWords(plan: 'specific' | string[]): string {
  const words = (plan === 'specific' ? ['specific'] : plan).filter((w) => /^[a-z]+$/.test(w));
  return (words.length ? words : ['specific']).join(',');
}

/**
 * The tool's arguments for a device: that device by its USB ids, and on
 * Windows and Linux what to record — everything (`--record`), only some steps
 * (`--steps deep,macro,specific`), or the report alone (`--no-record`). macOS
 * has nothing to record with: the report alone.
 */
export function reportToolArgs(
  d: Pick<DeviceDescriptor, 'vid' | 'pid' | 'kind'>,
  plan: RecordingPlan,
  os: ReportToolOs,
): string[] {
  const args = ['--device', `${hex4(d.vid)}:${hex4(d.pid)}`];
  if (os === 'darwin') return args;
  if (plan === 'report') return [...args, '--no-record'];
  // What it is, so the recording does not ask: Shark Deck knows.
  const rec = [...args, '--record', '--kind', d.kind === 'keyboard' ? 'keyboard' : 'mouse'];
  return plan === 'all' ? rec : [...rec, '--steps', stepWords(plan)];
}

/**
 * A demo device's: the steps its real owner would be asked for, walked
 * without a device and without recording (`--preview-steps`). Null for a
 * plan that is a report: a report of a demo device reads nothing.
 */
export function previewArgs(kind: DeviceDescriptor['kind'], plan: RecordingPlan): string[] | null {
  if (plan === 'report') return null;
  const args = ['--preview-steps', kind === 'keyboard' ? 'keyboard' : 'mouse'];
  return plan === 'all' ? args : [...args, '--steps', stepWords(plan)];
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

/**
 * A copy of the tool where it outlives the app: Shark Deck closes before a
 * recording, and the files of an AppImage (unmounted) or a portable build
 * (unpacked to a temporary folder) go with it, mid-recording. In a folder of
 * its own (mode 700): a fixed name in a shared /tmp is one another user could
 * put there first, for a script that asks for sudo.
 */
async function staged(tool: string): Promise<string> {
  try {
    const dir = await fs.mkdtemp(join(tmpdir(), 'sharkdeck-report-'));
    const copy = join(dir, basename(tool));
    await fs.copyFile(tool, copy);
    return copy;
  } catch {
    return tool;
  }
}

const onPath = (name: string) =>
  (process.env['PATH'] ?? '').split(delimiter).some((dir) => dir && existsSync(join(dir, name)));

export interface ReportToolResult {
  ok: boolean;
  error?: string;
  /** The app closes itself next, so only the official software talks to the device. */
  quitting?: boolean;
  /** A demo device: the tool shows its steps and records nothing. */
  preview?: boolean;
}

export async function openReportTool(deviceId: string): Promise<ReportToolResult> {
  const d = deviceManager.getDescriptor(deviceId);
  if (!d) return { ok: false, error: 'This device is not connected.' };
  const plan = supportPlan(d);
  if (!plan) return { ok: false, error: 'Shark Deck has nothing to ask about this device.' };
  const os = process.platform;
  if (os !== 'win32' && os !== 'darwin' && os !== 'linux') {
    return { ok: false, error: `No device report tool for ${os}.` };
  }
  let args: string[];
  let preview = false;
  if (d.simulated) {
    const steps = previewArgs(d.kind, plan.record);
    if (!steps) return { ok: false, error: 'A demo device has no report to make.' };
    args = steps;
    preview = true;
  } else {
    args = reportToolArgs(d, plan.record, os);
  }
  return launchTool(os, args, preview);
}

/**
 * The tool for a device Shark Deck does not list, by its USB ids (Settings,
 * "Missing a device?"): all of it recorded where the tool records, the
 * report alone on macOS. Named by its ids, the tool finds it without the
 * unplugging a device of an unknown brand otherwise needs, and on Linux and
 * macOS at all (their tool lists only the families Shark Deck knows).
 */
export async function openReportToolFor(target: ReportTarget): Promise<ReportToolResult> {
  const os = process.platform;
  if (os !== 'win32' && os !== 'darwin' && os !== 'linux') {
    return { ok: false, error: `No device report tool for ${os}.` };
  }
  const ok = (n: unknown) => Number.isInteger(n) && (n as number) > 0 && (n as number) <= 0xffff;
  if (!ok(target?.vid) || !ok(target?.pid)) return { ok: false, error: 'Not a USB id.' };
  const kind = target.kind === 'keyboard' ? 'keyboard' : 'mouse';
  return launchTool(
    os,
    reportToolArgs({ vid: target.vid, pid: target.pid, kind }, 'all', os),
    false,
  );
}

/**
 * The USB devices plugged in, one per USB id, from what the system lists
 * (nothing is opened or sent): its names, whether it has a keyboard
 * (0001:0006) or a mouse (0001:0002) collection, and whether Shark Deck
 * shows it already. Keyboards and mice first, the listed ones last.
 */
export function usbHidSummaries(
  all: HidCandidate[],
  listed: (vid: number, pid: number) => boolean,
): UsbHidDevice[] {
  const by = new Map<string, UsbHidDevice>();
  for (const c of all) {
    if (!c.vendorId || !c.productId) continue;
    const key = `${c.vendorId}:${c.productId}`;
    const was = by.get(key);
    const kind: UsbHidDevice['kind'] =
      c.usagePage === 1 && c.usage === 6
        ? 'keyboard'
        : c.usagePage === 1 && c.usage === 2
          ? 'mouse'
          : 'other';
    const d: UsbHidDevice = was ?? {
      vid: c.vendorId,
      pid: c.productId,
      kind,
      listed: listed(c.vendorId, c.productId),
    };
    // A board shows a mouse collection too (its knob, its mouse keys): a
    // keyboard collection decides.
    if (kind === 'keyboard' || (kind === 'mouse' && d.kind === 'other')) d.kind = kind;
    d.product ||= c.product?.trim() || undefined;
    d.manufacturer ||= c.manufacturer?.trim() || undefined;
    by.set(key, d);
  }
  const rank = (d: UsbHidDevice) => (d.listed ? 2 : 0) + (d.kind === 'other' ? 1 : 0);
  return [...by.values()].sort(
    (a, b) =>
      rank(a) - rank(b) ||
      (a.product ?? '').localeCompare(b.product ?? '') ||
      a.vid - b.vid ||
      a.pid - b.pid,
  );
}

export async function listUsbHidDevices(): Promise<UsbHidDevice[]> {
  const shown = new Set(
    deviceManager
      .list()
      .filter((d) => !d.simulated)
      .map((d) => `${d.vid}:${d.pid}`),
  );
  return usbHidSummaries(await enumerate(), (vid, pid) => shown.has(`${vid}:${pid}`));
}

/** Starts the tool with these arguments; Shark Deck closes once it is up where the tool needs the device to itself. */
async function launchTool(
  os: ReportToolOs,
  args: string[],
  preview: boolean,
): Promise<ReportToolResult> {
  // The tool wants the device to itself: Shark Deck closes once it is up — on
  // Windows always (its report asks some families their model), on Linux for
  // a recording (its report only reads /sys).
  const quitting = !preview && (os === 'win32' || args.includes('--record'));
  const shipped = reportToolPath(os);
  if (!existsSync(shipped))
    return { ok: false, error: `The device report tool is missing (${shipped}).` };
  try {
    const tool = await staged(shipped);
    if (os === 'win32') {
      // Its own console window: the tool asks its questions there, then opens
      // its recording window. Every word but the path is a fixed one.
      spawn(`"${tool}" ${args.join(' ')}`, [], {
        shell: true,
        detached: true,
        stdio: 'ignore',
        windowsHide: false,
      }).unref();
      return { ok: true, quitting, preview };
    }
    const run = unixToolCommand(tool, args);
    if (os === 'darwin') {
      // A .command file opens in Terminal and runs; no permission to drive Terminal needed.
      const file = join(tmpdir(), 'SharkDeck-device-report.command');
      const quoted = run.map((a) => `'${a.replace(/'/g, `'\\''`)}'`).join(' ');
      await fs.writeFile(file, `#!/bin/sh\nexec ${quoted}\n`, { mode: 0o755 });
      spawn('open', [file], { detached: true, stdio: 'ignore' }).unref();
      return { ok: true, preview };
    }
    const term = LINUX_TERMINALS.find(([name]) => onPath(name));
    if (!term) return { ok: false, error: 'No terminal program was found to run it in.' };
    spawn(term[0], [term[1], ...run], { detached: true, stdio: 'ignore' }).unref();
    return { ok: true, quitting, preview };
  } catch (e) {
    return { ok: false, error: String((e as Error)?.message ?? e) };
  }
}
