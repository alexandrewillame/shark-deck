/**
 * USBPcap recordings for tests, in the format tools/SharkDeck-device-report.bat
 * leaves them (pcap, link type 249, USBPcap 1.5 control stages): what the
 * capture reader and the dossier are tested against, since no test can run
 * USBPcap itself.
 */
export class UsbPcapBuilder {
  private records: Uint8Array[] = [];
  private irp = 0x1000n;

  constructor(readonly bus = 1) {}

  private record(
    t: number,
    irp: bigint,
    up: boolean,
    dev: number,
    ep: number,
    transfer: number,
    stage: number | null,
    data: Uint8Array,
    status = 0,
  ): void {
    const hl = stage === null ? 27 : 28;
    const rec = new Uint8Array(16 + hl + data.length);
    const v = new DataView(rec.buffer);
    v.setUint32(0, Math.floor(t / 1e6), true);
    v.setUint32(4, t % 1e6, true);
    v.setUint32(8, hl + data.length, true);
    v.setUint32(12, hl + data.length, true);
    v.setUint16(16, hl, true);
    v.setBigUint64(18, irp, true);
    v.setUint32(26, status, true);
    v.setUint16(30, transfer === 2 ? 0x08 : 0x09, true);
    rec[32] = up ? 1 : 0;
    v.setUint16(33, this.bus, true);
    v.setUint16(35, dev, true);
    rec[37] = ep;
    rec[38] = transfer;
    v.setUint32(39, data.length, true);
    if (stage !== null) rec[43] = stage;
    rec.set(data, 16 + hl);
    this.records.push(rec);
  }

  /** A control transfer: its setup (with any data sent), then its completion (with any data read). */
  control(t: number, dev: number, setup: number[], data: number[] = [], answerAfter = 300): this {
    const irp = this.irp++;
    const isIn = (setup[0]! & 0x80) !== 0;
    const ep = isIn ? 0x80 : 0x00;
    this.record(t, irp, false, dev, ep, 2, 0, new Uint8Array([...setup, ...(isIn ? [] : data)]));
    this.record(t + answerAfter, irp, true, dev, ep, 2, 3, new Uint8Array(isIn ? data : []));
    return this;
  }

  /** An input report: the waiting read, then its completion with the data. */
  interruptIn(t: number, dev: number, ep: number, data: number[], submitted = true): this {
    const irp = this.irp++;
    if (submitted) this.record(t - 100, irp, false, dev, ep, 1, null, new Uint8Array());
    this.record(t, irp, true, dev, ep, 1, null, new Uint8Array(data));
    return this;
  }

  interruptOut(t: number, dev: number, ep: number, data: number[]): this {
    const irp = this.irp++;
    this.record(t, irp, false, dev, ep, 1, null, new Uint8Array(data));
    this.record(t + 200, irp, true, dev, ep, 1, null, new Uint8Array());
    return this;
  }

  bytes(): Uint8Array {
    const header = new Uint8Array(24);
    const v = new DataView(header.buffer);
    v.setUint32(0, 0xa1b2c3d4, true);
    v.setUint16(4, 2, true);
    v.setUint16(6, 4, true);
    v.setUint32(16, 65535, true);
    v.setUint32(20, 249, true);
    const out = new Uint8Array(24 + this.records.reduce((n, r) => n + r.length, 0));
    out.set(header);
    let at = 24;
    for (const r of this.records) {
      out.set(r, at);
      at += r.length;
    }
    return out;
  }
}

export const getDescriptor = (type: number, index: number, length: number, iface = 0) => [
  type === 0x22 ? 0x81 : 0x80,
  6,
  index,
  type,
  iface & 0xff,
  iface >> 8,
  length & 0xff,
  length >> 8,
];

/** SET_REPORT / GET_REPORT setups; type 1 input, 2 output, 3 feature. */
export const setReport = (type: number, id: number, iface: number, length: number) => [
  0x21,
  0x09,
  id,
  type,
  iface,
  0,
  length & 0xff,
  length >> 8,
];
export const getReport = (type: number, id: number, iface: number, length: number) => [
  0xa1,
  0x01,
  id,
  type,
  iface,
  0,
  length & 0xff,
  length >> 8,
];

export function deviceDescriptor(vid: number, pid: number, serialIndex = 0): number[] {
  return [
    18,
    1,
    0x00,
    0x02,
    0,
    0,
    0,
    64,
    vid & 0xff,
    vid >> 8,
    pid & 0xff,
    pid >> 8,
    0x05,
    0x01,
    1,
    2,
    serialIndex,
    1,
  ];
}

