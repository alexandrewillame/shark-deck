import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearDeviceCache,
  deviceCacheKey,
  dropDeviceCache,
  loadThroughCache,
  peekDeviceCache,
  putDeviceCache,
} from './deviceCache';

const K = (name: string, id = 'dev-1') => deviceCacheKey(id, name);

beforeEach(() => clearDeviceCache());

describe('deviceCacheKey', () => {
  it('scopes a name to one device', () => {
    expect(K('dpiLed', 'a')).not.toBe(K('dpiLed', 'b'));
  });
});

describe('loadThroughCache', () => {
  it('writes a result through so the next mount renders without a read', async () => {
    expect(peekDeviceCache(K('dpiLed')).hit).toBe(false);
    await loadThroughCache(K('dpiLed'), async () => ({ effect: 2 }));
    expect(peekDeviceCache<{ effect: number }>(K('dpiLed'))).toMatchObject({
      hit: true,
      value: { effect: 2 },
    });
  });

  /**
   * `null` is what `useDeviceData` registers as a read *failure*. Caching it
   * would hand the next pane a failure the device never actually reported, and
   * it would stick around for the life of the cache entry.
   */
  it('never caches a null answer', async () => {
    await loadThroughCache(K('receiverLed'), async () => null);
    expect(peekDeviceCache(K('receiverLed')).hit).toBe(false);
  });

  it('joins a read already in flight instead of starting a second one', async () => {
    let resolve!: (v: number) => void;
    const fn = vi.fn(() => new Promise<number>((r) => (resolve = r)));
    // The prefetch and a pane mounting at the same moment.
    const a = loadThroughCache(K('pollRate'), fn);
    const b = loadThroughCache(K('pollRate'), fn);
    expect(fn).toHaveBeenCalledTimes(1);
    resolve(1000);
    expect(await a).toBe(1000);
    expect(await b).toBe(1000);
  });

  it('lets a later read run once the first has settled', async () => {
    const fn = vi.fn(async () => 1);
    await loadThroughCache(K('x'), fn);
    await loadThroughCache(K('x'), fn);
    expect(fn).toHaveBeenCalledTimes(2); // an explicit reload must reach the device
  });

  it('does not leave a failed read wedged in the in-flight map', async () => {
    await expect(
      loadThroughCache(K('y'), async () => {
        throw new Error('nope');
      }),
    ).rejects.toThrow('nope');
    const fn = vi.fn(async () => 7);
    expect(await loadThroughCache(K('y'), fn)).toBe(7);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('passes straight through when the caller opted out of caching', async () => {
    const fn = vi.fn(async () => 5);
    expect(await loadThroughCache(null, fn)).toBe(5);
    await loadThroughCache(null, fn);
    expect(fn).toHaveBeenCalledTimes(2);
  });
});

describe('staleness', () => {
  it('marks a just-written entry fresh and an old one stale', () => {
    vi.useFakeTimers();
    try {
      putDeviceCache(K('sensor'), { lod: 1 });
      expect(peekDeviceCache(K('sensor'))).toMatchObject({ hit: true, stale: false });
      vi.advanceTimersByTime(60_000);
      // Still shown — just checked in the background rather than trusted blindly.
      expect(peekDeviceCache(K('sensor'))).toMatchObject({ hit: true, stale: true });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('dropDeviceCache', () => {
  it('forgets one device without touching another', () => {
    putDeviceCache(deviceCacheKey('a', 'dpiLed'), 1);
    putDeviceCache(deviceCacheKey('b', 'dpiLed'), 2);
    dropDeviceCache('a');
    expect(peekDeviceCache(deviceCacheKey('a', 'dpiLed')).hit).toBe(false);
    expect(peekDeviceCache(deviceCacheKey('b', 'dpiLed')).hit).toBe(true);
  });

  it('also drops in-flight reads, so a profile switch cannot land stale data', async () => {
    let resolve!: (v: number) => void;
    const first = loadThroughCache(
      deviceCacheKey('a', 'dpiStages'),
      () => new Promise<number>((r) => (resolve = r)),
    );
    dropDeviceCache('a');
    const fn = vi.fn(async () => 2);
    const second = loadThroughCache(deviceCacheKey('a', 'dpiStages'), fn);
    expect(fn).toHaveBeenCalledTimes(1); // did NOT join the pre-switch read
    resolve(1);
    await first;
    expect(await second).toBe(2);
  });
});
