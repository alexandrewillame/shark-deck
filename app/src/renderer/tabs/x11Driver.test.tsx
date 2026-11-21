import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { bridgeTo, liveDevice, settle } from '../../../test/lib/simDevice';
import { bekenMouseRoster, bekenReceiverDescriptor } from '../../main/devices/catalog/beken-mice';
import { BekenX11Mouse } from '../../main/devices/drivers/beken-8k-mouse';
import { configTabs } from './index';

/**
 * The X11's settings, drawn from what its own driver reads — the owner's
 * recorded report 10 — rather than from the simulated device. Its first test
 * build opened them on "Cannot read properties of undefined (reading 'wire')":
 * the Sensor panel assumed a list of lift-off distances, which the X11 does
 * not have, and the simulated X11 had read one anyway.
 */
const bytes = (hex: string) =>
  Uint8Array.from(
    hex
      .trim()
      .split(/\s+/)
      .map((h) => parseInt(h, 16)),
  );
/** Report 10 as the owner's X11 answered it at start.open (beken-8k-mouse.test.ts). */
const AT_START = bytes(
  '0a 80 01 01 fe 00 00 3f 20 20 12 25 38 4b 75 81 01 01 00 00 00 00 00 01 00 00 01 ff 00 00 00 ff 00 00 00 ff ff ff 00 00 ff ff ff 00 ff ff 40 00 ff ff ff 02 00 68 0f 30 01 38 ff 78 00 02 02 e4 01 02 00 00 03 00 00 04 00 00 00 00 00 00 00 00 0d 00 00 06 00 00 05 00 00 ' +
    '00 '.repeat(24) +
    '09 00 00 0a 00 00 34' +
    ' 00'.repeat(8),
);
const READY = bytes('a0 01 00 00 00 00 00 00');

/** The X11's driver over a mouse that answers report 10 as recorded. */
function x11(receiver: boolean) {
  const io = {
    write: async () => undefined,
    read: async () => null,
    readFeature: async (id: number) => (id === 0xa0 ? READY : id === 0x0a ? AT_START : null),
    readInput: async () => null,
    request: async () => null,
  };
  const channel = {
    transaction: <T,>(fn: (x: typeof io) => Promise<T>) => fn(io),
    write: io.write,
    readEvent: async () => null,
    descriptorRelease: 0x0110,
  };
  const descriptor = receiver
    ? bekenReceiverDescriptor(0x55)
    : bekenMouseRoster().find((d) => d.model === 'attack-shark-x11')!;
  const store = new Map<string, unknown>();
  const driver = new BekenX11Mouse({
    descriptor,
    channel: channel as never,
    onWarning: () => undefined,
    state: {
      get: async (k: string) => store.get(k),
      set: async (k: string, v: unknown) => void store.set(k, v),
    },
  });
  Object.assign(driver as unknown as Record<string, number>, {
    readWaitMs: 0,
    resendMs: 0,
    macroGapMs: 0,
  });
  return { descriptor, driver };
}

describe.each([
  ['on its cable', false],
  ['through its receiver', true],
])('the X11 %s', (_how, receiver) => {
  const { descriptor } = x11(receiver);
  const tabs = configTabs(liveDevice(descriptor, 'x11-tabs'));

  it('has its settings tabs', () => {
    expect(tabs.map((t) => t.id)).toEqual(expect.arrayContaining(['profile', 'buttons']));
  });

  for (const tab of tabs) {
    it(`opens its ${tab.id} tab on what its driver reads`, async () => {
      const { driver } = x11(receiver);
      bridgeTo(driver as never);
      const Tab = tab.component;
      const { container } = render(<Tab device={liveDevice(descriptor, `x11-${tab.id}`)} />);
      await settle();
      expect(container.textContent).not.toContain("Couldn't read this from the device.");
      expect(container.textContent?.length).toBeGreaterThan(0);
    });
  }
});
