import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * One type scale and one control height (tokens.css).
 *
 * There were fourteen font sizes — 10.5, 11.5, 12.5 and 15px among them, each
 * a half-step from a neighbour and each picked where it was needed — and
 * buttons, segmented controls and fields of 37, 33 and 31px side by side in
 * the same rows. Nothing stopped the next one either, which is this test.
 */
const DIR = __dirname;
const sheets = readdirSync(DIR)
  .filter((f) => f.endsWith('.css'))
  .map((f) => ({ name: f, css: readFileSync(resolve(DIR, f), 'utf8') }));
const tokens = sheets.find((s) => s.name === 'tokens.css')!.css;

/** Keycap micro-labels: drawn to the key, smaller than any UI text. */
const KEYCAP_SIZES = new Set(['8px', '9px', 'inherit', '0.78em', 'var(--kb-font)']);

describe('the type scale', () => {
  it('is defined once, in tokens.css', () => {
    for (const t of ['2xs', 'xs', 'sm', 'md', 'lg', 'xl', '2xl', 'display']) {
      expect(tokens, `--fs-${t}`).toMatch(new RegExp(`--fs-${t}:\\s*\\d+px;`));
    }
  });

  it('is the only source of a font size', () => {
    const off: string[] = [];
    for (const { name, css } of sheets) {
      if (name === 'tokens.css') continue;
      for (const m of css.matchAll(/font-size:\s*([^;]+);/g)) {
        const v = m[1]!.trim();
        if (/^var\(--fs-[a-z0-9]+\)$/.test(v)) continue;
        if (name === 'keyboard-map.css' && KEYCAP_SIZES.has(v)) continue;
        off.push(`${name}: ${v}`);
      }
    }
    expect(off).toEqual([]);
  });
});

describe('control heights', () => {
  it('sizes buttons, segments and fields from one token', () => {
    expect(tokens).toMatch(/--ctl-h:\s*\d+px;/);
    expect(tokens).toMatch(/--ctl-h-sm:\s*\d+px;/);
    const css = sheets.map((s) => s.css).join('\n');
    const rule = (sel: string) => {
      const m = new RegExp(
        `(?:^|\\n)${sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\{([^}]*)\\}`,
      ).exec(css);
      return m?.[1] ?? '';
    };
    expect(rule('.btn')).toMatch(/min-height:\s*var\(--ctl-h\)/);
    expect(rule('.seg button')).toMatch(/min-height:\s*calc\(var\(--ctl-h\) - 2px\)/);
    expect(rule('.btn.icon-only')).toMatch(/width:\s*var\(--ctl-h\)/);
    expect(css).toMatch(
      /select,\s*input\[type='text'\],\s*input\[type='number'\] \{[^}]*min-height:\s*var\(--ctl-h\)/,
    );
  });
});
