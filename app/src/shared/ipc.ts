/**
 * The typed IPC contract. `Api` is the exact surface exposed on
 * `window.sharkdeck` by the preload bridge; `Events` is the set of
 * main -> renderer push messages.
 */
import type { AppSettings, PlatformInfo } from './types/app-settings';
import type {
  BackupExport,
  BackupImportResult,
  BackupInfo,
  DeviceAccessResult,
  FrameLogEntry,
  RunningProcess,
  ScanDiagnostic,
  ScannedGame,
} from './types/diagnostics';
import type {
  ActuationLayout,
  KeyGroup,
  KeyboardOptions,
  KeyZoneBindings,
  MagneticKeySettings,
} from './types/keyboard-settings';
import type { KeyBinding } from './types/keys';
import type {
  DpiLedSettings,
  LightingSettings,
  PerKeyColor,
  PerKeyLightingOpts,
  PerKeyLightingPreset,
  ReceiverLedSettings,
  ReceiverLedValues,
  SideLightingSettings,
} from './types/lighting';
import type { FirmwareInfo, LiveDevice, TravelStreamResult, WriteResult } from './types/live';
import type { Macro } from './types/macros';
import type {
  ButtonMapping,
  DpiDynamicSettings,
  DpiStage,
  PairingStatus,
  PerformanceSettings,
  PowerSettings,
  SensorSettings,
} from './types/mouse-settings';
import type { AppProfile, ProfileField, ProfileSnapshots, SwitcherState } from './types/profiles';

export interface Api {
  // ---- devices ----------------------------------------------------------
  listDevices(): Promise<LiveDevice[]>;
  refreshDevices(): Promise<LiveDevice[]>;
  getScanDiagnostic(): Promise<ScanDiagnostic>;
  getFirmware(deviceId: string): Promise<FirmwareInfo | null>;
  /** Renames one onboard profile slot (see LiveDevice.profileNames); empty name clears back to "Profile {n}". */
  renameOnboardProfile(model: string, slot: number, name: string): Promise<LiveDevice[]>;
  /** Sets the cosmetic colour/edition choice for a model (see LiveDevice.colorVariant); null clears it. */
  setDeviceColor(model: string, variantId: string | null): Promise<LiveDevice[]>;
  /**
   * Browser edition: open the browser's device picker so the user can let
   * Shark Deck reach a device — WebHID grants one device at a time, and only
   * from a click, so call this straight from the click handler. The desktop
   * app sees every device already and answers `not-needed`.
   */
  requestDeviceAccess(): Promise<DeviceAccessResult>;
  /** Browser edition: take back the browser's permission for this device. Desktop: `not-needed`. */
  forgetDevice(deviceId: string): Promise<DeviceAccessResult>;

  // ---- reads (null = the device did not answer; [] / {} = genuinely empty) --
  readDpiStages(deviceId: string): Promise<DpiStage[] | null>;
  /** 0-based index into readDpiStages()'s array of the stage currently applied to the mouse. */
  readActiveDpiStage(deviceId: string): Promise<number | null>;
  readSensor(deviceId: string): Promise<SensorSettings | null>;
  readPower(deviceId: string): Promise<PowerSettings | null>;
  readMagnetic(deviceId: string): Promise<MagneticKeySettings[]>;
  /** Mod-tap and DKS keys' per-zone bindings, by slot — what SharkDeck wrote,
   *  kept on this computer (see `KeyZoneBindings`): a mod-tap key's
   *  `[hold, tap]`, a DKS key's `[null, a2, a3, a4]`. Null on a device without. */
  readKeyZoneBindings(deviceId: string): Promise<KeyZoneBindings | null>;
  readLighting(deviceId: string): Promise<LightingSettings[]>;
  readSideLighting(deviceId: string): Promise<SideLightingSettings | null>;
  /** The keyboard's per-key picture; null when it did not answer — which is
   *  not the same as a picture with every key off ([]). */
  readPerKeyLighting(deviceId: string): Promise<PerKeyColor[] | null>;
  readReceiverLed(deviceId: string): Promise<ReceiverLedSettings | null>;
  readDpiLed(deviceId: string): Promise<DpiLedSettings | null>;
  readMacros(deviceId: string): Promise<Macro[]>;
  readButtons(deviceId: string): Promise<Record<number, ButtonMapping> | null>;
  readPollRate(deviceId: string): Promise<number | null>;
  readDebounce(deviceId: string): Promise<number | null>;
  readKeyboardOptions(deviceId: string): Promise<KeyboardOptions | null>;
  readPerformance(deviceId: string): Promise<PerformanceSettings | null>;
  readDpiDynamic(deviceId: string): Promise<DpiDynamicSettings | null>;
  readFnLayer(deviceId: string): Promise<Record<number, string>>;
  /** Every slot's current binding for one layer; null = the device did not
   *  answer. Supersedes readFnLayer (kept for back-compat). */
  readKeyBindings(
    deviceId: string,
    layer: 'base' | 'fn',
  ): Promise<Record<number, KeyBinding> | null>;
  /** One pairing-progress probe; `null` = the receiver did not answer, which is
   *  no evidence either way. Completion is an observed `linked` false -> true. */
  getPairingStatus(deviceId: string): Promise<PairingStatus | null>;

