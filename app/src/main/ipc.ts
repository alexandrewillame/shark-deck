import { app, ipcMain, BrowserWindow, nativeTheme, dialog, screen } from 'electron';
import { basename } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Api } from '@shared/ipc';
import { IPC } from '@shared/ipc';
import type { PerKeyLightingPreset } from '@shared/types/lighting';
import type { ActuationLayout, KeyGroup } from '@shared/types/keyboard-settings';
import type { Macro } from '@shared/types/macros';
import type { AppProfile } from '@shared/types/profiles';
import { applicableDpiStages } from '@shared/mouse-wire';
import { getT } from '@shared/i18n';
import { deviceManager } from './devices/manager';
import { switcher } from './profiles/switcher';
import * as pstore from './profiles/store';
import * as mstore from './macros/store';
import * as lstore from './lighting/store';
import * as astore from './actuation/store';
import { writeActuationLayout } from './actuation/apply';
import * as ambient from './lighting/ambient';
import { scanGames } from './profiles/gameScan';
import { listRunningProcesses } from './profiles/processScan';
import { getSettings, getSettingsSync, setSettings } from './settings';
import { platform } from './platform';
import { bundleExecutableName } from './platform/mac';
import { frameLog } from './diagnostics';
import { deleteBackupFile, listBackupFiles, readBackup, writeBackup } from './store';
import { promises as fs } from 'node:fs';

function driverOrThrow(deviceId: string) {
  const d = deviceManager.getDriver(deviceId);
  if (!d) throw new Error(`device not connected: ${deviceId}`);
  return d;
}

/**
 * Every mutating IPC handler goes through here so a full backup exists on disk
 * before the first write to a device (CLAUDE.md invariant #1). `ensureBackup`
 * returns `false` when it could not take one (read threw / came back empty) —
 * the write must NOT proceed in that case, or a device that can be written but
 * not fully read gets mutated with nothing to restore from. A `simulated`
 * device legitimately has nothing to back up and returns `false`; let it
 * through.
 */
async function guardedWrite<T>(deviceId: string, fn: () => Promise<T>): Promise<T> {
  const ok = await deviceManager.ensureBackup(deviceId);
  if (!ok && !deviceManager.getDescriptor(deviceId)?.simulated) {
    throw new Error('Refusing to write: could not take a backup of the device first.');
  }
  // Every mutating path funnels through here, which makes it the one honest
  // answer to "did anything actually change on a device while auto-switch was
  // paused?". The switcher uses it to decide whether resuming needs to force
  // the current mode back out — see `noteDeviceWrite` / `dirtySinceSuspend`.
  switcher.noteDeviceWrite();
  // Same reason, different consumer: the live-state poll must not read a
  // device while a write to it is in flight, or just after — a read that
  // started first can land afterwards and push the pre-write value back into
  // the UI the user just changed. See LIVE_WRITE_QUIET_MS in devices/manager.ts.
  deviceManager.noteWriteStart(deviceId);
  try {
    return await fn();
  } finally {
    deviceManager.noteWriteEnd(deviceId);
  }
}

/**
 * Paged reads that must not stack.
 *
 * Each of these is a multi-frame sweep held open as one channel transaction,
 * and the renderer can ask for the same one again faster than it completes —
 * flipping the Remap tab between Base and Fn re-runs the effect
 * (`useDeviceData`'s deps are `[layer]`), and its `gen` counter only discards
 * the stale *result*: the main-process sweep it started keeps running and the
 * next one queues behind it. Four flips is four full sweeps back to back on a
 * firmware the capture notes say wedges under sustained traffic.
 *
 * Coalescing hands every caller of an identical in-flight read the same
 * promise. Reads only — two writes with the same arguments are two intended
 * writes, and folding them together would break the backup invariant's intent.
 */
const COALESCED_READS: ReadonlySet<string> = new Set<keyof Api>([
  'readKeyBindings',
  'readFnLayer',
  'readPerKeyLighting',
  'readMagnetic',
  'readMacros',
]);

const inflightReads = new Map<string, Promise<unknown>>();

function dedupeRead<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const existing = inflightReads.get(key) as Promise<T> | undefined;
  if (existing) return existing;
  const started = fn().finally(() => inflightReads.delete(key));
  inflightReads.set(key, started);
  return started;
}

