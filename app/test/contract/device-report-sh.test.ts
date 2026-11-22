import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import {
  configDescriptor,
  deviceDescriptor,
  getDescriptor,
  getReport,
  KEYBOARD_REPORT_DESCRIPTOR,
  setReport,
  stringDescriptor,
  VENDOR_REPORT_DESCRIPTOR,
} from '../lib/usbpcap';

vi.mock('node-hid', () => ({
  default: { devicesAsync: async () => [], HIDAsync: { open: vi.fn() } },
}));

const { knownVendorIds } = await import('../../src/main/devices/registry');
const { parseDeviceReport } = await import('../../src/main/devices/deviceReport');
const { DeviceTable, readPcap, transfersOf } =
  await import('../../src/main/devices/capture/usbpcap');
const { dossier } = await import('../../src/main/devices/capture/dossier');

/**
 * tools/sharkdeck-device-report.sh: the report for Linux and macOS owners,
 * and on Linux the recording of the official software. The report reads what
 * the system knows (Linux /sys, macOS ioreg) and sends nothing to a device;
 * the recording reads the kernel's USB monitor as root, keeps the device's own
 * traffic only, and walks the Windows tool's very steps. Run against a fake
 * /sys, a canned ioreg and a made-up usbmon stream, on the systems that have
 * a POSIX shell (not on Windows).
 */

