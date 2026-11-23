import { useMemo, useState } from 'react';
import type { Macro } from '@shared/types/macros';
import type { MacroLimits } from '@shared/types/live';
import { macroSlotOf } from '@shared/keyboard-macro';
import { InfoDot, Tooltip } from '../common';
import { Icon } from '../icons';
import { useT } from '../../state/i18n';
import { holdsMacro } from './macroUtils';

/** Above this many entries the list gets a filter box. */
const SEARCH_THRESHOLD = 8;

/**
 * The library rail — the master half of the tab.
 *
 * The library used to sit *below* the editor that edits it, so selecting a
 * macro scrolled you away from the list. Here it is a persistent column, and
 * the row for whatever is currently on the device carries a badge instead of
 * being repeated in a separate read-only list mid-page.
 */
export function MacroLibraryList({
  library,
  onDevice,
  limits,
  selectedId,
  dirty,
  onSelect,
  onNew,
  onImport,
  onDelete,
  onRemove,
}: {
  library: Macro[];
  onDevice: Macro[];
  limits?: MacroLimits;
  selectedId: string | null;
  dirty: boolean;
  onSelect: (m: Macro) => void;
  onNew: () => void;
  /** copy a macro the device holds into the library, to edit it */
  onImport?: (m: Macro) => void;
  /** take a macro off the device (where it has slots to empty) */
  onDelete?: (m: Macro) => void;
  /** take a macro out of the library (asked first) */
  onRemove?: (m: Macro) => void;
}) {
  const t = useT();
  const [search, setSearch] = useState('');

  const shown = useMemo(() => {
    const q = search.trim().toLowerCase();
    return q ? library.filter((m) => m.name.toLowerCase().includes(q)) : library;
  }, [library, search]);

  // A keyboard stores no macro name, so its macro is matched by what it holds;
  // a mouse's by its name as the mouse keeps it (holdsMacro).
  const keyboard = limits?.inlineWaitMs !== undefined;
  const same = (lib: Macro, dev: Macro) => holdsMacro(dev, lib, keyboard);
  const onDeviceNow = (m: Macro) => onDevice.some((d) => same(m, d));
  /** A keyboard's macros by their number (the key binding's "Macro 2"), the
   *  library macro it matches beside it. */
  const slotName = (d: Macro) => {
    const slot = keyboard ? macroSlotOf(d.id) : null;
    return slot === null ? d.name : t('keyfn.macroN', { n: String(slot + 1) });
  };
  const libraryName = (d: Macro) =>
    keyboard ? (library.find((m) => same(m, d))?.name ?? null) : null;

  return (
    <aside className="macro-lib">
      <div className="macro-lib-head">
        <h4>{t('macro.library')}</h4>
        <Tooltip text={t('macro.newMacro.tip')}>
          <button className="btn" onClick={onNew}>
            <Icon name="plus" size={12} /> {t('macro.newMacro')}
          </button>
        </Tooltip>
      </div>

      {library.length > SEARCH_THRESHOLD && (
        <input
          type="text"
          placeholder={t('macro.lib.search')}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      )}

      {library.length === 0 ? (
        <div className="empty">{t('macro.libraryEmpty')}</div>
      ) : (
        <ul className="macro-lib-list">
          {shown.map((m) => (
            <li key={m.id}>
              <Tooltip text={t('macro.lib.item.tip', { n: m.steps.length })}>
                <button
                  className={`macro-lib-item${m.id === selectedId ? ' active' : ''}`}
                  onClick={() => onSelect(m)}
                >
                  <span className="nm">{m.name}</span>
                  <span className="sub">
                    {t('macro.lib.steps', { n: m.steps.length })}
                    {onDeviceNow(m) && (
                      <span className="badge">{t('macro.lib.onDeviceBadge')}</span>
                    )}
                    {m.id === selectedId && dirty && (
                      <span className="badge dirty">{t('macro.unsaved')}</span>
                    )}
                  </span>
                </button>
              </Tooltip>
              {/* Its delete inside the row, at the end — as the device's own
                  macros have theirs; the editor's still deletes the open one. */}
              {onRemove && (
                <Tooltip text={t('macro.delete.tip')}>
                  <button
                    className="btn icon-only macro-lib-del danger"
                    aria-label={t('macro.lib.delete', { name: m.name })}
                    onClick={() => onRemove(m)}
                  >
                    <Icon name="trash" size={12} />
                  </button>
                </Tooltip>
              )}
            </li>
          ))}
        </ul>
      )}

      <div className="macro-lib-device">
        <h5>
          {t('macro.lib.onDevice')}{' '}
          <InfoDot
            text={t(keyboard ? 'macro.deviceSlot.hint.keyboard' : 'macro.deviceSlot.hint')}
            size={12}
          />
        </h5>
        {onDevice.length === 0 ? (
          <div className="empty">{t('macro.empty')}</div>
        ) : (
          <ul>
            {onDevice.map((m) => (
              <li key={m.id}>
                <span className="nm">
                  {slotName(m)}
                  {libraryName(m) && <span className="sub"> · {libraryName(m)}</span>}
                </span>
                <span className="sub">{t('macro.lib.steps', { n: m.steps.length })}</span>
                {onImport && (
                  <Tooltip text={t('macro.import.tip')}>
                    <button
                      className="btn icon-only macro-import"
                      aria-label={t('macro.import')}
                      onClick={() => onImport(m)}
                    >
                      <Icon name="copy" size={12} />
                    </button>
                  </Tooltip>
                )}
                {onDelete && (
                  <Tooltip text={t('macro.deleteOnDevice.tip')}>
                    <button
                      className="btn icon-only macro-import danger"
                      aria-label={t('macro.deleteOnDevice')}
                      onClick={() => onDelete(m)}
                    >
                      <Icon name="trash" size={12} />
                    </button>
                  </Tooltip>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </aside>
  );
}