/** Set by `registerIpc` — the real main window, so the titlebar controls never
 *  act on the overlay / crash window (which are also `BrowserWindow`s and can
 *  outlive a destroyed main window). */
let getMainWindow: () => BrowserWindow | null = () => null;

const handlers: { [K in keyof Api]?: (...args: any[]) => any } = {
  listDevices: () => deviceManager.list(),
  refreshDevices: () => deviceManager.list(),
  getScanDiagnostic: () => deviceManager.getDiagnostic(),
  getFirmware: (id: string) => driverOrThrow(id).getFirmware(),
  renameOnboardProfile: (model: string, slot: number, name: string) =>
    deviceManager.setProfileName(model, slot, name),
  setDeviceColor: (model: string, variantId: string | null) =>
    deviceManager.setColor(model, variantId),

  readDpiStages: (id: string) => driverOrThrow(id).readDpiStages(),
  readActiveDpiStage: (id: string) => driverOrThrow(id).readActiveDpiStage(),
  readSensor: (id: string) => driverOrThrow(id).readSensor(),
  readPower: (id: string) => driverOrThrow(id).readPower(),
  readMagnetic: (id: string) => driverOrThrow(id).readMagnetic(),
  readKeyZoneBindings: (id: string) => driverOrThrow(id).readKeyZoneBindings(),
  readSwitchTypes: (id: string) => driverOrThrow(id).readSwitchTypes(),
  setSwitchTypes: (id: string, assignments: { slot: number; switchId: number }[]) =>
    guardedWrite(id, () => driverOrThrow(id).setSwitchTypes(assignments)),
  readLighting: (id: string) => driverOrThrow(id).readLighting(),
  readSideLighting: (id: string) => driverOrThrow(id).readSideLighting(),
  readPerKeyLighting: (id: string) => driverOrThrow(id).readPerKeyLighting(),
  readReceiverLed: (id: string) => driverOrThrow(id).readReceiverLed(),
  readDpiLed: (id: string) => driverOrThrow(id).readDpiLed(),
  readFnLayer: (id: string) => driverOrThrow(id).readFnLayer(),
  readKeyBindings: (id: string, layer: 'base' | 'fn') => driverOrThrow(id).readKeyBindings(layer),
  readMacros: (id: string) => driverOrThrow(id).readMacros(),
  readButtons: (id: string) => driverOrThrow(id).readButtons(),
  readPollRate: (id: string) => driverOrThrow(id).readPollRate(),
  readDebounce: (id: string) => driverOrThrow(id).readDebounce(),
  readPerformance: (id: string) => driverOrThrow(id).readPerformance(),
  readDpiDynamic: (id: string) => driverOrThrow(id).readDpiDynamic(),

  setActiveProfile: async (id: string, slot: number) => {
    const r = await guardedWrite(id, () => driverOrThrow(id).setActiveProfile(slot));
    // Announce it here rather than leaving the renderer to guess: see
    // noteActiveProfile. Only on success — a refused switch leaves the device
    // on the slot it was already on.
    if (r.ok) deviceManager.noteActiveProfile(id, slot);
    return r;
  },
  // Disabled stages are dropped at the process boundary, not passed down and
  // flagged — the wire has no per-stage disable, so a stage that reaches a slot
  // is a stage the mouse can cycle into. Keeps every caller honest, including a
  // profile captured before the per-stage toggle was removed.
  setDpiStages: (id: string, s: any) =>
    guardedWrite(id, () => driverOrThrow(id).setDpiStages(applicableDpiStages(s))),
  setActiveDpiStage: (id: string, i: number) =>
    guardedWrite(id, () => driverOrThrow(id).setActiveDpiStage(i)),
  // Polling rate is one register with no profile argument — the board has a
  // single value and switching profiles does not change it. The app used to
  // shadow it per slot and replay it on every switch, which made the UI claim
  // a scope the hardware does not have; it is a plain device setting now.
  setPollRate: (id: string, hz: number) =>
    guardedWrite(id, () => driverOrThrow(id).setPollRate(hz)),
  // Not routed through `guardedWrite`: that is for the mutating `Api` methods,
  // which return a `WriteResult`, and this returns data. It does still hop
  // profiles, so `snapshotProfiles` takes the backup itself — the invariant
  // holds in fact, not only in the shape the contract test can see.
  snapshotProfiles: (id: string) => deviceManager.snapshotProfiles(id),
  copyProfile: (id: string, from: number, to: number, fields?: any) =>
    guardedWrite(id, () => deviceManager.copyProfile(id, from, to, fields)),
  setMagneticKeysOnProfile: (id: string, slot: number, keys: any, previous?: any) =>
    guardedWrite(id, () => deviceManager.setMagneticKeysOnProfile(id, slot, keys, previous)),
  setSensor: (id: string, s: any) => guardedWrite(id, () => driverOrThrow(id).setSensor(s)),
  setPower: (id: string, p: any) => guardedWrite(id, () => driverOrThrow(id).setPower(p)),
  setButton: (id: string, b: number, a: string) =>
    guardedWrite(id, () => driverOrThrow(id).setButton(b, a)),
  setButtonMapping: (id: string, b: number, m: any) =>
    guardedWrite(id, () => driverOrThrow(id).setButtonMapping(b, m)),
  setMagneticKey: (id: string, k: any) =>
    guardedWrite(id, () => driverOrThrow(id).setMagneticKey(k)),
  setMagneticKeys: (id: string, keys: any, previous?: any) =>
    guardedWrite(id, () => driverOrThrow(id).setMagneticKeys(keys, previous)),
  setMagneticGlobal: (id: string, mm: number) =>
    guardedWrite(id, () => driverOrThrow(id).setMagneticGlobal(mm)),
  setKeyZoneBindings: (id: string, slot: number, zones: Array<string | null>) =>
    guardedWrite(id, () => driverOrThrow(id).setKeyZoneBindings(slot, zones)),
  setMagneticCalibration: (id: string, scope: 'zero' | 'max') =>
    guardedWrite(id, () => driverOrThrow(id).setMagneticCalibration(scope)),
  setDebounce: (id: string, ms: number) =>
    guardedWrite(id, () => driverOrThrow(id).setDebounce(ms)),
  readKeyboardOptions: (id: string) => driverOrThrow(id).readKeyboardOptions(),
  setKeyboardOptions: (
    id: string,
    o: Partial<import('@shared/types/keyboard-settings').KeyboardOptions>,
  ) => guardedWrite(id, () => driverOrThrow(id).setKeyboardOptions(o)),
  setPerformance: (id: string, p: any) =>
    guardedWrite(id, () => driverOrThrow(id).setPerformance(p)),
  setDpiDynamic: (id: string, d: any) => guardedWrite(id, () => driverOrThrow(id).setDpiDynamic(d)),
  setLighting: (id: string, l: any) => guardedWrite(id, () => driverOrThrow(id).setLighting(l)),
  setSideLighting: (id: string, l: any) =>
    guardedWrite(id, () => driverOrThrow(id).setSideLighting(l)),
  setPerKeyLighting: (id: string, keys: any, opts?: any) =>
    guardedWrite(id, () => driverOrThrow(id).setPerKeyLighting(keys, opts)),
  setReceiverLed: (id: string, l: any) =>
    guardedWrite(id, () => driverOrThrow(id).setReceiverLed(l)),
  setDpiLed: (id: string, l: any) => guardedWrite(id, () => driverOrThrow(id).setDpiLed(l)),
  setKeyRemap: (id: string, layer: 'base' | 'fn', index: number, action: string) =>
    guardedWrite(id, () => driverOrThrow(id).setKeyRemap(layer, index, action)),
  saveMacro: (id: string, m: any) => guardedWrite(id, () => driverOrThrow(id).saveMacro(m)),
  deleteMacro: (id: string, mid: string) =>
    guardedWrite(id, () => driverOrThrow(id).deleteMacro(mid)),
  restoreDefaults: (id: string) => guardedWrite(id, () => driverOrThrow(id).restoreDefaults()),
  startPairing: (id: string) => driverOrThrow(id).startPairing(),
  getPairingStatus: (id: string) => driverOrThrow(id).getPairingStatus(),

  listMacroLibrary: () => mstore.listLibraryMacros(),
  saveMacroLibraryEntry: (m: Macro) => mstore.saveLibraryMacro(m),
  deleteMacroLibraryEntry: (mid: string) => mstore.deleteLibraryMacro(mid),
  pushMacroToDevice: (id: string, macroId: string) =>
    guardedWrite(id, async () => {
      const all = await mstore.listLibraryMacros();
      const m = all.find((x) => x.id === macroId);
      if (!m)
        return { ok: false, verified: 'unverified' as const, error: 'Macro not found in library' };
      return driverOrThrow(id).saveMacro(m);
    }),

  listPerKeyLightingLibrary: () => lstore.listPerKeyPresets(),
  savePerKeyLightingLibraryEntry: (p: PerKeyLightingPreset) => lstore.savePerKeyPreset(p),
  deletePerKeyLightingLibraryEntry: (pid: string) => lstore.deletePerKeyPreset(pid),
  applyPerKeyLightingLibraryEntry: (id: string, presetId: string, brightness?: number) =>
    guardedWrite(id, async () => {
      const all = await lstore.listPerKeyPresets();
      const preset = all.find((x) => x.id === presetId);
      if (!preset)
        return { ok: false, verified: 'unverified' as const, error: 'Preset not found in library' };
      return driverOrThrow(id).setPerKeyLighting(preset.colors, { brightness });
    }),

  // Disk only, like the lighting library above: no device is touched, so no
  // backup is owed. Each returns the whole new list so the renderer never
  // refetches.
  listActuationLayouts: () => astore.listActuationLayouts(),
  saveActuationLayout: (l: ActuationLayout) => astore.saveActuationLayout(l),
  deleteActuationLayout: (lid: string) => astore.deleteActuationLayout(lid),
  applyActuationLayout: (id: string, layoutId: string) =>
    guardedWrite(id, async () => {
      const all = await astore.listActuationLayouts();
      const layout = all.find((x) => x.id === layoutId);
      if (!layout)
        return { ok: false, verified: 'unverified' as const, error: 'Layout not found in library' };
      return writeActuationLayout(driverOrThrow(id), layout);
    }),
  listKeyGroups: (model: string, profile: number) => astore.listKeyGroups(model, profile),
  saveKeyGroup: (model: string, profile: number, g: KeyGroup) =>
    astore.saveKeyGroup(model, profile, g),
  deleteKeyGroup: (model: string, profile: number, gid: string) =>
    astore.deleteKeyGroup(model, profile, gid),
  replaceKeyGroups: (model: string, profile: number, groups: KeyGroup[]) =>
    astore.replaceKeyGroups(model, profile, groups),

  // Not through `guardedWrite`: these are continuous streams, not a settings
  // change, and taking a backup eight times a second is absurd. The first
  // frame still goes through the driver's own `setLighting`, and starting a
  // stream is gated on a device that is already attached.
  startAmbientLighting: (
    id: string,
    mode: 'screen' | 'music',
    color: [number, number, number],
    dazzle: boolean,
  ) => ambient.startAmbient(id, mode, color, dazzle),
  stopAmbientLighting: (id: string) => ambient.stopAmbient(id),
  pushAmbientSample: (id: string, sample: { color?: [number, number, number]; level?: number }) =>
    ambient.pushAmbientSample(id, sample),

  startTravelStream: (id: string, intervalMs?: number) => deviceManager.startTravel(id, intervalMs),
  stopTravelStream: (id: string, intervalMs?: number) =>
    deviceManager.stopTravel(id, true, { intervalMs }),

  setLiveWatch: (id: string, on: boolean) => deviceManager.setLiveWatch(id, on),

  backupNow: async (id: string) => {
    const desc = deviceManager.getDescriptor(id);
    const drv = driverOrThrow(id);
    // A simulated device has nothing to back up, and writeBackup() would
    // otherwise drop a file named for the *real* model — which listBackups()
    // would then report as a backup of actual hardware.
    if (desc?.simulated) throw new Error('simulated device: nothing to back up');
    const blocks = await drv.backup();
    const file = await writeBackup(desc!.model, id, blocks);
    return { file, model: desc!.model, createdAt: Date.now(), blocks: Object.keys(blocks).length };
  },
  listBackups: async (id: string) => {
    const desc = deviceManager.getDescriptor(id);
    if (!desc) return [];
    const files = await listBackupFiles(desc.model);
    const infos = [];
    for (const f of files) {
      const b = await readBackup(f);
      if (b)
        infos.push({
          file: f,
          model: b.model,
          createdAt: b.createdAt,
          blocks: Object.keys(b.blocks).length,
        });
    }
    return infos;
  },
  restoreBackup: async (id: string, file: string) => {
    // `readBackup` already rejects a path that isn't a plain filename in the
    // backups dir (see store.ts). Additionally refuse to replay a backup taken
    // from a different model — the wire layouts don't transfer, and the UI
    // only ever lists same-model backups, so a mismatch here is a bug or a
    // hand-edited request.
    const b = await readBackup(file);
    if (!b) return { ok: false, verified: 'unverified', error: 'backup not found' };
    const desc = deviceManager.getDescriptor(id);
    if (desc && b.model !== desc.model) {
      return {
        ok: false,
        verified: 'unverified',
        error: `backup is for "${b.model}", not "${desc.model}"`,
      };
    }
    return driverOrThrow(id).restoreFromBackup(b.blocks);
  },
  deleteBackup: async (id: string, file: string) => {
    // Same two guards as restoreBackup: `deleteBackupFile` rejects anything
    // that isn't a plain filename in the backups dir, and a backup belonging
    // to a different model is refused here — the UI only lists same-model
    // backups, so a mismatch is a bug or a hand-crafted request, and this is
    // an unlink.
    const b = await readBackup(file);
    if (!b) return { ok: false, error: 'backup not found' };
    const desc = deviceManager.getDescriptor(id);
    if (desc && b.model !== desc.model) {
      return { ok: false, error: `backup is for "${b.model}", not "${desc.model}"` };
    }
    if (!(await deleteBackupFile(file)))
      return { ok: false, error: 'could not delete the backup file' };
    // The card's `hasBackup` is otherwise only ever set true.
    await deviceManager.refreshBackupState(id);
    return { ok: true };
  },

  checkFirmwareFile: async (_id: string, p: string) => {
    try {
      const st = await fs.stat(p);
      return { valid: st.size > 0 && /\.(bin|hex|img)$/i.test(p), version: undefined };
    } catch {
      return { valid: false, error: 'file not readable' };
    }
  },

  listProfiles: () => pstore.listProfiles(),
  saveProfile: (p: AppProfile) => pstore.saveProfile(p),
  deleteProfile: (pid: string) => pstore.deleteProfile(pid),
  applyProfile: async (pid: string) => {
    const p = (await pstore.listProfiles()).find((x) => x.id === pid);
    if (!p) return [];
    return switcher.applyProfile(p);
  },
  // TODO: links are keyed by dev.model — promoting a generic-PID keyboard to
  // an exact catalog entry changes the model slug and orphans links captured
  // here (same caveat the old per-device snapshot capture had).
  //
  // A general profile is a pure link, so "capture" now means: for every
  // connected device, point this new profile at whichever onboard slot it is
  // currently on. It does NOT snapshot settings - there are no settings to
  // snapshot any more; the slot IS where they live.
  captureProfileFromDevices: async (name: string) => {
    const links: AppProfile['links'] = {};
    for (const dev of deviceManager.list()) {
      if (dev.capabilities.includes('profiles')) {
        links[dev.model] = { slot: dev.activeProfile ?? 1 };
      }
    }
    const profile: AppProfile = { id: randomUUID(), name, triggers: [], links };
    const saved = await pstore.saveProfile(profile);
    // saveProfile may have disambiguated the name ("gaming" -> "gaming 2");
    // hand back the stored record, not the requested one.
    return saved.find((p) => p.id === profile.id) ?? profile;
  },

  getSwitcherState: () => switcher.getState(),
  setSwitcherRunning: (running: boolean) => {
    // `start()` clears any pinned mode itself (see switcher.ts) — the
    // renderer confirms that with the user before ever calling here.
    running ? switcher.start() : switcher.stop();
    return switcher.getState();
  },
  setSwitcherSuspended: (suspended: boolean) => {
    switcher.setMenuOpen(suspended);
    return switcher.getState();
  },
  pinProfile: (pid: string | null) => switcher.pin(pid),
  scanGames: () => scanGames(),
  listRunningProcesses: (guiOnly?: boolean) => listRunningProcesses(guiOnly ?? true),
  pickExecutable: async () => {
    const isMac = platform.info().os === 'darwin';
    // Windows/Linux: filter on this OS's process suffix, if it has one
    // ('.exe' on Windows; Linux binaries have none). macOS: `.app` bundles —
    // Electron's native panel lets openFile select one as a package.
    const suffix = platform.info().processSuffix.replace('.', '');
    // A native dialog, so its words come from here rather than the renderer.
    const t = getT(getSettingsSync().language);
    const all = { name: t('dlg.filter.all'), extensions: ['*'] };
    const opts = {
      title: t('dlg.pickExe.title'),
      // A macOS open panel shows no title — its `message` is the line it
      // shows — and starts where the apps are.
      ...(isMac ? { message: t('dlg.pickExe.title'), defaultPath: '/Applications' } : {}),
      properties: ['openFile' as const],
      filters: isMac
        ? [{ name: t('dlg.filter.applications'), extensions: ['app'] }, all]
        : suffix
          ? [{ name: t('dlg.filter.programs'), extensions: [suffix] }, all]
          : [all],
    };
    const w = mainWin();
    const res = await (w ? dialog.showOpenDialog(w, opts) : dialog.showOpenDialog(opts));
    const picked = res.filePaths[0];
    if (res.canceled || !picked) return null;
    // macOS: the name the app RUNS under — its bundle's CFBundleExecutable,
    // what the running-process scan reports — rather than the bundle's own
    // name, which often differs (Steam.app runs as `steam_osx`), so a trigger
    // picked here never fired. The bundle name only when the plist can't be
    // read.
    if (isMac && picked.toLowerCase().endsWith('.app'))
      return (await bundleExecutableName(picked)) ?? basename(picked, '.app').toLowerCase();
    return basename(picked).toLowerCase();
  },

  getSettings: () => getSettings(),
  setSettings: async (patch: any) => {
    // Apply the OS-level change FIRST and let a failure propagate — otherwise
    // the setting is persisted (and the toggle reads "on") even when creating
    // the login item actually failed.
    if (patch.startAtBoot !== undefined) await platform.setStartAtBoot(patch.startAtBoot);
    const next = await setSettings(patch);
    if (patch.pollSeconds !== undefined) switcher.setPollSeconds(patch.pollSeconds);
    // Developer mode adds/removes simulated devices on the next scan pass;
    // nudge it so the grid reacts immediately instead of up to 2.5s later.
    if (patch.devMode !== undefined) deviceManager.nudgeScan();
    return next;
  },
  openMouseSettings: () => platform.openMouseSettings(),
  openExternal: (url: string) => platform.openExternal(url),
  getSystemDark: () => nativeTheme.shouldUseDarkColors,
  getPlatformInfo: () => ({
    ...platform.info(),
    isDev: !app.isPackaged,
    appVersion: app.getVersion(),
  }),

  windowMinimize: () => mainWin()?.minimize(),
  windowToggleMaximize: () => {
    const w = mainWin();
    if (!w) return;
    w.isMaximized() ? w.unmaximize() : w.maximize();
  },
  windowClose: () => mainWin()?.close(),
  windowIsMaximized: () => mainWin()?.isMaximized() ?? false,
  windowStartDrag: () => startWindowDrag(),
  windowEndDrag: () => stopWindowDrag(),

  getFrameLog: () => frameLog.all(),
  clearFrameLog: () => frameLog.clear(),
};

