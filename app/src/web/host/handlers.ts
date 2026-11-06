/**
 * The browser edition's side of the `Api` — every method the shared table in
 * main/handlers.ts does not implement, done the browser's way. The desktop's
 * counterpart is `desktopHandlers` in main/ipc.ts; the `satisfies` below makes
 * the compiler prove this table covers the same set.
 *
 * What the browser cannot do (auto-switch and app profiles, the native file
 * picker, window chrome, the OS mouse panel) answers with the empty shape the
 * renderer already handles, never a throw: the renderer hides those surfaces
 * in this edition (renderer/state/host.ts), and a stray call must not become
 * an error toast.
 */
import type { DeviceAccessResult } from '@shared/types/diagnostics';
import type { AppSettings, PlatformInfo } from '@shared/types/app-settings';
import type { SwitcherState } from '@shared/types/profiles';
import type { Handler, HostMethods } from '../../main/handlers';
import { deviceManager } from '../../main/devices/manager';
import { hidRequestFilters, resolveDescriptor } from '../../main/devices/registry';
import { setSettings } from '../../main/settings';

const IDLE_SWITCHER: SwitcherState = {
  running: false,
  suspended: false,
  activeProfileId: null,
  pinnedProfileId: null,
  lastEvent: null,
  lastSwitch: null,
  applying: null,
  current: null,
};

const describe = (err: unknown): string =>
  err instanceof Error ? `${err.name}: ${err.message}` : String(err);

/** `process.platform`'s vocabulary, from what the browser reports. ChromeOS reads as Linux. */
export function detectOs(nav: Navigator = navigator): PlatformInfo['os'] {
  const uaPlatform = (nav as Navigator & { userAgentData?: { platform?: string } }).userAgentData
    ?.platform;
  const p = (uaPlatform ?? nav.platform ?? '').toLowerCase();
  if (p.startsWith('win')) return 'win32';
  if (p.startsWith('mac')) return 'darwin';
  return 'linux';
}

const appVersion = (): string =>
  typeof __SD_APP_VERSION__ === 'string' ? __SD_APP_VERSION__ : '0.0.0-dev';

/** Every granted interface that belongs to the same model as `deviceId` — both of a V8's endpoints. */
async function grantedInterfacesOf(hid: HID, deviceId: string): Promise<HIDDevice[]> {
  const desc = deviceManager.getDescriptor(deviceId);
  if (!desc) return [];
  // By the model the VID/PID resolves to, not `desc.model`: a board the
  // firmware's model id moved to a better descriptor (resolveModelId) still
  // enumerates under its VID/PID's model.
  const model = resolveDescriptor(desc.vid, desc.pid)?.model;
  return (await hid.getDevices()).filter(
    (d) => resolveDescriptor(d.vendorId, d.productId)?.model === model,
  );
}

export const browserHandlers = {
  /**
   * WebHID's picker. `requestDevice` is the first thing called — before any
   * await — so the click that led here still counts as the user gesture
   * Chromium requires (main/handlers.ts `createDispatcher` calls handlers
   * synchronously for the same reason).
   */
  requestDeviceAccess: async (): Promise<DeviceAccessResult> => {
    const hid = navigator.hid;
    if (!hid) return { status: 'unsupported' };
    let picked: HIDDevice[];
    try {
      picked = await hid.requestDevice({ filters: hidRequestFilters() });
    } catch (err) {
      return { status: 'failed', error: describe(err) };
    }
    if (picked.length === 0) return { status: 'cancelled' };
    deviceManager.nudgeScan();
    return { status: 'granted', count: picked.length };
  },
  forgetDevice: async (id: string): Promise<DeviceAccessResult> => {
    const hid = navigator.hid;
    if (!hid) return { status: 'unsupported' };
    const mine = await grantedInterfacesOf(hid, id);
    if (mine.length === 0) return { status: 'failed', error: `device not connected: ${id}` };
    try {
      // `forget()` closes the device too; the next scan no longer lists it.
      for (const d of mine) await d.forget();
    } catch (err) {
      return { status: 'failed', error: describe(err) };
    }
    deviceManager.nudgeScan();
    return { status: 'forgotten' };
  },

  // No firmware files to pick in a browser (and nothing in the UI asks).
  checkFirmwareFile: async () => ({
    valid: false,
    error: 'not available in the browser edition',
  }),

  // Auto-switch and app profiles need the process list of the computer — the
  // part of Shark Deck that has to be installed. Out of the browser edition.
  listProfiles: async () => [],
  saveProfile: async () => [],
  deleteProfile: async () => [],
  applyProfile: async () => [],
  captureProfileFromDevices: async (): Promise<never> => {
    throw new Error('App profiles are not available in the browser edition');
  },
  getSwitcherState: async () => IDLE_SWITCHER,
  setSwitcherRunning: async () => IDLE_SWITCHER,
  setSwitcherSuspended: async () => IDLE_SWITCHER,
  pinProfile: async () => IDLE_SWITCHER,
  scanGames: async () => [],
  listRunningProcesses: async () => [],
  pickExecutable: async () => null,

  // No OS side effects to apply first (start-at-login, the switcher's poll
  // rate) and no simulated devices to add — just persist.
  setSettings: (patch: Partial<AppSettings>) => setSettings(patch),
  openMouseSettings: async () => false,
  // Nothing in the renderer opens links, and the edition makes no requests.
  openExternal: async () => {},
  getSystemDark: async () => matchMedia('(prefers-color-scheme: dark)').matches,
  getPlatformInfo: async (): Promise<PlatformInfo> => ({
    os: detectOs(),
    processSuffix: '',
    processExample: '',
    canOpenMouseSettings: false,
    nativeTrafficLights: false,
    isDev: import.meta.env.DEV,
    appVersion: appVersion(),
  }),

  // The browser draws the window.
  windowMinimize: async () => {},
  windowToggleMaximize: async () => {},
  windowClose: async () => {},
  windowIsMaximized: async () => false,
  windowStartDrag: async () => {},
  windowEndDrag: async () => {},

  // No quit to hold: a page asks through `beforeunload` (renderer/state/leaveGuard.ts).
  setPendingChanges: async (_pending: boolean) => {},
  quitApp: async () => {},
} satisfies { [K in HostMethods]: Handler };
