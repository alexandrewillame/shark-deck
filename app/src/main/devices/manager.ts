import { TRAVEL_POLL_MIN_MS } from '@shared/keyboard-travel';
import type { DeviceDescriptor, Provenance } from '@shared/types/device';
import type { ScanDiagnostic } from '@shared/types/diagnostics';
import type { LiveDevice, TravelStreamResult, WriteResult } from '@shared/types/live';
import type { Capability } from '@shared/types/capability';
import {
  profileFieldsFor,
  type ProfileField,
  type ProfileSnapshot,
  type ProfileSnapshots,
} from '@shared/types/profiles';
import { getT } from '@shared/i18n';
import { getSettingsSync } from '../settings';
import { toHex } from '../hid/frame';
import { enumerate, findVendorCollection, HidChannel, lastHidError } from '../hid/transport';
import type { HidCandidate } from '../hid/transport';
import type { DpiStage } from '@shared/types/mouse-settings';
import type { MagneticKeySettings } from '@shared/types/keyboard-settings';
import {
  COMPX_8K_DONGLE_VID,
  knownVendorIds,
  modelIdConflicts,
  resolveDescriptor,
  resolveModelId,
} from './registry';
import { Emitter } from '../emitter';
import { createDriver, Driver } from './drivers';
import { VirtualDriver, virtualDescriptors } from './virtual';
import { frameLog } from '../diagnostics';
import { listBackupFiles, writeBackup } from '../store';
import { getOnboardProfileNames, renameOnboardProfile } from './profileNames';
import { getDeviceColor, setDeviceColor } from './colors';
import { deviceStateFor } from './deviceState';
import { deviceUi } from './deviceUi';

interface Entry {
  descriptor: import('@shared/types/device').DeviceDescriptor;
  channel: HidChannel;
  driver: Driver;
  live: LiveDevice;
  lastBatteryPoll: number;
  /** true once the firmware's model id has been checked against the descriptor */
  modelIdChecked?: boolean;
  /** firmware read-back attempts so far, before falling back to slow retry */
  fwAttempts: number;
  /** last firmware attempt timestamp, once past FW_MAX_ATTEMPTS */
  lastFwAttempt: number;
  /** consecutive `ping()` failures so far — see PING_MISS_THRESHOLD */
  pingMisses: number;
  /** true once a read/write on this device has thrown what looks like an
   *  OS permission error — the common case on Linux without the SharkDeck
   *  udev rule installed (see assets/linux/60-sharkdeck.rules). The device
   *  still enumerates and resolves to a descriptor (reading the report
   *  descriptor needs no privilege), so this can only be detected here, once
   *  the driver actually tries to open and talk to it. */
  permissionError: boolean;
  /** How many times this device's channel has wedged (see HidWedgedError).
   *  Drives the reopen backoff — a wedged endpoint usually re-wedges. */
  wedges: number;
  /** Timestamp of the most recent wedge, for that backoff. */
  lastWedge: number;
  /** Last `readLiveState()` timestamp; 0 = never, which also forces the next
   *  due pass to poll (see `liveDue`). */
  lastLivePoll: number;
  /** The stage table the DPI *number* is derived from, so the live poll itself
   *  never has to re-read it. Cleared whenever it might have changed. */
  liveStages: DpiStage[] | null;
  /** True once `readLiveState()` has been attempted at all. Kept separate from
   *  `lastLivePoll`, which is reset to 0 to FORCE a poll (after a profile
   *  switch) — inferring "first attempt" from that would make a later null
   *  latch `liveUnsupported` and silently switch monitoring off. */
  liveProbed: boolean;
  /** Latched when this driver's very first `readLiveState()` returns null —
   *  i.e. it has no cheap probe. A *later* null is a dozing device, not an
   *  unsupported driver, so only the first one latches. */
  liveUnsupported: boolean;
}

/** node-hid surfaces hidapi's own text, not a typed error — "cannot open
 *  device with path …: " plus the OS's reason — so match on that: Linux says
 *  "Permission denied" (EACCES); macOS's IOKit says "(iokit/common) not
 *  permitted" or "privilege violation", or "exclusive access" when another
 *  program has seized the device. */
function looksLikePermissionError(err: unknown): boolean {
  const msg = String((err as Error)?.message ?? err ?? '');
  return /EACCES|permission|denied|insufficient|not permitted|privilege|exclusive access/i.test(
    msg,
  );
}

/** Give the firmware query a few quick tries — a device can be mid-wake on first scan. */
const FW_MAX_ATTEMPTS = 8;
/** After the quick tries are used up, keep retrying but only this often, so a
 *  permanently-null firmware is never cached for good. */
const FW_SLOW_RETRY_MS = 30_000;
/**
 * Consecutive `ping()` failures required before flipping a device to
 * offline. Only matters for the V8 mouse's stricter ping() (see its
 * class doc comment) — a single missed status reply on a scan tick would
 * otherwise flicker the card offline/online, which the old "did the dongle
 * answer at all" check never did (the dongle answers near-perfectly
 * reliably; the mouse's own radio link is the noisier part now that it's
 * what's actually being checked).
 */
const PING_MISS_THRESHOLD = 4;

/**
 * Reopen backoff after a wedge, and the point at which we stop trying.
 *
 * A cap is not optional. hidapi opens with FILE_SHARE_READ|FILE_SHARE_WRITE,
 * so a reopen *succeeds* while the old IRP is still pending — and the new
 * handle talks to the same wedged endpoint and wedges again, each attempt
 * stranding another libuv threadpool slot forever. Reopening on every 2.5s
 * scan tick would burn all 8 of them in about 20 seconds, which is a worse
 * bug than the one this is fixing. The device docs are clear that only a
 * power-cycle or replug clears this firmware state; re-enumeration builds a
 * fresh entry and resets the count.
 */
const WEDGE_BACKOFF_MS = 5_000;
const WEDGE_BACKOFF_MAX_MS = 60_000;
const WEDGE_GIVE_UP = 4;

/**
 * Live-travel sample cadence, and the floor for any slower rate a consumer
 * asks for. One sample is a whole paced magnetism-page read (~140ms), so this
 * is a floor rather than a spare-time poll — see `startTravel`.
 *
 * At this rate a sample is ~27 feature writes/sec sustained, which is the
 * traffic FINDINGS-R85HE.md's "endpoint lockup" note says wedges MI_02 (and
 * only a replug clears). Fine for the seconds someone spends watching one
 * key; not fine for the minutes a full calibration pass takes, which is why
 * `startTravel` takes an `intervalMs` and the SLOWEST request wins.
 */
const TRAVEL_POLL_MS = TRAVEL_POLL_MIN_MS;

/** Consecutive failed samples before the stream gives up rather than
 *  hammering a board that has stopped answering. */
const TRAVEL_MISS_GIVE_UP = 8;

/**
 * How often to re-read the state an on-device button can change (DPI stage,
 * poll rate), while a device's config screen is the active tab.
 *
 * Effective cadence is `max(scanIntervalMs, this)` — the poll runs inside a
 * scan pass rather than on a timer of its own, so the two were halved
 * together.
 *
 * Only while it is watched: nothing polls in the background. The values exist
 * to keep an open screen honest, and idle radio traffic to a mouse that may be
 * dozing buys nothing when nobody is looking. `setLiveWatch` is what arms it.
 */
const LIVE_POLL_MS = 1_500;
/**
 * Quiet period after a write before the live poll may run again.
 *
 * Without it the poll races the user: a read that started before their write
 * lands after it and pushes the old value back into the UI they just changed.
 * Stamped from `guardedWrite` in main/ipc.ts, which every mutating path
 * already funnels through (CLAUDE.md invariant #1), so no write can bypass it.
 */
const LIVE_WRITE_QUIET_MS = 750;

/**
 * The stored colour pick, validated against the descriptor's current variants.
 *
 * The stored id is written per model by devices/colors.ts and survives app
 * updates, so a variant that gets renamed in the catalogue (the R85HE's
 * `black` -> `green`, whose photo was always the green board) would otherwise
 * leave the user pinned to an id nothing answers to — `resolveDeviceArt` finds
 * no entry and falls back to the generic silhouette. Falling back to the
 * catalogue default keeps a real product photo on the card, and the next
 * explicit pick overwrites the stale value on disk.
 */
function resolveColorVariant(descriptor: DeviceDescriptor, stored: string | null): string | null {
  const variants = descriptor.colorVariants ?? [];
  if (stored && variants.some((v) => v.id === stored)) return stored;
  return variants[0]?.id ?? null;
}

/**
 * Is the receiver present while the device behind it is not?
 *
 * There is no separate dongle card to read this off — both endpoints of one
 * device collapse into a single entry (see `key`/`prefersEndpoint`) — so it
 * is derived: a wireless entry that is still enumerated and holding an open
 * channel, yet failing its liveness probe, is a receiver whose mouse has gone
 * away. An entry that stopped enumerating entirely is pruned, so its mere
 * existence is the "receiver is plugged in" signal.
 */
