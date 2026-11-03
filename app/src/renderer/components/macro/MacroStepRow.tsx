import { ALL_KEYS, labelForCode } from '@shared/keys';
import { Select, Tooltip } from '../common';
import { Icon } from '../icons';
import { useT } from '../../state/i18n';
import { useIsMac } from '../../state/shortcuts';
import { MOUSE_BUTTONS, type GroupKind, type MacroGroup } from './macroUtils';

/**
 * One row of the step timeline.
 *
 * A row is a `MacroGroup`, not a raw step: an adjacent press/release pair for
 * the same target shows as a single "Tap" carrying its hold time, and a pause
 * is its own `Wait` row rather than a number tucked onto a neighbouring row —
 * which is what makes the list readable straight down: every row happens after
 * the one above it and before the one below it, with nothing implied.
 *
 * Every field is editable in place. In the old editor only a delay was — a key
 * or button step had to be deleted and re-added to change it.
 */
export function MacroStepRow({
  group,
  index,
  dragging,
  onChange,
  onDelete,
  onDuplicate,
  onMove,
  onSplit,
  onDragStart,
  onDragEnd,
}: {
  group: MacroGroup;
  index: number;
  dragging: boolean;
  onChange: (next: MacroGroup) => void;
  onDelete: () => void;
  onDuplicate: () => void;
  onMove: (dir: -1 | 1) => void;
  onSplit: () => void;
  onDragStart: (e: React.DragEvent) => void;
  onDragEnd: () => void;
}) {
  const t = useT();
  // The move shortcut is Alt+arrow — the Option key, ⌥, on a Mac.
  const moveTip = t(useIsMac() ? 'macro.step.move.tip.mac' : 'macro.step.move.tip');
  const unsupported = group.kind === 'move';
  const isWait = group.kind === 'wait';

  const kindOptions: { value: GroupKind; label: string }[] = [
    { value: 'tap', label: t('macro.step.tap') },
    { value: 'press', label: t('macro.step.press') },
    { value: 'release', label: t('macro.step.release') },
  ];

  const targetLabel = unsupported
    ? `${group.dx ?? 0}, ${group.dy ?? 0}`
    : group.type === 'mouse'
      ? t(
          MOUSE_BUTTONS.find((b) => b.value === Number(group.value))?.labelKey ??
            'macro.mouse.left',
        )
      : labelForCode(String(group.value ?? ''));

  const kindHint = isWait
    ? t('macro.step.wait.hint')
    : group.kind === 'tap'
      ? t('macro.step.tap.hint')
      : group.kind === 'press'
        ? t('macro.step.press.hint')
        : t('macro.step.release.hint');

  return (
    <li
      className={`macro-step${dragging ? ' dragging' : ''}${unsupported ? ' unsupported' : ''}${isWait ? ' wait' : ''}`}
      draggable
      // Alt+arrow reorders from the keyboard; the drag handle alone left the
      // list unusable without a mouse.
      onKeyDown={(e) => {
        if (!e.altKey) return;
        if (e.key === 'ArrowUp') {
          e.preventDefault();
          onMove(-1);
        } else if (e.key === 'ArrowDown') {
          e.preventDefault();
          onMove(1);
        }
      }}
      tabIndex={0}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
    >
      <span className="macro-step-n">{index + 1}</span>
      <span className="grip" aria-hidden="true">
        <Icon name="grip" size={12} />
      </span>

      {isWait ? (
        <span className="macro-step-main">
          <Tooltip text={kindHint}>
            <span className="macro-kind wait-kind">
              <Icon name="clock" size={12} /> {t('macro.step.waitRow')}
            </span>
          </Tooltip>
          <label className="macro-wait-field">
            <input
              type="number"
              className="mono"
              min={0}
              max={65535}
              aria-label={t('macro.step.waitRow')}
              value={Math.round(group.ms ?? 0)}
              onChange={(e) => onChange({ ...group, ms: Math.max(0, Number(e.target.value) || 0) })}
            />
            <span className="unit">ms</span>
          </label>
        </span>
      ) : unsupported ? (
        <span className="macro-step-main">
          <span className="macro-kind warn">{t('macro.addMouse')}</span>
          <span className="mono">{targetLabel}</span>
        </span>
      ) : (
        <span className="macro-step-main">
          <Tooltip text={kindHint}>
            <Select
              className="macro-kind-sel"
              ariaLabel={t('macro.step.action')}
              value={group.kind}
              options={kindOptions}
              onChange={(v) => onChange({ ...group, kind: v as GroupKind })}
            />
          </Tooltip>
          {group.type === 'mouse' ? (
            <Select
              value={String(group.value ?? 1)}
              ariaLabel={t('macro.addMouse')}
              options={MOUSE_BUTTONS.map((b) => ({ value: String(b.value), label: t(b.labelKey) }))}
              onChange={(v) => onChange({ ...group, value: Number(v) })}
            />
          ) : (
            <Select
              value={String(group.value ?? '04')}
              ariaLabel={t('macro.addKey')}
              options={
                // A macro loaded from the device may hold a usage the curated
                // table does not list; keep it selectable instead of silently
                // snapping the row to another key.
                ALL_KEYS.some((k) => k.code === String(group.value))
                  ? ALL_KEYS.map((k) => ({ value: k.code, label: k.label }))
                  : [
                      { value: String(group.value ?? ''), label: targetLabel },
                      ...ALL_KEYS.map((k) => ({ value: k.code, label: k.label })),
                    ]
              }
              onChange={(v) => onChange({ ...group, value: v })}
            />
          )}
        </span>
      )}

      <span className="macro-step-times">
        {group.kind === 'tap' && (
          <Tooltip text={t('macro.step.hold.hint')}>
            <label>
              {t('macro.step.holdMs')}
              <input
                type="number"
                className="mono"
                min={0}
                max={65535}
                value={Math.round(group.holdMs)}
                onChange={(e) =>
                  onChange({ ...group, holdMs: Math.max(0, Number(e.target.value) || 0) })
                }
              />
              <span className="unit">ms</span>
            </label>
          </Tooltip>
        )}
      </span>

      <span className="macro-step-btns">
        {group.kind === 'tap' && (
          <Tooltip text={t('macro.step.split.tip')}>
            <button className="btn-icon" aria-label={t('macro.step.split')} onClick={onSplit}>
              <Icon name="split" size={13} />
            </button>
          </Tooltip>
        )}
        <Tooltip text={moveTip}>
          <button
            className="btn-icon"
            aria-label={t('macro.step.moveUp')}
            onClick={() => onMove(-1)}
          >
            <Icon name="arrowUp" size={13} />
          </button>
        </Tooltip>
        <Tooltip text={moveTip}>
          <button
            className="btn-icon"
            aria-label={t('macro.step.moveDown')}
            onClick={() => onMove(1)}
          >
            <Icon name="arrowDown" size={13} />
          </button>
        </Tooltip>
        <Tooltip text={t('macro.step.duplicate.tip')}>
          <button className="btn-icon" aria-label={t('macro.step.duplicate')} onClick={onDuplicate}>
            <Icon name="copy" size={13} />
          </button>
        </Tooltip>
        <Tooltip text={t('macro.step.delete.tip')}>
          <button className="btn-icon danger" aria-label={t('common.delete')} onClick={onDelete}>
            <Icon name="trash" size={13} />
          </button>
        </Tooltip>
      </span>
    </li>
  );
}
