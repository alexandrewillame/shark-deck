import type { ComponentType } from 'react';
import type { LiveDevice } from '@shared/types/live';
import type { MessageKey } from '@shared/i18n';
import { configurable, gate } from '@shared/menuGates';
import type { TabProps } from './common';
import type { IconName } from '../components/icons';
import { ProfileTab } from './ProfileTab';
import { DeviceTab } from './DeviceTab';
import { LightingTab } from './LightingTab';
import { ButtonsTab } from './ButtonsTab';
import { KeysTab } from './KeysTab';
import { ActuationTab } from './ActuationTab';
import { MacrosTab } from './MacrosTab';

export interface TabDef {
  id: string;
  labelKey: MessageKey;
  /** one-line explanation shown as a tooltip on the rail button — the only
   *  label left once the rail is collapsed to icons (see DeviceConfig.tsx) */
  descKey: MessageKey;
  icon: IconName;
  component: ComponentType<TabProps>;
  /**
   * Does switching the onboard profile change anything on this tab?
   *
   * Drives whether the profile picker appears above it (DeviceConfig.tsx).
   * It used to be one hardcoded `active !== 'device'` in the screen, which
   * meant a new tab silently inherited "yes" whether or not that was true,
   * and showed a picker implying a scope it did not have.
   *
   * Set it from evidence, not from the setting's name:
   * `scripts/probe-profile-scope.ts` selects each slot and reports which reads
   * actually differ. `docs/protocol/keyboard-compx.md` ("Profiles and what is
   * slot-scoped") has what the frames alone can tell you — which is less than
   * you would expect, since `SET_LEDPARAM` / `SET_SLEDPARAM` / `SET_USERPIC`
   * carry no slot byte at all.
   *
   * On a keyboard that evidence leaves Actuation alone: lighting frames carry
   * no slot byte, the key matrix is read and written at a fixed layer, the Fn
   * layer follows KBOPTION, there is one macro slot, and poll rate and
   * debounce are single registers. Only the magnetism pages follow
   * SET_PROFILE. `profileFieldsFor` in shared/types/profiles.ts is the same
   * rule for the compare and copy paths — keep the two in step.
   */
  profileScoped?: boolean;
}

/**
 * The device-config shell shows a small set of tabs, driven entirely by
 * capability: Overview (handled by the shell itself), Profile (onboard/
 * software slots + DPI/poll/sensor/power), then Buttons / Keys / Actuation /
 * Macros / Lighting each appear only when the device actually has that
 * feature — each used to be a section stacked inside Profile or Device, but
 * a device with several of them made those two tabs long and the individual
 * features hard to find, so they're promoted to their own top-level tabs.
 * Device (firmware, pairing, restore) always appears last. Which tabs exist is
 * decided by shared/menuGates.ts, the same table each tab's controls use.
 */
export function configTabs(device: LiveDevice): TabDef[] {
  const deviceTab: TabDef = {
    id: 'device',
    labelKey: 'cfg.tab.device',
    descKey: 'cfg.tab.device.desc',
    icon: 'chip',
    component: DeviceTab,
  };
  // Not identified yet, or a device Shark Deck leaves alone: what it is, and
  // nothing to set (see `configurable`).
  if (!configurable(device)) return [deviceTab];
  // A keyboard's onboard slot holds its actuation settings and nothing else —
  // see TabDef.profileScoped. Its first tab then has nothing per-profile in
  // it, so it is not called "Profile" either.
  const kb = device.kind === 'keyboard';
  const tabs: TabDef[] = [
    {
      id: 'profile',
      profileScoped: !kb,
      labelKey: kb ? 'cfg.tab.general' : 'cfg.tab.profile',
      descKey: kb ? 'cfg.tab.general.desc' : 'cfg.tab.profile.desc',
      icon: 'sliders',
      component: ProfileTab,
    },
  ];
  if (gate('tab.buttons', device)) {
    tabs.push({
      id: 'buttons',
      profileScoped: true,
      labelKey: 'cfg.tab.buttons',
      descKey: 'cfg.tab.buttons.desc',
      icon: 'cursorClick',
      component: ButtonsTab,
    });
  }
  if (gate('tab.keys', device)) {
    tabs.push({
      id: 'keys',
      profileScoped: !kb,
      labelKey: 'cfg.tab.keys',
      descKey: 'cfg.tab.keys.desc',
      icon: 'key',
      component: KeysTab,
    });
  }
  if (gate('tab.actuation', device)) {
    tabs.push({
      id: 'actuation',
      profileScoped: true,
      labelKey: 'cfg.tab.actuation',
      descKey: 'cfg.tab.actuation.desc',
      icon: 'gauge',
      component: ActuationTab,
    });
  }
  if (gate('tab.macros', device)) {
    tabs.push({
      id: 'macros',
      profileScoped: !kb,
      labelKey: 'cfg.tab.macros',
      descKey: 'cfg.tab.macros.desc',
      icon: 'macro',
      component: MacrosTab,
    });
  }
  if (gate('tab.lighting', device)) {
    tabs.push({
      id: 'lighting',
      profileScoped: !kb,
      labelKey: 'cfg.tab.lighting',
      descKey: 'cfg.tab.lighting.desc',
      icon: 'bulb',
      component: LightingTab,
    });
  }
  tabs.push(deviceTab);
  return tabs;
}
