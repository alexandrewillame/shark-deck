import { describe, expect, it } from 'vitest';
import { en, getT } from './i18n';
import {
  ASSIGNABLE_QUADS,
  ASSIGNABLE_QUAD_KEY,
  CONSUMER_LABEL,
  CONSUMER_LABEL_KEY,
  LIGHTING_LABEL,
  LIGHTING_LABEL_KEY,
  SYSTEM_LABEL,
  SYSTEM_LABEL_KEY,
  decodeKeyQuad,
  quadLabel,
} from './keyboard-fn-codes';
import { KB_FN_DEFAULT_SLOTS } from './keyboard-fn-defaults';

/**
 * These are the readings the app got wrong, written as the board's own bytes.
 *
 * Every case here came from a real R85HE being compared against what the Remap
 * tab said about it: media and brightness keys drawn as unbound, two-key combos
 * reported as whichever half happened to sit in byte 2, and a cleared slot
 * rendered as "-> 0x00".
 */
describe('decodeKeyQuad', () => {
  it('names a consumer-page binding instead of returning nothing', () => {
    // Fn+F8 pauses music. The old decode returned {kind:'consumer', code:null}
    // with no label, so the board drew an unbound key.
    expect(decodeKeyQuad([3, 0, 205, 0])).toMatchObject({
      kind: 'consumer',
      label: 'Play / Pause',
    });
    expect(decodeKeyQuad([3, 0, 112, 0]).label).toBe('Screen brightness -');
    expect(decodeKeyQuad([3, 0, 233, 0]).label).toBe('Volume +');
    expect(decodeKeyQuad([3, 0, 70, 0]).kind).toBe('consumer');
  });

  it('reads a consumer usage above 255 from both bytes', () => {
    // 0x0183 = Media player. Byte 3 is the high byte, not a modifier.
    expect(decodeKeyQuad([3, 0, 0x83, 0x01]).label).toBe('Media player');
  });

  it('keeps BOTH usages of a two-key combo', () => {
    // Read off the real board (scripts/diag-fn-quads.ts): Fn+8 is
    // [0, 230, 37, 0] and the user reads it on qmk.top as "R-Alt + 8".
    // Looking at byte 2 alone reported just "8".
    expect(decodeKeyQuad([0, 230, 37, 0]).label).toBe('R-Alt + 8');
    expect(decodeKeyQuad([0, 230, 48, 0]).label).toBe('R-Alt + ] }');
  });

  it('reports the non-modifier usage as the code of a combo', () => {
    // Which half is `code` matters: it is what a comparison against the
    // factory binding runs on, and what "what does this key send" means.
    expect(decodeKeyQuad([0, 230, 37, 0]).code).toBe('25');
    expect(decodeKeyQuad([0, 230, 48, 0]).code).toBe('30');
    // A lone modifier is its own binding — Fn+2 really is just R-Alt.
    expect(decodeKeyQuad([0, 0, 230, 0]).code).toBe('e6');
  });

  it('finds a usage sitting in byte 1 with byte 2 empty', () => {
    // The "-> 0x00" case. Fn+DEL / PgUp / PgDn store their usage in byte 1
    // and leave byte 2 at zero, so a decode that read bytes 2 and 3 called
    // all three of them unbound. Measured on hardware.
    expect(decodeKeyQuad([0, 73, 0, 0])).toMatchObject({ kind: 'key', code: '49' });
    expect(decodeKeyQuad([0, 74, 0, 0]).label).toBe('Home');
    expect(decodeKeyQuad([0, 77, 0, 0]).label).toBe('End');
  });

  it('reads the base layer the same way it always did', () => {
    // The base layer put its usage in byte 2 and that alignment was verified
    // against 77 of 77 layout entries — a change to the Fn decode must not
    // disturb it, since both layers share one quad shape.
    expect(decodeKeyQuad([0, 0, 69, 0]).label).toBe('F12');
    expect(decodeKeyQuad([0, 0, 76, 0]).label).toBe('Delete');
    expect(decodeKeyQuad([0, 0, 4, 0]).code).toBe('04');
  });

  it('calls an all-zero quad unused, not a binding to usage zero', () => {
    expect(decodeKeyQuad([0, 0, 0, 0])).toMatchObject({ kind: 'unused', code: null, label: '' });
  });

  it('locks firmware behaviour but not the lighting actions the picker offers', () => {
    // Neither rule the app tried to derive survived the board. "Types 10 and
    // 13 are reserved" locked the brightness and mode-cycle keys, which
    // qmk.top offers as ordinary bindings; "nothing is reserved" then
    // presented sub-mode and speed as bindings, which appear in no picker.
    // The answer is the vendor's own action list — see ASSIGNABLE_QUADS.

    // In the picker, so a binding.
    expect(decodeKeyQuad([13, 2, 1, 0])).toMatchObject({
      kind: 'lighting',
      label: 'Lighting brightness +',
      locked: false,
    });
    expect(decodeKeyQuad([13, 1, 0, 0]).label).toBe('Lighting mode');
    expect(decodeKeyQuad([13, 1, 0, 0]).locked).toBe(false);
    // A type-10 quad can be a binding too — lighting on/off is one.
    expect(decodeKeyQuad([10, 9, 0, 0])).toMatchObject({
      kind: 'system',
      label: 'Lighting on / off',
      locked: false,
    });

    // Not in the picker: firmware behaviour with nothing to assign.
    expect(decodeKeyQuad([10, 3, 0, 0]).locked).toBe(true);
    expect(decodeKeyQuad([13, 8, 1, 0]).locked).toBe(true);
    expect(decodeKeyQuad([13, 3, 1, 0]).locked).toBe(true);
    expect(decodeKeyQuad([13, 5, 1, 0]).locked).toBe(true);

    // A host-visible usage is never locked, whatever else is true of it.
    expect(decodeKeyQuad([3, 0, 205, 0]).locked).toBe(false);
    expect(decodeKeyQuad([0, 230, 37, 0]).locked).toBe(false);
  });

  it('gives every factory Fn default a label of its own', () => {
    // The factory table used to be the ONLY source of these labels, which is
    // why it was overwriting the live read. It is a fallback now, so the
    // decode has to stand on its own for everything except the opaque
    // firmware functions.
    const unlabelled = Object.values(KB_FN_DEFAULT_SLOTS).filter(
      (d) => !decodeKeyQuad(d.raw).label,
    );
    expect(unlabelled.map((d) => d.slot)).toEqual([]);
  });
});

