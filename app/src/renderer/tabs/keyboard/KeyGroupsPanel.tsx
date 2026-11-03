import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { KeyGroup } from '@shared/types/keyboard-settings';
import { InlineRename, Tooltip } from '../../components/common';
import { useAnchoredPosition } from '../../components/usePortalPosition';
import { useT } from '../../state/i18n';
import { GROUP_SWATCH_ROWS, groupSwatchName, isBaseGroup } from './useKeyGroups';

/**
 * The key-group rail, beside the board.
 *
 * A group is a set of keys sharing one set of actuation settings, and the app
 * derives them from the board itself (see deriveGroups) rather than asking
 * anyone to build them — so this is a READOUT of how the keyboard is currently
 * configured. Two things about a row can be changed: its name and its colour.
 * Except the base row — "Default", the keys still at the factory settings —
 * which is a fixed concept rather than a user group: it has no colour to pick
 * and shows a translated label rather than a name anyone typed, so there is
 * nothing on it to rename.
 *
 * It is a rail rather than a panel because it belongs to the board: clicking a
 * row selects those keys ON the board, and the two being a screen apart made
 * that connection invisible. Narrow, no key count, no header of its own — it
 * has to cost almost nothing next to a 79-key layout.
 *
 * Clicking a row SELECTS, and does nothing else. It used to also arm the group
 * so that subsequent clicks on the board wrote its settings into whatever you
 * clicked — which turned "let me look at these two groups" into a silent edit.
 * The one way to move a key into a group is dragging it onto a row: an explicit
 * gesture at an explicit target.
 *
 * What it deliberately does not have: a delete button (a key always has
 * settings, so a group cannot be removed — the board's Reset does that job by
 * putting keys back to the defaults), and a "new group" button (a group is a
 * consequence of settings, not something to create).
 */
export function KeyGroupsPanel({
  groups,
  selected,
  loading,
  onPick,
  onRename,
  onRecolor,
}: {
  groups: KeyGroup[];
  /** The board is being read. The rows describe the PREVIOUS read until it
   *  lands — and after a profile switch that is a different profile's
   *  partition, shown under the new profile's name. Say "reading" instead. */
  loading?: boolean;
  /** Groups the current key selection falls in — highlighted so the rail
   *  answers "what is this key set to" as well as the board does. */
  selected: ReadonlySet<string>;
  /** Select this group's keys on the board. Selecting, and nothing else. */
  onPick: (id: string) => void;
  onRename: (g: KeyGroup, name: string) => void;
  onRecolor: (g: KeyGroup, color: string) => void;
}) {
  const t = useT();
  /** Which row has its colour picker open. */
  const [picking, setPicking] = useState<string | null>(null);

  useEffect(() => {
    if (!picking) return;
    const close = (e: PointerEvent) => {
      const el = e.target as HTMLElement | null;
      if (el?.closest('.kg-colors, .kg-swatch')) return;
      setPicking(null);
    };
    window.addEventListener('pointerdown', close);
    return () => window.removeEventListener('pointerdown', close);
  }, [picking]);

  /**
   * Which group already has each colour.
   *
   * The picker used to simply omit them, which answers the wrong question: a
   * colour you cannot see does not tell you it is in use, it tells you the list
   * is shorter than it was last time. Every swatch is shown, and the ones that
   * are spoken for say so and by whom — still unpickable, because two groups
   * sharing a colour makes the board's own key painting ambiguous, which is the
   * only thing the colour is for.
   */
  const takenBy = new Map(
    groups.filter((g) => !isBaseGroup(g)).map((g) => [g.color, g.name] as const),
  );

  return (
    <div className="kg-rail" aria-busy={loading || undefined}>
      {loading && <p className="hint kg-reading">{t('act.groups.reading')}</p>}
      {!loading && groups.length === 0 && <p className="hint">{t('act.groups.none')}</p>}
      {!loading &&
        groups.map((g) => (
          // The whole row selects the group — it is one thing, so it is one
          // target. It is also the drop target for a key dragged off the board.
          <div
            key={g.id}
            data-group-id={g.id}
            className={`kg-row${selected.has(g.id) ? ' in-selection' : ''}`}
            role="button"
            tabIndex={0}
            aria-pressed={selected.has(g.id)}
            onClick={(e) => {
              // The rename control is inside the row and has its own job. Not a
              // blanket stopPropagation on the label: the label is `flex: 1`, so
              // that swallowed clicks on most of the row's width and the group
              // never got selected.
              if (
                (e.target as HTMLElement).closest(
                  '.inline-rename, .inline-rename-input, .kg-swatch',
                )
              )
                return;
              onPick(g.id);
            }}
            onKeyDown={(e) => {
              // Only when the ROW itself has focus. This fires for keys bubbling
              // out of the name input too, and preventDefault on ' ' there is why
              // group names could not contain a space.
              if (e.target !== e.currentTarget) return;
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                onPick(g.id);
              }
            }}
          >
            {isBaseGroup(g) ? (
              // The base — the keys at the factory settings: drawn as plain
              // keys on the board, so its swatch is a plain key too, and there
              // is no colour to pick. Its name is the translated label, not the
              // stored `BASE_GROUP_NAME`, and it cannot be renamed.
              <>
                <Tooltip text={t('act.groups.default.tip')}>
                  <span
                    className="kg-swatch kg-swatch-base"
                    role="img"
                    aria-label={t('act.groups.default.tip')}
                  />
                </Tooltip>
                <span className="kg-name">{t('act.groups.default')}</span>
              </>
            ) : (
              <>
                <GroupSwatch
                  color={g.color}
                  label={t('act.groups.recolor')}
                  onToggle={() => setPicking(picking === g.id ? null : g.id)}
                />
                <GroupName
                  group={g}
                  onCommit={(name) => onRename(g, name)}
                  editLabel={t('common.rename')}
                />
              </>
            )}
            {picking === g.id && !isBaseGroup(g) && (
              <ColorPopover
                takenBy={takenBy}
                current={g.color}
                onPick={(c) => {
                  onRecolor(g, c);
                  setPicking(null);
                }}
              />
            )}
          </div>
        ))}
    </div>
  );
}

