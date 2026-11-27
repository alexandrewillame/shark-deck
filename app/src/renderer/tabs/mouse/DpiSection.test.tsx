import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { bridgeTo, liveDevice, settle } from '../../../../test/lib/simDevice';
import { VirtualDriver, virtualDescriptors } from '../../../main/devices/virtual';
import { DpiSection } from './DpiSection';

/**
 * A stage's number is its place in the mouse's cycle, not its rank by DPI.
 *
 * The X8 PRO's owner set stage 3 above stage 4 (11-27): the tab renamed them
 * 3 <-> 4 and re-sorted the list, while the mouse kept stepping 1, 2, 3, 4 and
 * lighting each stage its own colour — so the highlight went 1, 3, 2… as the
 * DPI button went round.
 */
describe('DPI stages', () => {
  it('are numbered and listed in the mouse’s cycle order, whatever their values', async () => {
    const descriptor = virtualDescriptors().find((d) => d.model === 'attack-shark-x8-pro')!;
    const vd = new VirtualDriver({
      descriptor: { ...descriptor, simulated: true },
      channel: {} as never,
      onWarning: () => undefined,
    });
    const seeded = await vd.readDpiStages();
    const values = [750, 1200, 2400, 1600];
    await vd.setDpiStages(values.map((dpi, i) => ({ ...seeded![i]!, index: i, dpi })));
    bridgeTo(vd);

    const { container } = render(<DpiSection device={liveDevice(descriptor, 'dpi-order')} />);
    await settle();

    const rows = [...container.querySelectorAll('.dpi-stage-list .row')];
    expect(rows.map((r) => r.querySelector('.dpi-stage-pick')!.textContent!.trim())).toEqual([
      '1',
      '2',
      '3',
      '4',
    ]);
    expect(
      rows.map((r) => (r.querySelector('input[type=number]') as HTMLInputElement).value),
    ).toEqual(values.map(String));

    // On the track, each tick keeps its stage's number and colour…
    const labels = [...container.querySelectorAll<HTMLElement>('.dpi-tick-label')];
    expect(labels.map((l) => l.textContent!.trim())).toEqual(['1', '2', '3', '4']);
    expect(labels.map((l) => l.style.getPropertyValue('--handle-color'))).toEqual(
      seeded!
        .slice(0, 4)
        .map((s) => '#' + s.color.map((c) => c.toString(16).padStart(2, '0')).join('')),
    );
    // …and the labels alternate above and below by place on the track, so
    // 1600 (stage 4, third from the left) is up and 2400 (stage 3) down.
    const side = (n: string) =>
      labels.find((l) => l.textContent!.trim() === n)!.getAttribute('data-side');
    expect(['1', '2', '4', '3'].map(side)).toEqual(['up', 'down', 'up', 'down']);
  });
});
