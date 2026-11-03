import { useMemo, useState } from 'react';
import { KEY_GROUPS } from '@shared/keys';
import { useT } from '../../state/i18n';

/**
 * The grouped, searchable key grid, lifted out of the old single-file editor.
 * The raw-HID-usage escape hatch at the bottom is kept as-is: it is the only
 * way to reach a usage the curated table does not list.
 */
export function KeyPicker({ onPick }: { onPick: (code: string) => void }) {
  const t = useT();
  const [search, setSearch] = useState('');
  const [rawHex, setRawHex] = useState('04');

  const groups = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return KEY_GROUPS;
    return KEY_GROUPS.map((g) => ({
      ...g,
      keys: g.keys.filter((k) => k.label.toLowerCase().includes(q)),
    })).filter((g) => g.keys.length);
  }, [search]);

  return (
    <div className="keypick">
      <input
        type="text"
        autoFocus
        placeholder={t('macro.search')}
        value={search}
        onChange={(e) => setSearch(e.target.value)}
      />
      <div className="keypick-scroll">
        {groups.map((g) => (
          <div key={g.label}>
            <div className="grp">{g.labelKey ? t(g.labelKey) : g.label}</div>
            <div className="keys">
              {g.keys.map((k) => (
                <button key={k.code} className="keypick-key" onClick={() => onPick(k.code)}>
                  {k.label}
                </button>
              ))}
            </div>
          </div>
        ))}
        {groups.length === 0 && <div className="empty">—</div>}
      </div>
      <div className="keypick-raw">
        <span className="grp">{t('macro.rawHex')}</span>
        <input
          type="text"
          className="mono"
          value={rawHex}
          onChange={(e) => setRawHex(e.target.value)}
        />
        <button
          className="btn"
          onClick={() => onPick(rawHex.replace(/[^0-9a-fA-F]/g, '').toLowerCase())}
        >
          {t('common.add')}
        </button>
      </div>
    </div>
  );
}
