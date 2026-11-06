import { EditableNumber, Panel, Row, Toggle } from '../../components/common';
import { InfoLabel } from '../../components/InfoLabel';
import { Gated } from '../../components/Gated';
import { type TabProps, sd, useDeviceData, useAutoWrite, ReadFailed, Loading } from '../common';
import { useT } from '../../state/i18n';
import { travelRangesFor } from '@shared/keyboard-travel';
import type { MagneticKeySettings } from '@shared/types/keyboard-settings';

/**
 * Actuation for a magnetic board whose key map is not known yet.
 *
 * Without a slot map a per-key write could land on the wrong key, so this
 * board gets no keyboard drawing and no per-key modes — only the settings
 * that are the same for every key: actuation and release, rapid trigger and
 * its sensitivities, the dead zones. The driver reads and writes every slot
 * that holds a real key (found from the board's own keymap), so nothing is
 * written to an empty slot. Each control shows the value most keys hold.
 */
export function WholeBoardActuation({ device }: TabProps) {
  const t = useT();
  const R = travelRangesFor(device.ui.magnetic);
  const { data, setData, loading, firstLoad } = useDeviceData<MagneticKeySettings[] | null>(
    device.id,
    sd.readMagnetic,
    null,
    [],
    'magnetic',
  );
  const { queue, flush } = useAutoWrite(300, { deviceId: device.id });

  if (!loading && (data === null || data.length === 0)) {
    return (
      <Panel title={t('act.wholeBoard.title')}>
        <ReadFailed />
      </Panel>
    );
  }
  const keys = data ?? [];
  const common = <K extends keyof MagneticKeySettings>(k: K, fallback: MagneticKeySettings[K]) => {
    const counts = new Map<unknown, number>();
    for (const key of keys) counts.set(key[k], (counts.get(key[k]) ?? 0) + 1);
    let best: unknown = fallback;
    let n = 0;
    for (const [v, c] of counts) if (v !== undefined && c > n) [best, n] = [v, c];
    return best as MagneticKeySettings[K];
  };

  const set = (patch: Partial<MagneticKeySettings>) => {
    const before = keys;
    const next = keys.map((k) => ({ ...k, ...patch }));
    setData(next);
    queue(t('act.wholeBoard.title'), () => sd.setMagneticKeys(device.id, next, before));
  };

  const actuation = common('actuationMm', R.travel.default);
  const release = common('releaseMm', actuation);
  const rt = common('rapidTrigger', false);
  const rtPress = common('rtPressMm', R.rt.default);
  const rtRelease = common('rtReleaseMm', R.rt.default);
  const dzBottom = common('deadZoneBottomMm', R.deadzone.default);
  const dzTop = common('deadZoneMm', R.deadzone.default);
  const mm = (v: number) => `${v} mm`;

  return (
    <Panel title={t('act.wholeBoard.title')}>
      <p className="row-desc" onPointerUp={flush}>
        {t('act.wholeBoard.hint')}
      </p>
      {firstLoad && <Loading />}
      {!loading && (
        <div onBlur={flush}>
          <Row
            label={
              <InfoLabel label={t('act.travel.actuation')} text={t('act.travel.actuation.tip')} />
            }
          >
            <EditableNumber
              value={actuation}
              min={R.travel.min}
              max={R.travel.max}
              step={R.travel.step}
              render={mm}
              ariaLabel={t('act.travel.actuation')}
              onCommit={(v) => set({ actuationMm: v })}
            />
          </Row>
          <Row
            label={<InfoLabel label={t('act.travel.release')} text={t('act.travel.release.tip')} />}
          >
            <EditableNumber
              value={release ?? actuation}
              min={R.travel.min}
              max={R.travel.max}
              step={R.travel.step}
              render={mm}
              ariaLabel={t('act.travel.release')}
              onCommit={(v) => set({ releaseMm: v })}
            />
          </Row>
          <Gated id="act.rapidTrigger" device={device}>
            <Row
              label={<InfoLabel label={t('act.rt.title')} text={t('act.rt.tip')} />}
              hint={t('act.rt.hint')}
            >
              <Toggle on={!!rt} onChange={(v) => set({ rapidTrigger: v })} />
            </Row>
            <Row label={<InfoLabel label={t('act.rt.press')} text={t('act.rt.press.tip')} />}>
              <EditableNumber
                value={rtPress ?? R.rt.default}
                min={R.rt.min}
                max={R.rt.max}
                step={R.rt.step}
                render={mm}
                ariaLabel={t('act.rt.press')}
                onCommit={(v) => set({ rtPressMm: v })}
              />
            </Row>
            <Row label={<InfoLabel label={t('act.rt.release')} text={t('act.rt.release.tip')} />}>
              <EditableNumber
                value={rtRelease ?? R.rt.default}
                min={R.rt.min}
                max={R.rt.max}
                step={R.rt.step}
                render={mm}
                ariaLabel={t('act.rt.release')}
                onCommit={(v) => set({ rtReleaseMm: v })}
              />
            </Row>
          </Gated>
          <Row label={<InfoLabel label={t('act.dz.bottom')} text={t('act.dz.bottom.tip')} />}>
            <EditableNumber
              value={dzBottom ?? R.deadzone.default}
              min={R.deadzone.min}
              max={R.deadzone.max}
              step={R.deadzone.step}
              render={mm}
              ariaLabel={t('act.dz.bottom')}
              onCommit={(v) => set({ deadZoneBottomMm: v })}
            />
          </Row>
          <Gated id="act.deadZoneTop" device={device}>
            <Row label={<InfoLabel label={t('act.dz.top')} text={t('act.dz.top.tip')} />}>
              <EditableNumber
                value={dzTop ?? R.deadzone.default}
                min={R.deadzone.min}
                max={R.deadzone.max}
                step={R.deadzone.step}
                render={mm}
                ariaLabel={t('act.dz.top')}
                onCommit={(v) => set({ deadZoneMm: v })}
              />
            </Row>
          </Gated>
        </div>
      )}
    </Panel>
  );
}
