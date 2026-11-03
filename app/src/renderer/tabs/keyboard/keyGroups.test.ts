import { describe, expect, it } from 'vitest';
import type { MagneticKeySettings } from '@shared/types/keyboard-settings';
import { KB_FACTORY_RELEASE_MM, KB_TRAVEL_RANGE } from '@shared/keyboard-travel';
import {
  BASE_GROUP_COLOR,
  BASE_GROUP_NAME,
  GROUP_COLORS,
  GROUP_NAME_MAX,
  deriveGroups,
  groupColor,
  isBaseGroup,
  nextGroupColor,
  RAIL_W_CHROME,
  RAIL_W_MAX,
  RAIL_W_MIN,
  railWidthFor,
  reconcileGroups,
  sameGroups,
  validateGroupName,
  withBaseName,
} from './useKeyGroups';

/** A TUNED key — 1.5 mm is not the factory actuation, so a board built only
 *  from these has no base group. */
const key = (over: Partial<MagneticKeySettings> = {}): MagneticKeySettings => ({
  row: 0,
  col: 0,
  actuationMm: 1.5,
  rapidTrigger: false,
  ...over,
});

/** A key at the factory settings, as Reset writes them. */
const factory = (over: Partial<MagneticKeySettings> = {}): MagneticKeySettings => ({
  row: 0,
  col: 0,
  actuationMm: KB_TRAVEL_RANGE.travel.default,
  releaseMm: KB_TRAVEL_RANGE.travel.default,
  rapidTrigger: false,
  rtPressMm: KB_TRAVEL_RANGE.rt.default,
  rtReleaseMm: KB_TRAVEL_RANGE.rt.default,
  deadZoneMm: KB_TRAVEL_RANGE.deadzone.default,
  deadZoneBottomMm: KB_TRAVEL_RANGE.deadzone.default,
  mode: 'normal',
  ...over,
});

/**
 * The groups a board already has, read off it rather than hand-built.
 *
 * The panel started empty and left every key ungrouped, so the feature only
 * did anything after someone rebuilt by hand a partition the device could have
 * described itself.
 */
describe('deriveGroups', () => {
  it('puts every key in a group', () => {
    const keys = [
      { slot: 0, settings: key() },
      { slot: 1, settings: key({ actuationMm: 2.4 }) },
      { slot: 2, settings: key() },
      { slot: 3, settings: key({ rapidTrigger: true }) },
    ];
    const groups = deriveGroups(keys);
    const claimed = groups.flatMap((g) => g.slots).sort((a, b) => a - b);
    expect(claimed).toEqual([0, 1, 2, 3]);
    // ...and exactly once each.
    expect(new Set(claimed).size).toBe(claimed.length);
  });

  it('groups keys whose settings are identical', () => {
    const groups = deriveGroups([
      { slot: 0, settings: key() },
      { slot: 1, settings: key() },
      { slot: 2, settings: key({ actuationMm: 2.4 }) },
    ]);
    expect(groups).toHaveLength(2);
    expect(groups[0]!.slots).toEqual([0, 1]);
  });

  it('puts the dominant tuned setting first', () => {
    // With no factory keys there is no base; the biggest tuned bucket is the
    // one worth reading as group one.
    const keys = [
      ...Array.from({ length: 9 }, (_, i) => ({ slot: i, settings: key() })),
      { slot: 9, settings: key({ actuationMm: 0.4 }) },
    ];
    const groups = deriveGroups(keys);
    expect(groups[0]!.slots).toHaveLength(9);
    expect(groups[1]!.slots).toEqual([9]);
  });

  it('is reconciling against nothing', () => {
    const keys = [
      { slot: 0, settings: factory() },
      { slot: 1, settings: key() },
      { slot: 2, settings: key({ rapidTrigger: true }) },
    ];
    expect(deriveGroups(keys)).toEqual(reconcileGroups([], keys));
  });

  it('numbers the groups in size order', () => {
    const groups = deriveGroups([
      { slot: 0, settings: key({ actuationMm: 1.5 }) },
      { slot: 1, settings: key({ actuationMm: 0.3, rapidTrigger: true }) },
      { slot: 2, settings: key({ actuationMm: 2, mode: 'dks' }) },
    ]);
    expect(groups.map((g) => g.name)).toEqual(['Group #1', 'Group #2', 'Group #3']);
  });

  it('gives every group a distinct name and colour', () => {
    // Two buckets can differ in a field nothing in the name mentions —
    // release depth, say — so the name cannot be derived from the settings.
    const groups = deriveGroups([
      { slot: 0, settings: key({ releaseMm: 1 }) },
      { slot: 1, settings: key({ releaseMm: 2 }) },
    ]);
    expect(new Set(groups.map((g) => g.name)).size).toBe(2);
    expect(new Set(groups.map((g) => g.color)).size).toBe(2);
  });

  it('is empty for an empty board rather than inventing a group', () => {
    expect(deriveGroups([])).toEqual([]);
  });
});

