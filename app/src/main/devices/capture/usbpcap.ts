/**
 * USB recordings as tools/SharkDeck-device-report.bat writes them: USBPcap's
 * pcap format (link type 249), one record per URB, its submit and its
 * completion apart, already narrowed to the recorded device by the tool.
 * Format: https://desowin.org/usbpcap/captureformat.html
 *
 * This file turns the records back into transfers (a control request with its
 * answer, an interrupt report) and the devices into their descriptors.
 */

export const LINKTYPE_USBPCAP = 249;

export type TransferType = 'isochronous' | 'interrupt' | 'control' | 'bulk' | 'other';

export interface UsbPacket {
  /** Microseconds since 1970-01-01 UTC. */
  t: number;
  /** The IRP that carried it: what pairs a submit with its completion. */
  irp: bigint;
  status: number;
  /** The URB function. */
  fn: number;
  /** A completion, on its way back from the device; false: a submit. */
  up: boolean;
  bus: number;
  dev: number;
  /** Endpoint address, direction bit included. */
  ep: number;
  transfer: TransferType;
  /** Control transfers: 0 setup (with any OUT data), 3 complete (with any IN data). */
  stage: number | null;
  data: Uint8Array;
}

const TRANSFER_TYPES: TransferType[] = ['isochronous', 'interrupt', 'control', 'bulk'];

/** Every record of a USBPcap file. A recording cut short mid-record loses only that record. */
export function readPcap(file: Uint8Array): UsbPacket[] {
  if (file.byteLength < 24) throw new Error('not a pcap file: too short');
  const v = new DataView(file.buffer, file.byteOffset, file.byteLength);
  const magic = v.getUint32(0, true);
  const formats: Record<number, [boolean, boolean]> = {
    0xa1b2c3d4: [true, false],
    0xa1b23c4d: [true, true],
    0xd4c3b2a1: [false, false],
    0x4d3cb2a1: [false, true],
  };
  const format = formats[magic];
  if (!format) throw new Error('not a classic pcap file (pcapng is not read here)');
  const [le, nano] = format;
  const link = v.getUint32(20, le);
  if (link === LINKTYPE_USB_LINUX_MMAPPED || link === LINKTYPE_USB_LINUX) {
    return readUsbmon(file, v, le, nano, link === LINKTYPE_USB_LINUX_MMAPPED ? 64 : 48);
  }
  if (link !== LINKTYPE_USBPCAP) throw new Error(`pcap link type ${link}, not USBPcap (249)`);

  const out: UsbPacket[] = [];
  for (let at = 24; at + 16 <= file.byteLength;) {
    const sec = v.getUint32(at, le);
    const frac = v.getUint32(at + 4, le);
    const incl = v.getUint32(at + 8, le);
    const start = at + 16;
    if (start + incl > file.byteLength) break;
    at = start + incl;
    if (incl < 27) continue;
    // The USBPcap header itself is always little-endian.
    const headerLength = v.getUint16(start, true);
    if (headerLength < 27 || headerLength > incl) continue;
    const transfer = file[start + 22]!;
    const dataLength = Math.min(v.getUint32(start + 23, true), incl - headerLength);
    out.push({
      t: sec * 1e6 + (nano ? Math.floor(frac / 1000) : frac),
      irp: v.getBigUint64(start + 2, true),
      status: v.getUint32(start + 10, true),
      fn: v.getUint16(start + 14, true),
      up: (file[start + 16]! & 1) === 1,
      bus: v.getUint16(start + 17, true),
      dev: v.getUint16(start + 19, true),
      ep: file[start + 21]!,
      transfer: TRANSFER_TYPES[transfer] ?? 'other',
      stage: transfer === 2 && headerLength >= 28 ? file[start + 27]! : null,
      data: file.subarray(start + headerLength, start + headerLength + dataLength),
    });
  }
  return out;
}

/** Linux's usbmon, as tcpdump writes it: tools/sharkdeck-device-report.sh's recordings. */
export const LINKTYPE_USB_LINUX = 189;
export const LINKTYPE_USB_LINUX_MMAPPED = 220;
const USBMON_TYPES: TransferType[] = ['isochronous', 'interrupt', 'control', 'bulk'];

/**
 * A usbmon capture's records as USBPcap's: `S` a submit, `C` a completion; a
 * control submit's setup packet (the header's, when its flag says it is
 * there) goes before its OUT data as stage 0, a control completion is
 * stage 3. The header is in the capturing machine's byte order, little-endian
 * on every machine the tool runs on.
 */
