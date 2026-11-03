import type { DeviceDescriptor } from '@shared/types/device';
import { ATTACK_SHARK_V8, CATALOG } from './catalog';
import { COMPX_VENDOR_CONFIG_PIDS, REPORT_RATE_HINT } from './catalog/known-pids';
import { ANSI_75 } from './layouts';

const COMPX_VID = 0x3151;
export const COMPX_8K_DONGLE_VID = 0x3554;

/** Resolve a connected VID/PID to a descriptor, exact match first. */
export function resolveDescriptor(vid: number, pid: number): DeviceDescriptor | null {
  const exact = CATALOG.find((d) => d.vid === vid && d.pid === pid);
  if (exact) return exact;

  // Known Compx keyboard the vendor app recognises but we have no exact model
  // for yet: expose a generic magnetic-keyboard descriptor so it is still
  // configurable. Everything is provenance:inferred and backed up before write.
  if (vid === COMPX_VID && COMPX_VENDOR_CONFIG_PIDS.includes(pid)) {
    return genericCompxKeyboard(pid);
  }

  // Unknown Compx 8K wireless dongle (mouse side) — treat as a V8-family mouse.
  if (vid === COMPX_8K_DONGLE_VID) {
    return genericCompxMouse(pid);
  }

  return null;
}

/**
 * Correct a VID/PID resolution using the model id the firmware reports.
 *
 * VID/PID does not identify these boards: ~99 keyboards share
 * `0x3151:0x5029`, and the vendor tools disambiguate on the model id in the
 * `GET_USB_VERSION` reply. Concretely, an R86PROHE (vendor ids 2793 / 2982,
 * key layout `Common89_SG8967`) resolves by PID to the **R85HE** descriptor
 * (id 3123, `ANSI_79_SG9047`) — a different layout and key count, and since
 * every per-key magnetic/lighting/remap write is addressed by matrix `slot`,
 * those writes would land on the wrong keys.
 *
 * Returns the better descriptor, or null when the current one is already right
 * or nothing better is known (the common case). A mismatch with no catalogue
 * entry to switch to is reported separately by `modelIdConflicts` so the caller
 * can warn instead of silently trusting the wrong layout.
 */
export function resolveModelId(
  current: DeviceDescriptor,
  modelId: number,
): DeviceDescriptor | null {
  if (!modelId || modelId === 0xffffffff) return null;
  if (current.modelId === modelId) return null;
  const better = CATALOG.find((d) => d.modelId === modelId);
  if (!better || better.model === current.model) return null;
  return better;
}

/**
 * True when the device reports a model id that contradicts the descriptor we
 * resolved by VID/PID and no catalogue entry claims that id — i.e. this is a
 * board we do not actually model, wearing another model's layout.
 */
export function modelIdConflicts(current: DeviceDescriptor, modelId: number): boolean {
  if (!modelId || modelId === 0xffffffff) return false;
  if (current.modelId === undefined) return false;
  return current.modelId !== modelId && !CATALOG.some((d) => d.modelId === modelId);
}

/**
 * Unknown Compx 8K wireless dongle (mouse side): the V8 descriptor with the
 * PID swapped and demoted to `inferred`. Exported so developer mode can build
 * the same synthetic family without re-deriving it — see devices/virtual.ts.
 */
export function genericCompxMouse(pid: number): DeviceDescriptor {
  return {
    ...ATTACK_SHARK_V8,
    model: `compx-mouse-${pid.toString(16)}`,
    displayName: 'Attack Shark Mouse',
    provenance: 'inferred',
    pid,
  };
}

/** Exported for the same reason as `genericCompxMouse`. */
export function genericCompxKeyboard(pid: number): DeviceDescriptor {
  return {
    model: `compx-keyboard-${pid.toString(16)}`,
    displayName: 'Attack Shark Keyboard',
    vendor: 'Attack Shark',
    kind: 'keyboard',
    vid: COMPX_VID,
    pid,
    usagePage: 0xffff,
    usage: 0x02,
    reportLength: 65,
    transport: 'feature-report',
    // `compx-fea` (checksum at byte 2, `(0xFF - Sigma) & 0xFF`) is the scheme
    // VERIFIED against the real R85HE — the same `compx-keyboard` driver family
    // this descriptor uses. `bit7` was the pre-capture reconstruction the
    // firmware is known to reject outright (see hid/checksum.ts), so a generic
    // keyboard signed with it enumerated, showed a card, and then did nothing.
    checksum: 'compx-fea',
    driver: 'compx-keyboard',
    provenance: 'inferred',
    art: null,
    capabilities: [
      // Same SET_PROFILE/GET_PROFILE mechanism as the R85HE - see the
      // comment on `profiles` in catalog/r85he.ts.
      'profiles',
      'keyRemap',
      'fnLayer',
      'debounce',
      'perKeyLighting',
      'sideLighting',
      'pollRate',
      'macros',
      'firmwareUpdate',
      'restore',
      'autoSwitch',
    ],
    spec: {
      profileCount: 4,
      pollRates: REPORT_RATE_HINT[pid]
        ? [125, 250, 500, 1000, REPORT_RATE_HINT[pid]!]
        : [125, 250, 500, 1000],
      keyMatrix: { rows: 6, cols: 16, layout: ANSI_75 },
      lighting: { zones: ['per-key', 'side'], perKey: true },
    },
  };
}

/** Every VID we should enumerate at startup. */
export function knownVendorIds(): number[] {
  return Array.from(new Set([COMPX_VID, COMPX_8K_DONGLE_VID, ...CATALOG.map((d) => d.vid)]));
}
