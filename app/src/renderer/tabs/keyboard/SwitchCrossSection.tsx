import { useT } from '../../state/i18n';
import {
  ASSEMBLY,
  AXIS_TOP,
  AXIS_BOTTOM,
  STAGE_H,
  TOTAL_MM,
  dodgeLabels,
  mmToPx,
  spanPx,
} from './switchGeometry';

/** One horizontal marker on the travel axis. */
interface Marker {
  /** Where the line is DRAWN, in mm from the top of travel. */
  mm: number;
  /**
   * The number to print, when it differs from `mm`.
   *
   * Several markers sit at a position derived from their setting rather than at
   * the setting itself: a 0.3 mm bottom dead zone is drawn at 3.7 mm (measured
   * down from the top, like everything else on this axis), and the
   * rapid-trigger thresholds are drawn at a depth relative to the key's
   * tracked extremum. Printing the drawn position meant the label read
   * "Bottom dead zone 3.70" for a setting whose slider says 0.30 — two
   * different numbers for one setting, and the one the user cannot act on.
   */
  valueMm?: number;
  label: string;
  color: string;
  dashed?: boolean;
  /** The live-position marker: crosses the housing and gets a caret + bold
   *  label, so it stays distinguishable from `Actuate` (same accent colour)
   *  when the two land on top of each other — which is exactly when the user
   *  is watching. */
  live?: boolean;
  /** Drawn hollow: the setting applies, but there is no live reading behind
   *  the position yet (see the RT markers at rest). */
  faint?: boolean;
  /** The selection holds several values for this setting, so there is no
   *  number to print and no single row to point at — the marker keeps its
   *  name and goes faint. Same idea as TravelSlider's own `mixed`. */
  mixed?: boolean;
}

/** Minimum vertical distance (px) between two label baselines before they read
 *  as one smudge. fontSize is 11, so this is comfortably over one line box. */
const LABEL_MIN_GAP = 15;

/**
 * How far each successive marker's line stops short of the axis gutter.
 *
 * With the key near the top of its travel, Actuate / RT press / RT release /
 * Now can all land within a couple of pixels of each other — the LABELS were
 * already dodged apart, but the lines they point at were drawn on top of one
 * another, so four callouts fanned out of what looked like a single rule and
 * there was no way to tell which was which. Staggering where each line ends
 * gives every marker its own visible run, and the dot at that end marks the
 * true row even when the lines themselves coincide.
 */
const LINE_STAGGER = 9;

/**
 * Side-on cutaway of a Hall-effect keyswitch — keycap, stem, spring and magnet
 * over a PCB with a Hall sensor — with the actuation point, the rapid-trigger
 * thresholds, the top *and* bottom dead zones, and the current key depth all
 * drawn on the same millimetre travel axis `SwitchTravelStage`'s vertical
 * sliders use (`switchGeometry.ts` — one `mmToPx` shared by both, so a slider
 * handle and the marker it controls always land on the same pixel row).
 *
 * **The travel datum is the magnet's bottom face**, not the keycap. That is the
 * surface the Hall sensor measures, so it is the only feature every marker can
 * honestly be referenced to; the keycap, stem and spring are drawn stacked
 * upward from it at fixed offsets (`ASSEMBLY`). Previously the keycap underside
 * sat on `mmToPx(depth)` and the magnet was a fixed 44px (~0.73 mm) below it,
 * which meant every line on the axis pointed at the wrong part of the switch.
 */