function readUsbmon(
  file: Uint8Array,
  v: DataView,
  le: boolean,
  nano: boolean,
  headerLength: number,
): UsbPacket[] {
  const out: UsbPacket[] = [];
  for (let at = 24; at + 16 <= file.byteLength;) {
    const sec = v.getUint32(at, le);
    const frac = v.getUint32(at + 4, le);
    const incl = v.getUint32(at + 8, le);
    const start = at + 16;
    if (start + incl > file.byteLength) break;
    at = start + incl;
    if (incl < headerLength) continue;
    const type = file[start + 8]!;
    const xfer = file[start + 9]!;
    const transfer = USBMON_TYPES[xfer] ?? 'other';
    const up = type !== 0x53; // 'S'
    const payload = file.subarray(start + headerLength, start + incl);
    const setupPresent = transfer === 'control' && !up && file[start + 14] === 0;
    out.push({
      t: sec * 1e6 + (nano ? Math.floor(frac / 1000) : frac),
      irp: v.getBigUint64(start, true),
      status: v.getInt32(start + 28, true),
      fn: 0,
      up,
      bus: v.getUint16(start + 12, true),
      dev: file[start + 11]!,
      ep: file[start + 10]!,
      transfer,
      stage: transfer === 'control' ? (up ? 3 : 0) : null,
      data: setupPresent ? concat(file.subarray(start + 40, start + 48), payload) : payload,
    });
  }
  return out;
}

export interface Setup {
  requestType: number;
  request: number;
  value: number;
  index: number;
  length: number;
}

export interface Transfer {
  kind: 'control' | 'interrupt' | 'bulk';
  /** When it happened, µs: the request for anything sent, the arrival for an input report. */
  t: number;
  /** When it completed; null if the recording ended first. */
  done: number | null;
  bus: number;
  dev: number;
  ep: number;
  setup: Setup | null;
  /** Device to host. */
  in: boolean;
  /** What was sent (host to device) or what came back (device to host). */
  data: Uint8Array;
  status: number | null;
}

const concat = (a: Uint8Array, b: Uint8Array) => {
  const c = new Uint8Array(a.length + b.length);
  c.set(a);
  c.set(b, a.length);
  return c;
};

/** Submits and completions paired into transfers, in time order. Isochronous traffic is left out. */
export function transfersOf(packets: UsbPacket[]): Transfer[] {
  const open = new Map<string, Transfer>();
  const out: Transfer[] = [];
  for (const p of packets) {
    if (p.transfer !== 'control' && p.transfer !== 'interrupt' && p.transfer !== 'bulk') continue;
    const key = `${p.bus}/${p.dev}/${p.irp}`;
    if (p.transfer === 'control') {
      if (!p.up && p.stage === 0 && p.data.length >= 8) {
        const d = p.data;
        const setup: Setup = {
          requestType: d[0]!,
          request: d[1]!,
          value: d[2]! | (d[3]! << 8),
          index: d[4]! | (d[5]! << 8),
          length: d[6]! | (d[7]! << 8),
        };
        const t: Transfer = {
          kind: 'control',
          t: p.t,
          done: null,
          bus: p.bus,
          dev: p.dev,
          ep: p.ep,
          setup,
          in: (setup.requestType & 0x80) !== 0,
          data: d.subarray(8),
          status: null,
        };
        open.set(key, t);
        out.push(t);
      } else if (p.up && p.stage === 3) {
        const t = open.get(key);
        if (!t) continue;
        open.delete(key);
        t.done = p.t;
        t.status = p.status;
        if (t.in) t.data = p.data;
      } else if (p.stage === 1 && p.data.length) {
        // Captures from USBPcap before 1.5 carried data in a stage of its own.
        const t = open.get(key);
        if (t) t.data = concat(t.data, p.data);
      }
      continue;
    }
    const isIn = (p.ep & 0x80) !== 0;
    if (!p.up) {
      const t: Transfer = {
        kind: p.transfer,
        t: p.t,
        done: null,
        bus: p.bus,
        dev: p.dev,
        ep: p.ep,
        setup: null,
        in: isIn,
        data: isIn ? new Uint8Array(0) : p.data,
        status: null,
      };
      open.set(key, t);
      if (!isIn) out.push(t);
      continue;
    }
    const t = open.get(key);
    if (t) {
      open.delete(key);
      t.done = p.t;
      t.status = p.status;
      if (!isIn) continue;
      t.t = p.t;
      t.data = p.data;
      if (p.status === 0 || p.data.length) out.push(t);
    } else if (isIn && (p.status === 0 || p.data.length)) {
      // The tool drops the empty submits of keyboard and mouse reads.
      out.push({
        kind: p.transfer,
        t: p.t,
        done: p.t,
        bus: p.bus,
        dev: p.dev,
        ep: p.ep,
        setup: null,
        in: true,
        data: p.data,
        status: p.status,
      });
    }
  }
  return out.sort((a, b) => a.t - b.t);
}

export interface EndpointInfo {
  address: number;
  attributes: number;
  maxPacket: number;
  interval: number;
}

export interface InterfaceInfo {
  number: number;
  alternate: number;
  class: number;
  subclass: number;
  protocol: number;
  endpoints: EndpointInfo[];
  /** From its HID descriptor. */
  reportDescriptorLength: number | null;
}

