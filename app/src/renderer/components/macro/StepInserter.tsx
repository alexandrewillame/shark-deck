import { useEffect, useRef, useState } from 'react';
import { hidUsageForBrowserCode } from '@shared/keys';
import { Icon } from '../icons';
import { useT } from '../../state/i18n';
import { setKeyCaptureActive } from '../../state/shortcuts';
import { KeyPicker } from './KeyPicker';
import {
  DOM_BUTTON_VALUE,
  MOUSE_BUTTONS,
  tapGroup,
  waitGroup,
  type MacroGroup,
} from './macroUtils';

/** Default pause for a wait added by hand — long enough to be visible in a game. */
const DEFAULT_WAIT_MS = 50;

/**
 * The seam between two step rows: a thin hit zone that turns into an inline
 * "add a step here" panel when clicked.
 *
 * Building a macro used to mean scrolling to the buttons under the list, adding
 * at the end, then walking the new row back up with the move buttons. Here the
 * place you click *is* the position, and the panel is armed for a real
 * keypress, so adding a key is press-the-key rather than find-it-in-a-dropdown.
 * The same element is the drop target for reordering a row and for dropping a
 * recorded take, so there is exactly one visible answer to "where will this
 * land".
 */
export function StepInserter({
  open,
  dropOver,
  onOpen,
  onClose,
  onAdd,
  onDragOver,
  onDragLeave,
  onDrop,
}: {
  open: boolean;
  /** a step or take is being dragged over this seam right now */
  dropOver: boolean;
  onOpen: () => void;
  onClose: () => void;
  onAdd: (groups: MacroGroup[]) => void;
  onDragOver: (e: React.DragEvent) => void;
  onDragLeave: () => void;
  onDrop: (e: React.DragEvent) => void;
}) {
  const t = useT();
  const [browse, setBrowse] = useState(false);
  const armRef = useRef<HTMLDivElement>(null);

  // While the panel is armed the global tab shortcuts must stand down, or
  // Ctrl+W adds a "Ctrl" step *and* closes the tab (state/shortcuts.ts) — the
  // same guard the recorder uses.
  useEffect(() => {
    if (!open) return;
    setKeyCaptureActive(true);
    armRef.current?.focus();
    return () => setKeyCaptureActive(false);
  }, [open]);

  useEffect(() => {
    if (!open) setBrowse(false);
  }, [open]);

  const add = (g: MacroGroup) => {
    onAdd([g]);
    onClose();
  };

  if (!open) {
    return (
      <li
        className={`macro-insert${dropOver ? ' drop-over' : ''}`}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
      >
        <button className="macro-insert-btn" onClick={onOpen} aria-label={t('macro.insert.here')}>
          <Icon name="plus" size={11} />
        </button>
      </li>
    );
  }

  return (
    <li className="macro-insert open">
      <div
        className="macro-inserter"
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.preventDefault();
            onClose();
            return;
          }
          // Let the picker's own search box and the panel's buttons be typed
          // into and tabbed between; only the armed strip captures keys.
          if (e.target !== armRef.current) return;
          if (e.key === 'Tab') return;
          e.preventDefault();
          const usage = hidUsageForBrowserCode(e.code);
          if (usage) add(tapGroup('key', usage));
        }}
      >
        <div
          ref={armRef}
          className="macro-inserter-arm"
          tabIndex={0}
          role="button"
          onMouseDown={(e) => {
            const value = DOM_BUTTON_VALUE[e.button];
            if (!value) return;
            e.preventDefault();
            add(tapGroup('mouse', value));
          }}
          onContextMenu={(e) => e.preventDefault()}
        >
          <span className="rec-dot" aria-hidden="true" />
          {t('macro.insert.arm')}
        </div>

        <div className="macro-inserter-alt">
          <button className="btn" onClick={() => add(waitGroup(DEFAULT_WAIT_MS))}>
            <Icon name="clock" size={12} /> {t('macro.addWait')}
          </button>
          <div className="macro-add-mouse">
            <button className="btn" onClick={() => add(tapGroup('mouse', 1))}>
              <Icon name="mouse" size={12} /> {t('macro.addMouse')}
            </button>
            <div className="macro-add-menu">
              {MOUSE_BUTTONS.map((b) => (
                <button key={b.value} onClick={() => add(tapGroup('mouse', b.value))}>
                  {t(b.labelKey)}
                </button>
              ))}
            </div>
          </div>
          <button className="btn" onClick={() => setBrowse((v) => !v)} aria-expanded={browse}>
            <Icon name="keyboard" size={12} /> {t('macro.insert.browse')}
          </button>
          <span className="spacer" />
          <button className="btn-icon" onClick={onClose} aria-label={t('common.cancel')}>
            <Icon name="close" size={12} />
          </button>
        </div>

        {browse && <KeyPicker onPick={(code) => add(tapGroup('key', code))} />}
      </div>
    </li>
  );
}

export { DEFAULT_WAIT_MS };