function receiverOnline(wireless: boolean, online: boolean, channelOpen: boolean): boolean {
  return wireless && !online && channelOpen;
}

/**
 * What the host decides, set once with `deviceManager.configure()` before
 * `start()` — main/index.ts on the desktop, web/main.ts in the browser
 * edition. The defaults are the conservative values, so a host that forgets
 * the call ships no developer aids.
 */
export interface ManagerConfig {
  /** Developer mode may add the simulated devices. Desktop: unpackaged builds only. */
  allowSimulated: boolean;
  /** Show developer-only card notes (the "protocol inferred" hint). Desktop: unpackaged builds only. */
  showDevNotes: boolean;
  /** A `process.platform`-style OS name. Picks the advice a refused open gets. */
  os: string;
  /**
   * How a device that reports no USB serial is keyed. `'path'` keys it by its
   * endpoint (the desktop; the R85HE reports an empty serial). `'model'` keys
   * it by model — for WebHID, which exposes no serial at all, so the V8's
   * dongle and cable still collapse into one card through the cable-preferred
   * handover in `scan()`.
   */
  serialless: 'path' | 'model';
}

const DEFAULT_CONFIG: ManagerConfig = {
  allowSimulated: false,
  showDevNotes: false,
  os: 'unknown',
  serialless: 'path',
};

function hint(
  config: ManagerConfig,
  kind: string,
  online: boolean,
  wireless: boolean,
  battery: number | null,
  provenance: Provenance,
  permissionError: boolean,
  simulated?: boolean,
): string | null {
  const settings = getSettingsSync();
  const t = getT(settings.language);
  const Kind = `${kind[0]!.toUpperCase()}${kind.slice(1)}`;
  // Takes precedence over every other hint: a simulated card must never be
  // mistaken for hardware that is actually attached.
  if (simulated) return t('hint.simulated');
  if (!online && permissionError) {
    // The udev rule is the Linux answer. On macOS and Windows a refused open
    // means another program holds the device (the vendor's software, most
    // often) — the rule would be advice about nothing they have.
    return t(
      config.os === 'darwin'
        ? 'hint.offlinePermission.mac'
        : config.os === 'win32'
          ? 'hint.offlinePermission.win'
          : 'hint.offlinePermission',
    );
  }
  if (!online && (kind === 'mouse' || kind === 'keyboard')) {
    return wireless ? t('hint.offlineWireless', { kind }) : t('hint.offlineWired', { Kind });
  }
  // 0 means the low-battery warning is turned off (see set.lowBattery in
  // AppSettings).
  const threshold = settings.batteryLowThreshold;
  if (online && wireless && battery !== null && threshold > 0 && battery <= threshold) {
    return t('hint.batteryLow', { pct: battery });
  }
  // "not in the verified catalog yet — settings are best-effort" is a note
  // about how much of the protocol we have confirmed, which is developer
  // information: it names no problem the user can act on, and on a card it
  // reads as "this device is half-supported". Unpackaged builds only, matching
  // DevNote in the renderer.
  if (provenance === 'inferred' && config.showDevNotes) {
    return t('hint.inferred');
  }
  return null;
}

/** The endpoint-based device id: what a serial-less device is keyed by on the desktop. */
function pathKey(descriptor: DeviceDescriptor, path: string): string {
  return `${descriptor.vid.toString(16)}:${descriptor.pid.toString(16)}:${path}`;
}

const EMPTY_DIAGNOSTIC: ScanDiagnostic = {
  totalCollections: 0,
  vendorMatches: 0,
  resolved: 0,
  lastError: null,
  unmatched: [],
};

export class DeviceManager extends Emitter {
  private entries = new Map<string, Entry>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private config: ManagerConfig = DEFAULT_CONFIG;
  /** Set by `pause()`: no scan is scheduled, but nothing is dropped either. */
  private paused = false;
  /**
   * Presence/profile poll cadence — and the floor on everything that rides the
   * same pass, including the live DPI/poll-rate read (see LIVE_POLL_MS).
   *
   * Halved from 2500ms: a change made on the device — the DPI button, the
   * profile button, a rate switch — took up to a full scan tick plus a live
   * tick to show up, which read as sluggish. The extra cost is one `0x03` ping
   * and one `0x0E` profile read per device per tick, both single frames; the
   * expensive reads are all gated behind their own longer intervals
   * (battery 60s) or the watch flag.
   */
  private readonly scanIntervalMs = 1250;
  private readonly batteryIntervalMs = 60_000;
  private diagnostic: ScanDiagnostic = EMPTY_DIAGNOSTIC;
  /** Guards against a pass resurrecting entries after `stop()` clears them —
   *  now that HID I/O is async, a scan already in flight when `stop()` runs
   *  can otherwise finish and re-populate `entries` after `stop()` returns. */
  private stopped = false;
  /** True while a `scan()` pass is actually running. `nudgeScan()` sets
   *  `rescanRequested` instead of forking a second `setTimeout` chain when one
   *  is in flight — two chains would race to create/refresh the same entries
   *  and drive one `HidChannel` from two places. */
  private scanning = false;
  private rescanRequested = false;

  /** Set the host's choices — see `ManagerConfig`. Call before `start()`. */
  configure(patch: Partial<ManagerConfig>): void {
    this.config = { ...this.config, ...patch };
  }

  start(): void {
    this.stopped = false;
    this.paused = false;
    this.scheduleNextScan(0);
  }