const SCRIPT = resolve(__dirname, '../../../tools/sharkdeck-device-report.sh');
const BAT = resolve(__dirname, '../../../tools/SharkDeck-device-report.bat');
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

  it('sends nothing to a device: the report reads /sys, the recording only the USB monitor', () => {
    // No HID or USB device node is ever opened, and no ioctl made.
    expect(text).not.toMatch(/\/dev\/(hidraw|bus\/usb)/);
    expect(text).not.toMatch(/\bioctl\b/);
    expect(new Set(text.match(/\/dev\/[a-z0-9]+/g))).toEqual(
      new Set(['/dev/null', '/dev/tty', '/dev/usbmon0']),
    );
    // Nothing is written to a device node.
    expect(text).not.toMatch(/>>?\s*\/dev\/(?!null\b)/);
    // Root runs one thing: the monitor read, stopped with the flag file.
    expect(text.match(/\$ROOT\b[^\n]*/g)).toEqual([`$ROOT sh -c 'modprobe usbmon 2>/dev/null`]);
    const asRoot = /\$ROOT sh -c '([^']*)'/.exec(text)![1]!;
    expect(asRoot.split('\n').map((l) => l.split(/\s/)[0])).toEqual([
      'modprobe',
      '[',
      'echo',
      'cat',
      'while',
      'kill',
      'wait',
      'exit',
    ]);
    // A serial number is only checked for, never read.
    expect(text).not.toMatch(/<\s*"\$usb\/serial"|cat[^\n]*serial/);
    expect(text).toContain('[ -e "$usb/serial" ] && serial=1');
    const urls = text.match(/https?:\/\/[^\s'"]+/g) ?? [];
    for (const u of urls) expect(u).toMatch(/^https:\/\/github\.com\/alexandrewillame\/shark-deck/);
  });

  it('walks the Windows tool’s steps, row for row, and shows where each is', () => {
    const bat = readFileSync(BAT, 'utf8');
    const ofBat = (name: string) =>
      new RegExp(`\\$${name} = @'\\r\\n([\\s\\S]*?)\\r\\n'@`).exec(bat)![1]!.split('\r\n');
    const ofSh = (mark: string) =>
      new RegExp(`cat <<'${mark}'\\n([\\s\\S]*?)\\n${mark}\\n`).exec(text)![1]!.split('\n');
    expect(ofSh('STEPS')).toEqual(ofBat('StepTable'));
    expect(ofSh('WHERE')).toEqual(ofBat('WhereTable'));
    expect(ofSh('CUSTOM')).toEqual(ofBat('CustomStepTable'));
    expect(ofSh('STEPS').length).toBeGreaterThan(100);
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

  const sh = (args: string[], env: Record<string, string>) =>
    execFileSync('sh', [SCRIPT, ...args], {
      env: { ...process.env, SHARKDECK_OUT: out, SHARKDECK_MODEL: 'X8 PRO', ...env },
      stdio: 'pipe',
      encoding: 'utf8',
      timeout: 60_000,
    });
  const run = (env: Record<string, string>) => {
    sh([], env);
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
    expect(r.recording).toBeUndefined();
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

  it('previews the steps Shark Deck asks for, recording nothing', () => {
    const answers = join(root, 'preview-answers.txt');
    writeFileSync(answers, ['', 'button 4: Mute', 'f', ''].join('\n') + '\n');
    const said = sh(['--preview-steps', 'mouse', '--steps', 'specific'], {
      SHARKDECK_TTY: answers,
    });
    expect(said).toContain('a preview: nothing is recorded');
    expect(said).toMatch(/start\.open\s+done/);
    expect(said).toMatch(/custom\.each\s+done\s+button 4: Mute/);
    expect(said).toMatch(/end\.close\s+done/);
  });

  it('walks the media keys Shark Deck asks an X8 PRO for, one named setting a step', () => {
    const answers = join(root, 'media-answers.txt');
    writeFileSync(answers, Array(17).fill('n').join('\n') + '\n');
    const said = sh(['--preview-steps', 'mouse', '--steps', 'media'], { SHARKDECK_TTY: answers });
    expect(said).toContain('MEDIA KEYS  1 of 15  -  step 2 of 17');
    expect(said).toContain('Set button 4 (front side button) to the media key Previous track.');
    expect(said).toContain('Where to find it: Where buttons are set');
    expect(said).toMatch(/media\.favorites\s+not-offered/);
    expect(said).toMatch(/end\.close\s+not-offered/);
  });

  it('records a setting not listed at any step, and saves on Enter after the last one', () => {
    const answers = join(root, 'own-answers.txt');
    const lines = ['', 'o', 'debounce set to 4 ms', ...Array(15).fill('n'), '', 'o', 'n', ''];
    writeFileSync(answers, lines.join('\n') + '\n');
    const said = sh(['--preview-steps', 'mouse', '--steps', 'media'], { SHARKDECK_TTY: answers });
    expect(said).toContain('YOUR OWN SETTING  -  step 2 of 18');
    expect(said).toMatch(/own\.1\s+done\s+debounce set to 4 ms/);
    // back on the step it was asked from
    expect(said).toMatch(/media\.prev\s+not-offered/);
    expect(said).toContain('That was the last step. Save the recording.');
    // the second one, thought better of: not in the recording
    expect(said).not.toMatch(/own\.2/);
    expect(said).toMatch(/end\.close\s+done/);
  });

  /**
   * The X11 on its cable at bus 1, address 3 — a keyboard, a mouse and a
   * vendor interface — another brand's receiver at address 4, and the root hub.
   */
  const MOUSE_REPORT_DESCRIPTOR = [
    0x05, 0x01, 0x09, 0x02, 0xa1, 0x01, 0x09, 0x01, 0xa1, 0x00, 0x05, 0x09, 0x19, 0x01, 0x29, 0x05,
    0x15, 0x00, 0x25, 0x01, 0x95, 0x05, 0x75, 0x01, 0x81, 0x02, 0x95, 0x01, 0x75, 0x03, 0x81, 0x01,
    0x05, 0x01, 0x09, 0x30, 0x09, 0x31, 0x15, 0x81, 0x25, 0x7f, 0x75, 0x08, 0x95, 0x02, 0x81, 0x06,
    0xc0, 0xc0,
  ];
  const X11_INTERFACES = [
    { number: 0, protocol: 1, descriptor: KEYBOARD_REPORT_DESCRIPTOR, ep: 0x81 },
    { number: 1, protocol: 2, descriptor: MOUSE_REPORT_DESCRIPTOR, ep: 0x82 },
    { number: 2, protocol: 0, descriptor: VENDOR_REPORT_DESCRIPTOR, ep: 0x83 },
  ];

  function x11Sysfs(): string {
    const sys = join(root, 'sys-x11');
    const usb = (name: string, files: Record<string, string | Buffer>) => {
      const dev = join(sys, 'devices/pci0000:00/0000:00:14.0/usb1', name === 'usb1' ? '' : name);
      mkdirSync(dev, { recursive: true });
      for (const [f, v] of Object.entries(files))
        writeFileSync(join(dev, f), typeof v === 'string' ? `${v}\n` : v);
      mkdirSync(join(sys, 'bus/usb/devices'), { recursive: true });
      symlinkSync(dev, join(sys, 'bus/usb/devices', name));
      return dev;
    };
    usb('usb1', { idVendor: '1d6b', idProduct: '0002', busnum: '1', devnum: '1' });
    const config = configDescriptor(
      X11_INTERFACES.map((i) => ({
        number: i.number,
        protocol: i.protocol,
        reportLength: i.descriptor.length,
        endpoints: [{ address: i.ep, maxPacket: 8, interval: 1 }],
      })),
    );
    const x11 = usb('1-3', {
      idVendor: '1d57',
      idProduct: 'fa55',
      busnum: '1',
      devnum: '3',
      bcdDevice: '0110',
      product: 'X11 Mouse',
      manufacturer: 'Beken',
      serial: 'SECRET-123',
      descriptors: Buffer.from([...deviceDescriptor(0x1d57, 0xfa55, 3), ...config]),
    });
    for (const i of X11_INTERFACES) {
      const ifDir = join(x11, `1-3:1.${i.number}`);
      const id = `0003:1D57:FA55.000${i.number + 1}`;
      const node = join(ifDir, id);
      mkdirSync(node, { recursive: true });
      writeFileSync(join(ifDir, 'bInterfaceNumber'), `0${i.number}\n`);
      writeFileSync(join(node, 'uevent'), 'HID_ID=0003:00001D57:0000FA55\nHID_NAME=X11 Mouse\n');
      writeFileSync(join(node, 'report_descriptor'), Buffer.from(i.descriptor));
      mkdirSync(join(sys, 'bus/hid/devices'), { recursive: true });
      symlinkSync(node, join(sys, 'bus/hid/devices', id));
      // Linux lists the interfaces among the USB devices too, with no ids of their own.
      symlinkSync(ifDir, join(sys, 'bus/usb/devices', `1-3:1.${i.number}`));
    }
    usb('1-4', { idVendor: '046d', idProduct: 'c52b', busnum: '1', devnum: '4' });
    return sys;
  }

  /** One usbmon event as read(2) on /dev/usbmon0 gives it: a 48-byte header, then its data. */
  let urb = 0x1000;
  function mon(e: {
    type: 'S' | 'C';
    xfer: number;
    ep: number;
    dev: number;
    setup?: number[];
    data?: number[];
    status?: number;
    id?: number;
  }): Buffer {
    const h = Buffer.alloc(48);
    h.writeBigUInt64LE(BigInt(e.id ?? ++urb), 0);
    h[8] = e.type.charCodeAt(0);
    h[9] = e.xfer;
    h[10] = e.ep;
    h[11] = e.dev;
    h.writeUInt16LE(1, 12);
    h[14] = e.setup ? 0 : 0x2d;
    h.writeBigInt64LE(1_800_000_000n, 16);
    h.writeInt32LE(e.status ?? (e.type === 'S' ? -115 : 0), 28);
    const data = Buffer.from(e.data ?? []);
    h.writeUInt32LE(data.length, 32);
    h.writeUInt32LE(data.length, 36);
    if (e.setup) Buffer.from(e.setup).copy(h, 40);
    return Buffer.concat([h, data]);
  }
  /** A control request and its answer, on one URB. */
  const control = (dev: number, setup: number[], out: number[], back: number[], status = 0) => {
    const id = ++urb;
    const ep = setup[0]! & 0x80;
    return [
      mon({ type: 'S', xfer: 2, ep, dev, setup, data: out, id }),
      mon({ type: 'C', xfer: 2, ep, dev, data: back, status, id }),
    ];
  };
  const input = (dev: number, ep: number, data: number[]) => {
    const id = ++urb;
    return [
      mon({ type: 'S', xfer: 1, ep, dev, id }),
      mon({ type: 'C', xfer: 1, ep, dev, data, id }),
    ];
  };

  it('records a Linux device: its traffic only, typing blanked, movement cut, its descriptors written in', () => {
    const sys = x11Sysfs();
    const ask = [0xa0, 0x0a, 0x80, 0x00, 0x01, 0x00, 0x00, 0x00];
    const answer = [0x0a, 0x80, 0x01, ...new Array(125).fill(0x11)];
    const stream = Buffer.concat([
      // Another brand's receiver types an "a": never kept.
      ...input(4, 0x81, [0, 0, 0x04, 0, 0, 0, 0, 0]),
      // The official software asks for report 10, and reads it.
      ...control(3, setReport(3, 0xa0, 2, 8), ask, []),
      ...control(3, getReport(3, 0x0a, 2, 128), [], answer),
      // A key typed on the device's keyboard interface: kept, blanked.
      ...input(3, 0x81, [0, 0, 0x05, 0, 0, 0, 0, 0]),
      // Its mouse moving: a sample of 200 kept.
      ...Array.from({ length: 205 }, () => input(3, 0x82, [0, 1, 0])).flat(),
      // Its serial number, read by the virtual machine's Windows: blanked.
      ...control(3, getDescriptor(3, 3, 255), [], stringDescriptor('SECRET')),
      // Its receiver plugged in meanwhile (same vendor): recorded too, from its descriptor on.
      ...control(5, getDescriptor(1, 0, 18), [], deviceDescriptor(0x1d57, 0xfa60)),
      ...input(5, 0x83, [0x03, 0x55, 0x40, 0x02, 0x64]),
      // Another brand's device plugged in meanwhile: dropped once it has said what it is.
      ...control(6, getDescriptor(1, 0, 18), [], deviceDescriptor(0x046d, 0xc077)),
      ...input(6, 0x81, [0, 0, 0x06, 0, 0, 0, 0, 0]),
    ]);
    const usbmon = join(root, 'usbmon.bin');
    writeFileSync(usbmon, stream);
    const answers = join(root, 'answers.txt');
    writeFileSync(
      answers,
      [
        // no "mouse or keyboard?": a Beken chip makes mice only
        'Attack Shark Software 1.0.0.2, in a VirtualBox Windows 11',
        '', // start.open
        'button 4 set to Mute: it stays Volume up',
        'f', // the list is done
        '', // end.close
      ].join('\n') + '\n',
    );
    const recOut = join(root, 'rec');
    mkdirSync(recOut);
    sh(['--device', '1d57:fa55', '--record', '--steps', 'specific'], {
      SHARKDECK_SYS: sys,
      SHARKDECK_OS: 'Linux',
      SHARKDECK_USBMON: usbmon,
      SHARKDECK_TTY: answers,
      SHARKDECK_OUT: recOut,
      SHARKDECK_MODEL: 'X11',
    });

    const made = readdirSync(recOut);
    const folder = made.find((f) => /^SharkDeck-recording-1D57-FA55-\d{8}-\d{4}$/.test(f))!;
    expect(made).toContain(`${folder}.tar.gz`);
    expect(made.some((f) => f.startsWith('SharkDeck-device-report-'))).toBe(false);
    const reportText = readFileSync(join(recOut, folder, 'report.txt'), 'utf8');
    expect(reportText).not.toContain('SECRET-123');
    const report = parseDeviceReport(reportText);
    const rec = report.recording!;
    expect(rec).toMatchObject({
      kind: 'mouse',
      usbpcap: null,
      inPlace: true,
      finishedAllSteps: true,
      devices: ['1D57:FA55'],
      software: { process: 'Attack Shark Software 1.0.0.2, in a VirtualBox Windows 11' },
    });
    expect(rec.capture).toMatch(/^usbmon \(Linux /);
    expect(rec.kept).toMatchObject({
      keyPressesBlanked: 1,
      mouseMovesLeftOut: 5,
      serialNumbersBlanked: 1,
      unidentified: 0,
    });
    expect([...rec.kept.seen].sort()).toEqual([
      '1D57:FA55 (bus 1, address 3)',
      '1D57:FA60 (bus 1, address 5)',
    ]);
    expect(rec.steps.map((s) => [s.id, s.status, s.note])).toEqual([
      ['start.open', 'done', ''],
      ['custom.each', 'done', 'button 4 set to Mute: it stays Volume up'],
      ['end.close', 'done', ''],
    ]);

    const pcap = new Uint8Array(readFileSync(join(recOut, folder, 'capture.pcap')));
    const transfers = transfersOf(readPcap(pcap));
    expect(new Set(transfers.map((t) => t.dev))).toEqual(new Set([3, 5]));
    // Its descriptors as Linux holds them, written in first.
    const devices = new DeviceTable(transfers);
    expect(devices.all.map((d) => [d.id, d.address])).toEqual([
      ['1D57:FA55', 3],
      ['1D57:FA60', 5],
    ]);
    const x11 = devices.all[0]!;
    expect(x11.interfaces.map((i) => [i.number, i.endpoints[0]!.address])).toEqual([
      [0, 0x81],
      [1, 0x82],
      [2, 0x83],
    ]);
    expect([...x11.reportDescriptors.keys()]).toEqual([0, 1, 2]);
    expect([...x11.reportDescriptors.get(2)!]).toEqual(VENDOR_REPORT_DESCRIPTOR);
    // What the software said, whole.
    const hex = (d: Uint8Array) => Buffer.from(d).toString('hex');
    const feature = transfers.filter((t) => t.setup?.requestType === 0x21);
    expect(feature.map((t) => hex(t.data))).toEqual([hex(Uint8Array.from(ask))]);
    const read = transfers.find((t) => t.setup?.requestType === 0xa1)!;
    expect(hex(read.data)).toBe(hex(Uint8Array.from(answer)));
    // Typing blanked, movement sampled, the serial number gone.
    const keys = transfers.filter((t) => t.dev === 3 && t.ep === 0x81);
    expect(keys.map((t) => hex(t.data))).toEqual(['0000000000000000']);
    expect(transfers.filter((t) => t.dev === 3 && t.ep === 0x82)).toHaveLength(200);
    const serial = transfers.find((t) => t.setup?.request === 6 && t.setup.value === 0x0303)!;
    expect(hex(serial.data)).toBe('0e03' + '3000'.repeat(6));
    expect(Buffer.from(pcap).includes(Buffer.from('S\0E\0C\0R\0E\0T\0', 'latin1'))).toBe(false);
    // The receiver's own report, from the moment it named itself.
    expect(transfers.filter((t) => t.dev === 5 && t.ep === 0x83).map((t) => hex(t.data))).toEqual([
      '03554002' + '64',
    ]);

    // And the maintainer's reader makes a dossier of it.
    const d = dossier({
      model: report.model,
      recording: rec,
      pcap,
      devices: report.devices,
    });
    expect(d).toContain('with usbmon (Linux ');
    expect(d).toContain('the tool wrote in its device, configuration and report descriptors');
    expect(existsSync(join(recOut, folder, 'attach'))).toBe(false);
  });
});
