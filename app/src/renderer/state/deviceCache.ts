/**
 * A small in-memory cache of what each device last told us, so moving between
 * the tabs of one device's menu doesn't re-read the hardware every time.
 *
 * Every config pane loads its own data on mount, and switching tab remounts
 * the pane (`key={active}:{configEpoch}` in DeviceConfig) — so each visit used
 * to mean a fresh HID round trip and a "Reading from device…" wait, over and
 * over, for values that had not changed. HID is slow and serialised, and a
 * dozing mouse makes it slower.
 *
 * The rules, in priority order:
 *
 *  - **A cached value renders immediately, with no spinner.** That is the
 *    whole point; a pane that has a value must never make the user wait to see
 *    it again.
 *  - **A cached value is still checked.** On mount the pane re-reads in the
 *    background and updates if the answer differs. Nothing is shown as fresh
 *    that was not confirmed within a few seconds of being shown.
 *  - **A background check may never make things worse.** If the re-read comes
 *    back `null` — a dozing device, a dropped report — the cached value stands.
 *    Turning a working pane into "Couldn't read this from the device" because
 *    of one missed poll would be a regression, not honesty: we have a real
 *    value and no evidence it changed.
 *  - **An explicit reload always hits the device.** The Re-read button and the
 *    re-read after a write bypass the cache entirely and write through it.
 *
 * Entries live in memory only, keyed by device id, and are dropped when the
 * device goes away or switches profile (see `dropDeviceCache`).
 */

interface Entry {
  value: unknown;
  at: number;
}

const cache = new Map<string, Entry>();
/** In-flight reads, so a prefetch and a pane mounting at the same moment share
 *  one round trip instead of racing to issue two. */
const inflight = new Map<string, Promise<unknown>>();

/** How long a cached value may be shown before a background check is worth the
 *  traffic. Short enough that a change made in another tool shows up quickly;
 *  long enough that flipping between two tabs is free. */
const REVALIDATE_AFTER_MS = 5_000;

export const deviceCacheKey = (deviceId: string, name: string): string => `${deviceId}::${name}`;

export function peekDeviceCache<T>(key: string | null): {
  hit: boolean;
  value?: T;
  stale: boolean;
} {
  if (!key) return { hit: false, stale: true };
  const e = cache.get(key);
  if (!e) return { hit: false, stale: true };
  return { hit: true, value: e.value as T, stale: Date.now() - e.at >= REVALIDATE_AFTER_MS };
}

export function putDeviceCache(key: string | null, value: unknown): void {
  if (key) cache.set(key, { value, at: Date.now() });
}

/**
 * Run `fn`, writing the result through to the cache — and joining an identical
 * read already in flight rather than starting a second one.
 */
export function loadThroughCache<T>(key: string | null, fn: () => Promise<T>): Promise<T> {
  if (!key) return fn();
  const existing = inflight.get(key) as Promise<T> | undefined;
  if (existing) return existing;
  const p = fn().then(
    (v) => {
      inflight.delete(key);
      // A null answer is "the device didn't tell us", not a value — caching it
      // would hand the next pane a read failure the device never reported.
      if (v !== null && v !== undefined) putDeviceCache(key, v);
      return v;
    },
    (e) => {
      inflight.delete(key);
      throw e;
    },
  );
  inflight.set(key, p);
  return p;
}

/**
 * Bumped for a device whenever its cached reads are thrown away.
 *
 * `useAutoWrite` captures it when a write is queued and drops that write if it
 * changed before the debounce elapsed. A queued write is built from values the
 * pane read earlier — after a profile switch those describe a slot the write
 * would no longer land on, and the debounce is long enough (250 ms) that a
 * slider nudged just before switching profiles would otherwise be flushed onto
 * the newly selected one by the unmount flush.
 */
const generation = new Map<string, number>();

export function deviceGeneration(deviceId: string): number {
  return generation.get(deviceId) ?? 0;
}

/** Forget everything known about one device — it disconnected, or its active
 *  profile changed and every per-profile value with it. */
export function dropDeviceCache(deviceId: string): void {
  const prefix = `${deviceId}::`;
  for (const k of [...cache.keys()]) if (k.startsWith(prefix)) cache.delete(k);
  for (const k of [...inflight.keys()]) if (k.startsWith(prefix)) inflight.delete(k);
  generation.set(deviceId, deviceGeneration(deviceId) + 1);
}

/** Test seam / hard reset. */
export function clearDeviceCache(): void {
  cache.clear();
  inflight.clear();
  for (const id of [...generation.keys()]) generation.set(id, deviceGeneration(id) + 1);
}
