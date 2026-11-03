import { useState, type ReactNode } from 'react';
import { ConfirmDialog, InlineRename, Panel, Row, Tooltip } from './common';
import { Icon } from './icons';
import { useT } from '../state/i18n';
import { useStore } from '../state/store';
import { isSubmitEnter } from '../state/shortcuts';
import { cleanSavedName, nextSavedName, savedNameClash, SAVED_NAME_MAX } from '../state/savedName';

/** What a saved-layout library holds: a named entry, maybe for another model. */
export interface SavedEntry {
  id: string;
  name: string;
  model?: string;
}

/**
 * A library of named, saved boards — Actuation's saved layouts and per-key
 * lighting's — as one component, so the two cannot drift apart again.
 *
 *  - Saving is one click. The name field shows the next free default ("Layout
 *    3") and an empty field saves under it; type to name it something else.
 *    The field and its floppy Save sit on the panel's title line, where they
 *    cost no row of their own.
 *  - A name already in the list asks before overwriting it, because the name
 *    is a saved entry's only handle: saving under it again used to add a
 *    second row with the same label.
 *  - Each row is a thumbnail (bigger on hover), the name with its rename
 *    pencil, an optional hint, and whatever actions the library has.
 */
export function SavedLibraryPanel<E extends SavedEntry>({
  title,
  tip,
  entries,
  emptyText,
  onSave,
  onRename,
  replaceTitle,
  replaceBody,
  renameLabel,
  thumb,
  hint,
  actions,
}: {
  title: string;
  tip: string;
  entries: readonly E[];
  emptyText: string;
  /** `id` is '' for a new entry, or the id of the entry being overwritten. */
  onSave: (id: string, name: string) => Promise<void>;
  /** Called with a cleaned name that clashes with no other entry. */
  onRename: (entry: E, name: string) => Promise<void>;
  replaceTitle: (name: string) => string;
  replaceBody: string;
  renameLabel: string;
  /** The entry drawn at `u` px per key: 5 in the row, 14 in the hover. */
  thumb: (entry: E, u: number) => ReactNode;
  hint?: (entry: E) => string | undefined;
  actions: (entry: E) => ReactNode;
}) {
  const t = useT();
  const toast = useStore((st) => st.toast);
  const [name, setName] = useState('');
  /** The entry a pending save would overwrite, awaiting confirmation. */
  const [confirm, setConfirm] = useState<{ id: string; name: string } | null>(null);

  const fallback = nextSavedName(entries, (n) => t('saved.defaultName', { n: String(n) }));
  const target = cleanSavedName(name) || fallback;

  const write = async (id: string, label: string) => {
    await onSave(id, label);
    setName('');
  };
  const save = () => {
    const clash = savedNameClash(entries, target);
    if (clash) setConfirm({ id: clash.id, name: target });
    else void write('', target);
  };
  const rename = (entry: E, raw: string) => {
    const label = cleanSavedName(raw);
    if (!label || label === entry.name) return;
    if (savedNameClash(entries, label, entry.id)) {
      toast('warn', t('saved.nameTaken'));
      return;
    }
    void onRename(entry, label);
  };

  return (
    <Panel
      title={title}
      tip={tip}
      actions={
        <span className="saved-save">
          <input
            type="text"
            value={name}
            maxLength={SAVED_NAME_MAX}
            placeholder={fallback}
            aria-label={t('saved.name')}
            onChange={(e) => setName(e.target.value)}
            // Not the Enter that confirms an IME conversion — see isSubmitEnter.
            onKeyDown={(e) => isSubmitEnter(e) && save()}
          />
          <Tooltip text={t('saved.save.tip', { name: target })}>
            <button className="btn" onClick={save}>
              <Icon name="save" size={12} /> {t('common.save')}
            </button>
          </Tooltip>
        </span>
      }
    >
      {confirm && (
        <ConfirmDialog
          title={replaceTitle(confirm.name)}
          body={replaceBody}
          confirmLabel={t('act.layouts.replace.ok')}
          onResolve={(ok) => {
            const c = confirm;
            setConfirm(null);
            if (ok) void write(c.id, c.name);
          }}
        />
      )}
      {entries.length === 0 && <p className="hint">{emptyText}</p>}
      {entries.map((e) => (
        <Row
          key={e.id}
          label={
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 10 }}>
              {/* The entry itself, drawn — the same component at two sizes,
                  so the row thumbnail and the hover preview cannot disagree.
                  A list of names alone could only be told apart by loading
                  each in turn. */}
              <Tooltip text={e.name} media={thumb(e, 14)} mediaBare>
                <span className="preset-thumb">{thumb(e, 5)}</span>
              </Tooltip>
              {e.name}
              <InlineRename
                value={e.name}
                editLabel={renameLabel}
                onCommit={(v) => rename(e, v)}
                hideText
              />
            </span>
          }
          hint={hint?.(e)}
        >
          {actions(e)}
        </Row>
      ))}
    </Panel>
  );
}
