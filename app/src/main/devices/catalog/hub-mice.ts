import type { Capability } from '@shared/types/capability';
import type { DeviceDescriptor, LodOption } from '@shared/types/device';
import { LOD_OPTIONS } from '@shared/mouse-options';
import { DEBOUNCE_RANGE } from '@shared/mouse-wire';
import { ATTACK_SHARK_V8, ATTACK_SHARK_V8_WIRED } from './v8';

/**
 * The Compx "MOUSE HUB" family — every Attack Shark mouse that speaks the V8's
 * protocol (VID 0x3554, 17-byte reports on usage page 0xFF02).
 *
 * The dongle and cable PIDs are shared across models and with other brands
 * (3554:F517 is also a Quasar 2 Ultra), so a mouse is told apart by the
 * identify reply (command 0x01): `cid` (124 = Attack Shark), `mid` (the model)
 * and the link type. Our own V8 capture shows the reply `… 7c 05 05`, i.e.
 * cid 124, mid 5, link 5 — so mid 5 is the V8 (`verified-capture` for the
 * frame; the mid meanings below come from the vendor Hub's model table as
 * transcribed by Dorsal, `ported-from-vendor`). Only the V8 has been on
 * hardware; every other model here is `inferred`.
 */

/** The `cid` byte the identify reply carries for Attack Shark. */
export const ATTACK_SHARK_CID = 124;

export type HubSensor = 'paw3950' | 'paw3955';

/**
 * mid -> sensor class. Our installed Hub's Config.ini lists mids 1-5, 10 and
 * 11 with a PAW3950 at 42000 DPI, which agrees with the vendor table.
 */
export const HUB_MID_CLASS: Record<number, { sensor: HubSensor; maxDpi: number }> = {
  ...Object.fromEntries(
    [1, 2, 3, 4, 5, 10, 11, 12, 18].map((m) => [m, { sensor: 'paw3950' as const, maxDpi: 42000 }]),
  ),
  ...Object.fromEntries(
    [13, 14, 15, 16, 17, 21, 23].map((m) => [m, { sensor: 'paw3955' as const, maxDpi: 52000 }]),
  ),
  ...Object.fromEntries(
    [19, 20, 22].map((m) => [m, { sensor: 'paw3955' as const, maxDpi: 60000 }]),
  ),
};

/** Identify-reply link type -> cable or radio, and the fastest rate it carries. */
export const HUB_LINK: Record<number, { wired: boolean; maxHz: number }> = {
  0: { wired: false, maxHz: 1000 },
  1: { wired: false, maxHz: 4000 },
  2: { wired: true, maxHz: 1000 },
  3: { wired: true, maxHz: 8000 },
  4: { wired: false, maxHz: 2000 },
  5: { wired: false, maxHz: 8000 },
};

/** Cable PIDs from the Hub's own Config.ini (USB_PID) and its cable list. */
export const HUB_CABLE_PIDS: ReadonlySet<number> = new Set([
  0xf515, 0xf516, 0xfb43, 0xf5f6, 0xf50e,
]);

/** PAW3955 lift-off steps (the Hub's codes 1-5). */
export const LOD_OPTIONS_3955: LodOption[] = [
  { wire: 1, mm: 0.7 },
  { wire: 2, mm: 0.9 },
  { wire: 3, mm: 1.2 },
  { wire: 4, mm: 1.4 },
  { wire: 5, mm: 1.6 },
];

const POLL = [125, 250, 500, 1000, 2000, 4000, 8000];

/**
 * What every Hub mouse has: the region-A block is laid out the same for every
 * mid, so these read and write at the V8's offsets. Extras a store page does
 * not confirm per model — receiver LEDs, 20K-FPS scan, long range, angle
 * tuning, sensor mode — are left to the named models below.
 */
const CORE: Capability[] = [
  'profiles',
  'dpi',
  'pollRate',
  'motionSync',
  'angleSnapping',
  'rippleControl',
  'lod',
  'buttonRemap',
  'macros',
  'sleepTimer',
  'mouseDebounce',
  'dpiIndicatorLed',
  'pairing',
  'restore',
  'autoSwitch',
];

function hubMouse(opts: {
  model: string;
  name: string;
  sensor: HubSensor;
  maxDpi: number;
  extra?: Capability[];
  buttons?: number;
  identity: 'exact' | 'class';
  provenance: DeviceDescriptor['provenance'];
  artKey?: string;
}): DeviceDescriptor {
  return {
    model: opts.model,
    displayName: opts.name,
    vendor: 'Attack Shark',
    kind: 'mouse',
    vid: 0x3554,
    pid: 0xf517,
    usagePage: 0xff02,
    usage: 0x02,
    reportLength: 17,
    transport: 'output-report',
    checksum: 'shark-sum',
    driver: 'compx-mouse-8k',
    provenance: opts.provenance,
    art: null,
    ...(opts.artKey ? { artKey: opts.artKey } : {}),
    identity: opts.identity,
    capabilities: [...CORE, ...(opts.extra ?? [])],
    spec: {
      profileCount: 4,
      dpi: {
        min: 50,
        max: opts.maxDpi,
        step: 50,
        stages: 6,
        sensor: opts.sensor === 'paw3955' ? 'PAW3955' : 'PAW3950',
        codec: opts.sensor,
        colorPerStage: true,
      },
      pollRates: POLL,
      buttons: opts.buttons ?? 6,
      sleepTimerRange: { min: 10, max: 900 },
      debounceRange: { ...DEBOUNCE_RANGE },
      lighting: {
        zones: opts.extra?.includes('receiverLed') ? ['dpi-led', 'receiver-led'] : ['dpi-led'],
      },
      lodOptions: opts.sensor === 'paw3955' ? LOD_OPTIONS_3955 : LOD_OPTIONS,
    },
  };
}

