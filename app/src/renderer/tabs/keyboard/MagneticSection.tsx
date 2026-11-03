import type { ReactNode } from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { KeyGroup, MagneticKeySettings } from '@shared/types/keyboard-settings';
import type { KeyLayoutEntry } from '@shared/types/keys';
import { ConfirmDialog, Panel, Row, Segmented, Tooltip } from '../../components/common';
import { RapidTriggerMedia, GlobalActuationMedia } from '../../components/tooltipMedia';
import { KeyboardMap, type KeyGauge, type KeyRef } from '../../components/KeyboardMap';
import { ArtAnchor } from '../../components/ArtAnchor';
import { Icon } from '../../components/icons';
import { useAnchoredPosition } from '../../components/usePortalPosition';
import {
  type TabProps,
  sd,
  useWrite,
  useAutoWrite,
  useDeviceBusy,
  useDeviceTabOnScreen,
  useIsDev,
  Loading,
} from '../common';
import { setKeyCaptureActive } from '../../state/shortcuts';
import { DevNote } from '../common';
import { InfoLabel } from '../../components/InfoLabel';
import { useStore } from '../../state/store';
import { SwitchTravelStage } from './SwitchTravelStage';
import { rtInitial, rtStep, rtThresholds, type RtState } from './rapidTrigger';
import { slotOf } from '../../keyLayout';
import { distinctValues, isFactoryDefault, mixedFields } from './magneticSelection';
import { KeyGroupsPanel } from './KeyGroupsPanel';
import { KeyCap } from './remapKeyFace';
import { ActuationLayoutsSection } from './ActuationLayoutsSection';
import {
  DksPanel,
  ModTapPanel,
  ModeRow,
  SnapTapPanel,
  TogglePanel,
  type ModeContext,
} from './KeyModePanels';
import {
  choiceOf,
  isHalfPair,
  pairNumbers,
  planCopy,
  planModeChange,
  planPair,
  planReset,
  toggleMode,
  toggleStyleOf,
  type ModeChoice,
  type Plan,
} from './magneticModes';
import {
  groupBySlot,
  isBaseGroup,
  railWidthFor,
  reconcileGroups,
  sameGroups,
  useKeyGroups,
  validateGroupName,
  withBaseName,
} from './useKeyGroups';
import { useT } from '../../state/i18n';
import { KB_TRAVEL_RANGE } from '@shared/keyboard-travel';
import type { LightingSettings } from '@shared/types/lighting';

/**
 * The factory values every "Restore to default" writes.
 *
 * Every number comes from KB_TRAVEL_RANGE rather than being typed here, so the
 * defaults, the slider bounds and the read fallbacks cannot drift apart again —
 * they did, and the result was a panel offering 0.01-2.5 mm rapid trigger with
 * a 1.5 mm default (all three the *actuation* point's numbers) and a 0 mm top
 * dead zone the firmware cannot even store.
 */
const T = KB_TRAVEL_RANGE;
const DEFAULT_KEY = (row: number, col: number): MagneticKeySettings => ({
  row,
  col,
  actuationMm: T.travel.default,
  releaseMm: T.travel.default,
  rapidTrigger: false,
  rtPressMm: T.rt.default,
  rtReleaseMm: T.rt.default,
  deadZoneMm: T.deadzone.default,
  deadZoneBottomMm: T.deadzone.default,
  mode: 'normal',
});

const keyId = (k: KeyRef) => `${k.row}:${k.col}`;

/**
 * Clicking away from the board clears the key selection — and this is what
 * "away" means.
 *
 * A CONTROL, not a container. It used to name whole regions (`.kbmap`, and a
 * `.keeps-selection` marker on the toolbar row, the group rail and the entire
 * settings column), which meant most of the tab was un-clickable as far as
 * dropping a selection went: the empty half of the board, the gap between the
 * toolbar buttons, the status line reading "1 key selected", and everything
 * under the last group in the rail all silently kept it. The only reliable way
 * to deselect was to find a scrap of page that belonged to nothing.
 *
 * So: a click keeps the selection when it lands on something that ACTS on the
 * selection — a key, or any control — and clears it anywhere else. Every
 * control in those panels is a native `button`/`input`/`select` or carries
 * `role="button"` (the group rows), so this needs no per-component marking.
 *
 * One region is the exception, by request: `.act-cols`, the Key panel and the
 * saved layouts under the board. Everything in it is about the selected keys —
 * the panel edits them, a layout is saved from them — so a click on its empty
 * space or a heading is someone working with the selection, not leaving it.
 * The board itself, the toolbar and the rail still follow the rule above, so
 * there is plenty of tab left to click to deselect.
 *
 * The other entries that are not controls are here for their own reasons:
 *  - `.kbkey` is the selection gesture itself.
 *  - `.editable-number-popover`, `[role="dialog"]` (the key chooser) and
 *    `[role="listbox"]` (the Mode list) are portalled to `document.body`, so
 *    they are "outside" this tab by construction. Clicking the spinner arrows
 *    on an actuation value used to clear the selection the value belonged to,
 *    leaving the edit nothing to apply to.
 *  - `.keeps-selection` stays as an escape hatch for a non-native surface that
 *    still needs it (the group colour popover). It goes on the control, never
 *    on a panel.
 */
const KEEPS_SELECTION =
  '.kbkey, button, [role="button"], input, select, textarea, label, a[href], [contenteditable="true"], .keeps-selection, .editable-number-popover, [role="dialog"], [role="listbox"], .act-cols';

/** The rail's own font size, from `.kg-rail .kg-row` in per-key-lighting.css.
 *  Only the size is pinned here; the family comes from the document, so a
 *  theme change cannot make the measurement disagree with what is drawn. */
const RAIL_FONT_PX = 12;

/**
 * Width of a group name as the rail will actually draw it.
 *
 * One canvas, reused: this runs for every group whenever the list changes, and
 * a DOM-based measurement would mean a layout per name. Falls back to a
 * deliberate over-estimate where there is no canvas (jsdom), since too wide is
 * a slightly fat rail and too narrow is a name you cannot read.
 */
const measureRailText = (() => {
  let ctx: CanvasRenderingContext2D | null | undefined;
  return (text: string): number => {
    if (ctx === undefined) ctx = document.createElement('canvas').getContext('2d');
    if (!ctx) return text.length * 9;
    ctx.font = `${RAIL_FONT_PX}px ${getComputedStyle(document.body).fontFamily || 'sans-serif'}`;
    return ctx.measureText(text).width;
  };
})();

/** How long the settings must sit still before the groups are re-derived. */
const GROUP_SETTLE_MS = 200;

/**
 * The board-wide trigger-response switches and Hall calibration, as a popover
 * off the per-key toolbar rather than the full-width panel this used to be
 * above the board. Both are reached maybe once per set-up; the keyboard viewer
 * is what the tab is for, and a card that size pushed it below the fold.
 *
 * Setting every key's actuation and resetting every key are not in here any
 * more: both are things you do TO the keys, so they live with the keys — a
 * selection plus the Key panel, and "Reset all" beside the board's legend.
 *
 * Portaled to `document.body` at `position: fixed` (see usePortalPosition.ts)
 * for the same reason `LanguageMenu` and `ColorPicker` are — an in-flow panel
 * would be clipped by `.tabpane-in`, the pane's actual scrollport.
 */
function AllKeysMenu({
  disabled,
  onCalibrate,
  extra,
}: {
  disabled?: boolean;
  onCalibrate: () => void;
  /** Board-wide settings that belong in this menu but are owned elsewhere —
   *  the trigger-response switches. */
  extra?: ReactNode;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);
  // The panel lives outside `btnRef`'s subtree, so outside-click detection has
  // to check both — checking only the button treats every click inside the
  // panel as "outside" and closes it before the control registers.
  const panelRef = useRef<HTMLDivElement>(null);
  const pos = useAnchoredPosition(btnRef, panelRef, open, { align: 'start', placement: 'bottom' });

  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      const target = e.target as Node;
      if (btnRef.current?.contains(target) || panelRef.current?.contains(target)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', onDocClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDocClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div className="allkeys-menu">
      <Tooltip text={t('act.allKeys.tip')}>
        <button
          ref={btnRef}
          className={`btn ${open ? 'primary' : ''}`}
          aria-haspopup="dialog"
          aria-expanded={open}
          disabled={disabled}
          onClick={() => setOpen((v) => !v)}
        >
          {t('act.allKeys')}
          <Icon name="arrowDown" size={12} />
        </button>
      </Tooltip>
      {open &&
        createPortal(
          <div
            ref={panelRef}
            className="allkeys-panel"
            role="dialog"
            aria-label={t('act.allKeys.aria')}
            style={
              pos
                ? { left: pos.left, top: pos.top, maxHeight: pos.maxHeight }
                : { left: -9999, top: -9999 }
            }
          >
            {extra && (
              <>
                <div className="allkeys-section">{extra}</div>
                <div className="allkeys-sep" />
              </>
            )}
            <div className="allkeys-section allkeys-inline">
              <InfoLabel
                label={t('act.cal.recalibrate')}
                text={t('act.cal.recalibrate.tip')}
                media={<GlobalActuationMedia />}
              />
              <div className="allkeys-controls">
                <button
                  className="btn"
                  onClick={() => {
                    // Closes the panel first. It is a body-level portal at
                    // z-index 200, so left open it would sit on top of the
                    // calibration overlay this opens — and its own
                    // outside-click handler could not dismiss it either, since
                    // a click inside a modal stops propagating before it ever
                    // reaches `document`.
                    setOpen(false);
                    onCalibrate();
                  }}
                >
                  {t('act.cal.start')}
                </button>
              </div>
            </div>
          </div>,
          document.body,
        )}
    </div>
  );
}

/**
 * The two per-key markers on the board, as literal colours.
 *
 * Palette-independent for the same reason the keycap and group colours are:
 * `--violet` is #ffd76a under grey-brown and `--amber` is #ffb454, so "rapid
 * trigger" and "advanced mode" were the same yellow dot on the palette this is
 * actually used with. The shapes differ too — a round dot and a square — so
 * the distinction survives being small.
 */
const MARK_RT = '#8b7dff';
const MARK_MODE = '#ffb454';

/** Depth at which a key counts as "pressed to the bottom" during calibration. */
const BOTTOMED_MM = 3.2;

/**
 * Consecutive samples a key must be missing from before it is drawn as
 * released.
 *
 * The wire says "released" by omitting the key, so a single dropped sample is
 * indistinguishable from a real release — which is why a key that was still
 * being held would flick back to 0. Two frames of grace costs at most one
 * sample of latency on a genuine release.
 */
