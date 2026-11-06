import type { Capability } from '@shared/types/capability';
import type { DeviceDescriptor, LodOption } from '@shared/types/device';

/**
 * Attack Shark mice on the GearHub-V5 firmware (ROYUAN chip, VID 0x3151),
 * told apart by the device id their identify reply (0x8F) carries — the PID
 * only says cable (4026) or receiver (402D). Ids and sensors as OpenMouse's
 * GearHub catalogue records them (an R2 1893 checked on hardware there; the
 * rest from user diagnostics and the catalogue). provenance: ported-from-vendor.
 * Driven by drivers/gearhub-mouse.ts.
 */

type Sensor = 'PAW3950' | 'PAW3395';

const LOD: Record<Sensor, LodOption[]> = {
  // the options block's LOD byte is an index into the sensor's own list
  PAW3950: [
    { wire: 0, mm: 0.7 },
    { wire: 1, mm: 1 },
    { wire: 2, mm: 2 },
  ],
  PAW3395: [
    { wire: 0, mm: 1 },
    { wire: 1, mm: 2 },
  ],
};

const CAPS: Capability[] = [
  'dpi',
  'pollRate',
  'sensorTuning',
  'lod',
  'angleSnapping',
  'rippleControl',
  'mouseDebounce',
  'sleepTimer',
];

/** The GearHub mouse cable; anything else on this family is its receiver. */
export const GEARHUB_CABLE_PID = 0x4026;

function gearhubMouse(model: string, name: string, sensor: Sensor): DeviceDescriptor {
  return {
    model,
    displayName: `Attack Shark ${name}`,
    vendor: 'Attack Shark',
    kind: 'mouse',
    vid: 0x3151,
    pid: 0x402d,
    usagePage: 0xffff,
    usage: 0x02,
    reportLength: 65,
    transport: 'feature-report',
    checksum: 'compx-fea',
    driver: 'gearhub-mouse',
    provenance: 'ported-from-vendor',
    art: null,
    artKey: model,
    identity: 'exact',
    capabilities: CAPS,
    spec: {
      dpi: {
        min: 50,
        max: sensor === 'PAW3950' ? 42000 : 26000,
        step: 50,
        stages: 8,
        sensor,
        colorPerStage: true,
      },
      pollRates: [125, 250, 500, 1000, 2000, 4000, 8000],
      debounceRange: { min: 1, max: 10 },
      sleepPresets: [0, 15, 30, 60, 120, 300],
      lodOptions: LOD[sensor],
      lighting: { zones: ['dpi-led'] },
    },
  };
}

const R2 = gearhubMouse('attack-shark-r2', 'R2', 'PAW3950');
const R3 = gearhubMouse('attack-shark-r3', 'R3', 'PAW3395');
const R3_3950 = { ...gearhubMouse('attack-shark-r3', 'R3', 'PAW3950') };
const X3_PRO = gearhubMouse('attack-shark-x3-pro', 'X3 PRO', 'PAW3395');

/** device id -> descriptor. */
export const GEARHUB_MICE: ReadonlyMap<number, DeviceDescriptor> = new Map([
  [1893, R2],
  [3009, R2],
  [1643, R3],
  [3485, R3],
  [3309, R3_3950],
  [3310, R3_3950],
  [1660, X3_PRO],
]);

/**
 * GearHub ids of an Attack Shark mouse on a command set this driver does not
 * speak: the R2's newer MCU (3016, on PID 0x5043) — named, never written.
 */
export const GEARHUB_UNSUPPORTED: ReadonlyMap<number, string> = new Map([
  [3016, 'Attack Shark R2'],
]);

/** On its cable a GearHub mouse is wired and polls at 1000 Hz at most. */
export function onGearhubEndpoint(d: DeviceDescriptor, pid: number): DeviceDescriptor {
  if (pid !== GEARHUB_CABLE_PID) return d;
  return {
    ...d,
    wired: true,
    spec: { ...d.spec, pollRates: (d.spec.pollRates ?? []).filter((hz) => hz <= 1000) },
  };
}
