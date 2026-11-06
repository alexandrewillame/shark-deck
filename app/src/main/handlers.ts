/**
 * The device-facing half of the `Api`, shared by both hosts: the Electron main
 * process (main/ipc.ts) and the browser edition (src/web/host/). It holds every
 * handler that needs only the device layer and the app-side libraries —
 * device reads and writes, onboard profiles, the macro / lighting / actuation
 * libraries, backups, live streams, the frame log and reading settings.
 *
 * Nothing reachable from here may import Electron or Node: the browser
 * edition bundles this file. test/contract/browser-node-free.test.ts walks
 * its imports to keep it that way.
 *
 * `guardedWrite` lives here, so CLAUDE.md invariant #1 — a backup exists
 * before the first write to any device — holds in both hosts by construction,
 * and test/contract/ipc-guarded-write.test.ts checks one table, not two.
 */
import type { Api } from '@shared/ipc';
import type { BackupExport, BackupImportResult } from '@shared/types/diagnostics';
import type { PerKeyLightingPreset } from '@shared/types/lighting';
import type { ActuationLayout, KeyGroup, KeyboardOptions } from '@shared/types/keyboard-settings';
import type { Macro } from '@shared/types/macros';
import { applicableDpiStages } from '@shared/mouse-wire';
import { layoutAddressable } from '@shared/menuGates';
import { isReadOnly } from './devices/identity';
import { deviceManager } from './devices/manager';
import * as mstore from './macros/store';
import * as lstore from './lighting/store';
import * as astore from './actuation/store';
import { writeActuationLayout } from './actuation/apply';
import * as ambient from './lighting/ambient';
import { getSettings } from './settings';
import { frameLog } from './diagnostics';
import {
  deleteBackupFile,
  listBackupFiles,
  parseBackupFile,
  readBackup,
  readBackupText,
  writeBackup,
} from './store';

/** One `Api` method's implementation, called with the renderer's positional arguments. */
export type Handler = (...args: any[]) => any;

/** A table of `Api` method implementations, keyed by method name. */
export type HandlerTable = { [K in keyof Api]?: Handler };

/** The methods a host must implement itself — every `Api` method the shared table does not. */
export type HostMethods = Exclude<keyof Api, 'on' | keyof DeviceHandlers>;

export interface DeviceHandlerDeps {
  /**
   * Runs once per guarded write, just before it. The desktop passes the
   * auto-switcher's dirty flag (see `switcher.noteDeviceWrite`); the browser
   * edition has no switcher. Required, so a host has to decide.
   */
  onDeviceWrite: () => void;
}

function driverOrThrow(deviceId: string) {
  const d = deviceManager.getDriver(deviceId);
  if (!d) throw new Error(`device not connected: ${deviceId}`);
  return d;
}

/**
 * The driver, for a write addressed to one key. Refused on a board whose
 * layout does not name every key's slot (shared/menuGates.ts
 * `layoutAddressable`): the renderer offers no per-key control there, and a
 * guessed slot is how a write lands on the wrong key. Whole-board writes go
 * through `driverOrThrow` as before.
 */
function perKeyDriverOrThrow(deviceId: string) {
  const d = deviceManager.getDescriptor(deviceId);
  if (d?.kind === 'keyboard' && !layoutAddressable({ keyMatrix: d.spec.keyMatrix })) {
    throw new Error('This keyboard has no per-key layout; only whole-board settings can be set.');
  }
  return driverOrThrow(deviceId);
}