/**
 * Two groups with the same colour is two groups the board cannot tell apart,
 * which is the whole job of the colour.
 */
describe('group colours', () => {
  it('never repeats, however many groups there are', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 40; i++) seen.add(groupColor(i));
    expect(seen.size).toBe(40);
  });

  it('uses the hand-picked list first, then generates', () => {
    expect(groupColor(0)).toBe(GROUP_COLORS[0]);
    expect(groupColor(GROUP_COLORS.length - 1)).toBe(GROUP_COLORS[GROUP_COLORS.length - 1]);
    // Past the list it must still be a colour, and not one of the picked ones.
    const extra = groupColor(GROUP_COLORS.length);
    expect(extra.startsWith('hsl(')).toBe(true);
    expect(GROUP_COLORS).not.toContain(extra);
  });

  it('gives a new group a colour none of the others has', () => {
    // It used to wrap with `% GROUP_COLORS.length`, so group nine was the same
    // colour as group one.
    const groups = Array.from({ length: GROUP_COLORS.length }, (_, i) => ({
      id: String(i),
      name: `Group #${i + 1}`,
      color: groupColor(i),
      slots: [i],
    }));
    const next = nextGroupColor(groups);
    expect(groups.map((g) => g.color)).not.toContain(next);
  });

  it('derives a whole board without a colour collision', () => {
    const keys = Array.from({ length: 30 }, (_, i) => ({
      slot: i,
      settings: key({ actuationMm: 0.1 * (i + 1) }),
    }));
    const groups = deriveGroups(keys);
    expect(groups).toHaveLength(30);
    expect(new Set(groups.map((g) => g.color)).size).toBe(30);
  });
});

/**
 * The rail is the only place a group is identified, so a name that is blank —
 * or the same as another row's — makes a row unusable.
 */
