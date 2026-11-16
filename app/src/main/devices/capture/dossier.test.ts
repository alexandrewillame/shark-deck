import { describe, expect, it } from 'vitest';
import {
  enumerate,
  getReport,
  inject,
  KEYBOARD_REPORT_DESCRIPTOR,
  setReport,
  UsbPcapBuilder,
  VENDOR_REPORT_DESCRIPTOR,
} from '../../../../test/lib/usbpcap';
import type { ReportDevice } from '../deviceReport';
import { dossier, type Recording, type RecordingStep } from './dossier';

/**
 * A made-up mouse whose protocol is known here and nowhere else: a 17-byte
 * feature report 4 on interface 1, the command in byte 1, shark-sum last.
 * The official software polls the battery every second. A recording of it
 * must give the dossier everything that protocol is.
 */
const T0 = Date.parse('2026-11-16T10:00:00Z') * 1000;
const iso = (t: number) => new Date(t / 1000).toISOString();

function frame(command: number, args: number[]): number[] {
  const f = [0x04, command, ...args, ...new Array(14 - args.length).fill(0)];
  const sum = f.reduce((s, b) => s + b, 0);
  return [...f, (0x55 - sum) & 0xff];
}

/** inPlace: recorded where it was plugged in, so with only the descriptors
 *  USBPcap writes in, instead of plugged in for the recording. */
function recordingOf(inPlace = false) {
  const b = new UsbPcapBuilder();
  const steps: RecordingStep[] = [];
  const interfaces = [
    {
      number: 0,
      protocol: 2,
      reportLength: KEYBOARD_REPORT_DESCRIPTOR.length,
      endpoints: [{ address: 0x81, maxPacket: 8, interval: 1 }],
    },
    {
      number: 1,
      protocol: 0,
      reportLength: VENDOR_REPORT_DESCRIPTOR.length,
      endpoints: [{ address: 0x82, maxPacket: 64, interval: 1 }],
    },
  ];
  let t = inPlace
    ? inject(b, T0, 5, 0x1d57, 0xfa55, interfaces)
    : enumerate(b, T0, 5, 0x1d57, 0xfa55, interfaces, {
        0: KEYBOARD_REPORT_DESCRIPTOR,
        1: VENDOR_REPORT_DESCRIPTOR,
      });
  const poll = (at: number) => {
    b.control(at, 5, setReport(3, 4, 1, 17), frame(0x01, []));
    b.control(at + 2000, 5, getReport(3, 4, 1, 17), [0x04, 0x01, 0x64, ...new Array(14).fill(0)]);
  };
  const step = (
    id: string,
    value: string,
    series: string,
    seconds: number,
    work: (at: number) => void,
    note = '',
  ) => {
    const start = t;
    for (let s = 0; s < seconds; s++) poll(start + s * 1e6 + 100_000);
    work(start + 500_000);
    t = start + seconds * 1e6;
    steps.push({
      id,
      group: 'G',
      text: `do ${id}`,
      value,
      series,
      status: 'done',
      attempt: 0,
      note,
      start: iso(start),
      end: iso(t),
      shots: [`screens/${id}.jpg`],
    });
  };
  t += 2e6;
  step('start.open', '', '', 3, (at) =>
    b.control(at, 5, getReport(3, 4, 1, 17), [0x04, 0x02, 0x00, 0x10, ...new Array(13).fill(0)]),
  );
  step('start.idle', '', '', 15, () => {});
  // The owner types in another window meanwhile: the tool blanked it.
  if (inPlace)
    step('start.tour', '', '', 2, (at) => {
      b.interruptIn(at, 5, 0x81, new Array(8).fill(0));
      b.interruptIn(at + 100_000, 5, 0x81, new Array(8).fill(0));
    });
  for (const dpi of [400, 800, 1600, 3200])
    step(`dpi.s1.${dpi}`, String(dpi), 'dpi.s1', 3, (at) => {
      b.control(at, 5, setReport(3, 4, 1, 17), frame(0x02, [0x00, dpi / 50]));
      b.control(at + 3000, 5, getReport(3, 4, 1, 17), [
        0x04,
        0x02,
        0x00,
        dpi / 50,
        ...new Array(13).fill(0),
      ]);
    });
  for (const hz of [125, 500, 1000])
    step(`poll.${hz}`, String(hz), 'poll', 3, (at) =>
      b.control(at, 5, setReport(3, 4, 1, 17), frame(0x03, [1000 / hz])),
    );
  for (const [name, rgb] of [
    ['#FF0000', [0xff, 0, 0]],
    ['#00FF00', [0, 0xff, 0]],
    ['#0000FF', [0, 0, 0xff]],
  ] as const)
    step(`light.${name}`, name, 'light.color', 3, (at) =>
      b.control(at, 5, setReport(3, 4, 1, 17), frame(0x05, [rgb[1], rgb[0], rgb[2]])),
    );
  step('angle.on', 'on', 'angle', 2, (at) =>
    b.control(at, 5, setReport(3, 4, 1, 17), frame(0x06, [1])),
  );
  step('angle.off', 'off', 'angle', 2, (at) =>
    b.control(at, 5, setReport(3, 4, 1, 17), frame(0x06, [0])),
  );
  step('dpi.button', '', '', 2, (at) =>
    b.interruptIn(at, 5, 0x82, [0x05, 0x10, 0x02, 0, 0, 0, 0, 0]),
  );
  if (inPlace) {
    // Left with "Redo previous" after the software had already sent something,
    // then again with nothing sent.
    for (const sent of [true, false]) {
      if (sent) b.control(t + 500_000, 5, setReport(3, 4, 1, 17), frame(0x07, [1]));
      steps.push({
        ...steps[0]!,
        id: sent ? 'sleep.1' : 'sleep.10',
        text: 'do sleep',
        series: 'sleep',
        status: 'left',
        start: iso(t),
        end: iso(t + 2e6),
        shots: [],
      });
      t += 2e6;
    }
    // Put back before being done again: kept apart from the step's own tries.
    b.control(t + 500_000, 5, setReport(3, 4, 1, 17), frame(0x06, [0]));
    steps.push({
      ...steps[0]!,
      id: 'angle.on',
      text: 'do angle.on',
      value: 'on',
      series: 'angle',
      status: 'reverted',
      attempt: 1,
      start: iso(t),
      end: iso(t + 2e6),
      shots: [],
    });
    t += 2e6;
  }
  steps.push({ ...steps[0]!, id: 'light.each', status: 'not-offered', shots: [] });

  const recording: Recording = {
    version: 1,
    kind: 'mouse',
    usbpcap: '1.5.4.0',
    started: iso(T0),
    ended: iso(t),
    finishedAllSteps: true,
    ...(inPlace ? { inPlace: true } : {}),
    devices: ['1D57:FA55'],
    software: {
      process: 'X11Driver',
      product: 'X11 Driver',
      version: '1.0.2',
      company: 'Attack Shark',
    },
    kept: {
      messages: 999,
      otherDevices: 12,
      keyPressesBlanked: 0,
      mouseMovesLeftOut: 40,
      serialNumbersBlanked: 0,
      seen: ['1D57:FA55 (bus 1, address 5)'],
    },
    steps,
  };
  return { pcap: b.bytes(), recording };
}

