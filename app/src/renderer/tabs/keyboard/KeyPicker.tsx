import { useEffect, useMemo, useRef, useState } from 'react';
import {
  KEY_GROUPS,
  hidUsageForBrowserCode,
  normalizeUsage,
  type KeyDef,
  type KeyGroup,
} from '@shared/keys';
import { Row } from '../../components/common';
import { Icon } from '../../components/icons';
import { useT } from '../../state/i18n';
import { filterKeyGroups } from '../../state/keySearch';
import { keyName } from '../../state/shortcuts';
import { keyFace } from './remapKeyFace';

/**
 * Every key a binding can name, as rows of buttons by group — the Remap
 * tab's picker, and the one the Actuation tab's mod-tap and DKS panels use to
 * choose what a key holds or fires.
 *
 * `isOn` says which buttons are lit (what is chosen now); `onPick` gets the
 * HID usage of a button pressed. What a press MEANS — add to a combination,
 * replace the choice — is the caller's.
 *
 * `listen`: a key pressed on the keyboard picks it too, as clicking its
 * button would — "choose the key to hold" is answered fastest by pressing it.
 * For a picker that is the thing being answered (a chooser popover, the macro
 * editor's key list); the Remap tab captures combinations itself. Escape is
 * never picked — it closes the popover around the picker — and typing into a
 * text field stays typing.
 *
 * `searchable`: a box above the groups that narrows them to what is typed —
 * "vol", "f5", "media" (state/keySearch.ts). It never takes the focus by
 * itself: the board's own keys, and `listen`, keep theirs.
 */
export function KeyPicker({
  isOn = () => false,
  onPick,
  disabled,
  groups = KEY_GROUPS,
  listen,
  searchable,
}: {
  isOn?: (code: string) => boolean;
  onPick: (code: string) => void;
  disabled?: boolean;
  groups?: readonly KeyGroup[];
  listen?: boolean;
  searchable?: boolean;
}) {
  const t = useT();
  const [query, setQuery] = useState('');
  // A media or launcher key is named for what it does, and that name is
  // translated; a key legend stays as printed — but for Win and Alt, which a
  // Mac calls ⌘ and ⌥.
  const nameOf = (k: KeyDef) => (k.labelKey ? t(k.labelKey) : keyName(k.code, k.label));
  const groupNameOf = (g: KeyGroup) => (g.labelKey ? t(g.labelKey) : g.label);
  const shown = searchable ? filterKeyGroups(groups, query, nameOf, groupNameOf) : groups;
  /** The picker's own code for each usage it offers, by normalised usage. */
  const offered = useMemo(() => {
    const m = new Map<string, string>();
    for (const g of groups) for (const k of g.keys) m.set(normalizeUsage(k.code), k.code);
    return m;
  }, [groups]);
  const pick = useRef(onPick);
  pick.current = onPick;

  useEffect(() => {
    if (!listen || disabled) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.repeat || e.key === 'Escape') return;
      const el = e.target as HTMLElement | null;
      if (el?.closest?.('input, textarea, select, [contenteditable="true"]')) return;
      const usage = hidUsageForBrowserCode(e.code);
      const code = usage === null ? undefined : offered.get(normalizeUsage(usage));
      if (code === undefined) return;
      // Picked, and nothing else: no Tab focus move, no Alt menu, no app
      // shortcut firing underneath.
      e.preventDefault();
      e.stopPropagation();
      pick.current(code);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [listen, disabled, offered]);

  return (
    <>
      {listen && !disabled && <p className="hint key-picker-listen">{t('keypick.listen')}</p>}
      {searchable && (
        <div className="key-search">
          <Icon name="search" size={12} />
          <input
            type="text"
            value={query}
            placeholder={t('keypick.search')}
            aria-label={t('keypick.search')}
            spellCheck={false}
            autoComplete="off"
            disabled={disabled}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              // Escape empties the box first; with nothing typed it is left to
              // whatever the picker sits in (a chooser closes on it).
              if (e.key === 'Escape' && query) {
                e.preventDefault();
                e.stopPropagation();
                setQuery('');
              }
            }}
          />
          {query && (
            <button
              type="button"
              className="key-search-clear"
              aria-label={t('keypick.search.clear')}
              title={t('keypick.search.clear')}
              onClick={() => setQuery('')}
            >
              <Icon name="close" size={10} />
            </button>
          )}
        </div>
      )}
      {searchable && query.trim() && shown.length === 0 && (
        <p className="hint key-search-none">{t('keypick.search.none', { q: query.trim() })}</p>
      )}
      {shown.map((g) => (
        // Stacked: the group's name above its keys, which wrap to the width
        // they have. Beside the name, a row's control never shrinks (`.row-ctl`),
        // so the 26 letters stayed on one line and whatever held the picker
        // scrolled sideways.
        <Row key={g.label} className="row-stack" label={groupNameOf(g)}>
          <div className="remap-picker">
            {g.keys.map((k) => {
              const on = isOn(k.code);
              const name = nameOf(k);
              return (
                <button
                  key={k.code + k.label}
                  className={`btn remap-key${on ? ' on' : ''}`}
                  aria-pressed={on}
                  aria-label={name}
                  // The ISO key is on no board this app draws, so its name
                  // alone does not say what or where it is.
                  title={k.code === '64' ? t('remap.iso.tip') : name}
                  disabled={disabled}
                  onClick={() => onPick(k.code)}
                >
                  {keyFace({ ...k, label: name })}
                </button>
              );
            })}
          </div>
        </Row>
      ))}
    </>
  );
}
