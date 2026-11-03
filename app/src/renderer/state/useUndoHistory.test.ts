import { describe, expect, it } from 'vitest';
import { HISTORY_CAP, historyReducer, initialHistory, type History } from './useUndoHistory';

/**
 * The per-key lighting editor's Undo / Redo / Cancel. The rules that matter:
 * a paint stroke is ONE step however many keys it crosses, the stack is
 * capped, a read does not throw unapplied work away behind the user's back,
 * and Cancel is itself undoable.
 */
type V = Record<string, number>;
const eq = (a: V, b: V) => JSON.stringify(a) === JSON.stringify(b);
const r = historyReducer<V>(eq);
const run = (s: History<V>, ...as: Parameters<typeof r>[1][]) => as.reduce(r, s);
const start = (v: V = {}): History<V> => ({ ...initialHistory(v), saved: v });

describe('undo history', () => {
  it('round-trips commit, undo and redo', () => {
    const s = run(start(), { type: 'commit', next: { a: 1 } }, { type: 'commit', next: { a: 2 } });
    const u = r(s, { type: 'undo' });
    expect(u.present).toEqual({ a: 1 });
    expect(r(u, { type: 'redo' }).present).toEqual({ a: 2 });
  });

  it('does not count a commit that changes nothing', () => {
    const s = run(start({ a: 1 }), { type: 'commit', next: { a: 1 } });
    expect(s.past).toHaveLength(0);
  });

  it('makes one step of a stroke, until it is sealed', () => {
    const s = run(
      start(),
      { type: 'commit', next: { a: 1 }, coalesce: 'paint' },
      { type: 'commit', next: { a: 1, b: 1 }, coalesce: 'paint' },
      { type: 'commit', next: { a: 1, b: 1, c: 1 }, coalesce: 'paint' },
    );
    expect(s.past).toHaveLength(1);
    expect(r(s, { type: 'undo' }).present).toEqual({});
    // A sealed stroke ends there: the next press is its own step.
    const two = run(s, { type: 'seal' }, { type: 'commit', next: { d: 1 }, coalesce: 'paint' });
    expect(two.past).toHaveLength(2);
  });

  it('applies functional commits to the latest value', () => {
    const s = run(
      start(),
      { type: 'commit', next: (c) => ({ ...c, a: 1 }) },
      { type: 'commit', next: (c) => ({ ...c, b: 1 }) },
    );
    expect(s.present).toEqual({ a: 1, b: 1 });
  });

  it('clears redo on a new change', () => {
    const s = run(
      start(),
      { type: 'commit', next: { a: 1 } },
      { type: 'undo' },
      { type: 'commit', next: { b: 1 } },
    );
    expect(s.future).toHaveLength(0);
  });

  it(`keeps ${HISTORY_CAP} steps and no more`, () => {
    let s = start();
    for (let i = 1; i <= HISTORY_CAP + 5; i++) s = r(s, { type: 'commit', next: { a: i } });
    expect(s.past).toHaveLength(HISTORY_CAP);
    for (let i = 0; i < HISTORY_CAP; i++) s = r(s, { type: 'undo' });
    // The oldest five are gone: the furthest back is step 5, not the start.
    expect(s.present).toEqual({ a: 5 });
  });

  it('lets a quiet read replace a clean editor, but never unapplied edits', () => {
    const clean = r(start({ a: 1 }), { type: 'adopt', value: { a: 9 }, explicit: false });
    expect(clean.present).toEqual({ a: 9 });
    expect(clean.past).toHaveLength(0);

    const edited = run(
      start({ a: 1 }),
      { type: 'commit', next: { a: 2 } },
      { type: 'adopt', value: { a: 9 }, explicit: false },
    );
    expect(edited.present).toEqual({ a: 2 });
    expect(edited.saved).toEqual({ a: 9 });
  });

  it('makes an explicit read an undoable step', () => {
    const s = run(
      start({ a: 1 }),
      { type: 'commit', next: { a: 2 } },
      { type: 'adopt', value: { a: 9 }, explicit: true },
    );
    expect(s.present).toEqual({ a: 9 });
    expect(r(s, { type: 'undo' }).present).toEqual({ a: 2 });
  });

  it('cancels back to the board, undoably, and only when there is something to cancel', () => {
    const s = run(start({ a: 1 }), { type: 'commit', next: { a: 2 } }, { type: 'revert' });
    expect(s.present).toEqual({ a: 1 });
    expect(r(s, { type: 'undo' }).present).toEqual({ a: 2 });
    expect(r(start({ a: 1 }), { type: 'revert' }).past).toHaveLength(0);
  });

  it('is clean again after an Apply, and dirty again after an undo', () => {
    const applied = run(start({ a: 1 }), { type: 'commit', next: { a: 2 } }, { type: 'markSaved' });
    expect(eq(applied.present, applied.saved!)).toBe(true);
    const back = r(applied, { type: 'undo' });
    expect(eq(back.present, back.saved!)).toBe(false);
  });
});
