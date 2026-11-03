import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { WriteResult } from '@shared/types/live';
import { clearDeviceCache, dropDeviceCache } from '../state/deviceCache';
import { useStore } from '../state/store';
import { useAutoWrite, useWrite } from './common';

/**
 * `useWrite` and `useAutoWrite` are what every config control writes through,
 * so their behaviour is the write behaviour of the whole app. Neither had any
 * coverage: `tabs/common.tsx` could not even be imported in a test process
 * until state/bridge.ts made the window.sharkdeck read lazy.
 *
 * These drive the real zustand store rather than a mock. The toast ladder's
 * output is the thing under test, and `isDevBuild()` reads
 * `useStore.getState().platformInfo`, so using the real store exercises the
 * real branch instead of a stand-in.
 */

const toastsOf = () => useStore.getState().toasts;

beforeEach(() => {
  useStore.setState({ toasts: [], platformInfo: undefined });
  clearDeviceCache();
});

/** A write that resolves to exactly this result. */
const resolving = (r: WriteResult) => vi.fn(() => Promise.resolve(r));

describe('useWrite toast ladder', () => {
  it('folds a REJECTED write into a failed WriteResult and toasts once', async () => {
    // The documented HidWedgedError regression: an unplugged device, or a
    // channel that blows its native-call deadline, rejects rather than
    // resolving {ok:false}. Uncaught, that was an unhandled rejection in the
    // renderer and NO toast at all -- the write just appeared to do nothing.
    const { result } = renderHook(() => useWrite());
    let out: WriteResult | undefined;
    await act(async () => {
      out = await result.current.run('DPI', () => Promise.reject(new Error('device wedged')));
    });

    expect(out).toEqual({ ok: false, verified: 'unverified', error: 'device wedged' });
    expect(toastsOf()).toHaveLength(1);
    expect(toastsOf()[0].kind).toBe('err');
    expect(toastsOf()[0].text).toContain('device wedged');
    expect(result.current.last).toEqual(out);
  });

  it('reports a failed write, falling back to "write failed" with no error', async () => {
    const { result } = renderHook(() => useWrite());
    await act(async () => {
      await result.current.run('DPI', resolving({ ok: false, verified: 'unverified' }));
    });
    expect(toastsOf()).toHaveLength(1);
    expect(toastsOf()[0].kind).toBe('err');
    expect(toastsOf()[0].text).toBe('DPI: write failed');
  });

  it('lets `note` short-circuit the mismatch branch, as ONE warning', async () => {
    // A multi-field write where the confirmed fields landed but one `inferred`
    // offset did not. This used to produce three separate warnings for a
    // single action, the last of which slandered the fields that
    // demonstrably worked.
    const { result } = renderHook(() => useWrite());
    await act(async () => {
      await result.current.run(
        'Sensor',
        resolving({ ok: true, verified: 'mismatch', note: 'LOD did not take' }),
      );
    });
    expect(toastsOf()).toHaveLength(1);
    expect(toastsOf()[0].kind).toBe('warn');
    expect(toastsOf()[0].text).toBe('Sensor: applied, but LOD did not take.');
  });

  it('warns on a bare mismatch', async () => {
    const { result } = renderHook(() => useWrite());
    await act(async () => {
      await result.current.run('Poll rate', resolving({ ok: true, verified: 'mismatch' }));
    });
    expect(toastsOf()).toHaveLength(1);
    expect(toastsOf()[0].kind).toBe('warn');
    expect(toastsOf()[0].text).toContain('read back a different value');
  });

  it('phrases `unverified` per build type', async () => {
    // Shipped builds say "applied": phrasing a successful write as a caveat
    // made ordinary use feel unreliable. Dev builds keep the detail.
    const { result } = renderHook(() => useWrite());

    await act(async () => {
      await result.current.run('Lighting', resolving({ ok: true, verified: 'unverified' }));
    });
    expect(toastsOf()[0].kind).toBe('info');
    expect(toastsOf()[0].text).toBe('Lighting: applied.');

    useStore.setState({ toasts: [], platformInfo: { isDev: true } as never });
    await act(async () => {
      await result.current.run('Lighting', resolving({ ok: true, verified: 'unverified' }));
    });
    expect(toastsOf()[0].text).toBe('Lighting: sent (no read-back available to confirm).');
  });

  it('confirms a verified write', async () => {
    const { result } = renderHook(() => useWrite());
    await act(async () => {
      await result.current.run('Debounce', resolving({ ok: true, verified: 'match' }));
    });
    expect(toastsOf()).toHaveLength(1);
    expect(toastsOf()[0].kind).toBe('info');
    expect(toastsOf()[0].text).toBe('Debounce: applied and confirmed.');
  });

  it('tracks `last` across a success then a failure', async () => {
    const { result } = renderHook(() => useWrite());
    await act(async () => {
      await result.current.run('A', resolving({ ok: true, verified: 'match' }));
    });
    expect(result.current.last).toEqual({ ok: true, verified: 'match' });
    await act(async () => {
      await result.current.run('B', resolving({ ok: false, verified: 'unverified', error: 'x' }));
    });
    expect(result.current.last).toEqual({ ok: false, verified: 'unverified', error: 'x' });
  });
});

