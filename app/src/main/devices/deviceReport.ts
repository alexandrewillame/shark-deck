import type { DeviceDescriptor } from '@shared/types/device';
import { knownVendorIds, resolveDescriptor } from './registry';
import { resolveIdentity } from './identity';
import { list, type Recording } from './capture/dossier';
import { parseReportDescriptor, usageName, type ReportType } from './capture/hidDescriptor';

/**
 * Reading back a report from tools/SharkDeck-device-report.bat — what an
 * owner of an unsupported device sends — through the same registry and
 * identity code the app runs, so the answer to "can this be added, and where?"
 * is the app's own, not a guess. `npm run device-report -- <file>` prints it.
 *
 * The .bat writes a readable summary, then a marker line, then the JSON this
 * reads (the marker and the shape are the .bat's; device-report-tool.test.ts
 * pins the two together).
 */

export const REPORT_MARKER =
  '----- For the Shark Deck maintainer: keep everything below exactly as it is -----';

export interface ReportInterface {
  interface: number | null;
  usagePage: string;
  usage: string;
  kind: string;
  inputBytes: number;
  outputBytes: number;
  featureBytes: number;
  /** The interface's report ids per direction (0: it does not number them). */
  inputIds?: number[] | number;
  outputIds?: number[] | number;
  featureIds?: number[] | number;
}

export interface ReportDevice {
  vid: string;
  pid: string;
  release: string;
  product: string | null;
  /** Windows' report names the family; the Linux / macOS one does not. */
  family?: string;
  interfaces: ReportInterface[];
  identify: {
    asked: boolean;
    reply?: string | null;
    why?: string;
    modelId?: number;
    firmware?: string;
    cid?: number;
    mid?: number;
    link?: number;
  } | null;
}

export interface DeviceReport {
  tool: string;
  version: number;
  /** "linux" or "macos" from tools/sharkdeck-device-report.sh; absent from Windows' .bat. */
  platform?: string;
  model: string;
  devices: ReportDevice[];
  /** Present when the owner also recorded the official software (tool version 2). */
  recording?: Recording;
}

/** What the Linux / macOS script reports of an interface: its raw report descriptor. */
interface RawInterface {
  interface: number | null;
  transport?: string;
  reportDescriptor: string;
}

const hex4 = (n: number) => n.toString(16).toUpperCase().padStart(4, '0');

/**
 * An interface's report descriptor, laid out the way Windows reports it: one
 * entry per top-level collection, its sizes counting the report-id byte
 * (Windows' `InputReportByteLength`), so the rest of the reader and the
 * dossier treat a Linux or macOS report like the .bat's.
 */
export function interfacesFromDescriptor(raw: RawInterface): ReportInterface[] {
  const bytes = Uint8Array.from(
    (raw.reportDescriptor.match(/[0-9a-f]{2}/gi) ?? []).map((h) => parseInt(h, 16)),
  );
  const info = parseReportDescriptor(bytes);
  return info.collections.map((c) => {
    const of = (type: ReportType) =>
      info.reports.filter(
        (r) => r.type === type && r.usagePage === c.usagePage && r.usage === c.usage,
      );
    const size = (type: ReportType) => {
      const rs = of(type);
      return rs.length ? Math.max(...rs.map((r) => r.bytes)) + 1 : 0;
    };
    return {
      interface: raw.interface,
      usagePage: hex4(c.usagePage),
      usage: hex4(c.usage),
      kind: usageName(c.usagePage, c.usage),
      inputBytes: size('input'),
      outputBytes: size('output'),
      featureBytes: size('feature'),
      inputIds: of('input').map((r) => r.id),
      outputIds: of('output').map((r) => r.id),
      featureIds: of('feature').map((r) => r.id),
    };
  });
}

/** The JSON half of a report file. */
export function parseDeviceReport(text: string): DeviceReport {
  const at = text.indexOf(REPORT_MARKER);
  if (at < 0)
    throw new Error('not a Shark Deck device report: the maintainer marker line is missing');
  const report = JSON.parse(text.slice(at + REPORT_MARKER.length)) as DeviceReport;
  if (report.tool !== 'SharkDeck-device-report')
    throw new Error(`not a device report: tool "${report.tool}"`);
  // PowerShell 5 writes a one-element array as the element itself.
  report.devices = list(report.devices);
  for (const d of report.devices) {
    d.interfaces = list(d.interfaces as (ReportInterface | RawInterface)[]).flatMap((i) =>
      'reportDescriptor' in i && !('usagePage' in i) ? interfacesFromDescriptor(i) : [i],
    ) as ReportInterface[];
  }
  if (report.recording) report.recording.steps = list(report.recording.steps);
  return report;
}

const named = (d: DeviceDescriptor) =>
  `${d.displayName}${d.identityNote ? ` (${d.identityNote})` : ''}`;

/**
 * What the app makes of one reported device, and what adding it would take.
 * `recorded`: the report comes with a recording of the official software.
 */
