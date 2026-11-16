/**
 * A recording from tools/SharkDeck-device-report.bat, written out as the
 * dossier a driver is built from: the device's descriptors, what the official
 * software sent and got back at each step, what it polls on its own, and the
 * encodings and checksums the steps with known values point to.
 */
import type { ReportDevice } from '../deviceReport';
import { analyzeSeries, findChecksums, type SeriesPoint } from './fields';
import { usageName, type HidDescriptorInfo, type ReportType } from './hidDescriptor';
import {
  hexOf,
  messageLabel,
  readHid,
  type HidMessage,
  type HidRecording,
  type UsbRequest,
} from './hidMessages';
import { readPcap, transfersOf } from './usbpcap';

export interface RecordingStep {
  id: string;
  group: string;
  text: string;
  value: string;
  series: string;
  /** done, not-offered (not in the software) or skipped. */
  status: string;
  attempt: number;
  note: string;
  start: string;
  end: string;
  shots: string[];
}

export interface Recording {
  version: number;
  kind: string;
  usbpcap: string;
  started: string;
  ended: string;
  finishedAllSteps: boolean;
  /** Recorded where it was plugged in (USBPcap `--devices` +
   *  `--inject-descriptors`): its device and configuration descriptors are
   *  in the capture, its report descriptors and names are not. */
  inPlace?: boolean;
  devices: string[];
  software: Record<string, string | null>;
  kept: {
    messages: number;
    otherDevices: number;
    keyPressesBlanked: number;
    mouseMovesLeftOut: number;
    serialNumbersBlanked: number;
    /** Messages from a device that never sent its descriptor, left out. */
    unidentified?: number;
    seen: string[];
  };
  steps: RecordingStep[];
}

/** PowerShell 5 writes a one-element array as the element itself. */
export const list = <T>(x: T | T[] | null | undefined): T[] =>
  x == null ? [] : Array.isArray(x) ? x : [x];

const micros = (iso: string) => Date.parse(iso) * 1000;
const clock = (t: number) => new Date(t / 1000).toISOString().slice(11, 23);
const seconds = (us: number) => `${us < 0 ? '−' : '+'}${(Math.abs(us) / 1e6).toFixed(3)} s`;

const IDLE_STEPS = new Set(['start.idle', 'wl.idle']);

function signature(m: HidMessage): string {
  return `${m.device}|${m.kind}|${m.iface}|${m.reportId}|${hexOf(m.data, false)}`;
}

/**
 * What the software does on its own: every message seen while the owner was
 * told to touch nothing. A later copy is background too, unless it answers
 * something that is not (a read right after a new write stays in view).
 */
function backgroundOf(messages: HidMessage[], steps: RecordingStep[]): Set<HidMessage> {
  const quiet = new Set<string>();
  for (const s of steps) {
    if (!IDLE_STEPS.has(s.id) || s.status !== 'done') continue;
    const from = micros(s.start);
    const to = micros(s.end);
    for (const m of messages) if (m.t >= from && m.t <= to) quiet.add(signature(m));
  }
  const background = new Set<HidMessage>();
  const lastSent = new Map<string, { t: number; background: boolean }>();
  for (const m of messages) {
    const where = `${m.device}|${m.iface}`;
    const sends = m.kind.startsWith('set-') || m.kind === 'output';
    let isBackground = quiet.has(signature(m));
    if (!sends && isBackground) {
      const last = lastSent.get(where);
      if (last && !last.background && m.t - last.t < 500_000) isBackground = false;
    }
    if (sends) lastSent.set(where, { t: m.t, background: isBackground });
    if (isBackground) background.add(m);
  }
  return background;
}

function messageLine(m: HidMessage, from: number): string {
  const arrow = m.out ? (m.kind.startsWith('get-') ? '⇄' : '→') : '←';
  const answer = m.kind.startsWith('get-') ? ' answer' : '';
  return `- \`${seconds(m.t - from)}\` ${arrow} ${messageLabel(m)}${answer}${m.failed ? ' **failed**' : ''}: \`${hexOf(m.data)}\``;
}

const DESCRIPTOR_TYPES: Record<number, string> = {
  1: 'device',
  2: 'configuration',
  3: 'string',
  0x22: 'HID report',
};