describe('validateGroupName', () => {
  const groups = [
    { id: 'a', name: 'Group #1', color: '#111', slots: [0] },
    { id: 'b', name: 'Rapid trigger keys', color: '#222', slots: [1] },
  ];

  it('trims and collapses whitespace', () => {
    expect(validateGroupName('  Group   #3  ', groups, 'c')).toEqual({
      ok: true,
      name: 'Group #3',
    });
  });

  it('keeps single spaces inside a name', () => {
    // The row used to swallow the space key entirely, so this is worth pinning.
    expect(validateGroupName('My WASD keys', groups, 'c')).toEqual({
      ok: true,
      name: 'My WASD keys',
    });
  });

  it('strips control characters', () => {
    // Built from char codes rather than written literally: an invisible
    // character in a source file is exactly what this guards against.
    const NUL = String.fromCharCode(0);
    const US = String.fromCharCode(31);
    const DEL = String.fromCharCode(127);
    const r = validateGroupName(`Grou${NUL}p${US} #4${DEL}`, groups, 'c');
    expect(r).toEqual({ ok: true, name: 'Group #4' });
  });

  it('keeps hyphens and other ordinary punctuation', () => {
    // The control-character class was once written with LITERAL control
    // characters between its brackets; stripping those left `[-]`, which
    // quietly deleted every hyphen from every name instead.
    expect(validateGroupName('WASD - left hand', groups, 'c')).toEqual({
      ok: true,
      name: 'WASD - left hand',
    });
  });

  it('rejects a name that is empty or only whitespace', () => {
    expect(validateGroupName('', groups, 'c')).toEqual({ ok: false, reason: 'empty' });
    expect(validateGroupName('   ', groups, 'c')).toEqual({ ok: false, reason: 'empty' });
    expect(validateGroupName(String.fromCharCode(0), groups, 'c')).toEqual({
      ok: false,
      reason: 'empty',
    });
  });

  it('rejects a duplicate, ignoring case and padding', () => {
    expect(validateGroupName('group #1', groups, 'c')).toEqual({ ok: false, reason: 'duplicate' });
    expect(validateGroupName('  RAPID TRIGGER KEYS ', groups, 'c')).toEqual({
      ok: false,
      reason: 'duplicate',
    });
  });

  it('lets a group keep its own name', () => {
    expect(validateGroupName('Group #1', groups, 'a')).toEqual({ ok: true, name: 'Group #1' });
  });

  it('reserves the base name, whether or not the board has a base right now', () => {
    // No base in `groups`: a Reset later would grow one, and it must not find
    // a user group already called Default.
    expect(validateGroupName(BASE_GROUP_NAME, groups, 'c')).toEqual({
      ok: false,
      reason: 'duplicate',
    });
    expect(validateGroupName(' default ', groups, 'c')).toEqual({
      ok: false,
      reason: 'duplicate',
    });
  });

  it('reserves the translated base label when given the list as displayed', () => {
    const withBase = [
      { id: 'base', name: BASE_GROUP_NAME, color: BASE_GROUP_COLOR, slots: [5] },
      ...groups,
    ];
    const shown = withBaseName(withBase, 'Par défaut');
    expect(validateGroupName('par défaut', shown, 'c')).toEqual({
      ok: false,
      reason: 'duplicate',
    });
    // The stored name stays reserved too.
    expect(validateGroupName('Default', shown, 'c')).toEqual({ ok: false, reason: 'duplicate' });
  });

  it('caps the length so a name still fits the rail', () => {
    const r = validateGroupName('x'.repeat(200), groups, 'c');
    expect(r.ok && r.name.length).toBe(GROUP_NAME_MAX);
  });
});

/**
 * A group IS the set of keys sharing one set of settings. It cannot be stored
 * as a membership list and left alone: the list was seeded once, so editing a
 * key left it in a group it no longer qualified for — one group holding both a
 * rapid-trigger key and a plain one.
 */