  // ---- writes (all verified by read-back where a GET exists) ----------
  setActiveProfile(deviceId: string, slot: number): Promise<WriteResult>;
  /**
   * Read every onboard slot so they can be compared.
   *
   * SLOW and VISIBLE: no read in the protocol takes a profile argument, so
   * this switches the device to each slot in turn and puts it back. Call it on
   * demand, behind a busy state — never from a prefetch.
   */
  snapshotProfiles(deviceId: string): Promise<ProfileSnapshots>;
  /** Copies `fields` (or everything this device reports) from one slot to
   *  another. Same switch-read-switch shape as `snapshotProfiles`. */
  copyProfile(
    deviceId: string,
    from: number,
    to: number,
    fields?: ProfileField[],
  ): Promise<WriteResult>;
  /**
   * Writes some keys' actuation settings to one onboard slot, whether or not
   * it is the active one — the profile comparator's per-key copy. Hops to the
   * slot and back silently, like `copyProfile`. `previous` is as for
   * `setMagneticKeys`: positional, and only the differing pages are sent.
   */
  setMagneticKeysOnProfile(
    deviceId: string,
    slot: number,
    keys: MagneticKeySettings[],
    previous?: MagneticKeySettings[],
  ): Promise<WriteResult>;
  setDpiStages(deviceId: string, stages: DpiStage[]): Promise<WriteResult>;
  setActiveDpiStage(deviceId: string, index: number): Promise<WriteResult>;
  setPollRate(deviceId: string, hz: number): Promise<WriteResult>;
  setSensor(deviceId: string, s: SensorSettings): Promise<WriteResult>;
  setPower(deviceId: string, p: PowerSettings): Promise<WriteResult>;
  setButton(deviceId: string, button: number, action: string): Promise<WriteResult>;
  /** Rich button assignment — action + params + combo/multimedia/macro payload. */
  setButtonMapping(deviceId: string, button: number, mapping: ButtonMapping): Promise<WriteResult>;
  setMagneticKey(deviceId: string, k: MagneticKeySettings): Promise<WriteResult>;
  /** Bulk per-key write for a multi-key selection (Actuation tab). */
  /**
   * `previous[i]` is what the caller last read for `keys[i]`, if it knows.
   * Given, only the pages that actually differ go on the wire — the difference
   * between six hundred frames and sixty when a selection is reset.
   */
  setMagneticKeys(
    deviceId: string,
    keys: MagneticKeySettings[],
    previous?: MagneticKeySettings[],
  ): Promise<WriteResult>;
  setMagneticGlobal(deviceId: string, actuationMm: number): Promise<WriteResult>;
  /** One key's per-zone bindings: a mod-tap key's hold in zone 0 with its own
   *  binding (the tap) in zone 1, or a DKS key's actions 2-4 in zones 1-3 —
   *  see `KeyZoneBindings`. */
  setKeyZoneBindings(
    deviceId: string,
    slot: number,
    zones: Array<string | null>,
  ): Promise<WriteResult>;
  setMagneticCalibration(deviceId: string, scope: 'zero' | 'max'): Promise<WriteResult>;
  setDebounce(deviceId: string, ms: number): Promise<WriteResult>;
  setKeyboardOptions(deviceId: string, options: Partial<KeyboardOptions>): Promise<WriteResult>;
  setPerformance(deviceId: string, p: PerformanceSettings): Promise<WriteResult>;
  setDpiDynamic(deviceId: string, d: DpiDynamicSettings): Promise<WriteResult>;
  setLighting(deviceId: string, l: LightingSettings): Promise<WriteResult>;
  setSideLighting(deviceId: string, l: SideLightingSettings): Promise<WriteResult>;
  setPerKeyLighting(
    deviceId: string,
    keys: PerKeyColor[],
    opts?: PerKeyLightingOpts,
  ): Promise<WriteResult>;
  setReceiverLed(deviceId: string, l: ReceiverLedValues): Promise<WriteResult>;
  setDpiLed(deviceId: string, l: DpiLedSettings): Promise<WriteResult>;
  setKeyRemap(
    deviceId: string,
    layer: 'base' | 'fn',
    index: number,
    action: string,
  ): Promise<WriteResult>;
  saveMacro(deviceId: string, m: Macro): Promise<WriteResult>;
  deleteMacro(deviceId: string, macroId: string): Promise<WriteResult>;
  restoreDefaults(deviceId: string): Promise<WriteResult>;
  /** Put the receiver into pairing mode (wireless mice). */
  startPairing(deviceId: string): Promise<WriteResult>;

