import { useCallback, useMemo, useReducer } from 'react';

/** How many changes Undo can walk back. */
export const HISTORY_CAP = 40;

/**
 * An editor's value with its undo and redo stacks, and what the device holds.
 *
 * `saved` is the board's own state — the last read, or the last Apply — and
 * is what Cancel goes back to and what "unapplied changes" is measured
 * against. `null` until the first read lands.
 */
export interface History<T> {
  past: T[];
  present: T;
  future: T[];
  /** The coalescing group of the last commit, while it is still open: a paint
   *  stroke is many commits that undo as one. */
  group: string | null;
  saved: T | null;
}

export type HistoryAction<T> =
  | { type: 'commit'; next: T | ((cur: T) => T); coalesce?: string }
  | { type: 'seal' }
  | { type: 'undo' }
  | { type: 'redo' }
  | { type: 'adopt'; value: T; explicit: boolean }
  | { type: 'markSaved'; value?: T }
  | { type: 'revert' }
  | { type: 'reset'; value: T };

export const initialHistory = <T>(value: T): History<T> => ({
  past: [],
  present: value,
  future: [],
  group: null,
  saved: null,
});

/**
 * The whole behaviour, as a pure reducer — testable without React, and safe
 * under StrictMode's double invocation, since a functional `next` is resolved
 * here against the state it applies to rather than against a closure.
 *
 *  - **commit** pushes the old value onto the undo stack and clears redo. A
 *    commit that changes nothing is not a step. Successive commits with the
 *    same `coalesce` key replace the value in place until `seal` — one stroke,
 *    one step.
 *  - **adopt** is a read landing. An explicit one (the user pressed Read, or
 *    the re-read after an Apply) is an undoable step. A quiet one replaces the
 *    value only when there is nothing unapplied to lose; otherwise the edits
 *    stay, now measured against the fresh read.
 *  - **revert** (Cancel) goes back to `saved` — as a step, so Undo brings the
 *    edits back.
 *  - The undo stack keeps the last `cap` states.
 */
export function historyReducer<T>(equals: (a: T, b: T) => boolean, cap = HISTORY_CAP) {
  const push = (past: T[], v: T) => [...past, v].slice(-cap);
  return (s: History<T>, a: HistoryAction<T>): History<T> => {
    switch (a.type) {
      case 'commit': {
        const next = typeof a.next === 'function' ? (a.next as (cur: T) => T)(s.present) : a.next;
        if (equals(next, s.present)) return s;
        if (a.coalesce && a.coalesce === s.group) return { ...s, present: next, future: [] };
        return {
          ...s,
          past: push(s.past, s.present),
          present: next,
          future: [],
          group: a.coalesce ?? null,
        };
      }
      case 'seal':
        return s.group === null ? s : { ...s, group: null };
      case 'undo': {
        const prev = s.past[s.past.length - 1];
        if (prev === undefined) return s;
        return {
          ...s,
          past: s.past.slice(0, -1),
          present: prev,
          future: [s.present, ...s.future],
          group: null,
        };
      }
      case 'redo': {
        const [next, ...rest] = s.future;
        if (next === undefined) return s;
        return { ...s, past: push(s.past, s.present), present: next, future: rest, group: null };
      }
      case 'adopt': {
        const edited = s.saved !== null && !equals(s.present, s.saved);
        if (a.explicit) {
          if (equals(a.value, s.present)) return { ...s, saved: a.value, group: null };
          return {
            past: push(s.past, s.present),
            present: a.value,
            future: [],
            group: null,
            saved: a.value,
          };
        }
        if (edited) return { ...s, saved: a.value };
        return { ...s, present: a.value, future: [], group: null, saved: a.value };
      }
      case 'markSaved':
        return { ...s, saved: a.value ?? s.present };
      case 'revert':
        if (s.saved === null || equals(s.present, s.saved)) return s;
        return {
          ...s,
          past: push(s.past, s.present),
          present: s.saved,
          future: [],
          group: null,
        };
      case 'reset':
        return { ...initialHistory(a.value), saved: a.value };
    }
  };
}

/**
 * `historyReducer` as a hook. Every callback is stable, so they can sit in
 * effect dependencies and window listeners without re-subscribing.
 */
export function useUndoHistory<T>(
  initial: T,
  opts: { equals: (a: T, b: T) => boolean; cap?: number },
) {
  // The reducer is built once: `equals` and `cap` are configuration, not state.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const reducer = useMemo(() => historyReducer<T>(opts.equals, opts.cap), []);
  const [s, dispatch] = useReducer(reducer, initial, initialHistory);

  const commit = useCallback(
    (next: T | ((cur: T) => T), coalesce?: string) => dispatch({ type: 'commit', next, coalesce }),
    [],
  );
  const seal = useCallback(() => dispatch({ type: 'seal' }), []);
  const undo = useCallback(() => dispatch({ type: 'undo' }), []);
  const redo = useCallback(() => dispatch({ type: 'redo' }), []);
  const adopt = useCallback(
    (value: T, explicit: boolean) => dispatch({ type: 'adopt', value, explicit }),
    [],
  );
  const markSaved = useCallback((value?: T) => dispatch({ type: 'markSaved', value }), []);
  const revert = useCallback(() => dispatch({ type: 'revert' }), []);
  const reset = useCallback((value: T) => dispatch({ type: 'reset', value }), []);

  return {
    present: s.present,
    saved: s.saved,
    canUndo: s.past.length > 0,
    canRedo: s.future.length > 0,
    dirty: s.saved !== null && !opts.equals(s.present, s.saved),
    commit,
    seal,
    undo,
    redo,
    adopt,
    markSaved,
    revert,
    reset,
  };
}
