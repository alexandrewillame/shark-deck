import { Fragment, useState } from 'react';
import type { MacroLimits } from '@shared/types/live';
import { Tooltip } from '../common';
import { Icon } from '../icons';
import { useT } from '../../state/i18n';
import { MacroStepRow } from './MacroStepRow';
import { KeyPicker } from './KeyPicker';
import { StepInserter, DEFAULT_WAIT_MS } from './StepInserter';
import { DRAG_STEP, DRAG_TAKE, dragHas } from './dnd';
import {
  MOUSE_BUTTONS,
  encodedStepCount,
  formatDuration,
  groupsDuration,
  newUid,
  tapGroup,
  waitGroup,
  type MacroGroup,
} from './macroUtils';

/**
 * The step timeline plus its capacity meter and add-step controls.
 *
 * The meter matters because both onboard slots are small (63 records on the
 * keyboard, 76 on the V8) and both codecs *silently truncate* past that — the
 * old editor let you build a 200-step macro and only lose the tail at push
 * time, with nothing on screen to say so.
 *
 * Every seam between rows is a `<StepInserter>`: click it to add a step there,
 * or drop a dragged row or a recorded take on it. Rows themselves are drag
 * *sources* only, so a drop always lands between two rows rather than "on" one,
 * and there is never a question of which side of the target it went.
 */
