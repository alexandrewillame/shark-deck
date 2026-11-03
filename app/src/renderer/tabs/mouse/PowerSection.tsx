import { Panel } from '../../components/common';
import { InfoLabel } from '../../components/InfoLabel';
import { SleepMedia } from '../../components/tooltipMedia';
import { type TabProps, sd, useDeviceData, useAutoWrite, ReadFailed } from '../common';
import { useT } from '../../state/i18n';
import type { PowerSettings } from '@shared/types/mouse-settings';

// ---------------------------------------------------------------- power / sleep
const fmtSecs = (s: number, never: string) =>
  s === 0 ? never : s % 60 === 0 ? `${s / 60} min` : `${s} s`;
export function PowerSection({ device }: TabProps) {
  const t = useT();
  const { data, setData, loading } = useDeviceData<PowerSettings | null>(
    device.id,
    sd.readPower,
    null,
    [],
    'power',
  );
  const { queue, commit } = useAutoWrite(250, { deviceId: device.id });
  const presets = device.ui.sleepPresets?.length
    ? device.ui.sleepPresets
    : [10, 30, 60, 120, 180, 300, 600, 900];
  if (!loading && data === null) {
    return (
      <Panel title={t('power.title')}>
        <ReadFailed />
      </Panel>
    );
  }
  const d = data ?? { sleepTimerSec: 0 };
  const current = d.never ? 0 : d.sleepTimerSec;
  const apply = (sec: number, opts?: { drag?: boolean }) => {
    const next: PowerSettings = { ...d, sleepTimerSec: sec, never: sec === 0 };
    setData(next);
    (opts?.drag ? queue : commit)(t('power.title'), () => sd.setPower(device.id, next));
  };
  return (
    // The explanation sits on the heading's info dot with its picture, as on
    // PollRateSection — `power.sub` was already that dot's text, it just had
    // no illustration.
    <Panel
      title={<InfoLabel label={t('power.title')} text={t('power.sub')} media={<SleepMedia />} />}
    >
      {/* Same shape as PollRateSection: the label on its own line, then the
          preset pills as a full-width, left-aligned flex row below — not
          indented into a Row's right-hand column. */}
      <div className="label" style={{ marginBottom: 8 }}>
        {t('power.sleepAfter')}
      </div>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        {presets.map((p) => (
          <button
            key={p}
            className={`btn ${p === current ? 'primary' : ''}`}
            onClick={() => apply(p)}
          >
            {fmtSecs(p, t('power.never'))}
          </button>
        ))}
      </div>
    </Panel>
  );
}
