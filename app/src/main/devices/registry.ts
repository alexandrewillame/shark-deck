import type { DeviceDescriptor } from '@shared/types/device';
import { HUB_CABLE_PIDS } from './catalog/hub-mice';
import { JXC_VID, jxcDescriptorFor } from './catalog/jxc-mice';
import { BEKEN_VID, bekenDescriptorFor } from './catalog/beken-mice';

/** The ROYUAN / Compx keyboard chips (and the GearHub mice on them). */
export const ROYUAN_VIDS: readonly number[] = [0x3151, 0x39ab];

/** Relay targets a ROYUAN receiver selects with `0xF6`. */
export const RELAY_TARGET = { keyboard: 0x0a, mouse: 0x05 } as const;

/**
 * ROYUAN endpoints known to be a 2.4 GHz receiver, and what sits behind it.
 * A receiver does not answer the device's commands itself; it carries them
 * (hid/transport.ts). 0x4011 relays a keyboard (sharkfin, on an X86; OpenRGB
 * #4074 for the K86); 0x402D a GearHub mouse (OpenMouse, on an R2).
 * provenance: ported-from-vendor. A receiver not listed here is treated as a
 * device, and a model that answers nothing stays "Identifying…".
 */
export const ROYUAN_RECEIVERS: Readonly<Record<number, 'keyboard' | 'mouse'>> = {
  0x4011: 'keyboard',
  0x402d: 'mouse',
};

/** ROYUAN cable PIDs that are mice (GearHub-V5), not keyboards. */
export const ROYUAN_MOUSE_PIDS: ReadonlySet<number> = new Set([0x4026, 0x402d]);

/** The Compx 8K dongle family — the V8's protocol ("MOUSE HUB"). */
export const COMPX_8K_DONGLE_VID = 0x3554;

/**
 * Which protocol family a connected endpoint speaks — and nothing more.
 *
 * VID/PID cannot say WHICH device this is: ~99 boards of several brands share
 * 3151:5029, and 3554:F517 is both the V8's dongle and another brand's mouse.
 * So every device is attached `pending`, with a driver that sends nothing but
 * its family's identify command, and main/devices/identity.ts decides what it
 * is from the answer (see the manager's `applyIdentity`). Null = not a family
 * Shark Deck speaks.
 */
export function resolveDescriptor(vid: number, pid: number): DeviceDescriptor | null {
  if (ROYUAN_VIDS.includes(vid)) return provisionalRoyuan(vid, pid);
  if (vid === COMPX_8K_DONGLE_VID) return provisionalHub(pid);
  // The JXC firmware has no model-id read: its PID is its identity.
  if (vid === JXC_VID) return jxcDescriptorFor(pid);
  // Beken: named cards only, no driver (catalog/beken-mice.ts).
  if (vid === BEKEN_VID) return bekenDescriptorFor(pid);
  return null;
}

/**
 * A ROYUAN endpoint before it has identified. The model slug is the family,
 * not the PID, so the entry key (model + serial) is the same on every
 * endpoint of one device.
 */
export function provisionalRoyuan(vid: number, pid: number): DeviceDescriptor {
  // The receiver and mouse PIDs are 0x3151's; another VID's are its own.
  const ours = vid === 0x3151;
  const behind = ours ? ROYUAN_RECEIVERS[pid] : undefined;
  return {
    model: 'royuan',
    displayName: 'Identifying…',
    vendor: '',
    kind: ours && ROYUAN_MOUSE_PIDS.has(pid) ? 'mouse' : 'keyboard',
    ...(behind ? { relay: { target: RELAY_TARGET[behind] } } : {}),
    vid,
    pid,
    usagePage: 0xffff,
    usage: 0x02,
    reportLength: 65,
    transport: 'feature-report',
    checksum: 'compx-fea',
    driver: 'royuan-identify',
    provenance: 'inferred',
    art: null,
    identity: 'pending',
    capabilities: [],
    spec: {},
  };
}

/** A Compx Hub endpoint (dongle or cable) before it has identified. */
export function provisionalHub(pid: number): DeviceDescriptor {
  return {
    model: 'compx-hub',
    displayName: 'Identifying…',
    vendor: '',
    kind: 'mouse',
    vid: COMPX_8K_DONGLE_VID,
    pid,
    usagePage: 0xff02,
    usage: 0x02,
    reportLength: 17,
    transport: 'output-report',
    checksum: 'shark-sum',
    driver: 'hub-identify',
    provenance: 'inferred',
    art: null,
    identity: 'pending',
    // The cable endpoint wins over the receiver when both enumerate (the
    // mouse stops talking to its dongle once the cable is in); the identify
    // reply's link type confirms it once the mouse answers.
    ...(HUB_CABLE_PIDS.has(pid) ? { wired: true } : {}),
    capabilities: [],
    spec: {},
  };
}

/**
 * Does one device of this family enumerate on more than one endpoint? A Hub
 * mouse is its receiver AND its cable, under one serial and one memory, so
 * where no serial is reported (WebHID) its endpoints are keyed by family and
 * become one card. A ROYUAN board is one endpoint: keying it by family would
 * fold two different keyboards into one card.
 */
export function spansEndpoints(d: DeviceDescriptor): boolean {
  return d.vid === COMPX_8K_DONGLE_VID || d.vid === JXC_VID;
}

/** Every VID we should enumerate at startup. */
export function knownVendorIds(): number[] {
  return [...ROYUAN_VIDS, COMPX_8K_DONGLE_VID, JXC_VID, BEKEN_VID];
}

/**
 * The browser edition's device-picker filters (WebHID `requestDevice`): one
 * per vendor id + vendor-defined config usage page. Filtering on the usage
 * page rather than the VID alone keeps the picker from offering a device's
 * keyboard or mouse interface, which Chromium would refuse to talk to anyway.
 */
export function hidRequestFilters(): { vendorId: number; usagePage: number }[] {
  return [
    ...ROYUAN_VIDS.map((vendorId) => ({ vendorId, usagePage: 0xffff })),
    { vendorId: COMPX_8K_DONGLE_VID, usagePage: 0xff02 },
    { vendorId: JXC_VID, usagePage: 0xffff },
  ];
}
