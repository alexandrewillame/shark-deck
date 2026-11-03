/**
 * Small looping illustrations for the sensor-option tooltips (Tooltip's
 * `media` prop — see components/common.tsx). Placeholders standing in for
 * real captured footage: plain inline, theme-coloured SVG with a SMIL loop
 * rather than a bundled video/image file, so there's no asset to record yet
 * and nothing for the strict CSP to allow. Swap any of these for a real
 * `<video>`/`<img>` (passed the same way, as `media`) once real footage
 * exists — the Tooltip and its call sites don't need to change.
 *
 * Animations are defined in tooltipMediaData.ts — adding a new animation
 * there will automatically appear in both this component and the standalone
 * tooltipMedia.html preview. The words they draw are tagged there and put in
 * the app's language here (`localizeSvg`).
 */
import { useMemo } from 'react';
import { useT } from '../state/i18n';
import { ANIMATIONS, localizeSvg } from './tooltipMediaData';

const BOX = { width: 260, height: 110 };

/**
 * Render an animation by ID from the shared ANIMATIONS registry.
 * Usage: <RenderAnimation id="rippleControl" />
 */
function RenderAnimation({ id }: { id: string }) {
  const t = useT();
  const anim = ANIMATIONS.find((a) => a.id === id);
  const svg = useMemo(() => (anim ? localizeSvg(anim.svgContent, t) : ''), [anim, t]);
  if (!anim) return null;
  return (
    <svg
      viewBox="0 0 260 110"
      width={BOX.width}
      height={BOX.height}
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}

export function RippleControlMedia() {
  return <RenderAnimation id="rippleControl" />;
}

export function AngleSnappingMedia() {
  return <RenderAnimation id="angleSnapping" />;
}

export function MotionSyncMedia() {
  return <RenderAnimation id="motionSync" />;
}

export function LiftOffDistanceMedia() {
  return <RenderAnimation id="liftOffDistance" />;
}

export function MouseAngleModeMedia() {
  return <RenderAnimation id="mouseAngleMode" />;
}

export function ReportRateMedia() {
  return <RenderAnimation id="reportRate" />;
}

export function SensorModeMedia() {
  return <RenderAnimation id="sensorMode" />;
}

/** The sensor's own frame rate (20 kHz FPS scanning) — not the USB report
 *  rate, which is `ReportRateMedia`. */
export function SensorFpsMedia() {
  return <RenderAnimation id="sensorFps" />;
}

export function LongDistanceMedia() {
  return <RenderAnimation id="longDistance" />;
}

export function DebounceMedia() {
  return <RenderAnimation id="debounce" />;
}

export function DpiMedia() {
  return <RenderAnimation id="dpi" />;
}

export function SleepMedia() {
  return <RenderAnimation id="sleep" />;
}

export function RapidTriggerMedia() {
  return <RenderAnimation id="rapidTrigger" />;
}

export function ActuationPointMedia() {
  return <RenderAnimation id="actuationPoint" />;
}

export function GlobalActuationMedia() {
  return <RenderAnimation id="globalActuation" />;
}

export function TopDeadZoneMedia() {
  return <RenderAnimation id="topDeadZone" />;
}

export function BottomDeadZoneMedia() {
  return <RenderAnimation id="bottomDeadZone" />;
}
