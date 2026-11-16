/**
 * A recording's transfers, read as HID: which report went which way, on
 * which interface, with which id. Everything else on the control pipe
 * (descriptors, SET_IDLE, configuration) is kept apart as plain USB requests.
 */
import { parseReportDescriptor, type HidDescriptorInfo } from './hidDescriptor';
import { DeviceTable, type Transfer, type UsbDevice } from './usbpcap';

export type HidKind =
  | 'set-feature'
  | 'get-feature'
  | 'set-output'
  | 'get-input'
  | 'set-input'
  | 'get-output'
  | 'output'
  | 'input';

export interface HidMessage {
  /** µs: when it was sent, or (input reports) when it arrived. */
  t: number;
  /** For a GET: when the answer came back. */
  done: number | null;
  device: string;
  iface: number;
  kind: HidKind;
  /** Host to device. A GET is host to device too: its answer is `data`. */
  out: boolean;
  reportId: number;
  /** As it travelled: report id first when the interface numbers its reports. */
  data: Uint8Array;
  /** The transfer failed (stalled, cancelled). */
  failed: boolean;
}

export interface UsbRequest {
  t: number;
  device: string;
  setup: NonNullable<Transfer['setup']>;
  data: Uint8Array;
  failed: boolean;
}

const REPORT_TYPES = ['', 'input', 'output', 'feature'] as const;

export interface HidRecording {
  devices: DeviceTable;
  messages: HidMessage[];
  requests: UsbRequest[];
  /** Parsed report descriptors, by `${device id}/${interface}`. */
  descriptors: Map<string, HidDescriptorInfo>;
  /** The keys of `descriptors` that stand in for a missing report descriptor:
   *  the layout Windows gave the report tool. */
  fromWindows: Set<string>;
}

/**
 * `layouts`, by `${device id}/${interface}`: what Windows told the report tool
 * about each interface's reports. A recording made where the device was
 * plugged in has no report descriptors, and is read with these instead.
 */
export function readHid(
  transfers: Transfer[],
  layouts?: Map<string, HidDescriptorInfo>,
): HidRecording {
  const devices = new DeviceTable(transfers);
  const descriptors = new Map<string, HidDescriptorInfo>();
  const fromWindows = new Set<string>();
  for (const d of devices.all) {
    for (const [iface, raw] of d.reportDescriptors)
      descriptors.set(`${d.id}/${iface}`, parseReportDescriptor(raw));
  }
  for (const [key, info] of layouts ?? [])
    if (!descriptors.has(key)) {
      descriptors.set(key, info);
      fromWindows.add(key);
    }
  const numbered = (d: UsbDevice, iface: number) =>
    descriptors.get(`${d.id}/${iface}`)?.numbered ?? false;

  const messages: HidMessage[] = [];
  const requests: UsbRequest[] = [];
  for (const t of transfers) {
    const device = devices.at(t.bus, t.dev, t.t);
    const id = device?.id ?? `bus ${t.bus} address ${t.dev}`;
    const failed = t.status !== null && t.status !== 0;
    if (t.kind === 'control' && t.setup) {
      const s = t.setup;
      const classInterface = (s.requestType & 0x7f) === 0x21;
      if (classInterface && (s.request === 0x09 || s.request === 0x01)) {
        const type = REPORT_TYPES[s.value >> 8] ?? '';
        if (type) {
          const set = s.request === 0x09;
          messages.push({
            t: t.t,
            done: t.done,
            device: id,
            iface: s.index & 0xff,
            kind: `${set ? 'set' : 'get'}-${type}` as HidKind,
            out: true,
            reportId: s.value & 0xff,
            data: t.data,
            failed,
          });
          continue;
        }
      }
      requests.push({ t: t.t, device: id, setup: s, data: t.data, failed });
      continue;
    }
    if (t.kind !== 'interrupt' || !device) continue;
    const iface = devices.interfaceOf(device, t.ep) ?? -1;
    messages.push({
      t: t.t,
      done: t.done,
      device: id,
      iface,
      kind: t.in ? 'input' : 'output',
      out: !t.in,
      reportId: numbered(device, iface) && t.data.length ? t.data[0]! : 0,
      data: t.data,
      failed,
    });
  }
  return { devices, messages, requests, descriptors, fromWindows };
}

/** Bytes as hex, the trailing zeros of a padded report folded away. */
export function hexOf(data: Uint8Array, fold = true): string {
  let end = data.length;
  if (fold) while (end > 0 && data[end - 1] === 0) end--;
  const shown = Array.from(data.subarray(0, end), (b) => b.toString(16).padStart(2, '0')).join(' ');
  if (end === data.length) return shown;
  return `${shown}${shown ? ' ' : ''}(+${data.length - end} × 00)`;
}

/** What a message is for the eye: "set-feature if2 #0 64 B". */
export function messageLabel(m: HidMessage): string {
  return `${m.kind} if${m.iface} #${m.reportId} ${m.data.length} B`;
}
