import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { KB_CMD } from './compx-keyboard';

/**
 * Lock `KB_CMD` to the vendor's own command table.
 *
 * `KB_CMD` was reconstructed from the Attack Shark Driver v4 bundle plus a USB
 * capture. qmk.top ("GearHub-V5") is the vendor's WebHID configurator and
 * assigns the same opcodes in readable source, so it is an independent check on
 * that reconstruction — 33 of 35 entries agreed on the first comparison.
 *
 * Regenerate the fixture with `npm run extract:qmk`. If a vendor deploy moves an
 * opcode, this test fails and the raw JSON diff shows what moved.
 *
 * NOTE this compares against the *effective* table for the keyboard class chain
 * (`pD -> gD -> mD -> yD -> yn`). The same protocol family has a second,
 * colliding command set on other boards — e.g. family A's "write keymap" (9) is
 * family B's "write options bitfield", which holds the keyboard-lock bit. Never
 * mix the two tables.
 */

type Fixture = {
  chain: string[];
  effective: Array<{ name: string; value: number; definedIn: string }>;
};

/**
 * The fixtures are extracted locally and git-ignored (app/.gitignore), so a
 * fresh clone — CI — has none: these comparisons are skipped there rather
 * than failing the file on a missing JSON.
 */
const COMMANDS = resolve(process.cwd(), 'scripts/_raw/qmk-commands.json');
const MAGNETISM = resolve(process.cwd(), 'scripts/_raw/qmk-magnetism.json');
const fixture: Fixture = existsSync(COMMANDS)
  ? JSON.parse(readFileSync(COMMANDS, 'utf8'))
  : { chain: [], effective: [] };

const vendor = new Map(fixture.effective.map((c) => [c.name.replace(/^FEA_CMD_/, ''), c.value]));

/** Same opcode, different vendor spelling. */
const ALIAS: Record<string, string> = {
  SET_RESET: 'SET_RESERT',
  SET_FN: 'SET_FNKEYMATRIX',
  GET_FN: 'GET_FNKEYMATRIX',
  SET_MAGNETISM_REPORT: 'SET_MAGNETISM_REPOR',
};

/**
 * Not part of the keyboard command chain at all. In this protocol family 80 and
 * 208 are FEA_CMD_MOUSE_SET_KEYMATRIX / FEA_CMD_MOUSE_GET_KEYMATRIX; these two
 * entries came from a different vendor generation. No driver method sends them
 * today, and none should without a capture proving what a keyboard does with
 * them — a stray 80 is a cross-family write.
 */
const NOT_IN_KEYBOARD_CHAIN = ['SET_SKU', 'GET_SKU'] as const;

describe.skipIf(!existsSync(COMMANDS))('KB_CMD vs the qmk.top vendor table', () => {
  it('extracted the keyboard class chain, ending at the constructed class', () => {
    expect(fixture.chain).toContain('yn');
    expect(fixture.chain.length).toBeGreaterThanOrEqual(5);
  });

  const checked = Object.entries(KB_CMD).filter(
    ([name]) => !(NOT_IN_KEYBOARD_CHAIN as readonly string[]).includes(name),
  );

  it.each(checked)('%s = %i matches the vendor table', (name, value) => {
    expect(vendor.get(ALIAS[name] ?? name)).toBe(value);
  });

  it.each(NOT_IN_KEYBOARD_CHAIN)('%s is absent from the keyboard chain', (name) => {
    expect(vendor.has(ALIAS[name] ?? name)).toBe(false);
  });

  it('carries the magnetism commands the HE driver depends on', () => {
    expect(vendor.get('SET_MULTI_MAGNETISM')).toBe(0x65);
    expect(vendor.get('GET_MULTI_MAGNETISM')).toBe(0xe5);
  });
});

/**
 * The magnetic-switch parameter pages. Pages 2/3 (rapid-trigger sensitivity),
 * 16 (all-key DKS flags) and 254 (live travel) are the ones the driver did not
 * originally implement; assert they are still in the fixture so a regenerated
 * extraction that loses them fails loudly rather than silently narrowing.
 */
describe.skipIf(!existsSync(MAGNETISM))('magnetism parameter pages', () => {
  const mag = existsSync(MAGNETISM) ? JSON.parse(readFileSync(MAGNETISM, 'utf8')) : { pages: [] };
  const byName: Record<string, number> = Object.fromEntries(
    mag.pages.map((p: { name: string; page: number }) => [p.name, p.page]),
  );

  it.each([
    ['pressActuation', 0],
    ['releasePoint', 1],
    ['rapidTriggerPress', 2],
    ['rapidTriggerRelease', 3],
    ['dksActuationPoints', 4],
    ['modTapHoldTime', 5],
    ['deadZoneBottom', 6],
    ['modeByte', 7],
    ['dksZoneActions', 8],
    ['socdPartnerSlot', 9],
    ['dksZoneActionsAllKeys', 16],
    ['deadZoneTop', 251],
    ['switchType', 252],
    ['liveTravel', 254],
  ])('%s is page %i', (name, page) => {
    expect(byName[name]).toBe(page);
  });

  it('treats rapid trigger as a mode-byte bit, not a mode', () => {
    expect(mag.modeByte.rapidTriggerBit).toBe(0x80);
    expect(mag.modeByte.fullBottomBit).toBe(0x40);
    // snap/SOCD is a low-nibble mode and must not be conflated with RT
    expect(mag.modeByte.modes.find((m: { mode: string }) => m.mode === 'snap')?.value).toBe(7);
  });

  it('maps report-rate indices the same way the driver does', () => {
    expect(mag.reportRate.indexToHz).toEqual({
      0: 8000,
      1: 4000,
      2: 2000,
      3: 1000,
      4: 500,
      5: 250,
      6: 125,
    });
  });
});
