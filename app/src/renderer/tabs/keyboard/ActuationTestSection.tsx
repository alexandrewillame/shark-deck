import { useEffect, useMemo, useRef, useState } from 'react';
import type { MagneticKeySettings } from '@shared/types/keyboard-settings';
import type { LiveDevice } from '@shared/types/live';
import { KB_TRAVEL_RANGE, TRAVEL_POLL_MIN_MS } from '@shared/keyboard-travel';
import { Panel } from '../../components/common';
import { KeyboardMap } from '../../components/KeyboardMap';
import { sd } from '../../state/bridge';
import { useT } from '../../state/i18n';
import { bySlot } from '../../keyLayout';
import { rtInitial, rtStep, type RtState } from './rapidTrigger';
import { TOTAL_MM } from './switchGeometry';

/** Rolling window the graph shows, in milliseconds. */
const WINDOW_MS = 5_000;
/**
 * How often the main process is asked for a travel page while testing — the
 * fastest the board can answer.
 *
 * This asked for 40 ms and got 150: `startTravel` clamps with
 * `Math.max(TRAVEL_POLL_MS, …)`, because one sample is a four-chunk paged
 * magnetism read paced by the driver's 30 ms settle and costs ~130 ms on the
 * wire however often it is asked for. Asking for the real floor by name is
 * both honest and what `DeviceManager.travelRate` needs to hear: the SLOWEST
 * open request wins, so a view that wants the maximum has to not ask for less.
 */
const TEST_POLL_MS = TRAVEL_POLL_MIN_MS;
/** Samples kept per key — the window at the poll rate, plus jitter headroom. */
const MAX_SAMPLES = 256;
/** Below this, a key counts as at rest (matches the driver's own noise floor). */
const REST_MM = 0.05;

interface Sample {
  t: number;
  mm: number;
  down: boolean;
}

/**
 * "What is the keyboard actually doing right now" — the two questions the
 * per-key settings raise and nothing in the app could answer.
 *
 * 1. **Which keys are actuated**, right now, together. Whether a setting has
 *    made a key trigger too easily, or made one press register as two keys, is
 *    not something a number in a slider can tell you.
 * 2. **Travel over time**, per key, against that key's own threshold — which is
 *    where rapid trigger stops being an abstraction, since its thresholds chase
 *    the key rather than sitting at a fixed depth (see rapidTrigger.ts).
 *
 * The board's travel report is a poll, not a push (magnetism page 254 — see
 * docs/protocol/keyboard-compx.md), and the vendor's own tool warns that
 * enabling it costs key response. So it is armed while this view is on screen
 * and no longer — the board panel's info tip says as much, and the button on
 * the graph's heading can stop it without leaving the page.
 */