export function MacroStepList({
  groups,
  limits,
  take,
  onChange,
  onTakeUsed,
}: {
  groups: MacroGroup[];
  limits: MacroLimits | undefined;
  /** the recorded take waiting to be placed, if any — dropped onto a seam */
  take: MacroGroup[] | null;
  onChange: (next: MacroGroup[]) => void;
  onTakeUsed: () => void;
}) {
  const t = useT();
  const [pickOpen, setPickOpen] = useState(false);
  const [openAt, setOpenAt] = useState<number | null>(null);
  const [dragIdx, setDragIdx] = useState<number | null>(null);
  const [overSeam, setOverSeam] = useState<number | null>(null);

  const used = encodedStepCount(groups, limits);
  const max = limits?.maxSteps ?? 0;
  const over = max > 0 && used > max;
  const near = max > 0 && !over && used > max * 0.85;
  const unsupported = groups.filter((g) => g.kind === 'move').length;

  const mut = (fn: (g: MacroGroup[]) => MacroGroup[]) => onChange(fn([...groups]));

  const move = (i: number, dir: -1 | 1) =>
    mut((g) => {
      const j = i + dir;
      if (j < 0 || j >= g.length) return g;
      [g[i], g[j]] = [g[j]!, g[i]!];
      return g;
    });

  /** Move row `from` to sit at seam `seam` (the gap before row `seam`). */
  const reorder = (from: number, seam: number) =>
    mut((g) => {
      const to = seam > from ? seam - 1 : seam;
      if (from === to) return g;
      const [item] = g.splice(from, 1);
      g.splice(to, 0, item!);
      return g;
    });

  const insertAt = (seam: number, added: MacroGroup[]) =>
    onChange([...groups.slice(0, seam), ...added, ...groups.slice(seam)]);

  const append = (g: MacroGroup) => onChange([...groups, g]);

  const endDrag = () => {
    setDragIdx(null);
    setOverSeam(null);
  };

  const seamProps = (seam: number) => ({
    open: openAt === seam,
    dropOver: overSeam === seam,
    onOpen: () => setOpenAt(seam),
    onClose: () => setOpenAt(null),
    onAdd: (added: MacroGroup[]) => insertAt(seam, added),
    onDragOver: (e: React.DragEvent) => {
      if (!dragHas(e.dataTransfer, DRAG_STEP) && !dragHas(e.dataTransfer, DRAG_TAKE)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      setOverSeam(seam);
    },
    onDragLeave: () => setOverSeam((v) => (v === seam ? null : v)),
    onDrop: (e: React.DragEvent) => {
      e.preventDefault();
      if (dragHas(e.dataTransfer, DRAG_TAKE) && take) {
        insertAt(
          seam,
          take.map((g) => ({ ...g, uid: newUid() })),
        );
        onTakeUsed();
      } else if (dragIdx !== null) {
        reorder(dragIdx, seam);
      }
      endDrag();
    },
  });

  return (
    <div className="macro-steps-pane">
      <div className="macro-steps-head">
        <h4>{t('macro.steps.title')}</h4>
        {groups.length > 0 && (
          <span className="macro-steps-meta">
            {formatDuration(groupsDuration(groups))}
            {max > 0 && (
              <>
                <span className="dot-sep">·</span>
                <Tooltip text={t('macro.steps.capacity.tip')}>
                  <span className={over ? 'over' : near ? 'near' : ''}>
                    {t('macro.steps.capacity', { used, max })}
                  </span>
                </Tooltip>
              </>
            )}
          </span>
        )}
      </div>

      {max > 0 && groups.length > 0 && (
        <div className={`macro-capacity${over ? ' over' : near ? ' near' : ''}`}>
          <span style={{ width: `${Math.min(100, (used / max) * 100)}%` }} />
        </div>
      )}
      {over && <div className="macro-note err">{t('macro.steps.over', { n: used - max })}</div>}
      {near && <div className="macro-note warn">{t('macro.steps.near')}</div>}
      {unsupported > 0 && (
        <div className="macro-note warn">
          {t('macro.step.unsupported')}{' '}
          <button
            className="linklike"
            onClick={() => onChange(groups.filter((g) => g.kind !== 'move'))}
          >
            {t('macro.step.removeUnsupported')}
          </button>
        </div>
      )}

      {/* `armed` fattens the insert seams: a 12px target is fine to click but
          fiddly to drop on, and while a take is waiting the seams double as
          the "drop it here" affordance. */}
      <ol
        className={`macro-steps${groups.length === 0 ? ' is-empty' : ''}${
          dragIdx !== null || take ? ' armed' : ''
        }`}
      >
        {groups.length === 0 && openAt === null && (
          <li className="macro-steps-empty">
            <button className="empty" onClick={() => setOpenAt(0)}>
              {t('macro.steps.empty')}
            </button>
          </li>
        )}
        <StepInserter key="seam-0" {...seamProps(0)} />
        {groups.map((g, i) => (
          <Fragment key={g.uid}>
            <MacroStepRow
              group={g}
              index={i}
              dragging={dragIdx === i}
              onChange={(next) => mut((arr) => ((arr[i] = next), arr))}
              onDelete={() => onChange(groups.filter((_, j) => j !== i))}
              onDuplicate={() =>
                onChange([
                  ...groups.slice(0, i + 1),
                  { ...g, uid: newUid() },
                  ...groups.slice(i + 1),
                ])
              }
              onMove={(dir) => move(i, dir)}
              onSplit={() =>
                onChange([
                  ...groups.slice(0, i),
                  { ...g, kind: 'press', holdMs: 0 },
                  // The hold becomes a real pause between the two halves, which
                  // is what it always was — now visible rather than implied.
                  ...(g.holdMs > 0 ? [waitGroup(g.holdMs)] : []),
                  { ...g, uid: newUid(), kind: 'release', holdMs: 0 },
                  ...groups.slice(i + 1),
                ])
              }
              onDragStart={(e) => {
                e.dataTransfer.effectAllowed = 'move';
                e.dataTransfer.setData(DRAG_STEP, String(i));
                setDragIdx(i);
              }}
              onDragEnd={endDrag}
            />
            <StepInserter {...seamProps(i + 1)} />
          </Fragment>
        ))}
      </ol>

      <div className="macro-add">
        <Tooltip text={t('macro.addKey.tip')}>
          <button className="btn" onClick={() => setPickOpen((v) => !v)} aria-expanded={pickOpen}>
            <Icon name="plus" size={12} /> {t('macro.addKey')}
          </button>
        </Tooltip>
        <div className="macro-add-mouse">
          <Tooltip text={t('macro.addMouse.tip')}>
            <button className="btn" onClick={() => append(tapGroup('mouse', 1))}>
              <Icon name="plus" size={12} /> {t('macro.addMouse')}
            </button>
          </Tooltip>
          <div className="macro-add-menu">
            {MOUSE_BUTTONS.map((b) => (
              <button key={b.value} onClick={() => append(tapGroup('mouse', b.value))}>
                {t(b.labelKey)}
              </button>
            ))}
          </div>
        </div>
        <Tooltip text={t('macro.addWait.tip')}>
          <button className="btn" onClick={() => append(waitGroup(DEFAULT_WAIT_MS))}>
            <Icon name="clock" size={12} /> {t('macro.addWait')}
          </button>
        </Tooltip>
      </div>

      {pickOpen && (
        <KeyPicker
          onPick={(code) => {
            append(tapGroup('key', code));
            setPickOpen(false);
          }}
        />
      )}
    </div>
  );
}
