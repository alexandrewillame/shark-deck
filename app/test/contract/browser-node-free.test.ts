import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { dirname, relative, resolve } from 'node:path';
import ts from 'typescript';
import { APP_ROOT } from '../lib/ast';

/**
 * The browser edition (src/web/) bundles the device layer that runs in
 * Electron's main process on the desktop. Every module src/web/main.ts can
 * reach therefore has to run in a browser: no Node built-in, no Electron, and
 * none of the globals Node has and a page does not (`process`, `Buffer`,
 * `require`, `__dirname`).
 *
 * vite.web.config.ts refuses those imports at build time as well, but a build
 * is not part of `npm run check`. This walks the same import graph — with the
 * same aliases, `node-hid` swapped for the WebHID shim — in about a second, so
 * a stray `import … from 'node:fs'` in, say, the device manager fails here
 * rather than as a blank page on GitHub Pages.
 */

const ENTRY = 'src/web/main.ts';

/** Mirrors `resolve.alias` in vite.web.config.ts — pinned below. */
const ALIASES: Record<string, string> = {
  'node-hid': 'src/web/hid/node-hid-webhid.ts',
  '@shared': 'src/shared',
  '@': 'src/renderer',
};

const BANNED = new Set([...builtinModules, 'electron']);

/** Globals Node has and a page does not, as `name -> allowed member chains`. */
const NODE_GLOBALS = ['Buffer', 'require', '__dirname', '__filename'];

const rel = (abs: string) => relative(APP_ROOT, abs).replace(/\\/g, '/');

function resolveFile(base: string): string | null {
  for (const candidate of [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    `${base}/index.ts`,
    `${base}/index.tsx`,
  ]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return null;
}

type Target = { banned: string } | { file: string } | { external: true };

function target(spec: string, from: string): Target {
  if (spec.startsWith('node:') || BANNED.has(spec) || BANNED.has(spec.split('/')[0]!)) {
    return { banned: spec };
  }
  for (const [alias, to] of Object.entries(ALIASES)) {
    if (spec === alias || spec.startsWith(`${alias}/`)) {
      const file = resolveFile(resolve(APP_ROOT, to + spec.slice(alias.length)));
      return file ? { file } : { external: true };
    }
  }
  if (spec.startsWith('.')) {
    const file = resolveFile(resolve(dirname(from), spec));
    return file ? { file } : { external: true };
  }
  return { external: true }; // an npm package, bundled by Vite
}

function walk(entry: string): { reached: string[]; problems: string[] } {
  const seen = new Set<string>();
  const queue = [resolve(APP_ROOT, entry)];
  const problems: string[] = [];

  while (queue.length) {
    const file = queue.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    const sf = ts.createSourceFile(
      file,
      readFileSync(file, 'utf8'),
      ts.ScriptTarget.ES2022,
      true,
      file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    );
    const where = (n: ts.Node) =>
      `${rel(file)}:${sf.getLineAndCharacterOfPosition(n.getStart()).line + 1}`;

    const visit = (n: ts.Node): void => {
      let spec: string | undefined;
      if (ts.isImportDeclaration(n) && !n.importClause?.isTypeOnly) {
        spec = (n.moduleSpecifier as ts.StringLiteral).text;
      } else if (ts.isExportDeclaration(n) && !n.isTypeOnly && n.moduleSpecifier) {
        spec = (n.moduleSpecifier as ts.StringLiteral).text;
      } else if (
        ts.isCallExpression(n) &&
        n.expression.kind === ts.SyntaxKind.ImportKeyword &&
        n.arguments[0] &&
        ts.isStringLiteral(n.arguments[0])
      ) {
        spec = n.arguments[0].text;
      }
      if (spec !== undefined) {
        const t = target(spec, file);
        if ('banned' in t) problems.push(`${where(n)} imports "${t.banned}"`);
        else if ('file' in t && /\.tsx?$/.test(t.file) && !t.file.endsWith('.d.ts')) {
          queue.push(t.file);
        }
      }

      // `process.env.NODE_ENV` is the one exception: Vite defines it.
      if (
        ts.isPropertyAccessExpression(n) &&
        ts.isIdentifier(n.expression) &&
        n.expression.text === 'process'
      ) {
        const parent = n.parent;
        const nodeEnv =
          n.name.text === 'env' &&
          ts.isPropertyAccessExpression(parent) &&
          parent.name.text === 'NODE_ENV';
        if (!nodeEnv) problems.push(`${where(n)} uses process.${n.name.text}`);
      }
      if (
        ts.isIdentifier(n) &&
        NODE_GLOBALS.includes(n.text) &&
        !ts.isTypeReferenceNode(n.parent) &&
        !ts.isPropertyAccessExpression(n.parent) // `x.require` is someone's member, not the global
      ) {
        problems.push(`${where(n)} uses ${n.text}`);
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
  }
  return { reached: [...seen].map(rel), problems };
}

describe('the browser edition reaches no Node or Electron code', () => {
  const { reached, problems } = walk(ENTRY);

  it('walks the whole app, device layer included', () => {
    // Non-vacuity: a walker that stopped at the entry would pass everything.
    expect(reached.length).toBeGreaterThan(150);
    expect(reached).toEqual(
      expect.arrayContaining([
        'src/web/hid/node-hid-webhid.ts',
        'src/main/hid/transport.ts',
        'src/main/devices/manager.ts',
        'src/main/devices/drivers/compx-he-keyboard.ts',
        'src/main/handlers.ts',
        'src/main/store.ts',
        'src/main/settings.ts',
        'src/renderer/main.tsx',
        'src/renderer/App.tsx',
      ]),
    );
  });

  it('never reaches the desktop-only modules', () => {
    for (const desktop of [
      'src/main/ipc.ts',
      'src/main/index.ts',
      'src/main/store-fs.ts',
      'src/main/profiles/switcher.ts',
      'src/main/platform/index.ts',
    ]) {
      expect(reached, `${desktop} is reachable from ${ENTRY}`).not.toContain(desktop);
    }
  });

  it('imports no Node built-in or Electron, and uses no Node-only global', () => {
    expect(
      problems,
      `Node-only code reachable from ${ENTRY} (the browser edition would break at load):\n  ` +
        problems.join('\n  '),
    ).toEqual([]);
  });

  it('uses the same aliases as vite.web.config.ts', () => {
    const config = readFileSync(resolve(APP_ROOT, 'vite.web.config.ts'), 'utf8');
    for (const [alias, to] of Object.entries(ALIASES)) {
      expect(config, `vite.web.config.ts no longer aliases ${alias} to ${to}`).toContain(
        `'${alias}': resolve(__dirname, '${to}')`,
      );
    }
  });
});
