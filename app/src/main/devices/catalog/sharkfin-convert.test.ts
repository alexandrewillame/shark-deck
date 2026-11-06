import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ANSI_79_SG9047 } from '@shared/layouts';
import type { KeyLayoutEntry } from '@shared/types/keys';
import { convertLayout, isCertain, parseRates, type SharkfinLayout } from './sharkfin-convert';
import { VENDOR_LAYOUTS } from './generated/vendor-layouts';
import { LAYOUT_GEOMETRY } from './generated/layout-geometry';

const FIXTURE = resolve(process.cwd(), 'test/fixtures/sharkfin/Common79_SG9047.json');
const R85HE_MATRIX = resolve(process.cwd(), 'scripts/_raw/kb-r85he-matrix.json');

const sg9047 = JSON.parse(readFileSync(FIXTURE, 'utf8')) as SharkfinLayout;

/** The fields a per-key write and the drawing depend on (labels are cosmetic). */
const wire = (l: KeyLayoutEntry[]) =>
  l.map(({ slot, code, row, col, x, y, w }) => ({ slot, code, row, col, x, y, w }));

describe('the sharkfin layout converter reproduces the hand-verified R85HE layout', () => {
  it('sharkfin ships this layout with geometry but no slots', () => {
    expect(isCertain(sg9047)).toBe(false);
    expect(sg9047.keys.filter((k) => k.type === 'key')).toHaveLength(ANSI_79_SG9047.length);
  });

  it('matches every key to its slot through a matrix built from ANSI_79_SG9047', () => {
    // Always runs (no vendor files needed): proves the geometry math and the
    // matrixEntry -> slot matching. The vendor-matrix test below makes the
    // slots themselves independent of our own table.
    const matrix = new Array<number>(512).fill(0);
    for (const k of ANSI_79_SG9047) {
      const quad = k.code === null ? [10, 1, 0, 0] : [0, 0, k.code!, 0];
      quad.forEach((b, i) => (matrix[k.slot! * 4 + i] = b));
    }
    expect(wire(convertLayout(sg9047, { defaultMatrix: matrix }))).toEqual(wire(ANSI_79_SG9047));
  });

  describe.skipIf(!existsSync(R85HE_MATRIX))('against the vendor default matrix', () => {
    it('lands on exactly the verified slots, codes and geometry', () => {
      const { defaultMatrix } = JSON.parse(readFileSync(R85HE_MATRIX, 'utf8')) as {
        defaultMatrix: number[];
      };
      expect(wire(convertLayout(sg9047, { defaultMatrix }))).toEqual(wire(ANSI_79_SG9047));
    });
  });

  it('refuses to guess a slot that matches zero or several matrix entries', () => {
    expect(() => convertLayout(sg9047, { defaultMatrix: new Array(512).fill(0) })).toThrow(
      /matches 0 slots/,
    );
  });
});

describe('generated addressable layouts', () => {
  const stems = Object.keys(VENDOR_LAYOUTS);

  it('exist', () => {
    expect(stems.length).toBeGreaterThanOrEqual(10);
  });

  it.each(stems)('%s: every key has a unique slot inside the 128-slot layer', (stem) => {
    const slots = VENDOR_LAYOUTS[stem]!.map((k) => k.slot);
    expect(slots.every((s) => s !== undefined && s >= 0 && s < 128)).toBe(true);
    expect(new Set(slots).size).toBe(slots.length);
  });

  it.each(stems)('%s: follows the vendor column-major convention', (stem) => {
    // Every addressable layout in this family puts A at slot 9 and Space at
    // slot 41, and Esc top-left (slot 0, or 1 on boards with no F-row) — the
    // pattern ANSI_79_SG9047 was verified with on hardware. A converter or
    // source bug that shuffled slots would break these first.
    const keys = VENDOR_LAYOUTS[stem]!;
    const at = (code: number) => keys.find((k) => k.code === code)?.slot;
    expect(at(4), 'A').toBe(9);
    expect(at(44), 'Space').toBe(41);
    expect([0, 1]).toContain(at(41));
    for (const k of keys) {
      expect(k.row).toBe(k.slot! % 6);
      expect(k.col).toBe(Math.floor(k.slot! / 6));
    }
  });

  it.each(stems)('%s: matrix columns run top to bottom', (stem) => {
    // Within one matrix column, a higher row is drawn lower on the board.
    // A nav cluster or numpad may be wired to an electrical row it is not
    // drawn in, so allow a few exceptions — not a shuffled layout.
    const byCol = new Map<number, KeyLayoutEntry[]>();
    for (const k of VENDOR_LAYOUTS[stem]!) {
      if (!byCol.has(k.col)) byCol.set(k.col, []);
      byCol.get(k.col)!.push(k);
    }
    let pairs = 0;
    let bad = 0;
    for (const col of byCol.values()) {
      const s = [...col].sort((a, b) => a.row - b.row);
      for (let i = 1; i < s.length; i++, pairs++) if (s[i]!.y <= s[i - 1]!.y) bad++;
    }
    expect(bad / pairs).toBeLessThanOrEqual(0.1);
  });
});

describe('generated drawing-only layouts', () => {
  it.each(Object.keys(LAYOUT_GEOMETRY))('%s carries no slots', (stem) => {
    expect(LAYOUT_GEOMETRY[stem]!.some((k) => k.slot !== undefined)).toBe(false);
  });
});

describe('parseRates', () => {
  it('reads the cable and 2.4 GHz rate tokens of a vendor internal name', () => {
    expect(parseRates('ry5088_sg9047_1m_8k')).toEqual({ cable: 8000, wireless: null });
    expect(parseRates('ry5088_sg9047_3m_8k_8k')).toEqual({ cable: 8000, wireless: 8000 });
    expect(parseRates('ry5088_sg_sg9015_3m_8k_1k')).toEqual({ cable: 8000, wireless: 1000 });
    expect(parseRates('yc3121_x86_soc')).toEqual({ cable: null, wireless: null });
  });
});
