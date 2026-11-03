import { describe, expect, it } from 'vitest';
import type { KeyLayoutEntry } from '@shared/types/keys';
import { KB_TRAVEL_RANGE } from '@shared/keyboard-travel';
import { blocksByKey, diffField, keyNames } from './profileDiff';

/**
 * The bug this module exists to fix: the compare popup summarised a collection
 * by its LENGTH, so two profiles whose actuation differed on a dozen keys both
 * rendered as "79" and the table said nothing at all.
 *
 * So the assertions below are mostly about the detail — that a difference is
 * reported per key and per setting, named the way the Actuation tab names it,
 * and that equal-but-differently-shaped data does not produce phantom rows.
 */

const LAYOUT: KeyLayoutEntry[] = [
  { label: 'Esc', row: 0, col: 0, slot: 0 } as KeyLayoutEntry,
  { label: 'W', row: 1, col: 2, slot: 5 } as KeyLayoutEntry,
  { label: 'A', row: 2, col: 1, slot: 9 } as KeyLayoutEntry,
];
const NAMES = keyNames(LAYOUT);

const mag = (over: Partial<Record<string, unknown>> = {}) => ({
  row: 1,
  col: 2,
  actuationMm: 1.2,
  releaseMm: 1.0,
  rapidTrigger: false,
  ...over,
});

describe('diffField', () => {
  it('reports a scalar as the change itself, with no detail rows', () => {
    const d = diffField('pollRate', 1000, 8000, NAMES);
    expect(d.same).toBe(false);
    expect(d.unit).toBe('value');
    expect([d.a, d.b]).toEqual(['1000', '8000']);
    expect(d.rows).toEqual([]);
  });

  it('says nothing when the two sides match', () => {
    expect(diffField('pollRate', 1000, 1000, NAMES).same).toBe(true);
    expect(diffField('magnetic', [mag()], [mag()], NAMES).same).toBe(true);
  });

  it('names the key AND the setting that moved, not just a count', () => {
    // The reported case: same number of keys, different values. Neither side
    // is the 2.0 mm factory value, so the default marks stay out of the way.
    const d = diffField('magnetic', [mag()], [mag({ actuationMm: 2.4 })], NAMES);

    expect(d.same).toBe(false);
    expect(d).toMatchObject({ unit: 'key', changed: 1, total: 1 });
    // The key and the setting stay apart: they are different kinds of thing
    // and the table styles them differently, which one joined string cannot
    // express.
    expect(d.rows).toEqual([
      {
        label: 'W',
        setting: 'Actuation',
        a: '1.20 mm',
        b: '2.40 mm',
        aDefault: false,
        bDefault: false,
        keyId: '1,2',
      },
    ]);
  });

  it('lists every setting that moved on one key, separately', () => {
    const d = diffField(
      'magnetic',
      [mag()],
      [mag({ actuationMm: 2.0, rapidTrigger: true })],
      NAMES,
    );
    expect(d.rows.map((r) => `${r.label}/${r.setting}`)).toEqual([
      'W/Actuation',
      'W/Rapid Trigger',
    ]);
    // Booleans read as on/off, matching the toggles they come from.
    expect(d.rows[1]).toMatchObject({ a: 'off', b: 'on' });
  });

  it('counts keys, not rows, in the headline', () => {
    const a = [mag(), mag({ row: 0, col: 0 })];
    const b = [mag({ actuationMm: 2, rapidTrigger: true }), mag({ row: 0, col: 0 })];
    const d = diffField('magnetic', a, b, NAMES);
    // One key changed, two settings on it — the count is of KEYS, so a key
    // with three changed settings must not read as three keys.
    expect(d).toMatchObject({ unit: 'key', changed: 1, total: 2 });
    expect(d.rows).toHaveLength(2);
  });

  it('matches keys by identity, not by position', () => {
    // Same two keys, reported in the opposite order. Position matching would
    // call both of them changed.
    const a = [mag(), mag({ row: 0, col: 0, actuationMm: 0.5 })];
    const b = [mag({ row: 0, col: 0, actuationMm: 0.5 }), mag()];
    expect(diffField('magnetic', a, b, NAMES).same).toBe(false); // array order differs…
    expect(diffField('magnetic', a, b, NAMES).rows).toEqual([]); // …but nothing actually changed
  });

  it('shows a key one profile has and the other does not', () => {
    const d = diffField('magnetic', [mag(), mag({ row: 0, col: 0 })], [mag()], NAMES);
    expect(d.rows.some((r) => r.label.startsWith('Esc'))).toBe(true);
    expect(d.rows.every((r) => r.a === '—' || r.b === '—' || r.a !== r.b)).toBe(true);
  });

  it('gives per-key lighting a swatch as well as a hex', () => {
    const d = diffField(
      'perKeyLighting',
      [{ index: 1, color: [255, 0, 0] }],
      [{ index: 1, color: [0, 0, 255] }],
      NAMES,
    );
    expect(d.rows).toEqual([
      {
        label: 'W',
        a: '#ff0000',
        b: '#0000ff',
        aColor: '#ff0000',
        bColor: '#0000ff',
        keyId: '1',
      },
    ]);
  });

  it('names a remapped key and shows what it is bound to', () => {
    const d = diffField(
      'keyRemapFn',
      { 5: { slot: 5, code: '1a', kind: 'key', label: 'W' } },
      { 5: { slot: 5, code: '80', kind: 'media', label: 'Vol +' } },
      NAMES,
    );
    expect(d.rows).toEqual([{ label: 'W', a: 'W', b: 'Vol +', keyId: '5' }]);
  });

  it('breaks a settings object into the properties that differ', () => {
    const d = diffField(
      'sensor',
      { lod: 1, angleSnap: false },
      { lod: 2, angleSnap: false },
      NAMES,
    );
    expect(d).toMatchObject({ unit: 'setting', changed: 1 });
    expect(d.rows).toEqual([{ label: 'lod', a: '1', b: '2' }]);
  });

  it('marks a field neither profile could read, rather than calling it identical', () => {
    const d = diffField('magnetic', null, null, NAMES);
    expect(d.unread).toBe(true);
  });

  it('falls back to a slot number for a key the layout does not name', () => {
    const d = diffField('magnetic', [mag({ row: 9, col: 9 })], [], NAMES);
    expect(d.rows[0]!.label.startsWith('9,9')).toBe(true);
  });

  it('marks the side that is still the factory value', () => {
    // Which side is "the one someone chose" is the useful half of a diff, and
    // it is not recoverable from two numbers alone.
    const d = diffField(
      'magnetic',
      [mag({ actuationMm: KB_TRAVEL_RANGE.travel.default })],
      [mag({ actuationMm: 0.4 })],
      NAMES,
    );
    expect(d.rows[0]).toMatchObject({ aDefault: true, bDefault: false });
  });

  it('marks a default boolean and a default mode too', () => {
    const d = diffField('magnetic', [mag()], [mag({ rapidTrigger: true })], NAMES);
    expect(d.rows[0]).toMatchObject({ a: 'off', aDefault: true, b: 'on', bDefault: false });
  });

  it('calls both the Reset release and the factory release the default', () => {
    // Reset links the release to the 2.0 mm actuation; an untouched R85HE
    // reads 2.8 mm. The Actuation tab's Default group holds both, so the
    // comparator must not call either of them the deliberate side.
    const reset = mag({ actuationMm: KB_TRAVEL_RANGE.travel.default, releaseMm: 2.0 });
    const fresh = mag({ actuationMm: KB_TRAVEL_RANGE.travel.default, releaseMm: 2.8 });
    const tuned = mag({ actuationMm: KB_TRAVEL_RANGE.travel.default, releaseMm: 1.0 });
    const release = (d: ReturnType<typeof diffField>) =>
      d.rows.find((r) => r.setting === 'Release')!;
    expect(release(diffField('magnetic', [reset], [tuned], NAMES))).toMatchObject({
      aDefault: true,
      bDefault: false,
    });
    expect(release(diffField('magnetic', [fresh], [tuned], NAMES))).toMatchObject({
      aDefault: true,
      bDefault: false,
    });
  });

  it('claims no default for a setting that has none', () => {
    const d = diffField('pollRate', 1000, 8000, NAMES);
    expect(d.rows).toEqual([]);
    const c = diffField(
      'perKeyLighting',
      [{ index: 1, color: [255, 0, 0] }],
      [{ index: 1, color: [0, 0, 255] }],
      NAMES,
    );
    expect(c.rows[0]!.aDefault).toBeUndefined();
  });

  it('reports WHICH keys differ, by name, so they can be unioned across fields', () => {
    // The profile picker counts "keys that differ" across every key-addressed
    // field. Those index differently on the wire (row/col, layout index,
    // firmware slot), so only the name is unionable.
    const a = [mag(), mag({ row: 0, col: 0 })];
    const b = [mag({ actuationMm: 2 }), mag({ row: 0, col: 0 })];
    expect(diffField('magnetic', a, b, NAMES).changedKeys).toEqual(['W']);

    const light = diffField(
      'perKeyLighting',
      [{ index: 1, color: [255, 0, 0] }],
      [{ index: 1, color: [0, 0, 255] }],
      NAMES,
    );
    // Same key, named the same way, so a union counts it once.
    expect(light.changedKeys).toEqual(['W']);
  });
});

