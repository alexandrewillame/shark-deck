import { readJson, withFileLock, writeJson } from '../store';

/**
 * Where a record about a DEMO device goes.
 *
 * Onboard profile names, the photo colour and actuation key groups are kept
 * per model (profileNames.ts, colors.ts, actuation/store.ts), and a simulated
 * device carries a real model's name — so through the ordinary stores, a demo
 * R85HE renamed its profiles and recoloured its photo on the user's real
 * R85HE, and replacing its key groups wiped the real board's. In the browser
 * edition demo mode is offered to every visitor, who may own that keyboard.
 *
 * So the same store code runs over two IOs: `realIo`, the app's storage, and
 * `demoIo`, an in-memory one that lives as long as the process (the tab, in
 * the browser) and is never written anywhere. The per-model logic — name
 * de-duplication, the key-group upsert rules — exists once, for both.
 */
export interface StoreIo {
  readJson<T>(file: string, fallback: T): Promise<T>;
  writeJson(file: string, data: unknown): Promise<void>;
  withFileLock<T>(file: string, fn: () => Promise<T>): Promise<T>;
}

/** The app's own storage. Calls through, so a test's mock of `../store` is seen. */
export const realIo: StoreIo = {
  readJson: (file, fallback) => readJson(file, fallback),
  writeJson: (file, data) => writeJson(file, data),
  withFileLock: (file, fn) => withFileLock(file, fn),
};

const memory = new Map<string, unknown>();
const locks = new Map<string, Promise<unknown>>();

/** Demo mode's records: memory only, gone when the app (or tab) closes. */
export const demoIo: StoreIo = {
  async readJson<T>(file: string, fallback: T): Promise<T> {
    return memory.has(file) ? (structuredClone(memory.get(file)) as T) : fallback;
  },
  async writeJson(file: string, data: unknown): Promise<void> {
    memory.set(file, structuredClone(data));
  },
  // The same read-modify-write serialisation the real store gives each file.
  withFileLock<T>(file: string, fn: () => Promise<T>): Promise<T> {
    const prev = locks.get(file) ?? Promise.resolve();
    const result = prev.then(fn, fn);
    locks.set(
      file,
      result.catch(() => undefined),
    );
    return result;
  },
};

/** The IO for a device's per-model records: demo devices never reach the real ones. */
export const ioFor = (simulated: boolean | undefined): StoreIo => (simulated ? demoIo : realIo);

/** Forget every demo record — tests start from nothing. */
export function clearDemoRecords(): void {
  memory.clear();
  locks.clear();
}