describe('the dossier of a recording', () => {
  const { pcap, recording } = recordingOf();
  const text = dossier({
    model: 'X11',
    recording,
    pcap,
    files: new Set(['screens/start.open.jpg']),
  });

  it('describes the device from its descriptors', () => {
    expect(text).toContain('### 1D57:FA55 "Test Mouse"');
    expect(text).toContain(
      '| 1 | 3 / 0 / 0 | 0x82 interrupt 64 B every 1 | feature #4 16 B (vendor (settings)); input #5 7 B (vendor (settings)) |',
    );
    expect(text).toContain('Official software: X11Driver: X11 Driver 1.0.2, Attack Shark');
  });

  it('sets the battery polling apart, once, as what goes on by itself', () => {
    expect(text).toMatch(/→ set-feature if1 #4 17 B ×\d+ every ~1\.00 s: `04 01/);
    const dpi = text.slice(text.indexOf('### dpi.s1.800'), text.indexOf('### dpi.s1.1600'));
    expect(dpi).not.toContain('04 01 00');
    expect(dpi).toContain('(+6 background)');
  });

  it('keeps a read that answers a new write in view, even though the software also polls that report', () => {
    const dpi = text.slice(text.indexOf('### dpi.s1.800'), text.indexOf('### dpi.s1.1600'));
    expect(dpi).toContain('⇄ get-feature if1 #4 17 B answer: `04 02 00 10');
  });

  it('reads each setting’s encoding off the steps', () => {
    expect(text).toContain('byte 3 = value ÷ 50');
    // Byte 4 never moves: a 16-bit reading of 3–4 would only restate byte 3.
    expect(text).not.toContain('3–4 = value ÷ 50');
    expect(text).toContain('bytes that change: 3 (and 16, the checksum)');
    expect(text).toContain('byte 2 = 1000 ÷ value');
    expect(text).toContain('colour at bytes 2–4, in G R B order');
    expect(text).toContain('byte 2: on = 01, off = 00');
  });

  it('finds the checksum', () => {
    expect(text).toContain('byte 16 = (0x55 − Σ) & 0xFF of bytes 0–15');
  });

  it('shows what the device sends on its own, and what the owner skipped or deleted', () => {
    expect(text).toContain('← input if1 #5 8 B: `05 10 02 (+5 × 00)`');
    expect(text).toContain('Not in the software or skipped: light.each.');
    expect(text).toContain('screens/dpi.s1.400.jpg (deleted by the owner)');
  });
});

describe('the dossier of a recording made where the device was plugged in', () => {
  // No unplugging (a keyboard can take a while to type normally again after it):
  // the capture opens on the descriptors USBPcap writes in, and has no report
  // descriptors or names. The report layout Windows gave the tool stands in.
  const { pcap, recording } = recordingOf(true);
  const devices: ReportDevice[] = [
    {
      vid: '1D57',
      pid: 'FA55',
      release: '0105',
      product: 'Test Mouse',
      family: 'beken',
      identify: null,
      interfaces: [
        {
          interface: 0,
          usagePage: '0001',
          usage: '0006',
          kind: 'keyboard',
          inputBytes: 9,
          outputBytes: 0,
          featureBytes: 0,
          inputIds: [0],
        },
        {
          interface: 1,
          usagePage: 'FF00',
          usage: '0001',
          kind: 'vendor (settings)',
          inputBytes: 8,
          outputBytes: 0,
          featureBytes: 17,
          inputIds: [5],
          featureIds: 4,
        },
      ],
    },
  ];
  const text = dossier({
    model: 'X11',
    recording,
    pcap,
    files: new Set(['screens/start.open.jpg']),
    devices,
  });

  it('still knows the device, and its reports from the layout Windows gave', () => {
    expect(text).toContain('### 1D57:FA55\n');
    expect(text).toContain(
      '| 1 | 3 / 0 / 0 | 0x82 interrupt 64 B every 1 | input #5 7 B (vendor (settings)); feature #4 16 B (vendor (settings)) — as Windows gave them (report.txt) |',
    );
    expect(text).toContain('Recorded where it was plugged in, without unplugging it');
    // So the device's own reports carry their ids, as with a descriptor.
    expect(text).toContain('← input if1 #5 8 B: `05 10 02 (+5 × 00)`');
  });

  it('counts what was typed, blanked, instead of listing it, and never as background', () => {
    const tour = text.slice(text.indexOf('### start.tour'), text.indexOf('### dpi.s1.400'));
    expect(tour).toContain('0 messages (+4 background); 2 key reports blanked (what was typed).');
    expect(tour).not.toContain('(+8 × 00)');
    const background = text.slice(
      text.indexOf('## What goes on by itself'),
      text.indexOf('## Steps'),
    );
    expect(background).toContain('every ~1.00 s');
    expect(background).not.toContain('input if0');
  });

  it('shows a step left for “Redo previous” only when something reached the device in it', () => {
    expect(text).toContain('### sleep.1 (left for “Redo previous”): do sleep');
    expect(text).toContain('→ set-feature if1 #4 17 B: `04 07 01');
    expect(text).not.toContain('### sleep.10');
    expect(text).toContain('Not in the software or skipped: light.each.');
  });

  it('keeps what putting a step back sent apart from the step’s own values', () => {
    expect(text).toContain('### angle.on #2 (put back before doing it again): do angle.on');
    // The switch still reads off the steps themselves.
    expect(text).toContain('byte 2: on = 01, off = 00');
  });

  it('reads each setting’s encoding and the checksum off the steps all the same', () => {
    expect(text).toContain('byte 3 = value ÷ 50');
    expect(text).toContain('byte 2 = 1000 ÷ value');
    expect(text).toContain('colour at bytes 2–4, in G R B order');
    expect(text).toContain('byte 2: on = 01, off = 00');
    expect(text).toContain('byte 16 = (0x55 − Σ) & 0xFF of bytes 0–15');
  });
});
