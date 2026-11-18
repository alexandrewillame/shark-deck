import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';

vi.mock('node-hid', () => ({
  default: { devicesAsync: async () => [], HIDAsync: { open: vi.fn() } },
}));

const { knownVendorIds } = await import('../../src/main/devices/registry');
const { parseDeviceReport } = await import('../../src/main/devices/deviceReport');

/**
 * tools/sharkdeck-device-report.sh: the report for Linux and macOS owners.
 * It reads what the system knows (Linux /sys, macOS ioreg) and sends nothing
 * to a device; the maintainer's reader lays its raw descriptors out as the
 * Windows .bat reports them. Run against a fake /sys and a canned ioreg, on
 * the systems that have a POSIX shell (not on Windows).
 */

const SCRIPT = resolve(__dirname, '../../../tools/sharkdeck-device-report.sh');
const text = readFileSync(SCRIPT, 'utf8');

/** The X8 PRO's 8K receiver's settings collection: report 4 both ways, 63 bytes. */
const VENDOR = Buffer.from(
  '0601ff0902a101850409011500' + '26ff00750895' + '3f8102' + '0901953f9102' + 'c0',
  'hex',
);

describe('the Linux / macOS device report script', () => {
  it('knows the families the app knows', () => {
    const vids = /KNOWN_VIDS='([^']+)'/.exec(text)![1]!.split(' ');
    expect(new Set(vids)).toEqual(
      new Set(knownVendorIds().map((v) => v.toString(16).toUpperCase().padStart(4, '0'))),
    );
  });

  it('only reads: no device node opened, nothing written but its report', () => {
    expect(text).not.toMatch(/\/dev\/(hidraw|usb)/);
    expect(text).not.toMatch(/\b(sudo|modprobe|ioctl|usbmon)\b/);
    // A serial number is only checked for, never read.
    expect(text).not.toMatch(/<\s*"\$usb\/serial"|cat[^\n]*serial/);
    expect(text).toContain('[ -e "$usb/serial" ] && serial=1');
    const urls = text.match(/https?:\/\/[^\s'"]+/g) ?? [];
    for (const u of urls) expect(u).toMatch(/^https:\/\/github\.com\/alexandrewillame\/shark-deck/);
  });

  it('is a shell script with Unix line endings', () => {
    expect(text.startsWith('#!/bin/sh\n')).toBe(true);
    expect(text).not.toContain('\r');
  });
});

describe.skipIf(process.platform === 'win32')('running the script', () => {
  const root = mkdtempSync(join(tmpdir(), 'sd-report-sh-'));
  afterAll(() => rmSync(root, { recursive: true, force: true }));
  const out = join(root, 'out');
  mkdirSync(out);

  /** A fake /sys: the X8 PRO's receiver, and another brand's receiver beside it. */
  function sysfs(): string {
    const sys = join(root, 'sys');
    const add = (
      id: string,
      usb: string,
      iface: string,
      files: Record<string, string>,
      desc: Buffer,
    ) => {
      const dev = join(sys, 'devices/pci0000:00/usb2', usb);
      const node = join(dev, iface, id);
      mkdirSync(node, { recursive: true });
      for (const [f, v] of Object.entries(files)) writeFileSync(join(dev, f), `${v}\n`);
      const [, vid, pid] = /^0003:([0-9A-F]{4}):([0-9A-F]{4})/.exec(id)!;
      writeFileSync(
        join(node, 'uevent'),
        `DRIVER=hid-generic\nHID_ID=0003:0000${vid}:0000${pid}\nHID_NAME=${files.product}\n`,
      );
      writeFileSync(join(node, 'report_descriptor'), desc);
      mkdirSync(join(sys, 'bus/hid/devices'), { recursive: true });
      symlinkSync(node, join(sys, 'bus/hid/devices', id));
    };
    add(
      '0003:1D57:FA65.0003',
      '2-1',
      '2-1:1.2',
      {
        bcdDevice: '0118',
        product: '2.4G 8K HS Receiver',
        manufacturer: 'LXDDZ',
        serial: 'SECRET-123',
      },
      VENDOR,
    );
    add(
      '0003:046D:C52B.0004',
      '2-2',
      '2-2:1.0',
      { bcdDevice: '1211', product: 'USB Receiver', manufacturer: 'Logitech' },
      Buffer.from('05010902a101c0', 'hex'),
    );
    return sys;
  }

  const run = (env: Record<string, string>) => {
    execFileSync('sh', [SCRIPT], {
      env: { ...process.env, SHARKDECK_OUT: out, SHARKDECK_MODEL: 'X8 PRO', ...env },
      stdio: 'pipe',
    });
    return readFileSync(join(out, 'SharkDeck-device-report-1D57-FA65.txt'), 'utf8');
  };

  const expected = {
    usagePage: 'FF01',
    usage: '0002',
    kind: 'vendor (settings)',
    inputBytes: 64,
    outputBytes: 64,
    featureBytes: 0,
    inputIds: [4],
    outputIds: [4],
    featureIds: [],
  };

  it('reports a Linux device from /sys, without its serial number or another brand', () => {
    const report = run({ SHARKDECK_SYS: sysfs(), SHARKDECK_OS: 'Linux' });
    expect(report).not.toContain('SECRET-123');
    expect(report).not.toContain('046D');
    expect(report).toContain('reports a serial number: yes');
    const r = parseDeviceReport(report);
    expect(r.platform).toBe('linux');
    expect(r.model).toBe('X8 PRO');
    expect(r.devices).toHaveLength(1);
    expect(r.devices[0]).toMatchObject({
      vid: '1D57',
      pid: 'FA65',
      release: '0118',
      product: '2.4G 8K HS Receiver',
    });
    expect(r.devices[0]!.interfaces).toEqual([{ interface: 2, ...expected }]);
  });

  it('reports a macOS device from ioreg, its own properties only', () => {
    const ioreg = join(root, 'ioreg.txt');
    writeFileSync(
      ioreg,
      [
        '+-o IOUSBHostHIDDevice  <class IOUSBHostHIDDevice, id 0x100001234, registered, matched, active>',
        '    {',
        '      "VendorID" = 7511',
        '      "ProductID" = 64101',
        '      "VersionNumber" = 280',
        '      "Product" = "2.4G 8K HS Receiver"',
        '      "Manufacturer" = "LXDDZ"',
        '      "SerialNumber" = "SECRET-123"',
        '      "Transport" = "USB"',
        `      "ReportDescriptor" = <${VENDOR.toString('hex')}>`,
        '    }',
        '    ',
        '  +-o IOHIDInterface  <class IOHIDInterface, id 0x100001235, registered>',
        '      {',
        '        "VendorID" = 1133',
        '        "ReportDescriptor" = <05010902a101c0>',
        '      }',
        '+-o IOUSBHostHIDDevice  <class IOUSBHostHIDDevice, id 0x100009999, registered>',
        '    {',
        '      "VendorID" = 1133',
        '      "ProductID" = 50475',
        '      "Product" = "USB Receiver"',
        '      "ReportDescriptor" = <05010902a101c0>',
        '    }',
        '',
      ].join('\n'),
    );
    const report = run({ SHARKDECK_OS: 'Darwin', SHARKDECK_IOREG: `cat ${ioreg}` });
    expect(report).not.toContain('SECRET-123');
    const r = parseDeviceReport(report);
    expect(r.platform).toBe('macos');
    expect(r.devices).toHaveLength(1);
    expect(r.devices[0]).toMatchObject({ vid: '1D57', pid: 'FA65', release: '0118' });
    expect(r.devices[0]!.interfaces).toEqual([{ interface: null, ...expected }]);
  });
});
