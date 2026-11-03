import { KEY_GROUPS, type KeyDef, type KeyGroup } from '@shared/keys';
import { CONSUMER_LABEL, CONSUMER_LABEL_KEY } from '@shared/keyboard-fn-codes';
import { consumerAction } from './keyRemapState';

/**
 * The Remap tab's picker: every key `KEY_GROUPS` offers, with its media keys
 * written the way the keyboard writes its own.
 *
 * `KEY_GROUPS`' Media row is six keyboard-page usages (0xE8-0xEF), the codes
 * the macro editor records. The board's own media keys are not that: its
 * factory Fn layer binds them as Consumer-page quads (`[3, 0, 205, 0]` is Play /
 * Pause, Fn+F8 on a real R85HE), and a key bound to anything on that page —
 * Fn+F9's "Media player", say — had no button here at all, so it could be read
 * off the board but never given to another key. Every Consumer usage the app
 * can name (`CONSUMER_LABEL`) is offered instead, as the quad itself.
 *
 * `label` is the decode's English name, which is how the board names the key
 * once it is bound (remapGroups.test.ts holds the two together); `labelKey` is
 * the same name as the picker shows it, in the app's language.
 */
const consumer = (usages: number[]): KeyDef[] =>
  usages.map((u) => ({
    label: CONSUMER_LABEL[u] ?? `0x${u.toString(16)}`,
    labelKey: CONSUMER_LABEL_KEY[u],
    code: consumerAction(u),
  }));

/** In the order the old row had them, then what it lacked. */
const MEDIA = consumer([0xcd, 0xb5, 0xb6, 0xe2, 0xe9, 0xea, 0xb7, 0x183]);
const LAUNCH = consumer([0x18a, 0x192, 0x194, 0x221]);
const BROWSER = consumer([0x223, 0x224, 0x225, 0x227, 0x226, 0x22a]);
const SCREEN = consumer([0x6f, 0x70]);

export const REMAP_GROUPS: KeyGroup[] = [
  ...KEY_GROUPS.map((g) => {
    if (g.label === 'Media') return { ...g, keys: MEDIA };
    if (g.label === 'System') return { ...g, keys: [...g.keys, ...SCREEN] };
    return g;
  }),
  { label: 'Launch', labelKey: 'keypick.group.launch', keys: LAUNCH },
  { label: 'Browser', labelKey: 'keypick.group.browser', keys: BROWSER },
];
