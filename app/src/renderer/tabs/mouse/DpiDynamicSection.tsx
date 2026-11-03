import { Panel, Row, Segmented } from '../../components/common';
import { type TabProps, sd, useDeviceData, useAutoWrite, Loading } from '../common';
import { useT } from '../../state/i18n';
import { DPI_DYNAMIC_MODES } from '@shared/mouse-wire';
import type { DpiDynamicSettings } from '@shared/types/mouse-settings';

// ---------------------------------------- DPI dynamic sensitivity (future mice)
export function DpiDynamicSection({ device }: TabProps) {
  const t = useT();
  const { data, setData, loading } = useDeviceData<DpiDynamicSettings | null>(
    device.id,
    sd.readDpiDynamic,
    null,
  );
  const { commit } = useAutoWrite(250, { deviceId: device.id });
  const d = data ?? { mode: 1 };
  const set = (p: Partial<DpiDynamicSettings>) => {
    const next = { ...d, ...p };
    setData(next);
    commit(t('dpidyn.title'), () => sd.setDpiDynamic(device.id, next));
  };
  if (loading) return <Loading />;
  return (
    <Panel title={t('dpidyn.title')} tip={t('dpidyn.hint')}>
      <Row label={t('dpidyn.mode')}>
        <Segmented
          value={d.mode}
          options={DPI_DYNAMIC_MODES.map((o) => ({
            value: o.value,
            label: t(o.labelKey as never),
          }))}
          onChange={(v) => set({ mode: v })}
        />
      </Row>
    </Panel>
  );
}