  // ---- app-side macro library (device-independent — see main/macros/store.ts) --
  listMacroLibrary(): Promise<Macro[]>;
  saveMacroLibraryEntry(m: Macro): Promise<Macro[]>;
  deleteMacroLibraryEntry(id: string): Promise<Macro[]>;
  /** Writes one library macro into the device's one onboard macro slot. */
  pushMacroToDevice(deviceId: string, macroId: string): Promise<WriteResult>;

  // ---- app-side per-key lighting library (device-independent — see main/lighting/store.ts) --
  listPerKeyLightingLibrary(): Promise<PerKeyLightingPreset[]>;
  savePerKeyLightingLibraryEntry(p: PerKeyLightingPreset): Promise<PerKeyLightingPreset[]>;
  deletePerKeyLightingLibraryEntry(id: string): Promise<PerKeyLightingPreset[]>;
  /** Writes one saved preset's colours straight to the device. */
  applyPerKeyLightingLibraryEntry(
    deviceId: string,
    presetId: string,
    brightness?: number,
  ): Promise<WriteResult>;

  // ---- app-side actuation layouts + key groups (see main/actuation/store.ts) --
  listActuationLayouts(): Promise<ActuationLayout[]>;
  saveActuationLayout(l: ActuationLayout): Promise<ActuationLayout[]>;
  deleteActuationLayout(id: string): Promise<ActuationLayout[]>;
  /** Writes one saved layout's per-key settings straight to the device. */
  applyActuationLayout(deviceId: string, layoutId: string): Promise<WriteResult>;
  /** Key groups are per MODEL and per onboard PROFILE (slot), not per endpoint:
   *  `slots` are that board's matrix indices, and two of the same keyboard
   *  share them — but the settings a group is derived from belong to one
   *  profile, so each profile has its own groups and its own names. */
  listKeyGroups(model: string, profile: number): Promise<KeyGroup[]>;
  saveKeyGroup(model: string, profile: number, g: KeyGroup): Promise<KeyGroup[]>;
  deleteKeyGroup(model: string, profile: number, id: string): Promise<KeyGroup[]>;
  /** Replace one profile's whole group list. The list is derived from the
   *  board's own settings, so reconciling it has to be able to REMOVE groups —
   *  which an upsert cannot. See replaceKeyGroups in main/actuation/store.ts. */
  replaceKeyGroups(model: string, profile: number, groups: KeyGroup[]): Promise<KeyGroup[]>;

  // ---- replaceable magnetic switches (magnetism page 252) --------------
  /** slot -> switch model id, or null when the board did not answer. */
  readSwitchTypes(deviceId: string): Promise<Record<number, number> | null>;
  setSwitchTypes(
    deviceId: string,
    assignments: { slot: number; switchId: number }[],
  ): Promise<WriteResult>;

  // ---- live switch-travel monitor (magnetic keyboards) ----------------
  /**
   * Host-driven lighting: start streaming desktop colour ('screen') or audio
   * level ('music') to the board. See main/lighting/ambient.ts for why these
   * two effects need a host at all, and why this is a SharkDeck
   * implementation rather than a port of the vendor's frame.
   */
  startAmbientLighting(
    deviceId: string,
    mode: 'screen' | 'music',
    color: [number, number, number],
    /** The pane's Rainbow toggle. Every streamed frame carries it, so the
     *  board paints its own hues at whatever brightness the audio is driving
     *  — without it a music effect fell back to one static colour the moment
     *  the stream took over, whatever the toggle said. */
    dazzle: boolean,
  ): Promise<{ ok: boolean; error?: string }>;
  stopAmbientLighting(deviceId: string): Promise<void>;
  /**
   * One measurement for a running ambient effect: the screen's mean colour,
   * or 0..1 audio loudness. Measured in the renderer — it is the only place
   * with a video frame and an AnalyserNode — and written to the device on the
   * main process's own, much slower, cadence.
   */
  pushAmbientSample(
    deviceId: string,
    sample: { color?: [number, number, number]; level?: number },
  ): Promise<void>;

