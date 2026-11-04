import { describe, expect, it } from 'vitest';
import ts from 'typescript';
import { parse } from '../lib/ast';
import { IMPLEMENTED } from '../../src/web/hid/node-hid-webhid';

/**
 * The browser edition runs src/main/hid/transport.ts unchanged, over a WebHID
 * re-implementation of node-hid (src/web/hid/node-hid-webhid.ts, swapped in by
 * the `node-hid` alias in vite.web.config.ts). That holds only while
 * transport.ts uses nothing the shim lacks. A new `HID.x` or `dev.x()` would
 * still typecheck — the types are node-hid's — and then fail at runtime in the
 * browser alone, so the member list is pinned here.
 */

function nodeHidUsage(sf: ts.SourceFile): { module: Set<string>; handle: Set<string> } {
  const module = new Set<string>();
  const handle = new Set<string>();
  const isHid = (e: ts.Node): boolean => ts.isIdentifier(e) && e.text === 'HID';
  const isDevHandle = (e: ts.Expression): boolean =>
    (ts.isIdentifier(e) && e.text === 'dev') ||
    (ts.isPropertyAccessExpression(e) &&
      e.expression.kind === ts.SyntaxKind.ThisKeyword &&
      e.name.text === 'dev');

  const visit = (node: ts.Node): void => {
    if (ts.isPropertyAccessExpression(node) && isHid(node.expression)) {
      const parent = node.parent;
      module.add(
        ts.isPropertyAccessExpression(parent) && parent.expression === node
          ? `${node.name.text}.${parent.name.text}`
          : node.name.text,
      );
    }
    // `HID.HIDAsync` in a type position is a QualifiedName, not a property access.
    if (ts.isQualifiedName(node) && isHid(node.left)) module.add(node.right.text);
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      isDevHandle(node.expression.expression)
    ) {
      handle.add(node.expression.name.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return { module, handle };
}

const transport = parse('src/main/hid/transport.ts');

describe('the WebHID node-hid shim covers transport.ts', () => {
  const used = nodeHidUsage(transport);

  it('finds the calls it is meant to police', () => {
    // A walker that matched nothing would pass the subset checks vacuously.
    expect([...used.module]).toEqual(expect.arrayContaining(['devicesAsync', 'HIDAsync.open']));
    expect([...used.handle]).toEqual(expect.arrayContaining(['write', 'read']));
  });

  it('uses no node-hid module member the shim lacks', () => {
    const missing = [...used.module].filter(
      (m) => !(IMPLEMENTED.module as readonly string[]).includes(m),
    );
    expect(
      missing,
      `transport.ts uses HID.${missing.join(', HID.')}, which src/web/hid/node-hid-webhid.ts ` +
        'does not implement. Implement it there (and add it to IMPLEMENTED), or the browser ' +
        'edition breaks at runtime.',
    ).toEqual([]);
  });

  it('calls no handle method the shim lacks', () => {
    const missing = [...used.handle].filter(
      (m) => !(IMPLEMENTED.handle as readonly string[]).includes(m),
    );
    expect(
      missing,
      `transport.ts calls dev.${missing.join('(), dev.')}() on a node-hid handle, which ` +
        'WebHidHandle does not implement.',
    ).toEqual([]);
  });

  it('never relies on Buffer — the shim hands back plain Uint8Arrays', () => {
    const buffers: number[] = [];
    const visit = (node: ts.Node): void => {
      if (ts.isIdentifier(node) && node.text === 'Buffer') {
        buffers.push(transport.getLineAndCharacterOfPosition(node.getStart()).line + 1);
      }
      ts.forEachChild(node, visit);
    };
    visit(transport);
    expect(buffers, `Buffer used at transport.ts:${buffers.join(', :')}`).toEqual([]);
  });
});
