import { describe, expect, it } from 'vitest';
import ts from 'typescript';
import { interfaceMembers, parse } from '../lib/ast';

/**
 * The browser edition's `window.sharkdeck` (src/web/host/bridge.ts) counts
 * device writes in flight, so the page can warn before its tab closes in the
 * middle of one. The list it counts is hand-written; this pins it to the
 * `Api`, the same way ipc-guarded-write.test.ts derives "mutating": every
 * method returning a `WriteResult` must be on it. (Completeness of the
 * browser's handler table itself is checked there, alongside the desktop's.)
 */

const api = interfaceMembers(parse('src/shared/ipc.ts'), 'Api');
const MUTATING = api
  .filter((m) => /^Promise<WriteResult(\[\])?>$/.test(m.returnType))
  .map((m) => m.name);

/** The string literals of `DEVICE_WRITES = new Set([...])` in bridge.ts. */
function deviceWrites(): string[] {
  const sf = parse('src/web/host/bridge.ts');
  let names: string[] = [];
  const visit = (n: ts.Node): void => {
    if (
      ts.isVariableDeclaration(n) &&
      ts.isIdentifier(n.name) &&
      n.name.text === 'DEVICE_WRITES' &&
      n.initializer &&
      ts.isNewExpression(n.initializer)
    ) {
      const arr = n.initializer.arguments?.[0];
      if (arr && ts.isArrayLiteralExpression(arr)) {
        names = arr.elements.filter(ts.isStringLiteral).map((e) => e.text);
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return names;
}

describe('the browser bridge knows every device write', () => {
  const listed = deviceWrites();

  it('parsed the list', () => {
    expect(listed.length, 'DEVICE_WRITES not found in src/web/host/bridge.ts').toBeGreaterThan(25);
    expect(MUTATING.length).toBeGreaterThan(25);
  });

  it('lists every Api method that returns a WriteResult', () => {
    const missing = MUTATING.filter((m) => !listed.includes(m));
    expect(
      missing,
      `add to DEVICE_WRITES in src/web/host/bridge.ts: ${missing.join(', ')} — otherwise ` +
        'closing the tab during one of them gives no warning',
    ).toEqual([]);
  });

  it('lists only real Api methods', () => {
    const names = new Set(api.map((m) => m.name));
    const unknown = listed.filter((m) => !names.has(m));
    expect(unknown, `not Api methods: ${unknown.join(', ')}`).toEqual([]);
  });
});
