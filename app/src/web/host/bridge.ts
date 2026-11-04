/**
 * `window.sharkdeck` for the browser edition: the same `Api` the preload
 * bridge gives the desktop renderer, but answered in the page itself — no
 * process boundary, one dispatcher over the shared and browser tables.
 *
 * It keeps IPC's semantics on purpose, because the renderer was written
 * against them:
 *
 *  - Arguments and results are structured-cloned, as Electron's IPC does.
 *    Without that the renderer would hold the manager's own live objects
 *    (`list()` returns them), and a zustand store keeping one would watch it
 *    change underneath it — or change it.
 *  - Events are delivered asynchronously, each subscriber on its own: a
 *    renderer listener that throws must not unwind into the device manager's
 *    scan pass that emitted the event. A microtask keeps IPC's ordering — an
 *    event a handler emits arrives before that handler's own answer.
 */
import type { Api, Events } from '@shared/ipc';
import { createDispatcher, type HandlerTable } from '../../main/handlers';

/**
 * The calls that change a device's configuration. The bridge counts them in
 * flight so web/main.ts can warn before the tab closes mid-write. Every `Api`
 * method returning a `WriteResult` must be listed — pinned by
 * test/contract/browser-api.test.ts — plus the profile sweep, which steps the
 * device through its onboard slots and back.
 */
export const DEVICE_WRITES: ReadonlySet<string> = new Set([
  'setActiveProfile',
  'copyProfile',
  'setMagneticKeysOnProfile',
  'setDpiStages',
  'setActiveDpiStage',
  'setPollRate',
  'setSensor',
  'setPower',
  'setButton',
  'setButtonMapping',
  'setMagneticKey',
  'setMagneticKeys',
  'setMagneticGlobal',
  'setKeyZoneBindings',
  'setMagneticCalibration',
  'setDebounce',
  'setKeyboardOptions',
  'setPerformance',
  'setDpiDynamic',
  'setLighting',
  'setSideLighting',
  'setPerKeyLighting',
  'setReceiverLed',
  'setDpiLed',
  'setKeyRemap',
  'saveMacro',
  'deleteMacro',
  'restoreDefaults',
  'startPairing',
  'pushMacroToDevice',
  'applyPerKeyLightingLibraryEntry',
  'applyActuationLayout',
  'setSwitchTypes',
  'restoreBackup',
  'applyProfile',
  'snapshotProfiles',
]);

type Listener = (payload: unknown) => void;

export interface EventBus {
  on<K extends keyof Events>(channel: K, cb: (payload: Events[K]) => void): () => void;
  /** Deliver one event to every current subscriber of `channel`. */
  push(channel: string, payload: unknown): void;
}

/** Surfaces a listener's error the way an uncaught one would be — main.tsx toasts it. */
function reportUncaught(err: unknown): void {
  if (typeof reportError === 'function') reportError(err);
  else console.error(err);
}

export function createEventBus(report: (err: unknown) => void = reportUncaught): EventBus {
  const subscribers = new Map<string, Set<Listener>>();
  return {
    on(channel, cb) {
      let set = subscribers.get(channel);
      if (!set) subscribers.set(channel, (set = new Set()));
      const listener = cb as Listener;
      set.add(listener);
      return () => {
        set!.delete(listener);
      };
    },
    push(channel, payload) {
      const set = subscribers.get(channel);
      if (!set?.size) return;
      // One copy per event, shared by its subscribers — what the preload's
      // own fan-out hands them on the desktop.
      const copy = payload === undefined ? undefined : structuredClone(payload);
      queueMicrotask(() => {
        for (const listener of [...set]) {
          try {
            listener(copy);
          } catch (err) {
            report(err);
          }
        }
      });
    },
  };
}

export interface BrowserBridge {
  api: Api;
  /** Device writes started and not yet settled — see `DEVICE_WRITES`. */
  writesInFlight(): number;
}

export function createBrowserBridge(table: HandlerTable, bus: EventBus): BrowserBridge {
  const dispatch = createDispatcher(table);
  let writes = 0;
  const api: Record<string, unknown> = {};
  for (const method of Object.keys(table)) {
    const isWrite = DEVICE_WRITES.has(method);
    api[method] = (...args: unknown[]): Promise<unknown> => {
      // Called synchronously all the way to the handler (see createDispatcher)
      // — `requestDeviceAccess` needs the user gesture this call came from.
      const pending = dispatch(method, structuredClone(args)).then((r) =>
        r === undefined ? undefined : structuredClone(r),
      );
      if (!isWrite) return pending;
      writes++;
      return pending.finally(() => {
        writes--;
      });
    };
  }
  api.on = bus.on;
  return { api: api as unknown as Api, writesInFlight: () => writes };
}
