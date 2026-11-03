import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC } from '@shared/ipc';
import { interfaceMembers, parse } from '../lib/ast';

/**
 * CLAUDE.md invariant: `src/preload/index.ts` hand-mirrors every method of
 * `interface Api` in `src/shared/ipc.ts`. There is no codegen, and `tsc` only
 * catches a *missing* method (via `const api: Api`) -- it cannot catch a method
 * wired to the wrong channel name, because every read is
 * `(id: string) => Promise<something>` and they are all mutually assignable.
 *
 * A mistake here is a runtime `undefined is not a function`, or worse: silently
 * calling a different handler than the one the caller asked for.
 *
 * Strategy: the AST gives the declared universe (types are erased at runtime,
 * so `Api` cannot be reflected); a mocked `electron` captures what the preload
 * actually exposes.
 */

const h = vi.hoisted(() => ({
  exposed: {} as Record<string, unknown>,
  key: '',
  invokes: [] as unknown[][],
  onRegistrations: 0,
}));

vi.mock('electron', () => ({
  contextBridge: {
    exposeInMainWorld: (key: string, api: Record<string, unknown>) => {
      h.key = key;
      h.exposed = api;
    },
  },
  ipcRenderer: {
    invoke: (...args: unknown[]) => {
      h.invokes.push(args);
      return Promise.resolve(null);
    },
    on: () => {
      h.onRegistrations += 1;
    },
  },
}));

const declared = interfaceMembers(parse('src/shared/ipc.ts'), 'Api').map((m) => m.name);

beforeAll(async () => {
  await import('../../src/preload/index');
});

beforeEach(() => {
  h.invokes.length = 0;
});

describe('preload bridge mirrors the Api contract', () => {
  it('parsed a plausible Api interface', () => {
    // Non-vacuity guard. Without this, a rename of `Api` (or a change to how
    // it is declared) would empty every list below and turn this whole file
    // into a test that passes while proving nothing.
    expect(
      declared.length,
      'parsed no Api members -- was the interface renamed, split, or moved?',
    ).toBeGreaterThan(80);
    expect(declared).toContain('listDevices');
    expect(declared).toContain('on');
  });

  it('exposes exactly the declared surface on window.sharkdeck', () => {
    expect(h.key).toBe('sharkdeck');

    const exposed = Object.keys(h.exposed);
    const missing = declared.filter((d) => !exposed.includes(d));
    const extra = exposed.filter((e) => !declared.includes(e));

    // Reported by name so the fix needs neither file opened.
    expect(missing, `Api methods missing from src/preload/index.ts: ${missing.join(', ')}`).toEqual(
      [],
    );
    expect(extra, `preload exposes methods absent from Api: ${extra.join(', ')}`).toEqual([]);
  });

  it('exposes only functions', () => {
    const notFn = Object.entries(h.exposed)
      .filter(([, v]) => typeof v !== 'function')
      .map(([k]) => k);
    expect(notFn, `non-function values exposed: ${notFn.join(', ')}`).toEqual([]);
  });

  /**
   * The check that earns this file. A copy-paste slip like
   *   readSensor: (id) => invoke('readPower', id)
   * typechecks, mirrors correctly by name, and silently returns the wrong
   * device data forever. Only calling each method and watching which channel
   * it asks for can catch it.
   */
  it('routes every method to its own channel name', () => {
    const wrong: string[] = [];
    const silent: string[] = [];

    for (const name of declared) {
      if (name === 'on') continue; // event subscription, not an invoke
      h.invokes.length = 0;

      const fn = h.exposed[name] as (...a: unknown[]) => unknown;
      // Args are positional and unused by the mock; every preload method is an
      // arrow that forwards whatever it is given.
      void fn(0, 0, 0, 0);

      if (h.invokes.length !== 1) {
        silent.push(`${name} (issued ${h.invokes.length} invokes, expected 1)`);
        continue;
      }
      const [channel, method] = h.invokes[0];
      if (channel !== IPC.invoke || method !== name) {
        wrong.push(`${name} -> invoke(${String(channel)}, ${String(method)})`);
      }
    }

    expect(silent, `methods that did not issue exactly one invoke: ${silent.join('; ')}`).toEqual(
      [],
    );
    expect(wrong, `methods wired to the wrong channel: ${wrong.join('; ')}`).toEqual([]);
  });

  it('on() returns a working unsubscriber and binds one shared listener', () => {
    const on = h.exposed.on as (ch: string, cb: (p: unknown) => void) => () => void;

    const off1 = on('devices:changed', () => {});
    const off2 = on('devices:changed', () => {});
    expect(typeof off1).toBe('function');

    // One ipcRenderer.on for the whole renderer, not one per subscription --
    // the per-call version tripped MaxListenersExceededWarning past ~10 subs.
    expect(h.onRegistrations).toBe(1);

    off1();
    off2();
    expect(() => off1()).not.toThrow(); // idempotent
  });
});