describe('reconcileGroups', () => {
  const keys = (...specs: Array<[number, Partial<MagneticKeySettings>]>) =>
    specs.map(([slot, over]) => ({ slot, settings: key(over) }));

  it(`re-buckets after a key's settings change`, () => {
    const before = reconcileGroups([], keys([0, {}], [1, {}], [2, {}]));
    expect(before).toHaveLength(1);
    // Key 2 gains rapid trigger, so it is no longer the same group.
    const after = reconcileGroups(before, keys([0, {}], [1, {}], [2, { rapidTrigger: true }]));
    expect(after).toHaveLength(2);
    expect(after[0].slots).toEqual([0, 1]);
    expect(after[1].slots).toEqual([2]);
  });

  it('never puts two different settings in one group', () => {
    const groups = reconcileGroups(
      [],
      keys([0, { rapidTrigger: true }], [1, {}], [2, { rapidTrigger: true }], [3, {}]),
    );
    for (const g of groups) {
      const rts = new Set(g.slots.map((sl) => sl === 0 || sl === 2));
      expect(rts.size, `group ${g.name} mixes settings`).toBe(1);
    }
  });

  it(`keeps a renamed group's name on the keys that stayed together`, () => {
    const before = reconcileGroups([], keys([0, {}], [1, {}], [2, {}], [3, { actuationMm: 2 }]));
    const named = before.map((g) => (g.slots.length === 3 ? { ...g, name: 'WASD' } : g));
    // One of the three is retuned away.
    const after = reconcileGroups(
      named,
      keys([0, {}], [1, {}], [2, { actuationMm: 3 }], [3, { actuationMm: 2 }]),
    );
    const kept = after.find((g) => g.slots.join() === '0,1');
    expect(kept?.name).toBe('WASD');
  });

  it('gives a new bucket a colour no other group holds', () => {
    const before = reconcileGroups([], keys([0, {}], [1, {}]));
    const after = reconcileGroups(before, keys([0, {}], [1, { actuationMm: 2 }]));
    expect(new Set(after.map((g) => g.color)).size).toBe(after.length);
  });

  it('leaves every key in exactly one group', () => {
    const groups = reconcileGroups(
      [],
      keys([0, {}], [1, { rapidTrigger: true }], [2, { mode: 'dks' }], [3, {}]),
    );
    const claimed = groups.flatMap((g) => g.slots).sort((a, b) => a - b);
    expect(claimed).toEqual([0, 1, 2, 3]);
    expect(new Set(claimed).size).toBe(4);
  });

  it('gives two new buckets in one pass different names', () => {
    // `used` was built once from the inherited names, so the first new bucket
    // skipped "Group #2" to "Group #3" — and the second was given "Group #3"
    // as well. Here the inherited group is "Group #2" and two bigger buckets
    // appear at once.
    const previous = [
      { id: 'base', name: BASE_GROUP_NAME, color: BASE_GROUP_COLOR, slots: [0, 1, 2, 3, 4, 5, 6] },
      { id: 'g2', name: 'Group #2', color: groupColor(0), slots: [7] },
    ];
    const next = reconcileGroups(previous, [
      ...[0, 1, 2].map((slot) => ({ slot, settings: factory() })),
      ...keys([3, { actuationMm: 1.0 }], [4, { actuationMm: 1.0 }]),
      ...keys([5, { actuationMm: 1.2 }], [6, { actuationMm: 1.2 }]),
      ...keys([7, {}]),
    ]);
    expect(next).toHaveLength(4);
    expect(new Set(next.map((g) => g.name)).size).toBe(4);
    expect(next.find((g) => g.slots.join() === '7')?.name).toBe('Group #2');
    // Numbered from 1, skipping only what is in use.
    expect(next.map((g) => g.name).sort()).toEqual(
      [BASE_GROUP_NAME, 'Group #1', 'Group #2', 'Group #3'].sort(),
    );
  });

  it('puts RT-off keys with and without a stored sensitivity in one bucket', () => {
    // A key the app has Reset remembers 0.2 mm; an untouched one reads its
    // empty RT page as undefined. Rapid trigger is off on both, so the
    // sensitivity is not a setting either key is using.
    const groups = reconcileGroups(
      [],
      keys(
        [0, { rtPressMm: 0.2, rtReleaseMm: 0.2 }],
        [1, { rtPressMm: undefined, rtReleaseMm: undefined }],
        [2, { rtPressMm: 0.2, rtReleaseMm: 0.2 }],
      ),
    );
    expect(groups).toHaveLength(1);
    // Once RT is on the sensitivity counts again.
    expect(
      reconcileGroups(
        [],
        keys(
          [0, { rapidTrigger: true, rtPressMm: 0.2 }],
          [1, { rapidTrigger: true, rtPressMm: 0.5 }],
        ),
      ),
    ).toHaveLength(2);
  });
});

/**
 * The base group is the keys at the FACTORY settings, whatever its size: drawn
 * as plain keys, so a stock board is not one solid block of colour and the keys
 * that have been tuned are what stand out. It used to be the biggest bucket,
 * which on a board tuned everywhere but one key painted the tuned keys as plain
 * and the one factory key as "Group #4".
 */
