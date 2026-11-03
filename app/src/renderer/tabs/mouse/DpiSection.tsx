import type { CSSProperties } from 'react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { EditableNumber, Panel, Row, Tooltip } from '../../components/common';
import { Icon } from '../../components/icons';
import {
  type TabProps,
  sd,
  useDeviceData,
  useAutoWrite,
  useLiveSync,
  ReadFailed,
  Loading,
} from '../common';
import { useT } from '../../state/i18n';
import { hexToRgb, rgbToHex } from '../../colorUtil';
import { ColorPickerField } from '../../components/ColorPickerField';
import { InfoLabel } from '../../components/InfoLabel';
import { DpiMedia } from '../../components/tooltipMedia';
import type { DpiStage } from '@shared/types/mouse-settings';
import {
  MAX_STAGES,
  MIN_STAGES,
  clamp01,
  computeDpiWindow,
  pickNewStageColor,
  snapDpi,
} from './dpiStages';

export function DpiSection({ device }: TabProps) {
  const t = useT();
  const rng = device.ui.dpiRange ?? { min: 100, max: 26000, step: 50, stages: 6 };
  const {
    data: rawStages,
    setData,
    loading,
    firstLoad,
  } = useDeviceData<DpiStage[] | null>(device.id, sd.readDpiStages, null, [], 'dpiStages');
  // Defensive clamp on top of the driver's own (see compx-mouse-8k.ts's
  // readDpiStages) — a stale read can never show, add to, or write back more
  // than the catalog's declared stage count allows. Memoised on `rawStages`
  // identity: without this the `slice` produced a fresh array every render, so
  // the `computeDpiWindow` effect below ran every render and its `setWin`
  // (always a new object) never settled — a self-sustaining render loop once a
  // DPI read succeeds.
  const stages = useMemo(
    () => (rawStages ? rawStages.slice(0, MAX_STAGES) : rawStages),
    [rawStages],
  );
  const { queue, flush, commit } = useAutoWrite(250, { deviceId: device.id });

  // Which stage is actually applied to the mouse right now — distinct from
  // `active` below (that's hover/focus highlight only). Read once per
  // device; kept in sync locally on every click so the highlight moves
  // immediately instead of waiting on a re-read.
  const { data: selected, setData: setSelected } = useDeviceData<number | null>(
    device.id,
    sd.readActiveDpiStage,
    null,
    [],
    'activeDpiStage',
  );
  // The mouse's own DPI button moves the active stage with no app involvement.
  // `device.activeDpiStage` is the manager's live poll of it (see
  // setLiveWatch); this adopts it into the highlight above without a re-read,
  // a toast, or a remount. Frozen while a tick or its ID label is being
  // dragged, and `note()` below stops a poll that started before a click of
  // ours from undoing it.
  //
  // Only the SELECTED stage is live-synced, not the stage table: the V8 has no
  // on-device way to change a stage's DPI value, only to cycle between them,
  // and the one thing that does replace the table — a profile switch —
  // already remounts this pane via configEpoch.
  const { note: noteStage } = useLiveSync(device.activeDpiStage, selected, setSelected, {
    held: () => draggingIndex !== null || numberDragging.current,
  });
  const applyStage = (i: number) => {
    if (!stages || i === selected || !stages[i]?.enabled) return;
    setSelected(i);
    noteStage(i);
    commit(t('dpi.active'), () => sd.setActiveDpiStage(device.id, i));
  };

  const save = (next: DpiStage[]) => sd.setDpiStages(device.id, next);

  // 1-based rank of each array slot by ascending DPI (ties -> lower slot
  // first), shown as the stage's ID everywhere — so the lowest DPI always
  // reads as "1" regardless of the order the device stores its stages in.
  // The array itself is left in device order (reordering it would desync
  // `activeDpiStage` and the on-device register order).
  const ranks = useMemo(() => {
    if (!stages) return [] as number[];
    const order = stages.map((_, i) => i).sort((a, b) => stages[a]!.dpi - stages[b]!.dpi || a - b);
    const r: number[] = [];
    order.forEach((slot, pos) => (r[slot] = pos + 1));
    return r;
  }, [stages]);

  const write = (next: DpiStage[], debounced?: boolean) =>
    debounced ? queue(t('dpi.title'), () => save(next)) : commit(t('dpi.title'), () => save(next));

  const patch = (i: number, p: Partial<DpiStage>, debounced?: boolean) => {
    if (!stages) return;
    const next = stages.map((x, j) => (j === i ? { ...x, ...p } : x));
    setData(next);
    write(next, debounced);
  };
  /** Local-only update — no device write. Used by the DPI text field while the
   *  user is still typing, so a half-typed "1" (or an empty box, `Number('')`
   *  = 0) never reaches the hardware; the snap-and-write happens on blur/Enter. */
  const patchLocal = (i: number, p: Partial<DpiStage>) => {
    if (!stages) return;
    setData(stages.map((x, j) => (j === i ? { ...x, ...p } : x)));
  };
  const addStage = () => {
    if (!stages || stages.length >= MAX_STAGES) return;
    const prevDpi = stages[stages.length - 1]?.dpi ?? rng.min;
    // A proportional jump (not a fixed +4 steps) so a new stage is visibly
    // distinct from the last one even inside a zoomed-in auto window.
    const dpi = Math.min(rng.max, Math.round((prevDpi * 1.5) / rng.step) * rng.step);
    const color = pickNewStageColor(
      stages.map((s) => s.color),
      stages.length,
    );
    const next = [...stages, { index: stages.length, dpi, color, enabled: true }];
    setData(next);
    write(next);
  };
  const removeStage = (i: number) => {
    if (!stages || stages.length <= MIN_STAGES) return;
    const filtered = stages.filter((_, j) => j !== i).map((s, j) => ({ ...s, index: j }));
    // Removing a stage shifts every later stage's index down by one — keep
    // `selected` pointing at the same physical stage, or (if the removed
    // stage was itself the active one) fall back to the nearest remaining
    // stage and tell the device so, since its old slot no longer exists.
    const removedWasSelected = selected === i;
    const shifted =
      selected === null ? 0 : removedWasSelected ? i : selected > i ? selected - 1 : selected;
    const clamped = Math.min(Math.max(0, shifted), filtered.length - 1);
    setData(filtered);
    write(filtered);
    if (selected !== null) {
      if (clamped !== selected) setSelected(clamped);
      if (removedWasSelected)
        commit(t('dpi.active'), () => sd.setActiveDpiStage(device.id, clamped));
    }
  };

  // Which stage's tick is hovered/focused — its tick *and* its ID label and
  // its row light up together, so it's unambiguous which one you're moving.
  const [active, setActive] = useState<number | null>(null);
  const activate = (i: number) => setActive(i);
  const deactivate = (i: number) => setActive((a) => (a === i ? null : a));

  // Which stage is actively being dragged (tick, connector, or the ID
  // label's own drag — not just hovered) — shows a floating tooltip with
  // the live DPI value right above the track while it's set, so the number
  // is readable without needing to also watch the row below during the
  // drag itself.
  const [draggingIndex, setDraggingIndex] = useState<number | null>(null);

  // Clicking the tick (not just its ID label below) opens the same numeric
  // editor — a click needs to be told apart from a drag, since both start
  // the same way (pointerdown on the tick). `tickButtons` holds each stage's
  // EditableNumber trigger (via its `triggerRef`) so a recognised click can
  // just call `.click()` on it — same editor, same code path as clicking
  // the label directly.
  const tickButtons = useRef<Record<number, HTMLButtonElement | null>>({});
  // Measures the track for the ID label's own drag support (see
  // EditableNumber's `onDragMove`) — dragging the number should move the
  // stage exactly like dragging the tick does, not just open the editor.
  const trackLineRef = useRef<HTMLDivElement>(null);
  // The visible tick and its connector to the (now further-away) ID label
  // are both drag targets for the same stage — "hover over anything
  // connected to a stage and you can move it" rather than only the label.
  // One shared ref (only one gesture can be in flight at a time, since
  // there's one mouse) tracks which stage, and which of the two, is mid-drag.
  const pointerDrag = useRef<{ i: number; startX: number; dragging: boolean } | null>(null);
  // EditableNumber's own drag (dragging the ID label itself) isn't tracked by
  // `pointerDrag` above — this parallel flag lets the window-resize effect
  // below know a gesture of *either* kind is in flight.
  const numberDragging = useRef(false);

  // The track's visible window always zooms to the enabled stages — it still
  // reaches the device's full range by dragging a tick to an edge (see
  // computeDpiWindow's grow-only behaviour mid-drag, below).
  const [win, setWin] = useState(() => computeDpiWindow(stages ?? [], rng));
  useEffect(() => {
    if (!stages) return;
    const target = computeDpiWindow(stages, rng);
    const dragging = pointerDrag.current !== null || numberDragging.current;
    // Recompute freely between gestures; grow-only while one is in flight so
    // the track never rubber-bands out from under the cursor mid-drag — as a
    // dragged value approaches/passes the current window edge, `target`
    // already covers it (computeDpiWindow reads the live stage values), so
    // this still reaches the full range by dragging to an edge.
    setWin((w) => {
      const next = dragging
        ? { min: Math.min(w.min, target.min), max: Math.max(w.max, target.max) }
        : target;
      // Return the SAME object when nothing actually moved, so React bails out
      // of the re-render instead of committing an identical value.
      return next.min === w.min && next.max === w.max ? w : next;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stages, rng.min, rng.max]);

  // 0..1 position of a DPI value along the *visible window* (not the full
  // device range) — this is what makes the track "auto-zoom".
  const frac = (dpi: number) => clamp01((dpi - win.min) / Math.max(1, win.max - win.min));

  // The rendering formula insets by half the tick's own hit-area width at
  // each end (`--dpi-thumb`, read once below) so the tick's travel matches a
  // native range thumb's; the inverse below previously didn't account for
  // that inset at all, which is why a drag could land the tick several
  // pixels off the cursor and made "hover near a trait" unreliable.
  const dpiThumbPx = useRef(14);
  useEffect(() => {
    const el = trackLineRef.current;
    if (!el) return;
    const v = parseFloat(getComputedStyle(el).getPropertyValue('--dpi-thumb'));
    if (!Number.isNaN(v) && v > 0) dpiThumbPx.current = v;
  }, []);
  const dpiFromClientX = (clientX: number): number => {
    const rect = trackLineRef.current?.getBoundingClientRect();
    if (!rect || rect.width === 0) return win.min;
    const thumb = dpiThumbPx.current;
    const usable = Math.max(1, rect.width - thumb);
    const frac = clamp01((clientX - rect.left - thumb / 2) / usable);
    const raw = win.min + frac * (win.max - win.min);
    const stepped = Math.round(raw / rng.step) * rng.step;
    return Math.min(rng.max, Math.max(rng.min, stepped));
  };

  return (
    // One info dot on the heading, not two: the explanation of what DPI is
    // (with its picture) and the device's range/step note share a tooltip,
    // the range on its own line — `.tt` is `white-space: pre-line`.
    <Panel
      title={
        <InfoLabel
          label={t('dpi.title')}
          text={`${t('dpi.hint')}\n${t('dpi.range', { min: rng.min, max: rng.max, step: rng.step })}`}
          media={<DpiMedia />}
        />
      }
    >
      {firstLoad && <Loading />}
      {!loading && stages === null && <ReadFailed />}
      {!loading && stages !== null && (
        <>
          {/* One visual track, min -> max: a slim coloured tick per enabled
              stage, its ID above (odd) or below (even) so close ticks stay
              readable, tied to it with a small connector line. A native
              <input type=range> per stage still backs each one for keyboard
              access (Tab + arrow keys), but is entirely pointer-events:none
              (see styles.css) — the tick, its connector, and its ID label
              are what the mouse actually drags, each independently. Writes
              commit on release (pointer-up / blur). */}
          <div className="dpi-slider">
            <span className="dpi-track-end mono">{win.min}</span>
            <div className="dpi-track-line" ref={trackLineRef} onPointerUp={flush}>
              {/* A real element, not `.dpi-track-line::before` (which this
                  used to be) — the tick thumbs kept rendering behind the
                  bar despite an explicit z-index ordering that should have
                  put them in front, which points at some quirk specific to
                  stacking a native ::-webkit-slider-thumb against a
                  generated-content pseudo-element rather than an ordinary
                  sibling. A plain DOM element sidesteps the question
                  entirely: first in the JSX (so first in tree/paint order),
                  same visual result, no pseudo-element involved. */}
              <div className="dpi-track-bar" />
              {/* The visible track auto-zooms to the enabled stages
                  (computeDpiWindow) — when that window doesn't reach the
                  device's real min/max, these dashes mark that this edge is
                  a scaled cut, not the sensor's actual limit, so it doesn't
                  read as "you've hit the end" when there's really more range
                  just off-screen. Positioned flush against the bar's own
                  edge (`right: 100%` / `left: 100%` — same coordinate space,
                  not bridged across the flex gap to `.dpi-track-end` with
                  margin math) so the dashes read as that solid line
                  continuing, not a decoration floating near the number. */}
              {win.min > rng.min && (
                <div className="dpi-track-bar-ext dpi-track-bar-ext-start" aria-hidden="true" />
              )}
              {win.max < rng.max && (
                <div className="dpi-track-bar-ext dpi-track-bar-ext-end" aria-hidden="true" />
              )}
              {stages.map((s, i) =>
                s.enabled ? (
                  <input
                    key={i}
                    type="range"
                    // Keyboard-only now (`pointer-events: none` on the whole
                    // input — see styles.css): Tab focuses it, arrow keys
                    // nudge the value via `onChange`, same as any native
                    // range input, but it never itself responds to the
                    // mouse. Two separate attempts to make its *own* thumb
                    // the mouse-interactive surface (first a plain z-index
                    // fix, then an invisible-but-still-pointer-events:auto
                    // thumb decoupled from a visible sibling div) both left
                    // hovering unreliable specifically around the track's own
                    // vertical centre — where the bar sits — which points at
                    // some quirk in how a native `<input type=range>` hit-
                    // tests its thumb near the geometric middle of a track
                    // much taller than its default rendering, not just a
                    // stacking/z-index question. `.dpi-tick-visual` below is
                    // an ordinary `<div>` with its own pointer handling, free
                    // of whatever that quirk is.
                    className="dpi-track-handle"
                    aria-label={String(ranks[i])}
                    min={rng.min}
                    max={rng.max}
                    step={rng.step}
                    value={s.dpi}
                    onChange={(e) => patch(i, { dpi: Number(e.target.value) }, true)}
                    onFocus={() => activate(i)}
                    onBlur={() => deactivate(i)}
                  />
                ) : null,
              )}
              {/* The actually-visible tick, and — since the native thumb
                  above no longer takes pointer input at all — the primary
                  surface a mouse actually interacts with. A plain `<div>`
                  with its own drag handling (same pattern as the connector
                  below), positioned with the same formula as the connector
                  and the ID label (inset by half the nominal thumb width at
                  each end) so all three stay lined up with each other. */}
              {stages.map((s, i) =>
                s.enabled ? (
                  <div
                    key={`visual-${i}`}
                    className={`dpi-tick-visual ${active === i ? 'is-active' : ''} ${selected === i ? 'is-selected' : ''}`}
                    style={
                      {
                        left: `calc(${frac(s.dpi)} * (100% - var(--dpi-thumb)) + var(--dpi-thumb) / 2)`,
                        '--handle-color': rgbToHex(s.color),
                      } as CSSProperties
                    }
                    onMouseEnter={() => activate(i)}
                    onMouseLeave={() => deactivate(i)}
                    onPointerDown={(e) => {
                      pointerDrag.current = { i, startX: e.clientX, dragging: false };
                      e.currentTarget.setPointerCapture(e.pointerId);
                    }}
                    onPointerMove={(e) => {
                      const d = pointerDrag.current;
                      if (!d || d.i !== i) return;
                      if (!d.dragging && Math.abs(e.clientX - d.startX) > 3) d.dragging = true;
                      if (d.dragging) {
                        patch(i, { dpi: dpiFromClientX(e.clientX) }, true);
                        setDraggingIndex(i);
                      }
                    }}
                    onPointerUp={() => {
                      const d = pointerDrag.current;
                      pointerDrag.current = null;
                      setDraggingIndex(null);
                      if (d?.dragging) flush();
                      // A plain click (negligible movement) opens the exact
                      // same numeric editor the ID label opens, instead of
                      // just being a no-op drag-to-the-same-spot.
                      else tickButtons.current[i]?.click();
                    }}
                  />
                ) : null,
              )}
              {draggingIndex !== null && stages[draggingIndex] && (
                <div
                  className="dpi-drag-tooltip"
                  style={{
                    left: `calc(${frac(stages[draggingIndex]!.dpi)} * (100% - var(--dpi-thumb)) + var(--dpi-thumb) / 2)`,
                  }}
                >
                  {t('dpi.dragValue', { dpi: stages[draggingIndex]!.dpi })}
                </div>
              )}
              <div className="dpi-tick-labels">
                {/* The tie line between a tick and its label, further away
                    from it now than before — see `.dpi-tick-connector` in
                    styles.css. Its own hit-area is wider than the thin line
                    actually drawn (same idea as the invisible native
                    thumb's own hit-area, below), and dragging it moves the
                    stage exactly like dragging the tick or the label does;
                    a plain click (no real movement) opens the same editor
                    instead, via the same `tickButtons` ref the tick's own
                    click-vs-drag handling already uses. */}
                {stages.map((s, i) =>
                  s.enabled ? (
                    <div
                      key={`connector-${i}`}
                      className={`dpi-tick-connector ${active === i ? 'is-active' : ''}`}
                      data-side={ranks[i]! % 2 ? 'up' : 'down'}
                      style={
                        {
                          left: `calc(${frac(s.dpi)} * (100% - var(--dpi-thumb)) + var(--dpi-thumb) / 2)`,
                          '--handle-color': rgbToHex(s.color),
                        } as CSSProperties
                      }
                      onMouseEnter={() => activate(i)}
                      onMouseLeave={() => deactivate(i)}
                      onPointerDown={(e) => {
                        pointerDrag.current = { i, startX: e.clientX, dragging: false };
                        e.currentTarget.setPointerCapture(e.pointerId);
                      }}
                      onPointerMove={(e) => {
                        const d = pointerDrag.current;
                        if (!d || d.i !== i) return;
                        if (!d.dragging && Math.abs(e.clientX - d.startX) > 3) d.dragging = true;
                        if (d.dragging) {
                          patch(i, { dpi: dpiFromClientX(e.clientX) }, true);
                          setDraggingIndex(i);
                        }
                      }}
                      onPointerUp={() => {
                        const d = pointerDrag.current;
                        pointerDrag.current = null;
                        setDraggingIndex(null);
                        if (d?.dragging) flush();
                        else tickButtons.current[i]?.click();
                      }}
                    />
                  ) : null,
                )}
                {stages.map((s, i) =>
                  s.enabled ? (
                    <EditableNumber
                      key={i}
                      triggerRef={(el) => (tickButtons.current[i] = el)}
                      className={`dpi-tick-label ${active === i ? 'is-active' : ''} ${selected === i ? 'is-selected' : ''}`}
                      style={
                        {
                          // match the native thumb's travel (inset half a thumb
                          // width at each end) so the label tracks it 1:1
                          left: `calc(${frac(s.dpi)} * (100% - var(--dpi-thumb)) + var(--dpi-thumb) / 2)`,
                          '--handle-color': rgbToHex(s.color),
                        } as CSSProperties
                      }
                      dataSide={ranks[i]! % 2 ? 'up' : 'down'}
                      value={s.dpi}
                      min={rng.min}
                      max={rng.max}
                      step={rng.step}
                      ariaLabel={t('dpi.editValue', { n: ranks[i]! })}
                      render={() => ranks[i]}
                      onCommit={(dpi) => patch(i, { dpi })}
                      onDragStart={() => {
                        numberDragging.current = true;
                        activate(i);
                        setDraggingIndex(i);
                      }}
                      onDragMove={(clientX) => patch(i, { dpi: dpiFromClientX(clientX) }, true)}
                      onDragEnd={() => {
                        numberDragging.current = false;
                        deactivate(i);
                        setDraggingIndex(null);
                        flush();
                      }}
                    />
                  ) : null,
                )}
              </div>
            </div>
            <span className="dpi-track-end mono">{win.max}</span>
            <Tooltip text={stages.length >= MAX_STAGES ? t('dpi.maxStages') : t('dpi.add')}>
              <button
                className="btn icon-only dpi-add"
                disabled={stages.length >= MAX_STAGES}
                onClick={addStage}
                aria-label={t('dpi.add')}
              >
                <Icon name="plus" size={12} />
              </button>
            </Tooltip>
          </div>

          <div className="dpi-stage-list">
            {stages
              .map((s, i) => ({ s, i }))
              .sort((a, b) => ranks[a.i]! - ranks[b.i]!)
              .map(({ s, i }) => (
                <Row
                  key={i}
                  className={active === i ? 'dpi-row-active' : undefined}
                  selected={selected === i}
                  onClick={(e) => {
                    // Let the toggle, number field, colour swatch and remove
                    // button keep their own click behaviour — only a click
                    // on the row's own surface applies this stage.
                    if ((e.target as HTMLElement).closest('input,button,select,label')) return;
                    applyStage(i);
                  }}
                  label={
                    <Tooltip text={t('dpi.active')}>
                      <span className="dpi-stage-pick mono">
                        <span
                          className={`dpi-stage-pick-dot ${selected === i ? 'is-selected' : ''}`}
                          aria-hidden="true"
                        />
                        {ranks[i]}
                      </span>
                    </Tooltip>
                  }
                >
                  <input
                    type="number"
                    className="mono"
                    style={{ width: 90 }}
                    min={rng.min}
                    max={rng.max}
                    step={rng.step}
                    value={s.dpi}
                    onChange={(e) => {
                      const n = Number(e.target.value);
                      if (Number.isFinite(n)) patchLocal(i, { dpi: n });
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                    }}
                    onBlur={() => {
                      // Snap into [min,max] on the step grid and write once —
                      // the field never writes a raw keystroke to the device,
                      // so this is where the edit actually reaches hardware.
                      patch(i, { dpi: snapDpi(s.dpi, rng) });
                    }}
                  />
                  <span style={{ color: 'var(--text-mut)', fontSize: 12 }}>DPI</span>
                  <Tooltip text={t('common.colour')}>
                    <ColorPickerField
                      value={rgbToHex(s.color)}
                      onChange={(hex) => patch(i, { color: hexToRgb(hex) })}
                    />
                  </Tooltip>
                  {/* Removing is the only way to change how many stages the
                      mouse cycles — the wire has no per-stage disable, so the
                      row's old enable toggle could only ever pretend. Disabled
                      rather than hidden at MIN_STAGES, mirroring how the add
                      button handles MAX_STAGES above. */}
                  <Tooltip
                    text={stages.length <= MIN_STAGES ? t('dpi.minStages') : t('dpi.remove')}
                  >
                    <button
                      className="btn icon-only"
                      disabled={stages.length <= MIN_STAGES}
                      onClick={() => removeStage(i)}
                      aria-label={t('dpi.remove')}
                    >
                      <Icon name="close" size={12} />
                    </button>
                  </Tooltip>
                </Row>
              ))}
          </div>
        </>
      )}
    </Panel>
  );
}
