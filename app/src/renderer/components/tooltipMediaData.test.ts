import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { en } from '@shared/i18n';
import { ANIMATIONS, localizeSvg, svgWords } from './tooltipMediaData';

/**
 * Static guardrails for the tooltip illustrations. Their markup is a string
 * parsed as HTML via dangerouslySetInnerHTML, so nothing here is checked by
 * tsc, and the failure mode of every mistake below is the same: the picture
 * silently stops moving (or never appears) with no error anywhere. Each check
 * pins a pitfall the file's own comments already warn about.
 */

type Tag = { name: string; attrs: Record<string, string>; raw: string };

const ATTR = /([\w:-]+)="([^"]*)"/g;
const TAG = /<(\/)?([a-zA-Z][\w:-]*)([^<>]*?)(\/)?>/g;

function stripComments(svg: string): string {
  return svg.replace(/<!--[\s\S]*?-->/g, '');
}

/** Every element in the markup, opening tags only. */
function tags(svg: string): Tag[] {
  const out: Tag[] = [];
  for (const m of stripComments(svg).matchAll(TAG)) {
    if (m[1]) continue; // closing tag
    const attrs: Record<string, string> = {};
    for (const a of m[3]!.matchAll(ATTR)) attrs[a[1]!] = a[2]!;
    out.push({ name: m[2]!, attrs, raw: m[0] });
  }
  return out;
}

const ANIMATE_TAGS = new Set(['animate', 'animateMotion', 'animateTransform', 'set']);
const COLOUR_ATTRS = new Set(['fill', 'stroke', 'stop-color', 'color', 'flood-color']);
const nums = (s: string) => s.split(';').map((v) => v.trim());

