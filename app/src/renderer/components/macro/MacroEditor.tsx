import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { LiveDevice } from '@shared/types/live';
import type { Macro } from '@shared/types/macros';
import { ConfirmDialog, InfoDot, Tooltip } from '../common';
import { Icon } from '../icons';
import { useT } from '../../state/i18n';
import { useStore } from '../../state/store';
import { usePendingChange } from '../../state/leaveGuard';
import { sd, useDeviceData, useWrite } from '../../tabs/common';
import { MacroLibraryList } from './MacroLibraryList';
import { MacroRecorder } from './MacroRecorder';
import { MacroStepList } from './MacroStepList';
import { useMacroRecorder, type RecMode, type RecTiming } from './useMacroRecorder';
import {
  encodedStepCount,
  fromGroups,
  macroEquals,
  newUid,
  toGroups,
  type MacroGroup,
} from './macroUtils';

/** Name cap when the device has no name field of its own to constrain it. */
const FALLBACK_NAME_MAX = 30;

interface Draft {
  /** null while editing a macro that has never been saved */
  id: string | null;
  name: string;
  repeatCount: number;
  groups: MacroGroup[];
  /**
   * The name this draft was *given* when it was created, for an unsaved draft.
   * A new macro arrives already named ("Macro 3"), so the plain "has a name"
   * test would call an untouched pane dirty and prompt to save nothing on the
   * way out; comparing against the name it started with is what tells an
   * auto-assigned name apart from one the user actually typed.
   */
  autoName: string;
}

const blankDraft = (name: string): Draft => ({
  id: null,
  name,
  repeatCount: 1,
  groups: [],
  autoName: name,
});

/**
 * The lowest unused "Macro N".
 *
 * A new macro used to open on the literal placeholder "New macro", which had
 * to be replaced by hand before it could be saved at all — and two of them in
 * a row collided. A numbered default is immediately valid and unique, so
 * recording and saving needs no detour through the name field.
 */
function nextMacroName(library: Macro[], t: ReturnType<typeof useT>): string {
  const taken = new Set(library.map((m) => m.name.trim()));
  for (let n = 1; ; n++) {
    const name = t('macro.defaultName', { n });
    if (!taken.has(name)) return name;
  }
}

/**
 * The Macros tab: library on the left, one macro's editor on the right.
 *
 * Replaces a single flat panel that stacked the editor, a read-only on-device
 * list and the library in one column, with no notion of which macro was being
 * edited or whether it had unsaved changes.
 *
 * The recorder's state lives here rather than inside `<MacroRecorder>`: a
 * finished take is both something the record card shows and something the step
 * list below can accept a drop of, so the two need one owner.
 */
