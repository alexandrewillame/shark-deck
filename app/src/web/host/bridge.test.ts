import { describe, expect, it, vi } from 'vitest';

// The bridge reaches the shared handlers, hence the device layer and node-hid;
// nothing here touches a device, but the native module must not load.
vi.mock('node-hid', () => ({
  default: { devicesAsync: async () => [], HIDAsync: { open: vi.fn() } },
}));

const { createBrowserBridge, createEventBus } = await import('./bridge');

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

describe('the browser bridge keeps IPC semantics', () => {
  it('hands out copies — neither side can reach into the other’s objects', async () => {
    const live = { devices: [{ id: 'a', online: true }] };
    let received: { n: number } | null = null;
    const { api } = createBrowserBridge(
      {
        listDevices: () => live.devices,
        renameOnboardProfile: (arg: { n: number }) => {
          received = arg;
          return [];
        },
      },
      createEventBus(),
    );

    const got = await api.listDevices();
    got[0]!.online = false;
    expect(live.devices[0]!.online).toBe(true);

    const mine = { n: 1 };
    await (api.renameOnboardProfile as unknown as (a: { n: number }) => Promise<unknown>)(mine);
    expect(received).toEqual({ n: 1 });
    expect(received).not.toBe(mine);
  });

  it('calls the handler synchronously — the click that opened the WebHID picker still counts', () => {
    const calls: string[] = [];
    const { api } = createBrowserBridge(
      {
        requestDeviceAccess: () => {
          calls.push('handler');
          return { status: 'cancelled' };
        },
      },
      createEventBus(),
    );
    void api.requestDeviceAccess();
    calls.push('returned');
    expect(calls).toEqual(['handler', 'returned']);
  });

  it('exposes exactly the table’s methods, plus on()', () => {
    const { api } = createBrowserBridge({ listDevices: () => [] }, createEventBus());
    expect(Object.keys(api).sort()).toEqual(['listDevices', 'on']);
  });

  it('counts device writes in flight, including ones that fail', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { api, writesInFlight } = createBrowserBridge(
      {
        setPollRate: async () => {
          await gate;
          return { ok: true, verified: 'match' };
        },
        restoreBackup: async () => {
          await gate;
          throw new Error('no');
        },
        listDevices: async () => {
          await gate;
          return [];
        },
      },
      createEventBus(),
    );
    const a = api.setPollRate('d', 1000);
    const b = api.restoreBackup('d', 'f').catch(() => null);
    const c = api.listDevices(); // a read: not counted
    expect(writesInFlight()).toBe(2);
    release();
    await Promise.all([a, b, c]);
    expect(writesInFlight()).toBe(0);
  });
});

describe('the in-page event bus', () => {
  it('delivers after push returns, in order, a copy per event', async () => {
    const bus = createEventBus();
    const seen: unknown[] = [];
    bus.on('devices:changed', (d) => seen.push(d));
    const payload = [{ id: 'a' }];
    bus.push('devices:changed', payload);
    expect(seen).toEqual([]); // not during the emitter's own call stack
    await tick();
    expect(seen).toEqual([[{ id: 'a' }]]);
    expect(seen[0]).not.toBe(payload);
  });

  it('keeps one subscriber’s throw from the others and from the emitter', async () => {
    const reported: unknown[] = [];
    const bus = createEventBus((err) => reported.push(err));
    const seen: string[] = [];
    bus.on('write:warning', () => {
      throw new Error('renderer bug');
    });
    bus.on('write:warning', () => seen.push('second'));
    expect(() => bus.push('write:warning', { deviceId: 'd', message: 'm' })).not.toThrow();
    await tick();
    expect(seen).toEqual(['second']);
    expect(reported).toHaveLength(1);
  });

  it('stops delivering after unsubscribe', async () => {
    const bus = createEventBus();
    const seen: unknown[] = [];
    const off = bus.on('frame:log', (e) => seen.push(e));
    off();
    bus.push('frame:log', { ts: 1 });
    await tick();
    expect(seen).toEqual([]);
  });

  it('delivers an event a handler emits before that handler’s own answer, as IPC does', async () => {
    const bus = createEventBus();
    const order: string[] = [];
    bus.on('devices:changed', () => order.push('event'));
    const { api } = createBrowserBridge(
      {
        setActiveProfile: async () => {
          bus.push('devices:changed', []);
          return { ok: true, verified: 'match' };
        },
      },
      bus,
    );
    await api.setActiveProfile('d', 2).then(() => order.push('answer'));
    expect(order).toEqual(['event', 'answer']);
  });
});
