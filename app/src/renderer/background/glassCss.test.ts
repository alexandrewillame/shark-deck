import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * The frosted surfaces over the app background, asserted against the
 * stylesheet itself (jsdom loads no CSS).
 *
 * What is pinned is what would fail quietly: a frosted rule escaping its
 * `data-bg` scope changes the plain theme for everyone; the layer losing the
 * last word in the cascade, or `.app` losing its stacking context, leaves a
 * background that never shows; a keyboard board or a dialog turned
 * see-through is a readability bug nobody asked for.
 */
const read = (f: string) => readFileSync(resolve(__dirname, '..', f), 'utf8');
const css = read('styles/background.css').replace(/\/\*[\s\S]*?\*\//g, '');

/** Every rule as [selector, body]. Flat: this file has no nested blocks but
 *  @keyframes and one @media, which are handled by skipping their wrappers. */
function rules(src: string): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  for (let m = re.exec(src); m; m = re.exec(src)) out.push([m[1]!.trim(), m[2]!]);
  return out;
}

describe('the frosted surfaces', () => {
  it('only exist while a background is on', () => {
    for (const [sel, body] of rules(css)) {
      if (!/backdrop-filter|color-mix\(|--glass/.test(body)) continue;
      expect(sel, `${sel} frosts a surface outside :root[data-bg]`).toMatch(/:root\[data-bg\]/);
    }
  });

  it('frost the sticky sub-tab bars too, rather than leaving solid stripes', () => {
    const hit = rules(css).find(
      ([sel, body]) =>
        sel.includes('.pane-head:has(.title-tabs)') && body.includes('backdrop-filter'),
    );
    expect(hit, 'no frosted rule for the sticky sub-tab bars').toBeTruthy();
    expect(hit![1]).toMatch(/color-mix\(in srgb, var\(--bg\) var\(--glass-head-a\), transparent\)/);
  });

  it('leave the keyboard boards, dialogs, menus, tooltips and toasts opaque', () => {
    for (const cls of [
      '.kbmap',
      '.kbkey',
      '.modal',
      '.tt',
      '.toast',
      '.listbox-select-list',
      '.lang-menu-list',
    ]) {
      expect(css.includes(cls), `${cls} is made translucent`).toBe(false);
    }
  });

  it('give way to a panel fading in, which would blank the blur', () => {
    // An ancestor below full opacity cuts off what backdrop-filter sees.
    const frames = [
      ...css.matchAll(/@keyframes\s+(tabInGlass|tabPaneInGlass)\s*\{([\s\S]*?)\}\s*\}/g),
    ];
    expect(frames).toHaveLength(2);
    for (const f of frames) expect(f[2]).not.toMatch(/opacity/);
  });
});

describe('the layer', () => {
  it('has the last word in the cascade', () => {
    const imports = [...read('styles.css').matchAll(/@import '([^']+)'/g)].map((m) => m[1]);
    expect(imports.at(-1)).toBe('./styles/background.css');
  });

  it('sits in .app’s own stacking context, under everything in it', () => {
    const app = /\.app \{([^}]*)\}/.exec(read('styles/layout.css'))?.[1] ?? '';
    expect(app).toMatch(/isolation:\s*isolate/);
    const layer = /\.bg-layer \{([^}]*)\}/.exec(css)?.[1] ?? '';
    expect(layer).toMatch(/position:\s*fixed/);
    expect(layer).toMatch(/z-index:\s*-1/);
    expect(layer).toMatch(/pointer-events:\s*none/);
  });
});
