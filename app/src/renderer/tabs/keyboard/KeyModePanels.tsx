import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { type DksZone, EMPTY_DKS_ZONE } from '@shared/dks';
import { KB_TRAVEL_RANGE } from '@shared/keyboard-travel';
import { actionOfQuad, isModTapEntry, legacyModTapHold } from '@shared/key-zones';
import type { TFunc } from '@shared/i18n';
import type { KeyGroup } from '@shared/keys';
import { keyNameForCode } from '../../state/shortcuts';
import type { KeyZoneBindings } from '@shared/types/keyboard-settings';
import type { KeyBinding, KeyLayoutEntry } from '@shared/types/keys';
import type { LiveDevice, WriteResult } from '@shared/types/live';
import { Row, Segmented, Slider, Tooltip } from '../../components/common';
import { Icon } from '../../components/icons';
import { InfoLabel } from '../../components/InfoLabel';
import { ListboxSelect, type ListboxOption } from '../../components/ListboxSelect';
import { sd, useDeviceData } from '../common';
import { useT } from '../../state/i18n';
import { usePendingChange } from '../../state/leaveGuard';
import { factoryCode } from './keyRemapState';
import { boardKeyGroups, keyForUsage, usageOf } from './boardKeys';
import {
  DKS_POINTS,
  choiceAt,
  choiceLabel,
  choiceTip,
  choicesAt,
  freePoints,
  rowFires,
  rowSpans,
  seedRow,
  seedZones,
  withChoice,
  type DksChoice,
  type DksPoint,
} from './dksGrid';
import { KeyPicker } from './KeyPicker';
import {
  DKS_DEFAULT_POINT_MM,
  MODE_DEFS,
  MT_HOLD,
  MT_HOLD_ZONE,
  MT_TAP_ZONE,
  keyIdOf,
  partnerOf,
  planModeChange,
  planPair,
  planUnpair,
  toggleMode,
  toggleStyleOf,
  type KeyMap,
  type KeyRef,
  type ModeChoice,
  type Plan,
  type ToggleStyle,
} from './magneticModes';
import { KeyCap, usageFace } from './remapKeyFace';

/**
 * The Actuation tab's Mode row and the panel under it for each mode that
 * needs more than a mode byte: who a snap-tap key is paired with, a toggle's
 * style, a mod-tap key's hold, a DKS key's actions.
 *
 * Kept out of MagneticSection, which owns the board, the selection and the
 * writes; everything here works through `ModeContext`.
 */

export interface ModeContext {
  device: LiveDevice;
  /** Every key on the board, defaults standing in for any not yet read. */
  map: KeyMap;
  /** The board's keys: what each is called and what it sends. */
  layout: KeyLayoutEntry[];
  /** The key the panel is about — the selection's first. */
  anchor: KeyRef;
  selected: readonly KeyRef[];
  /** The anchor's firmware matrix slot. */
  slot: number | null;
  labelOf: (k: KeyRef) => string;
  colorOf: (k: KeyRef) => string | undefined;
  /** Write a plan: the board shows it at once, then the keyboard gets it. */
  /** Resolves the write's result, or nothing when the plan was empty. */
  applyPlan: (label: string, plan: Plan) => Promise<WriteResult | void>;
  /** Any other write, reported like every write on this tab. */
  write: (label: string, fn: () => Promise<WriteResult>) => Promise<WriteResult>;
}

/** The panel's key by what it types — "Caps Lock", as Remap names it — for
 *  the leave prompt (state/leaveGuard.ts). */
function keyNameOf(ctx: ModeContext): string {
  const entry = ctx.layout.find((e) => e.row === ctx.anchor.row && e.col === ctx.anchor.col);
  const code = factoryCode(entry);
  return code ? keyNameForCode(code) : ctx.labelOf(ctx.anchor);
}

/** The tag on anything not yet confirmed on hardware. `bare` inside a list
 *  option, whose own tooltip already says so (`act.exp.note`). */
export function ExperimentalTag({ bare }: { bare?: boolean }) {
  const t = useT();
  const tag = <span className="pill warn exp-tag">{t('act.exp.tag')}</span>;
  return bare ? (
    tag
  ) : (
    <Tooltip text={t('act.exp.note')}>
      <span tabIndex={0} className="exp-tag-wrap">
        {tag}
      </span>
    </Tooltip>
  );
}

