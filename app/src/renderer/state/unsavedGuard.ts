/**
 * Lets a deeply-nested editor veto a navigation that would throw its draft
 * away, without the navigation having to know what an editor is.
 *
 * The macro editor lives four components below the tab rail and the tab strip,
 * and both of those destroy it: switching config tab remounts the pane
 * (`key={active}:{configEpoch}` in DeviceConfig) and closing a device tab
 * unmounts the whole screen. Neither had any way to ask first, so a recorded,
 * unsaved macro vanished on a stray click.
 *
 * Keyed by device id rather than a single slot: every open device tab stays
 * mounted at once (App.tsx hides rather than unmounts), so two macro editors
 * can be registered simultaneously and each navigation must consult its own.
 */
export interface UnsavedGuard {
  /** true while there is work that closing would lose */
  dirty: () => boolean;
  /** persist it; false if the save was refused (e.g. the name is empty) */
  save: () => Promise<boolean>;
  /** what to call the thing at risk, for the prompt */
  name: () => string;
}

const guards = new Map<string, UnsavedGuard>();

/** Returns the de-registration function, for an effect cleanup. */
export function registerUnsavedGuard(key: string, guard: UnsavedGuard): () => void {
  guards.set(key, guard);
  return () => {
    // Only clear our own entry: a remount can register the replacement before
    // the old effect's cleanup runs.
    if (guards.get(key) === guard) guards.delete(key);
  };
}

/** The guard for this key, but only while it actually has something to lose. */
export function getUnsavedGuard(key: string): UnsavedGuard | null {
  const g = guards.get(key);
  return g && g.dirty() ? g : null;
}
