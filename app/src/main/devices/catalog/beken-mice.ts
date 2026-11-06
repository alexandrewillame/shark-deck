import type { DeviceDescriptor } from '@shared/types/device';
import { readOnly } from '../identity';

/**
 * Attack Shark mice on Beken chips (VID 0x1D57): X11, X11 SE, X11 PRO V2, R1,
 * X6, X3, X3 MAX, X3 PRO (first revision), X1, X8 SE / PLUS / PRO, G3,
 * G3 PRO, V3, V3 PRO, V6.
 *
 * Shown, never driven — no driver for this platform yet, deliberately: see
 * docs/protocol/mouse-beken.md. In short: every read needs a one-shot
 * permission mailbox (report 0xA0) whose only hardware evidence is on Linux;
 * nothing shows it working on Windows, and Chromium cannot reach the
 * configuration collection at all. Reports 0x10 (bootloader — the mouse stays
 * in it across replugs) and 0x0B (unpairs the receiver) sit next to the
 * settings ones; the model byte the receiver reports is ambiguous (a real X6
 * sends R1's); and DPI encodings differ per model.
 *
 * So a card names the model where its PID is its own, and says it is not
 * supported yet. The generic receiver 0xFA60 is shared by several brands and
 * attaches nothing. provenance: ported-from-vendor (community X11 tools; PIDs
 * as linux-hardware and their authors report them).
 */

export const BEKEN_VID = 0x1d57;

/** PID -> [the name shown, the photo set]. */
const BY_PID: ReadonlyMap<number, [string, string | null]> = new Map([
  [0xfa55, ['Attack Shark X11', 'attack-shark-x11']],
  [0x2126, ['Attack Shark X8 PRO', 'attack-shark-x8']],
  [0xfa65, ['Attack Shark X8 PRO', 'attack-shark-x8']],
  [0x2111, ['Attack Shark X1', 'attack-shark-x1']],
  [0x2124, ['Attack Shark X8 PLUS', 'attack-shark-x8']],
  // the cable PID the R1, X6 and X3 share
  [0xfa61, ['Attack Shark R1 / X6 / X3', null]],
]);

/** A named, never-written card — or null for a PID that is not Attack Shark's own. */
export function bekenDescriptorFor(pid: number): DeviceDescriptor | null {
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
