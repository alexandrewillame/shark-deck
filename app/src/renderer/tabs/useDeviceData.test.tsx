import { act, renderHook, waitFor } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearDeviceCache,
  deviceCacheKey,
  dropDeviceCache,
  putDeviceCache,
} from '../state/deviceCache';
import { ReadFailureContext, useDeviceData } from './common';

/**
 * `useDeviceData` is the read half of every config pane. Its subtlety is not
 * the happy path but four pieces of defensive machinery, none of which had
 * coverage:
 *
 *  - a generation counter, so a slow read for device A cannot land in the UI
 *    after the user has moved to device B;
 *  - a first-render cache seed, so switching tabs does not repaint a spinner
 *    over a value that is already known;
 *  - `quiet` mode, so a background revalidation behind an already-displayed
 *    value cannot replace it with a read-failure over one missed report;
 *  - `firstLoad`, which must never re-raise, or the row changes height and
 *    the control moves out from under the pointer mid-interaction.
 *
 * The cache treats an entry as stale after 5s (REVALIDATE_AFTER_MS), so the
 * stale cases use fake timers to age it rather than waiting.
 */

beforeEach(() => {
  clearDeviceCache();
});

/** A promise whose resolution this test controls. */
function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe('useDeviceData after a profile switch', () => {
  it('re-reads the device once the cache has been dropped', async () => {
    // The profile-switch bug. A switch remounts every pane (configEpoch), but
    // remounting alone changed nothing: the seed below is taken without asking
    // the device while the entry is inside its 5s revalidate window, so every
    // pane came back up showing the PREVIOUS profile's values -- and the next
    // control nudge wrote them onto the newly selected slot. Dropping the
    // cache first is what makes the remount actually re-read.
    const key = deviceCacheKey('devA', 'lighting');
    putDeviceCache(key, 'profile-1-effect');
    const loader = vi.fn(() => Promise.resolve('profile-2-effect'));

    const first = renderHook(() => useDeviceData('devA', loader, '', [], 'lighting'));
    expect(first.result.current.data).toBe('profile-1-effect');
    expect(loader).not.toHaveBeenCalled();
    first.unmount();

    dropDeviceCache('devA');
    const second = renderHook(() => useDeviceData('devA', loader, '', [], 'lighting'));
    await waitFor(() => expect(second.result.current.data).toBe('profile-2-effect'));
    expect(loader).toHaveBeenCalledTimes(1);
  });
});

describe('useDeviceData generation counter', () => {
  it('lets a later reload supersede an earlier in-flight one, whatever the resolve order', async () => {
    const first = deferred<string>();
    const second = deferred<string>();
    const loader = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);

    const { result } = renderHook(() => useDeviceData('devA', loader, 'initial'));

    // Kick off a second read while the first is still outstanding.
    await act(async () => {
      result.current.reload();
    });

    // Resolve them in the WRONG order: the superseded first read lands last.
    await act(async () => {
      second.resolve('second');
      first.resolve('first');
      await Promise.resolve();
    });

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(
      result.current.data,
      'a superseded read must not overwrite the newer value it lost the race to',
    ).toBe('second');
  });

  it('drops an in-flight load on unmount instead of setting state', async () => {
    const d = deferred<string>();
    const loader = vi.fn(() => d.promise);
    const errors: unknown[] = [];
    const spy = vi.spyOn(console, 'error').mockImplementation((...a) => void errors.push(a));

    const { unmount } = renderHook(() => useDeviceData('devA', loader, 'initial'));
    unmount();
    await act(async () => {
      d.resolve('late');
      await Promise.resolve();
    });

    expect(errors, 'resolving after unmount must not warn about setState').toEqual([]);
    spy.mockRestore();
  });
});