export function ActuationTestSection({
  device,
  settings,
}: {
  device: LiveDevice;
  /** Per-key settings by slot — the thresholds each key is judged against. */
  settings: Map<number, MagneticKeySettings>;
}) {
  const t = useT();
  const layout = device.ui.keyMatrix?.layout;
  /**
   * On as soon as the view is.
   *
   * Opening a view called Test is the request — there was nothing else this
   * screen could be for, and asking for a second click before it showed
   * anything just meant the first thing everyone saw was an empty graph. The
   * button stays, because the poll does cost key response (the vendor's own
   * tool says so) and that is worth being able to switch off without leaving
   * the page. Stopping the stream when this unmounts already happens below.
   */
  const [running, setRunning] = useState(true);
  /** The keyboard has no travel stream at all: Start can never work. */
  const [unsupported, setUnsupported] = useState(false);
  /**
   * Why a test that was running stopped by itself: the board refused to start
   * the stream, or stopped answering mid-way. Unlike `unsupported`, Start is
   * worth another press, so it stays live. Before the main process passed the
   * board's answer on, both looked like a test running with no key pressed.
   */
  const [stopNote, setStopNote] = useState<'startFailed' | 'lost' | null>(null);
  const [depth, setDepth] = useState<Record<number, number>>({});
  const [down, setDown] = useState<Set<number>>(new Set());
  /**
   * Per-slot ring of recent samples, and the rapid-trigger model per slot.
   *
   * Refs, not state: at 25 Hz across a dozen keys, storing every sample in
   * state would re-render the whole tab per sample. One counter below drives
   * the redraw instead, so the cost is one render per frame however many keys
   * are moving.
   */
  const history = useRef(new Map<number, Sample[]>());
  const rtStates = useRef(new Map<number, RtState>());
  const [, forceDraw] = useState(0);
  /** Achieved sample rate, smoothed. Shown because the requested rate is a
   *  floor the board is free to miss, and a graph that is quietly running at
   *  half speed looks exactly like one that is not. */
  const lastSampleAt = useRef(0);
  const [hz, setHz] = useState(0);

  const settingsRef = useRef(settings);
  settingsRef.current = settings;

  /** slot -> layout key. Also the filter for incoming samples: only a slot
   *  the board draws is a key, so nothing else can reach the pill, the graph
   *  or its legend — not even as a bare slot number (the driver already drops
   *  the off-layout slots; this keeps the view honest against any that
   *  don't). */
  const keyBySlot = useMemo(() => bySlot(layout), [layout]);
  const keyBySlotRef = useRef(keyBySlot);
  keyBySlotRef.current = keyBySlot;

  useEffect(() => {
    if (!running) return;
    let stopped = false;
    void sd.startTravelStream(device.id, TEST_POLL_MS).then((r) => {
      if (stopped || r.ok) return;
      if (r.unsupported) setUnsupported(true);
      else setStopNote('startFailed');
      setRunning(false);
    });
    const off = sd.on('device:travel', (p) => {
      if (stopped || p.id !== device.id) return;
      if (p.ended) {
        setStopNote('lost');
        setRunning(false);
        return;
      }
      if (!p.keys || p.complete === false) return;
      const now = Date.now();
      if (lastSampleAt.current) {
        const dt = now - lastSampleAt.current;
        if (dt > 0) setHz((prev) => (prev ? prev * 0.8 + (1000 / dt) * 0.2 : 1000 / dt));
      }
      lastSampleAt.current = now;
      const seen = new Map(
        p.keys.filter((k) => keyBySlotRef.current.has(k.slot)).map((k) => [k.slot, k.mm]),
      );
      const nextDown = new Set<number>();
      const nextDepth: Record<number, number> = {};

      // Every slot the history knows about is advanced, not only the ones in
      // this sample: a key absent from a sample is at REST, and skipping it
      // would leave its model holding the last press forever (the same trap
      // MagneticSection's own RT effect documents).
      const slots = new Set<number>([...seen.keys(), ...history.current.keys()]);
      for (const slot of slots) {
        const mm = seen.get(slot) ?? 0;
        const s = settingsRef.current.get(slot);
        const cfg = {
          actuationMm: s?.actuationMm ?? KB_TRAVEL_RANGE.travel.default,
          pressMm: s?.rtPressMm ?? KB_TRAVEL_RANGE.rt.default,
          releaseMm: s?.rtReleaseMm ?? KB_TRAVEL_RANGE.rt.default,
        };
        let state = rtStates.current.get(slot) ?? rtInitial();
        if (s?.rapidTrigger) {
          state = rtStep(state, mm, cfg);
        } else {
          // Plain threshold with hysteresis: fires past the actuation point,
          // releases above the release point (the same depth when the two are
          // linked, which is the board's own default).
          const release = s?.releaseMm ?? cfg.actuationMm;
          state = { ...state, down: state.down ? mm > release : mm >= cfg.actuationMm };
        }
        rtStates.current.set(slot, state);
        if (state.down) nextDown.add(slot);
        nextDepth[slot] = mm;

        const ring = history.current.get(slot) ?? [];
        ring.push({ t: now, mm, down: state.down });
        while (ring.length > MAX_SAMPLES || (ring[0] && now - ring[0].t > WINDOW_MS)) ring.shift();
        // Forget a key that has been at rest for the whole window, so the
        // graph does not accumulate a line for every key ever touched.
        if (ring.every((x) => x.mm <= REST_MM)) history.current.delete(slot);
        else history.current.set(slot, ring);
      }
      setDepth(nextDepth);
      setDown(nextDown);
      forceDraw((n) => n + 1);
    });
    return () => {
      stopped = true;
      off();
      void sd.stopTravelStream(device.id, TEST_POLL_MS);
      history.current.clear();
      rtStates.current.clear();
      lastSampleAt.current = 0;
      setHz(0);
      setDepth({});
      setDown(new Set());
    };
  }, [running, device.id]);

  const labelOfSlot = useMemo(() => {
    const m = new Map<number, string>();
    for (const [slot, k] of keyBySlot) m.set(slot, k.label);
    return m;
  }, [keyBySlot]);

  const pct = (v: number) => Math.max(0, Math.min(100, (v / TOTAL_MM) * 100));

  // Which keys are actuated sits on the board panel's own heading line: it is
  // the board's status, and a row of its own under the board cost a line
  // whether or not anything was pressed. The status box keeps its height
  // empty, so the pill appearing never nudges the board.
  const actuated = (
    <span className="act-test-status" aria-live="polite">
      {running && down.size > 0 && (
        <span className="pill ok">
          {t('act.test.actuated')}:{' '}
          {[...down]
            .map((s) => labelOfSlot.get(s))
            .filter(Boolean)
            .join(' + ')}
        </span>
      )}
    </span>
  );

  return (
    <>
      <Panel
        title={t('act.test.title')}
        tip={t('act.test.sub')}
        actions={actuated}
        className="panel-board-first"
      >
        <div className="kb-with-rail">
          <KeyboardMap
            layout={layout}
            interactive={false}
            // An actuated key lights up; every key also carries its live depth as
            // a gauge, so a key pressed but NOT registering looks different from
            // one that is not pressed at all. That difference is the question.
            accent={(k) => (k.slot != null && down.has(k.slot) ? 'var(--green)' : undefined)}
            gauge={(k) => {
              if (k.slot == null) return undefined;
              const s = settings.get(k.slot);
              return {
                fillPct: pct(depth[k.slot] ?? 0),
                ticks: [
                  {
                    pct: pct(s?.actuationMm ?? KB_TRAVEL_RANGE.travel.default),
                    color: 'var(--accent)',
                  },
                ],
              };
            }}
          />
          <div className="kg-rail kg-rail-ghost" aria-hidden="true" />
        </div>
      </Panel>
      {/* The control that starts and stops the stream sits with what it
          drives: the graph's heading, with the stream's own status beside it. */}
      <Panel
        title={t('act.test.graph')}
        actions={
          <>
            {unsupported && <span className="hint">{t('act.test.unsupported')}</span>}
            {!running && stopNote && (
              <span className="hint">
                {t(stopNote === 'lost' ? 'act.test.lost' : 'act.test.startFailed')}
              </span>
            )}
            {running && hz > 0 && (
              <span className="hint">{t('act.test.rate', { n: hz.toFixed(1) })}</span>
            )}
            <button
              className={`btn ${running ? '' : 'primary'}`}
              disabled={unsupported}
              onClick={() => {
                setStopNote(null);
                setRunning((r) => !r);
              }}
            >
              {running ? t('act.test.stop') : t('act.test.start')}
            </button>
          </>
        }
      >
        <TravelGraph
          history={history.current}
          labels={labelOfSlot}
          settings={settings}
          running={running}
        />
      </Panel>
    </>
  );
}