/**
 * The board's function names in the app's language. The English tables stay
 * what the main process decodes; the renderer shows `quadLabel` instead. If a
 * key and the English it stands for drift apart, the tooltip and the picker
 * would name the same binding two different ways.
 */
describe('quadLabel', () => {
  const tables: Array<[string, object, object]> = [
    ['CONSUMER_LABEL', CONSUMER_LABEL, CONSUMER_LABEL_KEY],
    ['ASSIGNABLE_QUADS', ASSIGNABLE_QUADS, ASSIGNABLE_QUAD_KEY],
    ['LIGHTING_LABEL', LIGHTING_LABEL, LIGHTING_LABEL_KEY],
    ['SYSTEM_LABEL', SYSTEM_LABEL, SYSTEM_LABEL_KEY],
  ];

  it.each(tables)('keys every %s entry to the English it stands for', (_, table, keyTable) => {
    const names = table as Record<string, string>;
    const keys = keyTable as Record<string, keyof typeof en>;
    expect(Object.keys(keys).sort()).toEqual(Object.keys(names).sort());
    for (const [id, key] of Object.entries(keys)) expect(en[key], id).toBe(names[id]);
  });

  it('reads exactly as the decode does in English, for every kind of quad', () => {
    const t = getT('en');
    const quads: Array<[number, number, number, number]> = [
      ...Object.keys(CONSUMER_LABEL).map((u): [number, number, number, number] => [
        3,
        0,
        Number(u) & 0xff,
        Number(u) >> 8,
      ]),
      ...Object.keys(ASSIGNABLE_QUADS).map(
        (q) => q.split(',').map(Number) as [number, number, number, number],
      ),
      [3, 0, 0x46, 0], // a consumer usage with no name
      [13, 3, 1, 0], // lighting speed -, by its exact row
      [13, 2, 7, 0], // lighting brightness, by its wildcard row
      [13, 9, 0, 0], // a lighting control nothing names
      [10, 3, 0, 0], // Windows key lock
      [10, 77, 0, 0], // a firmware function nothing names
      [0, 230, 37, 0], // a combination: legends, not a name
    ];
    for (const q of quads) expect(quadLabel(q, t), q.join(',')).toBe(decodeKeyQuad(q).label);
  });

  it('names a media key in the language asked for', () => {
    const fake = (key: string, vars?: Record<string, string | number>) =>
      `<${key}${vars ? ` ${JSON.stringify(vars)}` : ''}>`;
    expect(quadLabel([3, 0, 0x83, 0x01], fake)).toBe('<keyfn.mediaPlayer>');
    expect(quadLabel([3, 0, 0x46, 0], fake)).toBe('<keyfn.mediaUnknown {"code":"0x46"}>');
    // A combination keeps its legends whatever the language.
    expect(quadLabel([0, 230, 37, 0], fake)).toBe('R-Alt + 8');
  });
});