const LIVE_RELEASE_FRAMES = 2;

/** Depth (mm) a key has to pass before it counts as "the key being pressed" —
 *  what the stage falls back to showing when nothing is selected. Well clear
 *  of TRAVEL_REST_MM (0.05, the driver's own noise floor) so a resting hand
 *  cannot keep stealing the view. */
const LIVE_PICK_MM = 0.4;

/** A key's printed name, or its matrix position when the layout has no entry. */
const labelOf = (layout: KeyLayoutEntry[] | undefined, k: KeyRef): string =>
  layout?.find((e) => e.row === k.row && e.col === k.col)?.label ?? `R${k.row} C${k.col}`;

/**
 * Sample cadence while the calibration overlay is open.
 *
 * Calibration holds the stream for as long as it takes to press every key on
 * the board; the default cadence sustained over minutes is what wedges the
 * MI_02 endpoint. The manager clamps this to its own floor, so asking for a
 * slower rate is always safe.
 */
const CALIBRATION_POLL_MS = 400;

/**
 * How often the guidance lighting may be repainted during calibration.
 *
 * Each repaint is 7 chunked feature writes even on the streaming path, and it
 * runs alongside the travel stream on the same wedge-prone endpoint. Coalescing
 * to this interval keeps the board responsive; a key going dark a third of a
 * second after it is pressed still reads as immediate.
 */
const CALIBRATION_PAINT_MS = 350;

/** Guidance colours: white = still to do, off = done. */
const CALIB_TODO: [number, number, number] = [255, 255, 255];
const CALIB_DONE: [number, number, number] = [0, 0, 0];

/**
 * The rapid-trigger link control.
 *
 * The sliders themselves now live in `SwitchTravelStage` as vertical tracks,
 * beside actuation and the dead zones — they are travel settings and were the
 * only ones shaped differently. What is left here is the choice of ONE
 * sensitivity or two.
 *
 * One is the default: press and release sensitivity are the same kind of
 * quantity and almost always wanted equal, and two sliders that have to be kept
 * in step by hand is the sort of thing people get subtly wrong and then blame
 * the board for. Unlinking keeps whatever values are already set; re-linking
 * adopts the press value for both, so the two can never be left disagreeing
 * behind a single slider.
 */
function RtLink({ split, onSplit }: { split: boolean; onSplit: (next: boolean) => void }) {
  const t = useT();
  return (
    <Row label={<InfoLabel label={t('act.rt.sensitivity')} text={t('act.rt.link.tip')} />}>
      <button className="btn" onClick={() => onSplit(!split)}>
        {split ? t('act.rt.link') : t('act.rt.split')}
      </button>
    </Row>
  );
}

/**
 * The guided switch-calibration pass.
 *
 * qmk.top has ONE calibration flow, not two modes: start it, press every key
 * to the bottom until it goes green, finish. This surfaced here as two peer
 * buttons ("Re-zero" and "Full travel"), which asked the user to choose between
 * two halves of a single procedure. Both wire commands are still sent —
 * `SET_MAGNETISM_CAL` (28) to begin and
 * `SET_MAGNETISM_MAXIMUM_CALIBRATION` (30) to finish — matching the order of the
 * vendor's 立即校准 -> 完成校准 pair. Both frames are
 * `provenance: ported-from-vendor` and CAPTURE-KEYBOARD.md step 10 still wants
 * the payload confirmed, so that ordering is a documented hypothesis.
 *
 * **Keystrokes are swallowed while it runs.** Calibrating means pressing every
 * key on the board, which otherwise fires whatever those keys are bound to —
 * Alt+F4, Ctrl+W, the app's own tab chords. This does what the macro recorder
 * does: `setKeyCaptureActive(true)` to silence the app's own shortcuts, plus a
 * capture-phase listener that `preventDefault()`s every key event.
 *
 * That covers the app and, in a focused window, Alt+F4. It CANNOT stop the
 * Windows key, Alt+Tab or Ctrl+Alt+Del — those are reserved by the OS and would
 * need a native low-level keyboard hook, which this app does not have. The
 * overlay says so rather than implying total capture, naming the shortcuts the
 * OS it runs on keeps (`act.cal.suppressed.*`): ⌘Tab, ⌘Space and ⌘Q on macOS,
 * the Super key and Alt+Tab on a Linux desktop.
 */
