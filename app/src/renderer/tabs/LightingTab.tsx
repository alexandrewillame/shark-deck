import { type MutableRefObject, useEffect, useMemo, useRef, useState } from 'react';
import { gate } from '@shared/menuGates';
import { Gated } from '../components/Gated';
import type { KeyLayoutEntry } from '@shared/types/keys';
import type {
  DpiLedSettings,
  LightingSettings,
  ReceiverLedSettings,
  SideLightingSettings,
} from '@shared/types/lighting';
import {
  KB_LIGHT_EFFECTS,
  KB_LIGHT_STEPS,
  KB_PERKEY_EFFECT_INDEX,
  SIDE_LIGHT_EFFECTS,
  kbEffect,
} from '@shared/lighting';
import { DPI_LED_EFFECTS, LIGHT_MODES, LIGHT_OFF_TIMEOUTS } from '@shared/mouse-options';
import { RX_LED_WIRE } from '@shared/mouse-wire';
import {
  ColorField,
  Panel,
  PaneHeader,
  Row,
  Segmented,
  Select,
  Slider,
  StepSlider,
  TitleTabs,
  Toggle,
  Tooltip,
} from '../components/common';
import { ColorPickerField } from '../components/ColorPickerField';
import { KeyboardMap } from '../components/KeyboardMap';
import { ArtAnchor, requestArtRemeasure } from '../components/ArtAnchor';
import { DEVICE_ART_DETAIL } from '../components/deviceArtAssets';
import {
  type TabProps,
  sd,
  useDeviceData,
  useAutoWrite,
  useDeviceBusy,
  useWrite,
  ReadFailed,
  Loading,
} from './common';
import { useT } from '../state/i18n';
import { hexToRgb, rgbToHex } from '../colorUtil';
import { InfoLabel } from '../components/InfoLabel';
import { effectColor, isStaticEffect } from './lighting/effectPreview';
import { EffectThumb } from './lighting/EffectThumb';
import {
  GLOBAL_FALLBACK_EFFECT,
  GLOBAL_PICKER_EFFECTS,
  globalDraftDiffers,
  globalPickerList,
  seedGlobalDraft,
  useLightingMode,
} from './lighting/lightingMode';
import { confirmLeave, usePendingChange } from '../state/leaveGuard';
import { LightStage } from './lighting/LightStage';
import { PanelActions } from './lighting/PanelActions';
import { PerKeyPane } from './lighting/PerKeyPane';
import { usePerKeyEditor } from './lighting/usePerKeyEditor';
import { deviceCacheKey, putDeviceCache } from '../state/deviceCache';
import {
  applyPreset,
  applySidePreset,
  presetKey,
  presetOf,
  recallPreset,
} from './lighting/effectMemory';
import { useAmbientLighting } from './lighting/useAmbientLighting';
import { hostFeatures } from '../state/host';
import { useStore } from '../state/store';
import { usePaneView } from '../state/paneView';
import { useIsMac } from '../state/shortcuts';

/**
 * Drives the animated effect previews with a looping 0..1 phase.
 *
 * A plain `setInterval`, not `requestAnimationFrame`: ~20fps is plenty for a
 * colour preview and keeps a 79-key re-render off the display's paint cadence.
 * Paused under `prefers-reduced-motion`, and by `active: false` for an effect
 * that has nothing to animate.
 *
 * `periodMs` is the full loop. The board preview takes it from the effect's
 * own speed; the picker uses a fixed, slower one (see PICKER_PERIOD_MS).
 */
function useEffectPhase(periodMs: number, active: boolean): number {
  const [phase, setPhase] = useState(0);
  useEffect(() => {
    if (!active) return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const stepMs = 50;
    let elapsed = 0;
    const id = setInterval(() => {
      elapsed = (elapsed + stepMs) % periodMs;
      setPhase(elapsed / periodMs);
    }, stepMs);
    return () => clearInterval(id);
  }, [periodMs, active]);
  return phase;
}

/**
 * Loop length for the big board preview, from the effect's own speed.
 *
 * Slowed twice now. 6s..1s made most effects read as a flicker; 9s..3s still
 * did at the top end, because several previews pack more than one event into
 * a loop — `pressPoint` fires three simulated presses per cycle, so a 3s loop
 * is a keystroke a second and the press-reactive effects strobed.
 *
 * 11s..5s. The preview is there to say what an effect *is*, and it does not
 * have to match the board's own rate to do that — the speed setting still
 * reaches the hardware unchanged.
 */
const boardPeriodMs = (speedPercent: number) => 11000 - (speedPercent / 100) * 6000;

/**
 * The picker tiles animate at a fixed, unhurried pace, independent of the
 * selected effect's speed.
 *
 * Two bugs came out of sharing the board's phase. The tiles froze whenever the
 * *selected* effect was static — landing on the tab with "Always On" set, which
 * is the default, meant every thumbnail sat still until you clicked an animated
 * one. And they ran at whatever speed that effect had, so browsing effects at
 * speed 4 was a wall of flicker.
 *
 * Deliberately far slower than anything the board does. Twenty thumbnails
 * animating at a realistic speed is twenty things moving in peripheral vision
 * while you read the labels; these only have to show what KIND of effect each
 * one is. The board preview beside them runs at the real speed.
 */
const PICKER_PERIOD_MS = 14_000;

/**
 * Preset namespaces (`presetKey`'s middle segment).
 *
 * The board and the strip are different hardware with different effect lists,
 * so an effect whose name appears in both — Wave, Snake, Breath — must not
 * share one remembered colour between them.
 */
const BOARD_ZONE = 'keyboard';
const SIDE_ZONE = 'side';

/**
 * The effect picker: a tile per effect, each animating its own family, instead
 * of a text-only `<select>`. Names like "Mountain Wave" or "Snow Trace" say very
 * little on their own; a moving swatch says what you are choosing.
 *
 * ONE phase drives every tile (passed in, not one `useEffectPhase` per tile) —
 * twenty 50ms intervals to animate twenty thumbnails would be pure waste.
 */
