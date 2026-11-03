import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * A recorded macro must never replay with a key held down for good.
 *
 * Three ways one was: focus leaving mid-recording (Alt+Tab, ⌘Tab — the
 * modifier's release goes to the other window), stopping while a key is still
 * down, and macOS, which delivers no keyup for a key released while ⌘ is held
 * (⌘C recorded as ⌘↓ C↓ ⌘↑).
 */

const key = (type: 'keydown' | 'keyup', code: string) =>
  window.dispatchEvent(new KeyboardEvent(type, { code, bubbles: true, cancelable: true }));

/** Load the recorder as on `platform` (it reads navigator.platform once). */
async function recorder(platform = 'Win32') {
  vi.resetModules();
  Object.defineProperty(navigator, 'platform', { value: platform, configurable: true });
  const { useMacroRecorder } = await import('./useMacroRecorder');
  const hook = renderHook(() =>
    useMacroRecorder({ timing: 'none', fixedMs: 50, uiRef: { current: null } }),
  );
  act(() => hook.result.current.start());
  return hook;
}

/** The take, as `kind value` per row. */
const rows = (hook: Awaited<ReturnType<typeof recorder>>) =>
  (hook.result.current.take?.groups ?? []).map((g) => `${g.kind} ${g.value}`);

afterEach(() => {
  Object.defineProperty(navigator, 'platform', { value: '', configurable: true });
});

describe('the macro recorder', () => {
  it('lets go of a modifier whose release went to another window', async () => {
    const hook = await recorder();
    act(() => {
      key('keydown', 'AltLeft'); // Alt+Tab: the Tab and the release never arrive
      window.dispatchEvent(new Event('blur'));
    });
    act(() => hook.result.current.stop());
    expect(rows(hook)).toEqual(['tap e2']);
  });

  it('lets go of a key still down when the recording stops', async () => {
    const hook = await recorder();
    act(() => key('keydown', 'KeyA'));
    act(() => hook.result.current.stop());
    expect(rows(hook)).toEqual(['tap 4']);
  });

  it('ignores a release whose press it never saw', async () => {
    const hook = await recorder();
    act(() => {
      key('keyup', 'KeyB'); // held before Record was pressed
      key('keydown', 'KeyA');
      key('keyup', 'KeyA');
    });
    act(() => hook.result.current.stop());
    expect(rows(hook)).toEqual(['tap 4']);
  });

  it('on macOS, lets go of what was pressed under ⌘ when ⌘ comes up', async () => {
    const hook = await recorder('MacIntel');
    act(() => {
      key('keydown', 'MetaLeft');
      key('keydown', 'KeyC'); // its keyup never comes on a Mac
      key('keyup', 'MetaLeft');
    });
    act(() => hook.result.current.stop());
    // ⌘ held across a tap of C — a chord, every key let go.
    expect(rows(hook)).toEqual(['press e3', 'tap 6', 'release e3']);
  });

  it('on macOS, records each Caps Lock event as a whole tap', async () => {
    const hook = await recorder('MacIntel');
    act(() => key('keydown', 'CapsLock')); // turning it on
    act(() => key('keyup', 'CapsLock')); // turning it off, a press later
    act(() => hook.result.current.stop());
    expect(rows(hook)).toEqual(['tap 39', 'tap 39']);
  });
});