describe('blocksByKey', () => {
  it("groups one key's rows into one block, in order", () => {
    // The keyboard comparator draws one block per key and copies by it, so
    // rows of two keys must never interleave or merge.
    const a = [mag(), mag({ row: 0, col: 0 })];
    const b = [mag({ actuationMm: 2, rapidTrigger: true }), mag({ row: 0, col: 0, releaseMm: 2 })];
    const blocks = blocksByKey(diffField('magnetic', a, b, NAMES).rows);
    expect(blocks.map((x) => [x.keyId, x.name, x.rows.length])).toEqual([
      ['1,2', 'W', 2],
      ['0,0', 'Esc', 1],
    ]);
  });
});

describe('key modes in the comparison', () => {
  it('names modes and partners the way the Actuation tab does', () => {
    const names = keyNames([
      { label: 'A', row: 2, col: 1, slot: 9 },
      { label: 'D', row: 2, col: 3, slot: 21 },
    ] as never);
    const plain = { row: 2, col: 1, actuationMm: 2.5, rapidTrigger: false, mode: 'normal' };
    const snap = { ...plain, mode: 'snap', socdPartner: { row: 2, col: 3 } };
    const toggle = { ...plain, mode: 'tgl_dots' };
    const by = (a: unknown, b: unknown) =>
      Object.fromEntries(
        diffField('magnetic', [a], [b], names).rows.map((r) => [r.setting, [r.a, r.b]]),
      );

    expect(by(plain, snap)).toMatchObject({
      Mode: ['Normal', 'Snap-tap'],
      'Snap-tap partner': ['—', 'D'],
    });
    expect(by(plain, toggle).Mode).toEqual(['Normal', 'Toggle, repeating']);
  });
});
