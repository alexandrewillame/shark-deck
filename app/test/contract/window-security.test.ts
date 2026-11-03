import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { APP_ROOT, isBooleanLiteral, newExpressions, parse, propValue } from '../lib/ast';

/**
 * CLAUDE.md invariant: the renderer stays sandboxed --
 * `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true` -- and
 * every window denies navigation and popups.
 *
 * This is the app's security boundary, so a *false pass* is the worst outcome
 * in the whole contract suite. That is why it reads the AST and insists on real
 * boolean literals rather than grepping: a regex for `sandbox: true` is happily
 * satisfied by a commented-out line, and a regex for `nodeIntegration: false`
 * misses `nodeIntegration: !1` or a value threaded through a variable.
 *
 * Scanned by directory walk, so a fourth window file is covered the day it is
 * added rather than the day someone remembers to list it here.
 */

const MAIN_DIR = resolve(APP_ROOT, 'src/main');

function tsFilesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...tsFilesUnder(p));
    else if (e.name.endsWith('.ts') && !e.name.endsWith('.test.ts')) out.push(p);
  }
  return out;
}

const files = tsFilesUnder(MAIN_DIR);

interface Site {
  file: string;
  prefs?: ReturnType<typeof propValue>;
  hasPrefsObject: boolean;
  source: string;
}

const sites: Site[] = [];
for (const abs of files) {
  const rel = relative(APP_ROOT, abs).split(sep).join('/');
  const source = readFileSync(abs, 'utf8');
  if (!source.includes('new BrowserWindow')) continue;
  const sf = parse(rel);
  for (const { firstArg } of newExpressions(sf, 'BrowserWindow')) {
    const prefsNode = firstArg ? propValue(firstArg, 'webPreferences') : undefined;
    sites.push({
      file: rel,
      prefs: prefsNode,
      hasPrefsObject: !!prefsNode && prefsNode.kind !== undefined,
      source,
    });
  }
}

describe('every BrowserWindow stays sandboxed', () => {
  it('found the window construction sites', () => {
    // Non-vacuity. If this drops to 0 -- a rename, a factory wrapper, a moved
    // file -- every assertion below would pass while checking nothing.
    expect(
      sites.length,
      `found no "new BrowserWindow" sites under src/main (scanned ${files.length} files)`,
    ).toBeGreaterThanOrEqual(3);
  });

  it.each([
    ['contextIsolation', true],
    ['nodeIntegration', false],
    ['sandbox', true],
  ] as const)('sets %s to %s at every site', (flag, want) => {
    const bad: string[] = [];
    for (const s of sites) {
      const prefs = s.prefs;
      if (!prefs || !('properties' in prefs)) {
        bad.push(`${s.file}: no webPreferences object literal`);
        continue;
      }
      const value = propValue(prefs as never, flag);
      if (!isBooleanLiteral(value, want)) {
        bad.push(`${s.file}: ${flag} is ${value ? value.getText() : 'absent'}, expected ${want}`);
      }
    }
    expect(bad, bad.join('; ')).toEqual([]);
  });

  it('gives every window a preload script', () => {
    const bad = sites
      .filter((s) => {
        const prefs = s.prefs;
        if (!prefs || !('properties' in prefs)) return true;
        return !propValue(prefs as never, 'preload');
      })
      .map((s) => s.file);
    expect(bad, `windows with no preload: ${bad.join(', ')}`).toEqual([]);
  });

  it('denies popups and navigation in every file that opens a window', () => {
    const missing: string[] = [];
    for (const file of new Set(sites.map((s) => s.file))) {
      const src = sites.find((s) => s.file === file)!.source;
      if (!src.includes('setWindowOpenHandler')) missing.push(`${file}: no setWindowOpenHandler`);
      if (!src.includes("'will-navigate'")) missing.push(`${file}: no will-navigate handler`);
    }
    expect(missing, missing.join('; ')).toEqual([]);
  });
});