  /**
   * Stop polling without forgetting anything — unlike `stop()`, which drops
   * every entry and with it every open device tab. The browser edition pauses
   * while its tab is hidden: Chromium throttles a hidden tab's timers to once
   * a second or slower, so polling there would only stretch each exchange out.
   * A write already in flight is not part of the scan and runs to completion.
   */
  pause(): void {
    this.paused = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  /** Undo `pause()` with an immediate pass, so the cards catch up at once. */
  resume(): void {
    if (!this.paused) return;
    this.paused = false;
    if (this.stopped) return;
    if (this.scanning) this.rescanRequested = true;
    else this.scheduleNextScan(0);
  }

  /** Self-scheduling `setTimeout` chain, not `setInterval` — the next pass is
   *  only scheduled once the previous one (including all its now-async HID
   *  reads) has actually finished, so passes can never pile up on top of each
   *  other. Two truly concurrent passes would race to create/refresh the same
   *  entries and drive the same channel from two places at once. */
  private scheduleNextScan(delayMs: number): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.scanning = true;
      void this.scan()
        // A pass that throws must not end the chain, or become an unhandled
        // rejection — the renderer turns those into an error toast, and this
        // fires every tick. `hint()` runs outside the per-entry try, so one
        // bad device can reach here.
        .catch((err) => console.error('[devices] scan pass failed:', err))
        .finally(() => {
          this.scanning = false;
          if (this.stopped || this.paused) return;
          // A nudge that arrived mid-scan runs immediately; otherwise wait out
          // the normal tick. Either way there is exactly one pending timer.
          const next = this.rescanRequested ? 0 : this.scanIntervalMs;
          this.rescanRequested = false;
          this.scheduleNextScan(next);
        });
    }, delayMs);
  }

  /** Re-run the scan now instead of waiting out the rest of the 2.5s tick —
   *  used when a setting that changes what the scan produces (developer mode)
   *  is toggled, so the grid reacts immediately. */
  nudgeScan(): void {
    if (this.stopped || this.paused) return;
    if (this.scanning) {
      // Don't fork a second timer chain on top of the in-flight scan's own
      // `finally` reschedule — just tell that reschedule to fire at once.
      this.rescanRequested = true;
      return;
    }
    this.scheduleNextScan(0);
  }

  stop(): void {
    this.stopped = true;
    this.rescanRequested = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    // A start still waiting on the board's answer has no timer yet.
    const streams = new Set([...this.travelTimers.keys(), ...this.travelStarts.keys()]);
    for (const id of streams) this.stopTravel(id, true, { force: true });
    for (const e of this.entries.values()) void e.channel.close();
    this.entries.clear();
  }

  list(): LiveDevice[] {
    return [...this.entries.values()].map((e) => e.live);
  }

  getDiagnostic(): ScanDiagnostic {
    return this.diagnostic;
  }

  getDriver(deviceId: string): Driver | null {
    return this.entries.get(deviceId)?.driver ?? null;
  }

  getDescriptor(deviceId: string) {
    return this.entries.get(deviceId)?.descriptor ?? null;
  }

  /** Which onboard slot this device is on right now, as the manager last saw
   *  it — what a per-profile setting has to be recorded against. */
  getActiveProfile(deviceId: string): number | null {
    return this.entries.get(deviceId)?.live.activeProfile ?? null;
  }

  /** Rename one onboard profile slot for every live entry of this model — see devices/profileNames.ts. */
  async setProfileName(model: string, slot: number, name: string): Promise<LiveDevice[]> {
    const names = await renameOnboardProfile(model, slot, name);
    for (const e of this.entries.values()) {
      if (e.descriptor.model === model) e.live.profileNames = names;
    }
    this.emitChanged();
    return this.list();
  }

  /** Set the cosmetic colour/edition choice for every live entry of this model — see devices/colors.ts. */
  async setColor(model: string, variantId: string | null): Promise<LiveDevice[]> {
    const chosen = await setDeviceColor(model, variantId);
    for (const e of this.entries.values()) {
      // Clearing the stored pick falls back to the catalogue default, not to
      // null — null is the silhouette, and "no pick" is not "no photo".
      if (e.descriptor.model === model) {
        e.live.colorVariant = resolveColorVariant(e.descriptor, chosen);
      }
    }
    this.emitChanged();
    return this.list();
  }

  /**
   * Recompute `hasBackup` from what is actually on disk.
   *
   * `ensureBackup` only ever sets the flag TRUE (and the attach path computes
   * it once), so a deleted backup would leave a card claiming a restore point
   * it no longer has until the device next re-attached.
   */
  async refreshBackupState(deviceId: string): Promise<void> {
    const e = this.entries.get(deviceId);
    if (!e) return;
    const hasBackup = e.descriptor.simulated
      ? false
      : (await listBackupFiles(e.descriptor.model)).length > 0;
    if (hasBackup === e.live.hasBackup) return;
    e.live.hasBackup = hasBackup;
    this.emitChanged();
  }

  /** Take a one-time full backup before the first write to a device. */
  async ensureBackup(deviceId: string): Promise<boolean> {
    const e = this.entries.get(deviceId);
    if (!e) return false;
    // A simulated device has nothing to back up, and the backup store is keyed
    // by model — a file written here would be reported as a backup of real
    // hardware of this model. (VirtualDriver.backup() returns no blocks, so
    // this is belt-and-braces, but it should not depend on that.)
    if (e.descriptor.simulated) return false;
    const existing = await listBackupFiles(e.descriptor.model);
    if (existing.length > 0) {
      e.live.hasBackup = true;
      return true;
    }
    try {
      const blocks = await e.driver.backup();
      if (Object.keys(blocks).length === 0) return false;
      await writeBackup(e.descriptor.model, e.channel.deviceKey, blocks);
      e.live.hasBackup = true;
      this.emitChanged();
      return true;
    } catch {
      return false;
    }
  }

  /**
   * One physical device, one entry — even when it enumerates on more than one
   * endpoint.
   *
   * The V8 is `3554:F517` through its 8K dongle and `3554:F515` over USB-C,
   * with the same serial and the same onboard memory. Keying on VID/PID gave
   * it two cards, and once the cable is in the dongle stops relaying, so one
   * of those two was a dead menu that showed nothing. Keying on model+serial
   * instead collapses them: `adoptEndpoint` below then picks whichever
   * endpoint is actually carrying the traffic.
   *
   * A device with no serial (the R85HE reports an empty one) has nothing to
   * correlate on, so it keeps the path-based key and is unaffected. Two
   * physically distinct units reporting the SAME serial would merge.
   *
   * Under WebHID nothing has a serial, so the browser edition keys serial-less
   * devices by model instead (`serialless: 'model'`), which merges the V8's
   * two endpoints the same way. The cost is that two identical units would
   * share one card — and `findVendorCollection` only ever attaches the first
   * unit of a VID/PID anyway, on either host.
   */
  private key(descriptor: DeviceDescriptor, serial: string, path: string): string {
    if (serial) return `${descriptor.model}:${serial}`;
    if (this.config.serialless === 'model') return descriptor.model;
    return pathKey(descriptor, path);
  }

  /**
   * Should `candidate` take over an entry currently driven by `current`?
   *
   * Cable wins. When the mouse is plugged in over USB-C it stops talking to
   * its dongle, so the wireless endpoint is the stale one no matter that it
   * still enumerates.
   */
  private static prefersEndpoint(current: DeviceDescriptor, candidate: DeviceDescriptor): boolean {
    return candidate.wired === true && current.wired !== true;
  }

  /** Point an existing entry at a different endpoint of the same device,
   *  keeping everything the UI already knows about it. */
  private async adoptEndpoint(
    entry: Entry,
    id: string,
    vc: HidCandidate,
    descriptor: DeviceDescriptor,
  ): Promise<void> {
    const prev = entry.live;
    void entry.channel.close();
    entry.descriptor = descriptor;
    entry.channel = this.newChannel(id, vc, descriptor);
    entry.driver = createDriver({
      descriptor,
      channel: entry.channel,
      onWarning: (message) => this.emit('write:warning', { deviceId: id, message }),
      state: deviceStateFor(descriptor.model),
    });
    entry.pingMisses = 0;
    entry.permissionError = false;
    entry.wedges = 0;
    // The endpoint decides connection/wireless/capabilities/ui; everything the
    // device itself told us carries across, so the card doesn't blank out.
    const fresh = await this.newLiveDevice(id, descriptor);
    entry.live = {
      ...fresh,
      online: prev.online,
      battery: prev.battery,
      charging: prev.charging,
      batteryRaw: prev.batteryRaw,
      batteryMillivolts: prev.batteryMillivolts,
      activeProfile: prev.activeProfile,
      activeDpiStage: prev.activeDpiStage,
      activeDpi: prev.activeDpi,
      pollRate: prev.pollRate,
      colorVariant: prev.colorVariant,
      profileNames: prev.profileNames,
    };
    // Firmware belongs to the endpoint, not the device — the dongle reports
    // its own version and the cable reports the mouse's. Re-read rather than
    // carry the previous one across.
    entry.live.firmware = null;
    entry.fwAttempts = 0;
    entry.lastFwAttempt = 0;
    entry.liveStages = null;
    entry.liveProbed = false;
    entry.liveUnsupported = false;
  }

  /** The renderer-facing snapshot for a freshly-attached device. Shared by the
   *  real scan path and developer mode so the two cannot drift. */
  /**
   * Re-resolve an attached device once its firmware tells us what it actually
   * is, and swap the descriptor if VID/PID got it wrong.
   *
   * Runs at most once per entry (`modelIdChecked`). The driver is rebuilt on
   * the SAME channel because `descriptor.driver` may differ between the two
   * models, and the live device is rebuilt for its static fields with the
   * runtime state carried across so the card does not blink offline.
   */
  private async applyModelId(e: Entry, modelId: number): Promise<void> {
    if (e.modelIdChecked) return;
    e.modelIdChecked = true;

    if (modelIdConflicts(e.descriptor, modelId)) {
      // Known-wrong but nothing better to switch to: say so rather than let the
      // UI present another model's key layout as fact.
      this.emit('write:warning', {
        deviceId: e.live.id,
        message:
          `This keyboard reports model id ${modelId}, but it is attached as ` +
          `"${e.descriptor.displayName}" (id ${e.descriptor.modelId}) because they share a USB id. ` +
          `Per-key settings may address the wrong keys.`,
      });
      return;
    }

    const better = resolveModelId(e.descriptor, modelId);
    if (!better) return;

    const prev = e.live;
    e.descriptor = better;
    e.driver = createDriver({
      descriptor: better,
      channel: e.channel,
      onWarning: (message) => this.emit('write:warning', { deviceId: prev.id, message }),
      state: deviceStateFor(better.model),
    });
    const live = await this.newLiveDevice(prev.id, better);
    // carry runtime state across the swap
    e.live = {
      ...live,
      online: prev.online,
      battery: prev.battery,
      charging: prev.charging,
      batteryRaw: prev.batteryRaw,
      batteryMillivolts: prev.batteryMillivolts,
      activeProfile: prev.activeProfile,
      activeDpiStage: prev.activeDpiStage,
      activeDpi: prev.activeDpi,
      pollRate: prev.pollRate,
      firmware: prev.firmware,
      connection: prev.connection,
      wireless: prev.wireless,
    };
  }

  private async newLiveDevice(id: string, descriptor: DeviceDescriptor): Promise<LiveDevice> {
    return {
      id,
      model: descriptor.model,
      displayName: descriptor.displayName,
      kind: descriptor.kind,
      vid: descriptor.vid,
      pid: descriptor.pid,
      // `descriptor.wired` wins over both derivations. The V8 uses the SAME
      // vendor id for its dongle and its USB-C endpoint, so the VID/PID pair
      // cannot tell them apart — without this a cabled mouse showed up as a
      // 2.4 GHz device with a battery pill it has no battery for.
      connection: descriptor.wired
        ? 'usb'
        : descriptor.vid === COMPX_8K_DONGLE_VID
          ? '2.4g'
          : 'usb',
      wireless: descriptor.wired
        ? false
        : descriptor.kind === 'mouse' || descriptor.vid === COMPX_8K_DONGLE_VID,
      online: false,
      // Set on the first refresh, once a liveness probe has actually run.
      receiverOnline: false,
      battery: null,
      charging: false,
      batteryRaw: null,
      batteryMillivolts: null,
      activeProfile: null,
      activeDpiStage: null,
      activeDpi: null,
      pollRate: null,
      profileNames: await getOnboardProfileNames(descriptor.model),
      firmware: null,
      capabilities: descriptor.capabilities,
      provenance: descriptor.provenance,
      art: descriptor.art,
      // Any model with catalogue art falls back to its first colour variant, so
      // a device shows its real product photo from the moment it attaches
      // instead of the generic silhouette (resolveDeviceArt needs a variant id
      // to find one, and every current descriptor leaves the legacy single-image
      // `art` field null). The user's own pick, once made, always wins.
      colorVariant: resolveColorVariant(descriptor, await getDeviceColor(descriptor.model)),
      hint: null,
      hasBackup: descriptor.simulated
        ? false
        : (await listBackupFiles(descriptor.model)).length > 0,
      ui: deviceUi(descriptor),
    };
  }

  private newChannel(id: string, vc: HidCandidate, descriptor: DeviceDescriptor): HidChannel {
    return new HidChannel(
      vc,
      (dir, _deviceKey, hex, note) => frameLog.push({ deviceId: id, dir, hex, note }),
      descriptor.transport,
      descriptor.checksum,
      {
        onWedged: (reason) => this.onChannelWedged(id, reason),
        // Feature-report boards are the ones that lock up under a burst; 30ms
        // matches the drivers' own `settleMs`. The output-report path is
        // natively bounded and stays unpaced.
        requestPaceMs: descriptor.transport === 'feature-report' ? 30 : 0,
      },
    );
  }

  /**
   * A channel blew a native-call deadline: the handle is dead and the device
   * has stopped answering. Take the card offline **now** rather than after
   * PING_MISS_THRESHOLD more ticks — that threshold exists to absorb a single
   * dropped reply, and this is not a dropped reply. Waiting four more 2.5s
   * ticks is exactly the spinning-UI symptom being fixed.
   */
  private onChannelWedged(deviceId: string, reason: string): void {
    const e = this.entries.get(deviceId);
    if (!e) return;
    e.wedges++;
    e.lastWedge = Date.now();
    e.pingMisses = PING_MISS_THRESHOLD;
    e.live.online = false;
    e.live.receiverOnline = receiverOnline(e.live.wireless, false, e.channel.isOpen());
    this.stopTravel(deviceId, false, { force: true });
    e.live.hint = hint(
      this.config,
      e.live.kind,
      false,
      e.live.wireless,
      e.live.battery,
      e.live.provenance,
      e.permissionError,
      e.descriptor.simulated,
    );
    this.emit('write:warning', {
      deviceId,
      message: `${e.live.displayName} stopped responding and had to be disconnected (${reason}). Unplug and replug it if it does not come back.`,
    });
    this.emitChanged();
  }

  /**
   * Whether `scan()` may rebuild a disposed channel yet. An ordinary
   * `close()` (the offline-handle release in `refreshEntry`) reopens at once;
   * a wedge backs off exponentially and eventually gives up. See
   * WEDGE_BACKOFF_MS.
   */
  private mayReopen(e: Entry): boolean {
    // The count is cleared two ways, both of which correspond to the device
    // actually recovering: `refreshEntry` zeroes it the moment a ping answers,
    // and a physical replug drops the device out of enumeration, so the prune
    // sweep at the end of `scan()` deletes the entry entirely and the replugged
    // board gets a fresh one. Since the firmware notes say only a power-cycle
    // clears this state, giving up until one of those happens is the honest
    // behaviour rather than a retry loop stranding a handle per attempt.
    if (e.wedges === 0) return true;
    if (e.wedges >= WEDGE_GIVE_UP) return false;
    const wait = Math.min(WEDGE_BACKOFF_MS * 2 ** (e.wedges - 1), WEDGE_BACKOFF_MAX_MS);
    return Date.now() - e.lastWedge >= wait;
  }

  private async scan(): Promise<void> {
    const seen = new Set<string>();
    let changed = false;

    // One native enumeration per pass; filter to the Attack Shark VIDs here.
    const vendorIds = new Set(knownVendorIds());
    const allCollections = await enumerate();
    if (this.stopped) return;
    const vendorCollections = allCollections.filter((c) => vendorIds.has(c.vendorId));

    const diag: ScanDiagnostic = {
      totalCollections: allCollections.length,
      vendorMatches: vendorCollections.length,
      resolved: 0,
      lastError: lastHidError(),
      unmatched: [],
    };
    const flagged = new Set<number>(); // vid<<16|pid already recorded in `unmatched`

    for (const cand of vendorCollections) {
      const descriptor = resolveDescriptor(cand.vendorId, cand.productId);
      const dedupe = (cand.vendorId << 16) | cand.productId;
      if (!descriptor) {
        if (!flagged.has(dedupe)) {
          flagged.add(dedupe);
          diag.unmatched.push({
            vid: cand.vendorId,
            pid: cand.productId,
            product: cand.product,
            reason: 'unknown-model',
          });
        }
        continue;
      }
      const vc = findVendorCollection(
        allCollections,
        descriptor.vid,
        descriptor.pid,
        descriptor.usagePage,
        descriptor.usage,
      );
      if (!vc) {
        if (!flagged.has(dedupe)) {
          flagged.add(dedupe);
          diag.unmatched.push({
            vid: cand.vendorId,
            pid: cand.productId,
            product: cand.product,
            reason: 'no-vendor-collection',
          });
        }
        continue;
      }

      const id = this.key(descriptor, vc.serialNumber ?? '', vc.path);
      const existing = this.entries.get(id);
      // Both endpoints of one device resolve to the same id, so the usual
      // "already handled this pass" skip would drop the second one before it
      // ever got a chance to take over. Let a PREFERRED endpoint through.
      if (
        seen.has(id) &&
        !(existing && DeviceManager.prefersEndpoint(existing.descriptor, descriptor))
      )
        continue;
      seen.add(id);
      diag.resolved++;

      // A disposed channel can never be used again (see `HidChannel.close`),
      // so an entry holding one needs a fresh channel + driver built against
      // the collection we just enumerated. This is how a device that stopped
      // answering — and had its handle released by `refreshEntry` — comes back
      // without the entry (and its card) ever disappearing.
      if (existing?.channel.isDisposed() && this.mayReopen(existing)) {
        // Rebuild against the collection we just enumerated — which may be a
        // DIFFERENT endpoint than the one that died (unplug the cable and the
        // dongle is what is left), so adopt its descriptor too rather than
        // driving a USB-C descriptor over a 2.4 GHz channel.
        await this.adoptEndpoint(existing, id, vc, descriptor);
        changed = true;
      } else if (existing && DeviceManager.prefersEndpoint(existing.descriptor, descriptor)) {
        // Both endpoints of one device are enumerated this pass; the cable
        // takes over from the dongle.
        await this.adoptEndpoint(existing, id, vc, descriptor);
        changed = true;
      } else if (!existing) {
        const channel = this.newChannel(id, vc, descriptor);
        const driver = createDriver({
          descriptor,
          channel,
          onWarning: (message) => this.emit('write:warning', { deviceId: id, message }),
          state: deviceStateFor(descriptor.model),
        });
        const live = await this.newLiveDevice(id, descriptor);
        this.entries.set(id, {
          descriptor,
          channel,
          driver,
          live,
          lastBatteryPoll: 0,
          lastLivePoll: 0,
          liveStages: null,
          liveProbed: false,
          liveUnsupported: false,
          fwAttempts: 0,
          lastFwAttempt: 0,
          pingMisses: 0,
          permissionError: false,
          wedges: 0,
          lastWedge: 0,
        });
        changed = true;
      }

      const entry = this.entries.get(id)!;
      if (await this.refreshEntry(entry)) changed = true;
    }

    // `devMode` is a developer aid, and its Settings row only renders in an
    // unpackaged build (see AppSettings.tsx) — but the *setting* persists in
    // the shared userData config, so a flag left on during development would
    // otherwise follow the user into a packaged build, where there is no
    // longer any row to turn it back off. Gate on the build itself so the
    // setting really is inert once packaged, as documented.
    if (this.config.allowSimulated && getSettingsSync().devMode && !this.stopped) {
      if (await this.scanVirtual(seen)) changed = true;
    }

    // Prune vanished devices.
    //
    // Order and awaiting both matter. `stopTravel` must NOT try to notify a
    // device that is already gone: that queues a write on the channel, which
    // used to run after `close()` and re-open the HID handle — and since the
    // entry is deleted immediately below, nothing could ever close it again.
    // A leaked handle blocks the next `HIDAsync.open()` on the same path on
    // Windows, so a replugged keyboard was never re-detected until restart.
    // `close()` is bounded by its own timeout, so awaiting it cannot stall the
    // scan chain.
    for (const [id, e] of this.entries) {
      if (!seen.has(id)) {
        this.stopTravel(id, false, { force: true });
        await e.channel.close();
        this.entries.delete(id);
        changed = true;
      }
    }

    if (JSON.stringify(this.diagnostic) !== JSON.stringify(diag)) {
      this.diagnostic = diag;
      this.emit('scan:diagnostic', diag);
    }
    if (changed) this.emitChanged();
  }

  /**
   * Developer mode: one simulated device per supported shape, so the grid and
   * every config tab are reachable with no hardware attached (see
   * devices/virtual.ts).
   *
   * Deliberately part of the normal scan pass rather than a side channel:
   * adding each id to `seen` is the whole lifecycle. When the setting goes
   * false this is skipped, the ids are absent from `seen`, and the prune sweep
   * below removes the entries and emits `devices:changed` — no teardown code
   * of its own, and the renderer closes the orphaned tabs itself.
   */
  private async scanVirtual(seen: Set<string>): Promise<boolean> {
    let changed = false;
    for (const descriptor of virtualDescriptors()) {
      // No serial: simulated devices are per-descriptor on purpose — developer
      // mode exists to put every supported *shape* on screen at once, including
      // both endpoints of a device that real hardware would merge into one.
      // So always the endpoint key, whatever `serialless` says.
      const id = pathKey(descriptor, `sim-${descriptor.model}`);
      if (seen.has(id)) continue;
      seen.add(id);

      if (!this.entries.has(id)) {
        // A real channel over a candidate that is never opened: HidChannel
        // connects lazily on its first I/O, and VirtualDriver overrides every
        // method that would reach it, so no HID handle is ever created. Using
        // the real class keeps `Entry` (and stop()/prune, which call close())
        // unchanged — close() on an unopened channel is a no-op.
        const channel = new HidChannel(
          {
            path: `virtual:${descriptor.model}`,
            vendorId: descriptor.vid,
            productId: descriptor.pid,
            interface: -1,
            serialNumber: `sim-${descriptor.model}`,
          },
          (dir, _deviceKey, hex, note) => frameLog.push({ deviceId: id, dir, hex, note }),
          descriptor.transport,
          descriptor.checksum,
        );
        // Not createDriver(): the descriptor keeps its real driver key so the
        // rest of the app (MACRO_LIMITS, capability gating) behaves normally,
        // but instantiating that real driver would drive a live protocol at a
        // dead channel.
        const driver = new VirtualDriver({
          descriptor,
          channel,
          onWarning: (message) => this.emit('write:warning', { deviceId: id, message }),
        });
        this.entries.set(id, {
          descriptor,
          channel,
          driver,
          live: await this.newLiveDevice(id, descriptor),
          lastBatteryPoll: 0,
          lastLivePoll: 0,
          liveStages: null,
          liveProbed: false,
          liveUnsupported: false,
          fwAttempts: 0,
          lastFwAttempt: 0,
          pingMisses: 0,
          permissionError: false,
          wedges: 0,
          lastWedge: 0,
        });
        changed = true;
      }

      if (await this.refreshEntry(this.entries.get(id)!)) changed = true;
    }
    return changed;
  }

  private async refreshEntry(e: Entry): Promise<boolean> {
    // Deep snapshot: a shallow `{ ...e.live }` shares nested objects
    // (`profileNames`, `firmware`, …) with the live copy, so an in-place
    // nested mutation would be invisible to the JSON diff at the end.
    const prev = JSON.stringify(e.live);
    try {
      // `ping()` is a driver-chosen liveness probe (defaults to a profile
      // read, but the V8 mouse overrides it — see CompxMouse8K.ping — because
      // its profile GET is documented best-effort). Gating battery/firmware
      // polling on the profile read meant one flaky probe silenced both.
      const pinged = (await e.driver.ping()) || e.descriptor.kind === 'dongle';
      if (pinged) {
        e.pingMisses = 0;
        // Answering again means whatever wedged it is gone — usually a
        // replug, which is the only thing the firmware notes say clears it.
        e.wedges = 0;
        e.permissionError = false;
        e.live.online = true;
      } else {
        e.pingMisses++;
        // A miss doesn't immediately flip the card offline — require
        // PING_MISS_THRESHOLD in a row first, so a single dropped scan tick
        // doesn't flicker it. (Quick to recover, slower to declare down.)
        if (e.pingMisses >= PING_MISS_THRESHOLD) e.live.online = false;
      }
      const online = e.live.online;
      if (online) {
        const profile = await e.driver.getActiveProfile();
        // A profile switch replaces the whole per-profile block, so whatever
        // the live poll last derived is stale: drop the cached stage table and
        // make the poll below run in this same pass rather than up to
        // LIVE_POLL_MS later.
        if (profile !== null && profile !== e.live.activeProfile) {
          e.lastLivePoll = 0;
          e.liveStages = null;
          e.live.activeDpi = null;
        }
        e.live.activeProfile = profile ?? e.live.activeProfile;
      }

      const now = Date.now();
      if (this.liveDue(e, now)) await this.pollLiveState(e, now);
      if (online && now - e.lastBatteryPoll > this.batteryIntervalMs) {
        const bat = await e.driver.getBattery();
        e.live.battery = bat.level;
        e.live.charging = bat.charging;
        e.live.batteryRaw = bat.raw ?? null;
        e.live.batteryMillivolts = bat.millivolts ?? null;
        e.lastBatteryPoll = now;
        if (bat.level !== null)
          this.emit('device:battery', {
            id: e.live.id,
            battery: bat.level,
            charging: bat.charging,
          });
      }
      // getFirmware() returns an object even on total failure, so keep
      // retrying while the device version is still unknown, instead of
      // caching the first miss forever. Quick tries every scan tick while
      // under FW_MAX_ATTEMPTS (a device can be mid-wake on first scan), then
      // back off to one attempt per FW_SLOW_RETRY_MS so a persistently-null
      // firmware doesn't get queried every 2.5s indefinitely.
      const fwUnknown = !e.live.firmware || e.live.firmware.device === null;
      const fwDue = e.fwAttempts < FW_MAX_ATTEMPTS || now - e.lastFwAttempt > FW_SLOW_RETRY_MS;
      if (online && fwUnknown && fwDue) {
        if (e.fwAttempts < FW_MAX_ATTEMPTS) e.fwAttempts++;
        e.lastFwAttempt = now;
        const fw = await e.driver.getFirmware();
        if (fw && (fw.device !== null || fw.receiver !== null)) {
          e.live.firmware = fw;
        }
        // VID/PID cannot tell these boards apart; the firmware's model id can.
        // Do this only once a version actually came back, so a mid-wake read
        // returning 0 never triggers a swap.
        const modelId = (fw as { modelId?: number } | null)?.modelId ?? 0;
        if (modelId) await this.applyModelId(e, modelId);
        // A keyboard is "wireless" only once it has answered GET_RF_VERSION.
        if (e.descriptor.kind === 'keyboard' && fw) {
          e.live.wireless = (fw.receiverRaw ?? 0) > 0;
          e.live.connection = e.live.wireless ? '2.4g' : 'usb';
        }
      }
    } catch (err) {
      // Same debounce as a failed ping (above) — a thrown read (e.g. the HID
      // handle briefly unavailable while a receiver re-enumerates) used to
      // flip the card offline on the very first miss, bypassing
      // PING_MISS_THRESHOLD entirely.
      e.pingMisses++;
      if (looksLikePermissionError(err)) e.permissionError = true;
      if (e.pingMisses >= PING_MISS_THRESHOLD) e.live.online = false;
    }
    // Defence in depth for the leaked-handle failure the prune sweep
    // describes: release the OS handle as soon as a device stops answering,
    // instead of waiting for it to drop out of enumeration entirely. The entry
    // stays (so the card stays, shown offline); the channel is disposed, and
    // `scan()` gives the entry a fresh one on the next pass.
    if (!e.live.online && !e.descriptor.simulated && e.channel.isOpen()) {
      this.stopTravel(e.live.id, false, { force: true });
      await e.channel.close();
    }
    e.live.receiverOnline = receiverOnline(e.live.wireless, e.live.online, e.channel.isOpen());
    e.live.hint = hint(
      this.config,
      e.live.kind,
      e.live.online,
      e.live.wireless,
      e.live.battery,
      e.live.provenance,
      e.permissionError,
      e.descriptor.simulated,
    );

    return prev !== JSON.stringify(e.live);
  }

  // -- live device-state poll -------------------------------------------
  /**
   * Devices whose config screen is open. Only these are polled — see
   * LIVE_POLL_MS. Session state, so a renderer reload just leaves an entry
   * behind until `clearLiveWatches()`.
   */
  private liveWatch = new Set<string>();
  /** In-flight and just-finished writes per device — see LIVE_WRITE_QUIET_MS. */
  private writeQuiet = new Map<string, { at: number; inflight: number }>();

  setLiveWatch(deviceId: string, on: boolean): void {
    if (on) this.liveWatch.add(deviceId);
    else this.liveWatch.delete(deviceId);
  }

  /** Drop every watch — called when the renderer goes away, so a reload can't
   *  leave a device being polled with nothing on screen. */
  clearLiveWatches(): void {
    this.liveWatch.clear();
  }

  noteWriteStart(deviceId: string): void {
    const w = this.writeQuiet.get(deviceId) ?? { at: 0, inflight: 0 };
    w.inflight++;
    w.at = Date.now();
    this.writeQuiet.set(deviceId, w);
  }

  noteWriteEnd(deviceId: string): void {
    const w = this.writeQuiet.get(deviceId);
    if (!w) return;
    w.inflight = Math.max(0, w.inflight - 1);
    w.at = Date.now();
    // A write may have changed the stage table; re-derive it on the next poll.
    const e = this.entries.get(deviceId);
    if (e) e.liveStages = null;
  }

  private liveDue(e: Entry, now: number): boolean {
    if (e.liveUnsupported || !e.live.online) return false;
    // A single missed ping already means the device is answering badly; adding
    // reads on top of that is how a struggling channel gets pushed into a wedge.
    if (e.pingMisses > 0 || e.wedges > 0) return false;
    if (!this.liveWatch.has(e.live.id)) return false;
    // The travel stream drives the same serialized channel on its own 150ms
    // timer; two cadences contending would only slow both down.
    if (this.travelTimers.has(e.live.id)) return false;
    const w = this.writeQuiet.get(e.live.id);
    if (w && (w.inflight > 0 || now - w.at < LIVE_WRITE_QUIET_MS)) return false;
    return now - e.lastLivePoll >= LIVE_POLL_MS;
  }

  /**
   * One cheap probe (see `Driver.readLiveState`), plus a stage-table read only
   * when the table itself might have changed — so the steady-state cost of
   * tracking DPI and poll rate is a single 17-byte request per tick.
   *
   * Runs inside `refreshEntry`, not on its own timer: the scan chain already
   * guarantees passes cannot overlap, so this needs no busy-guard of its own
   * and inherits the online/wedge/permission handling around it.
   */
  private async pollLiveState(e: Entry, now: number): Promise<void> {
    const first = !e.liveProbed;
    e.liveProbed = true;
    e.lastLivePoll = now;
    const s = await e.driver.readLiveState();
    if (!s) {
      // Only the FIRST null means "this driver has no cheap probe". Every
      // later one is a device that was asleep or dropped a read, and latching
      // on that would silently switch monitoring off for the rest of the run.
      if (first) e.liveUnsupported = true;
      return;
    }
    e.live.activeDpiStage = s.activeDpiStage ?? e.live.activeDpiStage;
    e.live.pollRate = s.pollRate ?? e.live.pollRate;
    if (s.dpiStageCount !== null && (!e.liveStages || e.liveStages.length !== s.dpiStageCount)) {
      e.liveStages = await e.driver.readDpiStages();
    }
    const i = e.live.activeDpiStage;
    e.live.activeDpi = (i !== null ? e.liveStages?.[i]?.dpi : undefined) ?? null;
  }

  // -- live per-key travel stream ---------------------------------------
  private travelTimers = new Map<string, NodeJS.Timeout>();
  /**
   * How many consumers currently want this device's stream.
   *
   * The Actuation tab's own live view and the calibration overlay both drive
   * the same stream, and `stopTravel` used to tear the shared timer down
   * unconditionally — so whichever unmounted first killed the other's feed.
   * Opening calibration with a key selected is exactly that case.
   */
  private travelRefs = new Map<string, number>();
  /** The cadence each open request asked for; the SLOWEST one wins — see
   *  travelRate(). */
  private travelRates = new Map<string, number[]>();
  /** Consecutive failed reads, per device — see TRAVEL_MISS_GIVE_UP. */
  private travelMisses = new Map<string, number>();
  /** A start still waiting on the board's answer, per device. */
  private travelStarts = new Map<string, Promise<TravelStreamResult>>();

  /**
   * Open (or join) a device's live travel stream. Resolves with the board's
   * own answer.
   *
   * It used to answer `{ ok: true }` without waiting for one: the arm command
   * was fire-and-forget, so a device with no stream at all — or one that
   * refused it — looked exactly like a running stream with nobody pressing a
   * key, and the Test view's "no live travel stream" could never show. Now the
   * sampling starts only once the board has said yes, and a caller that joins
   * while the answer is on its way is given that same answer.
   *
   * A refusal still leaves this caller's vote counted, as a stream that ran
   * would: every consumer withdraws with `stopTravel` whatever the answer
   * was, and the bookkeeping stays balanced without special cases.
   */
  async startTravel(deviceId: string, intervalMs?: number): Promise<TravelStreamResult> {
    const e = this.entries.get(deviceId);
    if (!e) return { ok: false, error: 'device not connected' };
    // Not "unsupported": an offline board may well have the stream.
    if (!e.live.online) return { ok: false, error: 'device offline' };

    const rate = Math.max(TRAVEL_POLL_MS, intervalMs ?? TRAVEL_POLL_MS);
    const rates = this.travelRates.get(deviceId) ?? [];
    const wasSlowest = rates.length ? Math.max(...rates) : 0;
    rates.push(rate);
    this.travelRates.set(deviceId, rates);
    this.travelRefs.set(deviceId, (this.travelRefs.get(deviceId) ?? 0) + 1);

    // Being armed: the answer on its way is this caller's too. (The timer it
    // arms reads the cadence per tick, so this vote counts from the start.)
    const pending = this.travelStarts.get(deviceId);
    if (pending) return pending;
    // Already running. Re-arm only if this request actually changes the
    // effective cadence.
    if (this.travelTimers.has(deviceId)) {
      if (rate > wasSlowest) this.restartTravelTimer(deviceId);
      return { ok: true };
    }
    // Arm the firmware's reporting, then sample on a cadence.
    //
    // One `readTravel()` is now a whole magnetism-page read (4 write/read
    // pairs spaced by the driver's 30ms settle, ~140ms), not a single cheap
    // input-report poll — so this is one sample per tick, not a burst of four.
    // At TRAVEL_POLL_MS that is ~27 feature writes/sec, well under the rate
    // FINDINGS-R85HE.md's "Note — endpoint lockup" says wedges the MI_02
    // endpoint, and in line with what the vendor itself does while watching
    // travel during calibration.
    const start: Promise<TravelStreamResult> = e.driver
      .startTravelStream()
      .catch((err: unknown) => ({ ok: false, error: String(err) }))
      .then((r) => {
        // Superseded: stopped while the board was answering (every consumer
        // left, or the device went away), and maybe restarted since — the
        // stream is no longer this start's to arm.
        if (this.travelStarts.get(deviceId) !== start) return r;
        this.travelStarts.delete(deviceId);
        if (r.ok) {
          this.travelMisses.set(deviceId, 0);
          this.armTravelTimer(deviceId);
        }
        return r;
      });
    this.travelStarts.set(deviceId, start);
    return start;
  }

  /**
   * Effective cadence: the SLOWEST any current consumer asked for.
   *
   * Deliberately the slowest, not the fastest. A consumer asking for a slower
   * rate is asking to take load off a wedge-prone endpoint; honouring a
   * faster request from someone else would defeat exactly that. The live
   * readout is a visual guide, so running it at the calibration overlay's
   * cadence while calibration is open costs nothing that matters.
   */
  private travelRate(deviceId: string): number {
    const rates = this.travelRates.get(deviceId);
    return rates?.length ? Math.max(...rates) : TRAVEL_POLL_MS;
  }

  private restartTravelTimer(deviceId: string): void {
    const timer = this.travelTimers.get(deviceId);
    if (timer) clearTimeout(timer);
    this.travelTimers.delete(deviceId);
    this.armTravelTimer(deviceId);
  }

  /**
   * A failed read emits an INCOMPLETE sample rather than nothing. Emitting
   * nothing left the renderer showing the last frame indefinitely with no way
   * to tell a stalled stream from a still board.
   */
  private armTravelTimer(deviceId: string): void {
    const e = this.entries.get(deviceId);
    if (!e) return;
    const miss = () => {
      const misses = (this.travelMisses.get(deviceId) ?? 0) + 1;
      this.travelMisses.set(deviceId, misses);
      this.emit('device:travel', { id: deviceId, raw: '', keys: [], complete: false });
      if (misses >= TRAVEL_MISS_GIVE_UP) this.abandonTravel(deviceId);
    };
    /**
     * Chained, not `setInterval`.
     *
     * A sample is a four-chunk paced page read that costs ~130 ms against a
     * 150 ms cadence, so it only has to run slightly long to still be in
     * flight when the next tick arrives — and the busy guard then DROPPED that
     * tick, turning one slow sample into a 300 ms gap. Measuring each sample
     * and waiting only the remainder keeps the stream at the board's own
     * maximum rate instead of halving it whenever it hesitates.
     */
    const tick = () => {
      const started = Date.now();
      void (async () => {
        try {
          const sample = await e.driver.readTravel();
          if (sample) {
            this.travelMisses.set(deviceId, 0);
            this.emit('device:travel', {
              id: deviceId,
              raw: toHex(sample.raw),
              keys: sample.keys,
              complete: sample.complete,
            });
          } else {
            miss();
          }
        } catch {
          miss();
        } finally {
          // Re-arm only if this loop is still the live one: `stopTravel` (and
          // a re-arm at a new cadence) clears the handle, and a sample already
          // in flight when that happens must not resurrect the timer.
          if (this.travelTimers.get(deviceId) === handle) {
            const wait = Math.max(0, this.travelRate(deviceId) - (Date.now() - started));
            handle = setTimeout(tick, wait);
            this.travelTimers.set(deviceId, handle);
          }
        }
      })();
    };
    let handle: NodeJS.Timeout = setTimeout(tick, this.travelRate(deviceId));
    this.travelTimers.set(deviceId, handle);
  }

  /**
   * The board stopped answering travel reads: stop sampling it, and say so.
   *
   * This used to be a silent force-stop. Every consumer was left "running" on
   * a stream that had ended, which on screen looks exactly like a board
   * nobody is pressing — and since the force-stop also dropped their votes,
   * one consumer starting again could then be torn down by another's late
   * stop. So the votes are KEPT: each consumer hears `ended`, and withdraws
   * (or starts again) through the usual calls. The firmware's report is
   * switched off when the last of them withdraws, as for any stream.
   */
  private abandonTravel(deviceId: string): void {
    const timer = this.travelTimers.get(deviceId);
    if (timer) clearTimeout(timer);
    this.travelTimers.delete(deviceId);
    this.travelMisses.delete(deviceId);
    this.emit('device:travel', { id: deviceId, raw: '', keys: [], complete: false, ended: true });
  }

  /**
   * @param notifyDevice send the firmware's disable command. Skipped by the
   *   prune sweep: the device is already gone, and queueing a write on a
   *   channel that is being closed is what used to re-open its HID handle
   *   after `close()` (see the prune loop in `scan()`).
   */
  stopTravel(
    deviceId: string,
    notifyDevice = true,
    opts: { force?: boolean; intervalMs?: number } = {},
  ): void {
    const had = this.travelRefs.get(deviceId) ?? 0;
    // Nothing open: a force-stop (the device went away, or wedged) has already
    // torn it down, and this is a consumer withdrawing after the fact. There
    // is nothing to stop — and nothing to send to a device that may be gone.
    if (!opts.force && had <= 0) return;
    const refs = had - 1;
    if (!opts.force && refs > 0) {
      // Another consumer still wants it. Withdraw THIS consumer's own cadence
      // vote — identified by the interval it opened with, since the IPC
      // surface carries no per-consumer handle — and re-arm at whatever the
      // rest asked for. Withdrawing an arbitrary vote instead would leave the
      // calibration overlay's slow rate in force after it had closed, or
      // strip it while it was still open.
      this.travelRefs.set(deviceId, refs);
      const rates = this.travelRates.get(deviceId) ?? [];
      const rate = Math.max(TRAVEL_POLL_MS, opts.intervalMs ?? TRAVEL_POLL_MS);
      const at = rates.indexOf(rate);
      // An unrecognised rate means a caller that opened before this
      // bookkeeping existed; drop the slowest so the stream can only ever get
      // faster, never stuck slow.
      rates.splice(at >= 0 ? at : rates.indexOf(Math.max(...rates)), 1);
      this.travelRates.set(deviceId, rates);
      this.restartTravelTimer(deviceId);
      return;
    }
    const timer = this.travelTimers.get(deviceId);
    if (timer) clearTimeout(timer);
    this.travelTimers.delete(deviceId);
    this.travelRefs.delete(deviceId);
    this.travelRates.delete(deviceId);
    this.travelMisses.delete(deviceId);
    // A start still on its way must not arm a timer once it lands.
    this.travelStarts.delete(deviceId);
    // Torn down under consumers that still wanted it (offline, wedged, gone):
    // they hear it ended rather than watching a stream that went quiet.
    if (opts.force && had > 0) {
      this.emit('device:travel', { id: deviceId, raw: '', keys: [], complete: false, ended: true });
    }
    if (notifyDevice) void this.entries.get(deviceId)?.driver.stopTravelStream();
  }

  /**
   * Adopt a profile the app itself just selected, without waiting for a ping.
   *
   * `activeProfile` was only ever discovered by the ~2.5s ping poll, so an
   * in-menu switch had to announce itself: the switcher dropped the read cache
   * and bumped the config epoch by hand, every pane remounted and re-read —
   * and then the poll found the change too, and did the whole thing a second
   * time. Two remounts and two multi-page reads for one switch, which is the
   * reported "reading device appears, vanishes, comes back, vanishes".
   *
   * Telling the manager makes the device's own state the single announcement,
   * so the in-menu switch and the physical profile button arrive by exactly
   * one path and the renderer reacts to them identically.
   */
  noteActiveProfile(deviceId: string, slot: number): void {
    const e = this.entries.get(deviceId);
    if (!e || e.live.activeProfile === slot) return;
    e.live.activeProfile = slot;
    // A switch replaces the whole per-profile block, so whatever the live poll
    // last derived is stale — same reset the poll does when it spots one.
    e.lastLivePoll = 0;
    e.liveStages = null;
    e.live.activeDpi = null;
    this.emitChanged();
  }

  /**
   * Read every onboard slot, one at a time, and put the device back.
   *
   * The device only ever exposes the slot it is ON — not one read in the whole
   * protocol takes a profile argument — so the only way to see slot 3 while
   * you are on slot 1 is to go there. That makes this expensive and visible:
   * the board really does switch four times, its lighting changes as it goes,
   * and on a keyboard the magnetism pages alone are a multi-page sweep per
   * slot. It is on-demand for that reason and never part of a prefetch.
   *
   * Deliberately silent: `noteActiveProfile` is NOT called for the slots
   * passed through. It emits `devices:changed`, which makes DeviceConfig drop
   * the device cache and bump `configEpoch` — so announcing each hop would
   * remount every pane and kick off a cold re-read four times over, in the
   * middle of the sweep those reads are competing with. The sweep ends on the
   * slot it started from, so there is nothing to announce.
   *
   * The profile hops are writes, so this takes a backup first for the same
   * reason `guardedWrite` does. It cannot go through `guardedWrite` itself:
   * that is for methods returning a `WriteResult`, and this returns data.
   */
  async snapshotProfiles(deviceId: string): Promise<ProfileSnapshots> {
    const e = this.entries.get(deviceId);
    if (!e) throw new Error('No such device');
    if (!e.descriptor.simulated && !(await this.ensureBackup(deviceId))) {
      throw new Error('Refusing to switch profiles: could not take a backup of the device first.');
    }

    const caps = e.descriptor.capabilities;
    const has = (c: Capability) => caps.includes(c);
    const d = e.driver;

    // Field -> how to read it, gated on capability so a mouse is not asked
    // for key bindings. Order is display order in the compare table.
    const readers: Array<[ProfileField, boolean, () => Promise<unknown>]> = [
      ['pollRate', has('pollRate'), () => d.readPollRate()],
      ['debounce', has('debounce') || has('mouseDebounce'), () => d.readDebounce()],
      ['power', has('sleepTimer'), () => d.readPower()],
      ['sensor', has('sensorTuning'), () => d.readSensor()],
      ['dpiStages', has('dpi'), () => d.readDpiStages()],
      ['buttons', has('buttonRemap'), () => d.readButtons()],
      ['lighting', has('perKeyLighting') || has('mouseLighting'), () => d.readLighting()],
      ['sideLighting', has('sideLighting'), () => d.readSideLighting()],
      ['perKeyLighting', has('perKeyLighting'), () => d.readPerKeyLighting()],
      ['keyRemapBase', has('keyRemap'), () => d.readKeyBindings('base')],
      ['keyRemapFn', has('fnLayer'), () => d.readKeyBindings('fn')],
      ['magnetic', has('magneticSwitches'), () => d.readMagnetic()],
      ['switchTypes', has('replaceableSwitches'), () => d.readSwitchTypes()],
    ];
    // Only what the slot actually carries: on a keyboard that is actuation
    // alone, so the other reads would compare one register against itself.
    const scoped = profileFieldsFor(e.descriptor.kind);
    const active = readers.filter(([f, on]) => on && scoped.includes(f));
    const fields = active.map(([f]) => f);

    // Ask the DEVICE which slot it is on, not the manager's cached view of it.
    // The cache is only as fresh as the last poll or the last write that went
    // through `noteActiveProfile`, and restoring to a stale value would leave
    // the board on a profile nobody selected — the one outcome this sweep must
    // not have. Falls back to the cache if the device declines to answer.
    const started =
      (await e.driver.getActiveProfile().catch(() => null)) ?? e.live.activeProfile ?? 1;
    const count = e.descriptor.spec?.profileCount ?? 4;
    const slots: ProfileSnapshot[] = [];

    this.noteWriteStart(deviceId);
    try {
      for (let slot = 1; slot <= count; slot++) {
        this.emit('profiles:progress', { deviceId, slot, total: count });
        const snap: ProfileSnapshot = { slot, values: {} };
        try {
          const r = await d.setActiveProfile(slot);
          if (!r.ok) throw new Error(r.error ?? `could not select slot ${slot}`);
          for (const [field, , read] of active) {
            // One bad read must not lose the other twelve, or the three slots
            // already swept. A field that throws reads as "not available on
            // this slot" in the table, which is what it is.
            snap.values[field] = await read().catch(() => null);
          }
        } catch (err) {
          snap.error = String((err as Error)?.message ?? err);
        }
        slots.push(snap);
      }
    } finally {
      // Always, even if a slot threw: leaving the user's board on a profile
      // they did not choose is worse than the failed read.
      await this.entries
        .get(deviceId)
        ?.driver.setActiveProfile(started)
        .catch(() => {});
      this.noteWriteEnd(deviceId);
    }
    return { slots, restoredTo: started, fields };
  }

  /**
   * Copy some or all of one slot onto another.
   *
   * Same switch-read-switch-write shape as the sweep above, and the same
   * silence about the hops. `fields` omitted means every field this device
   * reports.
   */
  async copyProfile(
    deviceId: string,
    from: number,
    to: number,
    fields?: ProfileField[],
  ): Promise<WriteResult> {
    const e = this.entries.get(deviceId);
    if (!e) return { ok: false, verified: 'unverified', error: 'No such device' };
    if (from === to)
      return {
        ok: false,
        verified: 'unverified',
        error: 'Source and destination are the same profile',
      };

    const d = e.driver;
    // The device's own answer, for the same reason as the sweep above.
    const started = (await d.getActiveProfile().catch(() => null)) ?? e.live.activeProfile ?? 1;
    // Never "copies" a field the slot does not carry (see profileFieldsFor):
    // on a keyboard that would rewrite a shared register with its own value.
    const scoped = profileFieldsFor(e.descriptor.kind);
    const want = new Set((fields ?? scoped).filter((f) => scoped.includes(f)));
    const written: ProfileField[] = [];
    const skipped: ProfileField[] = [];

    this.noteWriteStart(deviceId);
    try {
      const sel = await d.setActiveProfile(from);
      if (!sel.ok)
        return {
          ok: false,
          verified: 'unverified',
          error: sel.error ?? `could not select profile ${from}`,
        };

      // Read everything wanted BEFORE switching: after the hop the source is
      // no longer reachable, and a half-read copy would write some fields from
      // the source and leave the rest at the destination's own values.
      const copiers: Array<[ProfileField, () => Promise<(() => Promise<WriteResult>) | null>]> = [
        ['pollRate', async () => valueWriter(await d.readPollRate(), (v) => d.setPollRate(v))],
        ['debounce', async () => valueWriter(await d.readDebounce(), (v) => d.setDebounce(v))],
        ['power', async () => valueWriter(await d.readPower(), (v) => d.setPower(v))],
        ['sensor', async () => valueWriter(await d.readSensor(), (v) => d.setSensor(v))],
        [
          'sideLighting',
          async () => valueWriter(await d.readSideLighting(), (v) => d.setSideLighting(v)),
        ],
        [
          'magnetic',
          async () => {
            // Everything of Mod-tap and DKS that lives in the slot travels with
            // the keys: mode, hold time, DKS point and zone flags are magnetism
            // pages. Their key bindings (the hold key, the DKS actions) are
            // not copied because they are not the slot's: SharkDeck writes
            // them to key-matrix layer 0 whichever profile is active
            // (`setKeyZoneBindings`), so the copy already uses them — and for
            // the same reason a copy INTO another slot leaves them alone
            // (`keepZoneBindings`), rather than undoing a mod-tap key on the
            // profile in use.
            const keys = await d.readMagnetic();
            return keys.length
              ? () => d.setMagneticKeys(keys, undefined, { keepZoneBindings: to !== started })
              : null;
          },
        ],
        [
          'lighting',
          async () => {
            const all = await d.readLighting();
            return all.length ? () => d.setLighting(all[0]!) : null;
          },
        ],
        [
          'perKeyLighting',
          async () => {
            const colors = await d.readPerKeyLighting();
            return colors?.length ? () => d.setPerKeyLighting(colors) : null;
          },
        ],
      ];

      const pending: Array<[ProfileField, () => Promise<WriteResult>]> = [];
      for (const [field, prepare] of copiers) {
        if (!want.has(field)) continue;
        const write = await prepare().catch(() => null);
        if (write) pending.push([field, write]);
        else skipped.push(field);
      }
      // Fields with no single-shot writer. Named rather than silently dropped
      // so the UI can say which ones it did not move.
      for (const f of want) {
        if (!copiers.some(([c]) => c === f) && !skipped.includes(f)) skipped.push(f);
      }
      if (!pending.length) {
        return {
          ok: false,
          verified: 'unverified',
          error: 'Nothing on this device can be copied between profiles',
        };
      }

      const dest = await d.setActiveProfile(to);
      if (!dest.ok)
        return {
          ok: false,
          verified: 'unverified',
          error: dest.error ?? `could not select profile ${to}`,
        };

      for (const [field, write] of pending) {
        const r = await write().catch(
          (err) => ({ ok: false, verified: 'unverified', error: String(err) }) as WriteResult,
        );
        if (r.ok) written.push(field);
        else skipped.push(field);
      }
    } finally {
      await this.entries
        .get(deviceId)
        ?.driver.setActiveProfile(started)
        .catch(() => {});
      this.noteWriteEnd(deviceId);
    }

    if (!written.length)
      return { ok: false, verified: 'unverified', error: 'No setting could be copied' };
    return {
      ok: true,
      verified: 'unverified',
      note: skipped.length
        ? `copied ${written.length}; ${skipped.length} not copied (${skipped.join(', ')})`
        : `copied ${written.length}`,
    };
  }

  /**
   * Write some keys' actuation settings to one slot — the profile comparator's
   * per-key copy.
   *
   * No magnetism GET or SET carries a profile byte, so a slot the board is not
   * on can only be written by going there: the same silent hop as
   * `copyProfile` (no `noteActiveProfile`, for the same reason), and the board
   * always ends on the slot it started on. The source settings come from the
   * caller's snapshot rather than a fresh source read — that read is a full
   * multi-page sweep, and the comparator re-reads after every copy anyway.
   */
  async setMagneticKeysOnProfile(
    deviceId: string,
    slot: number,
    keys: MagneticKeySettings[],
    previous?: MagneticKeySettings[],
  ): Promise<WriteResult> {
    const e = this.entries.get(deviceId);
    if (!e) return { ok: false, verified: 'unverified', error: 'No such device' };
    const d = e.driver;
    // The device's own answer, for the same reason as the sweep above.
    const started = (await d.getActiveProfile().catch(() => null)) ?? e.live.activeProfile ?? 1;
    const hop = slot !== started;

    this.noteWriteStart(deviceId);
    try {
      if (hop) {
        const sel = await d.setActiveProfile(slot);
        if (!sel.ok)
          return {
            ok: false,
            verified: 'unverified',
            error: sel.error ?? `could not select profile ${slot}`,
          };
      }
      // The key matrix is not the slot's (see copyProfile), so a write to a
      // slot the board is not showing leaves every key's bindings alone.
      return await d.setMagneticKeys(keys, previous, { keepZoneBindings: hop });
    } finally {
      if (hop)
        await this.entries
          .get(deviceId)
          ?.driver.setActiveProfile(started)
          .catch(() => {});
      this.noteWriteEnd(deviceId);
    }
  }

  private emitChanged(): void {
    this.emit('devices:changed', this.list());
  }
}

/**
 * A writer for a value that may not have been readable.
 *
 * Every simple field copies the same way — read it on the source slot, and if
 * something came back, hand out a closure that writes it on the destination.
 * `null` means "the source had nothing to give", which the caller reports as
 * not-copied rather than writing a default over the destination.
 */
function valueWriter<T>(
  value: T | null | undefined,
  write: (v: T) => Promise<WriteResult>,
): (() => Promise<WriteResult>) | null {
  return value === null || value === undefined ? null : () => write(value);
}

export const deviceManager = new DeviceManager();
