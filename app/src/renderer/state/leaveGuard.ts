import { useEffect, useRef, useSyncExternalStore } from 'react';
import { sd } from './bridge';
import { hostFeatures } from './host';
import { useStore } from './store';

/**
 * Asking before a navigation throws away a change nobody applied.
 *
 * Some settings are staged rather than written as they change: a remap waits
 * for Apply, the lighting editors are previews until Apply to keyboard, a
 * mod-tap or DKS key waits for its panel's Apply, a macro is a draft until
 * Save. Leaving the screen they are on loses that work. Two halves, so neither
 * has to know the other:
 *
 *  - a pane REGISTERS what it holds (`usePendingChange`), keyed by device id —
 *    every open device tab stays mounted (App.tsx hides rather than unmounts),
 *    so two devices can hold changes at once and each exit asks about its own;
 *  - a navigation ASKS before going (`confirmLeave`): straight through when
 *    nothing would be lost, otherwise one prompt (components/LeaveDialog.tsx,
 *    rendered once by App) that keeps editing, discards, or — for a single
 *    change — applies it and then goes.
 *
 * Which exits ask, which do not and why: docs/design/leave-guard.md.
 */

/** 'apply' writes it to the device; 'save' keeps it on this computer (a macro). */
export type PendingKind = 'apply' | 'save';

export interface PendingChange {
  readonly kind: PendingKind;
  /** Is there something leaving would lose, right now? */
  dirty(): boolean;
  /** What the prompt calls it: "Caps Lock → Esc", "Per-key colours", a macro's name. */
  label(): string;
  /** The label is plural ("Per-key colours"), so the prompt says "haven't been applied". */
  readonly plural?: boolean;
  /**
   * Apply (or save) it. Resolves false when that was refused or failed, which
   * keeps the user where they are — the write's own toast says why. Absent
   * when it cannot be done from what is on screen.
   */
  readonly commit?: () => Promise<boolean>;
}

export interface PendingItem {
  deviceId: string;
  change: PendingChange;
}

const registry = new Map<string, Set<PendingChange>>();

/** Returns the de-registration, for an effect cleanup. */
export function registerPendingChange(deviceId: string, change: PendingChange): () => void {
  let set = registry.get(deviceId);
  if (!set) registry.set(deviceId, (set = new Set()));
  set.add(change);
  notifyPendingChanged();
  return () => {
    // Only our own entry: a remount registers its replacement before the old
    // effect's cleanup runs.
    const s = registry.get(deviceId);
    if (s?.delete(change) && s.size === 0) registry.delete(deviceId);
    notifyPendingChanged();
  };
}

/** What leaving would lose — on one device, or (no id) on every device. */
export function pendingChanges(deviceId?: string): PendingItem[] {
  const out: PendingItem[] = [];
  for (const [id, set] of registry) {
    if (deviceId !== undefined && id !== deviceId) continue;
    for (const change of set) if (change.dirty()) out.push({ deviceId: id, change });
  }
  return out;
}

let anyPending = false;
const pendingListeners = new Set<(any: boolean) => void>();

/** Re-evaluate "is anything pending anywhere"; listeners hear only the flips. */
export function notifyPendingChanged(): void {
  const any = pendingChanges().length > 0;
  if (any === anyPending) return;
  anyPending = any;
  for (const l of pendingListeners) l(any);
}

export function onPendingChanged(listener: (any: boolean) => void): () => void {
  pendingListeners.add(listener);
  return () => void pendingListeners.delete(listener);
}

export interface PendingInput {
  dirty: boolean;
  label: () => string;
  commit?: () => Promise<boolean>;
  kind?: PendingKind;
  plural?: boolean;
}

/**
 * Register what this pane holds for as long as it is mounted. Read through a
 * ref, so the registration does not churn on every keystroke; `dirty` comes
 * from the pane's own state, so every render may have moved it.
 */
