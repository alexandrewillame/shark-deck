import { afterEach, beforeEach, vi } from 'vitest';
import { cleanup } from '@testing-library/react';
import { resetSd, sdStub } from './lib/sdStub';

/**
 * Setup for the `ui` tier (jsdom + React).
 *
 * Assigning window.sharkdeck is belt-and-braces now that
 * src/renderer/state/bridge.ts reaches it lazily -- but it has to exist before
 * anything calls through the bridge, and a missing stub should look like a
 * stub problem rather than a mysterious undefined.
 */
window.sharkdeck = sdStub;

/**
 * jsdom implements none of the three below, and the device-art measurement
 * path (components/ArtAnchor) uses the first two.
 *
 * These go through an untyped view of the globals on purpose: TypeScript types
 * `Window` as always having `matchMedia`, so a `'matchMedia' in window` guard
 * narrows to `never` and fails to compile -- even though jsdom genuinely omits
 * it at runtime.
 */
const g = globalThis as unknown as Record<string, unknown>;

if (typeof g.ResizeObserver !== 'function') {
  g.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}

if (typeof g.matchMedia !== 'function') {
  g.matchMedia = (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
    dispatchEvent: () => false,
  });
}

if (typeof Element.prototype.scrollIntoView !== 'function') {
  Element.prototype.scrollIntoView = function scrollIntoView() {};
}

beforeEach(() => resetSd());

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});
