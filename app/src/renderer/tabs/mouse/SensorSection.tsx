import { useRef } from 'react';
import { EditableNumber, Panel, Row, Segmented, Toggle } from '../../components/common';
import { AngleIllustration } from '../../components/AngleIllustration';
import {
  AngleSnappingMedia,
  LiftOffDistanceMedia,
  MotionSyncMedia,
  RippleControlMedia,
  MouseAngleModeMedia,
  SensorFpsMedia,
  LongDistanceMedia,
  SensorModeMedia,
} from '../../components/tooltipMedia';
import { type TabProps, sd, useDeviceData, useAutoWrite, ReadFailed, Loading } from '../common';
import { useT } from '../../state/i18n';
import { ANGLE_RANGE } from '@shared/mouse-wire';
import type { SensorSettings } from '@shared/types/mouse-settings';
import { InfoLabel } from '../../components/InfoLabel';

// ---------------------------------------------------------------- sensor
export function SensorSection({ device }: TabProps) {
  const t = useT();
  const { data, setData, loading, firstLoad } = useDeviceData<SensorSettings | null>(
    device.id,
    sd.readSensor,
    null,
    [],
    'sensor',
  );
  const { queue, flush, commit } = useAutoWrite(250, { deviceId: device.id });
  const caps = device.capabilities;
  const lodOptions = device.ui.lodOptions ?? [];
  const d = data ?? {};
  // Remembers the last non-zero angle so toggling the mode off-and-back-on
  // restores it instead of leaving it at whatever the fieldset's disabled
  // slider happened to show — the driver derives `angleMode` itself from
  // whether `angleDegrees` is non-zero, so the two must never disagree.
  // MUST stay above the early return below — a hook after a conditional return
  // changes the hook count between renders and crashes React.
  const lastAngle = useRef(0);
  if (d.angleDegrees) lastAngle.current = d.angleDegrees;
  if (!loading && data === null) {
    return (
      <Panel title={t('sensor.title')}>
        <ReadFailed />
      </Panel>
    );
  }
  // No Apply button — every change is written straight away. Discrete controls
  // (toggles / segmented) commit immediately; the angle slider debounces
  // while dragging and flushes on release (see the wrapper's onPointerUp).
  const set = (patch: Partial<SensorSettings>, opts?: { drag?: boolean }) => {
    const next = { ...d, ...patch };
    setData(next);
    (opts?.drag ? queue : commit)(t('sensor.title'), () => sd.setSensor(device.id, next));
  };
  // Each row says its thing twice, at two lengths: the info dot's tooltip
  // carries the full `*.hint` explanation (with its picture), and the `Row`'s
  // own hint line under the label is the one-clause `*.short` version — the
  // same sentence in both places was a wall of small print per row.
  return (
    <Panel title={t('sensor.title')}>
      {firstLoad && <Loading />}
      {!loading && lodOptions.length > 0 && (
        <Row
          label={
            <InfoLabel
              label={t('sensor.lod')}
              text={t('sensor.lod.hint')}
              media={<LiftOffDistanceMedia />}
            />
          }
          hint={t('sensor.lod.short')}
        >
          <Segmented
            value={d.lod ?? lodOptions[0]!.wire}
            options={lodOptions.map((o) => ({ value: o.wire, label: `${o.mm} mm` }))}
            onChange={(v) => set({ lod: v })}
          />
        </Row>
      )}
      {!loading && device.ui.sensorModes && (
        <Row
          label={
            <InfoLabel
              label={t('sensor.mode')}
              text={t('sensor.mode.tooltip')}
              media={<SensorModeMedia />}
            />
          }
          hint={t('sensor.mode.hint')}
        >
          <Segmented
            value={d.sensorMode ?? 0}
            options={[
              { value: 0, label: t('sensor.mode.lp') },
              { value: 1, label: t('sensor.mode.hp') },
            ]}
            onChange={(v) => set({ sensorMode: v })}
          />
        </Row>
      )}
      {!loading && (
        <>
          <Row
            label={
              <InfoLabel
                label={t('sensor.motionSync')}
                text={t('sensor.motionSync.hint')}
                media={<MotionSyncMedia />}
              />
            }
            hint={t('sensor.motionSync.short')}
          >
            <Toggle on={!!d.motionSync} onChange={(v) => set({ motionSync: v })} />
          </Row>
          <Row
            label={
              <InfoLabel
                label={t('sensor.angleSnap')}
                text={t('sensor.angleSnap.hint')}
                media={<AngleSnappingMedia />}
              />
            }
            hint={t('sensor.angleSnap.short')}
          >
            <Toggle on={!!d.angleSnapping} onChange={(v) => set({ angleSnapping: v })} />
          </Row>

          {/* Same left-label/right-control shape as every other row here,
              with an enable toggle on the right like the others — the
              slider + illustration below are just this row's expanded
              detail, disabled together while the mode is off. No Apply
              button: writes on release (onPointerUp/onBlur flush), or
              immediately when the degree value is typed directly.
              `no-border`: the row's own dashed bottom border would land
              between the toggle and its diagram — the separator belongs
              after the whole group instead, right before Ripple control
              (see `.angle-mode-fieldset`'s own border-bottom below). */}
          {caps.includes('angleMode') && (
            <>
              <Row
                className="no-border"
                label={
                  <InfoLabel
                    label={t('sensor.angleMode')}
                    text={t('sensor.angleMode.tooltip')}
                    media={<MouseAngleModeMedia />}
                  />
                }
                hint={t('sensor.angleMode.hint')}
              >
                <Toggle
                  on={!!d.angleMode}
                  onChange={(v) =>
                    set({ angleMode: v, angleDegrees: v ? lastAngle.current || 15 : 0 })
                  }
                />
              </Row>
              <fieldset className="angle-mode-fieldset" disabled={!d.angleMode}>
                <div className="angle-mode">
                  <div className="angle-mode-stage" onPointerUp={flush} onBlur={flush}>
                    <div className="angle-mode-value-row">
                      <EditableNumber
                        overlay
                        className="angle-mode-value mono"
                        value={d.angleDegrees ?? 0}
                        min={ANGLE_RANGE.min}
                        max={ANGLE_RANGE.max}
                        step={1}
                        ariaLabel={t('sensor.angleMode.editValue')}
                        render={(v) => `${v}°`}
                        onCommit={(angleDegrees) => set({ angleDegrees })}
                      />
                    </div>
                    <input
                      type="range"
                      className="angle-mode-slider"
                      min={ANGLE_RANGE.min}
                      max={ANGLE_RANGE.max}
                      step={1}
                      value={d.angleDegrees ?? 0}
                      onChange={(e) =>
                        set({ angleDegrees: Number(e.target.value) }, { drag: true })
                      }
                    />
                    <AngleIllustration degrees={d.angleDegrees ?? 0} />
                  </div>
                </div>
              </fieldset>
            </>
          )}

          <Row
            label={
              <InfoLabel
                label={t('sensor.ripple')}
                text={t('sensor.ripple.hint')}
                media={<RippleControlMedia />}
              />
            }
            hint={t('sensor.ripple.short')}
          >
            <Toggle on={!!d.rippleControl} onChange={(v) => set({ rippleControl: v })} />
          </Row>
          {caps.includes('highFpsScan') && (
            <Row
              label={
                <InfoLabel
                  label={t('sensor.highFps')}
                  text={t('sensor.highFps.hint')}
                  media={<SensorFpsMedia />}
                />
              }
              hint={t('sensor.highFps.short')}
            >
              <Toggle on={!!d.highFpsScan} onChange={(v) => set({ highFpsScan: v })} />
            </Row>
          )}
          {caps.includes('longDistanceMode') && (
            <Row
              label={
                <InfoLabel
                  label={t('sensor.longRange')}
                  text={t('sensor.longRange.hint')}
                  media={<LongDistanceMedia />}
                />
              }
              hint={t('sensor.longRange.short')}
            >
              <Toggle on={!!d.longDistanceMode} onChange={(v) => set({ longDistanceMode: v })} />
            </Row>
          )}
        </>
      )}
    </Panel>
  );
}

// ---------------------------------------------------------------- buttons
