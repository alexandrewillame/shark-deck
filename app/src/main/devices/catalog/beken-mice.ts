import type { Capability } from '@shared/types/capability';
import type { DeviceDescriptor } from '@shared/types/device';
import { readOnly } from '../identity';
import { mouseButtonMap } from './mouse-buttons';

/**
 * Attack Shark mice on Beken chips (VID 0x1D57): X11, X11 SE, X11 PRO V2, R1,
 * X6, X3, X3 MAX, X3 PRO (first revision), X1, X8 SE / PLUS / PRO, G3,
 * G3 PRO, V3, V3 PRO, V6.
 *
 * Two are driven, from their owners' USB recordings of the vendor software
 * (drivers/beken-8k-mouse.ts): the X8 PRO through its 8K receiver (FA65) and
 * on its cable (2126), and the X11 on its cable (FA55). On a cable both are
 * read through the one-shot permission mailbox (report 0xA0); the recordings
 * show it working on Windows. The rest are shown, never driven — see
 * docs/protocol/mouse-beken.md. In short: Chromium cannot reach the
 * configuration collection at all; reports 0x10 (bootloader — the mouse stays
 * in it across replugs) and 0x0B (unpairs the receiver) sit next to the
 * settings ones; the model byte the receiver reports is ambiguous (a real X6
 * sends R1's); and DPI encodings differ per model (the X11's is not the
 * X8 PRO's).
 *
 * So a card names the model where its PID is its own, and says it is not
 * supported yet. The generic receiver 0xFA60 is shared by several brands and
 * attaches nothing. provenance: ported-from-vendor (community X11 tools; PIDs
 * as linux-hardware and their authors report them; the FA65 protocol from the
 * owner's recording).
 */

export const BEKEN_VID = 0x1d57;

/** The X8 PRO's 8K receiver — driven (drivers/beken-8k-mouse.ts). */
export const X8_PRO_8K_RECEIVER = 0xfa65;
/** The X8 PRO on its cable — driven, and readable (Beken8kCableMouse). */
export const X8_PRO_CABLE = 0x2126;
/** The X11 on its cable — driven (BekenX11Mouse). */
export const X11_CABLE = 0xfa55;

/** PID -> [the name shown, the photo set]. */
const BY_PID: ReadonlyMap<number, [string, string | null]> = new Map([
  [X11_CABLE, ['Attack Shark X11', 'attack-shark-x11']],
  [X8_PRO_CABLE, ['Attack Shark X8 PRO', 'attack-shark-x8']],
  [X8_PRO_8K_RECEIVER, ['Attack Shark X8 PRO', 'attack-shark-x8']],
  [0x2111, ['Attack Shark X1', 'attack-shark-x1']],
  [0x2124, ['Attack Shark X8 PLUS', 'attack-shark-x8']],
  // the cable PID the R1, X6 and X3 share
  [0xfa61, ['Attack Shark R1 / X6 / X3', null]],
]);

const X8_PRO_CAPS: Capability[] = [
  'dpi',
  'pollRate',
  'sensorTuning',
  'lod',
  'rippleControl',
  'angleSnapping',
  'motionSync',
  'mouseDebounce',
  'sleepTimer',
  'buttonRemap',
];

/**
 * The X8 PRO through its 8K receiver. Every range is the vendor software's as
 * the recording showed it: DPI 50–40000, 125–8000 Hz, lift-off 1 or 2 mm, key
 * response from 4 ms (8 the most recorded), sleep from half a minute (10 min
 * the most recorded); the five buttons it lets you remap.
 */
function x8Pro8k(): DeviceDescriptor {
  return {
    model: 'attack-shark-x8-pro',
    displayName: 'Attack Shark X8 PRO',
    vendor: 'Attack Shark',
    kind: 'mouse',
    vid: BEKEN_VID,
    pid: X8_PRO_8K_RECEIVER,
    usagePage: 0xff01,
    usage: 0x0002,
    reportLength: 64,
    transport: 'output-report',
    checksum: 'none',
    driver: 'beken-8k-mouse',
    provenance: 'ported-from-vendor',
    art: null,
    artKey: 'attack-shark-x8',
    identity: 'exact',
    capabilities: X8_PRO_CAPS,
    spec: {
      dpi: { min: 50, max: 40000, step: 50, stages: 6, colorPerStage: false },
      pollRates: [125, 250, 500, 1000, 2000, 4000, 8000],
      lodOptions: [
        { wire: 0, mm: 1 },
        { wire: 1, mm: 2 },
      ],
      // The owner's slider ends (2026-11-19): key response 4–50 ms, sleep 0.5–30 min.
      debounceRange: { min: 4, max: 50 },
      sleepPresets: [30, 60, 120, 300, 600, 900, 1200, 1800],
      // Left, Right, Wheel, Forward, Backward, and the DPI button underneath.
      buttons: 6,
      buttonMap: mouseButtonMap(6),
      buttonActions: ['button', 'dpiSwitch', 'scrollUD', 'combo', 'multimedia', 'disable'],
    },
  };
}

