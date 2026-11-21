import type { Capability } from '@shared/types/capability';
import type { BodyLightEffect, DeviceDescriptor } from '@shared/types/device';
import { readOnly } from '../identity';
import { mouseButtonMap } from './mouse-buttons';

/**
 * Attack Shark mice on Beken chips (VID 0x1D57): X11, X11 SE, X11 PRO V2, R1,
 * X6, X3, X3 MAX, X3 PRO (first revision), X1, X8 SE / PLUS / PRO, G3,
 * G3 PRO, V3, V3 PRO, V6.
 *
 * Two are driven, from their owners' USB recordings of the vendor software
 * (drivers/beken-8k-mouse.ts): the X8 PRO through its 8K receiver (FA65) and
 * on its cable (2126), and the X11 on its cable (FA55) and through its
 * receiver (FA60). On a cable, and through FA60, both are read through the
 * one-shot permission mailbox (report 0xA0); the recordings show it working
 * on Windows. The rest are shown, never driven — see
 * docs/protocol/mouse-beken.md. In short: Chromium cannot reach the
 * configuration collection at all; reports 0x10 (bootloader — the mouse stays
 * in it across replugs) and 0x0B (unpairs the receiver) sit next to the
 * settings ones; the model byte the receiver reports is ambiguous (a real X6
 * sends R1's); and DPI encodings differ per model (the X11's is not the
 * X8 PRO's).
 *
 * So a card names the model where its PID is its own, and says it is not
 * supported yet. The receiver 0xFA60 is shared by several brands: it attaches
 * as "Identifying…" and is sent nothing until the mouse behind it has said
 * what it is (BekenIdentify: its model byte, which every Beken mouse sends
 * unasked); only an X11 is then driven. provenance: ported-from-vendor (community X11 tools; PIDs
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
/** The receiver the X11 ships with, which other brands' mice use too ("2.4G
 *  Wireless Device" by LXDDZ): identified by listening, then driven if an X11. */
export const BEKEN_SHARED_RECEIVER = 0xfa60;

/**
 * Byte 1 of a Beken mouse's notifications (input report 3), the model: 0x55
 * from the X11's own recording, the others as the community tools list them
 * (a real X6 sent R1's 0x10, so 0x10 names both).
 */
const BY_MODEL_BYTE: ReadonlyMap<number, [string, string | null]> = new Map([
  [0x55, ['Attack Shark X11', 'attack-shark-x11']],
  [0x07, ['Attack Shark X11 SE', null]],
  [0xa9, ['Attack Shark X11 PRO', null]],
  [0x10, ['Attack Shark R1 / X6', null]],
  [0x85, ['Attack Shark X6', null]],
  [0x4d, ['Attack Shark X3', null]],
  [0x4e, ['Attack Shark X3 MAX', null]],
  [0x4f, ['Attack Shark X3 PRO', null]],
  [0xb1, ['Attack Shark X1', 'attack-shark-x1']],
  [0x02, ['Attack Shark X8 SE', 'attack-shark-x8']],
  [0x06, ['Attack Shark X8 PLUS', 'attack-shark-x8']],
  [0x08, ['Attack Shark X8 PRO', 'attack-shark-x8']],
  [0x04, ['Attack Shark G3', null]],
  [0x0e, ['Attack Shark G3 PRO', null]],
  [0xea, ['Attack Shark V3', null]],
  [0xe5, ['Attack Shark V3 PRO', null]],
  [0x24, ['Attack Shark V6', null]],
]);

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
  'macros',
];