/** The Mode row: every mode the board has, each explaining itself. */
export function ModeRow({
  ctx,
  value,
  onChoose,
}: {
  ctx: ModeContext;
  /** null: the selected keys are in different modes. */
  value: ModeChoice | null;
  onChoose: (c: ModeChoice) => void;
}) {
  const t = useT();
  const n = ctx.selected.length;
  const options: ListboxOption<ModeChoice>[] = MODE_DEFS.filter(
    (m) => !m.cap || ctx.device.capabilities.includes(m.cap),
  ).map((m) => {
    const why =
      m.value === 'snap' && n > 2
        ? t('act.mode.why.snap')
        : (m.value === 'mt' || m.value === 'dks') && n !== 1
          ? t('act.mode.why.single')
          : null;
    return {
      value: m.value,
      label: t(m.labelKey),
      tip: [t(m.tipKey), why, m.experimental ? t('act.exp.note') : null]
        .filter(Boolean)
        .join('\n\n'),
      disabled: !!why,
      badge: m.experimental ? <ExperimentalTag bare /> : undefined,
    };
  });
  return (
    <Row label={<InfoLabel label={t('act.mode.title')} text={t('act.mode.tip')} />}>
      <ListboxSelect
        value={value}
        options={options}
        onChange={onChoose}
        placeholder={t('act.mode.mixed')}
        ariaLabel={t('act.mode.title')}
      />
    </Row>
  );
}

// ---------------------------------------------------------------- snap-tap

/**
 * The partner is picked in the key chooser, from this board's keys (so a key
 * can be typed to pick it, as anywhere else a key is asked for). It used to
 * be a click on the board above, which was also the selection gesture: the
 * board changed meaning for one click, with nothing on it to say so.
 */
export function SnapTapPanel({
  ctx,
  draft,
  onDone,
}: {
  ctx: ModeContext;
  /** Snap-tap chosen in the Mode list, no partner yet: nothing is written
   *  until one is picked. */
  draft: boolean;
  onDone: () => void;
}) {
  const t = useT();
  const me = ctx.map[keyIdOf(ctx.anchor)];
  const partner = partnerOf(ctx.map, ctx.anchor);
  const groups = useMemo(() => boardKeyGroups(ctx.layout, ctx.anchor), [ctx.layout, ctx.anchor]);
  // The chooser answers with a usage; the plan wants the key that sends it.
  const pair = (usage: string | null) => {
    const ref = usage === null ? null : keyForUsage(ctx.layout, usage, ctx.anchor);
    if (!ref) return;
    void ctx.applyPlan(t('act.snap.pair'), planPair(ctx.map, ctx.anchor, ref));
    onDone();
  };
  const unpair = () =>
    void ctx.applyPlan(t('act.snap.unpairLabel'), planUnpair(ctx.map, ctx.anchor));
  const chooser = (value: string | null) => (
    <KeyChooser value={value} label={t('act.snap.partnerKey')} groups={groups} onChange={pair} />
  );

  if (!me) return null;

  if (me.mode !== 'snap') {
    if (!draft) return null;
    return (
      <Row label={t('act.snap.partner')} hint={t('act.snap.partner.hint')}>
        <span className="mode-inline">
          {chooser(null)}
          <button className="btn" onClick={onDone}>
            {t('common.cancel')}
          </button>
        </span>
      </Row>
    );
  }

  if (!partner) {
    const named = me.socdPartner ? ctx.map[keyIdOf(me.socdPartner)] : undefined;
    return (
      <Row
        label={t('act.snap.partner')}
        hint={
          named
            ? t('act.snap.half.named', {
                key: ctx.labelOf(ctx.anchor),
                partner: ctx.labelOf(named),
              })
            : t('act.snap.half.none')
        }
      >
        <span className="mode-inline">
          <span className="pill warn">{t('act.snap.half')}</span>
          {chooser(named ? usageOf(ctx.layout, named) : null)}
          {named && (
            <button
              className="btn"
              onClick={() =>
                void ctx.applyPlan(t('act.snap.pair'), planPair(ctx.map, ctx.anchor, named))
              }
            >
              {t('act.snap.repair', { key: ctx.labelOf(named) })}
            </button>
          )}
          <button className="btn" onClick={unpair}>
            {t('act.snap.unpair')}
          </button>
        </span>
      </Row>
    );
  }

  return (
    <Row label={t('act.snap.pairedWith')} hint={t('act.snap.pairedWith.hint')}>
      <span className="mode-inline">
        {chooser(usageOf(ctx.layout, partner))}
        <button className="btn" onClick={unpair}>
          {t('act.snap.unpair')}
        </button>
      </span>
    </Row>
  );
}

