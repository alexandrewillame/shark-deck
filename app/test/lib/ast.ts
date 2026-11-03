import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ts from 'typescript';

/**
 * Small TypeScript-AST helpers shared by the contract tests.
 *
 * These read source as *text* rather than importing it, which is the whole
 * point: the wiring being checked (an interface, a hand-written object literal,
 * a BrowserWindow option bag) either cannot be imported in a test process at
 * all, or exists only as a type and is erased at runtime.
 *
 * `typescript` is already a devDependency; parsing a 260-line file costs ~20ms.
 */

/** Repo path of the `app/` directory, so every caller can use app-relative paths. */
export const APP_ROOT = resolve(__dirname, '../..');

export function parse(appRelativePath: string): ts.SourceFile {
  const path = resolve(APP_ROOT, appRelativePath);
  return ts.createSourceFile(
    path,
    readFileSync(path, 'utf8'),
    ts.ScriptTarget.ES2022,
    /* setParentNodes */ true,
  );
}

export interface Member {
  name: string;
  /** Rendered return type, e.g. `Promise<WriteResult>`. */
  returnType: string;
  /** Leading comment block, if any. */
  jsDoc: string;
}

/** Method and property signatures of one interface declaration. */
export function interfaceMembers(sf: ts.SourceFile, ifaceName: string): Member[] {
  const out: Member[] = [];
  sf.forEachChild((n) => {
    if (!ts.isInterfaceDeclaration(n) || n.name.text !== ifaceName) return;
    for (const m of n.members) {
      if (!ts.isMethodSignature(m) && !ts.isPropertySignature(m)) continue;
      if (!m.name || !ts.isIdentifier(m.name)) continue;
      out.push({
        name: m.name.text,
        returnType: m.type?.getText(sf) ?? '',
        jsDoc: leadingText(sf, m),
      });
    }
  });
  return out;
}

export interface Prop {
  name: string;
  /** Full source text of the property, including its value. */
  text: string;
}

/**
 * Properties of a `const <name> = { … }` object literal, unwrapping any
 * `as X` / `satisfies X` around the initializer.
 */
export function objectProps(sf: ts.SourceFile, constName: string): Prop[] {
  let lit: ts.ObjectLiteralExpression | undefined;
  const visit = (n: ts.Node): void => {
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.name.text === constName) {
      let init = n.initializer;
      while (init && (ts.isAsExpression(init) || ts.isSatisfiesExpression(init))) {
        init = init.expression;
      }
      if (init && ts.isObjectLiteralExpression(init)) lit = init;
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  if (!lit) return [];

  return lit.properties.flatMap((p) => {
    if (!ts.isPropertyAssignment(p) && !ts.isMethodDeclaration(p)) return [];
    const key = p.name;
    const name = ts.isIdentifier(key) || ts.isStringLiteral(key) ? key.text : null;
    return name ? [{ name, text: p.getText(sf) }] : [];
  });
}

/** Every `new <ctorName>(…)` expression in the file, with its first argument. */
export function newExpressions(
  sf: ts.SourceFile,
  ctorName: string,
): { node: ts.NewExpression; firstArg?: ts.ObjectLiteralExpression }[] {
  const out: { node: ts.NewExpression; firstArg?: ts.ObjectLiteralExpression }[] = [];
  const visit = (n: ts.Node): void => {
    if (ts.isNewExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === ctorName) {
      const a = n.arguments?.[0];
      out.push({ node: n, firstArg: a && ts.isObjectLiteralExpression(a) ? a : undefined });
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

/**
 * Reads a property off an object literal, following one level of nesting.
 * Returns the AST node so a caller can insist on a real boolean *literal*
 * rather than accepting any truthy-looking text.
 */
export function propValue(
  obj: ts.ObjectLiteralExpression,
  name: string,
): ts.Expression | undefined {
  for (const p of obj.properties) {
    if (!ts.isPropertyAssignment(p)) continue;
    const key = p.name;
    const k = ts.isIdentifier(key) || ts.isStringLiteral(key) ? key.text : null;
    if (k === name) return p.initializer;
  }
  return undefined;
}

export function isBooleanLiteral(e: ts.Expression | undefined, want: boolean): boolean {
  if (!e) return false;
  return want ? e.kind === ts.SyntaxKind.TrueKeyword : e.kind === ts.SyntaxKind.FalseKeyword;
}

/** Exported `const NAME = …` declarations whose name is SCREAMING_SNAKE_CASE. */
export function exportedScreamingConsts(sf: ts.SourceFile): { name: string; jsDoc: string }[] {
  const out: { name: string; jsDoc: string }[] = [];
  sf.forEachChild((n) => {
    if (!ts.isVariableStatement(n)) return;
    const exported = n.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
    if (!exported) return;
    for (const d of n.declarationList.declarations) {
      if (!ts.isIdentifier(d.name)) continue;
      if (!/^[A-Z][A-Z0-9_]*$/.test(d.name.text)) continue;
      out.push({ name: d.name.text, jsDoc: leadingText(sf, n) });
    }
  });
  return out;
}

function leadingText(sf: ts.SourceFile, n: ts.Node): string {
  const full = sf.getFullText();
  const ranges = ts.getLeadingCommentRanges(full, n.getFullStart()) ?? [];
  return ranges.map((r) => full.slice(r.pos, r.end)).join('\n');
}
