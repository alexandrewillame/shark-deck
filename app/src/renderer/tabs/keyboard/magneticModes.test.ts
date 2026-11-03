import { describe, expect, it } from 'vitest';
import { en } from '@shared/i18n';
import type { MagneticKeySettings } from '@shared/types/keyboard-settings';
import { snapPairMismatch } from '../../../main/devices/drivers/compx-he-keyboard';
import {
  MODE_DEFS,
  choiceOf,
  isHalfPair,
  keyIdOf,
  layoutZoneBindings,
  pairNumbers,
  partnerOf,
  planCopy,
  planModeChange,
  planPair,
  planReset,
  planUnpair,
  settingsForCopy,
  type KeyMap,
} from './magneticModes';

/**
 * The rules a change of key mode has to keep. The reported failure: choosing
 * "Snap" set one key's mode byte and nothing else — half a pair, which the
 * firmware ignores — and copying a paired key's settings handed the copy the
 * same partner.
 */

const key = (row: number, col: number, over: Partial<MagneticKeySettings> = {}) =>
  ({ row, col, actuationMm: 2.5, rapidTrigger: false, mode: 'normal', ...over }) as const;
const A = key(2, 1);
const D = key(2, 3, { rapidTrigger: true });
const W = key(1, 2);
const S = key(2, 2);
const ref = (k: { row: number; col: number }) => ({ row: k.row, col: k.col });

const board = (...keys: MagneticKeySettings[]): KeyMap =>
  Object.fromEntries(keys.map((k) => [keyIdOf(k), k]));

/** A board with the plan applied — what it holds after the write. */
const apply = (map: KeyMap, plan: MagneticKeySettings[]): KeyMap => ({
  ...map,
  ...board(...plan),
});

const paired = (map: KeyMap) => planPair(map, A, D);

describe('the modes on offer', () => {
  it('calls it Snap-tap, and every mode explains itself briefly', () => {
    expect(MODE_DEFS.map((m) => en[m.labelKey])).toContain('Snap-tap');
    for (const m of MODE_DEFS) {
      expect(en[m.tipKey].split(/\s+/).length, m.value).toBeLessThanOrEqual(25);
    }
  });

  it('marks exactly the unconfirmed modes Experimental — none, since the board checks', () => {
    // Mod-tap and DKS both behaved on an R85HE (verify-he-writes), Mod-tap once
    // its zones were the right way round.
    expect(MODE_DEFS.filter((m) => m.experimental).map((m) => m.value)).toEqual([]);
  });

  it('offers the two toggle styles as one Toggle', () => {
    expect(choiceOf('tgl_hold')).toBe('toggle');
    expect(choiceOf('tgl_dots')).toBe('toggle');
    expect(choiceOf(undefined)).toBe('normal');
  });
});

describe('pairing', () => {
  it('writes both keys, each naming the other and keeping its own settings', () => {
    const plan = paired(board(A, D));
    expect(plan).toHaveLength(2);
    const after = apply(board(A, D), plan);
    expect(partnerOf(after, A)).toMatchObject(ref(D));
    expect(partnerOf(after, D)).toMatchObject(ref(A));
    // D's own rapid trigger survives — the old driver stamped A's over it.
    expect(after[keyIdOf(D)]!.rapidTrigger).toBe(true);
    expect(snapPairMismatch(plan)).toBeNull();
  });

  it("releases both keys' previous partners", () => {
    // A with W, and D with S…
    const four = board(A, D, W, S);
    const aw = apply(four, planPair(four, A, W));
    const start = apply(aw, planPair(aw, D, S));
    expect(partnerOf(start, W)).toMatchObject(ref(A));
    expect(partnerOf(start, S)).toMatchObject(ref(D));

    const plan = planPair(start, A, D);
    const after = apply(start, plan);
    expect(after[keyIdOf(W)]).toMatchObject({ mode: 'normal', socdPartner: null });
    expect(after[keyIdOf(S)]).toMatchObject({ mode: 'normal', socdPartner: null });
    expect(isHalfPair(after, W) || isHalfPair(after, S)).toBe(false);
    expect(snapPairMismatch(plan)).toBeNull();
  });

  it('refuses to pair a key with itself, or with a key it has not read', () => {
    expect(planPair(board(A), A, A)).toEqual([]);
    expect(planPair(board(A), A, D)).toEqual([]);
  });

  it('numbers the pairs on the board, and spots a half pair', () => {
    const start = apply(board(A, D, W, S), paired(board(A, D, W, S)));
    const n = pairNumbers(start, [W, A, S, D]);
    expect(n.get(keyIdOf(A))).toBe(1);
    expect(n.get(keyIdOf(D))).toBe(1);
    expect(n.has(keyIdOf(W))).toBe(false);

    const half = { ...start, [keyIdOf(W)]: { ...W, mode: 'snap' as const, socdPartner: ref(A) } };
    expect(isHalfPair(half, W)).toBe(true);
    expect(isHalfPair(half, A)).toBe(false);
  });
});

