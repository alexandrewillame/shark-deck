import { useCallback, useEffect, useState } from 'react';
import type { KeyGroup, MagneticKeySettings } from '@shared/types/keyboard-settings';
import { groupingSignature, isFactoryDefault } from './magneticSelection';
import { SWATCH_HUES, type SwatchHueName } from '../../colorUtil';
import { sd } from '../../state/bridge';

/**
 * The key-group picker's colours: the nine shared hues (`SWATCH_HUES`, round
 * the wheel) and a slate, each light, vivid and deep.
 *
 * Fixed and palette-independent, for the same reason the keycap and remap
 * colours are (see tokens.css): these say "this key is in that group", and an
 * accent-derived colour would collide with the keycap itself under half the
 * palettes.
 *
 * HAND-PICKED, not generated. Generating every hue at one saturation and
 * lightness is what made the last grid poor: one lightness is a different
 * colour on every hue — dark yellow came out olive, and four greens and blues
 * converged on the same mint. These are standard designer shades (Tailwind's
 * 300-800 range), chosen per column by measuring every pair in CIE Lab:
 * `groupPalette.test.ts` holds the floor, so the grid cannot quietly close up.
 *
 * Light is a pastel, but stops well short of white: a selected key is drawn
 * with a white ring (SELECTION_RING), and a near-white group would make a
 * selected key and an unselected light one look the same.
 */
const GROUP_SWATCHES: Record<SwatchHueName | 'slate', readonly [string, string, string]> = {
  //            light      vivid      deep
  red: ['#fda4af', '#e11d48', '#9f1239'],
  orange: ['#fdba74', '#f97316', '#c2410c'],
  yellow: ['#fde047', '#eab308', '#a16207'],
  lime: ['#a3e635', '#65a30d', '#4d7c0f'],
  green: ['#34d399', '#059669', '#065f46'],
  cyan: ['#67e8f9', '#06b6d4', '#0891b2'],
  blue: ['#60a5fa', '#3b82f6', '#1e40af'],
  violet: ['#a78bfa', '#8b5cf6', '#6d28d9'],
  magenta: ['#e879f9', '#c026d3', '#a21caf'],
  slate: ['#94a3b8', '#64748b', '#334155'],
};

/** The picker's columns, in the order it shows them: the wheel, then slate. */
export const GROUP_HUES: readonly (SwatchHueName | 'slate')[] = [
  ...SWATCH_HUES.map((h) => h.name),
  'slate',
];

/** The picker's rows, top to bottom. */
export const GROUP_STRENGTHS = ['light', 'vivid', 'deep'] as const;

/** The picker's grid: one row per strength, one column per hue. */
export const GROUP_SWATCH_ROWS: string[][] = GROUP_STRENGTHS.map((_, row) =>
  GROUP_HUES.map((hue) => GROUP_SWATCHES[hue][row]),
);

/** A swatch's name, for its accessible label: "vivid blue". */
export function groupSwatchName(color: string): string | undefined {
  for (const [row, strength] of GROUP_STRENGTHS.entries()) {
    const col = GROUP_SWATCH_ROWS[row]!.indexOf(color);
    if (col >= 0) return `${strength} ${GROUP_HUES[col]}`;
  }
  return undefined;
}

/**
 * The order a new group's colour is taken from.
 *
 * Not the picker's wheel order: neighbours on the wheel are the colours that
 * look most alike, and the first groups on a board should differ the most. So
 * the vivid row in an order that keeps each new colour far from the ones
 * before it — red, blue, green, yellow first, the colours people ask for by
 * name — then the deep row, then the light one.
 */
const FIRST_HUES: readonly (SwatchHueName | 'slate')[] = [
  'red',
  'blue',
  'green',
  'yellow',
  'violet',
  'orange',
  'cyan',
  'magenta',
  'lime',
  'slate',
];
export const GROUP_COLORS: readonly string[] = [1, 2, 0].flatMap((row) =>
  FIRST_HUES.map((hue) => GROUP_SWATCHES[hue][row]),
);

/**
 * The nth group colour — hand-picked for the first eight, generated after that.
 *
 * The list used to wrap with `% GROUP_COLORS.length`, so a ninth group was the
 * same colour as the first and the board stopped distinguishing them. Past the
 * hand-picked set the hue advances by the golden angle, which is the standard
 * way to keep successive hues as far apart as possible however many you ask
 * for; saturation and lightness stay where the picked colours sit so a
 * generated one does not look like it came from a different palette.
 */
