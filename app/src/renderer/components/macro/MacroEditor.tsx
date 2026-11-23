import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { LiveDevice } from '@shared/types/live';
import type { Macro } from '@shared/types/macros';
import { macroSlotOf } from '@shared/keyboard-macro';
import { ConfirmDialog, InfoDot, ModalFrame, Select, Tooltip } from '../common';
import { Icon } from '../icons';
import { useStuckHead } from '../stickyHead';
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
  holdsMacro,
  macroEquals,
  newUid,
  retime,
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
  /**
   * The steps with their own pauses, while an Even or None timing has
   * replaced them in `groups` — what "As typed" puts back. Null when `groups`
   * already holds the macro's own pauses.
   */
  typed: MacroGroup[] | null;
}

const blankDraft = (name: string): Draft => ({
  id: null,
  name,
  repeatCount: 1,
  groups: [],
  autoName: name,
  typed: null,
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
export function MacroEditor({
  device,
  libraryHost,
}: {
  device: LiveDevice;
  /** where the library goes, when the pane gives it a place of its own */
  libraryHost?: HTMLElement | null;
}) {
  const t = useT();
  const toast = useStore((s) => s.toast);
  const { run } = useWrite();
  const limits = device.ui.macroLimits;
  // Save / Revert stay pinned while a long list of steps scrolls under them.
  const editRef = useRef<HTMLElement>(null);
  useStuckHead(editRef);

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
  /** the library macro a delete asks about: the one open, or a row's */
  const [confirmDelete, setConfirmDelete] = useState<{ id: string; name: string } | null>(null);

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
      typed: null,
    });
    // A saved macro opens on its own pauses.
    setTiming('real');
  }, []);

  /**
   * Timing is the macro's, not only the next recording's: Even and None
   * rewrite the pauses of the steps already here, and As typed puts back the
   * ones they had. It used to apply to recording alone, so choosing Even on a
   * recorded macro changed nothing on screen or on the device.
   */
  const applyTiming = (next: RecTiming, ms: number) => {
    setTiming(next);
    setFixedMs(ms);
    setDraft((d) => {
      const own = d.typed ?? d.groups;
      if (next === 'real') return { ...d, groups: own, typed: null };
      return { ...d, groups: retime(own, next === 'fixed' ? ms : 0), typed: own };
    });
  };

  // Land on the first library entry once, so the editor is never staring at a
  // blank pane while macros exist.
  const [seeded, setSeeded] = useState(false);
  useEffect(() => {
    if (seeded || !library.length) return;
    setSeeded(true);
    loadMacro(library[0]!);
  }, [library, seeded, loadMacro]);

  const startNew = (lib: Macro[] = library) => setDraft(blankDraft(nextMacroName(lib, t)));

  type Nav = { kind: 'select'; macro: Macro } | { kind: 'new' };
  const go = (action: Nav, lib: Macro[] = library) => {
    if (action.kind === 'new') startNew(lib);
    else loadMacro(action.macro);
  };
  const guard = (action: Nav) => {
    if (dirty) setPending(action);
    else go(action);
  };

  const applyPending = () => {
    if (!pending) return;
    go(pending);
    setPending(null);
  };

  const saveEntry = useCallback(async (): Promise<Macro | null> => {
    const name = draft.name.trim();
    // The V8 name field is a fixed 30-byte ASCII slot: an empty name round-trips
    // as nameLen 0, which the codec reads back as "no macro here" and the whole
    // macro silently disappears (mouse-macro-codec.ts).
    if (!name) {
      toast('err', t('macro.nameRequired'));
      return null;
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
    return macro;
  }, [draft, reloadLibrary, t, toast]);
  const save = useCallback(async () => !!(await saveEntry()), [saveEntry]);

  /**
   * Save, then go where the user was going. A refused save (an unnamed
   * macro) stays here, with the toast saying why. A new macro is numbered
   * past the one just saved, which the library reload has not brought yet.
   */
  const saveThenGo = async () => {
    const next = pending;
    setPending(null);
    const macro = await saveEntry();
    if (next && macro) go(next, [...library.filter((m) => m.id !== macro.id), macro]);
  };

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

  /**
   * A macro the device holds, copied into the library — a keyboard's by its
   * number, as it has no names. Opened at once unless the one being edited
   * has unsaved changes; then it waits in the library.
   */
  const importMacro = async (m: Macro) => {
    const slot = macroSlotOf(m.id);
    const base = slot === null ? m.name : t('macro.import.name', { n: String(slot + 1) });
    const taken = new Set(library.map((x) => x.name));
    let name = base;
    for (let k = 2; taken.has(name); k++) name = `${base} (${k})`;
    const entry: Macro = {
      id: crypto.randomUUID(),
      name,
      repeatCount: m.repeatCount,
      steps: m.steps,
    };
    await sd.saveMacroLibraryEntry(entry);
    reloadLibrary();
    if (!dirty) loadMacro(entry);
    toast('info', t('macro.imported', { name }));
  };

  /** A macro out of the library — the one open, or another row's (its edits stay). */
  const remove = async (target: { id: string }) => {
    await sd.deleteMacroLibraryEntry(target.id);
    if (target.id === draft.id) {
      const rest = library.filter((m) => m.id !== target.id);
      if (rest.length) loadMacro(rest[0]!);
      else startNew(rest);
    }
    reloadLibrary();
  };

  /**
   * Where Push writes, on a device with numbered slots (a keyboard's 64, a
   * V8's 16): the slots in use, then the first empty one. It starts on the
   * slot already holding this macro — a keyboard's by what it holds (it keeps
   * no names), a mouse's by name — else on the first empty one, else the first.
   */
  const slotCount = limits?.slots ?? 1;
  const keyboard = limits?.inlineWaitMs !== undefined;
  const slotChoices = useMemo(() => {
    if (slotCount <= 1) return [];
    const used = onDevice
      .map((m) => ({ m, slot: macroSlotOf(m.id) }))
      .filter((x): x is { m: Macro; slot: number } => x.slot !== null)
      .sort((a, b) => a.slot - b.slot);
    const taken = new Set(used.map((x) => x.slot));
    let free = -1;
    for (let s = 0; s < slotCount && free < 0; s++) if (!taken.has(s)) free = s;
    return [
      ...used.map(({ m, slot }) => ({ slot, m })),
      ...(free >= 0 ? [{ slot: free, m: null as Macro | null }] : []),
    ];
  }, [onDevice, slotCount]);
  const heldByLib = (lib: Macro, dev: Macro) => holdsMacro(dev, lib, keyboard);
  const heldBy = (m: Macro) =>
    holdsMacro(
      m,
      { name: draft.name, repeatCount: draft.repeatCount, steps: fromGroups(draft.groups) },
      keyboard,
    );
  const defaultSlot =
    slotChoices.find((c) => c.m && heldBy(c.m))?.slot ??
    slotChoices.find((c) => !c.m)?.slot ??
    slotChoices[0]?.slot ??
    0;
  const [pushSlot, setPushSlot] = useState<number | null>(null);
  // A new macro, or the device's macros changing, starts the choice afresh.
  useEffect(() => setPushSlot(null), [draft.id, onDevice]);
  const targetSlot = pushSlot ?? defaultSlot;
  const slotLabel = (slot: number) => t('keyfn.macroN', { n: String(slot + 1) });

  const push = async () => {
    if (!draft.id) return;
    setPushBusy(true);
    try {
      const slot = slotCount > 1 ? targetSlot : undefined;
      const r = await run(draft.name, () => sd.pushMacroToDevice(device.id, draft.id!, slot));
      if (r?.ok !== false)
        toast(
          'info',
          slot === undefined
            ? t('macro.pushed', { name: draft.name })
            : t('macro.pushedTo', { name: draft.name, slot: slotLabel(slot) }),
        );
      reloadDevice();
    } finally {
      setPushBusy(false);
    }
  };

  /** A macro off the device: its slot emptied, after a confirmation. */
  const [deleting, setDeleting] = useState<Macro | null>(null);
  const deleteOnDevice = async (m: Macro) => {
    const slot = macroSlotOf(m.id);
    await run(slot === null ? m.name : slotLabel(slot), () => sd.deleteMacro(device.id, m.id));
    reloadDevice();
  };

  // `rec` itself is a fresh object every render; its actions are not.
  const resetRec = rec.reset;

  const takeTyped = rec.take?.typed;
  const commitTake = useCallback(
    (groups: MacroGroup[], mode: RecMode) => {
      setDraft((d) => {
        const fresh = (gs: MacroGroup[]) => gs.map((g) => ({ ...g, uid: newUid() }));
        if (timing === 'real') {
          return { ...d, groups: mode === 'append' ? [...d.groups, ...fresh(groups)] : groups };
        }
        // Under Even or None the whole macro, old steps and new, keeps one timing;
        // its own pauses go on underneath for As typed.
        const take = takeTyped ?? groups;
        const own = mode === 'append' ? [...(d.typed ?? d.groups), ...fresh(take)] : take;
        return { ...d, groups: retime(own, timing === 'fixed' ? fixedMs : 0), typed: own };
      });
      resetRec();
    },
    [resetRec, takeTyped, timing, fixedMs],
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
    ? slotChoices.length
      ? t('macro.pushToDevice.tip.slot', { slot: slotLabel(targetSlot) })
      : t('macro.pushToDevice.tip')
    : !draft.id || dirty
      ? t('macro.pushToDevice.needSave')
      : over
        ? t('macro.pushToDevice.tooLong')
        : t('macro.pushToDevice.needSteps');

  const libraryList = (
    <MacroLibraryList
      library={library}
      onDevice={onDevice}
      limits={limits}
      selectedId={draft.id}
      dirty={dirty}
      onSelect={(m) => guard({ kind: 'select', macro: m })}
      onNew={() => guard({ kind: 'new' })}
      onImport={(m) => void importMacro(m)}
      onDelete={slotCount > 1 ? (m) => setDeleting(m) : undefined}
      onRemove={(m) => setConfirmDelete({ id: m.id, name: m.name })}
    />
  );
  return (
    <div className={`macro-pane${libraryHost ? ' lib-aside' : ''}`}>
      {libraryHost ? createPortal(libraryList, libraryHost) : libraryList}

      <section className="macro-edit has-sticky-head" ref={editRef}>
        {/* The editor's how-to is an info dot beside the name field rather
            than a paragraph above it — read once, and it was a line of the
            pane on every visit. */}
        <div className="macro-edit-head sticky-head">
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
              onClick={() =>
                draft.id && setConfirmDelete({ id: draft.id, name: saved?.name ?? draft.name })
              }
            >
              <Icon name="trash" size={13} />
            </button>
          </Tooltip>
        </div>

        <MacroRecorder
          rec={rec}
          uiRef={recUiRef}
          timing={timing}
          setTiming={(v) => applyTiming(v, fixedMs)}
          fixedMs={fixedMs}
          setFixedMs={(ms) => applyTiming('fixed', ms)}
          hasSteps={draft.groups.length > 0}
          onCommit={commitTake}
        />

        <MacroStepList
          groups={draft.groups}
          limits={limits}
          take={rec.phase === 'review' ? (rec.take?.groups ?? null) : null}
          onChange={(groups) => {
            // An edit by hand is the macro's own timing from then on.
            setDraft({ ...draft, groups, typed: null });
            setTiming('real');
          }}
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
          {slotChoices.length > 0 && (
            <label className="macro-push-slot">
              <span className="lbl">{t('macro.pushTo')}</span>
              <Select
                value={targetSlot}
                ariaLabel={t('macro.pushTo')}
                options={slotChoices.map(({ slot, m }) => ({
                  value: slot,
                  label: `${slotLabel(slot)} · ${m ? (keyboard ? (library.find((x) => heldByLib(x, m))?.name ?? t('macro.slot.used')) : m.name) : t('macro.slot.empty')}`,
                }))}
                onChange={(v) => setPushSlot(Number(v))}
              />
            </label>
          )}
          <Tooltip text={pushTip}>
            <button className="btn" disabled={!canPush || pushBusy} onClick={() => void push()}>
              <Icon name="upload" size={12} /> {t('macro.pushToDevice')}
            </button>
          </Tooltip>
        </div>
      </section>

      {/* The leave prompt's three ways (LeaveDialog): keep editing first, so
          Enter and Escape stay; Discard in red; Save, then go. */}
      {pending && (
        <ModalFrame
          title={t('macro.switch.title')}
          body={t('macro.discard.body', { name: draft.name || t('macro.defaultName', { n: 1 }) })}
          onCancel={() => setPending(null)}
        >
          <button className="btn" onClick={() => setPending(null)}>
            {t('leave.keep')}
          </button>
          <button className="btn danger" onClick={applyPending}>
            {t('macro.discard.confirm')}
          </button>
          <button className="btn primary" onClick={() => void saveThenGo()}>
            {t('macro.save')}
          </button>
        </ModalFrame>
      )}
      {deleting && (
        <ConfirmDialog
          title={t('macro.deleteOnDevice.title', {
            name:
              macroSlotOf(deleting.id) === null
                ? deleting.name
                : slotLabel(macroSlotOf(deleting.id)!),
          })}
          body={t('macro.deleteOnDevice.body')}
          confirmLabel={t('common.delete')}
          onResolve={(ok) => {
            const m = deleting;
            setDeleting(null);
            if (ok) void deleteOnDevice(m);
          }}
        />
      )}
      {confirmDelete && (
        <ConfirmDialog
          title={t('macro.delete.title')}
          body={t('macro.delete.body', { name: confirmDelete.name })}
          confirmLabel={t('common.delete')}
          onResolve={(ok) => {
            const target = confirmDelete;
            setConfirmDelete(null);
            if (ok) void remove(target);
          }}
        />
      )}
    </div>
  );
}