  /** Resolves with the board's own answer, once it has given one.
   *  @param intervalMs preferred sample cadence; the SLOWEST open request
   *  wins, and the floor is the driver's own read time. */
  startTravelStream(deviceId: string, intervalMs?: number): Promise<TravelStreamResult>;
  /** @param intervalMs the value this caller passed to `startTravelStream`,
   *  so its cadence vote can be withdrawn exactly rather than guessed at. */
  stopTravelStream(deviceId: string, intervalMs?: number): Promise<void>;

  // ---- live device-state monitoring -----------------------------------
  /**
   * Arm/disarm the DPI + poll-rate poll for one device. Armed by whichever
   * screen is showing that device, because those values can be changed with
   * the mouse's own buttons and would otherwise sit stale on screen; disarmed
   * as soon as nothing is showing them, so nothing polls in the background.
   */
  setLiveWatch(deviceId: string, on: boolean): Promise<void>;

  // ---- backup / restore --------------------------------------------------
  backupNow(deviceId: string): Promise<BackupInfo>;
  /**
   * The user's one-time OK to write to a device whose backup cannot hold every
   * setting (`LiveDevice.backupWaiver`), kept per model + firmware. Not a
   * device write: it lets the next one through `guardedWrite`.
   */
  acknowledgeNoBackup(deviceId: string): Promise<void>;
  listBackups(deviceId: string): Promise<BackupInfo[]>;
  restoreBackup(deviceId: string, file: string): Promise<WriteResult>;
  /** Delete one of this device's backups. Never touches the device itself. */
  deleteBackup(deviceId: string, file: string): Promise<{ ok: boolean; error?: string }>;
  /** One of this device's backups as JSON text, to save as a file. null = no such backup. */
  exportBackup(deviceId: string, file: string): Promise<BackupExport | null>;
  /**
   * Keep a backup file the user picked as one of this device's backups — the
   * way back from `exportBackup`, including from the other edition (desktop ↔
   * browser). It must be for this device's model. Never touches the device;
   * putting it back on the device is `restoreBackup`.
   */
  importBackup(deviceId: string, json: string): Promise<BackupImportResult>;

  // ---- firmware -------------------------------------------------------
  checkFirmwareFile(
    deviceId: string,
    path: string,
  ): Promise<{ valid: boolean; version?: string; error?: string }>;

  // ---- profiles + auto-switch ---------------------------------------
  listProfiles(): Promise<AppProfile[]>;
  saveProfile(p: AppProfile): Promise<AppProfile[]>;
  deleteProfile(id: string): Promise<AppProfile[]>;
  applyProfile(id: string): Promise<WriteResult[]>;
  /** Links a new profile to every connected device's *current* slot — does not snapshot settings. */
  captureProfileFromDevices(name: string): Promise<AppProfile>;

  getSwitcherState(): Promise<SwitcherState>;
  setSwitcherRunning(running: boolean): Promise<SwitcherState>;
  /** The renderer reports whether any device config tab is open — while one
   *  is, auto-switch holds off its poll/push loop rather than writing a
   *  profile underneath the menu the user is looking at (see
   *  SwitcherState.suspended). Resuming (no tabs left open) forces an
   *  immediate re-push of whatever mode should currently be active. */
  setSwitcherSuspended(suspended: boolean): Promise<SwitcherState>;
  pinProfile(profileId: string | null): Promise<SwitcherState>;
  scanGames(): Promise<ScannedGame[]>;
  /** On-demand, slower than the poll loop's own check — for the Auto-Switch
   *  "Refresh running apps" picker only. `guiOnly` (default true) keeps only
   *  processes with a visible window; pass false for the "show everything"
   *  escape hatch. */
  listRunningProcesses(guiOnly?: boolean): Promise<RunningProcess[]>;
  /** Opens a native file picker for an .exe; resolves to its lowercase
   *  basename (e.g. "cs2.exe"), or null if cancelled. */
  pickExecutable(): Promise<string | null>;

