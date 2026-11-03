import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * The sub-view selector has to stay on screen while the pane scrolls.
 *
 * Base/Fn, Keys/Test and the lighting zones ARE the pane's heading, so they
 * scrolled away with it — two screens into the Actuation tab there was no way
 * to tell which sub-view you were in, or to leave it, without scrolling back
 * up. (The profile bar above never needed this: it is rendered outside the
 * scrollport entirely.)
 *
 * Asserted against the stylesheet, because jsdom loads no CSS and would report
 * `static` for everything. What makes this worth pinning rather than trusting
 * is the second half: `position: sticky` binds to the nearest ancestor that
 * DECLARES a scroll mechanism, not the one that is actually scrolling. `.pane`
 * deliberately declares none — config-shell.css carries a long comment about a
 * stray `overflow-y: auto` there having already broken the hero art's sticky
 * once, in exactly this way. Add one back and these headings quietly stop
 * sticking, with nothing else to show for it.
 */
const read = (f: string) => readFileSync(resolve(__dirname, '../styles', f), 'utf8');

/** The declaration block following a selector, by plain text search. */
function bodyOf(css: string, selector: string): string {
  const at = css.indexOf(selector);
  if (at === -1) return '';
  const open = css.indexOf('{', at);
  const close = css.indexOf('}', open);
  return open === -1 || close === -1 ? '' : css.slice(open, close);
}

describe('the pane heading sticks to the top of the scrollport', () => {
  const panes = read('panes.css');

  it('is sticky at the top, in both the shapes a TitleTabs appears in', () => {
    // `.pane-head` wraps it in a PaneHeader; a HeroPane puts it straight under
    // `.pane` with no wrapper.
    const body = bodyOf(panes, '.pane-head:has(.title-tabs),\n.pane > .title-tabs');
    expect(body, 'the sticky rule moved or lost one of its two selectors').not.toBe('');
    expect(body).toContain('position: sticky');
    expect(body).toMatch(/top:\s*0/);
  });

  it('is opaque, so content does not scroll through it', () => {
    const body = bodyOf(panes, '.pane-head:has(.title-tabs),\n.pane > .title-tabs');
    expect(body).toMatch(/background:\s*var\(--bg\)/);
    expect(body).toMatch(/z-index:\s*[1-9]/);
  });

  it('leaves .pane declaring no scroll mechanism of its own', () => {
    // The trap. Sticky binds to the nearest ancestor that declares one, so an
    // `overflow` here would bind these headings to a box that never scrolls,
    // and they would sit at their normal flow position and scroll away.
    const body = bodyOf(read('config-shell.css'), '\n.pane {');
    expect(body, 'expected the .pane rule to still be there').not.toBe('');
    expect(body).not.toMatch(/overflow/);
  });
});
