import { describe, expect, it } from 'vitest';
import { KEY_GROUPS } from '@shared/keys';
import { REMAP_GROUPS } from '../tabs/keyboard/remapGroups';
import { filterKeyGroups, foldText } from './keySearch';

/** What a search over the Remap picker leaves, as English key names. */
const found = (query: string, groups = REMAP_GROUPS) =>
  filterKeyGroups(
    groups,
    query,
    (k) => k.label,
    (g) => g.label,
  ).flatMap((g) => g.keys.map((k) => k.label));

describe('filterKeyGroups', () => {
  it('returns every group untouched for an empty query', () => {
    expect(
      filterKeyGroups(
        REMAP_GROUPS,
        '  ',
        (k) => k.label,
        (g) => g.label,
      ),
    ).toEqual(REMAP_GROUPS);
  });

  it('finds the two volume keys from a few letters', () => {
    expect(found('vol')).toEqual(['Volume -', 'Volume +']);
  });

  it('matches the start of a word, so a single letter is not every name holding it', () => {
    expect(found('a')).toEqual(['A', 'Left Alt', 'Right Alt']);
    expect(found('f5')).toEqual(['F5']);
  });

  it('lists a whole group by its name, and narrows inside it', () => {
    expect(found('media')).toEqual(
      REMAP_GROUPS.find((g) => g.label === 'Media')!.keys.map((k) => k.label),
    );
    expect(found('media vol')).toEqual(['Volume -', 'Volume +']);
  });

  it('knows the other names people type', () => {
    expect(found('escape')).toEqual(['Esc']);
    expect(found('control')).toEqual(['Left Ctrl', 'Right Ctrl']);
    expect(found('cmd')).toEqual(['Left Win', 'Right Win']);
    expect(found('pgup')).toEqual(['Page Up']);
    expect(found('print screen')).toEqual(['Print Screen']);
  });

  it('splits Play/Pause the way it splits Play / Pause', () => {
    expect(found('pause', KEY_GROUPS)).toContain('Play/Pause');
    expect(found('pause')).toContain('Play / Pause');
  });

  it('ignores case and accents, in the translated names too', () => {
    const fr = filterKeyGroups(
      REMAP_GROUPS,
      'LUMINOSITE',
      (k) =>
        k.label.startsWith('Screen brightness') ? `Luminosité ${k.label.slice(-1)}` : k.label,
      (g) => g.label,
    ).flatMap((g) => g.keys.map((k) => k.label));
    expect(fr).toEqual(['Screen brightness -', 'Screen brightness +']);
    expect(foldText('Écran')).toBe('ecran');
  });

  it('drops groups with nothing left and finds nothing for nonsense', () => {
    expect(found('zzzz')).toEqual([]);
  });
});
