import { describe, expect, it } from 'vitest';
import {
  parseDeviceReport,
  REPORT_MARKER,
  triageDevice,
  triageReport,
  type ReportDevice,
} from './deviceReport';

/**
 * A report from tools/SharkDeck-device-report.bat, read back through the
 * app's own registry and identity code: what each kind of answer means for
 * adding the device.
 */

const device = (over: Partial<ReportDevice>): ReportDevice => ({
  vid: '3151',
  pid: '5029',
  release: '0511',
  product: 'R85HE',
  family: 'royuan',
  interfaces: [
    {
      interface: 2,
      usagePage: 'FFFF',
      usage: '0002',
      kind: 'vendor (settings)',
      inputBytes: 0,
      outputBytes: 0,
      featureBytes: 65,
    },
  ],
  identify: null,
  ...over,
});

const reportText = (devices: unknown) =>
  `Shark Deck device report\n...summary...\n\n${REPORT_MARKER}\n` +
  JSON.stringify({ tool: 'SharkDeck-device-report', version: 1, model: 'X11', devices });

describe('parseDeviceReport', () => {
  it('reads the JSON under the marker, a lone device included', () => {
    // PowerShell 5 can write a one-element array as the element itself.
    const r = parseDeviceReport(reportText(device({})));
    expect(r.model).toBe('X11');
    expect(r.devices).toHaveLength(1);
  });

  it('refuses a file that is not a report', () => {
    expect(() => parseDeviceReport('hello')).toThrow(/marker/);
  });

  it('lays a Linux or macOS report’s raw descriptors out as Windows reports them', () => {
    // tools/sharkdeck-device-report.sh: the X8 PRO's 8K receiver, its settings
    // collection FF01:0002 with report 4 both ways, 63 bytes + the id.
    const vendor =
      '0601ff0902a101' + '8504' + '0901150026ff00750895' + '3f' + '8102' + '0901953f9102' + 'c0';
    const r = parseDeviceReport(
      reportText({
        vid: '1D57',
        pid: 'FA65',
        release: '0118',
        product: '2.4G 8K HS Receiver',
        manufacturer: 'LXDDZ',
        interfaces: [{ interface: 2, transport: 'usb', reportDescriptor: vendor }],
        identify: null,
      }),
    );
    expect(r.devices[0]!.interfaces).toEqual([
      {
        interface: 2,
        usagePage: 'FF01',
        usage: '0002',
        kind: 'vendor (settings)',
        inputBytes: 64,
        outputBytes: 64,
        featureBytes: 0,
        inputIds: [4],
        outputIds: [4],
        featureIds: [],
      },
    ]);
    expect(triageReport(r).join('\n')).toContain('already supported — Attack Shark X8 PRO');
  });
});

describe('triageDevice', () => {
  it('names a keyboard that is already supported, from its model id', () => {
    const lines = triageDevice(
      device({ identify: { asked: true, reply: '008f330c', modelId: 3123, firmware: '5.11' } }),
    );
    expect(lines.join(' ')).toMatch(
      /model id 3123, firmware 5\.11\): already supported — .*R85 HE/,
    );
  });

  it('says where to add a model id no table knows', () => {
    const lines = triageDevice(device({ identify: { asked: true, reply: '…', modelId: 65000 } }));
    expect(lines.join(' ')).toMatch(/a model id no table knows.*import:kb/);
  });

  it('points a Hub mouse of an unnamed mid at the table that names it', () => {
    const lines = triageDevice(
      device({
        vid: '3554',
        pid: 'F517',
        product: '2.4G Dongle',
        family: 'compx-hub',
        identify: { asked: true, reply: '…', cid: 124, mid: 13, link: 5 },
      }),
    );
    expect(lines.join(' ')).toMatch(/mid is not named.*NAMED\[13\]/);
  });

  it('knows another brand on the same chip', () => {
    const lines = triageDevice(
      device({ vid: '3554', pid: 'F517', identify: { asked: true, cid: 7, mid: 1, link: 5 } }),
    );
    expect(lines.join(' ')).toMatch(/another brand/);
  });

  it('asks again when the family is known but the model did not answer', () => {
    const lines = triageDevice(
      device({ identify: { asked: false, why: 'Not asked (--no-query).' } }),
    );
    expect(lines.join(' ')).toMatch(/no model answer in the report \(Not asked \(--no-query\)\)\./);
  });

  it('keeps a Beken mouse with no recording shown and undriven, whatever the report', () => {
    const lines = triageDevice(
      device({
        vid: '1D57',
        pid: '2111',
        product: 'X1',
        family: 'beken',
        identify: { asked: false },
      }),
    );
    expect(lines.join(' ')).toMatch(/X1.*shown, not driven.*mouse-beken\.md/);
  });

  it('knows the original X11 on its cable is driven since its recording', () => {
    const lines = triageDevice(
      device({
        vid: '1D57',
        pid: 'FA55',
        product: 'X11',
        family: 'beken',
        identify: { asked: false },
      }),
    );
    expect(lines.join(' ')).toMatch(/1D57:FA55 "X11": already supported/);
  });

  it('says plainly when a family has no protocol at all', () => {
    const lines = triageDevice(
      device({ vid: '1234', pid: '5678', product: 'Mystery', family: 'unknown' }),
    );
    expect(lines.join(' ')).toMatch(/does not know — no protocol.*FFFF:0002/);
  });
});

describe('triageReport', () => {
  it('heads the lines with what the owner called it', () => {
    const lines = triageReport(parseDeviceReport(reportText([device({})])));
    expect(lines[0]).toMatch(/the owner calls it "X11"/);
  });
});