/**
 * The selection ring's colour, which no group may use.
 *
 * A selected key is drawn with a white outline (see `.kbkey.sel`) rather than
 * a fill, so it keeps showing its group colour while selected. The two must
 * still never be the same colour, and neither may depend on the palette — the
 * ring is a literal, and the generated group hues below stay well clear of
 * white by capping lightness.
 */
export const SELECTION_RING = '#ffffff';

/**
 * The colour of the board's base group — the keys at the factory settings:
 * none.
 *
 * On a stock board that is every key. Painted, it turned the whole board into
 * one solid block of the first group colour, which said nothing (a fresh
 * keyboard opened on a solid red board). Left as ordinary keys, the keys that
 * DIFFER from the factory are what stand out, which is the only thing the
 * colours are for. Stored as the empty string, which no swatch is; the base
 * takes no colour from the sequence, so the first group that differs gets the
 * first colour.
 *
 * The base used to be the LARGEST bucket, whatever it held. On a board tuned
 * everywhere but one key that made the tuned keys "plain" and the one factory
 * key "Group #4" — the reverse of what the colours are meant to say.
 */
export const BASE_GROUP_COLOR = '';

/**
 * The stored name of the base group.
 *
 * Forced on every reconcile rather than inherited, so the derived list is a
 * fixed point of `reconcileGroups` (the effect that keeps the store in step
 * saves only when the two disagree). The rail never shows this string: it
 * renders the translated `act.groups.default`, and the base cannot be renamed
 * — it is a fixed concept, not a user group. Callers that need the list as
 * DISPLAYED (rail width, rename validation) use `withBaseName`.
 */
export const BASE_GROUP_NAME = 'Default';

/** Is this the base group — the unpainted keys at the factory settings? */
export const isBaseGroup = (g: KeyGroup): boolean => g.color === BASE_GROUP_COLOR;

/**
 * The list as the rail shows it: the base under its translated label instead
 * of the stored `BASE_GROUP_NAME`. For anything that reasons about the names
 * on screen — how wide the rail must be, whether a typed name collides with a
 * row the user can see.
 */
export function withBaseName(groups: KeyGroup[], name: string): KeyGroup[] {
  return groups.map((g) => (isBaseGroup(g) ? { ...g, name } : g));
}

export function groupColor(index: number): string {
  if (index < GROUP_COLORS.length) return GROUP_COLORS[index]!;
  // Past the grid the hue advances by the golden angle, the standard way to
  // keep successive hues as far apart as possible however many you ask for.
  // The 67%/53% pair is deliberately not one of the grid's three, so a
  // generated colour can never land exactly on a swatch the picker offers.
  const hue = Math.round(((index - GROUP_COLORS.length) * 137.508 + 20) % 360);
  return `hsl(${hue}, 67%, 53%)`;
}

/** The first colour no other group has taken. */
export function nextGroupColor(groups: KeyGroup[]): string {
  const used = new Set(groups.map((g) => g.color));
  for (let i = 0; i < groups.length + GROUP_COLORS.length + 1; i++) {
    const c = groupColor(i);
    if (!used.has(c)) return c;
  }
  return groupColor(groups.length);
}

/**
 * One onboard profile's key groups, and the "which group am I adding to" mode.
 *
 * Groups are stored per MODEL (slots are that board's matrix indices), so this
 * keys off `model` rather than a device id — two of the same keyboard share
 * their groups, the same way they share onboard profile names. And per
 * PROFILE: a group is derived from the actuation settings, which belong to
 * the profile, so each profile has its own groups and names. One list for the
 * whole model is what made a rename on profile 1 show up on profile 2.
 *
 * Every mutator returns the whole new list from the main process, so nothing
 * here refetches.
 */
