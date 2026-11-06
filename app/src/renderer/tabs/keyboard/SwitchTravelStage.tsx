import type { ReactNode } from 'react';
import { EditableNumber, VerticalSlider } from '../../components/common';
import {
  ActuationPointMedia,
  TopDeadZoneMedia,
  BottomDeadZoneMedia,
  RapidTriggerMedia,
} from '../../components/tooltipMedia';
import { InfoLabel } from '../../components/InfoLabel';
import { useT } from '../../state/i18n';
import { SwitchCrossSection } from './SwitchCrossSection';
import { STAGE_H, TOTAL_MM, mmToPx, travelColumnLayout } from './switchGeometry';
import { KB_TRAVEL_RANGE } from '@shared/keyboard-travel';

/** Travel ranges. The UI used to hardcode 0.1..4.0 where the table caps the
 *  settable actuation at 3.4 mm, and every `step` here was a hand-typed 0.05
 *  rather than the table's own — which put the handle on values the firmware
 *  rounds away. Rapid trigger reads `T.rt`, not `T.travel`: it used to borrow
 *  the actuation row and so offered 0.01-2.5 mm with a 1.5 mm default.
 *  The ranges are the board's own (the `ranges` prop), defaulting to the
 *  R85HE-calibrated KB_TRAVEL_RANGE. */

/** The stage's own settings, by their `MagneticKeySettings` field name — the
 *  keys of the `mixed` map a multi-key selection passes down. */
export type MixedField =
  'actuationMm' | 'releaseMm' | 'deadZoneMm' | 'deadZoneBottomMm' | 'rtPressMm' | 'rtReleaseMm';

/**
 * One vertical slider on the shared travel axis: header above the track, the
 * track spanning [fromMm, toMm], the editable value below it — or above it,
 * with `valueAbove` (see `travelColumnLayout`).
 *
 * Everything is positioned absolutely by millimetre, which is what lets several
 * of these share a single column — see the dead-zone pair below, which sit at
 * opposite ends of the same axis and so can never collide.
 */
function TravelSlider({
  label,
  fromMm,
  toMm,
  value,
  min,
  max,
  step,
  invert,
  valueAbove,
  hatched,
  mixed,
  mixedValues,
  onChange,
}: {
  label: ReactNode;
  /** The physical mm sub-range this track occupies on the shared axis — NOT
   *  necessarily equal to [min, max]. The dead-zone tracks have a 0..1 value
   *  range but sit on the top or bottom quarter of the 0..4 mm axis, and the
   *  rapid-trigger track lays a *delta* along the axis starting from 0. */
  fromMm: number;
  toMm: number;
  value: number;
  min: number;
  max: number;
  step: number;
  /** Grow from the track's bottom instead of its top — the bottom dead zone,
   *  whose value is a depth measured up from the base of the stroke. */
  invert?: boolean;
  /** Print the value between the header and the track, not under the track —
   *  for a track that ends on the bottom of travel, where a value underneath
   *  would hang below every other column. */
  valueAbove?: boolean;
  /** The dead-zone tracks. The track itself is barred out to show the region
   *  it removes from the stroke, and it prints no number: a dead zone is an
   *  area, and the bars say how much of the travel it takes. The same hatch
   *  is drawn across the axis by SwitchCrossSection. */
  hatched?: boolean;
  /** The selection holds more than one value for this setting. The number is
   *  replaced by a dash and the handle goes faint: there is no one value to
   *  show, and printing the first selected key's would be a lie the user then
   *  applies to the rest. Setting it still works, and sets all of them. */
  mixed?: boolean;
  /** Every distinct value the selection holds for this setting. Drawn as one
   *  ghost handle each, so a mixed selection shows what it actually contains
   *  instead of parking a single handle at the first key's value. */
  mixedValues?: number[];
  /**
   * `live` marks a value still being aimed at — the slider mid-drag.
   *
   * The owner holds those and sends only what the gesture ends on, so this has
   * to distinguish them from a value the user has finished choosing: typing 0
   * into the box and pressing Enter is a decision, not a step on the way to
   * one, and must reach the board without waiting for a pointer release
   * somewhere else on the page.
   */
  onChange: (v: number, live?: boolean) => void;
}) {
  // Chromium centres a range thumb `THUMB_PX / 2` in from each end of its
  // track, so an input laid out to exactly [fromMm, toMm] can only reach `min`
  // 7px below the `fromMm` row and `max` 7px above the `toMm` row — the handle
  // visibly misses the SVG marker it controls at both extremes (~0.12 mm here)
  // and agrees with it only at the midpoint. `sliderTrack` overshoots the input
  // by one whole thumb and lifts it half a thumb, so the thumb *centre* sweeps
  // the true span. Only the input moves: the header and the value still key
  // off the real [fromMm, toMm] rows.
  const { header, track: input, value: valueBox } = travelColumnLayout(fromMm, toMm, valueAbove);
  return (
    <>
      <div className="switch-stage-col-label" style={header}>
        {label}
      </div>
      <div
        className={`switch-stage-col-track${hatched ? ' dz' : ''}${mixed ? ' is-mixed' : ''}`}
        style={{ top: input.top, height: input.height }}
      >
        <VerticalSlider
          value={value}
          min={min}
          max={max}
          step={step}
          invert={invert}
          heightPx={input.height}
          onChange={(v) => onChange(v, true)}
        />
        {/* One marker per value in the selection. Positioned on the SAME axis
            the track is laid out on, so a ghost sits exactly where that key's
            handle would be if it were the only one selected. */}
        {mixedValues?.map((v) => (
          <span
            key={v}
            className="switch-stage-ghost"
            style={{ top: mmToPx(v) - input.top }}
            aria-hidden="true"
          />
        ))}
      </div>
      <div className="switch-stage-col-value" style={{ top: valueBox.top }}>
        <EditableNumber
          value={value}
          min={min}
          max={max}
          step={step}
          onCommit={onChange}
          render={(v) => (mixed ? '– mm' : `${v} mm`)}
          className={mixed ? 'mono is-mixed' : 'mono'}
        />
      </div>
    </>
  );
}

