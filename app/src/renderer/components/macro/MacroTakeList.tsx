import { useEffect, useRef } from 'react';
import { Icon, type IconName } from '../icons';
import { useT } from '../../state/i18n';
import { keyNameForCode } from '../../state/shortcuts';
import { MOUSE_BUTTONS, type MacroGroup } from './macroUtils';

type T = ReturnType<typeof useT>;

/** Icon, kind word and target for one group — shared by every compact list. */
export function groupSummary(
  g: MacroGroup,
  t: T,
): { icon: IconName; kind: string; target: string } {
  if (g.kind === 'wait')
    return { icon: 'clock', kind: t('macro.step.waitRow'), target: `${Math.round(g.ms ?? 0)} ms` };
  if (g.kind === 'move')
    return { icon: 'cursorClick', kind: t('macro.addMouse'), target: `${g.dx ?? 0}, ${g.dy ?? 0}` };
  const target =
    g.type === 'mouse'
      ? t(MOUSE_BUTTONS.find((b) => b.value === Number(g.value))?.labelKey ?? 'macro.mouse.left')
      : keyNameForCode(String(g.value ?? ''));
  return {
    icon: g.type === 'mouse' ? 'mouse' : 'keyboard',
    kind: t(
      g.kind === 'tap'
        ? 'macro.step.tap'
        : g.kind === 'press'
          ? 'macro.step.press'
          : 'macro.step.release',
    ),
    target,
  };
}

/**
 * A read-only one-line-per-step rendering of a group list, used for both halves
 * of the recorder: the rows appearing as you record, and the finished take
 * waiting to be placed.
 *
 * Deliberately not `<MacroStepRow>`: nothing here is editable, and a take is
 * only worth glancing at — the moment it lands in the real list it becomes
 * ordinary editable rows.
 */
export function MacroTakeList({ groups, live }: { groups: MacroGroup[]; live?: boolean }) {
  const t = useT();
  const endRef = useRef<HTMLLIElement>(null);

  // Keep the newest capture in view — a live list that grows past its own
  // max-height otherwise records the interesting part off-screen.
  useEffect(() => {
    if (live) endRef.current?.scrollIntoView({ block: 'nearest' });
  }, [groups.length, live]);

  return (
    <ol className={`macro-take-list${live ? ' live' : ''}`}>
      {groups.map((g, i) => {
        const s = groupSummary(g, t);
        return (
          // Index keys, not `uid`: this list is rebuilt from scratch on every
          // captured event (toGroups mints fresh uids each pass) and is
          // append-only and read-only, so position *is* identity here.
          <li
            key={i}
            className={g.kind === 'wait' ? 'wait' : ''}
            ref={i === groups.length - 1 ? endRef : undefined}
          >
            <span className="n">{i + 1}</span>
            <Icon name={s.icon} size={11} />
            <span className="k">{s.kind}</span>
            <span className="tg">{s.target}</span>
            {g.kind === 'tap' && g.holdMs > 0 && (
              <span className="hold">
                {t('macro.step.holdMs')} {Math.round(g.holdMs)} ms
              </span>
            )}
          </li>
        );
      })}
    </ol>
  );
}