export interface UsbDevice {
  bus: number;
  address: number;
  /** "VVVV:PPPP". */
  id: string;
  vid: number;
  pid: number;
  release: number;
  usb: number;
  maxPacket0: number;
  iManufacturer: number;
  iProduct: number;
  iSerial: number;
  /** When its device descriptor came back, µs. */
  since: number;
  configuration: Uint8Array | null;
  interfaces: InterfaceInfo[];
  strings: Map<number, string>;
  /** HID report descriptors, by interface number. */
  reportDescriptors: Map<number, Uint8Array>;
}

const u16 = (d: Uint8Array, at: number) => d[at]! | (d[at + 1]! << 8);
export const hex4 = (n: number) => n.toString(16).toUpperCase().padStart(4, '0');

/** A configuration descriptor's interfaces and endpoints. */
export function parseConfiguration(c: Uint8Array): InterfaceInfo[] {
  const interfaces: InterfaceInfo[] = [];
  let current: InterfaceInfo | null = null;
  for (let i = 0; i + 1 < c.length;) {
    const length = c[i]!;
    const type = c[i + 1]!;
    if (length < 2 || i + length > c.length) break;
    if (type === 4 && length >= 9) {
      current = {
        number: c[i + 2]!,
        alternate: c[i + 3]!,
        class: c[i + 5]!,
        subclass: c[i + 6]!,
        protocol: c[i + 7]!,
        endpoints: [],
        reportDescriptorLength: null,
      };
      interfaces.push(current);
    } else if (type === 5 && length >= 7 && current) {
      current.endpoints.push({
        address: c[i + 2]!,
        attributes: c[i + 3]!,
        maxPacket: u16(c, i + 4) & 0x7ff,
        interval: c[i + 6]!,
      });
    } else if (type === 0x21 && length >= 9 && current) {
      // HID descriptor: its first class descriptor is the report descriptor.
      if (c[i + 6] === 0x22) current.reportDescriptorLength = u16(c, i + 7);
    }
    i += length;
  }
  return interfaces;
}

/**
 * The devices of a recording, from their own descriptors. One entry per time a
 * device came up: a replug, or the receiver after the cable, is a new entry.
 */
export class DeviceTable {
  readonly all: UsbDevice[] = [];
  private byAddress = new Map<string, UsbDevice[]>();

  constructor(transfers: Transfer[]) {
    for (const t of transfers) {
      if (t.kind !== 'control' || !t.setup || t.setup.request !== 6 || !t.data.length) continue;
      const { requestType, value, index } = t.setup;
      const type = value >> 8;
      if (requestType === 0x80 && type === 1 && t.data.length >= 18) {
        const d = t.data;
        const vid = u16(d, 8);
        const pid = u16(d, 10);
        const known = this.at(t.bus, t.dev, t.t);
        if (known && known.vid === vid && known.pid === pid) continue;
        const device: UsbDevice = {
          bus: t.bus,
          address: t.dev,
          id: `${hex4(vid)}:${hex4(pid)}`,
          vid,
          pid,
          release: u16(d, 12),
          usb: u16(d, 2),
          maxPacket0: d[7]!,
          iManufacturer: d[14]!,
          iProduct: d[15]!,
          iSerial: d[16]!,
          since: t.t,
          configuration: null,
          interfaces: [],
          strings: new Map(),
          reportDescriptors: new Map(),
        };
        this.all.push(device);
        const key = `${t.bus}/${t.dev}`;
        this.byAddress.set(key, [...(this.byAddress.get(key) ?? []), device]);
        continue;
      }
      const device = this.at(t.bus, t.dev, t.t);
      if (!device) continue;
      if (requestType === 0x80 && type === 2 && t.data.length >= 9) {
        if (!device.configuration || t.data.length > device.configuration.length) {
          device.configuration = t.data;
          device.interfaces = parseConfiguration(t.data);
        }
      } else if (requestType === 0x80 && type === 3 && (value & 0xff) !== 0 && t.data.length >= 2) {
        const end = Math.min(t.data[0]!, t.data.length);
        let s = '';
        for (let i = 2; i + 1 < end; i += 2) s += String.fromCharCode(u16(t.data, i));
        device.strings.set(value & 0xff, s);
      } else if (requestType === 0x81 && type === 0x22) {
        device.reportDescriptors.set(index & 0xff, t.data);
      }
    }
  }

  /** The device at an address at a moment. */
  at(bus: number, address: number, t: number): UsbDevice | null {
    const list = this.byAddress.get(`${bus}/${address}`);
    if (!list) return null;
    let found: UsbDevice | null = null;
    for (const d of list) if (d.since <= t) found = d;
    return found ?? list[0] ?? null;
  }

  /** The interface an endpoint belongs to. */
  interfaceOf(device: UsbDevice, endpoint: number): number | null {
    for (const i of device.interfaces)
      if (i.endpoints.some((e) => e.address === endpoint)) return i.number;
    return null;
  }
}