/** Named mids: the V8 (our capture), X11 ULTRA and F1 AIR (the vendor table). */
const NAMED: Record<number, DeviceDescriptor> = {
  5: ATTACK_SHARK_V8,
  11: hubMouse({
    model: 'attack-shark-x11-ultra',
    name: 'Attack Shark X11 ULTRA',
    sensor: 'paw3950',
    maxDpi: 42000,
    // its 8K "shark-fin" dock shows battery, DPI and rate on LEDs
    extra: ['receiverLed'],
    identity: 'exact',
    provenance: 'inferred',
  }),
  20: hubMouse({
    model: 'attack-shark-f1-air',
    name: 'Attack Shark F1 AIR',
    sensor: 'paw3955',
    maxDpi: 60000,
    extra: ['receiverLed'],
    buttons: 5,
    identity: 'exact',
    provenance: 'inferred',
  }),
};

/** Photographed models of each class, offered by the "Which model is this?" picker. */
export const HUB_CANDIDATES: Record<string, { artKey: string; name: string }[]> = {
  'paw3950-42000': [
    { artKey: 'attack-shark-x8', name: 'X8 ULTIMATE / X8 ULTRA' },
    { artKey: 'attack-shark-v5', name: 'V5' },
    { artKey: 'attack-shark-r11-ultra', name: 'R11 ULTRA' },
  ],
  'paw3955-52000': [
    { artKey: 'attack-shark-rs3-ultra', name: 'RS3 ULTRA' },
    { artKey: 'attack-shark-rs6-ultra', name: 'RS6 ULTRA' },
  ],
  'paw3955-60000': [
    { artKey: 'attack-shark-v2-air', name: 'V2 AIR' },
    { artKey: 'attack-shark-mega-b2', name: 'MEGA B2' },
    { artKey: 'attack-shark-r5-turbo', name: 'R5 TURBO' },
  ],
};

/** The class key a mid belongs to (`paw3950-42000`…), or null for an unknown mid. */
export function hubClassKey(mid: number): string | null {
  const c = HUB_MID_CLASS[mid];
  return c ? `${c.sensor}-${c.maxDpi}` : null;
}

/**
 * The descriptor for an Attack Shark Hub mouse that identified as `mid` over
 * a link of type `link`: cable or radio from the link, and no poll rate the
 * link cannot carry (a 1K receiver or cable never offers 8000 Hz).
 */
export function hubMouseFor(mid: number, link: number): DeviceDescriptor {
  return capPollToLink(hubMouseOnLink(mid, link), link);
}

function capPollToLink(d: DeviceDescriptor, link: number): DeviceDescriptor {
  const maxHz = HUB_LINK[link]?.maxHz;
  const rates = d.spec.pollRates;
  if (!maxHz || !rates?.some((hz) => hz > maxHz)) return d;
  return { ...d, spec: { ...d.spec, pollRates: rates.filter((hz) => hz <= maxHz) } };
}

function hubMouseOnLink(mid: number, link: number): DeviceDescriptor {
  const wired = HUB_LINK[link]?.wired ?? false;
  if (mid === 5) return wired ? ATTACK_SHARK_V8_WIRED : ATTACK_SHARK_V8;
  const named = NAMED[mid];
  const c = HUB_MID_CLASS[mid];
  const base =
    named ??
    (c
      ? hubMouse({
          model: `attack-shark-hub-m${mid}`,
          name: `Attack Shark mouse (${c.sensor === 'paw3955' ? 'PAW3955' : 'PAW3950'}, ${c.maxDpi / 1000}K)`,
          sensor: c.sensor,
          maxDpi: c.maxDpi,
          identity: 'class',
          provenance: 'inferred',
        })
      : {
          // An Attack Shark mouse (cid 124) of a model no table names: only
          // what every Hub mouse answers — battery, firmware, profiles.
          ...hubMouse({
            model: `attack-shark-hub-m${mid}`,
            name: 'Attack Shark mouse',
            sensor: 'paw3950',
            maxDpi: 42000,
            identity: 'class',
            provenance: 'inferred',
          }),
          capabilities: ['profiles', 'restore'] as Capability[],
          identityNote: `model ${mid}`,
        });
  if (!wired) return base;
  // Over a cable there is no receiver to configure (see catalog/v8.ts).
  return {
    ...base,
    wired: true,
    capabilities: base.capabilities.filter(
      (cap) => cap !== 'receiverLed' && cap !== 'pairing' && cap !== 'longDistanceMode',
    ),
    spec: { ...base.spec, lighting: { zones: ['dpi-led'] } },
  };
}

/** Every distinct Hub descriptor, for developer mode and the menu tests. */
export function hubMouseRoster(): DeviceDescriptor[] {
  return [
    hubMouseFor(11, 5),
    hubMouseFor(20, 5),
    hubMouseFor(1, 5),
    hubMouseFor(13, 5),
    hubMouseFor(19, 5),
  ];
}