// ---------------------------------------------------------------- toggle

export function TogglePanel({ ctx }: { ctx: ModeContext }) {
  const t = useT();
  const me = ctx.map[keyIdOf(ctx.anchor)];
  const style = toggleStyleOf(me?.mode);
  return (
    <Row
      label={t('act.toggle.style')}
      hint={style === 'repeat' ? t('act.toggle.repeat.hint') : t('act.toggle.hold.hint')}
    >
      <Segmented<ToggleStyle>
        value={style}
        options={[
          { value: 'hold', label: t('act.toggle.hold') },
          { value: 'repeat', label: t('act.toggle.repeat') },
        ]}
        onChange={(v) =>
          void ctx.applyPlan(
            t('act.toggle.styleLabel'),
            planModeChange(ctx.map, ctx.selected, toggleMode(v)),
          )
        }
      />
    </Row>
  );
}

// ---------------------------------------------------------------- bindings

/** The zone bindings this computer has written to the board. */
function useZoneBindings(deviceId: string) {
  const [zones, setZones] = useState<KeyZoneBindings | null>(null);
  const load = useCallback(() => {
    sd.readKeyZoneBindings(deviceId)
      .then(setZones)
      .catch(() => setZones(null));
  }, [deviceId]);
  useEffect(load, [load]);
  return [zones, load] as const;
}

/** What Tab moves between inside the chooser — ModalFrame's list, kept in step
 *  by hand (components/common.tsx does not export it). */
const FOCUSABLE =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * A key to bind, chosen from the Remap tab's picker in a centred dialog on the
 * app's modal pattern (`.modal-scrim` / `.modal`, see ModalFrame). `value` is
 * a HID usage (hex) or null for none; `groups` narrows the picker to some of
 * the keys (the snap-tap partner can only be a key on this board).
 *
 * It used to be a popover anchored under its button, 560 px wide, and each
 * group's keys sat beside the group's name on one line: the Letters row was
 * wider than the popover, which scrolled sideways. Centred, the picker has
 * the room it needs and its rows stack (KeyPicker), so it only ever scrolls
 * down.
 */