describe('useAutoWrite debounce', () => {
  const ok = (): Promise<WriteResult> => Promise.resolve({ ok: true, verified: 'match' });

  it('coalesces rapid queue() calls into one write, carrying the LAST payload', async () => {
    vi.useFakeTimers();
    const write = vi.fn((_which: string) => ok());
    const { result } = renderHook(() => useAutoWrite(250));

    act(() => {
      result.current.queue('DPI', () => write('first'));
      result.current.queue('DPI', () => write('second'));
    });
    expect(write).not.toHaveBeenCalled();

    await act(async () => {
      vi.advanceTimersByTime(250);
    });
    expect(write).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenCalledWith('second');
  });

  it('does not fire before the delay elapses', async () => {
    vi.useFakeTimers();
    const write = vi.fn(ok);
    const { result } = renderHook(() => useAutoWrite(250));
    act(() => result.current.queue('DPI', write));

    await act(async () => {
      vi.advanceTimersByTime(249);
    });
    expect(write).not.toHaveBeenCalled();

    await act(async () => {
      vi.advanceTimersByTime(1);
    });
    expect(write).toHaveBeenCalledTimes(1);
  });

  it('flush() writes immediately and clears the pending write', async () => {
    vi.useFakeTimers();
    const write = vi.fn(ok);
    const { result } = renderHook(() => useAutoWrite(250));

    act(() => result.current.queue('DPI', write));
    await act(async () => {
      result.current.flush();
    });
    expect(write).toHaveBeenCalledTimes(1);

    // The timer must not fire a second write for the same queued value.
    await act(async () => {
      vi.advanceTimersByTime(500);
    });
    expect(write).toHaveBeenCalledTimes(1);
  });

  it('commit() flushes the queued write FIRST, in order', async () => {
    // The documented bug: clicking a toggle within the debounce window of a
    // slider drag silently dropped the value the slider had already moved to.
    vi.useFakeTimers();
    const order: string[] = [];
    const queued = vi.fn(() => {
      order.push('queued');
      return ok();
    });
    const committed = vi.fn(() => {
      order.push('committed');
      return ok();
    });
    const { result } = renderHook(() => useAutoWrite(250));

    act(() => result.current.queue('slider', queued));
    await act(async () => {
      result.current.commit('toggle', committed);
    });

    expect(queued).toHaveBeenCalledTimes(1);
    expect(committed).toHaveBeenCalledTimes(1);
    expect(order).toEqual(['queued', 'committed']);
  });

  it('flushes a pending write on unmount', async () => {
    vi.useFakeTimers();
    const write = vi.fn(ok);
    const { result, unmount } = renderHook(() => useAutoWrite(250));

    act(() => result.current.queue('DPI', write));
    await act(async () => {
      unmount();
    });
    expect(write, 'navigating away must not silently drop the value').toHaveBeenCalledTimes(1);
  });

  it('drops a queued write whose device state was thrown away', async () => {
    // The profile-switch bug: a slider nudged just before switching profiles
    // was still sitting in the 250 ms debounce, and the switch REMOUNTS the
    // pane -- so the unmount flush wrote the old profile's value onto the
    // newly selected slot. `dropDeviceCache` is what a profile switch (and a
    // disconnect) calls, so it is also the signal that a queued write no
    // longer describes the device it would land on.
    vi.useFakeTimers();
    const write = vi.fn(ok);
    const { result, unmount } = renderHook(() => useAutoWrite(250, { deviceId: 'kb-1' }));

    act(() => result.current.queue('Actuation', write));
    act(() => dropDeviceCache('kb-1'));
    await act(async () => {
      unmount();
    });
    expect(write, 'a write built from a discarded read must not land').not.toHaveBeenCalled();
  });

  it('still flushes a queued write when another device is dropped', async () => {
    // The guard is per device: unplugging the mouse must not silently eat a
    // pending keyboard write.
    vi.useFakeTimers();
    const write = vi.fn(ok);
    const { result } = renderHook(() => useAutoWrite(250, { deviceId: 'kb-1' }));

    act(() => result.current.queue('Actuation', write));
    act(() => dropDeviceCache('mouse-9'));
    await act(async () => {
      vi.advanceTimersByTime(250);
    });
    expect(write).toHaveBeenCalledTimes(1);
  });

  it('keeps the pending debounce when onSettled is a fresh inline arrow', async () => {
    // onSettled is held in a ref precisely so a caller passing an inline
    // closure does not re-create queue/commit each render and drop the timer.
    vi.useFakeTimers();
    const write = vi.fn(ok);
    const settled = vi.fn();
    const { result, rerender } = renderHook(() => useAutoWrite(250, { onSettled: settled }));

    act(() => result.current.queue('DPI', write));
    rerender(); // new inline arrow identity
    await act(async () => {
      vi.advanceTimersByTime(250);
    });

    expect(write).toHaveBeenCalledTimes(1);
    expect(settled).toHaveBeenCalledTimes(1);
    expect(settled).toHaveBeenCalledWith({ ok: true, verified: 'match' });
  });
});
