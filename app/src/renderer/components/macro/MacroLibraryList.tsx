import { useMemo, useState } from 'react';
import type { Macro } from '@shared/types/macros';
import { InfoDot, Tooltip } from '../common';
import { Icon } from '../icons';
import { useT } from '../../state/i18n';

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
  selectedId,
  dirty,
  onSelect,
  onNew,
}: {
  library: Macro[];
  onDevice: Macro[];
  selectedId: string | null;
  dirty: boolean;
  onSelect: (m: Macro) => void;
  onNew: () => void;
}) {
  const t = useT();
  const [search, setSearch] = useState('');

  const shown = useMemo(() => {
    const q = search.trim().toLowerCase();
    return q ? library.filter((m) => m.name.toLowerCase().includes(q)) : library;
  }, [library, search]);

  // The keyboard stores no macro name at all (readMacros reports a fixed
  // "Onboard macro"), so a name match is the only link available — the same
  // approximation the Buttons tab already makes.
  const onDeviceNames = new Set(onDevice.map((m) => m.name));

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
                    {onDeviceNames.has(m.name) && (
                      <span className="badge">{t('macro.lib.onDeviceBadge')}</span>
                    )}
                    {m.id === selectedId && dirty && (
                      <span className="badge dirty">{t('macro.unsaved')}</span>
                    )}
                  </span>
                </button>
              </Tooltip>
            </li>
          ))}
        </ul>
      )}

      <div className="macro-lib-device">
        <h5>
          {t('macro.lib.onDevice')} <InfoDot text={t('macro.deviceSlot.hint')} size={12} />
        </h5>
        {onDevice.length === 0 ? (
          <div className="empty">{t('macro.empty')}</div>
        ) : (
          <ul>
            {onDevice.map((m) => (
              <li key={m.id}>
                <span className="nm">{m.name}</span>
                <span className="sub">{t('macro.lib.steps', { n: m.steps.length })}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </aside>
  );
}