/** A 60px column slot. Holds one track, or several that do not overlap. */
function Col({ children }: { children: ReactNode }) {
  return <div className="switch-stage-col">{children}</div>;
}

/**
 * The Actuation tab's per-key stage: the switch illustration
 * (`SwitchCrossSection`) plus one vertical slider per setting, each physically
 * aligned to the same 0–4 mm travel axis the illustration draws its markers on
 * (`switchGeometry.ts`) — dragging a handle and watching the matching line move
 * on the switch is the whole point, so the two must never drift out of sync.
 *
 * **Every depth setting is a vertical slider here, rapid trigger included.** RT
 * sensitivity used to be a pair of horizontal rows off to the side, on the
 * reasoning that a *delta* has no absolute position on the axis. That is true
 * but it left one setting shaped unlike all its neighbours; laying the delta
 * along the axis from 0 reads perfectly well as "this much travel", which is
 * exactly what the dead-zone tracks already do with their own 0..1 mm values.
 *
 * The two dead zones **share one column**. They occupy opposite ends of the
 * same axis and can never collide, so giving each its own column spent 60px of
 * width for nothing — and horizontal space here is what pushes the settings
 * panel below the fold.
 */
export function SwitchTravelStage({
  actuationMm,
  releaseMm,
  rapidTrigger,
  rtPressMm,
  rtReleaseMm,
  rtPressAtMm,
  rtReleaseAtMm,
  rtSplit,
  splitRelease,
  deadZoneMm,
  deadZoneBottomMm,
  liveMm,
  mixed,
  distinct,
  onActuationChange,
  onReleaseChange,
  onDeadZoneChange,
  onDeadZoneBottomChange,
  onRtPressChange,
  onRtReleaseChange,
  ranges = KB_TRAVEL_RANGE,
  showTopDeadZone = true,
}: {
  /** this board's own limits (`travelRangesFor(device.ui.magnetic)`) */
  ranges?: typeof KB_TRAVEL_RANGE;
  /** the top dead zone (page 251) exists on this board */
  showTopDeadZone?: boolean;
  actuationMm: number;
  releaseMm?: number;
  rapidTrigger?: boolean;
  rtPressMm?: number;
  rtReleaseMm?: number;
  rtPressAtMm?: number | null;
  rtReleaseAtMm?: number | null;
  /** Show press and release sensitivity as two tracks instead of one. */
  rtSplit?: boolean;
  /** Show the Release column: the user has unlinked it from Actuation. */
  splitRelease?: boolean;
  deadZoneMm?: number;
  deadZoneBottomMm?: number;
  liveMm?: number | null;
  /** Which settings differ across a multi-key selection — see TravelSlider's
   *  own `mixed`. */
  mixed?: Partial<Record<MixedField, boolean>>;
  /** Every distinct value the selection holds, per setting — one ghost handle
   *  each, so a mixed selection shows what it contains rather than parking one
   *  handle at the first key's value. See distinctValues. */
  distinct?: Partial<Record<MixedField, number[]>>;
  onActuationChange: (v: number, live?: boolean) => void;
  onReleaseChange: (v: number, live?: boolean) => void;
  onDeadZoneChange: (v: number, live?: boolean) => void;
  onDeadZoneBottomChange: (v: number, live?: boolean) => void;
  onRtPressChange: (v: number, live?: boolean) => void;
  onRtReleaseChange: (v: number, live?: boolean) => void;
}) {
  const T = ranges;
  const t = useT();
  /** A delta drawn from the top of the axis — the track's length IS the value. */
  const rtTrack = (
    label: string,
    tip: string,
    value: number,
    field: MixedField,
    onChange: (v: number) => void,
  ) => (
    <TravelSlider
      label={<InfoLabel label={label} text={tip} media={<RapidTriggerMedia />} />}
      fromMm={0}
      toMm={T.rt.max}
      value={value}
      min={T.rt.min}
      max={T.rt.max}
      step={T.rt.step}
      mixed={mixed?.[field]}
      mixedValues={distinct?.[field]}
      onChange={onChange}
    />
  );

  return (
    <div className="switch-stage" style={{ height: STAGE_H }}>
      <SwitchCrossSection
        actuationMm={actuationMm}
        releaseMm={releaseMm}
        rapidTrigger={rapidTrigger}
        rtPressMm={rtPressMm}
        rtReleaseMm={rtReleaseMm}
        rtPressAtMm={rtPressAtMm}
        rtReleaseAtMm={rtReleaseAtMm}
        deadZoneMm={deadZoneMm}
        deadZoneBottomMm={deadZoneBottomMm}
        liveMm={liveMm}
        mixed={mixed}
      />
      <div className="switch-stage-cols">
        <Col>
          <TravelSlider
            label={
              <InfoLabel
                stack
                label={t('act.travel.actuation')}
                text={t('act.travel.actuation.tip')}
                media={<ActuationPointMedia />}
              />
            }
            fromMm={T.travel.min}
            toMm={T.travel.max}
            value={actuationMm}
            min={T.travel.min}
            max={T.travel.max}
            step={T.travel.step}
            mixed={mixed?.actuationMm}
            mixedValues={distinct?.actuationMm}
            onChange={onActuationChange}
          />
        </Col>

        {/* Only when the user has unlinked it. It used to appear whenever rapid
            trigger happened to be OFF, which tied one setting's visibility to
            an unrelated one. */}
        {splitRelease && (
          <Col>
            <TravelSlider
              label={
                <InfoLabel
                  stack
                  label={t('act.travel.release')}
                  text={t('act.travel.release.tip')}
                  media={<ActuationPointMedia />}
                />
              }
              fromMm={T.travel.min}
              toMm={T.travel.max}
              value={releaseMm ?? actuationMm}
              min={T.travel.min}
              max={T.travel.max}
              step={T.travel.step}
              mixed={mixed?.releaseMm}
              mixedValues={distinct?.releaseMm}
              onChange={onReleaseChange}
            />
          </Col>
        )}

        {/* Both dead zones in one column: opposite ends of the same axis. */}
        <Col>
          {showTopDeadZone && (
            <TravelSlider
              label={
                <InfoLabel
                  stack
                  label={t('act.dz.top')}
                  text={t('act.dz.top.tip')}
                  media={<TopDeadZoneMedia />}
                />
              }
              fromMm={0}
              toMm={1}
              value={deadZoneMm ?? T.deadzone.default}
              min={T.deadzone.min}
              max={T.deadzone.max}
              step={T.deadzone.step}
              hatched
              mixed={mixed?.deadZoneMm}
              mixedValues={distinct?.deadZoneMm}
              onChange={onDeadZoneChange}
            />
          )}
          <TravelSlider
            label={
              <InfoLabel
                stack
                label={t('act.dz.bottom')}
                text={t('act.dz.bottom.tip')}
                media={<BottomDeadZoneMedia />}
              />
            }
            fromMm={TOTAL_MM - 1}
            toMm={TOTAL_MM}
            value={deadZoneBottomMm ?? T.deadzone.default}
            min={T.deadzone.min}
            max={T.deadzone.max}
            step={T.deadzone.step}
            invert
            // Its track ends on the bottom of travel; a value under it was the
            // one thing that needed the stage to run on below the axis.
            valueAbove
            hatched
            mixed={mixed?.deadZoneBottomMm}
            mixedValues={distinct?.deadZoneBottomMm}
            onChange={onDeadZoneBottomChange}
          />
        </Col>

        {rapidTrigger && !rtSplit && (
          <Col>
            {rtTrack(
              t('act.rt.sensitivity'),
              t('act.rt.sensitivity.tip'),
              rtPressMm ?? T.rt.default,
              'rtPressMm',
              // Linked: ONE call, which the owner turns into a single patch
              // setting both fields. Calling both handlers in turn queued two
              // writes for one drag — and, until `patch` was made to compose,
              // the second discarded the first's `rtPressMm`, which is the
              // value this very slider renders: the handle snapped back on
              // every drag and the control looked broken.
              onRtPressChange,
            )}
          </Col>
        )}
        {rapidTrigger && rtSplit && (
          <>
            <Col>
              {rtTrack(
                t('act.rt.press'),
                t('act.rt.press.tip'),
                rtPressMm ?? T.rt.default,
                'rtPressMm',
                onRtPressChange,
              )}
            </Col>
            <Col>
              {rtTrack(
                t('act.rt.release'),
                t('act.rt.release.tip'),
                rtReleaseMm ?? T.rt.default,
                'rtReleaseMm',
                onRtReleaseChange,
              )}
            </Col>
          </>
        )}
      </div>
    </div>
  );
}
