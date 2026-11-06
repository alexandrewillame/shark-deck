import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { GATES, configurable, gate, openGates, type GateId, type TabId } from '@shared/menuGates';
import { bridgeTo, liveDevice, settle } from '../../../test/lib/simDevice';
import { VirtualDriver, virtualDescriptors } from '../../main/devices/virtual';
import { provisionalHub, provisionalRoyuan } from '../../main/devices/registry';
import { GateProbe } from '../components/Gated';
import { setPaneView } from '../state/paneView';
import { configTabs } from './index';

/**
 * Every model's menus, drawn, against the gate table (shared/menuGates.ts).
 *
 * For each simulated device (one per catalogue model and fallback family —
 * the same roster developer mode shows), every tab and sub-view is rendered
 * with its reads answered by the VirtualDriver, and the `<Gated>` probe records
 * which controls actually drew. Two checks:
 *
 *  - nothing draws whose gate is closed — a setting the model does not have;
 *  - every always-visible control whose gate is open does draw — a gate the
 *    UI forgot to honour.
 *
 * Controls only drawn on demand (inside a closed menu, or once a key is
 * selected) are covered by the first check and by menuGates.test.ts.
 */

/** Controls that draw as soon as their tab / view is shown. */
const ALWAYS_DRAWN = new Set<GateId>([
  'dpi.section',
  'dpi.stageColors',
  'poll.section',
  'sensor.section',
  'sensor.lod',
  'sensor.mode',
  'sensor.motionSync',
  'sensor.angleSnap',
  'sensor.angleMode',
  'sensor.ripple',
  'sensor.highFps',
  'sensor.longRange',
  'debounce.mouse',
  'debounce.keyboard',
  'perf.section',
  'dpiDynamic.section',
  'kb.fnLayout',
  'power.section',
  'keys.base',
  'keys.fn',
  'act.perKey',
  'act.wholeBoard',
  'act.test',
  'light.kbEffects',
  'light.perKeyPaint',
  'light.side',
  'light.receiver',
  'light.dpiLed',
  'light.body',
  'dev.switches',
  'dev.colour',
  'dev.pair',
  'dev.restore',
  'dev.identity',
]);

/** Sub-views per tab, and the pane-view key each is remembered under. */
const VIEWS: Partial<Record<TabId, { key: string; views: string[] }>> = {
  keys: { key: 'keys.layer', views: ['base', 'fn'] },
  actuation: { key: 'act.view', views: ['keys', 'test'] },
  device: { key: 'device.view', views: ['device', 'switches'] },
};

// Developer mode's roster, plus a device of each family that has not said
// what it is yet — real hardware shows one of those on every plug-in.
const roster = [
  ...virtualDescriptors(),
  { ...provisionalHub(0xf517), model: 'pending-hub' },
  { ...provisionalRoyuan(0x3151, 0x5029), model: 'pending-royuan' },
];

describe.each(roster.map((d) => [d.model, d] as const))('%s', (_model, descriptor) => {
  it('offers exactly the tabs its gates open', () => {
    const device = liveDevice(descriptor, `gates-tabs-${descriptor.model}`);
    const tabs = configTabs(device).map((t) => t.id);
    if (!configurable(device)) {
      // pending, another brand's, unknown or unsupported: what it is, nothing to set
      expect(tabs).toEqual(['device']);
      return;
    }
    const expected = ['profile', 'device'];
    for (const id of [
      'tab.buttons',
      'tab.keys',
      'tab.actuation',
      'tab.macros',
      'tab.lighting',
    ] as const) {
      if (gate(id, device)) expected.push(GATES[id].tab);
    }
    expect([...tabs].sort()).toEqual([...expected].sort());
  });

  const device0 = liveDevice(descriptor, 'probe');
  for (const tab of configTabs(device0)) {
    const views = VIEWS[tab.id as TabId]?.views ?? [undefined];
    for (const view of views) {
      it(`draws the ${tab.id}${view ? `/${view}` : ''} controls its gates open, and no others`, async () => {
        const id = `gates-${descriptor.model}-${tab.id}-${view ?? ''}`;
        const device = liveDevice(descriptor, id);
        const vd = new VirtualDriver({
          descriptor: { ...descriptor, simulated: true },
          channel: {} as never,
          onWarning: () => undefined,
        });
        bridgeTo(vd);
        const v = VIEWS[tab.id as TabId];
        if (v && view) setPaneView(`${id}:${v.key}`, view);

        const probe = new Set<GateId>();
        const Tab = tab.component;
        render(
          <GateProbe.Provider value={probe}>
            <Tab device={device} />
          </GateProbe.Provider>,
        );
        await settle();

        const open = new Set(openGates(device));
        const drawnButClosed = [...probe].filter((g) => !open.has(g));
        expect(drawnButClosed, 'drawn although the model lacks it').toEqual([]);

        const missing = [...open].filter((g) => {
          const def = GATES[g] as { tab: string; view?: string };
          if (!ALWAYS_DRAWN.has(g) || def.tab !== tab.id) return false;
          if (def.view && view && def.view !== view) return false;
          if (def.view && !view) return false;
          return !probe.has(g);
        });
        expect(missing, 'gate open but not drawn').toEqual([]);
      });
    }
  }
});
