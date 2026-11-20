import { describe, expect, it } from 'vitest';
import {
  enumerate,
  getReport,
  KEYBOARD_REPORT_DESCRIPTOR,
  setReport,
  UsbPcapBuilder,
  VENDOR_REPORT_DESCRIPTOR,
  type FakeInterface,
} from '../../../../test/lib/usbpcap';
import { parseReportDescriptor } from './hidDescriptor';
import { hexOf, readHid } from './hidMessages';
import { readPcap, transfersOf } from './usbpcap';

const T0 = Date.parse('2026-11-16T10:00:00Z') * 1000;
const INTERFACES: FakeInterface[] = [
  {
    number: 0,
    protocol: 1,
    reportLength: KEYBOARD_REPORT_DESCRIPTOR.length,
    endpoints: [{ address: 0x81, maxPacket: 8, interval: 1 }],
  },
  {
    number: 1,
    protocol: 0,
    reportLength: VENDOR_REPORT_DESCRIPTOR.length,
    endpoints: [
      { address: 0x82, maxPacket: 64, interval: 1 },
      { address: 0x02, maxPacket: 64, interval: 1 },
    ],
  },
];

function recording() {
  const b = new UsbPcapBuilder();
  let t = enumerate(b, T0, 7, 0x1d57, 0xfa55, INTERFACES, {
    0: KEYBOARD_REPORT_DESCRIPTOR,
    1: VENDOR_REPORT_DESCRIPTOR,
  });
  const frame = [0x04, 0x02, 0x00, 0x10, ...new Array(13).fill(0)];
  b.control((t += 1000), 7, setReport(3, 4, 1, 17), frame);
  b.control((t += 1000), 7, getReport(3, 4, 1, 17), [0x04, 0x02, 0x01, ...new Array(14).fill(0)]);
  b.interruptIn((t += 1000), 7, 0x82, [0x05, 0x40, 0x55, 0, 0, 0, 0, 0]);
  b.interruptOut((t += 1000), 7, 0x02, [0x04, 0x09]);
  b.interruptIn((t += 1000), 7, 0x81, [0, 0, 0, 0, 0, 0, 0, 0], false);
  return b.bytes();
}

describe('reading a USBPcap recording', () => {
  it('pairs every request with its answer', () => {
    const transfers = transfersOf(readPcap(recording()));
    const set = transfers.find((t) => t.setup?.request === 0x09 && t.setup.value === 0x0304)!;
    expect(set.in).toBe(false);
    expect(hexOf(set.data)).toBe('04 02 00 10 (+13 × 00)');
    const get = transfers.find((t) => t.setup?.request === 0x01)!;
    expect(get.in).toBe(true);
    expect(hexOf(get.data)).toBe('04 02 01 (+14 × 00)');
    expect(get.done! - get.t).toBe(300);
  });

  it('knows the device from its own descriptors', () => {
    const { devices } = readHid(transfersOf(readPcap(recording())));
    expect(devices.all).toHaveLength(1);
    const d = devices.all[0]!;
    expect(d.id).toBe('1D57:FA55');
    expect(d.strings.get(2)).toBe('Test Mouse');
    expect(
      d.interfaces.map((i) => [i.number, i.protocol, i.endpoints.map((e) => e.address)]),
    ).toEqual([
      [0, 1, [0x81]],
      [1, 0, [0x82, 0x02]],
    ]);
    expect(d.interfaces[1]!.reportDescriptorLength).toBe(VENDOR_REPORT_DESCRIPTOR.length);
    expect(devices.interfaceOf(d, 0x82)).toBe(1);
  });

  it('reads HID messages: features, input and output reports, with their ids', () => {
    const { messages } = readHid(transfersOf(readPcap(recording())));
    expect(messages.map((m) => `${m.kind} if${m.iface} #${m.reportId}`)).toEqual([
      'set-feature if1 #4',
      'get-feature if1 #4',
      'input if1 #5',
      'output if1 #4',
      'input if0 #0',
    ]);
  });

  it('survives a recording cut off in the middle of a record', () => {
    const whole = recording();
    expect(readPcap(whole.subarray(0, whole.length - 5)).length).toBe(readPcap(whole).length - 1);
  });

  it('refuses what is not a USBPcap file', () => {
    expect(() => readPcap(new Uint8Array(30))).toThrow(/not a classic pcap/);
  });
});

/**
 * Linux's usbmon, as tcpdump writes it for tools/sharkdeck-device-report.sh
 * (link type 220): a 64-byte header a record, `S` submit / `C` completion,
 * a control submit's setup packet in the header.
 */
