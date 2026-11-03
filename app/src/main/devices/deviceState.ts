import { paths, readJson, withFileLock, writeJson } from '../store';

/**
 * Small per-model scratchpad for device state the wire protocol has no
 * confirmed GET for (e.g. the V8's receiver LEDs — command `0x2C` has no
 * known read; see compx-mouse-8k.ts's readReceiverLed). A driver persists its
 * last-written value here so a cold start shows "last known" instead of
 * "unreadable" forever. Keyed by model, not device id, for the same reason
 * `colors.ts` is — the id embeds a USB path that changes on replug.
 */
type Store = Record<string, Record<string, unknown>>;

async function readStore(): Promise<Store> {
  return readJson<Store>(paths.deviceState(), {});
}

export async function getDeviceState(model: string, key: string): Promise<unknown> {
  const store = await readStore();
  return store[model]?.[key];
}

export async function setDeviceState(model: string, key: string, value: unknown): Promise<void> {
  await withFileLock(paths.deviceState(), async () => {
    const store = await readStore();
    store[model] = { ...store[model], [key]: value };
    await writeJson(paths.deviceState(), store);
  });
}

/** Bind a `DriverContext.state` scratchpad to one model — see main/devices/manager.ts. */
export function deviceStateFor(model: string): {
  get(key: string): Promise<unknown>;
  set(key: string, v: unknown): Promise<void>;
} {
  return {
    get: (key) => getDeviceState(model, key),
    set: (key, v) => setDeviceState(model, key, v),
  };
}