/**
 * The same mouse on its cable: the same blocks, as feature reports on the
 * cable's 000B:0000 collection, and readable (drivers/beken-8k-mouse.ts,
 * Beken8kCableMouse). Over USB 1.1 it polls 1000 Hz at most. The same model,
 * so both connections share what was last sent.
 */
function x8ProCable(): DeviceDescriptor {
  const r = x8Pro8k();
  return {
    ...r,
    pid: X8_PRO_CABLE,
    usagePage: 0x000b,
    usage: 0x0000,
    transport: 'feature-report',
    driver: 'beken-8k-mouse-cable',
    spec: { ...r.spec, pollRates: [125, 250, 500, 1000] },
  };
}

/** The models named here, each with its PIDs — for the lineup doc (devices/lineup.ts). */
export function bekenRoster(): { name: string; pids: number[] }[] {
  const byName = new Map<string, number[]>();
  for (const [pid, [name]] of BY_PID) byName.set(name, [...(byName.get(name) ?? []), pid]);
  return [...byName].map(([name, pids]) => ({ name, pids }));
}

/**
 * The X11 on its cable, from its owner's recording (2026-11-19, issue #2):
 * 50–22000 DPI in six stages, 125–1000 Hz, angle snapping and ripple control,
 * key response 4–50 ms, sleep 0.5–30 min, its six buttons; read as the vendor
 * software reads it. Not driven yet: its lighting, macros, and its receiver
 * (FA60, which other brands' mice share).
 */
function x11Cable(): DeviceDescriptor {
  return {
    model: 'attack-shark-x11',
    displayName: 'Attack Shark X11',
    vendor: 'Attack Shark',
    kind: 'mouse',
    vid: BEKEN_VID,
    pid: X11_CABLE,
    usagePage: 0x000b,
    usage: 0x0000,
    reportLength: 64,
    transport: 'feature-report',
    checksum: 'none',
    driver: 'beken-x11-mouse',
    provenance: 'ported-from-vendor',
    art: null,
    artKey: 'attack-shark-x11',
    identity: 'exact',
    capabilities: [
      'dpi',
      'pollRate',
      'sensorTuning',
      'angleSnapping',
      'rippleControl',
      'mouseDebounce',
      'sleepTimer',
      'buttonRemap',
    ],
    spec: {
      dpi: { min: 50, max: 22000, step: 50, stages: 6, colorPerStage: false },
      pollRates: [125, 250, 500, 1000],
      debounceRange: { min: 4, max: 50 },
      sleepPresets: [30, 60, 120, 300, 600, 900, 1200, 1800],
      buttons: 6,
      buttonMap: mouseButtonMap(6),
      buttonActions: ['button', 'dpiSwitch', 'scrollUD', 'combo', 'multimedia', 'disable'],
    },
  };
}

/** The driven Beken descriptors, for demo mode, the lineup and the contract tests. */
export function bekenMouseRoster(): DeviceDescriptor[] {
  return [x8Pro8k(), x8ProCable(), x11Cable()];
}

/** The X8 PRO (receiver, cable) and the X11 (cable) driven; another named model a never-written card; else null. */
export function bekenDescriptorFor(pid: number): DeviceDescriptor | null {
  if (pid === X8_PRO_8K_RECEIVER) return x8Pro8k();
  if (pid === X8_PRO_CABLE) return x8ProCable();
  if (pid === X11_CABLE) return x11Cable();
  const hit = BY_PID.get(pid);
  if (!hit) return null;
  const [name, artKey] = hit;
  return {
    ...readOnly({ vid: BEKEN_VID, pid }, 'mouse', 'unsupported', 'Beken platform', name),
    // matched on the mouse collection every one of them has; nothing is opened
    usagePage: 0x01,
    usage: 0x02,
    ...(artKey ? { artKey } : {}),
  };
}