/** Deep sleep, 1–60 min on both mice's sliders (the X11's recording; the X8 PRO's pages). */
const DEEP_SLEEP_PRESETS = [60, 300, 600, 900, 1200, 1800, 2700, 3600];
const BEKEN_BUTTON_ACTIONS = [
  'button',
  'dpiSwitch',
  'scrollUD',
  'combo',
  'multimedia',
  'macro',
  'disable',
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
    connection: '2.4g',
    // Its battery and DPI-stage announcements (FF00:0001, input report 3).
    events: { usagePage: 0xff00, usage: 0x0001 },
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
      buttonActions: BEKEN_BUTTON_ACTIONS,
      deepSleepPresets: DEEP_SLEEP_PRESETS,
      // Its media keys (the MEDIA table, drivers/beken-8k-mouse.ts): Previous
      // track, Stop and Mute are guesses, and the eleven Shark Deck lists after
      // Volume+ (Media player… Favorites) have no code, so the driver refuses
      // them — what its owner saw, 2026-11-19. The tool's "Media keys" steps
      // ask for each by name.
      support: { gaps: ['mediaKeys'], record: ['media'] },
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
    connection: undefined,
    events: { usagePage: 0x000a, usage: 0x0000 },
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
 * The X11's light (its recording and the vendor software's pages): effect in
 * the power block, and which of brightness, speed and colour each one takes.
 * Names as the vendor software gives them (its owner's Spanish, in English).
 */
const X11_LIGHT_EFFECTS: BodyLightEffect[] = [
  { value: 0, label: 'Off', labelKey: 'common.off' },
  { value: 1, label: 'Static', labelKey: 'light.mouseFx.static', brightness: true, color: true },
  { value: 2, label: 'Breathing', labelKey: 'light.mouseFx.breathing', speed: true, color: true },
  { value: 3, label: 'Neon', labelKey: 'light.mouseFx.neon', speed: true },
  { value: 4, label: 'Colour breathing', labelKey: 'light.mouseFx.colourBreathing', speed: true },
  { value: 5, label: 'Static colour', labelKey: 'light.mouseFx.staticColour', brightness: true },
  { value: 6, label: 'Mixed breathing', labelKey: 'light.mouseFx.mixedBreathing', speed: true },
];

/**
 * The X11 on its cable, from its owner's recording (2026-11-19, issue #2):
 * 50–22000 DPI in six stages, 125–1000 Hz, angle snapping and ripple control,
 * key response 4–50 ms, sleep 0.5–30 min, its light, and the five buttons the
 * vendor software lets you remap (its DPI button is not one of them); read as
 * the vendor software reads it. Not driven yet: its macros.
 */
function x11Cable(): DeviceDescriptor {
  return {
    model: 'attack-shark-x11',
    displayName: 'Attack Shark X11',
    vendor: 'Attack Shark',
    kind: 'mouse',
    vid: BEKEN_VID,
    pid: X11_CABLE,
    // Its battery and DPI-stage announcements (000A:0000, input report 3).
    events: { usagePage: 0x000a, usage: 0x0000 },
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
      'mouseLighting',
      'buttonRemap',
      'macros',
    ],
    spec: {
      dpi: { min: 50, max: 22000, step: 50, stages: 6, colorPerStage: false },
      pollRates: [125, 250, 500, 1000],
      debounceRange: { min: 4, max: 50 },
      sleepPresets: [30, 60, 120, 300, 600, 900, 1200, 1800],
      buttons: 5,
      buttonMap: mouseButtonMap(5),
      buttonActions: BEKEN_BUTTON_ACTIONS,
      bodyLight: { effects: X11_LIGHT_EFFECTS },
      deepSleepPresets: DEEP_SLEEP_PRESETS,
    },
  };
}

/**
 * The X11 through its receiver (FA60), once it has said it is one: the very
 * blocks of the cable, which the receiver carries (its recording, the "other
 * connection" steps), on the receiver's own 000B:0000 collection.
 */
function x11Receiver(): DeviceDescriptor {
  const c = x11Cable();
  return { ...c, pid: BEKEN_SHARED_RECEIVER, connection: '2.4g' };
}

/**
 * The shared receiver before its mouse has said what it is: opened on its
 * notification collection (000A:0000, input report 3), where the mouse's
 * model byte arrives, and sent nothing (drivers/identify.ts BekenIdentify).
 */
function bekenReceiverPending(): DeviceDescriptor {
  return {
    model: 'beken-receiver',
    displayName: 'Beken receiver',
    vendor: 'Beken',
    kind: 'mouse',
    vid: BEKEN_VID,
    pid: BEKEN_SHARED_RECEIVER,
    connection: '2.4g',
    usagePage: 0x000a,
    usage: 0x0000,
    reportLength: 64,
    transport: 'feature-report',
    checksum: 'none',
    driver: 'beken-identify',
    provenance: 'ported-from-vendor',
    art: null,
    identity: 'pending',
    capabilities: [],
    spec: {},
  };
}

/**
 * What the mouse behind the shared receiver is, from its model byte: the X11
 * driven, another Beken model of Attack Shark's a named card, anything else
 * an unknown card. Nothing is written to either card.
 */
export function bekenReceiverDescriptor(model: number): DeviceDescriptor {
  if (model === 0x55) return x11Receiver();
  const endpoint = { vid: BEKEN_VID, pid: BEKEN_SHARED_RECEIVER };
  const note = `model byte 0x${model.toString(16).padStart(2, '0')}`;
  const hit = BY_MODEL_BYTE.get(model);
  if (!hit) return readOnly(endpoint, 'mouse', 'unknown', note);
  const [name, artKey] = hit;
  return {
    ...readOnly(endpoint, 'mouse', 'unsupported', note, name),
    ...(artKey ? { artKey } : {}),
  };
}

/** The driven Beken descriptors, for demo mode, the lineup and the contract tests. */
export function bekenMouseRoster(): DeviceDescriptor[] {
  return [x8Pro8k(), x8ProCable(), x11Cable(), x11Receiver()];
}

/**
 * The X8 PRO (receiver, cable) and the X11 (cable) driven; the shared receiver
 * pending until its mouse says what it is; another named model a
 * never-written card; else null.
 */
export function bekenDescriptorFor(pid: number): DeviceDescriptor | null {
  if (pid === X8_PRO_8K_RECEIVER) return x8Pro8k();
  if (pid === X8_PRO_CABLE) return x8ProCable();
  if (pid === X11_CABLE) return x11Cable();
  if (pid === BEKEN_SHARED_RECEIVER) return bekenReceiverPending();
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