describe('useDeviceData cache seeding', () => {
  it('uses a FRESH cached value on the first render without calling the loader', async () => {
    const key = deviceCacheKey('devA', 'pollRate');
    putDeviceCache(key, 1000);
    const loader = vi.fn(() => Promise.resolve(4000));

    const { result } = renderHook(() => useDeviceData('devA', loader, 0, [], 'pollRate'));

    // No spinner frame, no round trip -- this is what makes tab switches instant.
    expect(result.current.data).toBe(1000);
    expect(result.current.loading).toBe(false);
    expect(result.current.firstLoad).toBe(false);
    await act(async () => {
      await Promise.resolve();
    });
    expect(loader, 'a fresh cache hit must not hit the device').not.toHaveBeenCalled();
  });

  it('shows a STALE cached value immediately, then revalidates quietly', async () => {
    const key = deviceCacheKey('devA', 'pollRate');
    // Age the entry past REVALIDATE_AFTER_MS by stamping it in the PAST, so
    // the body of the test can keep real timers. @testing-library waitFor
    // polls on real timers; with fake ones installed it never advances and
    // the test just times out.
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() - 6_000);
    putDeviceCache(key, 1000);
    vi.useRealTimers();

    const loader = vi.fn(() => Promise.resolve(4000));
    const { result } = renderHook(() => useDeviceData('devA', loader, 0, [], 'pollRate'));

    // The stale value is on screen at once, and the check behind it must not
    // raise the spinner.
    expect(result.current.data).toBe(1000);
    expect(result.current.loading).toBe(false);

    await act(async () => {
      await Promise.resolve();
    });
    expect(loader).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(result.current.data).toBe(4000));
  });

  it('re-reads when a dep changes, even though the mount was cache-fresh', async () => {
    // The documented Base<->Fn layer bug: the seed only excuses the FIRST
    // load. Skipping a later one because the original mount happened to be
    // fresh left the pane showing the previous layer while writes went to the
    // new one.
    const key = deviceCacheKey('devA', 'bindings');
    putDeviceCache(key, 'base-data');
    const loader = vi.fn((_id: string) => Promise.resolve('fn-data'));

    const { result, rerender } = renderHook(
      ({ layer }: { layer: string }) => useDeviceData('devA', loader, '', [layer], 'bindings'),
      { initialProps: { layer: 'base' } },
    );

    expect(result.current.data).toBe('base-data');
    expect(loader).not.toHaveBeenCalled();

    rerender({ layer: 'fn' });
    await waitFor(() => expect(loader).toHaveBeenCalledTimes(1));
  });
});

describe('useDeviceData quiet mode and firstLoad', () => {
  it('leaves the displayed value alone when a quiet revalidation reads null', async () => {
    const key = deviceCacheKey('devA', 'sensor');
    // Age the entry past REVALIDATE_AFTER_MS by stamping it in the PAST, so
    // the body of the test can keep real timers. @testing-library waitFor
    // polls on real timers; with fake ones installed it never advances and
    // the test just times out.
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() - 6_000);
    putDeviceCache(key, 'known');
    vi.useRealTimers();

    const loader = vi.fn(() => Promise.resolve(null));
    const { result } = renderHook(() =>
      useDeviceData<string | null>('devA', loader, null, [], 'sensor'),
    );

    expect(result.current.data).toBe('known');
    await act(async () => {
      await Promise.resolve();
    });
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(
      result.current.data,
      'one missed report must not replace a real value with a read failure',
    ).toBe('known');
  });

  it('never re-raises firstLoad on a later reload', async () => {
    const loader = vi.fn(() => Promise.resolve('v'));
    const { result } = renderHook(() => useDeviceData('devA', loader, ''));

    await waitFor(() => expect(result.current.firstLoad).toBe(false));

    await act(async () => {
      result.current.reload();
    });
    // `loading` may go true for the refresh, but firstLoad must stay false --
    // panes render their spinner on firstLoad precisely so the row does not
    // change height under the pointer.
    expect(result.current.firstLoad).toBe(false);
    await waitFor(() => expect(result.current.loading).toBe(false));
  });
});

describe('useDeviceData read-failure registry', () => {
  const wrap = (registry: {
    register: (k: string, r: () => void) => void;
    unregister: (k: string) => void;
  }) =>
    function Wrapper({ children }: { children: ReactNode }) {
      return createElement(ReadFailureContext.Provider, { value: registry }, children);
    };

  it('registers on a null read and unregisters once a value arrives', async () => {
    const register = vi.fn();
    const unregister = vi.fn();
    const loader = vi.fn<() => Promise<string | null>>(() => Promise.resolve(null));

    const { result } = renderHook(() => useDeviceData<string | null>('devA', loader, null), {
      wrapper: wrap({ register, unregister }),
    });

    // DeviceConfig renders ONE aggregate banner from these registrations,
    // instead of a per-section Re-read button.
    await waitFor(() => expect(register).toHaveBeenCalled());
    expect(register.mock.calls[0][1], 'must hand the banner a reload callback').toBeTypeOf(
      'function',
    );

    loader.mockResolvedValue('recovered');
    await act(async () => {
      result.current.reload();
    });
    await waitFor(() => expect(result.current.data).toBe('recovered'));
    expect(unregister).toHaveBeenCalled();
  });
});