export function MacroEditor({ device }: { device: LiveDevice }) {
  const t = useT();
  const toast = useStore((s) => s.toast);
  const { run } = useWrite();
  const limits = device.ui.macroLimits;

  const { data: onDevice, reload: reloadDevice } = useDeviceData<Macro[]>(
    device.id,
    sd.readMacros,
    [],
    [],
    'macros',
  );
  const { data: library, reload: reloadLibrary } = useDeviceData<Macro[]>(
    device.id,
    // Device-independent, but useDeviceData gives the same load/reload plumbing
    // the rest of the tabs use (the old editor hand-rolled it here while the
    // Buttons tab already used this for the very same list).
    () => sd.listMacroLibrary(),
    [],
  );

  const [draft, setDraft] = useState<Draft>(() => blankDraft(t('macro.defaultName', { n: 1 })));
  const [pushBusy, setPushBusy] = useState(false);
  const [timing, setTiming] = useState<RecTiming>('real');
  const [fixedMs, setFixedMs] = useState(50);
  /** a navigation the user must confirm because the draft has unsaved edits */
  const [pending, setPending] = useState<null | { kind: 'select'; macro: Macro } | { kind: 'new' }>(
    null,
  );
  const [confirmDelete, setConfirmDelete] = useState(false);

  const recUiRef = useRef<HTMLDivElement>(null);
  const rec = useMacroRecorder({ timing, fixedMs, uiRef: recUiRef });

  const saved = useMemo(() => library.find((m) => m.id === draft.id) ?? null, [library, draft.id]);

  const dirty = useMemo(() => {
    const current = {
      name: draft.name,
      repeatCount: draft.repeatCount,
      steps: fromGroups(draft.groups),
    };
    if (!saved) return draft.groups.length > 0 || draft.name.trim() !== draft.autoName;
    return !macroEquals(current, saved);
  }, [draft, saved]);

  const loadMacro = useCallback((m: Macro) => {
    setDraft({
      id: m.id,
      name: m.name,
      repeatCount: m.repeatCount,
      groups: toGroups(m.steps),
      autoName: m.name,
    });
  }, []);

  // Land on the first library entry once, so the editor is never staring at a
  // blank pane while macros exist.
  const [seeded, setSeeded] = useState(false);
  useEffect(() => {
    if (seeded || !library.length) return;
    setSeeded(true);
    loadMacro(library[0]!);
  }, [library, seeded, loadMacro]);

  const startNew = () => setDraft(blankDraft(nextMacroName(library, t)));

  const guard = (action: { kind: 'select'; macro: Macro } | { kind: 'new' }) => {
    if (dirty) {
      setPending(action);
      return;
    }
    if (action.kind === 'new') startNew();
    else loadMacro(action.macro);
  };

  const applyPending = () => {
    if (!pending) return;
    if (pending.kind === 'new') startNew();
    else loadMacro(pending.macro);
    setPending(null);
  };

  const save = useCallback(async (): Promise<boolean> => {
    const name = draft.name.trim();
    // The V8 name field is a fixed 30-byte ASCII slot: an empty name round-trips
    // as nameLen 0, which the codec reads back as "no macro here" and the whole
    // macro silently disappears (mouse-macro-codec.ts).
    if (!name) {
      toast('err', t('macro.nameRequired'));
      return false;
    }
    const macro: Macro = {
      id: draft.id ?? crypto.randomUUID(),
      name,
      repeatCount: Math.max(1, Math.min(255, draft.repeatCount)),
      steps: fromGroups(draft.groups),
    };
    await sd.saveMacroLibraryEntry(macro);
    setDraft({ ...draft, id: macro.id, name, autoName: name });
    toast('info', t('macro.savedToLibrary'));
    reloadLibrary();
    return true;
  }, [draft, reloadLibrary, t, toast]);

  // Leaving this pane (another section, closing the tab, a profile switch,
  // quitting) asks first — see state/leaveGuard.ts. A refused save (an
  // unnamed macro) keeps the user here, with the toast explaining why.
  usePendingChange(device.id, {
    kind: 'save',
    dirty,
    label: () => draft.name.trim() || t('macro.defaultName', { n: 1 }),
    commit: save,
  });

  const revert = () => (saved ? loadMacro(saved) : startNew());

  const remove = async () => {
    if (!draft.id) return;
    await sd.deleteMacroLibraryEntry(draft.id);
    const rest = library.filter((m) => m.id !== draft.id);
    if (rest.length) loadMacro(rest[0]!);
    else startNew();
    reloadLibrary();
  };

  const push = async () => {
    if (!draft.id) return;
    setPushBusy(true);
    try {
      await run(draft.name, () => sd.pushMacroToDevice(device.id, draft.id!));
      toast('info', t('macro.pushed', { name: draft.name }));
      reloadDevice();
    } finally {
      setPushBusy(false);
    }
  };

  // `rec` itself is a fresh object every render; its actions are not.
  const resetRec = rec.reset;

  const commitTake = useCallback(
    (groups: MacroGroup[], mode: RecMode) => {
      setDraft((d) => ({
        ...d,
        groups:
          mode === 'append'
            ? [...d.groups, ...groups.map((g) => ({ ...g, uid: newUid() }))]
            : groups,
      }));
      resetRec();
    },
    [resetRec],
  );

  // Nothing to place a take *around* in an empty macro, so skip the review step
  // entirely and drop it straight in — the common case of "new macro, record it".
  useEffect(() => {
    if (rec.phase !== 'review' || !rec.take?.groups.length || draft.groups.length > 0) return;
    commitTake(rec.take.groups, 'replace');
  }, [rec.phase, rec.take, draft.groups.length, commitTake]);

  const over = !!limits && encodedStepCount(draft.groups, limits) > limits.maxSteps;
  // Pushing needs a saved library entry: pushMacroToDevice resolves the macro
  // by id out of the library file (main/ipc.ts).
  const canPush = !!draft.id && !dirty && draft.groups.length > 0 && !over;
  const pushTip = canPush
    ? t('macro.pushToDevice.tip')
    : !draft.id || dirty
      ? t('macro.pushToDevice.needSave')
      : over
        ? t('macro.pushToDevice.tooLong')
        : t('macro.pushToDevice.needSteps');

  return (
    <div className="macro-pane">
      <MacroLibraryList
        library={library}
        onDevice={onDevice}
        selectedId={draft.id}
        dirty={dirty}
        onSelect={(m) => guard({ kind: 'select', macro: m })}
        onNew={() => guard({ kind: 'new' })}
      />

      <section className="macro-edit">
        {/* The editor's how-to is an info dot beside the name field rather
            than a paragraph above it — read once, and it was a line of the
            pane on every visit. */}
        <div className="macro-edit-head">
          <InfoDot text={t('macro.editorHint')} />
          <Tooltip text={t('macro.name.tip', { max: limits?.nameMax ?? FALLBACK_NAME_MAX })}>
            <input
              type="text"
              className="macro-name"
              value={draft.name}
              maxLength={limits?.nameMax ?? FALLBACK_NAME_MAX}
              placeholder={t('macro.name')}
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
            />
          </Tooltip>
          {dirty && <span className="badge dirty">{t('macro.unsaved')}</span>}
          <span className="spacer" />
          <Tooltip text={t('macro.save.tip')}>
            <button className="btn primary" disabled={!dirty} onClick={() => void save()}>
              <Icon name="check" size={12} /> {t('macro.save')}
            </button>
          </Tooltip>
          <Tooltip text={t('macro.revert.tip')}>
            <button className="btn" disabled={!dirty} onClick={revert}>
              <Icon name="restore" size={12} /> {t('macro.revert')}
            </button>
          </Tooltip>
          <Tooltip text={t('macro.delete.tip')}>
            <button
              className="btn danger"
              disabled={!draft.id}
              aria-label={t('common.delete')}
              onClick={() => setConfirmDelete(true)}
            >
              <Icon name="trash" size={13} />
            </button>
          </Tooltip>
        </div>

        <MacroRecorder
          rec={rec}
          uiRef={recUiRef}
          timing={timing}
          setTiming={setTiming}
          fixedMs={fixedMs}
          setFixedMs={setFixedMs}
          hasSteps={draft.groups.length > 0}
          onCommit={commitTake}
        />

        <MacroStepList
          groups={draft.groups}
          limits={limits}
          take={rec.phase === 'review' ? (rec.take?.groups ?? null) : null}
          onChange={(groups) => setDraft({ ...draft, groups })}
          onTakeUsed={resetRec}
        />

        <div className="macro-foot">
          <label className="macro-repeat">
            <span className="lbl">{t('macro.repeat')}</span>
            <input
              type="number"
              className="mono"
              min={1}
              max={255}
              value={draft.repeatCount}
              onChange={(e) => setDraft({ ...draft, repeatCount: Number(e.target.value) || 1 })}
            />
            <span className="hint">{t('macro.repeat.hint')}</span>
          </label>
          <span className="spacer" />
          <Tooltip text={pushTip}>
            <button className="btn" disabled={!canPush || pushBusy} onClick={() => void push()}>
              <Icon name="upload" size={12} /> {t('macro.pushToDevice')}
            </button>
          </Tooltip>
        </div>
      </section>

      {pending && (
        <ConfirmDialog
          title={t('macro.discard.title')}
          body={t('macro.discard.body', { name: draft.name || t('macro.defaultName', { n: 1 }) })}
          confirmLabel={t('macro.discard.confirm')}
          onResolve={(ok) => (ok ? applyPending() : setPending(null))}
        />
      )}
      {confirmDelete && (
        <ConfirmDialog
          title={t('macro.delete.title')}
          body={t('macro.delete.body', { name: draft.name })}
          confirmLabel={t('common.delete')}
          onResolve={(ok) => {
            setConfirmDelete(false);
            if (ok) void remove();
          }}
        />
      )}
    </div>
  );
}