describe('reading a Linux (usbmon) recording', () => {
  /** One usbmon record: header fields as the kernel lays them out, then the data. */
  const record = (
    id: number,
    type: 'S' | 'C',
    xfer: number,
    ep: number,
    status: number,
    setup: number[] | null,
    data: number[],
  ) => {
    const h = new Uint8Array(64);
    const v = new DataView(h.buffer);
    v.setBigUint64(0, BigInt(id), true);
    h[8] = type.charCodeAt(0);
    h[9] = xfer;
    h[10] = ep;
    h[11] = 5; // devnum
    v.setUint16(12, 3, true); // busnum
    h[14] = setup ? 0 : 0x2d; // '-': no setup
    v.setInt32(28, status, true);
    v.setUint32(32, data.length, true);
    v.setUint32(36, data.length, true);
    if (setup) h.set(setup, 40);
    return Uint8Array.from([...h, ...data]);
  };
  const pcap = (records: Uint8Array[]) => {
    const head = new Uint8Array(24);
    const v = new DataView(head.buffer);
    v.setUint32(0, 0xa1b2c3d4, true);
    v.setUint16(4, 2, true);
    v.setUint16(6, 4, true);
    v.setUint32(16, 65535, true);
    v.setUint32(20, 220, true);
    const parts: number[] = [...head];
    records.forEach((r, i) => {
      const rh = new DataView(new ArrayBuffer(16));
      rh.setUint32(0, 1_800_000_000 + i, true);
      rh.setUint32(4, 0, true);
      rh.setUint32(8, r.length, true);
      rh.setUint32(12, r.length, true);
      parts.push(...new Uint8Array(rh.buffer), ...r);
    });
    return Uint8Array.from(parts);
  };

  it('pairs a feature report and its answer, and reads an input report', () => {
    const setReport = [0x21, 0x09, 0x04, 0x03, 0x02, 0x00, 0x08, 0x00];
    const getReport = [0xa1, 0x01, 0x0a, 0x03, 0x02, 0x00, 0x80, 0x00];
    const ask = [0xa0, 0x0a, 0x80, 0x00, 0x01, 0x00, 0x00, 0x00];
    const answer = [0x0a, 0x80, 0x01, 0x01, 0xfe];
    const transfers = transfersOf(
      readPcap(
        pcap([
          record(1, 'S', 2, 0x00, -115, setReport, ask),
          record(1, 'C', 2, 0x00, 0, null, []),
          record(2, 'S', 2, 0x80, -115, getReport, []),
          record(2, 'C', 2, 0x80, 0, null, answer),
          record(3, 'C', 1, 0x83, 0, null, [0x03, 0x55, 0x40, 0x02, 0x64]),
        ]),
      ),
    );
    expect(
      transfers.map((t) => [t.kind, t.in, t.setup?.request ?? null, hexOf(t.data, false)]),
    ).toEqual([
      ['control', false, 0x09, 'a0 0a 80 00 01 00 00 00'],
      ['control', true, 0x01, '0a 80 01 01 fe'],
      ['interrupt', true, null, '03 55 40 02 64'],
    ]);
    expect(transfers.map((t) => [t.bus, t.dev, t.status])).toEqual([
      [3, 5, 0],
      [3, 5, 0],
      [3, 5, 0],
    ]);
  });

  it('keeps a stalled request as failed', () => {
    const setReport = [0x21, 0x09, 0xa0, 0x03, 0x02, 0x00, 0x08, 0x00];
    const [t] = transfersOf(
      readPcap(
        pcap([
          record(1, 'S', 2, 0x00, -115, setReport, [0xa0, 0x0b, 0x08, 0, 0, 0, 0, 0]),
          record(1, 'C', 2, 0x00, -32, null, []),
        ]),
      ),
    );
    expect(t!.status).toBe(-32);
  });
});

describe('HID report descriptors', () => {
  it('reads a boot keyboard', () => {
    const k = parseReportDescriptor(Uint8Array.from(KEYBOARD_REPORT_DESCRIPTOR));
    expect(k.collections).toEqual([{ usagePage: 1, usage: 6 }]);
    expect(k.reports).toEqual([{ type: 'input', id: 0, bytes: 8, usagePage: 1, usage: 6 }]);
    expect(k.numbered).toBe(false);
  });

  it('reads a vendor settings page with numbered reports', () => {
    const v = parseReportDescriptor(Uint8Array.from(VENDOR_REPORT_DESCRIPTOR));
    expect(v.reports).toEqual([
      { type: 'feature', id: 4, bytes: 16, usagePage: 0xff00, usage: 1 },
      { type: 'input', id: 5, bytes: 7, usagePage: 0xff00, usage: 1 },
    ]);
    expect(v.numbered).toBe(true);
  });
});
