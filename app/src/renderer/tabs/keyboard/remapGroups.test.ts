import { describe, expect, it } from 'vitest';
import { en } from '@shared/i18n';
import { decodeKeyQuad } from '@shared/keyboard-fn-codes';
import { KEY_GROUPS } from '@shared/keys';
import {
  consumerAction,
  pickAction,
  pickHas,
  pickOf,
  quadBytes,
  togglePick,
} from './keyRemapState';
import { MACRO_ACTION, REMAP_GROUPS, remapGroupsFor } from './remapGroups';

/**
 * The Remap picker's media and launcher keys.
 *
 * Reported: Fn+F9 was "Media player" on the board, and the picker had no
 * button for it — a binding could be read off a key but never given to
 * another one. The picker's Media row was six keyboard-page usages; the board
 * binds media keys as Consumer-page quads.
 */
describe('the Remap picker', () => {
  const all = REMAP_GROUPS.flatMap((g) => g.keys);
  const byLabel = (label: string) => all.find((k) => k.label === label);

  it('offers Media player, as the quad the board stores', () => {
    expect(byLabel('Media player')?.code).toBe('03008301');
    expect(decodeKeyQuad(quadBytes('03008301')).label).toBe('Media player');
  });

  it('writes every media key the way the factory Fn layer does', () => {
    // Play / Pause is [3, 0, 205, 0] on a real R85HE's Fn+F8.
    expect(byLabel('Play / Pause')?.code).toBe('0300cd00');
    expect(byLabel('Volume -')?.code).toBe('0300ea00');
    expect(all.some((k) => /^e[8-f]$/.test(k.code))).toBe(false);
  });

  it('names each button exactly as the board will then name the key', () => {
    for (const k of all.filter((k) => k.code.length === 8)) {
      expect(decodeKeyQuad(quadBytes(k.code)).label, k.code).toBe(k.label);
    }
  });

  it('translates every heading and media key it names, to the words the board uses', () => {
    // The picker draws `labelKey`; `label` is what the board calls the key
    // once bound. In English the two must read the same.
    for (const g of REMAP_GROUPS) expect(en[g.labelKey!], g.label).toBe(g.label);
    for (const k of all.filter((k) => k.code.length === 8)) {
      expect(en[k.labelKey!], k.code).toBe(k.label);
    }
  });

  it('keeps every other key the shared table offers, in its order', () => {
    const plain = (gs: typeof KEY_GROUPS) =>
      gs.flatMap((g) => g.keys).filter((k) => k.code.length < 8 && !/^e[8-f]$/.test(k.code));
    expect(plain(REMAP_GROUPS)).toEqual(plain(KEY_GROUPS));
  });

  it('leaves the macro editor its own keyboard-page media row', () => {
    const media = KEY_GROUPS.find((g) => g.label === 'Media')?.keys ?? [];
    expect(media.length).toBeGreaterThan(0);
    for (const k of media) expect(k.code).toMatch(/^e[8-f]$/);
  });

  it('orders media and brightness back before forward, down before up', () => {
    const names = (label: string) =>
      REMAP_GROUPS.find((g) => g.label === label)!.keys.map((k) => k.label);
    const media = names('Media');
    const before = (a: string, b: string) =>
      expect(media.indexOf(a)).toBeLessThan(media.indexOf(b));
    before('Previous track', 'Play / Pause');
    before('Play / Pause', 'Next track');
    before('Volume -', 'Volume +');
    const system = names('System');
    expect(system.indexOf('Screen brightness -')).toBeLessThan(
      system.indexOf('Screen brightness +'),
    );
  });
});

describe('a pick', () => {
  const mediaPlayer = consumerAction(0x183);

  it('reads a key bound to a consumer usage as that one button', () => {
    const p = pickOf([3, 0, 0x83, 0x01]);
    expect(p).toEqual({ usages: [], quad: '03008301' });
    expect(pickHas(p, mediaPlayer)).toBe(true);
    expect(pickAction(p)).toBe('03008301');
  });

  it('reads a combination as its usages, lighting no media key', () => {
    const p = pickOf([0, 230, 37, 0]);
    expect(p).toEqual({ usages: [230, 37], quad: null });
    expect(pickHas(p, '25')).toBe(true);
    expect(pickHas(p, mediaPlayer)).toBe(false);
  });

  it('replaces a combination with a media key, and the other way round', () => {
    const combo = { usages: [0xe0, 0x04], quad: null };
    const media = togglePick(combo, mediaPlayer);
    expect(media).toEqual({ usages: [], quad: '03008301' });
    expect(togglePick(media, '4')).toEqual({ usages: [4], quad: null });
    // A second click on the staged media key clears it.
    expect(togglePick(media, mediaPlayer)).toEqual({ usages: [], quad: null });
  });

  it('still builds a combination one usage at a time', () => {
    let p = { usages: [] as number[], quad: null as string | null };
    for (const code of ['e0', 'e1', '29']) p = togglePick(p, code);
    expect(pickAction(p)).toBe('00e0e129');
  });
});

/**
 * The keyboard's macros as key bindings: `[9, 0, slot, 0]`, the official
 * software's own (an R98 HE: F12 given its first macro; Fn + N*, N- and N/ its
 * three), which a real R98 HE accepted and read back.
 */
describe('the macros in the Remap picker', () => {
  it('offers a button per macro on the board, and none for an empty board', () => {
    const codes = (slots: number[] | null) =>
      remapGroupsFor(slots)
        .flatMap((g) => g.keys)
        .map((k) => k.code)
        .filter((c) => c.startsWith('09'));
    expect(codes([])).toEqual([]);
    expect(MACRO_ACTION).toBe('09000000');
    expect(codes([2, 0, 1])).toEqual(['09000000', '09000100', '09000200']);
    expect(codes(null)).toEqual([]);
  });

  it('names a button by the library macro its slot holds, where there is one', () => {
    const macros = remapGroupsFor([0, 1], (slot) => (slot === 1 ? 'Rolling' : null)).find(
      (g) => g.labelKey === 'keypick.group.macro',
    )!.keys;
    expect(macros.map((k) => k.label)).toEqual(['Macro 1', 'Macro 2 · Rolling']);
    expect(macros.map((k) => k.labelKey)).toEqual(['keyfn.macroN', 'keyfn.macroNamed']);
    expect(en['keyfn.macroNamed']).toBe('Macro {n} · {name}');
  });

  it('reads them back as the macros they are, and lights the one a key holds', () => {
    const first = decodeKeyQuad(quadBytes(MACRO_ACTION));
    expect([first.kind, first.label, first.short]).toEqual(['macro', 'Macro 1', 'M1']);
    expect(decodeKeyQuad([9, 0, 2, 0]).label).toBe('Macro 3');
    expect(en[first.labelKey!]).toBe('Macro {n}');
    const bound = pickOf([9, 0, 2, 0]);
    expect(pickHas(bound, '09000200')).toBe(true);
    expect(pickHas(bound, MACRO_ACTION)).toBe(false);
    expect(pickAction(togglePick(pickOf([0, 0, 0x45, 0]), MACRO_ACTION))).toBe(MACRO_ACTION);
  });
});
