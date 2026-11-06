import type { Capability } from '@shared/types/capability';
import type { DeviceDescriptor, LodOption } from '@shared/types/device';
import { readOnly } from '../identity';

/**
 * Attack Shark's "JXC" mice, on the Compx ODM's VID 0x373E (driven by
 * drivers/jxc-mouse.ts). This firmware has no model-id read, so a mouse is
 * known by its PID — and the VID is shared with LAMZU, RAWM, CRDRAKO,
 * LunaFury, UNIUS and Vancer, so only the PIDs below are ever driven.
 * provenance: ported-from-vendor (Dorsal's model table, MIT; an R5 ULTRA
 * checked on hardware there). Never on our hardware.
 */

export const JXC_VID = 0x373e;

/** 0x87 is 0.7 mm, then plain 1 and 2. */
const LOD: LodOption[] = [
  { wire: 0x87, mm: 0.7 },
  { wire: 0x01, mm: 1 },
  { wire: 0x02, mm: 2 },
];

const CAPS: Capability[] = [
  'profiles',
  'autoSwitch',
  'dpi',
  'pollRate',
  'sensorTuning',
  'lod',
  'motionSync',
  'rippleControl',
  'angleSnapping',
  'mouseDebounce',
  'sleepTimer',
];

interface JxcModel {
  model: string;
  name: string;
  cable: number;
  receiver: number;
}

const MODELS: JxcModel[] = [
  { model: 'attack-shark-r5-ultra', name: 'R5 ULTRA', cable: 0x0046, receiver: 0x0047 },
  { model: 'attack-shark-r6', name: 'R6', cable: 0x0021, receiver: 0x0022 },
  { model: 'attack-shark-r8', name: 'R8', cable: 0x003a, receiver: 0x003b },
];

function jxcMouse(m: JxcModel, pid: number): DeviceDescriptor {
  const wired = pid === m.cable;
  return {
    model: m.model,
    displayName: `Attack Shark ${m.name}`,
    vendor: 'Attack Shark',
    kind: 'mouse',
    vid: JXC_VID,
    pid,
    // the configuration collection is usage 0 on this firmware, not 1 or 2
    usagePage: 0xffff,
    usage: 0x0000,
    reportLength: 65,
    transport: 'feature-report',
    checksum: 'none',
    driver: 'jxc-mouse',
    provenance: 'ported-from-vendor',
    // photos by model slug where the store sells it (the R8 it does not)
    art: null,
    identity: 'exact',
    ...(wired ? { wired: true } : {}),
    capabilities: CAPS,
    spec: {
      profileCount: 3,
      dpi: { min: 100, max: 42000, step: 50, stages: 6, sensor: 'PAW3950', colorPerStage: false },
      // cable 125-1000 Hz, receiver up to 8 kHz
      pollRates: wired ? [125, 250, 500, 1000] : [125, 250, 500, 1000, 2000, 4000, 8000],
      debounceRange: { min: 0, max: 20 },
      lodOptions: LOD,
    },
  };
}

/**
 * The M5 ULTRA's ids are also a MAMBASNAKE M5 Ultra's, and no source ties
 * them to Attack Shark firmly: named, never written, until one is confirmed.
 */
const UNCONFIRMED: ReadonlyMap<number, string> = new Map([
  [0x0051, 'M5 ULTRA (Attack Shark or MAMBASNAKE)'],
  [0x0050, 'M5 ULTRA (Attack Shark or MAMBASNAKE)'],
]);

/** Other brands' mice on this VID, by PID (Dorsal's and OpenMouse's tables). */
const OTHER_BRANDS: ReadonlyMap<number, string> = new Map([
  ...[0x006a, 0x006b].map((p) => [p, 'CRDRAKO'] as const),
  ...[0x001c, 0x001d, 0x001e].map((p) => [p, 'LAMZU'] as const),
  ...[0x003c, 0x003d].map((p) => [p, 'UNIUS'] as const),
  ...[0x0098, 0x0099].map((p) => [p, 'RAWM'] as const),
  ...[0x0032, 0x0033, 0x0054, 0x0084].map((p) => [p, 'LunaFury'] as const),
  ...[0x0066, 0x0067].map((p) => [p, 'Vancer'] as const),
]);

/** Every JXC endpoint: an Attack Shark model, or a card that names what it is. */
export function jxcDescriptorFor(pid: number): DeviceDescriptor {
  const m = MODELS.find((x) => x.cable === pid || x.receiver === pid);
  if (m) return jxcMouse(m, pid);
  const endpoint = { vid: JXC_VID, pid };
  // Matched on the same configuration collection as a JXC mouse, so a card
  // appears only for a device that has one.
  const onCollection = (d: DeviceDescriptor) => ({ ...d, usagePage: 0xffff, usage: 0x0000 });
  const unconfirmed = UNCONFIRMED.get(pid);
  if (unconfirmed) return onCollection(readOnly(endpoint, 'mouse', 'unknown', unconfirmed));
  const brand = OTHER_BRANDS.get(pid);
  if (brand) return onCollection(readOnly(endpoint, 'mouse', 'foreign', brand));
  const hex = pid.toString(16).padStart(4, '0');
  return onCollection(readOnly(endpoint, 'mouse', 'unknown', `373e:${hex}`));
}

/** One descriptor per JXC model, for developer mode and the menu tests. */
export function jxcMouseRoster(): DeviceDescriptor[] {
  return MODELS.map((m) => jxcMouse(m, m.receiver));
}