export function usePendingChange(deviceId: string, input: PendingInput): void {
  const ref = useRef(input);
  ref.current = input;
  useEffect(
    () =>
      registerPendingChange(deviceId, {
        get kind() {
          return ref.current.kind ?? 'apply';
        },
        dirty: () => ref.current.dirty,
        label: () => ref.current.label(),
        get commit() {
          return ref.current.commit;
        },
        get plural() {
          return ref.current.plural;
        },
      }),
    [deviceId],
  );
  useEffect(() => notifyPendingChanged());
}

/** Which way out — it decides the prompt's wording. */
export type LeaveExit = 'leave' | 'switch' | 'quit';

export interface LeaveRequest {
  exit: LeaveExit;
  /** What would be lost, as it stood when the question was asked. */
  items: PendingItem[];
  proceed: () => void;
}

let request: LeaveRequest | null = null;
const requestListeners = new Set<() => void>();

function setRequest(next: LeaveRequest | null): void {
  request = next;
  for (const l of requestListeners) l();
}

/**
 * Go, or ask first. `proceed` runs now when leaving loses nothing; otherwise
 * only once the user discards (or applies) — never on Keep editing.
 * `deviceId` null means every device: quitting.
 */
export function confirmLeave(
  deviceId: string | null,
  proceed: () => void,
  exit: LeaveExit = 'leave',
): void {
  const items = pendingChanges(deviceId ?? undefined);
  if (!items.length) {
    proceed();
    return;
  }
  // One question at a time — but quitting outranks whatever else was open.
  if (request && (exit !== 'quit' || request.exit === 'quit')) return;
  setRequest({ exit, items, proceed });
}

export function useLeaveRequest(): LeaveRequest | null {
  return useSyncExternalStore(
    (cb) => {
      requestListeners.add(cb);
      return () => void requestListeners.delete(cb);
    },
    () => request,
  );
}

export type LeaveChoice = 'keep' | 'discard' | 'commit';

/** The prompt's answer. 'commit' goes only once the change has landed. */
export async function resolveLeave(choice: LeaveChoice): Promise<void> {
  const r = request;
  if (!r) return;
  setRequest(null);
  if (choice === 'keep') return;
  if (choice === 'commit') {
    const only = r.items.length === 1 ? r.items[0] : undefined;
    if (!only?.change.commit) return;
    let ok = false;
    try {
      ok = await only.change.commit();
    } catch {
      ok = false;
    }
    if (!ok) return;
  }
  r.proceed();
}

/**
 * Where a click is someone navigating — the title bar and its tabs, the
 * section rail, a pane's own section tabs — or answering a dialog through its
 * backdrop. Remap and Actuation drop their key selection on a click anywhere
 * else, and with it whatever was staged for that key; on these it must
 * survive, so the prompt rather than a click handler that fired first decides
 * what happens to it, and Keep editing comes back to exactly what was there.
 */
export const NAVIGATION_SURFACES = '.topbar, .tabrail, .title-tabs, .modal-scrim';

/**
 * The host's part of asking, for App's mount effect.
 *
 * The desktop holds a quit while the renderer says something is pending, and
 * sends `app:quitRequested` instead; the answer comes back as `quitApp`. A
 * page can only ask through `beforeunload`, in the browser's own words.
 */
export function installLeaveGuardHost(): () => void {
  const offs: Array<() => void> = [];
  if (hostFeatures.quitPrompt) {
    offs.push(onPendingChanged((any) => void sd.setPendingChanges(any)));
    offs.push(
      sd.on('app:quitRequested', () => {
        // Show the screen holding the changes, when they are all on one device.
        const ids = new Set(pendingChanges().map((i) => i.deviceId));
        if (ids.size === 1) useStore.getState().openTab({ name: 'config', deviceId: [...ids][0]! });
        confirmLeave(null, () => void sd.quitApp(), 'quit');
      }),
    );
  }
  if (hostFeatures.unloadPrompt) {
    const ask = (e: BeforeUnloadEvent) => {
      if (!pendingChanges().length) return;
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', ask);
    offs.push(() => window.removeEventListener('beforeunload', ask));
  }
  return () => offs.forEach((off) => off());
}

/** Tests only: forget every registration and any open question. */
export function resetLeaveGuard(): void {
  registry.clear();
  anyPending = false;
  setRequest(null);
}
