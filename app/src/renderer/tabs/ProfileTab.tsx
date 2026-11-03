import { hasAny } from '@shared/capabilities';
import { HeroPane, type TabProps } from './common';
import { useT } from '../state/i18n';
import { DebounceSection } from './mouse/DebounceSection';
import { KeyboardFnLayoutSection } from './keyboard/KeyboardFnLayoutSection';
import { DpiDynamicSection } from './mouse/DpiDynamicSection';
import { DpiSection } from './mouse/DpiSection';
import { PerformanceSection } from './mouse/PerformanceSection';
import { PollRateSection } from './mouse/PollRateSection';
import { PowerSection } from './mouse/PowerSection';
import { SensorSection } from './mouse/SensorSection';

/**
 * Everything stored per profile, in one tab. Sections below render whenever
 * the device's capability set calls for them, independent of the profile
 * model — they always read/write the device's live current state.
 *
 * Which profile you're looking at is picked once, above every tab (see
 * ProfileSwitcher.tsx, rendered by DeviceConfig) rather than here. It is the
 * device's own onboard slot in every case, so the sections below need no
 * notion of a profile at all: they read and write the device's live state,
 * and the live state IS the selected slot. There is deliberately no "capture"
 * — editing a setting while slot 1 is selected is editing slot 1. Power is
 * dropped entirely for a wired keyboard (no battery to save).
 *
 * Buttons, Keys (remap/Fn layer), and Actuation (magnetic switches) used to
 * be sections stacked in here too; they're now their own top-level tabs
 * (tabs/ButtonsTab.tsx / KeysTab.tsx / ActuationTab.tsx via tabs/index.tsx),
 * since a keyboard with several of them made this one tab long and the
 * individual features harder to find.
 *
 * On a keyboard none of what is left here follows the slot (Fn-row layout,
 * poll rate and debounce are single registers — see TabDef.profileScoped),
 * so the tab is "General" there and has no profile picker above it.
 */
export function ProfileTab({ device }: TabProps) {
  const t = useT();
  const caps = device.capabilities;
  const isKeyboard = device.kind === 'keyboard';
  return (
    <HeroPane
      device={device}
      title={isKeyboard ? t('cfg.tab.general') : t('profile.title')}
      sub={isKeyboard ? t('cfg.tab.general.desc') : t('profile.sub')}
    >
      {!isKeyboard && (
        <>
          {caps.includes('dpi') && <DpiSection device={device} />}
          {caps.includes('pollRate') && <PollRateSection device={device} />}
          {hasAny(caps, [
            'sensorTuning',
            'motionSync',
            'lod',
            'highFpsScan',
            'longDistanceMode',
            'sensorMode',
          ]) && <SensorSection device={device} />}
          {caps.includes('mouseDebounce') && <DebounceSection device={device} />}
          {caps.includes('perfMode') && <PerformanceSection device={device} />}
          {caps.includes('dpiDynamic') && <DpiDynamicSection device={device} />}
        </>
      )}

      {isKeyboard && caps.includes('keyboardOptions') && (
        <KeyboardFnLayoutSection device={device} />
      )}
      {isKeyboard && caps.includes('pollRate') && <PollRateSection device={device} />}
      {isKeyboard && caps.includes('debounce') && <DebounceSection device={device} />}

      {device.wireless && caps.includes('sleepTimer') && <PowerSection device={device} />}
    </HeroPane>
  );
}
