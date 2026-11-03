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
import { REMAP_GROUPS } from './remapGroups';

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
    expect(KEY_GROUPS.find((g) => g.label === 'Media')?.keys[0]?.code).toBe('e8');
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