describe('the base group', () => {
  const keys = (...specs: Array<[number, Partial<MagneticKeySettings>]>) =>
    specs.map(([slot, over]) => ({ slot, settings: key(over) }));
  const board = (...specs: Array<[number, MagneticKeySettings]>) =>
    specs.map(([slot, settings]) => ({ slot, settings }));

  it('is the factory keys, unpainted and first, even when outnumbered', () => {
    // Nine tuned keys and one at the factory settings — the reported board.
    const groups = deriveGroups(
      board(...Array.from({ length: 9 }, (_, i) => [i, key()] as [number, MagneticKeySettings]), [
        9,
        factory(),
      ]),
    );
    expect(groups).toHaveLength(2);
    expect(groups[0]).toMatchObject({
      name: BASE_GROUP_NAME,
      color: BASE_GROUP_COLOR,
      slots: [9],
    });
    expect(isBaseGroup(groups[0]!)).toBe(true);
    // The tuned keys are the first COLOURED group, with the first colour.
    expect(groups[1]).toMatchObject({ name: 'Group #1', color: groupColor(0) });
    expect(groups[1]!.slots).toHaveLength(9);
  });

  it('is every key on a stock board, so nothing is painted', () => {
    const groups = deriveGroups(board([0, factory()], [1, factory()], [2, factory()]));
    expect(groups.map((g) => g.color)).toEqual([BASE_GROUP_COLOR]);
    expect(groups[0]!.name).toBe(BASE_GROUP_NAME);
  });

  it('does not exist on a board with no factory keys — every group is coloured', () => {
    const groups = deriveGroups(
      keys(
        [0, {}],
        [1, {}],
        [2, {}],
        [3, { actuationMm: 0.4 }],
        [4, { actuationMm: 0.4 }],
        [5, { mode: 'dks' }],
      ),
    );
    expect(groups.some(isBaseGroup)).toBe(false);
    expect(groups.map((g) => g.name)).toEqual(['Group #1', 'Group #2', 'Group #3']);
    expect(groups.map((g) => g.slots.length)).toEqual([3, 2, 1]);
    expect(groups.map((g) => g.color)).toEqual([groupColor(0), groupColor(1), groupColor(2)]);
    // A board with one tuned setting everywhere is one coloured group, not a base.
    expect(deriveGroups(keys([0, {}], [1, {}])).map((g) => g.color)).toEqual([groupColor(0)]);
  });

  it('holds an untouched key and a Reset key together', () => {
    // A factory R85HE reads 2.0 / 2.8 mm with an empty top dead-zone page; a
    // key the app has Reset holds 2.0 / 2.0 with 0.3 / 0.3. Both are "at the
    // factory settings", which is what the rail's tooltip says the row holds
    // and what Reset must put a key back into.
    const untouched = factory({
      releaseMm: KB_FACTORY_RELEASE_MM,
      deadZoneMm: 0,
      rtPressMm: undefined,
      rtReleaseMm: undefined,
    });
    const groups = deriveGroups(board([0, untouched], [1, factory()], [2, untouched]));
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ color: BASE_GROUP_COLOR, slots: [0, 1, 2] });
  });

  it('becomes the base when its keys are Reset, and the old base takes a colour and a number', () => {
    const before = reconcileGroups(
      [],
      board([0, factory()], [1, factory()], [2, factory()], [3, key()], [4, key()]),
    );
    expect(before.map((g) => [g.name, g.color])).toEqual([
      [BASE_GROUP_NAME, BASE_GROUP_COLOR],
      ['Group #1', groupColor(0)],
    ]);
    // Keys 3 and 4 are Reset; keys 0-2 are tuned to 1.0 mm.
    const tuned = board(
      [0, key({ actuationMm: 1.0 })],
      [1, key({ actuationMm: 1.0 })],
      [2, key({ actuationMm: 1.0 })],
      [3, factory()],
      [4, factory()],
    );
    const after = reconcileGroups(before, tuned);
    expect(after[0]).toMatchObject({
      name: BASE_GROUP_NAME,
      color: BASE_GROUP_COLOR,
      slots: [3, 4],
    });
    const old = after.find((g) => g.slots.join() === '0,1,2')!;
    expect(old.color).not.toBe(BASE_GROUP_COLOR);
    expect(old.name).toMatch(/^Group #\d+$/);
    // ...and settles there.
    expect(sameGroups(after, reconcileGroups(after, tuned))).toBe(true);
  });

  it('always carries the stored base name, whatever the record said', () => {
    // A record from before the base had a fixed name — or one a user renamed
    // under the old rule — is still the base: it keeps its id and loses the
    // name, so the derived list is a fixed point and the rail's translated
    // label is the only name the row ever shows.
    const previous = [{ id: 'kept', name: 'WASD', color: BASE_GROUP_COLOR, slots: [0, 1] }];
    const next = reconcileGroups(previous, board([0, factory()], [1, factory()]));
    expect(next).toEqual([
      { id: 'kept', name: BASE_GROUP_NAME, color: BASE_GROUP_COLOR, slots: [0, 1] },
    ]);
  });

  it('never leaks the base name onto a coloured group', () => {
    // The old base's keys are all tuned away; no factory key is left.
    const previous = [
      { id: 'base', name: BASE_GROUP_NAME, color: BASE_GROUP_COLOR, slots: [0, 1] },
    ];
    const next = reconcileGroups(previous, keys([0, {}], [1, {}]));
    expect(next).toHaveLength(1);
    expect(next[0]).toMatchObject({ id: 'base', name: 'Group #1', color: groupColor(0) });
    expect(sameGroups(next, reconcileGroups(next, keys([0, {}], [1, {}])))).toBe(true);
  });

  it('frees the colour of a group whose keys are Reset', () => {
    const before = reconcileGroups(
      [],
      board([0, factory()], [1, key()], [2, key({ mode: 'dks' })]),
    );
    const colours = before.filter((g) => !isBaseGroup(g)).map((g) => g.color);
    expect(colours).toEqual([groupColor(0), groupColor(1)]);
    // Key 1 is Reset: its group dissolves into the base, and a new bucket may
    // take the colour it held.
    const after = reconcileGroups(
      before,
      board(
        [0, factory()],
        [1, factory()],
        [2, key({ mode: 'dks' })],
        [3, key({ actuationMm: 0.5 })],
      ),
    );
    expect(new Set(after.map((g) => g.color)).size).toBe(after.length);
    expect(after.find((g) => g.slots.join() === '3')?.color).toBe(groupColor(0));
  });

  it('is renamed for display without touching the other rows', () => {
    const groups = deriveGroups(board([0, factory()], [1, key()]));
    const shown = withBaseName(groups, 'Par défaut');
    expect(shown.map((g) => g.name)).toEqual(['Par défaut', 'Group #1']);
    // The stored list is untouched.
    expect(groups[0]!.name).toBe(BASE_GROUP_NAME);
  });
});