export function KeyChooser({
  value,
  onChange,
  label,
  allowNone,
  groups,
}: {
  value: string | null;
  onChange: (code: string | null) => void;
  label: string;
  allowNone?: boolean;
  groups?: readonly KeyGroup[];
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  // Focus moves into the dialog on open — which is also what lets a key
  // pressed reach the picker while the Actuation tab is in test mode, and
  // what keeps the tab's own Escape (drop the selection) out of it — Tab
  // stays inside, Escape closes it, and focus goes back to the button it came
  // from. The scrim closes it on a press, in the markup below.
  useEffect(() => {
    if (!open) return;
    panelRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        setOpen(false);
        return;
      }
      if (e.key !== 'Tab' || !panelRef.current) return;
      const items = [...panelRef.current.querySelectorAll<HTMLElement>(FOCUSABLE)];
      if (!items.length) return;
      const first = items[0]!;
      const last = items[items.length - 1]!;
      const inside = panelRef.current.contains(document.activeElement);
      if (e.shiftKey && (document.activeElement === first || !inside)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (document.activeElement === last || !inside)) {
        e.preventDefault();
        first.focus();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      const btn = btnRef.current;
      if (btn?.isConnected) btn.focus();
    };
  }, [open]);

  const name = value ? keyNameForCode(value) : '';
  const choose = (code: string | null) => {
    onChange(code);
    setOpen(false);
  };
  return (
    <>
      <button
        ref={btnRef}
        className="btn key-chooser"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={value ? `${label}: ${name}` : label}
        onClick={() => setOpen((v) => !v)}
      >
        {value ? (
          <KeyCap label={name} face={usageFace(parseInt(value, 16), name)} small />
        ) : (
          <span className="key-chooser-none">{t('act.chooser.choose')}</span>
        )}
        <Icon name="arrowDown" size={11} />
      </button>
      {open &&
        createPortal(
          // `keeps-selection`: the Actuation tab drops its key selection on a
          // press anywhere outside the selection's own UI, and the scrim
          // covers the whole window — closing the chooser by clicking beside
          // it must not also lose the key it was opened for.
          <div className="modal-scrim keeps-selection" onMouseDown={() => setOpen(false)}>
            <div
              ref={panelRef}
              role="dialog"
              aria-modal="true"
              aria-label={label}
              tabIndex={-1}
              className="modal key-chooser-panel"
              onMouseDown={(e) => e.stopPropagation()}
            >
              <div className="key-chooser-head">
                <h4>{label}</h4>
                {allowNone && (
                  <button className="btn" onClick={() => choose(null)}>
                    <Icon name="close" size={11} /> {t('act.chooser.none')}
                  </button>
                )}
              </div>
              <KeyPicker isOn={(code) => code === value} onPick={choose} listen groups={groups} />
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}

// ---------------------------------------------------------------- mod-tap

/**
 * A tap as a keycap: the usage's own face where it is a plain key, its name
 * from the base layer otherwise.
 */
function tapCap(tap: string, binding: KeyBinding | undefined, color: string | undefined) {
  const usage = /^[0-9a-f]{1,4}$/i.test(tap) ? parseInt(tap, 16) : null;
  const name =
    usage !== null ? keyNameForCode(tap) : (binding?.shortLabel ?? binding?.label ?? tap);
  return (
    <KeyCap
      label={name}
      face={usage !== null ? usageFace(usage, name) : undefined}
      color={color}
      small
    />
  );
}

export function ModTapPanel({
  ctx,
  draft,
  onDone,
}: {
  ctx: ModeContext;
  /** Not yet a mod-tap key: chosen in the Mode list, waiting for Apply. */
  draft: boolean;
  onDone: () => void;
}) {
  const t = useT();
  const me = ctx.map[keyIdOf(ctx.anchor)];
  const [zones, reloadZones] = useZoneBindings(ctx.device.id);
  const entry = ctx.slot === null ? undefined : zones?.[ctx.slot];
  // What the key types — its tap. The firmware fires zone 0 on a HOLD, so a
  // mod-tap key's own binding is moved to zone 1 and its hold takes zone 0
  // (shared/key-zones.ts). A key that is already mod-tap has its tap in the
  // record; any other key has it where every key does, in its base binding —
  // read through the Remap tab's cache, so it is usually there already.
  const { data: base } = useDeviceData<Record<number, KeyBinding> | null>(
    ctx.device.id,
    (id) => sd.readKeyBindings(id, 'base'),
    null,
    [],
    'keyBindings:base',
  );
  const binding = ctx.slot === null ? undefined : base?.[ctx.slot];
  const tap = isModTapEntry(entry)
    ? entry![MT_TAP_ZONE]!
    : binding
      ? actionOfQuad(binding.raw)
      : null;
  // The hold this computer last wrote — including one recorded the old way
  // round, so a key set up before the fix opens with its hold chosen.
  const recorded = isModTapEntry(entry)
    ? entry![MT_HOLD_ZONE]!
    : me?.mode === 'mt'
      ? legacyModTapHold(entry)
      : null;
  const [hold, setHold] = useState<string | null>(null);
  const [ms, setMs] = useState(me?.mtHoldMs ?? MT_HOLD.default);
  useEffect(() => {
    if (recorded) setHold((h) => h ?? recorded);
  }, [recorded]);

  /** Resolves whether both writes landed. */
  const apply = async (): Promise<boolean> => {
    if (!hold || !tap || ctx.slot === null) return false;
    const zonesOut: Array<string | null> = [];
    zonesOut[MT_HOLD_ZONE] = hold;
    zonesOut[MT_TAP_ZONE] = tap;
    const r = await ctx.write(t('act.mt.writeKeys'), () =>
      sd.setKeyZoneBindings(ctx.device.id, ctx.slot!, zonesOut),
    );
    if (!r.ok) return false;
    const plan = await ctx.applyPlan(
      t('act.mode.mt'),
      planModeChange(ctx.map, [ctx.anchor], 'mt').map((k) => ({ ...k, mtHoldMs: ms })),
    );
    reloadZones();
    onDone();
    return plan?.ok !== false;
  };

  // A hold chosen and not applied — a new mod-tap key, or a change to one —
  // goes with the selection or the tab, so leaving asks (state/leaveGuard.ts).
  usePendingChange(ctx.device.id, {
    dirty: draft
      ? hold !== null
      : hold !== null && (hold !== recorded || ms !== (me?.mtHoldMs ?? MT_HOLD.default)),
    label: () => t('leave.what.mode', { mode: t('act.mode.mt'), key: keyNameOf(ctx) }),
    commit: hold && tap && ctx.slot !== null ? apply : undefined,
  });

  return (
    <>
      <Row label={t('act.mt.tap')} hint={tap ? t('act.mt.tap.hint') : t('act.mt.tap.reading')}>
        <span className="mode-inline">
          {tap ? (
            tapCap(tap, binding, ctx.colorOf(ctx.anchor))
          ) : (
            <span className="mode-pick-slot" aria-hidden="true">
              …
            </span>
          )}
        </span>
      </Row>
      <Row label={t('act.mt.hold')} hint={t('act.mt.hold.hint')}>
        <KeyChooser value={hold} onChange={setHold} label={t('act.mt.holdKey')} />
      </Row>
      <Row label={t('act.mt.holdTime')} hint={t('act.mt.holdTime.hint')}>
        <Slider
          value={ms}
          min={MT_HOLD.min}
          max={MT_HOLD.max}
          step={MT_HOLD.step}
          unit=" ms"
          onChange={setMs}
        />
      </Row>
      <Row label={null}>
        <span className="mode-inline">
          <button
            className="btn primary"
            disabled={!hold || !tap || ctx.slot === null}
            onClick={() => void apply()}
          >
            <Icon name="upload" size={12} /> {t('common.apply')}
          </button>
          {draft && (
            <button className="btn" onClick={onDone}>
              {t('common.cancel')}
            </button>
          )}
        </span>
      </Row>
    </>
  );
}

// ---------------------------------------------------------------- DKS

/** One element of a row's track: a span (`rowSpans`) or a free point. */
interface DksCell {
  from: DksPoint;
  to: DksPoint;
  kind: 'tap' | 'hold' | 'empty';
  tapAtEnd?: boolean;
}

/** A row as drawn: its spans, and an empty cell at each point they leave. */
function trackOf(z: DksZone): DksCell[] {
  const cells: DksCell[] = [
    ...rowSpans(z),
    ...freePoints(z).map((p) => ({ from: p, to: p, kind: 'empty' as const })),
  ];
  return cells.sort((a, b) => a.from - b.from);
}

/** What a cell reads. The menu says "Tap here"; the cell, with less room,
 *  says "Tap" and shows the dot the legend explains. */
function faceOf(cell: DksCell, t: TFunc) {
  if (cell.kind === 'empty') return '—';
  if (cell.kind === 'tap')
    return (
      <>
        <i className="dks-dot" aria-hidden="true" />
        {t('act.dks.face.tap')}
      </>
    );
  const point = t(DKS_POINTS[cell.to].label);
  return t(cell.tapAtEnd ? 'act.dks.face.holdTap' : 'act.dks.face.hold', { point });
}

/** The centre of each point's column, as a share of the track's width. */
const DKS_X = ['12.5%', '37.5%', '62.5%', '87.5%'] as const;

/**
 * The stroke, drawn over the grid's columns: down through Press to the
 * Bottom, along it to Lift, back up through Release, the DKS point a dashed
 * line across. Positions are percentages of the width so the drawing follows
 * the columns at any width — a stretched viewBox would pull the dots into
 * ovals.
 */
function DksDiagram() {
  const t = useT();
  const top = 4;
  const line = 20;
  const bottom = 42;
  return (
    <svg className="dks-diagram" width="100%" height="48" aria-hidden="true" focusable="false">
      <line className="dks-diagram-point" x1="0" x2="100%" y1={line} y2={line} />
      <text className="dks-diagram-label" x="25%" y={line - 4} textAnchor="middle">
        {t('act.dks.point')}
      </text>
      <line className="dks-diagram-stroke" x1={DKS_X[0]} x2={DKS_X[0]} y1={top} y2={bottom} />
      <line className="dks-diagram-stroke" x1={DKS_X[0]} x2={DKS_X[3]} y1={bottom} y2={bottom} />
      <line className="dks-diagram-stroke" x1={DKS_X[3]} x2={DKS_X[3]} y1={bottom} y2={top} />
      {/* A nested svg takes a percentage position; a path on its own cannot. */}
      <svg x={DKS_X[0]} y={top + 9} width="1" height="1" overflow="visible">
        <path className="dks-diagram-arrow" d="M-3.5 -3.5 L0 0 L3.5 -3.5" />
      </svg>
      <svg x={DKS_X[3]} y={top + 5} width="1" height="1" overflow="visible">
        <path className="dks-diagram-arrow" d="M-3.5 3.5 L0 0 L3.5 3.5" />
      </svg>
      <circle className="dks-diagram-dot" cx={DKS_X[0]} cy={line} r="3.5" />
      <circle className="dks-diagram-dot" cx={DKS_X[1]} cy={bottom} r="3.5" />
      <circle className="dks-diagram-dot" cx={DKS_X[2]} cy={bottom} r="3.5" />
      <circle className="dks-diagram-dot" cx={DKS_X[3]} cy={line} r="3.5" />
    </svg>
  );
}

export function DksPanel({
  ctx,
  draft,
  onDone,
}: {
  ctx: ModeContext;
  draft: boolean;
  onDone: () => void;
}) {
  const t = useT();
  const me = ctx.map[keyIdOf(ctx.anchor)];
  const [zones, reloadZones] = useZoneBindings(ctx.device.id);
  const recorded = ctx.slot === null ? null : (zones?.[ctx.slot] ?? null);
  const [point, setPoint] = useState(me?.dksPointMm ?? DKS_DEFAULT_POINT_MM);
  // A key that is DKS already opens on its own rows; a new one on the seeds
  // (dksGrid.ts) rather than an empty grid, which applied as nothing at all.
  const [rows, setRows] = useState<DksZone[]>(() =>
    me?.mode === 'dks' && me.dksZones?.length === 4 ? me.dksZones : seedZones(),
  );
  /** Actions 2-4; action 1 is the key's own binding, set in Remap. */
  const [actions, setActions] = useState<Array<string | null>>([null, null, null]);
  useEffect(() => {
    if (recorded)
      setActions((a) =>
        a.every((x) => x === null) ? [1, 2, 3].map((z) => recorded[z] || null) : a,
      );
  }, [recorded]);

  const bound = (row: number) => row === 0 || !!actions[row - 1];
  const setRow = (row: number, fn: (z: DksZone) => DksZone) =>
    setRows((rs) => rs.map((z, i) => (i === row ? fn(z) : z)));
  /** Action 2-4 bound or unbound. A row just bound starts as a tap at its
   *  own point, which is where the vendor app fires it; an unbound row fires
   *  nowhere. */
  const bind = (row: number, code: string | null) => {
    setActions((a) => a.map((x, i) => (i === row - 1 ? code : x)));
    setRow(row, (z) => (!code ? { ...EMPTY_DKS_ZONE } : rowFires(z) ? z : seedRow(row)));
  };

  /** Resolves whether both writes landed. */
  const apply = async (): Promise<boolean> => {
    if (ctx.slot === null) return false;
    // Bindings first, then the zone flags — the vendor's own order, and the
    // likely reason a bare zone-flag write does nothing on this firmware.
    const r = await ctx.write(t('act.dks.writeActions'), () =>
      sd.setKeyZoneBindings(ctx.device.id, ctx.slot!, [null, ...actions.map((a) => a ?? '')]),
    );
    if (!r.ok) return false;
    const plan = await ctx.applyPlan(
      t('act.dks.writeMode'),
      planModeChange(ctx.map, [ctx.anchor], 'dks').map((k) => ({
        ...k,
        dksPointMm: point,
        dksZones: rows.map((z, i) => (bound(i) ? z : { ...EMPTY_DKS_ZONE })),
      })),
    );
    reloadZones();
    onDone();
    return plan?.ok !== false;
  };

  // A key just turned DKS here, or one whose rows, actions or point were
  // changed, is lost with the selection or the tab — so leaving asks
  // (state/leaveGuard.ts). Compared against what the key opened on.
  const openedRows = me?.mode === 'dks' && me.dksZones?.length === 4 ? me.dksZones : null;
  const openedActions = recorded ? [1, 2, 3].map((z) => recorded[z] || null) : [null, null, null];
  usePendingChange(ctx.device.id, {
    dirty:
      draft ||
      point !== (me?.dksPointMm ?? DKS_DEFAULT_POINT_MM) ||
      (openedRows !== null && JSON.stringify(rows) !== JSON.stringify(openedRows)) ||
      JSON.stringify(actions) !== JSON.stringify(openedActions),
    label: () => t('leave.what.mode', { mode: t('act.mode.dks'), key: keyNameOf(ctx) }),
    commit: ctx.slot !== null ? apply : undefined,
  });

  return (
    <>
      <Row label={<InfoLabel label={t('act.dks.point')} text={t('act.dks.point.tip')} />}>
        <Slider
          value={point}
          min={KB_TRAVEL_RANGE.travel.min}
          max={KB_TRAVEL_RANGE.travel.max}
          step={KB_TRAVEL_RANGE.travel.step}
          unit=" mm"
          onChange={setPoint}
        />
      </Row>
      <div className="dks-grid" role="group" aria-label={t('act.dks.aria')}>
        <span className="dks-grid-corner" />
        <DksDiagram />
        <span className="dks-grid-corner" />
        <div className="dks-track">
          {DKS_POINTS.map((p) => (
            <Tooltip key={p.label} text={t(p.tip)}>
              <span className="dks-grid-point" tabIndex={0}>
                <span>{t(p.label)}</span>
                <span className="dks-grid-caption">{t(p.caption)}</span>
              </span>
            </Tooltip>
          ))}
        </div>
        {rows.map((z, row) => (
          <Fragment key={row}>
            <span className="dks-grid-action">
              {row === 0 ? (
                <Tooltip text={t('act.dks.action1.tip')}>
                  <span tabIndex={0}>
                    <KeyCap label={ctx.labelOf(ctx.anchor)} color={ctx.colorOf(ctx.anchor)} small />
                  </span>
                </Tooltip>
              ) : (
                <KeyChooser
                  value={actions[row - 1] ?? null}
                  onChange={(code) => bind(row, code)}
                  label={t('act.dks.action', { n: row + 1 })}
                  allowNone
                />
              )}
            </span>
            <div className="dks-track">
              {trackOf(z).map((cell) => (
                // A hold is one element across the points it covers: those
                // points have no cell of their own.
                <div
                  key={cell.from}
                  className="dks-slot"
                  style={{ gridColumn: `${cell.from + 1} / ${cell.to + 2}` }}
                >
                  <ListboxSelect<DksChoice>
                    value={choiceAt(z, cell.from)}
                    options={choicesAt(z, cell.from).map((c) => ({
                      value: c,
                      label: choiceLabel(c, t),
                      tip: choiceTip(c, cell.from, t),
                    }))}
                    onChange={(c) => setRow(row, (r) => withChoice(r, cell.from, c))}
                    ariaLabel={t('act.dks.actionAt', {
                      n: row + 1,
                      point: t(DKS_POINTS[cell.from].label),
                    })}
                    className={`dks-cell is-${cell.kind}${cell.tapAtEnd ? ' has-tap-end' : ''}`}
                    face={faceOf(cell, t)}
                    disabled={!bound(row)}
                  />
                </div>
              ))}
            </div>
          </Fragment>
        ))}
        <p className="kb-legend dks-legend">
          <span className="kb-legend-item">
            <i className="dks-dot" aria-hidden="true" />
            {t('act.dks.legend.tap')}
          </span>
          <span className="kb-legend-item">
            <i className="dks-legend-bar" aria-hidden="true" />
            {t('act.dks.legend.hold')}
          </span>
          <span className="kb-legend-item">
            <span className="dks-legend-none" aria-hidden="true">
              —
            </span>
            {t('act.dks.legend.none')}
          </span>
          <span className="kb-legend-item">{t('act.dks.legend.pick')}</span>
        </p>
      </div>
      <Row label={null}>
        <span className="mode-inline">
          <button className="btn primary" disabled={ctx.slot === null} onClick={() => void apply()}>
            <Icon name="upload" size={12} /> {t('common.apply')}
          </button>
          {draft && (
            <button className="btn" onClick={onDone}>
              {t('common.cancel')}
            </button>
          )}
        </span>
      </Row>
    </>
  );
}
