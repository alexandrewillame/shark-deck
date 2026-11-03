import type { Api } from '@shared/ipc';

/**
 * `window.sharkdeck`, reached lazily.
 *
 * Ten renderer modules used to do `const sd = window.sharkdeck` at module
 * scope, which reads `window` the instant the module is imported. That made
 * every one of them -- and anything importing them, transitively -- throw
 * `ReferenceError: window is not defined` in a plain Node test process. It is
 * why the repo's renderer tests could only ever target small `.ts` helpers
 * deliberately carved out of their components, and why the hooks in
 * tabs/common.tsx had no coverage at all.
 *
 * The Proxy defers the lookup to first property access, so importing a
 * renderer module in Node is now harmless and a test can install a stub
 * (or swap it per test) before anything touches it. Forwarding through a
 * Proxy is safe here because every preload method is an arrow closing over
 * `invoke` -- none of them depend on `this`.
 *
 * All ~146 `sd.readX(...)` call sites are unchanged.
 */
export const sd: Api = new Proxy({} as Api, {
  get(_target, prop) {
    const bridge = globalThis.window?.sharkdeck as unknown as
      Record<PropertyKey, unknown> | undefined;
    if (!bridge) {
      throw new Error(
        `window.sharkdeck is not available (tried to read "${String(prop)}"). ` +
          'In the app this means the preload bridge did not load; in a test it ' +
          'means window.sharkdeck was not stubbed -- see test/setup.ui.ts.',
      );
    }
    return bridge[prop];
  },
});