function requestLine(r: UsbRequest, from: number): string {
  const s = r.setup;
  const kind = ['standard', 'class', 'vendor', 'reserved'][(s.requestType >> 5) & 3];
  const setup = [
    s.requestType,
    s.request,
    s.value & 0xff,
    s.value >> 8,
    s.index & 0xff,
    s.index >> 8,
    s.length & 0xff,
    s.length >> 8,
  ]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join(' ');
  return `- \`${seconds(r.t - from)}\` USB ${kind} request \`${setup}\`${r.failed ? ' **failed**' : ''}${r.data.length ? `: \`${hexOf(r.data)}\`` : ''}`;
}

/** Control requests worth reading: anything but descriptors and SET_IDLE. */
function notable(r: UsbRequest): boolean {
  const s = r.setup;
  if (s.request === 6 && (s.requestType & 0x7f) <= 1 && DESCRIPTOR_TYPES[s.value >> 8])
    return false;
  if (s.requestType === 0x21 && (s.request === 0x0a || s.request === 0x0b)) return false; // SET_IDLE, SET_PROTOCOL
  if (s.requestType === 0x00 && (s.request === 9 || s.request === 5)) return false; // SET_CONFIGURATION, SET_ADDRESS
  return true;
}

export interface DossierInput {
  model: string;
  recording: Recording;
  pcap: Uint8Array;
  /** Files present next to the recording (to flag pictures the owner deleted). */
  files?: Set<string>;
  /** The report's devices: the report layout Windows gave, which stands in for
   *  report descriptors a recording made in place does not have. */
  devices?: ReportDevice[];
}

/** What Windows told the report tool about each interface's reports, by
 *  `${device id}/${interface}`, in the shape of a parsed report descriptor. */
export function layoutsFromReport(devices: ReportDevice[]): Map<string, HidDescriptorInfo> {
  const out = new Map<string, HidDescriptorInfo>();
  for (const d of list(devices)) {
    const id = `${d.vid}:${d.pid}`.toUpperCase();
    for (const i of list(d.interfaces)) {
      if (i.interface === null || i.interface === undefined) continue;
      const key = `${id}/${i.interface}`;
      const info = out.get(key) ?? { collections: [], reports: [], numbered: false };
      const usagePage = parseInt(i.usagePage, 16);
      const usage = parseInt(i.usage, 16);
      info.collections.push({ usagePage, usage });
      const directions: [ReportType, number[] | number | undefined, number][] = [
        ['input', i.inputIds, i.inputBytes],
        ['output', i.outputIds, i.outputBytes],
        ['feature', i.featureIds, i.featureBytes],
      ];
      for (const [type, ids, bytes] of directions) {
        if (!bytes) continue;
        // Windows counts the report id byte in, numbered or not.
        for (const id of list(ids)) {
          info.reports.push({ type, id, bytes: bytes - 1, usagePage, usage });
          if (id) info.numbered = true;
        }
      }
      out.set(key, info);
    }
  }
  return out;
}

export function dossier(input: DossierInput): string {
  const rec = input.recording;
  const steps = list(rec.steps);
  const hid: HidRecording = readHid(
    transfersOf(readPcap(input.pcap)),
    layoutsFromReport(list(input.devices)),
  );
  // What was typed on a keyboard collection, blanked by the tool: counted, not listed.
  const blank = (m: HidMessage) => {
    if (m.kind !== 'input') return false;
    const info = hid.descriptors.get(`${m.device}/${m.iface}`);
    const r = info?.reports.find((x) => x.type === 'input' && x.id === m.reportId);
    if (!r || r.usagePage !== 1 || r.usage !== 6) return false;
    return m.data.subarray(info!.numbered ? 1 : 0).every((b) => b === 0);
  };
  const background = backgroundOf(
    hid.messages.filter((m) => !blank(m)),
    steps,
  );
  const out: string[] = [];
  const sw = rec.software ?? {};

  out.push(`# Recording: ${input.model || 'unnamed device'} (${rec.kind})`, '');
  out.push(
    `Recorded ${rec.started} to ${rec.ended} with USBPcap ${rec.usbpcap}. ` +
      `${steps.filter((s) => s.status === 'done').length} steps done, ` +
      `${steps.filter((s) => s.status === 'not-offered').length} not in the software, ` +
      `${steps.filter((s) => s.status === 'skipped').length} skipped` +
      `${rec.finishedAllSteps ? '' : ', **the owner stopped before the last step**'}.`,
  );
  if (sw.process) {
    out.push(
      `Official software: ${sw.process}${sw.product ? `: ${sw.product} ${sw.version ?? ''}` : ''}` +
        `${sw.company ? `, ${sw.company}` : ''}${sw.file ? ` (${sw.folder ?? ''}\\${sw.file}${sw.sha256 ? `, SHA-256 ${sw.sha256}` : ''})` : ''}.`,
    );
  } else out.push('No picture of the official software: its window was never picked.');
  if (rec.inPlace)
    out.push(
      'Recorded where it was plugged in, without unplugging it: USBPcap wrote in its device and ' +
        'configuration descriptors, but its report descriptors and names are not in the capture. ' +
        'report.txt has the report layout Windows gave.',
    );
  const k = rec.kept;
  out.push(
    `The tool kept ${k.messages} USB records from ${list(k.seen).join(', ') || 'no device'}; ` +
      `${k.keyPressesBlanked} key presses blanked, ${k.mouseMovesLeftOut} mouse movements left out, ` +
      `${k.serialNumbersBlanked} serial numbers blanked` +
      `${k.unidentified ? `; ${k.unidentified} messages from a device that never named itself were left out` : ''}. ` +
      `This file read ${hid.messages.length} HID messages.`,
    '',
  );

  // ---- Devices
  out.push('## Devices', '');
  for (const d of hid.devices.all) {
    const name = d.strings.get(d.iProduct);
    const maker = d.strings.get(d.iManufacturer);
    out.push(
      `### ${d.id}${name ? ` "${name}"` : ''}${maker ? ` by "${maker}"` : ''}`,
      '',
      `Release ${(d.release >> 8).toString(16)}.${(d.release & 0xff).toString(16).padStart(2, '0')}, ` +
        `USB ${(d.usb >> 8).toString(16)}.${(d.usb & 0xff).toString(16).padStart(2, '0')}, ` +
        `bus ${d.bus} address ${d.address}, first seen ${clock(d.since)} UTC` +
        `${d.iSerial ? ', reports a serial number (blanked)' : ''}.`,
      '',
      '| Interface | Class / sub / protocol | Endpoints | Reports |',
      '|---|---|---|---|',
    );
    for (const i of d.interfaces) {
      const key = `${d.id}/${i.number}`;
      const info = hid.descriptors.get(key);
      const endpoints = i.endpoints
        .map(
          (e) =>
            `0x${e.address.toString(16).padStart(2, '0')} ${['control', 'isochronous', 'bulk', 'interrupt'][e.attributes & 3]} ${e.maxPacket} B every ${e.interval}`,
        )
        .join('; ');
      const reports = info
        ? info.reports
            .map((r) => `${r.type} #${r.id} ${r.bytes} B (${usageName(r.usagePage, r.usage)})`)
            .join('; ') + (hid.fromWindows.has(key) ? ' — as Windows gave them (report.txt)' : '')
        : i.class === 3
          ? '(report descriptor not in the recording)'
          : '';
      out.push(
        `| ${i.number}${i.alternate ? ` alt ${i.alternate}` : ''} | ${i.class} / ${i.subclass} / ${i.protocol} | ${endpoints} | ${reports} |`,
      );
    }
    out.push('');
    for (const [iface, raw] of d.reportDescriptors) {
      out.push(
        `Report descriptor, interface ${iface} (${raw.length} B): \`${hexOf(raw, false)}\``,
        '',
      );
    }
  }
  if (!hid.devices.all.length)
    out.push('No device descriptor in the recording: it was not plugged in while recording.', '');

  // ---- Background
  out.push('## What goes on by itself', '');
  const repeated = new Map<string, HidMessage[]>();
  for (const m of background)
    repeated.set(signature(m), [...(repeated.get(signature(m)) ?? []), m]);
  if (!repeated.size)
    out.push(
      'Nothing: the software was silent while left alone (or no "leave it alone" step was done).',
      '',
    );
  for (const group of [...repeated.values()].sort((a, b) => b.length - a.length).slice(0, 40)) {
    const m = group[0]!;
    const gaps = group
      .slice(1)
      .map((x, i) => x.t - group[i]!.t)
      .sort((a, b) => a - b);
    const every = gaps.length
      ? ` every ~${(gaps[Math.floor(gaps.length / 2)]! / 1e6).toFixed(2)} s`
      : '';
    out.push(
      `- ${m.out ? (m.kind.startsWith('get-') ? '⇄' : '→') : '←'} ${messageLabel(m)} ×${group.length}${every}: \`${hexOf(m.data)}\``,
    );
  }
  out.push('');

  // ---- Steps
  out.push('## Steps', '');
  out.push(
    '`→` sent to the device, `⇄` read from it (the bytes are its answer), `←` sent by the device on its own. Background messages are left out of each step.',
    '',
  );
  const firstStart = steps.length ? micros(steps[0]!.start) : Infinity;
  const before = hid.messages.filter((m) => m.t < firstStart && !background.has(m) && !blank(m));
  if (before.length) {
    out.push(`### Before the first step: plugging in (${before.length} messages)`, '');
    for (const m of before.slice(0, 200)) out.push(messageLine(m, before[0]!.t));
    if (before.length > 200) out.push(`- … ${before.length - 200} more`);
    out.push('');
  }
  for (const s of steps) {
    // A step the owner left with "Redo previous" before finishing it, and what
    // they sent putting a step back before doing it again.
    const left = s.status === 'left';
    const reverted = s.status === 'reverted';
    if (s.status !== 'done' && !left && !reverted) continue;
    const from = micros(s.start);
    const to = micros(s.end);
    const inStep = hid.messages.filter((m) => m.t >= from && m.t <= to);
    const shown = inStep.filter((m) => !background.has(m) && !blank(m));
    const quiet = inStep.filter((m) => background.has(m)).length;
    const typed = inStep.filter(blank).length;
    const requests = hid.requests.filter((r) => r.t >= from && r.t <= to && notable(r));
    if ((left || reverted) && !shown.length && !requests.length) continue;
    const pictures = list(s.shots).map((f) =>
      input.files && !input.files.has(f) ? `${f} (deleted by the owner)` : f,
    );
    out.push(
      `### ${s.id}${s.attempt ? ` #${s.attempt + 1}` : ''}${left ? ' (left for “Redo previous”)' : ''}${reverted ? ' (put back before doing it again)' : ''}: ${s.text}`,
      '',
      `${clock(from)}–${clock(to)} UTC${s.value ? `, value **${s.value}**` : ''}${s.note ? `, note: "${s.note}"` : ''}` +
        `${pictures.length ? `, pictures: ${pictures.join(', ')}` : ''}. ` +
        `${shown.length} message${shown.length === 1 ? '' : 's'}` +
        `${quiet ? ` (+${quiet} background)` : ''}` +
        `${typed ? `; ${typed} key report${typed === 1 ? '' : 's'} blanked (what was typed)` : ''}.`,
      '',
    );
    const timeline = [
      ...shown.map((m) => ({ t: m.t, line: messageLine(m, from) })),
      ...requests.map((r) => ({ t: r.t, line: requestLine(r, from) })),
    ].sort((a, b) => a.t - b.t);
    for (const x of timeline.slice(0, 400)) out.push(x.line);
    if (timeline.length > 400) out.push(`- … ${timeline.length - 400} more`);
    if (timeline.length) out.push('');
  }
  const notDone = steps.filter((s) => s.status === 'not-offered' || s.status === 'skipped');
  if (notDone.length) {
    out.push(
      `Not in the software or skipped: ${notDone.map((s) => `${s.id}${s.status === 'skipped' ? ' (skipped)' : ''}`).join(', ')}.`,
      '',
    );
  }

  // ---- Checksums first: the series below set their bytes apart.
  const byShape = new Map<string, Uint8Array[]>();
  for (const m of hid.messages) {
    const key = `${m.out && !m.kind.startsWith('get-') ? 'sent' : 'received'}: ${messageLabel(m)}`;
    byShape.set(key, [...(byShape.get(key) ?? []), m.data]);
  }
  const rules = new Map([...byShape].map(([key, frames]) => [key, findChecksums(frames)] as const));
  const sentChecksums = new Map<string, number[]>();
  for (const [key, found] of rules)
    if (key.startsWith('sent: ') && found.length) sentChecksums.set(key.slice(6), found[0]!.at);

  // ---- Series
  out.push('## Settings set to known values', '');
  const series = new Map<string, SeriesPoint[]>();
  for (const s of steps) {
    if (!s.series || s.status !== 'done') continue;
    const from = micros(s.start);
    const to = micros(s.end);
    const point: SeriesPoint = {
      step: s.id,
      value: s.value,
      note: s.note,
      messages: hid.messages.filter((m) => m.t >= from && m.t <= to && !background.has(m)),
    };
    series.set(s.series, [...(series.get(s.series) ?? []), point]);
  }
  for (const [name, points] of series) {
    if (points.length < 2) continue;
    out.push(
      `### ${name}: ${points.map((p) => p.value || '?').join(', ')}`,
      '',
      ...analyzeSeries(points, sentChecksums),
      '',
    );
  }
  if (![...series.values()].some((p) => p.length >= 2))
    out.push('No setting was set to two known values.', '');

  // ---- Checksums
  out.push('## Checksums', '');
  out.push('Bytes marked `*` in the tables above are the first rule of their shape.', '');
  let any = false;
  for (const [key, found] of rules) {
    if (!found.length) continue;
    any = true;
    out.push(
      `- ${key} (${byShape.get(key)!.length} frames): ${found.map((r) => r.text).join('; or ')}`,
    );
  }
  if (!any)
    out.push('- No checksum rule fits every frame of any shape (or too few different frames).');
  out.push('');
  return out.join('\n');
}