describe('sameGroups', () => {
  const g = (id: string, name: string, color: string, slots: number[]) => ({
    id,
    name,
    color,
    slots,
  });

  it('ignores order', () => {
    const a = [g('1', 'A', '#111', [0, 1]), g('2', 'B', '#222', [2])];
    const b = [g('2', 'B', '#222', [2]), g('1', 'A', '#111', [1, 0])];
    expect(sameGroups(a, b)).toBe(true);
  });

  it('notices a changed name, colour or membership', () => {
    const a = [g('1', 'A', '#111', [0, 1])];
    expect(sameGroups(a, [g('1', 'B', '#111', [0, 1])])).toBe(false);
    expect(sameGroups(a, [g('1', 'A', '#222', [0, 1])])).toBe(false);
    expect(sameGroups(a, [g('1', 'A', '#111', [0])])).toBe(false);
  });
});

/**
 * The rail must hold exactly as many rows as the board has distinct settings —
 * one if every key agrees, two if one set of keys differs, and so on.
 *
 * It held far more. The derived list was stored with a per-group upsert, which
 * cannot make a group disappear, so a bucket that stopped existing stayed in
 * the file (emptied of its slots by the next save) and came back as a row for
 * no keys. The stored list therefore never matched the derived one, so the
 * effect that compares them reconciled, saved, re-rendered and reconciled
 * again — a loop that both filled the rail and kept the IPC channel busy while
 * a 79-key write was trying to use it.
 */
