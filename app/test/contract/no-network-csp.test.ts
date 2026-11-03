import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { hardenCsp } from '../../build/csp';
import { APP_ROOT } from '../lib/ast';

/**
 * CLAUDE.md invariant: no network. Strict CSP, a `will-navigate` block, and a
 * `setWindowOpenHandler` deny. Model names and art are bundled, never fetched.
 *
 * Two halves:
 *  - the CSP that ships, including proof that the production hardening step
 *    still fires. `hardenProdCsp` is `apply: 'build'`, so a dev run never
 *    executes it; if a directive were renamed or reordered so `connect-src`
 *    stopped matching, the replace would quietly become a no-op and a
 *    localhost-permitting CSP would ship. Nothing noticed that before.
 *  - that no source file reaches for the network in the first place.
 */

const RENDERER = resolve(APP_ROOT, 'src/renderer');

function htmlFiles(): string[] {
  return readdirSync(RENDERER)
    .filter((f) => f.endsWith('.html'))
    .map((f) => join(RENDERER, f));
}

function tsFilesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...tsFilesUnder(p));
    else if (/\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name)) out.push(p);
  }
  return out;
}

/** `content` of the CSP meta, parsed into directive -> value list. */
function cspOf(html: string): Map<string, string[]> {
  const meta = /http-equiv="Content-Security-Policy"\s*\n?\s*content="([^"]+)"/.exec(html);
  const map = new Map<string, string[]>();
  if (!meta) return map;
  for (const part of meta[1].split(';')) {
    const [name, ...values] = part.trim().split(/\s+/);
    if (name) map.set(name, values);
  }
  return map;
}

const pages = htmlFiles().map((abs) => ({
  name: abs.split(sep).pop()!,
  text: readFileSync(abs, 'utf8'),
}));

describe('renderer CSP', () => {
  it('found every renderer page', () => {
    // Non-vacuity: a page added later is covered automatically, but an empty
    // list here would make everything below pass while checking nothing.
    expect(pages.map((p) => p.name).sort()).toEqual(['crash.html', 'index.html', 'overlay.html']);
  });

  it.each(['index.html', 'crash.html', 'overlay.html'])('%s declares a strict CSP', (name) => {
    const page = pages.find((p) => p.name === name)!;
    const csp = cspOf(page.text);

    expect(csp.size, `${name}: no Content-Security-Policy meta found`).toBeGreaterThan(2);
    expect(csp.get('base-uri'), `${name}: base-uri must be 'none'`).toEqual(["'none'"]);

    const all = [...csp.values()].flat().join(' ');
    expect(all, `${name}: 'unsafe-eval' must never appear`).not.toContain('unsafe-eval');

    // No remote origins anywhere. `data:`/`blob:` are fine (bundled art).
    expect(all, `${name}: no http(s) origin may appear in any directive`).not.toMatch(
      /https?:\/\/(?!localhost)/,
    );
  });

  it('confines the dev localhost allowance to connect-src', () => {
    // Only index.html has HMR to accommodate. If `localhost` ever leaks into
    // script-src or default-src, that is the regression that matters.
    for (const page of pages) {
      const csp = cspOf(page.text);
      for (const [directive, values] of csp) {
        if (directive === 'connect-src') continue;
        expect(
          values.join(' '),
          `${page.name}: localhost must not appear in ${directive}`,
        ).not.toContain('localhost');
      }
    }
  });

  it('actually rewrites index.html for production', () => {
    const dev = pages.find((p) => p.name === 'index.html')!.text;
    const prod = hardenCsp(dev);

    // The point of the whole test: prove the substitution fired. A stale regex
    // would return the input unchanged and ship the dev CSP.
    expect(prod, 'hardenCsp() made no change -- the connect-src regex no longer matches').not.toBe(
      dev,
    );

    const csp = cspOf(prod);
    expect(csp.get('connect-src')).toEqual(["'self'"]);
    expect(csp.get('form-action'), 'production must deny form submissions').toEqual(["'none'"]);
    expect(prod, 'no localhost may survive into the production CSP').not.toContain('localhost');
  });

  it('leaves the two default-src none pages already locked down', () => {
    // hardenCsp is a no-op on these (they have no connect-src to rewrite), so
    // they have to carry form-action themselves.
    for (const name of ['crash.html', 'overlay.html']) {
      const csp = cspOf(pages.find((p) => p.name === name)!.text);
      expect(csp.get('default-src'), `${name}: expected default-src 'none'`).toEqual(["'none'"]);
      expect(csp.get('form-action'), `${name}: must declare form-action itself`).toEqual([
        "'none'",
      ]);
    }
  });
});

describe('no source file reaches the network', () => {
  const files = [...tsFilesUnder(resolve(APP_ROOT, 'src'))];

  it('scanned a plausible number of files', () => {
    expect(files.length, 'source scan found almost nothing').toBeGreaterThan(100);
  });

  it('contains no HTTP client usage', () => {
    const banned = [
      /\bfetch\s*\(/,
      /\bXMLHttpRequest\b/,
      /\bWebSocket\b/,
      /from ['"]node:https?['"]/,
      /require\(['"]node:https?['"]\)/,
      /from ['"]axios['"]/,
      /\bnet\.request\b/,
    ];
    const hits: string[] = [];
    for (const abs of files) {
      const text = readFileSync(abs, 'utf8');
      for (const re of banned) {
        if (re.test(text)) {
          hits.push(`${relative(APP_ROOT, abs).split(sep).join('/')}: ${re.source}`);
        }
      }
    }
    expect(hits, `network usage found: ${hits.join('; ')}`).toEqual([]);
  });

  it('keeps shell.openExternal behind an http(s) guard, in known places only', () => {
    const callers = files
      .filter((abs) => /shell\.openExternal\s*\(/.test(readFileSync(abs, 'utf8')))
      .map((abs) => relative(APP_ROOT, abs).split(sep).join('/'))
      .sort();

    // Opening a URL in the user's own browser is the one outward action the
    // app takes. Both sites guard on ^https?:// so a file:// or custom-scheme
    // URL cannot be handed to the OS.
    expect(callers).toEqual(['src/main/index.ts', 'src/main/platform/shared.ts']);
    for (const rel of callers) {
      const text = readFileSync(resolve(APP_ROOT, rel), 'utf8');
      expect(text, `${rel}: openExternal must be guarded by an ^https?:// test`).toMatch(
        /\^https\?:/,
      );
    }
  });
});
