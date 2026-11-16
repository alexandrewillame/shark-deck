import { normalizeUsage, type KeyDef, type KeyGroup } from '@shared/keys';

/**
 * Narrowing a key list to what was typed — the search box over the Remap
 * picker, the mod-tap / DKS key chooser and the macro editor's key list.
 *
 * Every word typed has to start a word of one of the key's names: the name
 * the picker shows (translated, or ⌘ / ⌥ on a Mac), its English legend, or one
 * of the other names people type for it ("control", "escape", "pgup"). So "a"
 * finds A and the Alt keys rather than every name with an "a" in it, and "f5"
 * finds F5 but not F15. A word of three letters or more may also name the
 * group: "media" lists the media keys, "media vol" the two volume keys.
 * Case and accents are ignored.
 */

/** Other names a key goes by, by HID usage — what people type when the legend
 *  says something else. */
const ALIASES: Record<string, readonly string[]> = {
  e0: ['control'],
  e4: ['control'],
  e2: ['option', 'opt'],
  e6: ['option', 'opt', 'altgr'],
  e3: ['windows', 'super', 'command', 'cmd', 'meta', 'gui'],
  e7: ['windows', 'super', 'command', 'cmd', 'meta', 'gui'],
  '29': ['escape'],
  '28': ['return'],
  '2a': ['bksp'],
  '2c': ['spacebar'],
  '49': ['ins'],
  '4c': ['del'],
  '4b': ['pgup', 'pageup'],
  '4e': ['pgdn', 'pagedown'],
  '46': ['prtsc', 'prtscn', 'printscreen'],
  '47': ['scrlk'],
  '53': ['numlock'],
  '65': ['context'],
};

/** Lowercase, accents gone, so "écran" is found by "ecran". */
export const foldText = (s: string): string =>
  s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();

/** The words of a name: "Play / Pause" and "Play/Pause" both give play, pause. */
const wordsOf = (s: string): string[] =>
  foldText(s)
    .split(/[\s/]+/)
    .filter(Boolean);

/** The minimum length for a typed word to stand for a whole group. */
const GROUP_WORD_MIN = 3;

export function filterKeyGroups<G extends KeyGroup>(
  groups: readonly G[],
  query: string,
  /** The key's name as the picker draws it. */
  nameOf: (k: KeyDef) => string,
  /** The group's heading as the picker draws it. */
  groupNameOf: (g: G) => string,
): G[] {
  const typed = wordsOf(query);
  if (typed.length === 0) return [...groups];
  const out: G[] = [];
  for (const g of groups) {
    const groupWords = [...wordsOf(groupNameOf(g)), ...wordsOf(g.label)];
    const keys = g.keys.filter((k) => {
      const keyWords = [
        ...wordsOf(nameOf(k)),
        ...wordsOf(k.label),
        ...(ALIASES[normalizeUsage(k.code)] ?? []),
      ];
      return typed.every(
        (w) =>
          keyWords.some((kw) => kw.startsWith(w)) ||
          (w.length >= GROUP_WORD_MIN && groupWords.some((gw) => gw.startsWith(w))),
      );
    });
    if (keys.length > 0) out.push({ ...g, keys });
  }
  return out;
}