export function triageDevice(dev: ReportDevice, recorded = false): string[] {
  const protocolFrom = recorded
    ? 'Its recording is what the driver is written from: read the dossier (npm run device-report on the .zip).'
    : 'That needs a recording of the official software first: the report tool offers one, with USBPcap.';
  const vid = parseInt(dev.vid, 16);
  const pid = parseInt(dev.pid, 16);
  const id = `${dev.vid}:${dev.pid}${dev.product ? ` "${dev.product}"` : ''}`;
  const endpoint = { vid, pid };
  const first = resolveDescriptor(vid, pid);

  if (!first) {
    if (knownVendorIds().includes(vid)) {
      return [
        `${id}: a family Shark Deck knows, but a product id no catalogue lists.`,
        'Beken: name it in catalog/beken-mice.ts (shown, never driven). JXC: catalog/jxc-mice.ts MODELS.',
      ];
    }
    const vendor = dev.interfaces.filter((i) => parseInt(i.usagePage, 16) >= 0xff00);
    return [
      `${id}: a family Shark Deck does not know — no protocol for it yet.`,
      vendor.length
        ? `Settings interfaces: ${vendor.map((i) => `${i.usagePage}:${i.usage} (in ${i.inputBytes} / out ${i.outputBytes} / feature ${i.featureBytes} bytes)`).join(', ')}.`
        : 'It reports no vendor (settings) interface at all: it may have no configuration.',
      `Driving it needs its protocol, then a new driver. ${protocolFrom}`,
    ];
  }

  if (first.identity !== 'pending') {
    // JXC and Beken: the product id is the identity.
    if (first.driver === 'no-io') {
      return [
        `${id}: ${named(first)} — shown, not driven.`,
        first.vid === 0x1d57
          ? `Beken: driving it needs the protocol confirmed on Windows (docs/protocol/mouse-beken.md). ${protocolFrom}`
          : 'Its table names it read-only; add it as a model only once it is confirmed as Attack Shark’s.',
      ];
    }
    return [`${id}: already supported — ${first.displayName} (${first.model}).`];
  }

  const ask = dev.identify;
  let d: DeviceDescriptor | null = null;
  if (ask?.modelId !== undefined)
    d = resolveIdentity(endpoint, { family: 'royuan', modelId: ask.modelId });
  else if (ask?.mid !== undefined && ask.cid !== undefined && ask.link !== undefined) {
    d = resolveIdentity(endpoint, {
      family: 'compx-hub',
      cid: ask.cid,
      mid: ask.mid,
      link: ask.link,
    });
  }
  if (!d) {
    return [
      `${id}: ${first.model === 'royuan' ? 'ROYUAN' : 'Compx Hub'} family, but no model answer in the report${ask?.why ? ` (${ask.why.replace(/\.$/, '')})` : ''}.`,
      'Ask for a report with the device answering (by cable for a relaying receiver; the mouse awake).',
    ];
  }
  const answer =
    ask?.modelId !== undefined
      ? `model id ${ask.modelId}${ask.firmware ? `, firmware ${ask.firmware}` : ''}`
      : `cid ${ask?.cid}, mid ${ask?.mid}, link ${ask?.link}`;
  // Absent on a hand-written catalogue entry, and meaning `exact` there.
  switch (d.identity ?? 'exact') {
    case 'exact':
      return [`${id} (${answer}): already supported — ${d.displayName} (${d.model}).`];
    case 'class':
      return [
        `${id} (${answer}): an Attack Shark Hub mouse whose mid is not named — driven by its sensor class as "${d.displayName}".`,
        `Name it: catalog/hub-mice.ts NAMED[${ask?.mid}] (and HUB_MID_CLASS / HUB_CANDIDATES for its photos).`,
      ];
    case 'unsupported':
      return [
        `${id} (${answer}): ${named(d)} — an Attack Shark model on a command set no driver speaks.`,
        'Needs that command set first (protocol notes, then a driver).',
      ];
    case 'foreign':
      return [`${id} (${answer}): another brand's device — ${named(d)}. Nothing to add.`];
    default:
      return [
        `${id} (${answer}): a model id no table knows.`,
        ask?.modelId !== undefined
          ? 'Refresh the vendor registry (`npm run import:kb`); a board still missing is new — add it through catalog/keyboard-resolutions.ts, or catalog/gearhub-mice.ts for a mouse.'
          : 'Check the cid: 124 is Attack Shark.',
      ];
  }
}

/** The whole report, as the lines `npm run device-report` prints. */
export function triageReport(report: DeviceReport): string[] {
  const lines = [
    `Device report, tool version ${report.version}${report.model ? ` — the owner calls it "${report.model}"` : ''}:`,
    ...report.devices.flatMap((d) => ['', ...triageDevice(d, !!report.recording)]),
  ];
  const rec = report.recording;
  if (rec) {
    const done = rec.steps.filter((s) => s.status === 'done').length;
    lines.push(
      '',
      `With a recording of the official software (${rec.kind}): ${done} of ${rec.steps.length} steps done` +
        `${rec.software?.process ? `, in ${rec.software.process}` : ''}. Read its dossier to write the driver.`,
    );
  }
  return lines;
}
