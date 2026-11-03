/**
 * Diagnostics: scan results, the frame log, backups.
 *
 * Split out of the former shared/types.ts.
 */

export interface ScannedGame {
  label: string;
  exe: string;
  source: 'steam' | 'epic' | 'manual';
}

/** A currently-running process, for the Auto-Switch Processes panel's
 *  "Refresh running apps" picker — see main/profiles/processScan.ts. */
export interface RunningProcess {
  /** lowercase image name, no path — matches ProfileTrigger.exe */
  name: string;
  path: string | null;
  /** data: URL, or null if extraction failed/was skipped */
  iconDataUrl: string | null;
}

// ---------------------------------------------------------------------------
// Developer / diagnostics
// ---------------------------------------------------------------------------

export interface FrameLogEntry {
  ts: number;
  deviceId: string;
  dir: 'tx' | 'rx';
  hex: string;
  note?: string;
}

export interface BackupInfo {
  file: string;
  model: string;
  createdAt: number;
  blocks: number;
}

/** Why a connected Attack Shark collection did not become a configurable device. */
export type ScanUnmatchedReason =
  /** VID is a known Attack Shark vendor, but the PID is in neither the catalog
   *  nor the vendor-app config PID list. */
  | 'unknown-model'
  /** A descriptor resolved, but its usagePage/usage vendor collection is absent
   *  (a filter driver or the vendor app may be holding it exclusively). */
  | 'no-vendor-collection'
  /** The vendor collection was found but opening it failed with a permission
   *  error — the common case on Linux without the SharkDeck udev rule
   *  installed (see assets/linux/60-sharkdeck.rules). */
  | 'permission-denied';

/** One pass of DeviceManager.scan(), surfaced to the welcome screen so a total
 *  HID failure is not indistinguishable from "nothing plugged in". */
export interface ScanDiagnostic {
  /** every HID collection on the bus */
  totalCollections: number;
  /** collections at a known Attack Shark VID */
  vendorMatches: number;
  /** descriptors we fully resolved to a live device */
  resolved: number;
  /** message from the last `HID.devices()` throw, or null when the scan was clean */
  lastError: string | null;
  unmatched: { vid: number; pid: number; product?: string; reason: ScanUnmatchedReason }[];
}