/** Graph geometry. Plain inline SVG, like the rest of this tab. */
const G = { w: 720, h: 200, padL: 26, padR: 8, padT: 8, padB: 10 };
const LINE_COLORS = [
  'var(--accent)',
  'var(--violet)',
  'var(--amber)',
  'var(--green)',
  'var(--magenta)',
];

/**
 * A path through `pts` as cubic Béziers, using centripetal Catmull-Rom.
 *
 * The graph drew straight segments between samples, and at ~6 samples a second
 * a keypress is four or five points — so a stroke that is physically a smooth
 * curve came out as a spiky polyline whose corners were just the sample
 * instants.
 *
 * Centripetal (alpha = 0.5), not uniform: samples are NOT evenly spaced in x
 * (the poll jitters, and a key at rest is dropped from the ring entirely), and
 * uniform Catmull-Rom overshoots badly where a short segment meets a long one
 * — it puts a control point outside the range of its own neighbours, which on
 * a travel graph reads as the key having gone deeper than it did. Centripetal
 * parameterisation cannot do that.
 */
function smoothPath(pts: Array<{ x: number; y: number }>): string {
  if (pts.length === 0) return '';
  if (pts.length === 1) return `M ${pts[0]!.x} ${pts[0]!.y}`;
  if (pts.length === 2) return `M ${pts[0]!.x} ${pts[0]!.y} L ${pts[1]!.x} ${pts[1]!.y}`;

  const d: string[] = [`M ${pts[0]!.x} ${pts[0]!.y}`];
  const dist = (a: { x: number; y: number }, b: { x: number; y: number }) =>
    Math.sqrt((b.x - a.x) ** 2 + (b.y - a.y) ** 2);

  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] ?? pts[i]!;
    const p1 = pts[i]!;
    const p2 = pts[i + 1]!;
    const p3 = pts[i + 2] ?? p2;

    // Knot spacing to the power of alpha/... — the square root IS alpha = 0.5.
    const d1 = Math.sqrt(dist(p0, p1)) || 1e-6;
    const d2 = Math.sqrt(dist(p1, p2)) || 1e-6;
    const d3 = Math.sqrt(dist(p2, p3)) || 1e-6;

    const c1x = p1.x + ((p2.x - p0.x) * d2) / (3 * (d1 + d2));
    const c1y = p1.y + ((p2.y - p0.y) * d2) / (3 * (d1 + d2));
    const c2x = p2.x - ((p3.x - p1.x) * d2) / (3 * (d2 + d3));
    const c2y = p2.y - ((p3.y - p1.y) * d2) / (3 * (d2 + d3));
    d.push(`C ${c1x} ${c1y} ${c2x} ${c2y} ${p2.x} ${p2.y}`);
  }
  return d.join(' ');
}