function EffectPicker({
  value,
  color,
  rainbow,
  option,
  recall,
  onPick,
  effects,
  layout,
  strip,
}: {
  value: string;
  /** Fallback colour, for an effect that has never been used. */
  color: [number, number, number];
  /** Fallback colour mode, likewise. */
  rainbow: boolean;
  /** Fallback direction, likewise. */
  option?: number;
  /**
   * That effect's own remembered parameters, if it has any.
   *
   * Without this every tile previewed with the SELECTED effect's colour and
   * dazzle flag, so an Always On that has always been set to Rainbow drew as
   * one flat cyan until you clicked it — at which point its real settings
   * loaded and the same tile turned multicolour. A picker has to show what
   * picking it would give, and picking it restores its own preset (see
   * withEffect / applyPreset).
   */
  recall: (
    label: string,
  ) => { color?: [number, number, number]; dazzle?: boolean; option?: number } | undefined;
  onPick: (label: string) => void;
  /**
   * Which effects to offer. Defaults to the keyboard's own table; the side
   * strip has a shorter list of its own.
   *
   * The tile previews come from `effectColor`, which is keyed on the effect's
   * LABEL — and the side strip's labels are the same words ("Breath",
   * "Wave", "Snake"), so the same renderer draws both. An effect it does not
   * know falls back to a flat fill, which is the honest answer for one.
   */
  effects?: readonly { label: string; qmkLabel?: string }[];
  /** The board each tile draws. Omitted for the side strip, which draws one
   *  continuous bar instead — see `EffectThumb`. */
  layout?: KeyLayoutEntry[];
  strip?: boolean;
}) {
  const t = useT();
  // Its OWN phase — never the board's. See PICKER_PERIOD_MS.
  const phase = useEffectPhase(PICKER_PERIOD_MS, true);
  const list = effects ?? GLOBAL_PICKER_EFFECTS;
  return (
    <div className="effect-grid" role="listbox" aria-label={t('light.effects.aria')}>
      {list.map((e) => {
        // The SELECTED effect previews what is on screen right now, not what
        // was last banked for it. `recall` only moves when you leave an effect
        // or press Apply, so its own tile went on showing the old colour while
        // you were picking a new one — "the preview doesn't update until I
        // leave this effect". Every other tile still shows its own memory,
        // which is the point of the tiles.
        const mem = e.label === value ? undefined : recall(e.label);
        return (
          <Tooltip
            key={e.label}
            text={e.qmkLabel ? t('light.effect.qmkName', { name: e.qmkLabel }) : e.label}
          >
            <button
              role="option"
              aria-selected={e.label === value}
              className={`effect-tile ${e.label === value ? 'on' : ''}`}
              onClick={() => onPick(e.label)}
            >
              {/* The whole board, not a stand-in for one. An abstract 6x3
                  grid meant a wave across six columns previewed nothing like
                  the same wave across seventy-nine keys — which is the thing
                  the tile exists to show. */}
              <EffectThumb
                label={e.label}
                layout={layout}
                strip={strip}
                phase={phase}
                color={mem?.color ?? color}
                option={mem?.option ?? option ?? 0}
                // A tile shows what picking it would actually give: this
                // effect's own remembered colour mode, falling back to the
                // current one for an effect never used, and always multicolour
                // for an effect that carries no colour of its own.
                rainbow={(mem?.dazzle ?? rainbow) || !kbEffect(e.label)?.colour}
              />
              <span className="effect-tile-label">{e.label}</span>
            </button>
          </Tooltip>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------- keyboard: global vs per-key
/**
 * Global and per-key are the SAME wire concept, not two independent panes
 * that could disagree — per-key ("Custom") is literally one entry
 * (KB_PERKEY_EFFECT_INDEX) in the same KB_LIGHT_EFFECTS list a global effect
 * picks from. That exclusivity is what `light.mode.hint` says, right under
 * the selector — it used to be carried by the selector's SHAPE instead (a
 * `Row`, i.e. a setting, rather than navigation), which said it to nobody and
 * buried the choice halfway down the pane. It is a second-level `TitleTabs`
 * now, nested under the zone picker it belongs to. Nothing is written to the
 * device until whichever pane's own Apply is clicked — switching modes here is
 * purely navigation, matching how the rest of this tab already works.
 */
function MainLightingPane({ device, perKeyLighting }: TabProps & { perKeyLighting: boolean }) {
  const t = useT();
  const settings = useStore((st) => st.settings);
  // Read once here and hand the result to GlobalEffectPane — both used to call
  // `useDeviceData(readLighting)` independently, so opening this tab fired two
  // identical HID reads.
  const {
    data: loaded,
    setData: setLoaded,
    firstLoad,
    reload,
  } = useDeviceData<LightingSettings[]>(device.id, sd.readLighting, [], [], 'lighting');
  // Follows the device on every read; an in-tab click holds only until the
  // next one. See useLightingMode — this was the profile-switch bug.
  const { mode: activeMode, setMode } = useLightingMode(loaded, perKeyLighting);

  /**
   * Both editors live HERE, above the two sub-views, so switching between
   * Global and Per-Key keeps what was being edited in each — and so the Global
   * preview and the Global selection are one value. That preview used to be
   * seeded straight from the read, which on a board showing its per-key layer
   * meant previewing an effect the picker cannot select (see seedGlobalDraft).
   */
  const [globalDraft, setGlobalDraft] = useState<LightingSettings | null>(null);
  /**
   * Changed by hand since the board was last read or applied — what leaving
   * would lose. Not the Modified pill: while the board shows its per-key
   * picture, Global holds a fallback effect nobody chose.
   */
  const [globalEdited, setGlobalEdited] = useState(false);
  /** Set by Global's "Read from keyboard": the next read replaces the draft
   *  instead of being reconciled with it. */
  const discardDraft = useRef(false);
  useEffect(() => {
    const read = loaded[0];
    if (!read) return;
    const fallback = recallPreset(settings, device.model, BOARD_ZONE, GLOBAL_FALLBACK_EFFECT);
    setGlobalDraft((prev) => seedGlobalDraft(read, discardDraft.current ? null : prev, fallback));
    discardDraft.current = false;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded]);
  const perKey = usePerKeyEditor(loaded[0] ?? null);

  /**
   * A write succeeded: the board now holds `next`. The read and its cache are
   * moved on from that, not re-read — a read straight after the colour burst
   * can come back stale, and a stale one would flip the derived mode and bounce
   * the user off the pane they just applied from. This is also what tells
   * Global, after a per-key Apply, that the board has left its effect — and
   * that its draft, which the board can no longer show, is not pending.
   */
  const noteApplied = (next: LightingSettings) => {
    const arr = [next, ...loaded.slice(1)];
    setLoaded(arr);
    putDeviceCache(deviceCacheKey(device.id, 'lighting'), arr);
    setGlobalEdited(false);
  };

  /**
   * Leaving Lighting or its Main zone loses both editors, so each asks first
   * (state/leaveGuard.ts). Global <-> Per-Key keeps them, which is why they
   * register here; only the one on screen can apply from the prompt.
   */
  const globalApply = useRef<(() => Promise<boolean>) | null>(null);
  const perKeyApply = useRef<(() => Promise<boolean>) | null>(null);
  usePendingChange(device.id, {
    dirty: globalEdited && !!globalDraft && globalDraftDiffers(globalDraft, loaded[0]),
    label: () => t('leave.what.lighting', { name: globalDraft?.effect ?? '' }),
    commit:
      activeMode === 'global' ? () => globalApply.current?.() ?? Promise.resolve(false) : undefined,
  });
  usePendingChange(device.id, {
    dirty: perKey.edited,
    label: () => t('leave.what.perKey'),
    plural: true,
    commit:
      activeMode === 'perkey' ? () => perKeyApply.current?.() ?? Promise.resolve(false) : undefined,
  });

  return (
    <>
      {/* Global vs per-key is a sub-view, so it reads as one — a second-level
          `TitleTabs` right under the pane heading, not a `Segmented` buried in
          a settings row halfway down the pane. They remain mutually exclusive
          on the wire (per-key is one entry in the same effect list a global
          effect picks from). The rail's info dot is the ONE place this pane
          explains itself: how painting works on Per-Key, that exclusivity on
          Global. */}
      {perKeyLighting && (
        <TitleTabs
          level={2}
          value={activeMode}
          options={[
            { value: 'global', label: t('light.mode.global'), tip: t('light.mode.global.tip') },
            { value: 'perkey', label: t('light.mode.perkey'), tip: t('light.mode.perkey.tip') },
          ]}
          onChange={setMode}
          info={activeMode === 'perkey' ? t('light.perkey.help') : t('light.mode.hint')}
        />
      )}
      {activeMode === 'global' ? (
        <GlobalEffectPane
          device={device}
          applied={loaded[0]}
          draft={globalDraft}
          setDraft={(next) => {
            setGlobalDraft(next);
            setGlobalEdited(true);
          }}
          firstLoad={firstLoad}
          reserveTools={perKeyLighting}
          onRead={() => {
            discardDraft.current = true;
            setGlobalEdited(false);
            reload();
          }}
          onApplied={noteApplied}
          applyRef={globalApply}
        />
      ) : (
        <PerKeyPane
          device={device}
          editor={perKey}
          applyRef={perKeyApply}
          // Until the main lighting has been read, assume it is: no hint
          // flashing up for a moment on every visit.
          showing={!loaded[0] || loaded[0].effect === KB_LIGHT_EFFECTS[KB_PERKEY_EFFECT_INDEX]}
          onApplied={(brightness) =>
            noteApplied({
              ...(loaded[0] ?? DEFAULT_KB_LIGHTING),
              effect: KB_LIGHT_EFFECTS[KB_PERKEY_EFFECT_INDEX]!,
              brightness,
              enabled: true,
            })
          }
        />
      )}
    </>
  );
}

/** What the Global editor shows before the board's own read lands. */
const DEFAULT_KB_LIGHTING: LightingSettings = {
  zone: 'keyboard',
  effect: 'Always On',
  brightness: 100,
  speed: 50,
  color: [61, 248, 232],
  enabled: true,
};

/**
 * The Global effect editor. Controlled: the draft lives in MainLightingPane
 * (see there), so what the board previews and which effect tile is selected
 * are one value, and the edit survives a visit to Per-Key.
 */
function GlobalEffectPane({
  device,
  applied,
  draft,
  setDraft,
  firstLoad,
  reserveTools,
  onRead,
  onApplied,
  applyRef,
}: TabProps & {
  /** What the board is believed to hold — the read, moved on by every Apply
   *  (MainLightingPane's `noteApplied`). */
  applied: LightingSettings | undefined;
  draft: LightingSettings | null;
  setDraft: (next: LightingSettings) => void;
  firstLoad: boolean;
  /** Keep the per-key tool column's width, so the board does not move between
   *  sub-tabs — see LightStage. */
  reserveTools: boolean;
  onRead: () => void;
  onApplied: (next: LightingSettings) => void;
  /** Filled with this pane's Apply while it is mounted. */
  applyRef: MutableRefObject<(() => Promise<boolean>) | null>;
}) {
  const t = useT();
  const { run } = useWrite();
  const { whileBusy } = useDeviceBusy(device.id);
  const [applying, setApplying] = useState(false);
  const boardRef = useRef<HTMLDivElement>(null);
  const cur: LightingSettings = draft ?? DEFAULT_KB_LIGHTING;
  // Per-effect memory: each effect keeps its own brightness/speed/colour
  // rather than inheriting whatever the previous one was set to.
  const settings = useStore((st) => st.settings);
  const setSettings = useStore((st) => st.setSettings);

  /**
   * Switch effect, restoring that effect's own remembered parameters, and
   * bank the outgoing effect's current ones on the way out.
   */
  const withEffect = (from: LightingSettings, label: string): LightingSettings => {
    void rememberEffect(from);
    return applyPreset(from, label, recallPreset(settings, device.model, BOARD_ZONE, label));
  };

  /** Persist one effect's parameters. Called when leaving an effect and on
   *  Apply — not on every slider tick, which would be a settings write per
   *  frame of a drag. */
  const rememberEffect = async (l: LightingSettings) => {
    const key = presetKey(device.model, BOARD_ZONE, l.effect);
    const next = await sd.setSettings({
      lightingPresets: { ...(settings?.lightingPresets ?? {}), [key]: presetOf(l) },
    });
    setSettings(next);
  };

  /**
   * Nothing is written until Apply. Edit freely, press Apply on whichever pane
   * you are using, and that is what the board gets.
   *
   * Do not add an `enabled` toggle here, and do not write on every change.
   * Per-key IS one entry in this same effect list — the same wire field — so a
   * separate toggle makes the two modes look independent and lets "global
   * enabled" and "per-key" both read as on, which is impossible. `Off` in the
   * effect list is the off switch.
   */
  const edit = (next: LightingSettings) => setDraft(next);

  // "Not written yet" compares against what the board holds — which, while
  // the board is on its per-key layer, is not any Global effect at all, so a
  // fallback draft correctly reads as unapplied.
  const dirty = globalDraftDiffers(cur, applied);

  /** Resolves whether the board took it. */
  const apply = async (): Promise<boolean> => {
    setApplying(true);
    // `enabled` is no longer a control; it is whatever the chosen effect means.
    const next: LightingSettings = { ...cur, enabled: cur.effect !== 'Off' };
    let ok = false;
    await whileBusy(t('busy.lighting'), async () => {
      const r = await run(t('light.apply'), () => sd.setLighting(device.id, next));
      ok = r.ok;
      if (r.ok) {
        onApplied(next);
        await rememberEffect(next);
      }
    });
    setApplying(false);
    return ok;
  };
  // The leave prompt's "Apply and leave" (MainLightingPane holds the draft).
  useEffect(() => {
    applyRef.current = apply;
    return () => {
      applyRef.current = null;
    };
  });
  // Every control below is gated on the vendor's own per-effect capability
  // table rather than a hand-kept name list. Speed especially: the table omits
  // `maxSpeed` for static effects, which is exactly the "static lighting still
  // has an active speed slider" complaint — it was rendered unconditionally, so
  // it read as a setting that silently did nothing.
  // Host-fed effects run against what the BOARD is showing, not what is being
  // edited — nothing reaches the device until Apply, and streaming to a board
  // that is still on the previous effect would fight it.
  const liveEffect = applied?.effect;
  // The browser edition never captures: the stream would stop whenever its
  // tab is hidden, which is exactly when a game or a film is on screen. Its
  // picker leaves these effects out (see GLOBAL_PICKER_EFFECTS).
  const ambientMode = !hostFeatures.ambientLighting
    ? null
    : liveEffect === 'Screen Colour'
      ? ('screen' as const)
      : liveEffect === 'Music (Level)' || liveEffect === 'Music (Spectrum)'
        ? ('music' as const)
        : null;
  const isMac = useIsMac();
  const { error: ambientError, noAudio } = useAmbientLighting(
    device.id,
    ambientMode,
    applied?.color ?? cur.color,
    !!applied?.enabled,
    // What the BOARD was told, like `color` beside it — not what is being
    // edited. The stream used to drop this entirely, which is why Rainbow
    // looked ignored on Music (Level).
    !!applied?.dazzle,
  );

  const spec = kbEffect(cur.effect);
  const isOff = cur.effect === 'Off';
  const showSpeed = !isOff && !!spec?.speed;
  const showBrightness = !isOff && !!spec?.brightness;
  const showColour = !isOff && !!spec?.colour && !cur.dazzle;
  const showDazzle = !isOff && !!spec?.dazzle;
  const options = isOff ? undefined : spec?.options;
  const layout = device.ui.keyMatrix?.layout;
  const isStatic = isStaticEffect(cur.effect);
  const phase = useEffectPhase(boardPeriodMs(cur.speed), cur.enabled && !isStatic);
  const bounds = useMemo(() => {
    const xs = layout?.map((k) => k.x) ?? [0];
    const ys = layout?.map((k) => k.y) ?? [0];
    return { maxX: Math.max(...xs, 0), maxY: Math.max(...ys, 0) };
  }, [layout]);

  return (
    <>
      <LightStage boardRef={boardRef} reserveTools={reserveTools}>
        {/* Look-only preview. No opacity wrapper dimming the whole board (it
            made the keys unreadable in dark themes) — brightness/enabled is
            carried in the key colour itself; a disabled effect just shows the
            neutral, readable default key like the Per-Key pane's unpainted
            keys. */}
        <KeyboardMap
          ref={boardRef}
          interactive={false}
          lit
          layout={layout}
          accent={
            !isOff
              ? (k) =>
                  effectColor(cur.effect, k, {
                    phase,
                    bounds,
                    color: cur.color,
                    brightness: cur.brightness,
                    // Multi-colour when the user picked "rainbow", or when the
                    // effect carries no colour of its own. This flag reached
                    // only the static branch before, so a breathing effect in
                    // rainbow mode previewed in one colour and a wave ignored
                    // the colour the user had picked.
                    rainbow: !spec?.colour || !!cur.dazzle,
                    // The direction/variant control reached the driver but not
                    // the preview, so picking Left for Wave changed the board
                    // and nothing on screen.
                    option: cur.option ?? 0,
                  })
              : undefined
          }
        />
      </LightStage>
      {isStatic && (
        <p className="hint" style={{ margin: '8px 0' }}>
          {t('light.preview.static')}
        </p>
      )}
      {/* Host-fed effects. The board renders nothing on its own for these —
          SharkDeck computes the colour and writes it, so the effect only runs
          while this tab is open. Saying so beats the previous behaviour,
          which was the lights going dark with no explanation. */}
      {ambientMode && (
        <p className="hint" style={{ margin: '8px 0' }}>
          {ambientMode === 'screen' ? t('light.hostFed.running') : t('light.hostFed.runningMusic')}
          {' — '}
          {t('light.hostFed.hint')}
        </p>
      )}
      {ambientMode === 'music' && noAudio && (
        <p className="hint" style={{ margin: '8px 0', color: 'var(--amber)' }}>
          {t('light.hostFed.audioFail')}
        </p>
      )}
      {ambientMode && ambientError && (
        <p className="hint" style={{ margin: '8px 0', color: 'var(--amber)' }}>
          {t('light.hostFed.failed', { reason: ambientError })}
          {/* macOS refuses until the user allows it, and the error itself
              ("Error starting capture") says nothing about where. */}
          {isMac && ambientMode === 'screen' && (
            <>
              <br />
              {t('light.hostFed.macPermission')}
            </>
          )}
        </p>
      )}
      <Panel
        title={t('light.global.title')}
        actions={<PanelActions dirty={dirty} busy={applying} onApply={apply} onRead={onRead} />}
      >
        <div>
          {firstLoad && <Loading />}
          {/* Stacked, not a normal Row.
              A Row is label-left / control-right with `space-between`, which is
              right for a toggle and wrong for a 20-tile grid: the grid ended up
              as the right-hand item of a flex row with no definite width, so
              `repeat(auto-fill, …)` resolved to a single narrow column jammed
              against the pane's right edge — the label alone on the far left, a
              wide empty gap, everything crammed at the right. Given the full
              pane width the same grid lays out 6-8 tiles per row. */}
          <div className="row row-stack">
            <div className="label">{t('common.effect')}</div>
            <EffectPicker
              value={cur.effect}
              effects={globalPickerList(cur.effect)}
              color={cur.color}
              rainbow={!!cur.dazzle}
              option={cur.option ?? 0}
              layout={layout}
              recall={(label) => recallPreset(settings, device.model, BOARD_ZONE, label)}
              onPick={(label) => edit(withEffect(cur, label))}
            />
          </div>
          {(showColour || showDazzle) && (
            <Row label={t('common.colour')}>
              {showColour && (
                <ColorPickerField
                  value={rgbToHex(cur.color)}
                  onChange={(hex) => edit({ ...cur, color: hexToRgb(hex) })}
                />
              )}
              {showDazzle && (
                <label
                  style={{
                    fontSize: 12,
                    color: 'var(--text-dim)',
                    display: 'flex',
                    gap: 6,
                    alignItems: 'center',
                  }}
                >
                  <Toggle on={!!cur.dazzle} onChange={(v) => edit({ ...cur, dazzle: v })} />{' '}
                  {t('light.dazzle')}
                </label>
              )}
            </Row>
          )}
          {options && (
            <Row label={t('light.direction')}>
              <Segmented
                value={String(cur.option ?? 0)}
                options={options.map((o, i) => ({ value: String(i), label: o }))}
                onChange={(v) => edit({ ...cur, option: Number(v) })}
              />
            </Row>
          )}
          {showBrightness && (
            <Row label={t('common.brightness')} hint={t('light.steps.hint')}>
              <StepSlider
                value={cur.brightness}
                steps={KB_LIGHT_STEPS}
                ariaLabel={t('common.brightness')}
                onChange={(v) => edit({ ...cur, brightness: v })}
              />
            </Row>
          )}
          {showSpeed && (
            <Row label={t('common.speed')} hint={t('light.steps.hint')}>
              <StepSlider
                value={cur.speed}
                steps={KB_LIGHT_STEPS}
                ariaLabel={t('common.speed')}
                onChange={(v) => edit({ ...cur, speed: v })}
              />
            </Row>
          )}
        </div>
      </Panel>
    </>
  );
}

// ---------------------------------------------------------------- keyboard: underglow
/**
 * Effect and colour-mode are orthogonal, matching the vendor's own
 * "Shining" (an automatic multicolour scheme) vs "Custom colour" (one fixed
 * user colour) choice — applied to any of the 6 real side effects, not a
 * substitute for picking an effect. Brightness shows for every effect
 * except Off; speed shows only for effects the vendor's own table gives a
 * `maxSpeed` (a static effect has nothing to animate). That gate used to be a
 * hardcoded `!== 'Always On'` name check, which left Screen Colour and both
 * Music effects showing a speed slider that does nothing.
 */
function UnderglowPane({ device }: TabProps) {
  const t = useT();
  const { data: loaded, reload } = useDeviceData<SideLightingSettings | null>(
    device.id,
    sd.readSideLighting,
    null,
    [],
    'sideLighting',
  );
  const { run } = useWrite();
  const { whileBusy } = useDeviceBusy(device.id);
  const [applying, setApplying] = useState(false);
  const [l, setL] = useState<SideLightingSettings | null>(null);
  useEffect(() => {
    if (loaded) setL(loaded);
  }, [loaded]);
  const cur: SideLightingSettings = l ?? {
    effect: 'Always On',
    brightness: 100,
    speed: 50,
    color: [61, 248, 232],
    enabled: true,
    dazzle: false,
  };
  /**
   * Per-effect memory, exactly as the Global pane has it — the strip holds
   * ONE effect with one colour, so switching away and back used to hand the
   * returning effect whatever the last one was set to. Always On can be on
   * Rainbow while every other effect keeps its own custom colour.
   *
   * Its own zone key, so the strip and the board never read each other's
   * settings: they are different hardware with different effect lists.
   */
  const settings = useStore((st) => st.settings);
  const setSettings = useStore((st) => st.setSettings);
  const rememberEffect = async (from: SideLightingSettings) => {
    const next = await sd.setSettings({
      lightingPresets: {
        ...(settings?.lightingPresets ?? {}),
        [presetKey(device.model, SIDE_ZONE, from.effect)]: presetOf({
          ...from,
          zone: 'side',
        } as LightingSettings),
      },
    });
    setSettings(next);
  };
  const withEffect = (from: SideLightingSettings, label: string): SideLightingSettings => {
    void rememberEffect(from);
    return applySidePreset(from, label, recallPreset(settings, device.model, SIDE_ZONE, label));
  };
  // Same edit-then-Apply rule as the Main panes. This zone kept its own
  // auto-write and its own `enabled` toggle, which would have left one tab
  // behaving two different ways depending on which zone you were looking at —
  // and `Off` is already in this list too, so the toggle was the same
  // duplication it was on the Main pane.
  const edit = (next: SideLightingSettings) => setL(next);
  const isOff = cur.effect === 'Off';
  // Same "what the board holds now" state as the Main pane — a successful
  // Apply moves it, so the Modified pill clears instead of contradicting an
  // effect the user can see running on the strip.
  const [written, setWritten] = useState<SideLightingSettings | null>(null);
  const readBoard = () => {
    setWritten(null);
    reload();
  };
  const applied = written ?? loaded;
  const dirty =
    !!applied &&
    JSON.stringify([cur.effect, cur.brightness, cur.speed, cur.color, cur.dazzle]) !==
      JSON.stringify([
        applied.effect,
        applied.brightness,
        applied.speed,
        applied.color,
        applied.dazzle,
      ]);
  /** Resolves whether the strip took it. */
  const apply = async (): Promise<boolean> => {
    setApplying(true);
    const next: SideLightingSettings = { ...cur, enabled: cur.effect !== 'Off' };
    let ok = false;
    await whileBusy(t('busy.lighting'), async () => {
      const r = await run(t('light.apply'), () => sd.setSideLighting(device.id, next));
      ok = r.ok;
      if (r.ok) {
        setWritten(next);
        await rememberEffect(next);
      }
    });
    setApplying(false);
    return ok;
  };
  // Leaving this zone, Lighting or the device's tab loses an edit not applied
  // yet, so they ask first (state/leaveGuard.ts).
  usePendingChange(device.id, {
    dirty,
    label: () => t('leave.what.side', { name: cur.effect }),
    commit: apply,
  });
  // No local <ArtAnchor> here — the LightingTab container below owns the one
  // hero-side art column (keyboard photo + the side-light close-up) for this
  // pane, the same reason MouseLightingContainer owns it for the mouse's own
  // Lighting sub-panes rather than each one wrapping itself in a HeroPane.
  return (
    <>
      <Panel
        title={t('light.side.title')}
        actions={<PanelActions dirty={dirty} busy={applying} onApply={apply} onRead={readBoard} />}
      >
        <div>
          {/* The same visual picker the main lighting pane uses, over the side
              strip's own shorter effect list. A `<select>` here made two
              controls for one concept look like two different kinds of thing,
              and named effects that the tile shows in one glance. */}
          <div className="row row-stack">
            <div className="label">{t('common.effect')}</div>
            <EffectPicker
              value={cur.effect}
              color={cur.color}
              rainbow={!!cur.dazzle}
              effects={SIDE_LIGHT_EFFECTS.map((e) => ({ label: e.name }))}
              // One long LED bar across the front of the case, so its tiles
              // are one continuous rectangle rather than a second keyboard.
              strip
              option={0}
              recall={(label) => recallPreset(settings, device.model, SIDE_ZONE, label)}
              onPick={(label) => edit(withEffect(cur, label))}
            />
          </div>
          {!isOff && (
            /* One line, whatever is selected.
               The explanation used to be a `hint`, which is a second line
               UNDER the label and as wide as its sentence — so the control
               slot was squeezed and adding the picker pushed the row onto two
               lines the moment you chose Custom colour. It is an info dot now.

               Picker first, then the mode, and Custom colour before Rainbow:
               the same left-to-right order as the Global pane's own colour
               row, so the two zones read the same way round. */
            <Row label={<InfoLabel label={t('common.colour')} text={t('light.colourMode.hint')} />}>
              {!cur.dazzle && (
                <ColorPickerField
                  value={rgbToHex(cur.color)}
                  onChange={(hex) => edit({ ...cur, color: hexToRgb(hex) })}
                  ariaLabel={t('common.colour')}
                />
              )}
              <Segmented
                value={cur.dazzle ? 'rainbow' : 'custom'}
                options={[
                  { value: 'custom', label: t('light.colourMode.custom') },
                  { value: 'rainbow', label: t('light.dazzle') },
                ]}
                onChange={(v) => edit({ ...cur, dazzle: v === 'rainbow' })}
              />
            </Row>
          )}
          {!isOff && (
            <Row label={t('common.brightness')} hint={t('light.steps.hint')}>
              <StepSlider
                value={cur.brightness}
                steps={KB_LIGHT_STEPS}
                ariaLabel={t('common.brightness')}
                onChange={(v) => edit({ ...cur, brightness: v })}
              />
            </Row>
          )}
          {!isOff && !!kbEffect(cur.effect)?.speed && (
            <Row label={t('common.speed')} hint={t('light.steps.hint')}>
              <StepSlider
                value={cur.speed}
                steps={KB_LIGHT_STEPS}
                ariaLabel={t('common.speed')}
                onChange={(v) => edit({ ...cur, speed: v })}
              />
            </Row>
          )}
        </div>
      </Panel>
    </>
  );
}

// ---------------------------------------------------------------- mouse: DPI LED
// Neither of these two mouse sub-panes renders its own hero art — the
// container below (MouseLightingContainer) owns one shared art column (hero
// photo + whichever detail shot matches the active pane) so switching
// between them doesn't duplicate or re-fade the mouse photo itself.
function DpiLedPane({ device }: TabProps) {
  const t = useT();
  const {
    data: loaded,
    loading,
    firstLoad,
    reload,
  } = useDeviceData<DpiLedSettings | null>(device.id, sd.readDpiLed, null, [], 'dpiLed');
  // Re-read the device once each write settles, and re-seat the mirror below
  // from that read. Without it this panel showed what was *requested* forever:
  // `setL(next)` is optimistic and `loaded` never changed again, so a value the
  // firmware clamped, ignored, or overrode kept rendering as if it had taken.
  const { queue, commit, flush } = useAutoWrite(250, {
    onSettled: () => reload(),
    deviceId: device.id,
  });
  const [l, setL] = useState<DpiLedSettings | null>(null);
  useEffect(() => setL(loaded), [loaded]);
  if (!loading && loaded === null && l === null) {
    return (
      <Panel>
        <ReadFailed />
      </Panel>
    );
  }
  const cur: DpiLedSettings = l ?? { effect: 1, brightness: 100 };
  const edit = (next: DpiLedSettings, drag?: boolean) => {
    setL(next);
    (drag ? queue : commit)(t('dpiLed.title'), () => sd.setDpiLed(device.id, next));
  };
  // Off (0): neither control. Steady (1): brightness. Breathing (2): speed.
  // Each effect gets exactly the one control it has — a breathing LED sets its
  // own brightness as it pulses, so a brightness slider there controls nothing
  // the user can see.
  return (
    <Panel>
      <div onPointerUp={flush} onBlur={flush}>
        {firstLoad && <Loading />}
        <Row label={t('dpiLed.effect')}>
          <Select
            value={cur.effect}
            options={DPI_LED_EFFECTS.map((o) => ({ value: o.value, label: o.label }))}
            onChange={(v) => edit({ ...cur, effect: Number(v) })}
          />
        </Row>
        {/* `drag` (the second argument) routes these through the debounced
            `queue` rather than an immediate `commit`. Without it every tick of
            a slider drag fired a whole setDpiLed — four writes plus a re-read
            each — and the `onPointerUp={flush}` above was dead code because
            nothing was ever queued to flush. */}
        {cur.effect === 1 && (
          <Row label={t('common.brightness')}>
            <Slider
              value={cur.brightness}
              min={0}
              max={100}
              unit="%"
              ariaLabel={t('common.brightness')}
              onChange={(v) => edit({ ...cur, brightness: v }, true)}
            />
          </Row>
        )}
        {cur.effect === 2 && (
          <Row label={t('common.speed')}>
            <Slider
              value={cur.speed ?? 60}
              min={0}
              max={100}
              unit="%"
              ariaLabel={t('common.speed')}
              onChange={(v) => edit({ ...cur, speed: v }, true)}
            />
          </Row>
        )}
        <p className="hint" style={{ margin: '10px 0 0' }}>
          {t('dpiLed.colourHint')}
        </p>
      </div>
    </Panel>
  );
}

// ---------------------------------------------------------------- mouse: receiver LED
// Values are RX_LED_WIRE (mouse-wire.ts) — the 2026-08-30 capture, which
// corrects the vendor `receiverList` table (it had ConnQuality/PollRate
// swapped).
//
// "DPI level" (wire 4) is deliberately NOT offered: the receiver has no way to
// show a DPI stage usefully. It stays in RX_LED_WIRE because that table is
// also the plausibility gate on a value read back off the hardware (see
// RX_LED_VALUES) — a receiver already set to 4 by the vendor tool must still
// decode, it just cannot be chosen here.
const RX_LED_UNSELECTABLE = new Set([4]);
const RX_LED_OPTIONS = RX_LED_WIRE.filter((o) => !RX_LED_UNSELECTABLE.has(o.value));

/**
 * What each indication's colours mean, drawn as the colours themselves.
 *
 * The thing being explained IS a colour, so naming it in a sentence ("Red
 * 125 Hz · Blue 250 Hz · …") asks the reader to translate back while looking
 * at the actual LED. Values from the receiver's documented behaviour; the
 * labels are numbers and units, so nothing here needs translating.
 */
const RX_LED_KEY: {
  titleKey: 'rxLed.opt.pollRate' | 'rxLed.opt.battery';
  items: { color: string; label: string }[];
}[] = [
  {
    titleKey: 'rxLed.opt.pollRate',
    items: [
      { color: '#ff3b30', label: '125 Hz' },
      { color: '#3b82f6', label: '250 Hz' },
      { color: '#ffd60a', label: '500 Hz' },
      { color: '#ff9500', label: '1000 Hz' },
      { color: '#af52de', label: '2000 Hz' },
      { color: '#34c759', label: '4000 Hz' },
      { color: '#32d0e0', label: '8000 Hz' },
    ],
  },
  {
    titleKey: 'rxLed.opt.battery',
    items: [
      { color: '#34c759', label: '≥ 75%' },
      { color: '#ff9500', label: '< 75%' },
      { color: '#ff3b30', label: '≤ 15%' },
    ],
  },
];

function ReceiverLedKey() {
  const t = useT();
  return (
    <div className="led-key">
      {RX_LED_KEY.map((group) => (
        <div className="led-key-group" key={group.titleKey}>
          <div className="led-key-title">{t(group.titleKey)}</div>
          <div className="led-key-row">
            {group.items.map((it) => (
              <span className="led-key-item" key={it.label}>
                <span className="led-key-dot" style={{ color: it.color }} aria-hidden="true" />
                {it.label}
              </span>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

/**
 * There is no read-failure branch here any more, and that is the point.
 * `readReceiverLed` never returns null: the receiver always answers, so a
 * "Couldn't read this from the device" banner was describing a problem that
 * did not exist. What can be missing is a *confirmed* read command, and that
 * is a different thing to say — see `ReceiverLedSettings.source`.
 */
function ReceiverLedPane({ device }: TabProps) {
  const t = useT();
  const {
    data: loaded,
    firstLoad,
    reload,
  } = useDeviceData<ReceiverLedSettings | null>(
    device.id,
    sd.readReceiverLed,
    null,
    [],
    'receiverLed',
  );
  const { commit } = useAutoWrite(250, { onSettled: () => reload(), deviceId: device.id });
  const [l, setL] = useState<ReceiverLedSettings | null>(null);
  useEffect(() => setL(loaded), [loaded]);
  const cur: ReceiverLedSettings = l ?? { indications: [0, 0, 0], source: 'unreadable' };
  const unread = cur.source === 'unreadable';
  const setLed = (i: 0 | 1 | 2, value: number) => {
    const next: [number, number, number] = [...cur.indications];
    next[i] = value;
    const nextCur: ReceiverLedSettings = { ...cur, indications: next, source: 'lastWrite' };
    setL(nextCur);
    commit(t('rxLed.title'), () => sd.setReceiverLed(device.id, nextCur));
  };
  return (
    <Panel>
      {firstLoad && <Loading inline />}
      {(cur.source === 'lastWrite' || cur.source === 'cache') && (
        <p className="hint" style={{ margin: '0 0 10px' }}>
          {t('rxLed.fromCache')}
        </p>
      )}
      {unread && (
        <p className="hint" style={{ margin: '0 0 10px' }}>
          {t('rxLed.unknown')}
        </p>
      )}
      {([0, 1, 2] as const).map((i) => (
        <Row key={i} label={t('rxLed.led', { n: i + 1 })}>
          {/* While the state is unknown the picker shows a disabled "not
              reported" entry rather than a real option — nothing is displayed
              as if it had been read. Choosing any option writes it and the
              pane switches to showing that. */}
          <Select
            value={unread ? -1 : cur.indications[i]}
            options={[
              ...(unread ? [{ value: -1, label: t('rxLed.unknown.opt') }] : []),
              ...RX_LED_OPTIONS.map((o) => ({ value: o.value, label: t(o.labelKey as never) })),
            ]}
            onChange={(v) => setLed(i, Number(v))}
          />
        </Row>
      ))}
      <ReceiverLedKey />
    </Panel>
  );
}

// -------------------------------------------- mouse: body light strip (future mice)
function BodyLightPane({ device }: TabProps) {
  const t = useT();
  const { data, loading } = useDeviceData<LightingSettings[]>(
    device.id,
    sd.readLighting,
    [],
    [],
    'lighting',
  );
  const { commit } = useAutoWrite(250, { deviceId: device.id });
  const loaded = data.find((z) => z.zone === 'body');
  const [l, setL] = useState<LightingSettings | null>(null);
  useEffect(
    () =>
      setL(
        loaded ?? {
          zone: 'body',
          effect: '1',
          brightness: 80,
          speed: 50,
          color: [61, 248, 232],
          enabled: true,
        },
      ),
    [loaded],
  );
  if (loading) return <Loading />;
  if (!l) return null;
  const set = (p: Partial<LightingSettings>) => {
    const next = { ...l, ...p };
    setL(next);
    commit(t('light.body.title'), () => sd.setLighting(device.id, next));
  };
  return (
    <Panel>
      <Row label={t('common.effect')}>
        <Select
          value={l.effect}
          options={LIGHT_MODES.map((m) => ({ value: String(m.value), label: m.label }))}
          onChange={(v) => set({ effect: v })}
        />
      </Row>
      <Row label={t('common.brightness')}>
        <Slider value={l.brightness} min={0} max={100} onChange={(v) => set({ brightness: v })} />
      </Row>
      <Row label={t('common.speed')}>
        <Slider value={l.speed} min={0} max={100} onChange={(v) => set({ speed: v })} />
      </Row>
      <Row label={t('common.colour')}>
        <ColorField value={l.color} onChange={(color) => set({ color })} />
      </Row>
      <Row label={t('light.body.moveOff')}>
        <Toggle on={!!l.offWhenMoving} onChange={(v) => set({ offWhenMoving: v })} />
      </Row>
      <Row label={t('light.body.offAfter')}>
        <Select
          value={l.offTimeoutSec ?? 0}
          options={[
            { value: 0, label: t('power.never') },
            ...LIGHT_OFF_TIMEOUTS.map((o) => ({ value: o.value * 10, label: o.label })),
          ]}
          onChange={(v) => set({ offTimeoutSec: Number(v) })}
        />
      </Row>
    </Panel>
  );
}

// ---------------------------------------------------------------- container
export function LightingTab({ device }: TabProps) {
  const t = useT();
  const isKeyboard = device.kind === 'keyboard';
  // A mouse's two sub-panes (Receiver LED first, then DPI-indicator LED —
  // reversed from their old order) share ONE hero art column: the mouse
  // photo plus whichever close-up detail shot matches the active pane, so
  // switching between them never re-fades or duplicates the mouse photo
  // itself. That's why this container owns the single ArtAnchor/detail-image
  // pair directly, rather than each sub-pane wrapping itself in a HeroPane.
  if (!isKeyboard) {
    // Each LED's explanation is its tab's tooltip — it used to be the first
    // line of the pane, read once and then in the way.
    const panes: MousePane[] = [];
    if (gate('light.receiver', device))
      panes.push({
        id: 'rxled',
        label: t('rxLed.title'),
        tip: t('rxLed.indication.hint'),
        el: <ReceiverLedPane device={device} />,
        detail: DEVICE_ART_DETAIL[device.ui.artKey]?.receiverLed,
      });
    if (gate('light.dpiLed', device))
      panes.push({
        id: 'dpiled',
        label: t('dpiLed.title'),
        tip: t('dpiLed.hint'),
        el: <DpiLedPane device={device} />,
        detail: DEVICE_ART_DETAIL[device.ui.artKey]?.dpiLed,
      });
    if (gate('light.body', device))
      panes.push({
        id: 'body',
        label: t('light.body.title'),
        el: <BodyLightPane device={device} />,
      });
    return (
      <>
        <Gated id="light.receiver" device={device} />
        <Gated id="light.dpiLed" device={device} />
        <Gated id="light.body" device={device} />
        <MouseLightingContainer
          viewKey={`${device.id}:light.zone`}
          title={t('light.title')}
          sub={t('light.mouse.sub')}
          panes={panes}
        />
      </>
    );
  }

  const panes = useMemo(() => {
    const list: { id: string; label: string; tip: string; el: JSX.Element }[] = [];
    // The effect grid needs a main backlight; painting single keys also needs
    // the slot map (shared/menuGates.ts). A board with only an edge light gets
    // only the Side pane.
    if (gate('light.kbEffects', device))
      list.push({
        id: 'effects',
        label: t('light.zone.main'),
        tip: t('light.zone.main.tip'),
        el: <MainLightingPane device={device} perKeyLighting={gate('light.perKeyPaint', device)} />,
      });
    if (gate('light.side', device))
      list.push({
        id: 'side',
        label: t('light.zone.side'),
        tip: t('light.zone.side.tip'),
        el: <UnderglowPane device={device} />,
      });
    return list;
  }, [device, t]);
  // Kept outside this component, so a profile switch — which remounts every
  // pane to make it re-read the board — leaves you on the zone you were
  // working in. See usePaneView.
  const [active, setActive] = usePaneView(`${device.id}:light.zone`, panes[0]?.id ?? '');
  const cur = panes.find((p) => p.id === active) ?? panes[0];
  // Effects (global + per-key) keeps the board-on-top layout — it's the
  // functional editing surface, not decoration. Side is a plain settings
  // panel, so it gets the same hero-side shell the mouse's Lighting
  // sub-panes use, with the side-light close-up as its detail shot.
  const isSide = cur?.id === 'side';
  const sideLight = DEVICE_ART_DETAIL[device.ui.artKey]?.sideLight;

  return (
    <div className={`pane ${isSide ? 'hero-side is-keyboard' : ''}`}>
      <Gated id="light.kbEffects" device={device} />
      <Gated id="light.perKeyPaint" device={device} />
      <Gated id="light.side" device={device} />
      <PaneHeader
        title={
          panes.length > 1 ? (
            <TitleTabs
              value={cur?.id ?? ''}
              options={panes.map((p) => ({ value: p.id, label: p.label, tip: p.tip }))}
              // Each zone's editor goes when another is shown: ask first.
              onChange={(id) => id !== cur?.id && confirmLeave(device.id, () => setActive(id))}
            />
          ) : (
            t('light.title')
          )
        }
        sub={t('light.keyboard.sub')}
      />
      {isSide ? (
        <>
          <div className={`hero-art-col ${sideLight ? 'has-detail' : ''}`}>
            <ArtAnchor mode="hero" className="art-hero-anchor" />
            {sideLight && (
              <img
                className="led-detail-art"
                src={sideLight}
                alt={t('light.side.title')}
                draggable={false}
              />
            )}
          </div>
          <div className="hero-side-content">{cur?.el}</div>
        </>
      ) : (
        cur?.el
      )}
    </div>
  );
}

/** One LED zone of a mouse's Lighting tab. */
interface MousePane {
  id: string;
  label: string;
  /** What this LED shows — the tab's tooltip. */
  tip?: string;
  el: JSX.Element;
  detail?: string;
}

/**
 * A mouse's Lighting tab: one hero-side layout (see .pane.hero-side in
 * styles.css) shared by both sub-panes — the mouse photo plus the active
 * pane's own close-up detail shot sit in the left column, the zone switcher
 * and the active pane's Panel content sit in the right column.
 */
function MouseLightingContainer({
  viewKey,
  title,
  sub,
  panes,
}: {
  /** Where this container's chosen sub-pane is remembered — see usePaneView.
   *  Held outside the component because a profile switch remounts it, and
   *  which LED you are setting up has nothing to do with which profile. */
  viewKey: string;
  title: string;
  sub: string;
  panes: MousePane[];
}) {
  const [active, setActive] = usePaneView(viewKey, panes[0]?.id ?? '');
  const cur = panes.find((p) => p.id === active) ?? panes[0];
  const detailSrc = cur?.detail;
  // Switching sub-pane swaps the close-up photo beside the hero shot, and the
  // two are different sizes — so the <ArtAnchor> below moves without ever
  // changing its own size. Nothing the anchor watches sees that: its
  // ResizeObserver only fires on its own box, and its capture-phase `load`
  // listener only covers its own descendants, while this <img> is a sibling.
  // The travelling photo therefore kept its old position until an unrelated
  // scroll happened to re-measure it. Announce the move explicitly, both when
  // the pane changes and again once the new image has actually decoded (which
  // is when the column really re-lays-out).
  useEffect(() => requestArtRemeasure(), [active]);
  return (
    <div className="pane hero-side">
      {/* The same header every pane has. With one LED there is no tab to
          carry its own explanation, so it joins the pane's. */}
      <PaneHeader
        title={
          panes.length > 1 ? (
            <TitleTabs
              value={cur?.id ?? ''}
              options={panes.map((p) => ({ value: p.id, label: p.label, tip: p.tip }))}
              onChange={setActive}
            />
          ) : (
            title
          )
        }
        sub={panes.length === 1 && cur?.tip ? `${sub} ${cur.tip}` : sub}
      />
      <div className={`hero-art-col ${detailSrc ? 'has-detail' : ''}`}>
        <ArtAnchor mode="hero" className="art-hero-anchor" />
        {detailSrc && (
          <img
            key={detailSrc}
            className="led-detail-art"
            src={detailSrc}
            alt={cur?.label ?? ''}
            draggable={false}
            onLoad={() => requestArtRemeasure()}
          />
        )}
      </div>
      {/* No selector here any more: it IS the heading above. The pane also
          used to print the chosen zone's name a third time as its Panel
          title — see ReceiverLedPane and friends, which now drop it. */}
      <div className="hero-side-content">{cur?.el}</div>
    </div>
  );
}
