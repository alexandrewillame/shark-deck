import { describe, expect, it, vi } from 'vitest';

// handlers.ts reaches the device manager and so node-hid; nothing here talks
// to a device, but the native module must not load in a test process.
vi.mock('node-hid', () => ({
  default: { devicesAsync: async () => [], HIDAsync: { open: vi.fn() } },
}));

const { createDispatcher } = await import('./handlers');

describe('createDispatcher (both hosts’ method router)', () => {
  it('routes by own property only', async () => {
    const dispatch = createDispatcher({ listDevices: () => ['a'] });
    expect(await dispatch('listDevices', [])).toEqual(['a']);
    await expect(dispatch('toString', [])).rejects.toThrow(/unknown IPC method: toString/);
    await expect(dispatch('nope', [])).rejects.toThrow(/unknown IPC method: nope/);
  });

  it('calls the handler synchronously, before any await', () => {
    // A browser handler that opens the WebHID picker needs the click that
    // triggered it; a microtask hop before the call would be survivable, a
    // macrotask one would not. Prove there is no hop at all.
    const seen: string[] = [];
    const dispatch = createDispatcher({
      listDevices: () => {
        seen.push('handler');
        return [];
      },
    });
    void dispatch('listDevices', []);
    seen.push('after dispatch returned');
    expect(seen).toEqual(['handler', 'after dispatch returned']);
  });

  it('turns a synchronous throw into a rejection', async () => {
    const dispatch = createDispatcher({
      listDevices: () => {
        throw new Error('boom');
      },
    });
    await expect(dispatch('listDevices', [])).rejects.toThrow('boom');
  });

  it('joins a caller to an identical paged read already in flight, but never a write', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const read = vi.fn(async (_id: string, layer: string) => {
      await gate;
      return layer;
    });
    const write = vi.fn(async () => ({ ok: true }));
    const dispatch = createDispatcher({ readKeyBindings: read, setKeyRemap: write });

    const a = dispatch('readKeyBindings', ['kb', 'base']);
    const b = dispatch('readKeyBindings', ['kb', 'base']);
    const fn = dispatch('readKeyBindings', ['kb', 'fn']);
    void dispatch('setKeyRemap', ['kb', 'base', 1, 'A']);
    void dispatch('setKeyRemap', ['kb', 'base', 1, 'A']);
    release();

    expect(await a).toBe('base');
    expect(await b).toBe('base');
    expect(await fn).toBe('fn');
    expect(read).toHaveBeenCalledTimes(2); // base once, fn once
    expect(write).toHaveBeenCalledTimes(2);

    // Settled reads are not cached: the next call runs again.
    await dispatch('readKeyBindings', ['kb', 'base']);
    expect(read).toHaveBeenCalledTimes(3);
  });
});
