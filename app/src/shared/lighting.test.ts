import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  KB_LIGHT_EFFECTS,
  KB_LIGHT_EFFECTS_TABLE,
  KB_PERKEY_EFFECT_INDEX,
  SIDE_LIGHT_EFFECTS,
  kbEffect,
  RAINBOW_EFFECTS,
} from './lighting';

/**
 * The effect tables are the wire protocol: array position IS the value of
 * `SET_LEDPARAM` byte `e[1]`. They were previously hand-maintained with a
 * docstring crediting a source that does not contain them, no test, and no
 * entry in docs/protocol — so a rename or a reorder would have silently
 * changed what gets written to a device.
 *
 * This locks them to the vendor bundle we actually extracted them from.
 *
 * The bundle is extracted locally (`npm run extract:qmk`) and git-ignored
 * (app/.gitignore), so a fresh clone — CI — has none: the comparisons with it
 * are skipped there rather than failing the whole file on a missing fixture.
 */
const BUNDLE = fileURLToPath(new URL('../../scripts/_raw/qmk-bundle.js', import.meta.url));
const HAVE_BUNDLE = existsSync(BUNDLE);
const bundle = HAVE_BUNDLE ? readFileSync(BUNDLE, 'utf8') : '';

/** Pull `{0:"LightOff",1:...}` style index maps out of the minified bundle. */
function indexMap(symbol: string): Record<number, string> {
  if (!HAVE_BUNDLE) return {};
  const at = bundle.indexOf(symbol);
  expect(at, `${symbol} not found in the vendor bundle`).toBeGreaterThan(-1);
  const open = bundle.indexOf('{', at);
  const close = bundle.indexOf('}', open);
  const out: Record<number, string> = {};
  for (const m of bundle.slice(open, close).matchAll(/(\d+):"(\w+)"/g)) out[Number(m[1])] = m[2]!;
  return out;
}

describe.skipIf(!HAVE_BUNDLE)('KB_LIGHT_EFFECTS_TABLE matches the vendor LIGHT_LIST', () => {
  const list = indexMap('LIGHT_LIST');

  it('is index-for-index identical, with no gaps', () => {
    expect(Object.keys(list)).toHaveLength(KB_LIGHT_EFFECTS_TABLE.length);
    for (const [wire, id] of Object.entries(list)) {
      expect(KB_LIGHT_EFFECTS_TABLE[Number(wire)]?.id, `wire ${wire}`).toBe(id);
    }
  });

  it('keeps the per-key layer at the index the driver writes', () => {
    expect(KB_LIGHT_EFFECTS_TABLE[KB_PERKEY_EFFECT_INDEX]?.id).toBe('LightUserPicture');
  });

  it('exposes labels positionally, so KB_LIGHT_EFFECTS stays a wire-indexed array', () => {
    expect(KB_LIGHT_EFFECTS).toHaveLength(KB_LIGHT_EFFECTS_TABLE.length);
    expect(KB_LIGHT_EFFECTS[0]).toBe('Off');
  });

  it('has unique labels — the UI round-trips effects by label', () => {
    expect(new Set(KB_LIGHT_EFFECTS).size).toBe(KB_LIGHT_EFFECTS.length);
    for (const e of KB_LIGHT_EFFECTS_TABLE) expect(kbEffect(e.label)?.id).toBe(e.id);
  });
});

describe('per-effect parameters match the vendor lightLayout', () => {
  /** The longest `types:[…]` array in the bundle that covers the main list. */
  const types = (() => {
    let best = '';
    for (let i = bundle.indexOf('types:['); i >= 0; i = bundle.indexOf('types:[', i + 1)) {
      const start = bundle.indexOf('[', i);
      let depth = 0;
      let j = start;
      for (; j < bundle.length; j++) {
        if (bundle[j] === '[') depth++;
        else if (bundle[j] === ']' && --depth === 0) break;
      }
      const seg = bundle.slice(start, j + 1);
      if (seg.includes('LightAlwaysOn') && seg.length > best.length) best = seg;
    }
    const out = new Map<
      string,
      { speed: boolean; brightness: boolean; colour: boolean; dazzle: boolean; options: number }
    >();
    for (const m of best.matchAll(/\{type:"(\w+)"([^}]*)\}/g)) {
      const body = m[2] ?? '';
      out.set(m[1]!, {
        speed: body.includes('maxSpeed:'),
        brightness: body.includes('maxValue:'),
        colour: body.includes('rgb:!0'),
        dazzle: body.includes('dazzle:!0'),
        options: body.match(/options:\[([^\]]*)\]/)?.[1]?.split(',').length ?? 0,
      });
    }
    return out;
  })();

  it.skipIf(!HAVE_BUNDLE)('found the vendor table', () => {
    expect(types.size).toBeGreaterThan(15);
  });

  it.each([...(types?.keys() ?? [])])('%s', (id) => {
    const want = types.get(id)!;
    const got = KB_LIGHT_EFFECTS_TABLE.find((e) => e.id === id);
    expect(got, `${id} missing from the table`).toBeDefined();
    expect(!!got!.speed, 'speed').toBe(want.speed);
    expect(!!got!.brightness, 'brightness').toBe(want.brightness);
    expect(!!got!.colour, 'colour').toBe(want.colour);
    expect(!!got!.dazzle, 'dazzle').toBe(want.dazzle);
    expect(got!.options?.length ?? 0, 'option count').toBe(want.options);
  });

  it('gives the static effect no speed control — the reported bug', () => {
    expect(kbEffect('Always On')?.speed).toBeFalsy();
    expect(kbEffect('Always On')?.brightness).toBe(true);
  });

  it('does not hide the colour picker for effects the board colours', () => {
    // These four were in the old hand-kept RAINBOW_EFFECTS list despite the
    // vendor marking them `rgb:!0`.
    for (const label of ['Wave', 'Kaleidoscope', 'Circle Wave', 'Dazzling']) {
      expect(kbEffect(label)?.colour, label).toBe(true);
      expect(RAINBOW_EFFECTS.has(label), label).toBe(false);
    }
    expect(RAINBOW_EFFECTS.has('Spectrum Cycle')).toBe(true);
  });
});

describe.skipIf(!HAVE_BUNDLE)('SIDE_LIGHT_EFFECTS matches the vendor SIDE_LIGUT_LIST', () => {
  // Vendor's own typo — matching it exactly is the point.
  const list = indexMap('SIDE_LIGUT_LIST');

  it('maps every entry to the same wire value', () => {
    const byWire = new Map(SIDE_LIGHT_EFFECTS.map((e) => [e.wire, e.name]));
    expect(byWire.size).toBe(Object.keys(list).length);
    for (const wire of Object.keys(list))
      expect(byWire.has(Number(wire)), `wire ${wire}`).toBe(true);
  });

  it('puts Snake at 5, not the main list’s 7', () => {
    expect(list[5]).toBe('LightSnake');
    expect(SIDE_LIGHT_EFFECTS.find((e) => e.name === 'Snake')?.wire).toBe(5);
  });
});