describe('tooltipMediaData', () => {
  it('ids are unique and every one has a wrapper in tooltipMedia.tsx (and vice versa)', () => {
    const ids = ANIMATIONS.map((a) => a.id);
    expect(new Set(ids).size).toBe(ids.length);
    const src = readFileSync(fileURLToPath(new URL('./tooltipMedia.tsx', import.meta.url)), 'utf8');
    // `return <…/>;` — the file's doc comment also shows a `<RenderAnimation>`
    // usage example, which is not a wrapper.
    const wrapped = [...src.matchAll(/return <RenderAnimation id="([^"]+)" \/>;/g)].map(
      (m) => m[1]!,
    );
    expect([...wrapped].sort()).toEqual([...ids].sort());
  });

  it('descriptions survive the preview generator', () => {
    // scripts/generate-tooltip-preview.mjs reads this file with a regex that
    // takes a single-quoted string — a straight apostrophe in a description
    // truncates the card's caption there. Use a curly one (’).
    for (const a of ANIMATIONS) {
      expect(a.description, a.id).not.toContain("'");
      expect(a.label, a.id).not.toContain("'");
    }
  });

  for (const anim of ANIMATIONS) {
    describe(anim.id, () => {
      const all = tags(anim.svgContent);
      const animates = all.filter((t) => ANIMATE_TAGS.has(t.name));

      it('is balanced markup', () => {
        // innerHTML "repairs" a missing </g> by closing it at the end of the
        // string, which moves every later element inside the group — and its
        // transform, clip or opacity animation — without a word of complaint.
        const stack: string[] = [];
        for (const m of stripComments(anim.svgContent).matchAll(TAG)) {
          const [, close, name, , selfClose] = m;
          if (close) {
            expect(stack.pop(), `stray </${name}>`).toBe(name);
          } else if (!selfClose) {
            stack.push(name!);
          }
        }
        expect(stack, 'unclosed elements').toEqual([]);
      });

      it('uses kebab-case presentation attributes', () => {
        // Parsed as HTML, not JSX: `strokeWidth="2"` is an unknown attribute
        // the browser ignores, and the stroke renders at the default width.
        expect(anim.svgContent).not.toMatch(
          /\b(strokeWidth|strokeDasharray|strokeDashoffset|strokeLinecap|strokeLinejoin|strokeOpacity|fillOpacity|fillRule|clipRule|clipPath|fontSize|fontFamily|fontWeight|textAnchor|dominantBaseline|letterSpacing)=/,
        );
      });

      it('has at least one SMIL animation that loops', () => {
        expect(animates.length).toBeGreaterThan(0);
        for (const t of animates) {
          expect(t.attrs.dur, t.raw).toMatch(/^\d+(\.\d+)?s$/);
          expect(t.attrs.repeatCount, t.raw).toBe('indefinite');
          if (t.name !== 'animateMotion') expect(t.attrs.attributeName, t.raw).toBeTruthy();
        }
      });

      it('keeps keyTimes, values, keyPoints and keySplines in step', () => {
        for (const t of animates) {
          const { keyTimes, values, keyPoints, keySplines, calcMode } = t.attrs;
          if (keyTimes) {
            const kt = nums(keyTimes).map(Number);
            expect(kt[0], t.raw).toBe(0);
            expect(kt[kt.length - 1], t.raw).toBe(1);
            for (let i = 1; i < kt.length; i++) expect(kt[i]! >= kt[i - 1]!, t.raw).toBe(true);
            if (values) expect(nums(values).length, t.raw).toBe(kt.length);
            if (keyPoints) expect(nums(keyPoints).length, t.raw).toBe(kt.length);
            if (calcMode === 'spline') {
              expect(keySplines, t.raw).toBeTruthy();
              expect(nums(keySplines!).length, t.raw).toBe(kt.length - 1);
            }
          } else {
            expect(keySplines, `${t.raw}: keySplines need keyTimes`).toBeUndefined();
            expect(keyPoints, `${t.raw}: keyPoints need keyTimes`).toBeUndefined();
          }
          // animateMotion's default calcMode is "paced", under which keyPoints
          // are ignored — the dot then runs the whole path at its own pace,
          // out of step with whatever the keyPoints were timing it against.
          if (keyPoints) expect(calcMode, t.raw).toMatch(/^(linear|discrete|spline)$/);
        }
      });

      it('never animates a colour towards a CSS custom property', () => {
        // Chromium parses a SMIL colour values list as raw SVG colours;
        // `var(--x)` isn't one, so the whole animation silently no-ops. Static
        // fills may use var(); animated ones must be literals or currentColor.
        for (const t of animates) {
          if (!COLOUR_ATTRS.has(t.attrs.attributeName ?? '')) continue;
          expect(t.attrs.values ?? '', t.raw).not.toContain('var(');
          expect(t.attrs.to ?? '', t.raw).not.toContain('var(');
          expect(t.attrs.from ?? '', t.raw).not.toContain('var(');
        }
      });

      it('tags every word it draws, each with the catalogue entry it shows', () => {
        // Untagged text would stay English in every language. Numbers, units
        // and the sleeping mouse's "zz" are not words to translate.
        const untagged = [...stripComments(anim.svgContent).matchAll(/<text\b([^>]*)>([^<]*)/g)]
          .filter((m) => !m[1]!.includes('data-i18n'))
          .map((m) => m[2]!.trim())
          .filter((text) => !/^(\d[\d.,]*( k?Hz)?|zz)?$/.test(text));
        expect(untagged).toEqual([]);
        // The English written in the markup is what the preview page shows,
        // and has to be what the app shows in English too.
        for (const [key, text] of svgWords(anim.svgContent)) {
          expect(en[key as keyof typeof en], key).toBe(text);
        }
      });

      it('resolves every url(#id) reference locally', () => {
        const defined = new Set(all.map((t) => t.attrs.id).filter(Boolean));
        for (const ref of anim.svgContent.matchAll(/url\(#([^)]+)\)/g)) {
          expect(defined.has(ref[1]!), `url(#${ref[1]}) in ${anim.id}`).toBe(true);
        }
      });
    });
  }

  it('puts each tagged word in the language asked for, escaped', () => {
    const svg = '<text x="1" data-i18n="tipmedia.onScreen">on screen<animate /></text>';
    expect(localizeSvg(svg, () => 'à l’écran & <ici>')).toBe(
      '<text x="1" data-i18n="tipmedia.onScreen">à l’écran &amp; &lt;ici&gt;<animate /></text>',
    );
  });

  it('element ids are unique across every illustration', () => {
    // Pattern, gradient and clipPath ids are document-global: the preview page
    // renders every illustration at once, and two `#hatch`es there means one
    // of them paints with the other's pattern.
    const seen = new Map<string, string>();
    for (const anim of ANIMATIONS) {
      for (const t of tags(anim.svgContent)) {
        const id = t.attrs.id;
        if (!id) continue;
        expect(seen.get(id), `id "${id}" reused by ${anim.id}`).toBeUndefined();
        seen.set(id, anim.id);
      }
    }
  });
});