/**
 * A group's name, editable in place.
 *
 * The plain text and the editor are the same box: `InlineRename`'s
 * `overlayRef` portals its input over whatever element is passed, sized to it.
 * Rendering the name and a `hideText` InlineRename side by side instead showed
 * the name twice while editing — the static copy and the input — which is
 * exactly what the control is meant to avoid.
 */
function GroupName({
  group,
  editLabel,
  onCommit,
}: {
  group: KeyGroup;
  editLabel: string;
  onCommit: (name: string) => void;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  return (
    <>
      <span className="kg-name" ref={ref}>
        {group.name}
      </span>
      <InlineRename
        value={group.name}
        onCommit={onCommit}
        editLabel={editLabel}
        hideText
        overlayRef={ref}
      />
    </>
  );
}

/**
 * The swatch, and the colour list it opens.
 *
 * Portalled and anchored rather than absolutely positioned in the row: the rail
 * is the rightmost thing in the pane, so a popover laid out inside it ran off
 * the window and the choices past the edge could not be reached at all.
 * `useAnchoredPosition` clamps to the viewport and flips side when there is no
 * room, the same as every other floating panel in the app.
 */
function GroupSwatch({
  color,
  label,
  onToggle,
}: {
  color: string;
  label: string;
  onToggle: () => void;
}) {
  return (
    <button
      className="kg-swatch"
      style={{ background: color }}
      aria-label={label}
      onClick={(e) => {
        e.stopPropagation();
        onToggle();
      }}
    />
  );
}

function ColorPopover({
  takenBy,
  current,
  onPick,
}: {
  /** colour -> the group holding it, for the "already used" marks. */
  takenBy: ReadonlyMap<string, string>;
  current: string;
  onPick: (c: string) => void;
}) {
  const t = useT();
  const anchorRef = useRef<HTMLSpanElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const pos = useAnchoredPosition(anchorRef, boxRef, true, { align: 'start', placement: 'bottom' });
  return (
    <>
      {/* Zero-size marker at the row, so the popover has something to anchor
          to without the swatch button needing to own a ref through a portal. */}
      <span ref={anchorRef} className="kg-anchor" aria-hidden="true" />
      {createPortal(
        <div
          ref={boxRef}
          className="kg-colors"
          role="dialog"
          onClick={(e) => e.stopPropagation()}
          style={pos ? { left: pos.left, top: pos.top } : { left: -9999, top: -9999 }}
        >
          {/* One row per strength, one column per hue — the same colour down
              each column, three depths of it. Rendered row by row so the grid
              is the DOM's shape too, not just the stylesheet's. */}
          {GROUP_SWATCH_ROWS.map((row, r) => (
            <div className="kg-color-row" key={r}>
              {row.map((c) => {
                const owner = takenBy.get(c);
                const mine = c === current;
                return (
                  <button
                    key={c}
                    className={`kg-color${mine ? ' on' : ''}${owner && !mine ? ' taken' : ''}`}
                    style={{ background: c }}
                    aria-label={
                      owner && !mine
                        ? t('act.groups.colorTaken', { color: groupSwatchName(c) ?? c, owner })
                        : (groupSwatchName(c) ?? c)
                    }
                    title={owner && !mine ? t('act.groups.colorTaken.tip', { owner }) : undefined}
                    disabled={!!owner && !mine}
                    onClick={() => onPick(c)}
                  />
                );
              })}
            </div>
          ))}
        </div>,
        document.body,
      )}
    </>
  );
}