export function useKeyGroups(model: string, profile: number) {
  const [groups, setGroups] = useState<KeyGroup[]>([]);
  /** False until the store has answered. An empty list means "this model has
   *  no groups", which is a different thing from "we have not looked yet" —
   *  and the difference matters, because the first is what triggers seeding. */
  const [loaded, setLoaded] = useState(false);
  /** The group keys clicked on the board are being added to, if any. */
  const [adding, setAdding] = useState<string | null>(null);

  useEffect(() => {
    let stale = false;
    setLoaded(false);
    sd.listKeyGroups(model, profile)
      .then((g) => {
        if (stale) return;
        setGroups(g);
        setLoaded(true);
      })
      .catch(() => !stale && setLoaded(true));
    return () => {
      stale = true;
    };
  }, [model, profile]);

  const save = useCallback(
    async (g: KeyGroup) => setGroups(await sd.saveKeyGroup(model, profile, g)),
    [model, profile],
  );

  const remove = useCallback(
    async (id: string) => {
      setGroups(await sd.deleteKeyGroup(model, profile, id));
      setAdding((cur) => (cur === id ? null : cur));
    },
    [model, profile],
  );

  /** Add or remove one slot from a group, and save. A slot in no group is the
   *  implicit "ungrouped" bucket — there is no record for it. */
  const toggleSlot = useCallback(
    async (groupId: string, slot: number) => {
      const g = groups.find((x) => x.id === groupId);
      if (!g) return;
      const slots = g.slots.includes(slot) ? g.slots.filter((s) => s !== slot) : [...g.slots, slot];
      await save({ ...g, slots });
    },
    [groups, save],
  );

  /**
   * Replace the whole list in one go — how the derived partition is stored.
   *
   * ONE call, not a `saveKeyGroup` per entry. Saving is an upsert, so a group
   * the board no longer has stayed in the file (with its slots stripped by the
   * next save, leaving an empty row in the rail), the stored list therefore
   * never matched the derived one, and the reconcile effect that compares them
   * re-saved on every render — a loop that filled the rail with dead groups and
   * kept the IPC channel busy while a 79-key write was trying to use it.
   *
   * Empty groups are dropped on the way past: a group with no keys is not a
   * grouping of anything.
   */
  const replaceAll = useCallback(
    async (next: KeyGroup[]) => {
      setGroups(
        await sd.replaceKeyGroups(
          model,
          profile,
          next.filter((g) => g.slots.length > 0),
        ),
      );
    },
    [model, profile],
  );

  return { groups, loaded, adding, setAdding, save, remove, toggleSlot, replaceAll };
}

/** slot -> the group that claims it. A slot belongs to at most one. */
export function groupBySlot(groups: KeyGroup[]): Map<number, KeyGroup> {
  const m = new Map<number, KeyGroup>();
  for (const g of groups) for (const s of g.slots) m.set(s, g);
  return m;
}

/**
 * Partition every key into groups by the settings it already has.
 *
 * A board arrives from the factory with, typically, the factory setting on all
 * 79 keys and a handful of keys the user has tuned — which is a grouping that
 * already exists on the device and that the app was throwing away by starting
 * with an empty list and asking the user to build it by hand. Keys whose
 * settings are identical are the same group by definition.
 *
 * The keys at the factory settings are the unpainted base, "Default"; the rest
 * are named "Group #1", "Group #2"… in size order. They were named after their
 * settings (`1.5 mm`, `2.0 mm · RT`), which is a label that goes stale the
 * moment the group is edited — the panel beside the list already shows what
 * the settings ARE, and the name's job is to be something you can recognise
 * and change.
 *
 * The same thing as reconciling against no stored groups at all, so it is.
 */
export function deriveGroups(
  keys: Array<{ slot: number; settings: MagneticKeySettings }>,
): KeyGroup[] {
  return reconcileGroups([], keys);
}

/**
 * Reconcile the stored groups against what the board's settings actually say.
 *
 * A group IS the set of keys sharing one set of settings — that is the whole
 * definition, and it is not something anyone chooses. The stored list was only
 * seeded once, so every later edit drifted it out of agreement with the board:
 * change one key's rapid trigger and it kept the group membership it no longer
 * qualified for, and the rail ended up describing a partition that did not
 * exist (a group holding both a rapid-trigger key and a plain one).
 *
 * So the buckets are recomputed from the settings every time, and the stored
 * records supply only the two things a bucket cannot know about itself: its
 * name and its colour. Those follow the keys — a bucket inherits from whichever
 * previous group it overlaps most, so renaming "Group #3" to "WASD" and then
 * retuning one of its keys keeps the name on the keys that stayed together
 * rather than resetting it.
 *
 * The base is the bucket of keys at the FACTORY settings (`isFactoryDefault`),
 * whatever its size: first in the list, unpainted, always named
 * `BASE_GROUP_NAME`. It used to be the biggest bucket, which on a board tuned
 * everywhere but one key painted the tuned keys as plain and the factory key
 * as a group. A board with no factory keys has no base — every bucket is
 * coloured, largest first. A stored record that was the base and now matches
 * a tuned bucket becomes an ordinary group: it takes the first free colour and
 * a fresh number, so the reserved name never sits on a coloured row.
 */