function CalibrationOverlay({
  deviceId,
  layout,
  perKeyLighting,
  onClose,
}: {
  deviceId: string;
  layout?: KeyLayoutEntry[];
  /** Only paint guidance on a board that actually has per-key LEDs. */
  perKeyLighting: boolean;
  onClose: () => void;
}) {
  const t = useT();
  // Unknown until App's first IPC answer lands; Windows is the wording that
  // has always been shown, so it stays the fallback.
  const os = useStore((s) => s.platformInfo?.os);
  const { run } = useWrite();
  const [phase, setPhase] = useState<'starting' | 'pressing' | 'finishing'>('starting');
  const [failed, setFailed] = useState<string | null>(null);
  const [seen, setSeen] = useState<Set<number>>(new Set());
  const [streamOk, setStreamOk] = useState(false);
  /** The board's lighting before we took it over, to be put back on exit. */
  const priorLighting = useRef<LightingSettings | null>(null);
  /** Last painted set, so an unchanged `seen` never repaints. */
  const paintedRef = useRef<string>('');
  // `seen` mirrored into a ref so the painter below reads the current set
  // without its interval being torn down and rebuilt on every keypress.
  const seenRef = useRef(seen);
  seenRef.current = seen;

  // Swallow every key event for the duration, at the capture phase so nothing
  // downstream (including this app's own window-level handlers) sees it.
  useEffect(() => {
    setKeyCaptureActive(true);
    const swallow = (e: KeyboardEvent) => {
      // Escape is the one way out, so it must still reach us.
      if (e.key === 'Escape' && e.type === 'keydown') {
        e.preventDefault();
        onClose();
        return;
      }
      e.preventDefault();
      e.stopPropagation();
    };
    window.addEventListener('keydown', swallow, true);
    window.addEventListener('keyup', swallow, true);
    return () => {
      window.removeEventListener('keydown', swallow, true);
      window.removeEventListener('keyup', swallow, true);
      setKeyCaptureActive(false);
    };
  }, [onClose]);

  // Begin, then watch the travel stream so a key pressed to the bottom can be
  // marked. The board reports no per-key calibration signal we have captured,
  // so this is DERIVED from travel — hence the dev-only caveat below.
  useEffect(() => {
    let stopped = false;
    void (async () => {
      // The first write of a session goes through `guardedWrite` ->
      // `ensureBackup()`, which on this board is a ~70-chunk paged sweep. That
      // is several seconds during which the dialog would otherwise sit there
      // with both buttons dead and nothing said, so `starting` is a state the
      // UI names rather than a gap.
      const r = await run(t('act.cal.startLabel'), () =>
        sd.setMagneticCalibration(deviceId, 'zero'),
      );
      if (stopped) return;
      if (!r.ok) {
        setFailed(r.error ?? t('act.cal.startRefused'));
        return;
      }
      setPhase('pressing');
      const stream = await sd.startTravelStream(deviceId, CALIBRATION_POLL_MS);
      if (!stopped) setStreamOk(stream.ok);
    })();
    const off = sd.on('device:travel', (p) => {
      if (stopped || p.id !== deviceId) return;
      // The stream gave up (the board stopped answering): say progress can no
      // longer be shown, rather than freeze the count where it stopped.
      if (p.ended) {
        setStreamOk(false);
        return;
      }
      if (!p.keys) return;
      setSeen((prev) => {
        let next: Set<number> | null = null;
        for (const k of p.keys ?? []) {
          if (k.mm >= BOTTOMED_MM && !prev.has(k.slot)) (next ??= new Set(prev)).add(k.slot);
        }
        return next ?? prev;
      });
    });
    return () => {
      stopped = true;
      off();
      void sd.stopTravelStream(deviceId, CALIBRATION_POLL_MS);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deviceId]);

  /**
   * Light every key white, and extinguish each one as it is calibrated, so
   * "which keys still need pressing" is visible on the board itself rather
   * than only on the screen. The board's previous lighting is captured first
   * and restored on the way out, including the Escape and Cancel paths.
   *
   * Repaints are coalesced (CALIBRATION_PAINT_MS) and use the streaming
   * per-key path — no read-back, no effect re-assertion — because this runs
   * concurrently with the travel stream on an endpoint that wedges under
   * sustained traffic.
   */
  useEffect(() => {
    if (!perKeyLighting || !layout || phase === 'starting' || failed) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const paint = async () => {
      if (stopped) return;
      const key = [...seenRef.current].sort((a, b) => a - b).join(',');
      if (key === paintedRef.current) return;
      paintedRef.current = key;
      const colors = layout
        .map((k) => k.slot)
        .filter((slot): slot is number => slot !== undefined)
        .map((slot) => ({
          index: slot,
          color: seenRef.current.has(slot) ? CALIB_DONE : CALIB_TODO,
        }));
      await sd.setPerKeyLighting(deviceId, colors, { brightness: 100, streaming: true });
    };

    void (async () => {
      // Capture what to put back, then take the board over. The FIRST paint is
      // a normal (non-streaming) write: it is what flips the board onto the
      // per-key layer, which every streaming repaint after it relies on.
      // Captured ONCE. If this effect ever re-ran, the board would already be
      // showing our white guidance, and re-reading would "restore" that.
      if (!priorLighting.current) {
        const before = await sd.readLighting(deviceId);
        if (stopped) return;
        priorLighting.current = before[0] ?? null;
      }
      const all = layout
        .map((k) => k.slot)
        .filter((slot): slot is number => slot !== undefined)
        .map((slot) => ({ index: slot, color: CALIB_TODO }));
      await sd.setPerKeyLighting(deviceId, all, { brightness: 100 });
      paintedRef.current = '';
      timer = setInterval(() => void paint(), CALIBRATION_PAINT_MS);
    })();

    return () => {
      stopped = true;
      if (timer) clearInterval(timer);
      const prior = priorLighting.current;
      // Put the board back. Deliberately not awaited — this runs from an
      // unmount, and the write outliving the component is the point.
      if (prior) void sd.setLighting(deviceId, prior);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deviceId, perKeyLighting, layout, phase === 'starting', failed]);

  const finish = async () => {
    setPhase('finishing');
    const r = await run(t('act.cal.finishLabel'), () => sd.setMagneticCalibration(deviceId, 'max'));
    // Falling back to `pressing` on failure matters more than it looks: Cancel
    // used to be disabled while finishing and Finish disabled unless pressing,
    // so a call that failed or never resolved left the dialog with no way out
    // but the Escape key.
    if (!r.ok) {
      setFailed(r.error ?? t('act.cal.finishRefused'));
      setPhase('pressing');
      return;
    }
    onClose();
  };

  const total = layout?.length ?? 0;
  // One sentence with its emphasis as a placeholder, so a translation can put
  // "every key" wherever its grammar wants it.
  const [pressBefore, pressAfter = ''] = t('act.cal.press').split('{every}');
  return createPortal(
    <div className="modal-scrim" role="dialog" aria-modal="true" aria-label={t('act.cal.aria')}>
      <div className="calib-panel">
        <h3>{t('act.cal.title')}</h3>
        {phase === 'starting' && !failed && <p className="hint">{t('act.cal.preparing')}</p>}
        <p className="hint">
          {pressBefore}
          <strong>{t('act.cal.press.every')}</strong>
          {pressAfter}
        </p>
        <p className="hint">
          {t(
            os === 'darwin'
              ? 'act.cal.suppressed.mac'
              : os === 'linux'
                ? 'act.cal.suppressed.linux'
                : 'act.cal.suppressed.win',
          )}
        </p>
        {layout && (
          <div className="calib-board">
            <KeyboardMap
              layout={layout}
              interactive={false}
              accent={(k) => (seen.has(k.slot ?? -1) ? 'var(--green, #49e08b)' : undefined)}
            />
          </div>
        )}
        <p className="hint">
          {streamOk ? t('act.cal.seen', { n: seen.size, total }) : t('act.cal.noStream')}
        </p>
        {streamOk && <DevNote>{t('act.cal.inferred')}</DevNote>}
        {failed && (
          <p className="hint" style={{ color: 'var(--red)' }}>
            {t('act.cal.failed', { error: failed })}
          </p>
        )}
        <div className="calib-actions">
          {/* Never disabled. Whatever else is stuck, closing must work. */}
          <button className="btn" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button
            className="btn primary"
            onClick={finish}
            disabled={phase !== 'pressing' || !!failed}
          >
            {phase === 'finishing' ? t('act.cal.finishing') : t('act.cal.finish')}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
export function MagneticSection({ device, aside }: TabProps & { aside?: ReactNode }) {
  const t = useT();
  const toast = useStore((st) => st.toast);
  const layout = device.ui.keyMatrix?.layout;

  const { queue, commit, flush } = useAutoWrite(250, { deviceId: device.id });
  const { busy, whileBusy } = useDeviceBusy(device.id);
  const onScreen = useDeviceTabOnScreen(device.id);

  const [byKey, setByKey] = useState<Record<string, MagneticKeySettings>>({});
  // Multi-key selection — a Set of "row:col" ids rather than a single KeyRef,
  // so many keys can be selected and edited together (the user's explicit
  // ask: a Select-all button, edits applying across the whole selection).
  const [sel, setSel] = useState<Set<string>>(new Set());
  const boardRef = useRef<HTMLDivElement>(null);

  // live per-key travel — consumes the driver's own slot-indexed, mm-scaled
  // decode (device:travel's `keys`) instead of hand-parsing raw bytes here.
  // The driver now reads magnetism page 254 (a verified-capture frame) rather
  // than an uncaptured input-report stream, but what that page contains while
  // a key is held has still never been observed — the badge below says so.
  //
  // `live` is DERIVED, not stored: selecting a key is itself a request to see
  // that key's live position (there is nothing else the visualiser can show
  // about "now"), so a selection arms the stream on its own — and so does Test
  // keys (`testing`), which also keeps your key presses out of the app.
  //
  // The other two latches exist because a derived value can't be switched off
  // by the thing that reads it:
  //   `liveFailed` — `startTravelStream` rejects on any non-HE device
  //     ('Live travel not supported by this device', drivers/base.ts). Without
  //     the latch, arming-on-selection would retry that on every click.
  //   `blurred` — the old handler called setLive(false) on window blur; against
  //     a derived value that does nothing, so park the state instead and let
  //     focus re-arm it if a key is still selected.
  //   `liveLost` — the stream ended under us (the board stopped answering, or
  //     refused to start) rather than never existing. Parked like `blurred`,
  //     not latched like `liveFailed`: the next key click, the Test keys
  //     button or the window regaining focus tries again. Retrying on its own
  //     would just repeat a failing read against a wedge-prone endpoint.
  /**
   * Test keys: press keys on the keyboard and watch them, with nothing
   * reaching the app.
   *
   * Pressing keys to watch them is what this tab is for, and a key under test
   * still does its normal job: Tab moves focus, Enter presses whatever is
   * focused, the arrows scroll. Those presses used to be swallowed whenever a
   * key was SELECTED — an invisible mode that also took Tab and Enter from
   * anyone working the app from the keyboard (Escape was the only way out,
   * and nothing said so). Now it is a button you turn on, a line that says it
   * is on, and Escape or the button to turn it off. A selection still shows
   * its key live; it just no longer holds the keyboard.
   */
  const [testing, setTesting] = useState(false);
  const [liveFailed, setLiveFailed] = useState(false);
  const [liveLost, setLiveLost] = useState(false);
  const [blurred, setBlurred] = useState(false);
  const [liveBySlot, setLiveBySlot] = useState<Record<number, number>>({});
  /** The last slot seen being pressed. With nothing selected the stage shows
   *  this key instead of a resting switch and an empty panel — "what is the
   *  key I just pressed set to?" is the question the tab exists to answer, and
   *  it took a click on the right cap to ask it. */
  const [lastActiveSlot, setLastActiveSlot] = useState<number | null>(null);
  /** Consecutive samples a slot has been missing from — see LIVE_RELEASE_FRAMES. */
  const absentRef = useRef(new Map<number, number>());
  // Rapid-trigger state for the key currently being inspected. Kept in a ref
  // and mirrored into state only when the drawn thresholds actually move, so a
  // 100+ Hz travel stream does not re-render the whole tab per sample.
  const rtRef = useRef<RtState>(rtInitial());
  const [rtAt, setRtAt] = useState<{ pressAt: number | null; releaseAt: number | null }>({
    pressAt: null,
    releaseAt: null,
  });
  const [liveFrames, setLiveFrames] = useState({ received: 0, decoded: 0 });

  // Until this read lands, every key's settings fall back to DEFAULT_KEY —
  // plausible-looking numbers that are NOT what the board holds. Showing them
  // unlabelled reads as real device state, so the board is gated on the read
  // instead (the reported "no indication anything is loading").
  const [loading, setLoading] = useState(true);
  /**
   * Whether the board has EVER been read in this pane. `loading` ends on a
   * failed read too, and a failed read leaves every key on DEFAULT_KEY — which
   * the group reconcile below took for a board with one setting everywhere,
   * collapsing the rail to a single group and throwing every name away.
   */
  const [readOk, setReadOk] = useState(false);

  const byKeyRef = useRef(byKey);
  byKeyRef.current = byKey;

  /**
   * Read the board's per-key settings.
   *
   * Also called after a bulk write, rather than trusting the list we sent: a
   * 79-key write is hundreds of frames on a firmware that can stall mid-burst,
   * and the panel showing the values it MEANT to write while the board holds a
   * mixture of old and new is worse than slow — it is the app reporting a
   * success it has not checked. (Reported as "restore finished and every key
   * had different settings", which is what a half-landed batch looks like.)
   */
  const reloadKeys = useCallback(async () => {
    try {
      const list = await sd.readMagnetic(device.id);
      // An empty list is "I could not read the board", not "the board is
      // empty" — the driver returns it when the pages that define a key did
      // not answer. Taking it literally wiped `byKey`, every key fell back to
      // DEFAULT_KEY in the group reconcile below, and the rail collapsed to a
      // single group: the reported "reset one key and the whole board turns
      // one colour, until I press Read from keyboard".
      if (!list.length) return;
      const map: Record<string, MagneticKeySettings> = {};
      for (const k of list) map[`${k.row}:${k.col}`] = k;
      byKeyRef.current = map;
      setByKey(map);
      setReadOk(true);
    } catch {
      /* leave the last known state up rather than blanking the board */
    }
  }, [device.id]);

  /**
   * The opening read, behind the same block a write puts up.
   *
   * A multi-page sweep takes seconds, and until it lands the board shows
   * fall-back defaults under whatever profile name is in the title bar — which,
   * after a profile switch, reads as "this profile happens to be set up exactly
   * like the last one". Worse, it was all still clickable: a key selected and
   * edited in that window is edited against settings the app has not got yet.
   * `whileBusy` is what "Reset all" already uses; a read that the UI
   * must not be used during is the same situation.
   */
  useEffect(() => {
    let stale = false;
    setLoading(true);
    void whileBusy(t('busy.readingKeyboard'), () => sd.readMagnetic(device.id))
      .then((list) => {
        // Same reason as reloadKeys: an empty read is a failure, and the
        // fall-back defaults already on screen are a better answer than a
        // board asserted to be uniformly default.
        if (stale || !list.length) return;
        const map: Record<string, MagneticKeySettings> = {};
        for (const k of list) map[`${k.row}:${k.col}`] = k;
        setByKey(map);
        setReadOk(true);
      })
      .catch(() => undefined)
      .finally(() => {
        if (!stale) setLoading(false);
      });
    return () => {
      stale = true;
    };
    // `t` is left out on purpose: a language change must not re-read the board.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [device.id, whileBusy]);

  /**
   * The travel stream is on whenever a key is selected, and while testing.
   *
   * Selecting a key IS a request to watch it — the switch diagram's whole job
   * is to show where that key is right now. Test keys asks for the whole
   * board, with nothing selected.
   *
   * `liveFailed` and `blurred` still win: a device with no stream must not be
   * asked twice, and a backgrounded window has no reason to keep polling.
   */
  const live = !liveFailed && !liveLost && !blurred && (sel.size > 0 || testing);
  /** Every key's live depth on its gauge — whenever the stream runs. */
  const boardTint = live;

  useEffect(() => {
    if (!live) return;
    let stopped = false;
    setLiveFrames({ received: 0, decoded: 0 });
    sd.startTravelStream(device.id).then((r) => {
      if (r.ok) return;
      if (r.unsupported) setLiveFailed(true);
      else if (!stopped) setLiveLost(true);
    });
    const off = sd.on('device:travel', (p) => {
      if (stopped || p.id !== device.id) return;
      if (p.ended) {
        setLiveLost(true);
        return;
      }
      setLiveFrames((f) => ({
        received: f.received + 1,
        decoded: f.decoded + (p.keys?.length ? 1 : 0),
      }));
      // An incomplete sample is one the driver discarded or could not read.
      // Since a released key is expressed by ABSENCE from `keys`, treating it
      // as data reads as "the whole board just came up" — which is the
      // "key I am still holding jumps to 0" report. Drop it instead.
      if (!p.keys || p.complete === false) return;
      const seen = new Map<number, number>();
      for (const k of p.keys) seen.set(k.slot, k.mm);
      // Deepest key in this sample wins, so rolling a hand across the board
      // follows the key actually being pressed rather than whichever the
      // driver happened to list first.
      let deepest: { slot: number; mm: number } | null = null;
      for (const k of p.keys) {
        if (k.mm >= LIVE_PICK_MM && (!deepest || k.mm > deepest.mm)) deepest = k;
      }
      if (deepest) setLastActiveSlot(deepest.slot);
      setLiveBySlot((prev) => {
        const next: Record<number, number> = {};
        for (const [slot, mm] of seen) {
          next[slot] = mm;
          absentRef.current.delete(slot);
        }
        // A key that vanishes for a single frame is far more likely to be a
        // dropped sample than a real release, so hold its last depth for a
        // couple of frames before letting it fall back to rest.
        for (const key of Object.keys(prev)) {
          const slot = Number(key);
          if (seen.has(slot)) continue;
          const misses = (absentRef.current.get(slot) ?? 0) + 1;
          if (misses < LIVE_RELEASE_FRAMES) {
            absentRef.current.set(slot, misses);
            next[slot] = prev[slot]!;
          } else {
            absentRef.current.delete(slot);
          }
        }
        return next;
      });
    });
    return () => {
      stopped = true;
      off();
      sd.stopTravelStream(device.id);
      absentRef.current.clear();
      setLiveBySlot({});
    };
  }, [live, device.id]);

  // Also stop the (potentially endpoint-wedging) live stream when the app
  // loses focus, not just on unmount — a tab left open in the background
  // has no reason to keep polling. Regaining focus re-arms it if a key is
  // still selected, so coming back to the window doesn't leave the visualiser
  // silently dead with a key highlighted.
  useEffect(() => {
    const onBlur = () => setBlurred(true);
    const onFocus = () => {
      setBlurred(false);
      setLiveLost(false);
    };
    window.addEventListener('blur', onBlur);
    window.addEventListener('focus', onFocus);
    return () => {
      window.removeEventListener('blur', onBlur);
      window.removeEventListener('focus', onFocus);
    };
  }, []);

  // Advance the rapid-trigger model on each live sample for the inspected key.
  // `rtThresholds` is what the diagram draws: the thresholds chase the key's
  // deepest / shallowest point, which is the whole behaviour the old
  // "actuation ± sensitivity" markers failed to show.
  useEffect(() => {
    if (!live || !stageRefRef.current || !stageKeyRef.current?.rapidTrigger) {
      rtRef.current = rtInitial();
      setRtAt((prev) =>
        prev.pressAt === null && prev.releaseAt === null
          ? prev
          : { pressAt: null, releaseAt: null },
      );
      return;
    }
    const cfg = {
      actuationMm: stageKeyRef.current.actuationMm,
      pressMm: stageKeyRef.current.rtPressMm ?? T.rt.default,
      releaseMm: stageKeyRef.current.rtReleaseMm ?? T.rt.default,
    };
    const slot = layout ? slotOf(layout, stageRefRef.current) : null;
    // A key absent from the sample is at REST, not unknown. Early-returning
    // here left `rtRef` holding the deepest point of the last press forever,
    // so the diagram kept drawing thresholds from a key that had long since
    // come back up.
    const mm = (slot !== null ? liveBySlot[slot] : undefined) ?? 0;
    rtRef.current = rtStep(rtRef.current, mm, cfg);
    const next = rtThresholds(rtRef.current, cfg);
    setRtAt((prev) =>
      prev.pressAt === next.pressAt && prev.releaseAt === next.releaseAt ? prev : next,
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [liveBySlot, live, layout]);

  const selectedRefs = useMemo(() => {
    if (!layout) return [] as KeyRef[];
    return layout.filter((k) => sel.has(keyId(k))).map((k) => ({ row: k.row, col: k.col }));
  }, [layout, sel]);

  // The panel edits the FIRST selected key's current values and applies the
  // same patch to every selected key. Where the selection does NOT agree on a
  // setting, the control shows no value at all (see `mixed` below) rather than
  // the anchor's — otherwise a bulk edit silently presented one key's numbers
  // as the group's and flattened the rest on the next touch.
  const anchorKey = selectedRefs[0] ?? null;
  // Read by the rapid-trigger effect, which runs on every travel sample and
  // must not re-subscribe per render. Both are filled in below, once the stage
  // key is known (it is the selection anchor, or the live preview key).
  const stageRefRef = useRef<KeyRef | null>(null);
  const stageKeyRef = useRef<MagneticKeySettings | null>(null);
  const key = useMemo<MagneticKeySettings | null>(() => {
    if (!anchorKey) return null;
    return byKey[keyId(anchorKey)] ?? DEFAULT_KEY(anchorKey.row, anchorKey.col);
  }, [anchorKey, byKey]);

  /**
   * With nothing selected, follow the key being pressed.
   *
   * The panel stays inert either way — this is a readout, not an edit target,
   * and a keystroke must never become an edit. It only has something to show
   * while the travel stream is running, which with an empty selection means
   * the Live monitor has been switched on deliberately: the stream is a poll
   * the vendor's own tool warns costs key response, so it is not armed just
   * because this tab is open.
   */
  const previewRef = useMemo<KeyRef | null>(() => {
    if (anchorKey || !layout || lastActiveSlot === null) return null;
    const entry = layout.find((k) => k.slot === lastActiveSlot);
    return entry ? { row: entry.row, col: entry.col } : null;
  }, [anchorKey, layout, lastActiveSlot]);

  /**
   * The key the stage draws.
   *
   * With several keys selected it follows whichever of THEM was pressed last,
   * not the one that happens to be first in the selection. Pressing a key to
   * see its stroke is the natural way to ask "and what about this one", and a
   * stage pinned to the anchor answered about a different key every time.
   * Falls back to the anchor (nothing pressed yet), then to the live preview
   * (nothing selected at all).
   *
   * The EDIT anchor is deliberately still `anchorKey`: which key the panel
   * reads its values from must not change under the user's hands mid-edit, and
   * where the selection disagrees the controls show nothing either way (see
   * `mixed`).
   */
  const stageRef = useMemo<KeyRef | null>(() => {
    if (selectedRefs.length > 1 && layout && lastActiveSlot !== null) {
      const entry = layout.find((k) => k.slot === lastActiveSlot);
      if (entry && sel.has(keyId(entry))) return { row: entry.row, col: entry.col };
    }
    return anchorKey ?? previewRef;
  }, [selectedRefs, layout, lastActiveSlot, sel, anchorKey, previewRef]);

  const stageKey = useMemo<MagneticKeySettings | null>(() => {
    if (!stageRef) return null;
    return byKey[keyId(stageRef)] ?? DEFAULT_KEY(stageRef.row, stageRef.col);
  }, [stageRef, byKey]);

  /**
   * Which settings the current selection disagrees on.
   *
   * Only meaningful for more than one key: with a single key selected nothing
   * is ever mixed, and with none there is nothing to compare.
   */
  const selectedSettings = useMemo(
    () => selectedRefs.map((r) => byKey[keyId(r)] ?? DEFAULT_KEY(r.row, r.col)),
    [selectedRefs, byKey],
  );
  const mixed = useMemo(() => mixedFields(selectedSettings), [selectedSettings]);
  /** Nothing for "Reset all" to do. */
  const allDefault = useMemo(
    () =>
      !layout ||
      layout.every((k) => isFactoryDefault(byKey[keyId(k)] ?? DEFAULT_KEY(k.row, k.col))),
    [layout, byKey],
  );
  /** Not just "do these differ" but WHICH values they hold — the stage draws a
   *  handle per value, because one handle at the first key's depth beside a
   *  blanked number claims the whole selection is set to that depth. */
  const distinct = useMemo(() => distinctValues(selectedSettings), [selectedSettings]);

  /**
   * Press/release and the two rapid-trigger sensitivities: **linked unless
   * the user unlinks them, per key.**
   *
   * These used to be three-state, DERIVING the answer by comparing the two
   * values read off the board. Two things were wrong with that.
   *
   * The vendor tool this tab is meant to agree with offers one actuation
   * control and one RT sensitivity, so the derived state disagreed with it on
   * any board whose two pages happen to differ — and a factory R85HE's do:
   * the captured snapshot in docs/reverse-engineering decodes untouched keys
   * as 2.0 mm press against 2.8 mm release, which "derive" must call
   * separate.
   *
   * And the override was never reset — not on selection change, not when a
   * read landed — so one click of "Set actuation & release separately" on any
   * key made every key
   * selected afterwards render as separate for the rest of the mount. That
   * was self-confirming: while split, a slider drag writes only one of the
   * pair (see `onRtPressChange` below), so the device genuinely diverged and
   * the next read legitimately reported "separate".
   */
  const [splitRelease, setSplitRelease] = useState(false);
  const [rtSplit, setRtSplit] = useState(false);
  const [calibrating, setCalibrating] = useState(false);
  const [confirmRestore, setConfirmRestore] = useState(false);
  /** Snap-tap, Mod-tap or DKS chosen in the Mode list but not applied: each
   *  needs something more before the key's mode can change — a partner, a
   *  hold key, actions — so nothing is written until its panel has it. */
  const [draftMode, setDraftMode] = useState<'snap' | 'mt' | 'dks' | null>(null);
  // It belongs to the key it was started on; selecting another drops it.
  useEffect(() => {
    setDraftMode(null);
  }, [sel]);
  const isDev = useIsDev();

  /**
   * While testing, swallow key events (see `testing`).
   *
   * The key under test still does its normal job otherwise, so testing Tab
   * would move focus through the UI, Enter press whatever is focused, and the
   * arrows scroll. Suppressed at the capture phase, plus
   * `setKeyCaptureActive` so the app's own Ctrl+W / Ctrl+Tab chords stay quiet
   * too (the same mechanism the macro recorder and calibration use).
   *
   * Text fields are excluded, or the click-to-type value boxes on this very
   * tab would stop accepting digits. So is every other tab: the selection
   * survives switching away (the tab stays mounted, hidden), but the capture
   * must not — it is let go while this tab is off screen and taken back when
   * it returns.
   *
   * The Windows key, Alt+Tab and Ctrl+Alt+Del are reserved by the OS and
   * cannot be intercepted from Electron without a native hook — see the note
   * in CalibrationOverlay.
   */
  useEffect(() => {
    if (!testing || !onScreen) return;
    setKeyCaptureActive(true);
    /** Keys that belong to a control, not to the keyboard under test: typing
     *  in a field, the Mode list's own arrows and Escape, anything in a dialog
     *  this tab opened (the key chooser). */
    const passesThrough = () => {
      const el = document.activeElement as HTMLElement | null;
      if (!el) return false;
      const tag = el.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || el.isContentEditable) return true;
      return el.getAttribute('role') === 'combobox' || !!el.closest('[role="dialog"]');
    };
    const swallow = (e: KeyboardEvent) => {
      if (passesThrough()) return;
      // Escape is the one key that means something to this tab rather than to
      // the keyboard under test, so it is read before the rest are dropped:
      // it stops testing.
      if (e.type === 'keydown' && e.key === 'Escape') setTesting(false);
      e.preventDefault();
      e.stopPropagation();
    };
    window.addEventListener('keydown', swallow, true);
    window.addEventListener('keyup', swallow, true);
    return () => {
      window.removeEventListener('keydown', swallow, true);
      window.removeEventListener('keyup', swallow, true);
      setKeyCaptureActive(false);
    };
  }, [testing, onScreen]);

  /**
   * Escape, when not testing: drop the selection — what the capture above
   * used to do for every selection. Bubble phase, so a dialog or menu that
   * handles Escape for itself (and stops it) closes without also clearing the
   * board.
   */
  useEffect(() => {
    if (testing || !onScreen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      const el = document.activeElement as HTMLElement | null;
      if (
        el?.closest(
          'input, textarea, select, [contenteditable="true"], [role="dialog"], [role="menu"], [role="listbox"]',
        )
      )
        return;
      setSel((prev) => (prev.size ? new Set<string>() : prev));
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [testing, onScreen]);
  stageRefRef.current = stageRef;
  stageKeyRef.current = stageKey;

  // Unlinking is a per-key decision, so selecting another key starts linked
  // again. Keyed on the anchor's id rather than on `key`, which is rebuilt on
  // every read and would reset the toggle under a drag.
  const anchorId = anchorKey ? keyId(anchorKey) : null;
  useEffect(() => {
    setSplitRelease(false);
    setRtSplit(false);
  }, [anchorId]);

  /**
   * The latest `byKey`, readable synchronously.
   *
   * `patch` used to build its next state from the `byKey` captured at render
   * time, so two patches fired from ONE event handler both started from the
   * same base and the second silently discarded the first. That is not
   * hypothetical: the linked rapid-trigger slider called
   * `onRtPressChange` then `onRtReleaseChange`, the second patch threw away
   * `rtPressMm` — which is the value the slider renders — and the handle
   * therefore snapped straight back on every drag, looking like a dead
   * control. Reading the base from a ref makes consecutive patches compose,
   * whatever the caller does.
   */
  /**
   * A write parked until the gesture that produced it ends.
   *
   * Dragging used to `queue` on every move — a 250 ms debounce, which on a
   * slow drag is not one write but a write every time the hand paused. Each is
   * a multi-page burst to a board that is still being aimed at, so the device
   * spent the whole gesture taking values nobody asked it to keep. The value
   * the user means is the one they let go on; that is the only one sent.
   */
  const heldRef = useRef<{
    label: string;
    list: MagneticKeySettings[];
    /** What the board held before this gesture started, per key id. */
    prev: Record<string, MagneticKeySettings>;
  } | null>(null);

  /**
   * Write some keys, telling the driver what they held before.
   *
   * `previous` is what lets it send only the pages that actually changed — the
   * difference between eight frames per key and one or two. Passed only when
   * every key has one: a partial list would have to be positional anyway, and a
   * missing entry is exactly the case (a key not yet read) where guessing
   * "unchanged" would drop a page the board never got.
   */
  const writeKeys = useCallback(
    (list: MagneticKeySettings[], prev?: Record<string, MagneticKeySettings>) => {
      const previous = prev ? list.map((k) => prev[keyId(k)]) : [];
      const known = previous.length === list.length && previous.every(Boolean);
      return list.length > 1
        ? sd.setMagneticKeys(
            device.id,
            list,
            known ? (previous as MagneticKeySettings[]) : undefined,
          )
        : sd.setMagneticKey(device.id, list[0]!);
    },
    [device.id],
  );

  const patch = (p: Partial<MagneticKeySettings>, drag?: boolean) => {
    if (!selectedRefs.length) return;
    const nextByKey = { ...byKeyRef.current };
    const nextList: MagneticKeySettings[] = [];
    // The state to diff against is the one the BOARD is in, which for the
    // second and later steps of a drag is not the one on screen — those
    // intermediate values were never sent. So the first step of a gesture wins.
    const prev: Record<string, MagneticKeySettings> = { ...(heldRef.current?.prev ?? {}) };
    for (const k of selectedRefs) {
      const id = keyId(k);
      const base = nextByKey[id] ?? DEFAULT_KEY(k.row, k.col);
      if (!(id in prev) && byKeyRef.current[id]) prev[id] = byKeyRef.current[id]!;
      const next = { ...base, ...p };
      nextByKey[id] = next;
      nextList.push(next);
    }
    byKeyRef.current = nextByKey;
    setByKey(nextByKey);
    const label =
      selectedRefs.length > 1
        ? t('act.write.keys', { n: selectedRefs.length })
        : t('act.write.key');
    if (drag) {
      heldRef.current = { label, list: nextList, prev };
      return;
    }
    heldRef.current = null;
    void commit(label, () => writeKeys(nextList, prev));
  };

  /** Send whatever the gesture ended on. */
  const commitHeld = useCallback(() => {
    const h = heldRef.current;
    heldRef.current = null;
    if (h) void commit(h.label, () => writeKeys(h.list, h.prev));
  }, [commit, writeKeys]);

  /** Every key's settings, the default standing in for a key not read yet —
   *  what the mode planners (magneticModes.ts) work from. */
  const fullMap = (): Record<string, MagneticKeySettings> => {
    const m = { ...byKeyRef.current };
    for (const k of layout ?? []) m[keyId(k)] ??= DEFAULT_KEY(k.row, k.col);
    return m;
  };
  const boardMap = useMemo(() => {
    const m = { ...byKey };
    for (const k of layout ?? []) m[keyId(k)] ??= DEFAULT_KEY(k.row, k.col);
    return m;
  }, [byKey, layout]);

  /**
   * Show a plan on the board, then write it — in one batch, so the two halves
   * of a snap-tap pair land together and the driver can refuse a pair that
   * disagrees with itself.
   */
  const applyPlan = async (label: string, plan: Plan) => {
    if (!plan.length) return;
    const before = byKeyRef.current;
    const next = { ...byKeyRef.current };
    for (const k of plan) next[keyId(k)] = k;
    byKeyRef.current = next;
    setByKey(next);
    heldRef.current = null;
    await commit(label, () => writeKeys(plan, before));
  };

  /**
   * Any pointer release ends a drag, wherever it happens.
   *
   * A range input takes pointer capture, and the switch diagram's markers are
   * dragged with window listeners of their own, so the release regularly lands
   * outside the panel the slider is in — a handler on that panel alone would
   * miss it and the value would sit unsent until the next edit. Unmount flushes
   * too, so navigating away cannot silently drop what was just set.
   */
  useEffect(() => {
    const up = () => commitHeld();
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
    return () => {
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      commitHeld();
    };
  }, [commitHeld]);

  /**
   * Put every key back to DEFAULT_KEY.
   *
   * One paced bulk write (`setMagneticKeys`), not 79 separate ones — the same
   * reason `patch` uses it for a multi-key selection. Local state is updated
   * from the same list that goes to the wire, so the board and the panel
   * cannot disagree while the read settles.
   */
  const restoreDefaults = async () => {
    setConfirmRestore(false);
    if (!layout) return;
    const list = layout.map((k) => DEFAULT_KEY(k.row, k.col));
    const before = byKeyRef.current;
    const next: Record<string, MagneticKeySettings> = {};
    for (const k of list) next[keyId(k)] = k;
    byKeyRef.current = next;
    setByKey(next);
    // A slider value still held from the gesture before this would land on
    // top of the defaults we are about to write.
    heldRef.current = null;
    await flush();
    // Held open until the paced bulk write actually lands. It used to be
    // fire-and-forget, so the panel snapped to the defaults instantly while
    // the board was still taking them — the reported "looks immediate, feels
    // like the keyboard has stopped responding".
    await whileBusy(t('busy.resetAllKeys'), async () => {
      await commit(t('act.write.resetAll'), () => writeKeys(list, before));
      // Read back: the panel must show what the BOARD holds, not what we asked
      // it to hold. Also what re-derives the groups, which is how "every key is
      // the same now" becomes one row in the rail.
      await reloadKeys();
    });
  };

  /**
   * Put the selected keys back to their factory values.
   *
   * The real action behind what used to be a delete button on each group row.
   * A group cannot be deleted — a key always has settings, so removing its
   * group would only make the list disagree with the board — but putting keys
   * back to the default IS a thing you can do, and doing it is what dissolves
   * a group: the keys join whichever group already holds the defaults.
   */
  const resetSelected = async () => {
    if (!layout || !selectedRefs.length) return;
    // Through the planner: a key reset out of a snap-tap pair releases its
    // partner too, instead of leaving it naming a key that no longer agrees.
    const list = planReset(fullMap(), selectedRefs, (r) => DEFAULT_KEY(r.row, r.col));
    const before = byKeyRef.current;
    const next = { ...byKeyRef.current };
    for (const k of list) next[keyId(k)] = k;
    byKeyRef.current = next;
    setByKey(next);
    heldRef.current = null;
    await flush();
    await whileBusy(t('busy.resetSelectedKeys'), async () => {
      const n = selectedRefs.length;
      const label = n === 1 ? t('act.write.resetOne') : t('act.write.resetMany', { n });
      await commit(label, () => writeKeys(list, before));
      await reloadKeys();
    });
  };

  const selectAll = () => {
    if (!layout) return;
    setSel(new Set(layout.map((k) => keyId(k))));
  };
  const selectNone = () => setSel(new Set());

  // ---- key groups ---------------------------------------------------------
  /**
   * The profile this pane's groups belong to, fixed at mount.
   *
   * `byKey` is the slot that was active when the pane mounted and read, so its
   * groups must be that slot's too. A profile switch remounts the pane
   * (DeviceConfig bumps the epoch), so pinning loses nothing — and it stops a
   * reconcile still pending from the old profile writing its partition into
   * the new profile's record in the render before the remount.
   */
  const [groupProfile] = useState(() => device.activeProfile ?? 1);
  const {
    groups,
    loaded: groupsLoaded,
    save: saveGroup,
    replaceAll: replaceAllGroups,
  } = useKeyGroups(device.model, groupProfile);

  /**
   * Keep the groups agreeing with the board, on every settings change.
   *
   * A group IS the set of keys sharing one set of settings, so it cannot be
   * stored as a membership list and left alone: seeding it once and then
   * editing a key left that key in a group it no longer qualified for, and the
   * rail described a partition that did not exist — one group holding both a
   * rapid-trigger key and a plain one. The buckets are recomputed here and the
   * stored records only carry the name and colour across (see
   * reconcileGroups). `sameGroups` stops this writing on every render.
   *
   * Only against a board actually read (`readOk`), and never while the device
   * is busy: the profile comparator's sweep and copies hop the board between
   * slots underneath this pane, and a partition taken mid-hop belongs to
   * whichever slot the board happened to be passing through.
   */
  const onPinnedProfile = (device.activeProfile ?? groupProfile) === groupProfile;
  useEffect(() => {
    if (!groupsLoaded || loading || !readOk || busy || !onPinnedProfile || !layout) return;
    // Settled, not per change. `byKey` moves with every step of a slider drag,
    // and re-deriving there means a disk write and a re-render per step for a
    // partition nobody can read while it is moving.
    const t = setTimeout(() => {
      const keys = layout
        .filter((k) => k.slot != null)
        .map((k) => ({ slot: k.slot!, settings: byKey[keyId(k)] ?? DEFAULT_KEY(k.row, k.col) }));
      if (!keys.length) return;
      const next = reconcileGroups(groups, keys);
      if (!sameGroups(groups, next)) void replaceAllGroups(next);
    }, GROUP_SETTLE_MS);
    return () => clearTimeout(t);
  }, [
    groupsLoaded,
    groups,
    loading,
    readOk,
    busy,
    onPinnedProfile,
    layout,
    byKey,
    replaceAllGroups,
  ]);
  const slotGroup = useMemo(() => groupBySlot(groups), [groups]);

  /** How wide the rail has to be for the names it is holding — see
   *  railWidthFor, and measureRailText for why it is measured. */
  const railWidth = useMemo(
    () =>
      railWidthFor(
        // The base is stored as 'Default' and drawn translated; measure what
        // is drawn.
        withBaseName(groups, t('act.groups.default')).map((g) => g.name),
        measureRailText,
      ),
    [groups, t],
  );

  /** The groups the selected keys belong to. Selecting a key should say what
   *  it is set to, and the rail is where that is written down. */
  const selectedGroupIds = useMemo(() => {
    const out = new Set<string>();
    if (!layout) return out;
    for (const k of layout) {
      if (k.slot == null || !sel.has(keyId(k))) continue;
      const g = slotGroup.get(k.slot);
      if (g) out.add(g.id);
    }
    return out;
  }, [layout, sel, slotGroup]);

  /**
   * Give some keys a group's settings, which is what joining it means.
   *
   * There is no membership to edit: a key is in a group precisely when its
   * settings match the group's, so the only way to move it is to change them.
   * The reconcile effect above then re-buckets and the key appears in the row
   * it now belongs to.
   *
   * Reached ONLY by dragging a key onto a group row — an explicit gesture at an
   * explicit target. Clicking a group used to arm a mode where every subsequent
   * key click rewrote that key, which meant simply selecting keys from two
   * different groups silently changed their settings. Selecting is for looking;
   * writing needs a gesture that says so.
   */
  const applyGroupTo = (groupId: string, refs: KeyRef[]) => {
    const g = groups.find((x) => x.id === groupId);
    if (!g || !layout || !refs.length) return;
    const donor = g.slots
      .map((slot) => layout.find((k) => k.slot === slot))
      .map((k) => (k ? byKeyRef.current[keyId(k)] : undefined))
      .find((v): v is MagneticKeySettings => !!v);
    if (!donor) return;
    // Never the donor's snap-tap partner or bindings — see settingsForCopy.
    const list = planCopy(fullMap(), donor, refs);
    if (!list.length) return;
    const before = byKeyRef.current;
    const next = { ...byKeyRef.current };
    for (const k of list) next[keyId(k)] = k;
    byKeyRef.current = next;
    setByKey(next);
    // The base group's stored name is the untranslated 'Default' — name it as
    // the rail does.
    const name = isBaseGroup(g) ? t('act.groups.default') : g.name;
    queue(t('act.write.applyGroup', { name }), () => writeKeys(list, before));
  };

  /**
   * Give one key another key's settings — the key-onto-key drop.
   *
   * Written out in full rather than through `applyGroupTo`: the source key may
   * be in no group the rail knows about yet (its settings were changed a moment
   * ago and the partition is still settling), and "make this key like that one"
   * should not depend on the bookkeeping having caught up.
   */
  const copySettings = (from: KeyRef, to: KeyRef) => {
    const src = byKeyRef.current[keyId(from)];
    if (!src) return;
    // Never the source's snap-tap partner or bindings — see settingsForCopy —
    // and a key copied over leaves its own pair cleanly.
    const list = planCopy(fullMap(), src, [to]);
    if (!list.length) return;
    const before = byKeyRef.current;
    const next = { ...byKeyRef.current };
    for (const k of list) next[keyId(k)] = k;
    byKeyRef.current = next;
    setByKey(next);
    queue(t('act.write.copyTo', { key: labelOf(layout, to) }), () => writeKeys(list, before));
  };

  /** Swap the whole group list for a saved layout's — one write, so the old
   *  list cannot survive as a set of empty rows (see replaceAll). */
  const replaceGroups = async (next: KeyGroup[]) =>
    replaceAllGroups(next.map((g) => ({ ...g, id: '' })));

  /** A key's colour on the board — its group's, which is what the cap in the
   *  panel heading has to carry for the heading to point at the same object. */
  const capColorOf = (k: KeyRef): string | undefined => {
    if (loading || !layout) return undefined;
    const slot = slotOf(layout, k);
    // The base group's colour is none — `|| undefined` draws it as a plain key.
    return slot === null ? undefined : slotGroup.get(slot)?.color || undefined;
  };

  /** Select every key in a group — clicking a group is also "show me these". */
  const selectGroup = (slots: number[]) => {
    if (!layout) return;
    const wanted = new Set(slots);
    setSel(new Set(layout.filter((k) => k.slot != null && wanted.has(k.slot)).map(keyId)));
  };

  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      // A modifier means "add to what I have" everywhere on this tab —
      // shift/ctrl-drag rubber-bands a block and ADDS it (see `onMarquee`), and
      // that drag can start on empty board. Clearing here would make the
      // gesture begin by throwing away the selection it is meant to extend.
      if (e.shiftKey || e.ctrlKey || e.metaKey) return;
      const el = e.target as HTMLElement | null;
      if (!el || el.closest(KEEPS_SELECTION)) return;
      setSel((prev) => (prev.size ? new Set<string>() : prev));
    };
    window.addEventListener('pointerdown', onDown);
    return () => window.removeEventListener('pointerdown', onDown);
  }, []);

  const onSelect = (k: KeyRef) => {
    // A click is a request to watch: a stream that was lost gets another try.
    setLiveLost(false);
    // Every click toggles; nothing replaces the selection any more.
    //
    // Building up a set of keys is what this board is FOR — the panel below
    // edits all of them at once — and requiring a held modifier for the normal
    // case made the common gesture the awkward one. Escape and "Select none"
    // are the ways back to empty, which is why a plain click no longer needs
    // to be one.
    setSel((prev) => {
      const id = keyId(k);
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  /** What the Mode row and its panels need — see KeyModePanels.tsx. */
  const modeCtx: ModeContext | null =
    anchorKey && key && layout
      ? {
          device,
          map: boardMap,
          layout,
          anchor: anchorKey,
          selected: selectedRefs,
          slot: slotOf(layout, anchorKey),
          labelOf: (k) => labelOf(layout, k),
          colorOf: capColorOf,
          applyPlan,
          write: commit,
        }
      : null;
  /** What the Mode list shows: a pending choice wins over the key's mode. */
  const modeValue: ModeChoice | null = draftMode ?? (mixed.mode ? null : choiceOf(key?.mode));

  /**
   * A mode chosen in the list. Normal and Toggle are just the mode byte, and
   * are written at once. Snap-tap is a pairing: two keys selected pair with
   * each other; one key opens its panel to choose the partner, and is written
   * once it has one. Mod-tap and DKS need bindings first, so they open their
   * panel and write on its Apply.
   */
  const chooseMode = (choice: ModeChoice) => {
    setDraftMode(null);
    if (!anchorKey) return;
    const map = fullMap();
    if (choice === 'normal') {
      void applyPlan(
        t('act.write.mode', { name: t('act.mode.normal') }),
        planModeChange(map, selectedRefs, 'normal'),
      );
    } else if (choice === 'toggle') {
      const style = choiceOf(key?.mode) === 'toggle' ? toggleStyleOf(key?.mode) : 'hold';
      void applyPlan(
        t('act.write.mode', { name: t('act.mode.toggle') }),
        planModeChange(map, selectedRefs, toggleMode(style)),
      );
    } else if (choice === 'snap') {
      if (selectedRefs.length === 2) {
        void applyPlan(t('act.snap.pair'), planPair(map, selectedRefs[0]!, selectedRefs[1]!));
      } else setDraftMode('snap');
    } else {
      setDraftMode(choice);
    }
  };

  const shownMode = modeValue;
  const modePanel = !modeCtx ? null : shownMode === 'snap' ? (
    <SnapTapPanel ctx={modeCtx} draft={draftMode === 'snap'} onDone={() => setDraftMode(null)} />
  ) : shownMode === 'toggle' ? (
    <TogglePanel ctx={modeCtx} />
  ) : shownMode === 'mt' && selectedRefs.length === 1 ? (
    <ModTapPanel
      key={keyId(modeCtx.anchor)}
      ctx={modeCtx}
      draft={draftMode === 'mt'}
      onDone={() => setDraftMode(null)}
    />
  ) : shownMode === 'dks' && selectedRefs.length === 1 ? (
    <DksPanel
      key={keyId(modeCtx.anchor)}
      ctx={modeCtx}
      draft={draftMode === 'dks'}
      onDone={() => setDraftMode(null)}
    />
  ) : null;

  /** Snap-tap pairs, numbered 1, 2, … in board order, for the badge on each key. */
  const pairNo = useMemo(() => pairNumbers(boardMap, layout ?? []), [boardMap, layout]);

  return (
    <div>
      {confirmRestore && (
        <ConfirmDialog
          title={t('act.reset.confirm.title')}
          body={t('act.reset.confirm.body')}
          confirmLabel={t('act.reset.confirm.ok')}
          onResolve={(ok) => (ok ? void restoreDefaults() : setConfirmRestore(false))}
        />
      )}
      {calibrating && (
        <CalibrationOverlay
          deviceId={device.id}
          layout={layout}
          perKeyLighting={device.ui.perKeyLighting}
          onClose={() => setCalibrating(false)}
        />
      )}
      <Panel title={t('act.perKey')} className="panel-board-first">
        {loading && (
          <div className="panel-loading">
            <Loading inline />
          </div>
        )}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 12,
            marginBottom: 10,
            flexWrap: 'wrap',
            // Keep the board mounted while the read is in flight (the art
            // anchor measures it), just don't present placeholder values as
            // if they were the device's.
            ...(loading ? { display: 'none' } : null),
          }}
        >
          {/* Test keys — see `testing` in the state block. */}
          <Tooltip
            text={
              liveFailed
                ? t('act.testKeys.unsupported')
                : liveLost
                  ? t('act.testKeys.lost')
                  : testing
                    ? t('act.testKeys.stop')
                    : t('act.testKeys.tip')
            }
          >
            {/* `aria-disabled`, not `disabled`, for the unsupported case — a
                really-disabled button fires no mouse events, so the Tooltip
                explaining *why* it's dead would never open (same reasoning as
                Toggle's own `disabled`, see common.tsx). `loading` is
                transient and has nothing to explain, so it stays a real
                disable. */}
            <button
              className={`btn ${testing ? 'is-on' : ''}`}
              onClick={() => {
                if (liveFailed) return;
                setLiveLost(false);
                setTesting((v) => !v);
              }}
              aria-pressed={testing}
              aria-disabled={liveFailed || undefined}
              disabled={loading}
            >
              <span className="dot-lead" aria-hidden="true" style={{ opacity: testing ? 1 : 0 }}>
                ●
              </span>
              {t('act.testKeys')}
            </button>
          </Tooltip>
          <AllKeysMenu disabled={loading} onCalibrate={() => setCalibrating(true)} extra={aside} />
          {/* Sweep the board again, on demand.
              The tab reads once when it opens and then trusts what it sent, so
              there was no way to ask "what does the keyboard actually hold?" —
              which is the only question worth asking when the panel and the
              device might disagree. Label fixed and never disabled-by-width:
              the busy state is the overlay, so this button does not resize and
              shuffle the row beside it. */}
          <Tooltip text={t('act.read.tip')}>
            <button
              className="btn"
              disabled={loading}
              onClick={() =>
                void whileBusy(t('busy.readingKeyboard'), async () => {
                  commitHeld();
                  await flush();
                  await reloadKeys();
                })
              }
            >
              <Icon name="download" size={12} /> {t('act.read')}
            </button>
          </Tooltip>
          {/* A frame-decode counter and a hardware-confidence warning are both
              developer information — see DevNote in tabs/common.tsx. */}
          {/* After the spacer, not before it: developer information should not be
              able to push the controls around when it appears. */}
          {/* Rendered even when empty — a status line that appears and vanishes
              is a status line that moves every button beside it. */}
          <span className={`hint kb-status${testing ? ' is-testing' : ''}`} aria-live="polite">
            {testing
              ? t('act.testKeys.on')
              : sel.size === 1
                ? t('act.sel.keysOne')
                : sel.size > 1
                  ? t('act.sel.keys', { n: sel.size })
                  : ' '}
          </span>
          {live && isDev && (
            <span className="pill warn">
              {t('act.live.frames', {
                decoded: liveFrames.decoded,
                received: liveFrames.received,
              })}
            </span>
          )}
          <span style={{ flex: 1 }} />
          <button className="btn" onClick={selectAll}>
            <Icon name="marquee" size={12} /> {t('act.sel.all')}
          </button>
          <button className="btn" onClick={selectNone} disabled={sel.size === 0}>
            <Icon name="close" size={12} /> {t('act.sel.none')}
          </button>
        </div>
        {/* Board and group rail side by side. The rail is what turns "these
            keys share settings" into something you can see and click, so it
            has to be next to the keys it is talking about. */}
        <div className="kb-with-rail" style={{ ['--kg-rail-w' as string]: `${railWidth}px` }}>
          <ArtAnchor mode="keyboard" className="art-keyboard-anchor" measureRef={boardRef}>
            <KeyboardMap
              ref={boardRef}
              layout={layout}
              isSelected={(k) => sel.has(keyId(k))}
              onSelect={onSelect}
              // Drag a key onto a group row to give it that group's settings,
              // or onto another key to give that key these settings. Both are
              // "this key's settings belong over there", which is the only
              // thing moving a key can mean: a key is in a group precisely
              // when its settings match.
              selectedCount={sel.size}
              onKeyDrop={(from, to) => {
                const refs = sel.has(keyId(from))
                  ? selectedRefs
                  : [{ row: from.row, col: from.col }];
                if (to.groupId) {
                  applyGroupTo(to.groupId, refs);
                  return;
                }
                if (to.key) copySettings(from, to.key);
              }}
              // Double-click: select everything set up like this key. It is the
              // question the board is best placed to answer — the rail can do
              // it too, but only if you already know which row this key is in.
              onKeyDoubleClick={(k) => {
                const g = k.slot == null ? undefined : slotGroup.get(k.slot);
                if (g) selectGroup(g.slots);
              }}
              marqueeFromKeys
              // Shift or ctrl + drag rubber-bands a block of keys; a plain
              // drag has hold of the key it started on (see onKeyToGroup). It
              // adds, exactly like a click does (see onSelect); Escape is the
              // one way to empty the selection, so no gesture needs to do it as
              // a side effect.
              onMarquee={(keys) => {
                setSel((prev) => {
                  const next = new Set(prev);
                  for (const k of keys) next.add(keyId(k));
                  return next;
                });
              }}
              // The key's fill is its GROUP, always.
              //
              // It used to be the group colour only while the live tint was
              // off — and that tint switches on the moment anything is selected
              // (see `boardTint`), so clicking a key or a group blanked the
              // colours off the whole board, which is exactly when the
              // partition is worth seeing. Worse, with nothing pressed the tint
              // had no reading to show and returned undefined, so the board
              // went plain rather than merely changing meaning.
              //
              // Live depth has the per-key gauge, which draws the real travel
              // rather than a tint standing in for it. One channel, one
              // meaning.
              accent={(k) => {
                // Nothing while the board is being read. The groups are stored
                // per MODEL, so after a profile switch they still describe the
                // profile you just left — a confident, wrong partition painted
                // over a board whose settings are not known yet, under the new
                // profile's name. An unpainted board says "not known", which is
                // the truth for those seconds.
                if (loading) return undefined;
                return k.slot == null ? undefined : slotGroup.get(k.slot)?.color || undefined;
              }}
              // Different colour AND different shape. These were `--violet` and
              // `--amber`, which under the grey-brown palette are #ffd76a and
              // #ffb454 — two shades of the same yellow, so the board showed one
              // marker where it meant two. Literal colours, like the group and
              // keycap ones, because a palette token is free to become anything.
              cap={(k) => {
                const ks = byKey[keyId(k)];
                if (!ks) return null;
                const rt = ks.rapidTrigger ? (
                  <span className="kbkey-dot" style={{ background: MARK_RT }} />
                ) : null;
                // A snap-tap key carries its pair's number, so the two halves
                // of each pair can be found at a glance — and "!" when it is
                // half a pair the keyboard ignores.
                const pair = pairNo.get(keyId(k));
                if (pair !== undefined || ks.mode === 'snap') {
                  const half = pair === undefined && isHalfPair(boardMap, k);
                  return (
                    <>
                      {rt}
                      <span
                        className={half ? 'kbkey-pair is-half' : 'kbkey-pair'}
                        style={{ background: MARK_MODE }}
                      >
                        {half ? '!' : pair}
                      </span>
                    </>
                  );
                }
                if (rt) return rt;
                if (ks.mode && ks.mode !== 'normal')
                  return <span className="kbkey-dot is-square" style={{ background: MARK_MODE }} />;
                return null;
              }}
              gauge={(k) => {
                const ks = byKey[keyId(k)] ?? DEFAULT_KEY(k.row, k.col);
                // The slider's OWN max, not a hand-copied 4. The comment claimed
                // they matched; the slider's is 3.4, so every gauge drew its fill
                // and ticks ~15% short of where the value actually sat.
                const max = KB_TRAVEL_RANGE.travel.max;
                const pct = (mm: number) => Math.max(0, Math.min(100, (mm / max) * 100));
                const gauge: KeyGauge = {
                  fillPct: pct(ks.actuationMm),
                  ticks: [],
                  bands: [],
                };
                if (ks.releaseMm !== undefined)
                  gauge.ticks!.push({ pct: pct(ks.releaseMm), color: 'var(--violet)' });
                if (ks.deadZoneMm)
                  gauge.bands!.push({
                    fromPct: 0,
                    toPct: pct(ks.deadZoneMm),
                    color: 'var(--text-mut)',
                  });
                if (ks.deadZoneBottomMm)
                  gauge.bands!.push({
                    fromPct: pct(max - ks.deadZoneBottomMm),
                    toPct: 100,
                    color: 'var(--text-mut)',
                  });
                if (boardTint && layout) {
                  const slot = slotOf(layout, k);
                  const liveMm = slot !== null ? liveBySlot[slot] : undefined;
                  if (liveMm != null)
                    gauge.ticks!.push({ pct: pct(liveMm), color: 'var(--accent)' });
                }
                return gauge;
              }}
            />
          </ArtAnchor>
          <KeyGroupsPanel
            groups={groups}
            loading={loading}
            selected={selectedGroupIds}
            onPick={(id) => {
              const g = groups.find((x) => x.id === id);
              if (g) selectGroup(g.slots);
            }}
            onRename={(g, name) => {
              // The base group is a fixed concept, not a user group; the rail
              // offers no rename on it, this is the backstop.
              if (isBaseGroup(g)) return;
              // The rail is the only place a group is identified, so a blank or
              // duplicate name makes a row unusable. Rejected rather than
              // silently uniquified: renaming to a name that is taken is a
              // mistake worth saying out loud. The base's translated label
              // counts as taken too.
              const v = validateGroupName(
                name,
                withBaseName(groups, t('act.groups.default')),
                g.id,
              );
              if (!v.ok) {
                toast(
                  'warn',
                  v.reason === 'empty'
                    ? t('act.groups.nameEmpty')
                    : t('act.groups.nameTaken', { name: name.trim() }),
                );
                return;
              }
              if (v.name !== g.name) void saveGroup({ ...g, name: v.name });
            }}
            onRecolor={(g, color) => void saveGroup({ ...g, color })}
          />
        </div>
        {/* What the marks on the board mean. Every one of these was previously
            unexplained — a violet dot, an amber dot and an accent tint with no
            key anywhere on the tab. */}
        <div className="kb-legend">
          <span className="kb-legend-item">
            <span className="kb-legend-dot" style={{ background: MARK_RT }} />
            {t('act.legend.rt')}
          </span>
          <span className="kb-legend-item">
            <span className="kb-legend-dot is-square" style={{ background: MARK_MODE }} />
            {t('act.legend.mode')}
          </span>
          <span className="kb-legend-item">
            <span className="kbkey-pair is-legend" style={{ background: MARK_MODE }}>
              1
            </span>
            {t('act.snap.pair')}
          </span>
          <span className="kb-legend-item">
            <span
              className="kb-legend-swatch"
              style={{ background: 'rgba(var(--accent-rgb), 0.55)' }}
            />
            {t('act.legend.live')}
          </span>
          <span className="kb-legend-item">
            <span className="kb-legend-gauge" />
            {t('act.legend.gauge')}
          </span>
          {/* Every key, so it sits with the board rather than with the Key
              panel's own Reset (the selected keys only) — the same place the
              Remap tab keeps its Reset all. */}
          <Tooltip text={t('act.reset.all.tip')}>
            <button
              className="btn kb-legend-end"
              disabled={loading || allDefault}
              onClick={() => setConfirmRestore(true)}
            >
              <Icon name="restore" size={12} /> {t('act.reset.all')}
            </button>
          </Tooltip>
        </div>
      </Panel>

      {/* Everything below the board, in two columns.
          It was one stack — board, saved layouts, key groups, the key stage,
          trigger response — roughly three screens of pane that you had to
          scroll through to see what a key was set to while looking at the key
          you had selected. The board stays full width (it is the tab's
          anchor); the settings stage takes the wider column because its
          sliders are the thing being read, and the lists take the narrower
          one. Stacks back to one column when the pane is too narrow to split.
          The whole region keeps the selection — clicking in it is working WITH
          the selected keys, not leaving them. */}
      <div className="act-cols">
        {/* The wider column: the stage is what you read while a key is
            selected, and its sliders need the room. */}
        <div className="act-col act-col-main">
          {/* Kept mounted with nothing selected — a panel this size appearing and
              vanishing as you click around the board is disorienting, and it is
              also where a first-time user looks to find out what to do next. It
              shows the resting switch diagram, dimmed and inert, with a line
              saying what to do. */}
          <div
            className={anchorKey && key ? undefined : 'panel-inert'}
            aria-disabled={anchorKey ? undefined : true}
          >
            <Panel
              actions={
                // This key, or these keys — the selection only. Every key is
                // "Reset all", under the board.
                <Tooltip text={t('act.reset.selected.tip')}>
                  <button
                    className="btn"
                    onClick={() => void resetSelected()}
                    disabled={sel.size === 0}
                  >
                    <Icon name="restore" size={12} /> {t('act.reset.selected')}
                  </button>
                </Tooltip>
              }
              title={
                // The section keeps its name in every state. It used to be
                // replaced by whatever was selected — so choosing a key left a
                // panel of sliders under a lone keycap, with nothing saying
                // what the panel was. The name leads; the subject follows it.
                //
                // The subject is the key itself, drawn as the board draws it
                // (same cap, same group colour), rather than its name in prose
                // beside a board where it is already visible. Same
                // representation as the Remap tab's assign panel.
                <span className="remap-title">
                  {t('act.key.title')}
                  {anchorKey && key ? (
                    sel.size > 1 ? (
                      <span className="remap-title-any">{t('act.sel.count', { n: sel.size })}</span>
                    ) : (
                      <KeyCap label={labelOf(layout, anchorKey)} color={capColorOf(anchorKey)} />
                    )
                  ) : previewRef ? (
                    // A readout, not a selection: the panel stays inert, so
                    // the title has to say why it is showing a key nobody
                    // clicked.
                    <>
                      <span className="remap-title-any">{t('act.key.pressing')}</span>
                      <KeyCap label={labelOf(layout, previewRef)} color={capColorOf(previewRef)} />
                    </>
                  ) : null}
                </span>
              }
            >
              {!anchorKey || !key ? (
                <p className="hint">
                  {previewRef ? t('act.key.previewHint') : t('act.key.emptyHint')}
                </p>
              ) : null}
              <div
                style={{ display: 'flex', gap: 24, flexWrap: 'wrap' }}
                onPointerUp={commitHeld}
                onBlur={commitHeld}
              >
                <SwitchTravelStage
                  actuationMm={stageKey?.actuationMm ?? DEFAULT_KEY(0, 0).actuationMm}
                  releaseMm={stageKey?.releaseMm}
                  rapidTrigger={stageKey?.rapidTrigger}
                  rtPressMm={stageKey?.rtPressMm}
                  rtReleaseMm={stageKey?.rtReleaseMm}
                  rtPressAtMm={rtAt.pressAt}
                  rtReleaseAtMm={rtAt.releaseAt}
                  splitRelease={splitRelease}
                  rtSplit={rtSplit}
                  mixed={mixed}
                  distinct={distinct}
                  onRtPressChange={(v, live) =>
                    patch(rtSplit ? { rtPressMm: v } : { rtPressMm: v, rtReleaseMm: v }, live)
                  }
                  onRtReleaseChange={(v, live) => patch({ rtReleaseMm: v }, live)}
                  deadZoneMm={stageKey?.deadZoneMm}
                  deadZoneBottomMm={stageKey?.deadZoneBottomMm}
                  liveMm={
                    live && layout && stageRef
                      ? (liveBySlot[slotOf(layout, stageRef) ?? -1] ?? null)
                      : null
                  }
                  onActuationChange={(v, live) =>
                    patch(
                      splitRelease
                        ? { actuationMm: v }
                        : // Linked: release follows actuation exactly.
                          { actuationMm: v, releaseMm: v },
                      live,
                    )
                  }
                  onReleaseChange={(v, live) => patch({ releaseMm: v }, live)}
                  onDeadZoneChange={(v, live) => patch({ deadZoneMm: v }, live)}
                  onDeadZoneBottomChange={(v, live) => patch({ deadZoneBottomMm: v }, live)}
                />
                <div style={{ flex: 1, minWidth: 220 }}>
                  <Row
                    label={
                      <InfoLabel label={t('act.release.point')} text={t('act.release.point.tip')} />
                    }
                  >
                    <button
                      className="btn"
                      onClick={() => {
                        const next = !splitRelease;
                        setSplitRelease(next);
                        // Re-linking snaps release back onto the gap, so the two
                        // cannot be left disagreeing behind one slider.
                        if (!next && key) patch({ releaseMm: key.actuationMm });
                      }}
                    >
                      {splitRelease ? t('act.release.link') : t('act.release.split')}
                    </button>
                  </Row>
                  {/* A list, not a segmented control: five side-by-side buttons is a
                      lot of width for a setting left on Normal almost always.
                      Unlike a native select, each option explains itself where
                      it is being chosen (see ListboxSelect). */}
                  {modeCtx && <ModeRow ctx={modeCtx} value={modeValue} onChoose={chooseMode} />}
                  {device.capabilities.includes('rapidTrigger') && (
                    <Row
                      label={
                        <InfoLabel
                          label={t('act.rt.title')}
                          text={t('act.rt.tip')}
                          media={<RapidTriggerMedia />}
                        />
                      }
                      hint={t('act.rt.hint')}
                    >
                      <Segmented
                        value={mixed.rapidTrigger ? '' : key?.rapidTrigger ? 'on' : 'off'}
                        options={[
                          { value: 'off', label: t('common.off') },
                          { value: 'on', label: t('common.on') },
                        ]}
                        onChange={(v) =>
                          patch(
                            v === 'on'
                              ? // Switching rapid trigger on sets the sensitivity
                                // too, and to OUR default. Without it the flag
                                // armed at whatever the board happened to hold
                                // — the vendor's factory 0.3 mm — so the app's
                                // documented default was never what you got by
                                // turning the feature on.
                                {
                                  rapidTrigger: true,
                                  rtPressMm: key?.rtPressMm ?? T.rt.default,
                                  rtReleaseMm: key?.rtReleaseMm ?? T.rt.default,
                                }
                              : { rapidTrigger: false },
                          )
                        }
                      />
                    </Row>
                  )}
                  {device.capabilities.includes('rapidTrigger') &&
                    key?.rapidTrigger &&
                    !mixed.rapidTrigger && (
                      <RtLink
                        split={rtSplit}
                        onSplit={(next) => {
                          setRtSplit(next);
                          // Re-linking adopts the press value for both.
                          if (!next && key?.rtPressMm !== undefined)
                            patch({ rtReleaseMm: key.rtPressMm });
                        }}
                      />
                    )}
                  {/* Under rapid trigger, not between it and the Mode row: the
                      mode's own settings are the longest block here, and rapid
                      trigger applies in every mode. */}
                  {modePanel && <div className="mode-panel">{modePanel}</div>}
                </div>
              </div>
            </Panel>
          </div>
          <ActuationLayoutsSection
            device={device}
            layout={layout}
            current={() => ({
              keys: layout ? layout.map((k) => byKey[keyId(k)] ?? DEFAULT_KEY(k.row, k.col)) : [],
              groups,
            })}
            onLoad={(l) => {
              // Runs after the layout has reached the board (Apply writes
              // first), so this is catching the panel up, not staging an edit.
              // A layout also carries the groups that organised it, so they come
              // back too — replaced wholesale rather than merged, since a
              // half-applied set would claim slots from two layouts at once.
              const next: Record<string, MagneticKeySettings> = {};
              for (const k of l.keys) next[keyId(k)] = k;
              byKeyRef.current = next;
              setByKey(next);
              void replaceGroups(l.groups);
            }}
          />
        </div>
      </div>
    </div>
  );
}
