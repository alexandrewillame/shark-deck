import { useState } from 'react';
import type { Capability } from '@shared/types/capability';
import type { LiveDevice } from '@shared/types/live';
import type { MessageKey } from '@shared/i18n';
import { CAPABILITY_META } from '@shared/capabilities';
import { useT } from '../state/i18n';
import { sd } from '../state/bridge';
import { Icon } from './icons';

/** The section a setting the device cannot report is found under. */
const SECTION: Partial<Record<Capability, MessageKey>> = {
  dpi: 'dpi.title',
  pollRate: 'poll.title',
  sensorTuning: 'sensor.title',
  motionSync: 'sensor.title',
  angleSnapping: 'sensor.title',
  rippleControl: 'sensor.title',
  lod: 'sensor.title',
  highFpsScan: 'sensor.title',
  angleMode: 'sensor.title',
  sensorMode: 'sensor.title',
  sleepTimer: 'power.title',
  mouseDebounce: 'debounce.title',
  debounce: 'debounce.title',
  dpiIndicatorLed: 'dpiLed.title',
  mouseLighting: 'light.title',
  receiverLed: 'light.title',
  buttonRemap: 'cfg.tab.buttons',
  macros: 'cfg.tab.macros',
};

/**
 * The one-time question a device a backup cannot fully cover asks before its
 * first write (drivers/base.ts `BackupPolicy`, kind `partial`). Until it is
 * answered the menus stay locked — every write would be refused anyway — and
 * the answer is kept per model + firmware, so it is asked once.
 */
export function BackupWaiverBanner({ device }: { device: LiveDevice }) {
  const t = useT();
  const [sending, setSending] = useState(false);
  const waiver = device.backupWaiver;
  if (!waiver) return null;
  const names = [
    ...new Set(
      waiver.unreadable.map((c) => {
        const key = SECTION[c];
        return key ? t(key) : CAPABILITY_META[c].label;
      }),
    ),
  ];
  return (
    <div className="waiver-banner" role="alert">
      <Icon name="warning" />
      <div className="waiver-text">
        <strong>{t('backup.waiver.title')}</strong>
        <p>{t('backup.waiver.body', { list: names.join(', ') })}</p>
      </div>
      <button
        className="btn primary"
        disabled={sending}
        onClick={() => {
          setSending(true);
          void sd.acknowledgeNoBackup(device.id).finally(() => setSending(false));
        }}
      >
        {t('backup.waiver.ok')}
      </button>
    </div>
  );
}
