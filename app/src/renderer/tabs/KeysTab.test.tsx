import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { DeviceDescriptor } from '@shared/types/device';
import { bridgeTo, liveDevice, settle } from '../../../test/lib/simDevice';
import { VirtualDriver, virtualDescriptors } from '../../main/devices/virtual';
import { KeysTab } from './KeysTab';

/**
 * The layer the Remap tab opens on: the Fn layer on every board that has one,
 * Base on a board that can only remap its base layer.
 */

async function openKeysTab(descriptor: DeviceDescriptor, id: string) {
  bridgeTo(
    new VirtualDriver({
      descriptor: { ...descriptor, simulated: true },
      channel: {} as never,
      onWarning: () => undefined,
    }),
  );
  const { container } = render(<KeysTab device={liveDevice(descriptor, id)} />);
  await settle();
  return container;
}

const boards = virtualDescriptors().filter(
  (d) => d.capabilities.includes('keyRemap') && d.capabilities.includes('fnLayer'),
);

describe('KeysTab', () => {
  it('has boards with both layers to open', () => {
    expect(boards.length).toBeGreaterThan(0);
  });

  it.each(boards.map((d) => [d.model, d] as const))(
    '%s opens on the Fn layer',
    async (model, d) => {
      const pane = await openKeysTab(d, `keys-default-${model}`);
      const shown = pane.querySelector('.title-tabs button[aria-current="page"]');
      expect(shown?.textContent).toBe('Fn layer');
      // …and lists it first, Base second.
      const tabs = [...pane.querySelectorAll('.title-tabs button')].map((b) => b.textContent);
      expect(tabs).toEqual(['Fn layer', 'Base']);
    },
  );

  it('opens on Base on a board with no Fn layer', async () => {
    const d = boards[0]!;
    const baseOnly = { ...d, capabilities: d.capabilities.filter((c) => c !== 'fnLayer') };
    const pane = await openKeysTab(baseOnly, 'keys-default-base-only');
    // One layer: its name is the title, with no tabs to choose between.
    expect(pane.querySelector('.title-tabs')).toBeNull();
    expect(pane.querySelector('.pane-head h2')?.textContent).toMatch(/^Base/);
  });
});
