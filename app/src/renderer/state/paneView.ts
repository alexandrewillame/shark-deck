import { useCallback, useSyncExternalStore } from 'react';

/**
 * Which sub-view a pane is showing — Base or Fn, Global or Per-key, Keys or
 * Test — kept OUTSIDE the pane so it survives the pane being rebuilt.
 *
 * Every config pane is remounted whenever the device's profile changes
 * (`key={active}:{configEpoch}` in DeviceConfig), which is how each one is made
 * to re-read the board. A sub-view held in `useState` dies with it, so
 * switching profile while looking at the Fn layer put you back on Base, and
 * the same for every other sub-view in the app. The choice is about what you
 * are *doing*, not about the profile, so it has no business being thrown away
 * when the profile changes.
 *
 * Module state rather than a zustand slice: this is per-session UI position,
 * nothing else reads it, and keeping it out of the store means a sub-view
 * switch re-renders the one pane that asked for it rather than every consumer
 * of the store.
 *
 * Keys are `<scope>:<pane>` — scoped by device (or model) so two keyboards
 * open side by side do not share a position.
 */
const views = new Map<string, string>();
const listeners = new Set<() => void>();

function emit() {
  for (const l of listeners) l();
}

function subscribe(fn: () => void) {
  listeners.add(fn);
  return () => void listeners.delete(fn);
}

/** Read without subscribing — for a caller that only needs the current value. */
export function peekPaneView(key: string): string | undefined {
  return views.get(key);
}

export function setPaneView(key: string, value: string): void {
  if (views.get(key) === value) return;
  views.set(key, value);
  emit();
}

/** Forget a scope's positions — used when a device goes away for good. */
export function dropPaneViews(scope: string): void {
  let changed = false;
  for (const k of [...views.keys()])
    if (k.startsWith(`${scope}:`)) {
      views.delete(k);
      changed = true;
    }
  if (changed) emit();
}

/**
 * `useState`'s shape, backed by the module store above.
 *
 * `fallback` is only used the first time a key is seen; afterwards the stored
 * value wins, which is the whole point — a remount must not reset it.
 */
export function usePaneView<T extends string>(key: string, fallback: T): [T, (v: T) => void] {
  const value = useSyncExternalStore(
    subscribe,
    () => (views.get(key) as T | undefined) ?? fallback,
    () => fallback,
  );
  const set = useCallback((v: T) => setPaneView(key, v), [key]);
  return [value, set];
}