/** The real main window, for the custom titlebar controls — NOT just "the first
 *  live window", which could be the overlay or crash window. */
function mainWin(): BrowserWindow | null {
  const w = getMainWindow();
  return w && !w.isDestroyed() ? w : null;
}

// ---------------------------------------------------------------------------
// Manual titlebar drag — see Api.windowStartDrag's doc comment. Nearly every
// topbar element (Home, auto-switch toggle, language, settings, the window
// buttons) needs to both be clickable AND move the window on a press-drag,
// which a native `-webkit-app-region: drag` region can't do (it swallows all
// mouse input on Windows, so a button inside one never fires `click`). Driven
// from the OS cursor position rather than renderer pointermove deltas: once
// the window starts following the cursor, the pointer barely moves relative
// to the button any more, so screen-coordinate polling is what actually
// tracks a drag reliably.
// ---------------------------------------------------------------------------
let dragTimer: ReturnType<typeof setInterval> | null = null;
let dragWatchdog: ReturnType<typeof setTimeout> | null = null;

function stopWindowDrag(): void {
  if (dragTimer) clearInterval(dragTimer);
  if (dragWatchdog) clearTimeout(dragWatchdog);
  dragTimer = null;
  dragWatchdog = null;
}

function startWindowDrag(): void {
  const w = mainWin();
  if (!w) return;
  stopWindowDrag();
  const start = screen.getCursorScreenPoint();
  let offX: number;
  let offY: number;
  if (w.isMaximized()) {
    // Native Windows titlebar behaviour: restore-and-follow. Land the
    // restored window under the cursor at the same fractional X position it
    // had across the maximized width, then track from there.
    const maximizedBounds = w.getBounds();
    const frac = maximizedBounds.width
      ? (start.x - maximizedBounds.x) / maximizedBounds.width
      : 0.5;
    w.unmaximize();
    const restored = w.getBounds();
    offX = Math.round(frac * restored.width);
    offY = start.y - maximizedBounds.y;
    w.setPosition(start.x - offX, start.y - offY);
  } else {
    const b = w.getBounds();
    offX = start.x - b.x;
    offY = start.y - b.y;
  }
  dragTimer = setInterval(() => {
    const win = mainWin();
    if (!win || win.isDestroyed()) return stopWindowDrag();
    const p = screen.getCursorScreenPoint();
    // setPosition, not setBounds — avoids a DPI-mismatch resize when the
    // drag crosses a monitor with a different scale factor.
    win.setPosition(p.x - offX, p.y - offY);
  }, 16);
  // Belt-and-braces: a renderer crash or a missed pointerup would otherwise
  // leave the window following the cursor forever.
  dragWatchdog = setTimeout(stopWindowDrag, 30_000);
}

