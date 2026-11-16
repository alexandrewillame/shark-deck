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
