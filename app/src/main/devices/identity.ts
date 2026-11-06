import type { DeviceDescriptor, DeviceKind, IdentityStatus } from '@shared/types/device';
import type { IdentityKey } from './identity-key';
import { KEYBOARDS_BY_ID, foreignBrand } from './catalog/keyboards';
import { ATTACK_SHARK_CID, HUB_CABLE_PIDS, hubMouseFor } from './catalog/hub-mice';
import { GEARHUB_MICE, GEARHUB_UNSUPPORTED, onGearhubEndpoint } from './catalog/gearhub-mice';

/**
 * Turn an identify answer into the descriptor a device is driven with.
 *
 * VID/PID only says which protocol FAMILY a device speaks (see
 * registry.ts `resolveDescriptor`, which attaches it `pending`); what the
 * device IS comes from here:
 *  - a known Attack Shark model id / mid -> its exact descriptor;
 *  - an Attack Shark mouse of an unnamed mid -> the descriptor its sensor
 *    class shares (`class`);
 *  - an Attack Shark board whose command set has no driver -> `unsupported`;
 *  - another brand, or an id no table knows -> a read-only card.
 * The descriptor is bound to the endpoint it actually came in on.
 */
export function resolveIdentity(
  endpoint: { vid: number; pid: number },
  key: IdentityKey,
): DeviceDescriptor {
  if (key.family === 'royuan') {
    // GearHub mice share the chip, the VID and the identify command: their
    // device ids are their own (catalog/gearhub-mice.ts).
    const mouse = GEARHUB_MICE.get(key.modelId);
    if (mouse) return onGearhubEndpoint(bind(mouse, endpoint), endpoint.pid);
    const otherMcu = GEARHUB_UNSUPPORTED.get(key.modelId);
    if (otherMcu) {
      return readOnly(endpoint, 'mouse', 'unsupported', `device id ${key.modelId}`, otherMcu);
    }
    const d = KEYBOARDS_BY_ID.get(key.modelId);
    if (d?.identity === 'unsupported') {
      // A real Attack Shark board on a command set with no driver yet: its
      // own name and photo, nothing read or written.
      return {
        ...readOnly(endpoint, 'keyboard', 'unsupported', `model id ${key.modelId}`, d.displayName),
        ...(d.artKey ? { artKey: d.artKey } : {}),
      };
    }
    if (d) return bind(d, endpoint);
    const brand = foreignBrand(key.modelId);
    return readOnly(
      endpoint,
      'keyboard',
      brand ? 'foreign' : 'unknown',
      brand ? `${brand}, model id ${key.modelId}` : `model id ${key.modelId}`,
    );
  }
  if (key.cid !== ATTACK_SHARK_CID) {
    return readOnly(endpoint, 'mouse', 'foreign', `vendor ${key.cid}, model ${key.mid}`);
  }
  return bind(hubMouseFor(key.mid, key.link), endpoint);
}

function bind(d: DeviceDescriptor, endpoint: { vid: number; pid: number }): DeviceDescriptor {
  return d.vid === endpoint.vid && d.pid === endpoint.pid
    ? d
    : { ...d, vid: endpoint.vid, pid: endpoint.pid };
}

/** A card that shows what the device said it is, and does nothing else. */
export function readOnly(
  endpoint: { vid: number; pid: number },
  kind: DeviceKind,
  identity: Extract<IdentityStatus, 'foreign' | 'unknown' | 'unsupported'>,
  note: string,
  name?: string,
): DeviceDescriptor {
  const hex = (n: number) => n.toString(16).padStart(4, '0');
  return {
    model: `read-only-${hex(endpoint.vid)}-${hex(endpoint.pid)}`,
    displayName:
      name ?? (identity === 'foreign' ? 'Not an Attack Shark device' : 'Unrecognised device'),
    vendor: '',
    kind,
    vid: endpoint.vid,
    pid: endpoint.pid,
    usagePage: 0,
    usage: 0,
    reportLength: 0,
    transport: 'feature-report',
    checksum: 'none',
    driver: 'no-io',
    provenance: 'inferred',
    art: null,
    identity,
    identityNote: note,
    capabilities: [],
    spec: {},
  };
}

/** True for a Hub endpoint that is the mouse's own cable rather than a receiver. */
export const isHubCable = (pid: number) => HUB_CABLE_PIDS.has(pid);

/**
 * A card Shark Deck shows and never talks to: another brand, an id no table
 * knows, or an Attack Shark model whose command set has no driver yet.
 */
export function isReadOnly(d: Pick<DeviceDescriptor, 'identity'>): boolean {
  return d.identity === 'foreign' || d.identity === 'unknown' || d.identity === 'unsupported';
}
