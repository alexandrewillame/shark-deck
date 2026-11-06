import { contextBridge, ipcRenderer } from 'electron';
import type { Api } from '@shared/ipc';
import { IPC } from '@shared/ipc';

/**
 * The ONLY bridge between the sandboxed renderer and the main process.
 * The renderer gets `window.sharkdeck` and nothing else — no Node, no ipc.
 */
const invoke = (method: keyof Api, ...args: unknown[]) =>
  ipcRenderer.invoke(IPC.invoke, method, ...args);

const api: Api = {
  listDevices: () => invoke('listDevices'),
  refreshDevices: () => invoke('refreshDevices'),
  getScanDiagnostic: () => invoke('getScanDiagnostic'),
  getFirmware: (id) => invoke('getFirmware', id),
  renameOnboardProfile: (model, slot, name) => invoke('renameOnboardProfile', model, slot, name),
  setDeviceColor: (model, variantId) => invoke('setDeviceColor', model, variantId),
  requestDeviceAccess: () => invoke('requestDeviceAccess'),
  forgetDevice: (id) => invoke('forgetDevice', id),

  readDpiStages: (id) => invoke('readDpiStages', id),
  readActiveDpiStage: (id) => invoke('readActiveDpiStage', id),
  readSensor: (id) => invoke('readSensor', id),
  readPower: (id) => invoke('readPower', id),
  readMagnetic: (id) => invoke('readMagnetic', id),
  readKeyZoneBindings: (id) => invoke('readKeyZoneBindings', id),
  readLighting: (id) => invoke('readLighting', id),
  readSideLighting: (id) => invoke('readSideLighting', id),
  readPerKeyLighting: (id) => invoke('readPerKeyLighting', id),
  readReceiverLed: (id) => invoke('readReceiverLed', id),
  readDpiLed: (id) => invoke('readDpiLed', id),
  readFnLayer: (id) => invoke('readFnLayer', id),
  readKeyBindings: (id, layer) => invoke('readKeyBindings', id, layer),
  readMacros: (id) => invoke('readMacros', id),
  readButtons: (id) => invoke('readButtons', id),
  readPollRate: (id) => invoke('readPollRate', id),
  readDebounce: (id) => invoke('readDebounce', id),
  readPerformance: (id) => invoke('readPerformance', id),
  readDpiDynamic: (id) => invoke('readDpiDynamic', id),

  setActiveProfile: (id, slot) => invoke('setActiveProfile', id, slot),
  snapshotProfiles: (id) => invoke('snapshotProfiles', id),
  copyProfile: (id, from, to, fields) => invoke('copyProfile', id, from, to, fields),
  setMagneticKeysOnProfile: (id, slot, keys, previous) =>
    invoke('setMagneticKeysOnProfile', id, slot, keys, previous),
  setDpiStages: (id, s) => invoke('setDpiStages', id, s),
  setActiveDpiStage: (id, i) => invoke('setActiveDpiStage', id, i),
  setPollRate: (id, hz) => invoke('setPollRate', id, hz),
  setSensor: (id, s) => invoke('setSensor', id, s),
  setPower: (id, p) => invoke('setPower', id, p),
  setButton: (id, b, a) => invoke('setButton', id, b, a),
  setButtonMapping: (id, b, m) => invoke('setButtonMapping', id, b, m),
  setMagneticKey: (id, k) => invoke('setMagneticKey', id, k),
  setMagneticKeys: (id, keys, previous) => invoke('setMagneticKeys', id, keys, previous),
  setMagneticGlobal: (id, mm) => invoke('setMagneticGlobal', id, mm),
  setKeyZoneBindings: (id, slot, zones) => invoke('setKeyZoneBindings', id, slot, zones),
  setMagneticCalibration: (id, scope) => invoke('setMagneticCalibration', id, scope),
  setDebounce: (id, ms) => invoke('setDebounce', id, ms),
  readKeyboardOptions: (id) => invoke('readKeyboardOptions', id),
  setKeyboardOptions: (id, o) => invoke('setKeyboardOptions', id, o),
  setPerformance: (id, p) => invoke('setPerformance', id, p),
  setDpiDynamic: (id, d) => invoke('setDpiDynamic', id, d),
  setLighting: (id, l) => invoke('setLighting', id, l),
  setSideLighting: (id, l) => invoke('setSideLighting', id, l),
  setPerKeyLighting: (id, keys, opts) => invoke('setPerKeyLighting', id, keys, opts),
  setReceiverLed: (id, l) => invoke('setReceiverLed', id, l),
  setDpiLed: (id, l) => invoke('setDpiLed', id, l),
  setKeyRemap: (id, layer, index, action) => invoke('setKeyRemap', id, layer, index, action),
  saveMacro: (id, m) => invoke('saveMacro', id, m),
  deleteMacro: (id, mid) => invoke('deleteMacro', id, mid),
  restoreDefaults: (id) => invoke('restoreDefaults', id),
  startPairing: (id) => invoke('startPairing', id),
  getPairingStatus: (id) => invoke('getPairingStatus', id),

  listMacroLibrary: () => invoke('listMacroLibrary'),
  saveMacroLibraryEntry: (m) => invoke('saveMacroLibraryEntry', m),
  deleteMacroLibraryEntry: (id) => invoke('deleteMacroLibraryEntry', id),
  pushMacroToDevice: (id, macroId) => invoke('pushMacroToDevice', id, macroId),

  listPerKeyLightingLibrary: () => invoke('listPerKeyLightingLibrary'),
  savePerKeyLightingLibraryEntry: (p) => invoke('savePerKeyLightingLibraryEntry', p),
  deletePerKeyLightingLibraryEntry: (id) => invoke('deletePerKeyLightingLibraryEntry', id),
  applyPerKeyLightingLibraryEntry: (id, presetId, brightness) =>
    invoke('applyPerKeyLightingLibraryEntry', id, presetId, brightness),
  readSwitchTypes: (id) => invoke('readSwitchTypes', id),
  setSwitchTypes: (id, assignments) => invoke('setSwitchTypes', id, assignments),
  listActuationLayouts: () => invoke('listActuationLayouts'),
  saveActuationLayout: (l) => invoke('saveActuationLayout', l),
  deleteActuationLayout: (id) => invoke('deleteActuationLayout', id),
  applyActuationLayout: (id, layoutId) => invoke('applyActuationLayout', id, layoutId),
  listKeyGroups: (model, profile) => invoke('listKeyGroups', model, profile),
  saveKeyGroup: (model, profile, g) => invoke('saveKeyGroup', model, profile, g),
  deleteKeyGroup: (model, profile, id) => invoke('deleteKeyGroup', model, profile, id),
  replaceKeyGroups: (model, profile, groups) => invoke('replaceKeyGroups', model, profile, groups),

  startAmbientLighting: (id, mode, color, dazzle) =>
    invoke('startAmbientLighting', id, mode, color, dazzle),
  stopAmbientLighting: (id) => invoke('stopAmbientLighting', id),
  pushAmbientSample: (id, sample) => invoke('pushAmbientSample', id, sample),
  startTravelStream: (id, intervalMs) => invoke('startTravelStream', id, intervalMs),
  stopTravelStream: (id, intervalMs) => invoke('stopTravelStream', id, intervalMs),

  setLiveWatch: (id, on) => invoke('setLiveWatch', id, on),

  backupNow: (id) => invoke('backupNow', id),
  acknowledgeNoBackup: (id) => invoke('acknowledgeNoBackup', id),
  listBackups: (id) => invoke('listBackups', id),
  restoreBackup: (id, file) => invoke('restoreBackup', id, file),
  deleteBackup: (id, file) => invoke('deleteBackup', id, file),
  exportBackup: (id, file) => invoke('exportBackup', id, file),
  importBackup: (id, json) => invoke('importBackup', id, json),

  checkFirmwareFile: (id, p) => invoke('checkFirmwareFile', id, p),

  listProfiles: () => invoke('listProfiles'),
  saveProfile: (p) => invoke('saveProfile', p),
  deleteProfile: (pid) => invoke('deleteProfile', pid),
  applyProfile: (pid) => invoke('applyProfile', pid),
  captureProfileFromDevices: (name) => invoke('captureProfileFromDevices', name),

  getSwitcherState: () => invoke('getSwitcherState'),
  setSwitcherRunning: (running) => invoke('setSwitcherRunning', running),
  setSwitcherSuspended: (suspended) => invoke('setSwitcherSuspended', suspended),
  pinProfile: (pid) => invoke('pinProfile', pid),
  scanGames: () => invoke('scanGames'),
  listRunningProcesses: (guiOnly?: boolean) => invoke('listRunningProcesses', guiOnly),
  pickExecutable: () => invoke('pickExecutable'),

  getSettings: () => invoke('getSettings'),
  setSettings: (patch) => invoke('setSettings', patch),
  openMouseSettings: () => invoke('openMouseSettings'),
  openExternal: (url) => invoke('openExternal', url),
  getSystemDark: () => invoke('getSystemDark'),
  getPlatformInfo: () => invoke('getPlatformInfo'),

  windowMinimize: () => invoke('windowMinimize'),
  windowToggleMaximize: () => invoke('windowToggleMaximize'),
  windowClose: () => invoke('windowClose'),
  windowIsMaximized: () => invoke('windowIsMaximized'),
  windowStartDrag: () => invoke('windowStartDrag'),
  windowEndDrag: () => invoke('windowEndDrag'),

  setPendingChanges: (pending) => invoke('setPendingChanges', pending),
  quitApp: () => invoke('quitApp'),

  getFrameLog: () => invoke('getFrameLog'),
  clearFrameLog: () => invoke('clearFrameLog'),

  on: (channel, cb) => {
    let set = subscribers.get(channel);
    if (!set) {
      set = new Set();
      subscribers.set(channel, set);
    }
    const entry = cb as (p: unknown) => void;
    set.add(entry);
    ensureBridgeListener();
    return () => {
      set!.delete(entry);
      if (set!.size === 0) subscribers.delete(channel);
    };
  },
};

/**
 * One `ipcRenderer.on(IPC.event, …)` for the whole renderer, fanning out to a
 * per-channel Set. The old code added a fresh listener per `on()` call on this
 * single channel, so a renderer with more than ~10 live subscriptions tripped
 * Node's `MaxListenersExceededWarning`.
 */
const subscribers = new Map<string, Set<(payload: unknown) => void>>();
let bridgeListenerBound = false;

function ensureBridgeListener(): void {
  if (bridgeListenerBound) return;
  bridgeListenerBound = true;
  ipcRenderer.on(IPC.event, (_e: unknown, ch: string, payload: unknown) => {
    const set = subscribers.get(ch);
    if (!set) return;
    for (const cb of [...set]) cb(payload);
  });
}

contextBridge.exposeInMainWorld('sharkdeck', api);
