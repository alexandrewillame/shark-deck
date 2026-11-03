import type { Api } from '@shared/ipc';
import { vi } from 'vitest';

type Fn = ReturnType<typeof vi.fn>;

/**
 * A stub for the whole `window.sharkdeck` surface.
 *
 * Auto-vivifying: any property read produces (and caches) a `vi.fn()` that
 * resolves `null`. That means the stub can never drift out of sync with the
 * 99-method `Api` interface -- adding a method needs no change here -- and a
 * test only has to override the two or three calls it actually cares about:
 *
 *   sdMock.readPollRate.mockResolvedValue(1000);
 *
 * `on()` is special-cased to return an unsubscriber, since callers store and
 * invoke the return value.
 */
const fns = new Map<PropertyKey, Fn>();

function fnFor(prop: PropertyKey): Fn {
  let f = fns.get(prop);
  if (!f) {
    f = prop === 'on' ? vi.fn(() => () => undefined) : vi.fn(() => Promise.resolve(null));
    fns.set(prop, f);
  }
  return f;
}

/** Indexable view of the stub, for `sdMock.readPollRate.mockResolvedValue(...)`. */
export const sdMock = new Proxy({} as Record<string, Fn>, {
  get: (_t, prop) => fnFor(prop),
});

export const sdStub = sdMock as unknown as Api;

/** Drop every recorded call and every override. Called before each test. */
export function resetSd(): void {
  fns.clear();
}
