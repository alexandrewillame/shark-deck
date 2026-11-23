import { KEY_GROUPS, type KeyDef, type KeyGroup } from '@shared/keys';
import { CONSUMER_LABEL, CONSUMER_LABEL_KEY, MACRO_QUAD_TYPE } from '@shared/keyboard-fn-codes';
import { consumerAction, quadAction } from './keyRemapState';

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

/** In the order a keyboard's media row has them: back before forward, down
 *  before up — Previous, Play / Pause, Next, Stop, Mute, Volume -, Volume +. */
const MEDIA = consumer([0xb6, 0xcd, 0xb5, 0xb7, 0xe2, 0xea, 0xe9, 0x183]);
const LAUNCH = consumer([0x18a, 0x192, 0x194, 0x221]);
const BROWSER = consumer([0x223, 0x224, 0x225, 0x227, 0x226, 0x22a]);
/** Screen brightness -, then +. */
const SCREEN = consumer([0x70, 0x6f]);

export const REMAP_GROUPS: KeyGroup[] = [
  ...KEY_GROUPS.map((g) => {
    if (g.label === 'Media') return { ...g, keys: MEDIA };
    if (g.label === 'System') return { ...g, keys: [...g.keys, ...SCREEN] };
    return g;
  }),
  { label: 'Launch', labelKey: 'keypick.group.launch', keys: LAUNCH },
  { label: 'Browser', labelKey: 'keypick.group.browser', keys: BROWSER },
];

/** A macro on the board as a binding: `[9, 0, slot, 0]`, the official
 *  software's own (see `decodeKeyQuad`). */
export const macroAction = (slot: number): string => quadAction([MACRO_QUAD_TYPE, 0, slot, 0]);
/** The first macro. */
export const MACRO_ACTION = macroAction(0);

/**
 * The picker's groups for a board: a button per macro it holds — what the
 * keyboard holds, not the library, so a macro taken out of the library (or
 * written by other software) can still be given to a key. `nameOf` adds the
 * name of the library macro a slot matches, as the Macros tab's On the device
 * list does. A board holding none has no Macro row: a button for an empty
 * slot would give a key that does nothing.
 */
export function remapGroupsFor(
  macroSlots: readonly number[] | null,
  nameOf: (slot: number) => string | null = () => null,
): KeyGroup[] {
  if (!macroSlots?.length) return REMAP_GROUPS;
  const slots = [...new Set(macroSlots)].sort((a, b) => a - b);
  return [
    ...REMAP_GROUPS,
    {
      label: 'Macro',
      labelKey: 'keypick.group.macro',
      keys: slots.map((n) => {
        const name = nameOf(n);
        const labelVars: Record<string, string> = { n: String(n + 1) };
        if (name) labelVars.name = name;
        return {
          label: name ? `Macro ${n + 1} · ${name}` : `Macro ${n + 1}`,
          labelKey: name ? 'keyfn.macroNamed' : 'keyfn.macroN',
          labelVars,
          tipKey: 'keypick.macro.tip',
          code: macroAction(n),
        };
      }),
    },
  ];
}