export function reconcileGroups(
  previous: KeyGroup[],
  keys: Array<{ slot: number; settings: MagneticKeySettings }>,
): KeyGroup[] {
  const buckets = bucketBySettings(keys);

  // The base first, then biggest first, so the board's dominant tuned setting
  // gets first claim on a name and the numbering below stays stable as smaller
  // groups come and go.
  const ordered = [...buckets.values()].sort(
    (a, b) => Number(b.factory) - Number(a.factory) || b.slots.length - a.slots.length,
  );

  // Each stored record can be inherited once. Tracked by the record, not its
  // id: a list that has not been through the store yet has no ids, and keying
  // on '' made the first match take every record with it.
  const taken = new Set<KeyGroup>();
  const matched = ordered.map((bucket) => {
    const wanted = new Set(bucket.slots);
    let best: KeyGroup | undefined;
    let bestOverlap = 0;
    for (const g of previous) {
      if (taken.has(g)) continue;
      const overlap = g.slots.reduce((n, s) => n + (wanted.has(s) ? 1 : 0), 0);
      if (overlap > bestOverlap) {
        best = g;
        bestOverlap = overlap;
      }
    }
    if (best) taken.add(best);
    return { bucket, prev: best };
  });

  // What the surviving records keep: a colour (the base has none, and a record
  // that becomes the base gives its colour up) and a name (the base's is
  // forced, and a record that stops being the base is renamed).
  const takenColors = new Set<string>();
  const used = new Set<string>();
  for (const { bucket, prev } of matched) {
    if (!prev || bucket.factory || isBaseGroup(prev)) continue;
    takenColors.add(prev.color);
    used.add(prev.name);
  }
  let nextIndex = 0;
  const freeColor = () => {
    while (takenColors.has(groupColor(nextIndex))) nextIndex++;
    const color = groupColor(nextIndex);
    takenColors.add(color);
    return color;
  };
  // Numbered from 1, skipping names in use — and each name handed out is in
  // use from then on. `used` was built once from the inherited names only, so
  // two new buckets in one pass could both be given "Group #3".
  let nextNumber = 1;
  const freshName = () => {
    while (used.has(`Group #${nextNumber}`)) nextNumber++;
    const name = `Group #${nextNumber}`;
    used.add(name);
    return name;
  };

  return matched.map(({ bucket, prev }) => {
    if (bucket.factory)
      return {
        id: prev?.id ?? '',
        name: BASE_GROUP_NAME,
        color: BASE_GROUP_COLOR,
        slots: bucket.slots,
      };
    if (prev && !isBaseGroup(prev)) return { ...prev, slots: bucket.slots };
    // A brand-new bucket, or the old base whose keys have since been tuned:
    // the first free colour and a number nothing else uses.
    return { id: prev?.id ?? '', name: freshName(), color: freeColor(), slots: bucket.slots };
  });
}

/** Are two group lists the same partition with the same names and colours? */
export function sameGroups(a: KeyGroup[], b: KeyGroup[]): boolean {
  if (a.length !== b.length) return false;
  const key = (g: KeyGroup) =>
    `${g.name}|${g.color}|${[...g.slots].sort((x, y) => x - y).join(',')}`;
  const as = a.map(key).sort();
  const bs = b.map(key).sort();
  return as.every((v, i) => v === bs[i]);
}

/** How long a group name may be. Long enough for "Rapid trigger keys", short
 *  enough that the 168px rail can show it. */
export const GROUP_NAME_MAX = 28;

/**
 * Check a name typed into the rail before it is saved.
 *
 * Returns the cleaned name, or a reason it cannot be used. Names are compared
 * case- and whitespace-insensitively, because two rows reading "group 1" and
 * "Group 1 " are the same row as far as anyone looking at them is concerned —
 * and the rail is the only place a group is identified, so a duplicate makes
 * one of them unusable.
 *
 * `BASE_GROUP_NAME` is always taken, base row or no base row: a board with no
 * factory keys has no "Default" today and grows one the moment a key is Reset,
 * and that row must not find a user group already wearing its name. The rail
 * shows the base under a TRANSLATED label, so callers pass the list through
 * `withBaseName` to have that label reserved too.
 */
