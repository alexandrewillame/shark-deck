import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The browser edition's page, as served. Browsers and extensions with a
 * "dark mode for every site" repainted it on top of the app's own themes —
 * the opt-outs that stop them are two tags in the head, pinned here so an
 * edit to the page cannot drop them quietly.
 */
const html = readFileSync(resolve(__dirname, 'index.html'), 'utf8').replace(/<!--[\s\S]*?-->/g, '');
const head = /<head>([\s\S]*?)<\/head>/.exec(html)?.[1] ?? '';

describe('the page keeps its own look', () => {
  it("turns off the browsers' forced dark mode", () => {
    // `only` forbids the browser from overriding the scheme; with `light` it
    // leaves native controls exactly as an undeclared page gets them.
    expect(head).toMatch(/<meta\s+name="color-scheme"\s+content="only light"\s*\/?>/);
  });

  it('tells Dark Reader to stay off', () => {
    // Dark Reader checks for this tag and removes its theme where it is found.
    expect(head).toMatch(/<meta\s+name="darkreader-lock"\s*\/?>/);
  });
});