export function SwitchCrossSection({
  actuationMm,
  releaseMm,
  rapidTrigger,
  rtPressMm,
  rtReleaseMm,
  rtPressAtMm,
  rtReleaseAtMm,
  deadZoneMm,
  deadZoneBottomMm,
  liveMm,
  mixed,
}: {
  actuationMm: number;
  releaseMm?: number;
  rapidTrigger?: boolean;
  rtPressMm?: number;
  rtReleaseMm?: number;
  /** Live RT re-press threshold (mm), tracked from the key's shallowest point
   *  since it last released. Undefined when there is no live reading. */
  rtPressAtMm?: number | null;
  /** Live RT release threshold (mm), tracked from the deepest point reached. */
  rtReleaseAtMm?: number | null;
  deadZoneMm?: number;
  deadZoneBottomMm?: number;
  liveMm?: number | null;
  /** Settings the current multi-key selection disagrees on. */
  mixed?: { actuationMm?: boolean; releaseMm?: boolean };
}) {
  const t = useT();
  // Wide enough for the longest tick label. Text starts at `axisX + 44` (194)
  // and the outer <svg> clips at W, so the old 260 left only ~66px — about 10
  // monospace glyphs at fontSize 11 — and silently truncated
  // "bottom dead zone 3.70" to "bottom dea" and "release 1.30" to "release 1.".
  // Measured against the English labels; a translation much longer than
  // "RT release 0.30" clips the same way.
  const W = 352;
  // The stage's own height, shared with the slider columns beside this.
  const H = STAGE_H;
  const hx = 40; // housing left edge
  const hw = 90; // housing width
  const axisX = 150; // vertical travel-axis line
  /** Where the marker lines stop. The live one always reaches this column;
   *  crowded neighbours step back from it (see LINE_STAGGER). */
  const markerEndX = axisX + 40;
  /** The label column, clear of the outermost dot by more than the elbow's own
   *  turn-back — otherwise the leader for the marker AT that column ran
   *  leftwards before turning, which read as the line belonging to the row
   *  above it. */
  const labelX = markerEndX + 22;

  // Depth the moving assembly is drawn at — the live travel reading when the
  // monitor is on, otherwise fully at rest.
  const depthMm = liveMm ?? 0;
  const dy = spanPx(0, depthMm);

  // Every part is positioned from the datum (the magnet's bottom face at
  // `AXIS_TOP`) and then translated down by the current travel, so the drawn
  // switch and the axis can never disagree.
  const magnetTop = AXIS_TOP - ASSEMBLY.magnetH;
  const stemTop = magnetTop - ASSEMBLY.stemH;
  const capBottom = stemTop - ASSEMBLY.capGap;
  const capTop = capBottom - ASSEMBLY.keycapH;
  // The housing swallows the magnet at rest and runs down to the PCB.
  const housingTop = magnetTop - 6;

  // A zigzag between two y's, its coil count roughly constant regardless of
  // span — visually "compresses" (tighter zigzags) as the key presses down
  // and the spring shortens, rather than being a static decoration.
  const springPath = (x: number, yTop: number, yBottom: number) => {
    const coils = 6;
    const span = Math.max(6, yBottom - yTop);
    const step = span / coils;
    let d = `M ${x} ${yTop}`;
    for (let i = 0; i < coils; i++) {
      const y0 = yTop + step * i;
      const y1 = yTop + step * (i + 0.5);
      const y2 = yTop + step * (i + 1);
      d += ` L ${x + 7} ${y0 + step * 0.25} L ${x - 7} ${y1 + step * 0.25} L ${x} ${y2}`;
    }
    return d;
  };

  // No dead-zone markers. A dead zone is a REGION, not a threshold, and
  // drawing it as a labelled line with a number ("Bottom dead zone 3.70") put
  // two more rows into an already crowded label stack to say something the
  // shaded band beside them was already saying. The band does the whole job
  // now — see the hatched rects below.
  const markers: Marker[] = [];
  markers.push({
    mm: actuationMm,
    label: t('act.marker.actuate'),
    color: 'var(--accent)',
    mixed: mixed?.actuationMm,
  });
  if (releaseMm !== undefined && releaseMm !== actuationMm)
    markers.push({
      mm: releaseMm,
      label: t('act.marker.release'),
      color: 'var(--text-dim)',
      dashed: true,
      mixed: mixed?.releaseMm,
    });

  /**
   * Rapid-trigger thresholds follow the KEY, not the actuation point.
   *
   * They used to be drawn at `actuation + rtPress` and `actuation - rtRelease`,
   * which is simply not what rapid trigger does: both thresholds are measured
   * from the deepest (or shallowest) point the key has reached since it last
   * reversed, so they chase it up and down the stroke. See `rapidTrigger.ts`.
   *
   * With a live reading we draw the real tracked thresholds. Without one there
   * is no extremum to measure from, so instead of inventing a position we hang
   * the two spans off the resting `Now` line, drawn faint — that shows the size
   * of each threshold and which way it acts, without claiming a depth.
   */
  const rtLive = rtPressAtMm != null || rtReleaseAtMm != null;
  if (rapidTrigger) {
    if (rtReleaseAtMm != null) {
      markers.push({
        mm: rtReleaseAtMm,
        valueMm: rtReleaseMm,
        label: t('act.marker.rtRelease'),
        color: 'var(--violet)',
        dashed: true,
      });
    }
    if (rtPressAtMm != null) {
      markers.push({
        mm: rtPressAtMm,
        valueMm: rtPressMm,
        label: t('act.marker.rtPress'),
        color: 'var(--violet)',
        dashed: true,
      });
    }
    if (!rtLive) {
      if (rtPressMm != null)
        markers.push({
          mm: depthMm + rtPressMm,
          valueMm: rtPressMm,
          label: t('act.marker.rtPress'),
          color: 'var(--violet)',
          dashed: true,
          faint: true,
        });
      if (rtReleaseMm != null)
        markers.push({
          mm: Math.max(0, depthMm - rtReleaseMm),
          valueMm: rtReleaseMm,
          label: t('act.marker.rtRelease'),
          color: 'var(--violet)',
          dashed: true,
          faint: true,
        });
    }
  }
  // `Now` is drawn ALWAYS, at rest when there is no stream — it used to appear
  // only once a live reading arrived, so the one line that explains what the
  // drawn key is doing was missing exactly when a first-time user looked.
  markers.push({
    mm: depthMm,
    label: t('act.marker.now'),
    color: 'var(--accent)',
    live: true,
    faint: liveMm == null,
  });

  // Marker lines stay on their true row; only the labels are nudged apart, with
  // a leader line drawn back to the row whenever one moved.
  const labelYs = dodgeLabels(
    markers.map((m) => mmToPx(m.mm)),
    LABEL_MIN_GAP,
    12,
    H - 8,
  );
  /**
   * Where each marker's line stops.
   *
   * Only markers that actually crowd each other are staggered — spread out,
   * they all reach the gutter and the illustration stays clean. The live
   * marker always reaches furthest, since it is the one being watched.
   */
  const endXs = (() => {
    const base = markerEndX;
    const byY = markers
      .map((m, i) => ({ y: mmToPx(m.mm), i, live: !!m.live }))
      .sort((a, b) => a.y - b.y);
    const out = new Array<number>(markers.length).fill(base);
    // Walk the rows, splitting them into runs of markers that crowd each other.
    // The live marker always keeps the base column — it is the one being
    // watched — and everything sharing its run steps back, INCLUDING the first
    // of the run. Letting the first keep rank 0 put its dot exactly under the
    // live one, so hovering "Now" lit a dot that belonged to "RT release".
    let runStart = 0;
    for (let n = 1; n <= byY.length; n++) {
      const breaks = n === byY.length || byY[n]!.y - byY[n - 1]!.y >= LABEL_MIN_GAP;
      if (!breaks) continue;
      const run = byY.slice(runStart, n);
      if (run.length > 1) {
        let rank = 1;
        for (const r of run) {
          if (r.live) continue;
          out[r.i] = base - rank * LINE_STAGGER;
          rank++;
        }
      }
      runStart = n;
    }
    return out;
  })();
  const laid = markers.map((m, i) => ({
    ...m,
    y: mmToPx(m.mm),
    labelY: labelYs[i]!,
    endX: endXs[i]!,
  }));

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      width={W}
      height={H}
      role="img"
      aria-label={t('act.switch.aria')}
      className="switch-cross"
    >
      <defs>
        <clipPath id="switch-housing-clip">
          <rect x={hx} y={housingTop} width={hw} height={AXIS_BOTTOM - housingTop} rx={8} />
        </clipPath>
        {/* Dead travel: barred out rather than labelled. A flat wash reads as
            "highlighted"; diagonal bars are the long-standing convention for
            "this region does not count", which is exactly what a dead zone
            is. Same pattern is used on the dead-zone slider tracks beside
            this SVG (see .switch-stage-col-track.dz), so the band and the
            control that sets it are visibly the same object. */}
        <pattern
          id="switch-deadzone-hatch"
          width={6}
          height={6}
          patternUnits="userSpaceOnUse"
          patternTransform="rotate(45)"
        >
          <rect width={6} height={6} fill="var(--text-mut)" fillOpacity={0.14} />
          <line x1={0} y1={0} x2={0} y2={6} stroke="var(--text-mut)" strokeWidth={2.4} />
        </pattern>
      </defs>

      {/* housing shell */}
      <rect
        x={hx}
        y={housingTop}
        width={hw}
        height={AXIS_BOTTOM - housingTop}
        rx={8}
        fill="var(--bg-1)"
        stroke="var(--line)"
      />
      <rect
        x={hx}
        y={housingTop}
        width={hw}
        height={16}
        rx={8}
        fill="var(--bg-2)"
        stroke="var(--line)"
      />

      {/* Dead travel, top and bottom: barred out across the housing AND the
          axis, so the remaining clear span between them reads as the part of
          the stroke that actually counts. */}
      {deadZoneMm ? (
        <rect
          x={hx}
          y={AXIS_TOP}
          width={axisX - hx + 6}
          height={spanPx(0, deadZoneMm)}
          fill="url(#switch-deadzone-hatch)"
        />
      ) : null}
      {deadZoneBottomMm ? (
        <rect
          x={hx}
          y={mmToPx(TOTAL_MM - deadZoneBottomMm)}
          width={axisX - hx + 6}
          height={spanPx(TOTAL_MM - deadZoneBottomMm, TOTAL_MM)}
          fill="url(#switch-deadzone-hatch)"
        />
      ) : null}

      {/* The rapid-trigger band: the span between the key and whichever
          threshold is currently live, so it visibly shrinks and grows with the
          stroke instead of sitting at a fixed depth. */}
      {rapidTrigger && rtLive && (
        <rect
          x={hx}
          y={Math.min(mmToPx(depthMm), mmToPx(rtReleaseAtMm ?? rtPressAtMm ?? depthMm))}
          width={hw}
          height={Math.max(
            2,
            Math.abs(mmToPx(rtReleaseAtMm ?? rtPressAtMm ?? depthMm) - mmToPx(depthMm)),
          )}
          fill="var(--violet)"
          fillOpacity={0.22}
        />
      )}

      {/* Spring and magnet, clipped to the housing they sit inside. */}
      <g clipPath="url(#switch-housing-clip)">
        <path
          d={springPath(hx + 20, housingTop + 14, magnetTop + dy)}
          fill="none"
          stroke="var(--text-mut)"
          strokeWidth={1.2}
        />
        <g transform={`translate(0, ${dy})`}>
          {/* The magnet. Its BOTTOM edge is the datum: at depth d it sits on
              exactly mmToPx(d), which is the row every marker is drawn at. */}
          <rect
            x={hx + 28}
            y={magnetTop}
            width={34}
            height={ASSEMBLY.magnetH}
            rx={2}
            fill="var(--violet)"
          />
        </g>
      </g>

      {/* The stem, drawn UNCLIPPED and all the way up to the keycap.
          Two bugs in one shape: it was inside the housing clip, whose top edge
          is 6px below the datum, so at rest — and at any depth shallower than
          that — its upper 20px was simply cut off and the cap appeared to float
          free of the switch. And it stopped at `stemTop`, one `capGap` short of
          the cap's underside, leaving a permanent gap between the two parts it
          is supposed to join. It now spans cap underside -> datum in one piece.
          This is a section view, so a stem crossing the housing's top lip reads
          correctly rather than needing to be hidden behind it. */}
      <g transform={`translate(0, ${dy})`}>
        <rect
          x={hx + 38}
          y={capBottom}
          width={14}
          /* Cap underside down to the magnet's top face — the magnet finishes
             the stack, and running the stem the extra 10px to the datum would
             paint this grey shaft straight over the middle of it (the stem is
             drawn after the clipped group, so it would win). */
          height={ASSEMBLY.capGap + ASSEMBLY.stemH}
          fill="var(--bg-3)"
          stroke="var(--line)"
        />
      </g>

      {/* Keycap — drawn outside the clip so it travels down OVER the housing,
          the way a real cap does (it is wider than the switch body). */}
      <g transform={`translate(0, ${dy})`}>
        <path
          d={`M ${hx - 5} ${capTop} L ${hx + hw + 5} ${capTop} L ${hx + hw - 4} ${capBottom} L ${hx + 4} ${capBottom} Z`}
          fill="var(--bg-3)"
          stroke="var(--line)"
          strokeWidth={1.2}
        />
      </g>

      {/* PCB + Hall sensor */}
      <line
        x1={hx}
        x2={hx + hw}
        y1={AXIS_BOTTOM}
        y2={AXIS_BOTTOM}
        stroke="var(--line)"
        strokeWidth={2}
      />
      <rect
        x={hx + hw / 2 - 12}
        y={AXIS_BOTTOM - 4}
        width={24}
        height={8}
        rx={2}
        fill="var(--accent)"
        fillOpacity={0.35}
      />

      {/* Travel axis, ticked at three scales.
          Whole millimetres alone gave nothing to judge a 1.45 mm actuation
          point against — the axis spans 4 mm in 240 px, so a 0.1 mm tick is a
          perfectly readable 6 px apart, and the halves get a label since 8
          extra numbers at 30 px spacing still do not crowd. */}
      <line x1={axisX} x2={axisX} y1={AXIS_TOP} y2={AXIS_BOTTOM} stroke="var(--line)" />
      {Array.from({ length: TOTAL_MM * 10 + 1 }, (_, i) => {
        const mm = i / 10;
        const whole = i % 10 === 0;
        const half = i % 5 === 0;
        const len = whole ? 4 : half ? 3 : 1.5;
        return (
          <g key={i} opacity={whole ? 1 : half ? 0.8 : 0.45}>
            <line
              x1={axisX - len}
              x2={axisX + len}
              y1={mmToPx(mm)}
              y2={mmToPx(mm)}
              stroke="var(--line)"
            />
            {half && (
              <text
                x={axisX - 8}
                y={mmToPx(mm) + 3}
                fontSize={whole ? 9 : 7.5}
                fill="var(--text-mut)"
                textAnchor="end"
              >
                {whole ? mm : mm.toFixed(1)}
              </text>
            )}
          </g>
        );
      })}
      <text x={hx - 6} y={AXIS_TOP + 4} fontSize={10} fill="var(--text-mut)" textAnchor="end">
        {t('act.marker.top')}
      </text>
      <text x={hx - 6} y={AXIS_BOTTOM + 4} fontSize={10} fill="var(--text-mut)" textAnchor="end">
        {t('act.marker.bottom')}
      </text>

      {laid.map((m) => (
        <g
          key={`${m.label}-${m.mm}`}
          className={`switch-marker${m.faint || m.mixed ? ' is-faint' : ''}`}
        >
          {/* Hit areas. A callout could previously only be picked up by landing
              on a 1.5px line, which is why "Actuate" would not light at rest.
              Two SMALL rects rather than one spanning both rows: a joined rect
              covers most of the diagram whenever the label is dodged far from
              its marker, and the live marker's would then blanket every other
              callout — which is why nothing else could be highlighted once the
              key was pressed.

              The label row is the reliable one: labels are dodged at least
              LABEL_MIN_GAP apart, so these never overlap each other. */}
          <rect
            className="switch-marker-hit"
            x={labelX - 14}
            y={m.labelY - 7}
            width={W - labelX + 14}
            height={14}
          />
          <rect
            className="switch-marker-hit"
            x={hx + hw}
            y={m.y - 4}
            width={Math.max(0, m.endX - hx - hw)}
            height={8}
          />
          <line
            // The live marker runs the full width of the housing so it visibly
            // meets the magnet it is reporting on; the setting markers start at
            // the housing's right edge and leave the illustration clear.
            x1={m.live ? hx : hx + hw}
            x2={m.endX}
            y1={m.y}
            y2={m.y}
            stroke={m.color}
            strokeWidth={m.live ? 2 : 1.5}
            strokeDasharray={m.dashed ? '4 3' : undefined}
          />
          {/* The row itself, so a marker whose line is hidden under three
              others is still readable as a position. */}
          <circle cx={m.endX} cy={m.y} r={m.live ? 3 : 2.2} fill={m.color} />
          {m.live && (
            <path
              d={`M ${axisX - 5} ${m.y - 5} L ${axisX + 5} ${m.y} L ${axisX - 5} ${m.y + 5} Z`}
              fill={m.color}
            />
          )}
          {/* Elbow, not a single long diagonal: the run out of the marker and
              the run into the label are both horizontal, with one short slope
              between them, which is the ordinary callout shape and far easier
              to trace back when four of them overlap. */}
          {
            <path
              d={`M ${m.endX} ${m.y} H ${labelX - 14} L ${labelX - 5} ${m.labelY} H ${labelX - 2}`}
              fill="none"
              stroke={m.color}
              strokeWidth={0.9}
              opacity={0.75}
            />
          }
          <text
            x={labelX}
            y={m.labelY + 4}
            fontSize={11}
            fill={m.color}
            className="mono"
            fontWeight={m.live ? 700 : undefined}
            // Halo: the stroke is painted *under* the fill, so a label stays
            // legible where it crosses a marker line or a shaded band.
            stroke="var(--bg-1)"
            strokeWidth={3}
            strokeLinejoin="round"
            paintOrder="stroke"
          >
            {m.label}
            {m.mixed ? '' : ` ${(m.valueMm ?? m.mm).toFixed(2)}`}
          </text>
        </g>
      ))}
    </svg>
  );
}

// No colour legend here any more. Every marker already carries its own name
// and value as text on the line itself ("Actuate 1.45"), so a second list
// mapping the same colours back to the same names was duplication that took a
// column of width away from the illustration it described.
