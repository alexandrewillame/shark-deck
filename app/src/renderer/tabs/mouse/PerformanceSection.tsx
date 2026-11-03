import { Panel, Row, Segmented, Toggle } from '../../components/common';
import { type TabProps, sd, useDeviceData, useAutoWrite, Loading } from '../common';
import { useT } from '../../state/i18n';
import { PERFORMANCE_TIMEOUTS } from '@shared/mouse-options';
import type { PerformanceSettings } from '@shared/types/mouse-settings';

// ------------------------------------------------ performance mode (future mice)
export function PerformanceSection({ device }: TabProps) {
  const t = useT();
  const { data, setData, loading } = useDeviceData<PerformanceSettings | null>(
    device.id,
    sd.readPerformance,
    null,
  );
  const { commit } = useAutoWrite(250, { deviceId: device.id });
  const d = data ?? { enabled: false, timeoutSec: 60 };
  const set = (p: Partial<PerformanceSettings>) => {
    const next = { ...d, ...p };
    setData(next);
    commit(t('perf.title'), () => sd.setPerformance(device.id, next));
  };
  if (loading) return <Loading />;
  return (
    <Panel title={t('perf.title')} tip={t('perf.hint')}>
      <Row label={t('perf.enable')}>
        <Toggle on={d.enabled} onChange={(v) => set({ enabled: v })} />
      </Row>
      <Row label={t('perf.timeout')}>
        <Segmented
          value={d.timeoutSec}
          options={PERFORMANCE_TIMEOUTS.map((o) => ({ value: o.value * 10, label: o.label }))}
          onChange={(v) => set({ timeoutSec: v })}
        />
      </Row>
    </Panel>
  );
}