  // ---- app settings + platform ------------------------------------
  getSettings(): Promise<AppSettings>;
  setSettings(patch: Partial<AppSettings>): Promise<AppSettings>;
  /** Opens the OS's mouse-settings panel; resolves false if nothing on this
   *  OS/DE could be launched (see PlatformInfo.canOpenMouseSettings). */
  openMouseSettings(): Promise<boolean>;
  openExternal(url: string): Promise<void>;
  /** current OS-level dark-mode preference, for `themeMode: 'system'` */
  getSystemDark(): Promise<boolean>;
  /** static per-OS facts the renderer needs — see PlatformInfo */
  getPlatformInfo(): Promise<PlatformInfo>;

  // ---- custom window frame -----------------------------------------
  windowMinimize(): Promise<void>;
  windowToggleMaximize(): Promise<void>;
  windowClose(): Promise<void>;
  windowIsMaximized(): Promise<boolean>;
  /** Begin a manual titlebar drag: the main process follows the OS cursor
   *  and moves the window until windowEndDrag(). Used by topbar buttons,
   *  which cannot be native `-webkit-app-region: drag` regions and still
   *  receive click (a drag region swallows all mouse input on Windows). */
  windowStartDrag(): Promise<void>;
  windowEndDrag(): Promise<void>;

  // ---- leaving with changes nobody applied (renderer/state/leaveGuard.ts) ----
  /** Whether any screen holds such a change. While it does, the desktop holds
   *  a quit and sends `app:quitRequested` instead, so the renderer can ask. */
  setPendingChanges(pending: boolean): Promise<void>;
  /** Quit without asking again: the user answered the renderer's prompt. */
  quitApp(): Promise<void>;

  // ---- diagnostics -------------------------------------------------
  getFrameLog(): Promise<FrameLogEntry[]>;
  clearFrameLog(): Promise<void>;

  // ---- push events ----------------------------------------------------
  on<K extends keyof Events>(channel: K, cb: (payload: Events[K]) => void): () => void;
}

export interface Events {
  'devices:changed': LiveDevice[];
  'scan:diagnostic': ScanDiagnostic;
  'device:battery': { id: string; battery: number | null; charging: boolean };
  'switcher:state': SwitcherState;
  /** an auto-switch mode's (AppProfile) triggers or links changed from the
   *  main process itself rather than a renderer-initiated save — currently
   *  only fired once a manually-added Game/App is first seen running and its
   *  icon gets backfilled (see switcher.ts's tick()). The Auto-Switch screen
   *  re-fetches its profile list on this. */
  'appProfiles:changed': void;
  'frame:log': FrameLogEntry;
  'write:warning': { deviceId: string; message: string };
  /**
   * `snapshotProfiles` moving on to the next slot.
   *
   * The sweep is one long `invoke`, and on a keyboard it is tens of seconds
   * — a spinner with no number reads as a hang. This is the only thing the
   * sweep announces; it deliberately does NOT emit `devices:changed` as it
   * hops, which would remount every pane mid-read (see manager.ts).
   */
  'profiles:progress': { deviceId: string; slot: number; total: number };
  /** the custom titlebar's maximize glyph tracks this */
  'window:maximized': boolean;
  /** A quit was held because a change was never applied (see `setPendingChanges`):
   *  the window is on screen again, and the renderer asks before calling `quitApp`. */
  'app:quitRequested': void;
  /** OS dark-mode preference changed; the renderer re-applies `themeMode: 'system'` */
  'nativeTheme:changed': { dark: boolean };
  /**
   * Live per-key switch travel while the magnetic report stream is on.
   * `raw` is the untrimmed report hex (the parsed shape is still being
   * confirmed on hardware, decoded server-side — see compx-he-keyboard.ts's
   * decodeTravelFrame); `keys` is slot-indexed, matching every other
   * per-key wire operation.
   */
  'device:travel': {
    id: string;
    raw: string;
    keys?: { slot: number; mm: number }[];
    /** false when the sample was discarded or the read failed. A released key
     *  is expressed by absence from `keys`, so an incomplete sample must not
     *  be read as "every key came up". */
    complete?: boolean;
    /** The stream stopped without being asked to: the board stopped answering
     *  travel reads, or went offline. No sample follows; a consumer that
     *  still wants one starts the stream again. It used to just go quiet,
     *  which on screen is indistinguishable from nobody pressing a key. */
    ended?: boolean;
  };
}

export const IPC = {
  invoke: 'sharkdeck:invoke',
  event: 'sharkdeck:event',
} as const;
