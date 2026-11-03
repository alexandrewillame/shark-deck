import { describe, expect, it } from 'vitest';
import { cleanSavedName, nextSavedName, savedNameClash, SAVED_NAME_MAX } from './savedName';

/**
 * Saving a layout or a preset under a name that already existed used to add a
 * SECOND entry with that name — the stores upsert by `id`, and nothing checked
 * the label. Two identical rows, no way to tell them apart, and no way to
 * overwrite the one you meant.
 *
 * So a clash has to be findable, and "the same name" has to mean what a person
 * means by it: not a different name because of a trailing space or a capital.
 */
describe('cleanSavedName', () => {
  it('trims and collapses whitespace', () => {
    expect(cleanSavedName('  Fast   keys  ')).toBe('Fast keys');
    expect(cleanSavedName('\tWASD\n')).toBe('WASD');
  });

  it('strips control characters, which are invisible differences', () => {
    // Two names that look identical must not be two names.
    expect(cleanSavedName('Fa\u0000st')).toBe('Fast');
    expect(cleanSavedName('Fast\u007f')).toBe('Fast');
  });

  it('caps the length, so a row cannot be blown open by a paste', () => {
    expect(cleanSavedName('x'.repeat(200))).toHaveLength(SAVED_NAME_MAX);
  });

  it('reduces a name made only of blanks to nothing', () => {
    // Callers gate on the cleaned value, so this is what makes Save inert.
    expect(cleanSavedName('   \t \n ')).toBe('');
  });
});

describe('savedNameClash', () => {
  const list = [
    { id: 'a', name: 'Fast keys' },
    { id: 'b', name: 'WASD' },
  ];

  it('finds an exact match', () => {
    expect(savedNameClash(list, 'WASD')?.id).toBe('b');
  });

  it('ignores case and surrounding space, as a person reading the list would', () => {
    expect(savedNameClash(list, '  wasd ')?.id).toBe('b');
    expect(savedNameClash(list, 'FAST   KEYS')?.id).toBe('a');
  });

  it('matches a stored name that itself needs cleaning', () => {
    expect(savedNameClash([{ id: 'c', name: ' Spare  room ' }], 'spare room')?.id).toBe('c');
  });

  it('is not a clash with itself, so a rename can keep its own name', () => {
    expect(savedNameClash(list, 'WASD', 'b')).toBeUndefined();
    // …but still clashes with a DIFFERENT entry.
    expect(savedNameClash(list, 'Fast keys', 'b')?.id).toBe('a');
  });

  it('finds nothing for a name that cleans away to nothing', () => {
    expect(savedNameClash(list, '   ')).toBeUndefined();
  });
});

describe('nextSavedName', () => {
  const fmt = (n: number) => `Layout ${n}`;

  it('starts at 1 on an empty library', () => {
    expect(nextSavedName([], fmt)).toBe('Layout 1');
  });

  it('skips a name already taken, by the clash rules', () => {
    // "layout 1 " is "Layout 1" to anyone reading the list.
    expect(nextSavedName([{ id: 'a', name: 'layout 1 ' }], fmt)).toBe('Layout 2');
  });

  it('fills the lowest gap rather than counting the entries', () => {
    const list = [
      { id: 'a', name: 'Layout 1' },
      { id: 'b', name: 'Layout 3' },
    ];
    expect(nextSavedName(list, fmt)).toBe('Layout 2');
  });
});