export interface FakeInterface {
  number: number;
  /** Boot protocol: 1 keyboard, 2 mouse, 0 none. */
  protocol: number;
  reportLength: number;
  endpoints: { address: number; maxPacket: number; interval: number }[];
}

export function configDescriptor(interfaces: FakeInterface[]): number[] {
  const body: number[] = [];
  for (const i of interfaces) {
    body.push(9, 4, i.number, 0, i.endpoints.length, 3, i.protocol ? 1 : 0, i.protocol, 0);
    body.push(9, 0x21, 0x11, 0x01, 0, 1, 0x22, i.reportLength & 0xff, i.reportLength >> 8);
    for (const e of i.endpoints)
      body.push(7, 5, e.address, 3, e.maxPacket & 0xff, e.maxPacket >> 8, e.interval);
  }
  const total = 9 + body.length;
  return [9, 2, total & 0xff, total >> 8, interfaces.length, 1, 0, 0xa0, 50, ...body];
}

export const stringDescriptor = (s: string) => [
  2 + 2 * s.length,
  3,
  ...[...s].flatMap((c) => [c.charCodeAt(0) & 0xff, c.charCodeAt(0) >> 8]),
];

/** A boot keyboard: modifiers, reserved, six keys. */
export const KEYBOARD_REPORT_DESCRIPTOR = [
  0x05, 0x01, 0x09, 0x06, 0xa1, 0x01, 0x05, 0x07, 0x19, 0xe0, 0x29, 0xe7, 0x15, 0x00, 0x25, 0x01,
  0x75, 0x01, 0x95, 0x08, 0x81, 0x02, 0x95, 0x01, 0x75, 0x08, 0x81, 0x01, 0x95, 0x06, 0x75, 0x08,
  0x15, 0x00, 0x25, 0x65, 0x05, 0x07, 0x19, 0x00, 0x29, 0x65, 0x81, 0x00, 0xc0,
];

/** A vendor settings page: feature report 4, 16 bytes, and input report 5, 7 bytes. */
export const VENDOR_REPORT_DESCRIPTOR = [
  0x06, 0x00, 0xff, 0x09, 0x01, 0xa1, 0x01, 0x85, 0x04, 0x09, 0x02, 0x15, 0x00, 0x26, 0xff, 0x00,
  0x75, 0x08, 0x95, 0x10, 0xb1, 0x02, 0x85, 0x05, 0x09, 0x03, 0x95, 0x07, 0x81, 0x02, 0xc0,
];

/** A device recorded where it was plugged in: what USBPcapCMD
 *  `--inject-descriptors` writes first (its device and configuration
 *  descriptors, then a SET_CONFIGURATION), and nothing else of its coming up. */
export function inject(
  b: UsbPcapBuilder,
  t: number,
  dev: number,
  vid: number,
  pid: number,
  interfaces: FakeInterface[],
): number {
  const config = configDescriptor(interfaces);
  b.control(t, dev, getDescriptor(1, 0, 18), deviceDescriptor(vid, pid));
  b.control((t += 1000), dev, getDescriptor(2, 0, config.length), config);
  b.control((t += 1000), dev, [0x00, 0x09, config[5]!, 0, 0, 0, 0, 0]);
  return t + 1000;
}

/** A device coming up: the descriptors Windows reads, then SET_IDLE per interface. */
export function enumerate(
  b: UsbPcapBuilder,
  t: number,
  dev: number,
  vid: number,
  pid: number,
  interfaces: FakeInterface[],
  reportDescriptors: Record<number, number[]>,
  serial = '',
): number {
  const device = deviceDescriptor(vid, pid, serial ? 3 : 0);
  const config = configDescriptor(interfaces);
  b.control(t, dev, getDescriptor(1, 0, 18), device);
  b.control((t += 1000), dev, getDescriptor(2, 0, 9), config.slice(0, 9));
  b.control((t += 1000), dev, getDescriptor(2, 0, config.length), config);
  b.control((t += 1000), dev, getDescriptor(3, 2, 255), stringDescriptor('Test Mouse'));
  if (serial) b.control((t += 1000), dev, getDescriptor(3, 3, 255), stringDescriptor(serial));
  for (const i of interfaces) {
    b.control((t += 1000), dev, [0x21, 0x0a, 0, 0, i.number, 0, 0, 0]);
    const rd = reportDescriptors[i.number] ?? [];
    b.control((t += 1000), dev, getDescriptor(0x22, 0, rd.length + 64, i.number), rd);
  }
  return t + 1000;
}