/**
 * A clock that ticks every animation frame, so the graph scrolls with the
 * wall clock instead of with the sample stream.
 *
 * The window's right edge is "now", and `now` used to be read once per render
 * — and the only thing causing a render was a sample arriving. At ~6 samples a
 * second that meant the whole plot jumped 1/30th of its width, six times a
 * second: a stutter whose size was set by the poll interval and which got
 * worse exactly when the board was slowest to answer. Scrolling is a property
 * of time passing, not of data arriving.
 */
function useAnimationClock(active: boolean): number {
  const [t, setT] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    let raf = 0;
    const tick = () => {
      setT(Date.now());
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [active]);
  return t;
}

/**
 * Travel of every recently-active key over the last few seconds.
 *
 * One line per key, plus a shaded band from that key's actuation point down to
 * the bottom of the stroke — so "far enough to register" is a region you watch
 * the line enter, not a number to compare against. The segments where the key
 * was actually reported down are drawn thick, which is what makes rapid
 * trigger legible: with RT on, the line leaves and re-enters `down` without
 * ever coming back out of the band.
 *
 * The axes are drawn even with nothing to plot, so the panel keeps its height
 * when the test is stopped or idle instead of collapsing to a line of text.
 * "Press any key." is only shown while the test is running: a stopped test is
 * not listening, so inviting a key press there was wrong.
 */
function TravelGraph({
  history,
  labels,
  settings,
  running,
}: {
  history: Map<number, Sample[]>;
  labels: Map<number, string>;
  settings: Map<number, MagneticKeySettings>;
  running: boolean;
}) {
  const t = useT();
  const slots = [...history.keys()];
  // Ticks every frame whenever there is anything to draw, so the plot slides
  // smoothly rather than in one jump per sample.
  const now = useAnimationClock(slots.length > 0);
  const plotW = G.w - G.padL - G.padR;
  const plotH = G.h - G.padT - G.padB;
  const x = (ts: number) => G.padL + plotW * (1 - (now - ts) / WINDOW_MS);
  const y = (mm: number) => G.padT + plotH * Math.max(0, Math.min(1, mm / TOTAL_MM));

  return (
    <svg viewBox={`0 0 ${G.w} ${G.h}`} width="100%" role="img" aria-label={t('act.test.graph')}>
      {[0, 1, 2, 3, 4].map((mm) => (
        <g key={mm}>
          <line
            x1={G.padL}
            y1={y(mm)}
            x2={G.w - G.padR}
            y2={y(mm)}
            stroke="var(--line)"
            strokeWidth={0.5}
          />
          <text x={2} y={y(mm) + 3} fontSize={9} fill="var(--text-mut)">
            {mm}
          </text>
        </g>
      ))}
      {running && slots.length === 0 && (
        <text
          x={G.padL + plotW / 2}
          y={G.padT + plotH / 2}
          fontSize={12}
          textAnchor="middle"
          dominantBaseline="middle"
          fill="var(--text-mut)"
        >
          {t('act.test.waiting')}
        </text>
      )}
      {slots.map((slot, i) => {
        const ring = history.get(slot) ?? [];
        const color = LINE_COLORS[i % LINE_COLORS.length]!;
        const act = settings.get(slot)?.actuationMm ?? KB_TRAVEL_RANGE.travel.default;
        const line = smoothPath(ring.map((s) => ({ x: x(s.t), y: y(s.mm) })));
        // Contiguous runs where the key was reported down, smoothed the same
        // way so the thick overlay follows the thin line exactly.
        const runs: string[] = [];
        let run: Array<{ x: number; y: number }> = [];
        for (const s of ring) {
          if (s.down) run.push({ x: x(s.t), y: y(s.mm) });
          else if (run.length) {
            runs.push(smoothPath(run));
            run = [];
          }
        }
        if (run.length) runs.push(smoothPath(run));
        return (
          <g key={slot}>
            <rect
              x={G.padL}
              y={y(act)}
              width={plotW}
              height={Math.max(0, y(TOTAL_MM) - y(act))}
              fill={color}
              opacity={0.05}
            />
            <line
              x1={G.padL}
              y1={y(act)}
              x2={G.w - G.padR}
              y2={y(act)}
              stroke={color}
              strokeWidth={0.8}
              strokeDasharray="3 3"
              opacity={0.6}
            />
            <path d={line} fill="none" stroke={color} strokeWidth={1.2} opacity={0.75} />
            {runs.map((d, j) => (
              <path key={j} d={d} fill="none" stroke={color} strokeWidth={3} />
            ))}
            <text x={G.padL + 4} y={G.padT + 12 + i * 12} fontSize={10} fill={color}>
              {labels.get(slot)}
            </text>
          </g>
        );
      })}
    </svg>
  );
}