/** Control characters, which must never reach a name: they are invisible, so
 *  two names that look identical would not be, and they break the row's
 *  single-line layout. */
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/g;

export function validateGroupName(
  raw: string,
  groups: KeyGroup[],
  selfId: string,
): { ok: true; name: string } | { ok: false; reason: 'empty' | 'duplicate' } {
  // Collapse runs of whitespace and strip control characters, so a name cannot
  // carry invisible differences or break the row's single-line layout.
  const name = raw.replace(CONTROL_CHARS, '').replace(/\s+/g, ' ').trim().slice(0, GROUP_NAME_MAX);
  if (!name) return { ok: false, reason: 'empty' };
  const key = name.toLowerCase();
  if (key === BASE_GROUP_NAME.toLowerCase()) return { ok: false, reason: 'duplicate' };
  if (groups.some((g) => g.id !== selfId && g.name.trim().toLowerCase() === key))
    return { ok: false, reason: 'duplicate' };
  return { ok: true, name };
}

/**
 * The one bucket that is not keyed by signature: every key at the factory
 * settings, whatever its exact bytes. Not a string `groupingSignature` can
 * produce — a signature always has eight `|` in it.
 */
const FACTORY_BUCKET = 'factory';

/**
 * Keys grouped by the settings they hold.
 *
 * Keyed by `groupingSignature` — the fields the per-key panel can actually
 * differ on, with the ones not in force blanked. Two keys are in the same
 * group exactly when this string matches, with ONE exception: every key that
 * `isFactoryDefault` accepts goes in the same bucket. The factory state is not
 * one signature — an untouched key reads 2.0 / 2.8 mm and a key the app has
 * Reset holds 2.0 / 2.0 — and "Default" means the keys at the factory
 * settings, which is what the rail's tooltip promises and what Reset must put
 * a key back into.
 */
function bucketBySettings(
  keys: Array<{ slot: number; settings: MagneticKeySettings }>,
): Map<string, { factory: boolean; slots: number[] }> {
  const buckets = new Map<string, { factory: boolean; slots: number[] }>();
  for (const { slot, settings } of keys) {
    const factory = isFactoryDefault(settings);
    const sig = factory ? FACTORY_BUCKET : groupingSignature(settings);
    const b = buckets.get(sig);
    if (b) b.slots.push(slot);
    else buckets.set(sig, { factory, slots: [slot] });
  }
  return buckets;
}

/**
 * How wide the key-group rail has to be for the names it is holding.
 *
 * Fixed at 128px, a renamed group read as "Rapid trigger k…" — the rename is
 * offered so a row can say what it is, and then the row could not show it.
 *
 * MEASURED, not estimated from the character count: at 12px the same eight
 * characters are 50px as "Group #1" and 66px as all-caps, so any per-character
 * figure is either too narrow for one of those or far too wide for the other.
 * `measure` is injected so this stays pure (and so a test does not need a
 * canvas); the caller passes a real text measurement.
 */
export const RAIL_W_MIN = 128;
/** Past this the rail is a column of its own rather than an annotation on the
 *  board, so a very long name ellipsises instead. Wide enough for the 25
 *  characters the names are actually written at; GROUP_NAME_MAX allows 28, and
 *  a 28-character name in capitals is where the cap starts to bite. */
export const RAIL_W_MAX = 240;
/**
 * Swatch, gaps, padding, the rename affordance and the scrollbar gutter —
 * everything in the row that is not the name.
 *
 * Measured against the rendered row, which came to 55px. It was set from a
 * stripped-down copy that had no rename control, at 44px, so every name was
 * budgeted 11px more room than it had: "Fast actuation" wants 73px, was given
 * exactly 73, and ellipsised on the first sub-pixel of rounding. The extra 3px
 * here is slack against that same rounding — a canvas measurement and the
 * browser's own layout do not round the same way, and an exact fit still
 * ellipsised.
 */
export const RAIL_W_CHROME = 62;

export function railWidthFor(names: readonly string[], measure: (s: string) => number): number {
  const widest = names.reduce((n, name) => Math.max(n, measure(name)), 0);
  return Math.round(Math.min(RAIL_W_MAX, Math.max(RAIL_W_MIN, RAIL_W_CHROME + widest)));
}