describe('the partition is exactly the settings', () => {
  const keys = (...specs: Array<Partial<MagneticKeySettings>>) =>
    specs.map((over, i) => ({ slot: i, settings: key(over) }));

  it('gives one group when every key agrees', () => {
    expect(reconcileGroups([], keys({}, {}, {}, {}, {}))).toHaveLength(1);
  });

  it('gives two when one set differs, however many keys are in it', () => {
    const g = reconcileGroups([], keys({}, {}, { rapidTrigger: true }, { rapidTrigger: true }, {}));
    expect(g).toHaveLength(2);
  });

  it('never holds two different settings in one group', () => {
    const board = keys(
      {},
      { rapidTrigger: true },
      {},
      { actuationMm: 2 },
      { rapidTrigger: true },
      { actuationMm: 2, rapidTrigger: true },
    );
    const sig = (slot: number) => JSON.stringify(board.find((b) => b.slot === slot)!.settings);
    for (const g of reconcileGroups([], board)) {
      expect(new Set(g.slots.map(sig)).size, `group ${g.name} mixes settings`).toBe(1);
    }
  });

  it('settles in one pass — reconciling its own output changes nothing', () => {
    // This is what stops the reconcile effect looping: it saves only when the
    // stored list disagrees with the derived one, so the derived one has to be
    // a fixed point.
    const board = keys({}, {}, { rapidTrigger: true }, { actuationMm: 2 }, {});
    const once = reconcileGroups([], board);
    const twice = reconcileGroups(once, board);
    expect(sameGroups(once, twice)).toBe(true);
    expect(sameGroups(twice, reconcileGroups(twice, board))).toBe(true);
  });

  it('settles after an edit, too', () => {
    const before = reconcileGroups([], keys({}, {}, {}, {}));
    // Six keys that agreed, now all given rapid trigger together: still one
    // group, not one per key. (Reported as "I enabled rapid trigger on six keys
    // and got three groups".)
    const after = reconcileGroups(
      before,
      keys(
        { rapidTrigger: true },
        { rapidTrigger: true },
        { rapidTrigger: true },
        { rapidTrigger: true },
      ),
    );
    expect(after).toHaveLength(1);
    expect(
      sameGroups(
        after,
        reconcileGroups(
          after,
          keys(
            { rapidTrigger: true },
            { rapidTrigger: true },
            { rapidTrigger: true },
            { rapidTrigger: true },
          ),
        ),
      ),
    ).toBe(true);
  });

  it('never emits a group with no keys', () => {
    const board = keys({}, { rapidTrigger: true }, {});
    const first = reconcileGroups([], board);
    // The RT key joins the others: its bucket must vanish, not linger empty.
    const merged = reconcileGroups(first, keys({}, {}, {}));
    expect(merged).toHaveLength(1);
    expect(merged.every((g) => g.slots.length > 0)).toBe(true);
  });
});

/**
 * A group can be renamed so its row can say what it is; at a fixed 128px the
 * row then could not show it ("Rapid trigger k…").
 */
describe('railWidthFor', () => {
  /** Stands in for a real text measurement — 6px a character. */
  const px = (s: string) => s.length * 6;

  it('never goes below the width a short name already had', () => {
    expect(railWidthFor(['A'], px)).toBe(RAIL_W_MIN);
    expect(railWidthFor([], px)).toBe(RAIL_W_MIN);
  });

  it('grows to fit the longest name, and only the longest', () => {
    const one = railWidthFor(['a much longer group name'], px);
    expect(one).toBe(RAIL_W_CHROME + 24 * 6);
    expect(railWidthFor(['A', 'a much longer group name', 'B'], px)).toBe(one);
  });

  it('stops growing at a width that is still an annotation on the board', () => {
    expect(railWidthFor(['x'.repeat(200)], px)).toBe(RAIL_W_MAX);
  });

  it('leaves room for the swatch and the scrollbar, not just the text', () => {
    // The name is not the row. Without the chrome the text is drawn under the
    // gutter, which is the same unreadable row by another route. Measured
    // below the cap, where the width is still the name's to decide.
    const n = 20;
    expect(railWidthFor(['x'.repeat(n)], px)).toBe(RAIL_W_CHROME + n * 6);
    expect(railWidthFor(['x'.repeat(n)], px)).toBeGreaterThan(n * 6);
  });
});