describe('leaving a pair', () => {
  const start = apply(board(A, D, W), paired(board(A, D, W)));

  it('unpairs both keys', () => {
    const after = apply(start, planUnpair(start, A));
    expect(after[keyIdOf(A)]!.mode).toBe('normal');
    expect(after[keyIdOf(D)]!.mode).toBe('normal');
  });

  it('a new mode on one key releases its partner', () => {
    const plan = planModeChange(start, [A], 'tgl_hold');
    const after = apply(start, plan);
    expect(after[keyIdOf(A)]!.mode).toBe('tgl_hold');
    expect(after[keyIdOf(D)]).toMatchObject({ mode: 'normal', socdPartner: null });
  });

  it('a reset of one key releases its partner', () => {
    const after = apply(
      start,
      planReset(start, [D], (k) => key(k.row, k.col)),
    );
    expect(after[keyIdOf(A)]).toMatchObject({ mode: 'normal', socdPartner: null });
  });

  it('a reset of both keys writes each once', () => {
    expect(planReset(start, [A, D], (k) => key(k.row, k.col))).toHaveLength(2);
  });
});

describe('modes that need values of their own', () => {
  it('gives a new mod-tap or DKS key the defaults it lacks, and keeps ones it has', () => {
    const map = board(A, { ...W, mtHoldMs: 350 });
    const plan = planModeChange(map, [A, W], 'mt');
    expect(plan.map((k) => k.mtHoldMs)).toEqual([200, 350]);
    expect(planModeChange(map, [A], 'dks')[0]!.dksPointMm).toBe(0.7);
  });

  it('never makes snap-tap without a partner', () => {
    expect(planModeChange(board(A), [A], 'snap')).toEqual([]);
  });
});

describe('copying settings', () => {
  const start = apply(board(A, D, W, S), paired(board(A, D, W, S)));

  it('never copies a partner: the copy is a plain key with the same travel', () => {
    const copy = settingsForCopy({ ...start[keyIdOf(A)]!, actuationMm: 1.2 }, W);
    expect(copy).toMatchObject({ row: W.row, col: W.col, mode: 'normal', actuationMm: 1.2 });
    expect(copy.socdPartner).toBeNull();
  });

  it('releases the partner of a key that is copied over', () => {
    const plan = planCopy(start, { ...S, actuationMm: 1 }, [D]);
    const after = apply(start, plan);
    expect(after[keyIdOf(D)]).toMatchObject({ mode: 'normal', actuationMm: 1 });
    expect(after[keyIdOf(A)]).toMatchObject({ mode: 'normal', socdPartner: null });
  });

  it('copies modes that need nothing of their own', () => {
    expect(settingsForCopy({ ...S, mode: 'tgl_dots' }, W).mode).toBe('tgl_dots');
    expect(settingsForCopy({ ...S, mode: 'mt', mtHoldMs: 300 }, W)).toMatchObject({
      mode: 'normal',
      mtHoldMs: undefined,
    });
  });
});

describe('the bindings a saved layout keeps', () => {
  const board = [
    { label: 'A', row: 1, col: 1, slot: 9, x: 1, y: 1 },
    { label: 'S', row: 1, col: 2, slot: 15, x: 2, y: 1 },
    { label: 'D', row: 1, col: 3, slot: 21, x: 3, y: 1 },
    { label: 'F', row: 1, col: 4, slot: 27, x: 4, y: 1 },
  ];
  const record = {
    9: [null, 'e0'],
    15: [null, '05', '06', '07'],
    21: [null, 'e1'],
    27: [null, null],
  };

  it("keeps the Mod-tap and DKS keys' bindings, by position", () => {
    const keys = [
      key(1, 1, { mode: 'mt' }),
      key(1, 2, { mode: 'dks' }),
      key(1, 3), // plain now: its old hold is not worth keeping
      key(1, 4, { mode: 'mt' }), // nothing recorded worth saving
    ];
    expect(layoutZoneBindings(keys, board, record)).toEqual([
      { row: 1, col: 1, zones: [null, 'e0'] },
      { row: 1, col: 2, zones: [null, '05', '06', '07'] },
    ]);
  });

  it('keeps nothing when the record could not be read', () => {
    expect(layoutZoneBindings([key(1, 1, { mode: 'mt' })], board, null)).toEqual([]);
  });
});