export function registerIpc(
  getWindows: () => BrowserWindow[],
  mainWindow: () => BrowserWindow | null = () => getWindows()[0] ?? null,
): void {
  getMainWindow = mainWindow;
  ipcMain.handle(IPC.invoke, async (_e, method: keyof Api, ...args: unknown[]) => {
    // Own-property lookup only — a bare `handlers[method]` also resolves
    // `Object.prototype` members ('toString', 'constructor', …) and would
    // invoke them.
    if (!Object.prototype.hasOwnProperty.call(handlers, method)) {
      throw new Error(`unknown IPC method: ${String(method)}`);
    }
    const fn = handlers[method]!;
    // Keyed on method + args so Base and Fn stay separate reads, while a second
    // caller for the *same* one joins the sweep already in flight.
    if (COALESCED_READS.has(method)) {
      return dedupeRead(`${String(method)}:${JSON.stringify(args)}`, async () => fn(...args));
    }
    return fn(...args);
  });

  const push = (channel: string, payload: unknown) => {
    // Device/switcher events fire on a timer; a window may be mid-teardown.
    for (const w of getWindows()) {
      if (w.isDestroyed() || w.webContents.isDestroyed()) continue;
      w.webContents.send(IPC.event, channel, payload);
    }
  };

  deviceManager.on('devices:changed', (d) => push('devices:changed', d));
  deviceManager.on('scan:diagnostic', (d) => push('scan:diagnostic', d));
  deviceManager.on('device:battery', (d) => push('device:battery', d));
  deviceManager.on('device:travel', (d) => push('device:travel', d));
  deviceManager.on('write:warning', (d) => push('write:warning', d));
  deviceManager.on('profiles:progress', (d) => push('profiles:progress', d));
  switcher.on('switcher:state', (s) => push('switcher:state', s));
  switcher.on('appProfiles:changed', () => push('appProfiles:changed', undefined));
  frameLog.onPush((e) => push('frame:log', e));

  nativeTheme.on('updated', () =>
    push('nativeTheme:changed', { dark: nativeTheme.shouldUseDarkColors }),
  );
}

/**
 * Per-window main-side wiring. Called from index.ts once the window exists.
 *
 * 1. Custom titlebar: tell the renderer when the OS (double-click, snap,
 *    Win+Up) changes the maximize state so its glyph stays in sync.
 * 2. Drop every live-state watch when the renderer goes away. A watch is armed
 *    by a mounted screen (see `setLiveWatch`), so one that outlives its
 *    renderer would keep polling a device with nothing on screen to show it.
 *    Whatever is actually open re-arms itself on the next render.
 */
export function wireWindowChrome(w: BrowserWindow): void {
  const send = () =>
    !w.isDestroyed() && w.webContents.send(IPC.event, 'window:maximized', w.isMaximized());
  w.on('maximize', send);
  w.on('unmaximize', send);
  w.webContents.on('did-start-loading', () => deviceManager.clearLiveWatches());
  w.on('closed', () => deviceManager.clearLiveWatches());
}