export function createDeviceHandlers(deps: DeviceHandlerDeps) {
  /**
   * Every mutating handler goes through here so a full backup exists before
   * the first write to a device (CLAUDE.md invariant #1). `ensureBackup`
   * returns `false` when it could not take one (read threw / came back
   * empty) — the write must NOT proceed in that case, or a device that can be
   * written but not fully read gets mutated with nothing to restore from. A
   * `simulated` device legitimately has nothing to back up and returns
   * `false`; let it through.
   */
  async function guardedWrite<T>(deviceId: string, fn: () => Promise<T>): Promise<T> {
    const ok = await deviceManager.ensureBackup(deviceId);
    if (!ok && !deviceManager.getDescriptor(deviceId)?.simulated) {
      throw new Error('Refusing to write: could not take a backup of the device first.');
    }
    // Every mutating path funnels through here, which makes it the one honest
    // answer to "did anything actually change on a device while auto-switch
    // was paused?". The desktop's switcher uses it to decide whether resuming
    // needs to force the current mode back out — see `noteDeviceWrite` /
    // `dirtySinceSuspend` in profiles/switcher.ts.
    deps.onDeviceWrite();
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

  const deviceHandlers = {
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
      guardedWrite(id, () => perKeyDriverOrThrow(id).setSwitchTypes(assignments)),
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
    // flagged — the wire has no per-stage disable, so a stage that reaches a
    // slot is a stage the mouse can cycle into. Keeps every caller honest,
    // including a profile captured before the per-stage toggle was removed.
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
    // Not routed through `guardedWrite`: that is for the mutating `Api`
    // methods, which return a `WriteResult`, and this returns data. It does
    // still hop profiles, so `snapshotProfiles` takes the backup itself — the
    // invariant holds in fact, not only in the shape the contract test can see.
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
      guardedWrite(id, () => perKeyDriverOrThrow(id).setMagneticKey(k)),
    setMagneticKeys: (id: string, keys: any, previous?: any) =>
      guardedWrite(id, () => driverOrThrow(id).setMagneticKeys(keys, previous)),
    setMagneticGlobal: (id: string, mm: number) =>
      guardedWrite(id, () => driverOrThrow(id).setMagneticGlobal(mm)),
    setKeyZoneBindings: (id: string, slot: number, zones: Array<string | null>) =>
      guardedWrite(id, () => perKeyDriverOrThrow(id).setKeyZoneBindings(slot, zones)),
    setMagneticCalibration: (id: string, scope: 'zero' | 'max') =>
      guardedWrite(id, () => driverOrThrow(id).setMagneticCalibration(scope)),
    setDebounce: (id: string, ms: number) =>
      guardedWrite(id, () => driverOrThrow(id).setDebounce(ms)),
    readKeyboardOptions: (id: string) => driverOrThrow(id).readKeyboardOptions(),
    setKeyboardOptions: (id: string, o: Partial<KeyboardOptions>) =>
      guardedWrite(id, () => driverOrThrow(id).setKeyboardOptions(o)),
    setPerformance: (id: string, p: any) =>
      guardedWrite(id, () => driverOrThrow(id).setPerformance(p)),
    setDpiDynamic: (id: string, d: any) =>
      guardedWrite(id, () => driverOrThrow(id).setDpiDynamic(d)),
    setLighting: (id: string, l: any) => guardedWrite(id, () => driverOrThrow(id).setLighting(l)),
    setSideLighting: (id: string, l: any) =>
      guardedWrite(id, () => driverOrThrow(id).setSideLighting(l)),
    setPerKeyLighting: (id: string, keys: any, opts?: any) =>
      guardedWrite(id, () => perKeyDriverOrThrow(id).setPerKeyLighting(keys, opts)),
    setReceiverLed: (id: string, l: any) =>
      guardedWrite(id, () => driverOrThrow(id).setReceiverLed(l)),
    setDpiLed: (id: string, l: any) => guardedWrite(id, () => driverOrThrow(id).setDpiLed(l)),
    setKeyRemap: (id: string, layer: 'base' | 'fn', index: number, action: string) =>
      guardedWrite(id, () => perKeyDriverOrThrow(id).setKeyRemap(layer, index, action)),
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
          return {
            ok: false,
            verified: 'unverified' as const,
            error: 'Macro not found in library',
          };
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
          return {
            ok: false,
            verified: 'unverified' as const,
            error: 'Preset not found in library',
          };
        return driverOrThrow(id).setPerKeyLighting(preset.colors, { brightness });
      }),

    // App-side only, like the lighting library above: no device is touched, so
    // no backup is owed. Each returns the whole new list so the renderer never
    // refetches.
    listActuationLayouts: () => astore.listActuationLayouts(),
    saveActuationLayout: (l: ActuationLayout) => astore.saveActuationLayout(l),
    deleteActuationLayout: (lid: string) => astore.deleteActuationLayout(lid),
    applyActuationLayout: (id: string, layoutId: string) =>
      guardedWrite(id, async () => {
        const all = await astore.listActuationLayouts();
        const layout = all.find((x) => x.id === layoutId);
        if (!layout)
          return {
            ok: false,
            verified: 'unverified' as const,
            error: 'Layout not found in library',
          };
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

    startTravelStream: (id: string, intervalMs?: number) =>
      deviceManager.startTravel(id, intervalMs),
    stopTravelStream: (id: string, intervalMs?: number) =>
      deviceManager.stopTravel(id, true, { intervalMs }),

    setLiveWatch: (id: string, on: boolean) => deviceManager.setLiveWatch(id, on),

    acknowledgeNoBackup: (id: string) => deviceManager.acknowledgeNoBackup(id),
    backupNow: async (id: string) => {
      const desc = deviceManager.getDescriptor(id);
      const drv = driverOrThrow(id);
      // A simulated device has nothing to back up, and writeBackup() would
      // otherwise drop a file named for the *real* model — which listBackups()
      // would then report as a backup of actual hardware.
      if (desc?.simulated) throw new Error('simulated device: nothing to back up');
      // Nothing is read from a device that has not said what it is, or that
      // Shark Deck leaves alone — a file here would be named for its family.
      if (!desc || desc.identity === 'pending' || isReadOnly(desc)) {
        throw new Error('this device is not configured by Shark Deck: nothing to back up');
      }
      const blocks = await drv.backup();
      const file = await writeBackup(desc!.model, id, blocks);
      return {
        file,
        model: desc!.model,
        createdAt: Date.now(),
        blocks: Object.keys(blocks).length,
      };
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
      // `readBackup` already rejects a name that isn't a plain file name in
      // the backups area (see store.ts). Additionally refuse to replay a backup
      // taken from a different model — the wire layouts don't transfer, and
      // the UI only ever lists same-model backups, so a mismatch here is a bug
      // or a hand-edited request.
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
      // that isn't a plain file name in the backups area, and a backup
      // belonging to a different model is refused here — the UI only lists
      // same-model backups, so a mismatch is a bug or a hand-crafted request,
      // and this deletes.
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
    exportBackup: async (id: string, file: string): Promise<BackupExport | null> => {
      // The same guards as restore and delete: a plain name, and this device's model.
      const b = await readBackup(file);
      if (!b) return null;
      const desc = deviceManager.getDescriptor(id);
      if (desc && b.model !== desc.model) return null;
      const json = await readBackupText(file);
      return json === null ? null : { name: file, json };
    },
    importBackup: async (id: string, json: string): Promise<BackupImportResult> => {
      const desc = deviceManager.getDescriptor(id);
      if (!desc) return { ok: false, error: `device not connected: ${id}` };
      // Same reason as backupNow: the store is keyed by model, and a backup
      // filed against a simulated device would read as one of real hardware.
      if (desc.simulated) return { ok: false, error: 'simulated device: no backups' };
      const parsed = parseBackupFile(json);
      if ('error' in parsed) return { ok: false, error: parsed.error };
      if (parsed.model !== desc.model) {
        return { ok: false, error: `backup is for "${parsed.model}", not "${desc.model}"` };
      }
      const file = await writeBackup(parsed.model, parsed.serial, parsed.blocks, parsed.createdAt);
      await deviceManager.refreshBackupState(id);
      return {
        ok: true,
        info: {
          file,
          model: parsed.model,
          createdAt: parsed.createdAt,
          blocks: Object.keys(parsed.blocks).length,
        },
      };
    },

    getSettings: () => getSettings(),

    getFrameLog: () => frameLog.all(),
    clearFrameLog: () => frameLog.clear(),
  } satisfies HandlerTable;

  return deviceHandlers;
}

export type DeviceHandlers = ReturnType<typeof createDeviceHandlers>;

/**
 * Paged reads that must not stack.
 *
 * Each of these is a multi-frame sweep held open as one channel transaction,
 * and the renderer can ask for the same one again faster than it completes —
 * flipping the Remap tab between Base and Fn re-runs the effect
 * (`useDeviceData`'s deps are `[layer]`), and its `gen` counter only discards
 * the stale *result*: the sweep it started keeps running and the next one
 * queues behind it. Four flips is four full sweeps back to back on a firmware
 * the capture notes say wedges under sustained traffic.
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

/**
 * Method name + arguments in, a promise of the handler's result out — what
 * each host puts behind its own transport (the `sharkdeck:invoke` IPC channel
 * on the desktop, a direct call in the browser edition).
 *
 * The handler is called synchronously, before the first `await`, so a browser
 * handler that needs the click that triggered it (WebHID's `requestDevice`)
 * still has it.
 */
export function createDispatcher(
  table: HandlerTable,
): (method: string, args: unknown[]) => Promise<unknown> {
  const inflight = new Map<string, Promise<unknown>>();
  return (method, args) => {
    // Own-property lookup only — a bare `table[method]` also resolves
    // `Object.prototype` members ('toString', 'constructor', …) and would
    // invoke them.
    if (!Object.prototype.hasOwnProperty.call(table, method)) {
      return Promise.reject(new Error(`unknown IPC method: ${method}`));
    }
    const fn = table[method as keyof Api]!;
    const call = (): Promise<unknown> => {
      try {
        return Promise.resolve(fn(...args));
      } catch (err) {
        return Promise.reject(err);
      }
    };
    if (!COALESCED_READS.has(method)) return call();
    // Keyed on method + args so Base and Fn stay separate reads, while a second
    // caller for the *same* one joins the sweep already in flight.
    const key = `${method}:${JSON.stringify(args)}`;
    const existing = inflight.get(key);
    if (existing) return existing;
    const started = call().finally(() => inflight.delete(key));
    inflight.set(key, started);
    return started;
  };
}

/** Forward the device layer's events to a host's event channel. */
export function wireDeviceEvents(push: (channel: string, payload: unknown) => void): void {
  deviceManager.on('devices:changed', (d) => push('devices:changed', d));
  deviceManager.on('scan:diagnostic', (d) => push('scan:diagnostic', d));
  deviceManager.on('device:battery', (d) => push('device:battery', d));
  deviceManager.on('device:travel', (d) => push('device:travel', d));
  deviceManager.on('write:warning', (d) => push('write:warning', d));
  deviceManager.on('profiles:progress', (d) => push('profiles:progress', d));
  frameLog.onPush((e) => push('frame:log', e));
}
