import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { BUNDLED_TREES, REPO_ROOT, backendSourceFiles } from '../../__mocks__/source-tree';

/**
 * pi's run state is read only through `pi-session/run-lifecycle.ts` (docs/invariants.md, "pi's run lifecycle"). This guard
 * is syntactic: it flags every read of a property named `isStreaming` or `isIdle` and every reference to `waitForIdle`,
 * on any receiver, direct, optional-chained, by string key, destructured in a declaration or in an assignment, in the
 * source esbuild bundles into the extension and desktop hosts, where pi sessions live. src/webview is out: it holds no pi
 * session and its view models have `isStreaming` fields of their own. A call such as the MCP server manager's
 * `isIdle(name, timeoutMs)` is not a read of pi's getters and passes. Its limits: a same-named getter on a non-pi object is
 * flagged too, and a read through a computed key held in a variable (`session[key]`), through `Reflect.get`, or by
 * destructuring the target of a `for...of` is missed.
 */

const MODULE = 'src/core/pi-session/run-lifecycle.ts';
const GETTERS = new Set(['isStreaming', 'isIdle']);
const WAIT = 'waitForIdle';

const flagged = (name: string, called: boolean): boolean => name === WAIT || (GETTERS.has(name) && !called);

const isCallee = (node: ts.Node): boolean => ts.isCallExpression(node.parent) && node.parent.expression === node;

/** Each read of pi's run state in `source`, as `<line>: <text>`. */
function runStateReads(source: string): string[] {
  const file = ts.createSourceFile('source.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const found: string[] = [];
  const report = (node: ts.Node): void => {
    const line = file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1;
    found.push(`${line}: ${node.getText(file).replace(/\s+/g, ' ')}`);
  };
  const visit = (node: ts.Node): void => {
    if (ts.isPropertyAccessExpression(node) && flagged(node.name.text, isCallee(node))) report(node);
    else if (ts.isElementAccessExpression(node) && ts.isStringLiteralLike(node.argumentExpression) && flagged(node.argumentExpression.text, isCallee(node))) report(node);
    else if (ts.isBindingElement(node) && ts.isObjectBindingPattern(node.parent)) {
      const key = node.propertyName ?? node.name;
      if ((ts.isIdentifier(key) || ts.isStringLiteralLike(key)) && flagged(key.text, false)) report(node);
    } else if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isObjectLiteralExpression(node.left)) {
      for (const property of node.left.properties) {
        const key = ts.isShorthandPropertyAssignment(property) || ts.isPropertyAssignment(property) ? property.name : undefined;
        if (key && (ts.isIdentifier(key) || ts.isStringLiteralLike(key)) && flagged(key.text, false)) report(property);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
}

const CAUGHT: readonly { readonly name: string; readonly source: string }[] = [
  { name: 'a direct read', source: 'if (session.isStreaming) return;' },
  { name: 'a read through a longer receiver', source: 'const busy = this.runtime.session.isIdle;' },
  { name: 'an optional-chained read', source: 'if (this.runtime?.session?.isStreaming) return;' },
  { name: "the agent loop's flag", source: 'const looping = session.agent.state.isStreaming;' },
  { name: 'a read by string key', source: "const busy = session['isStreaming'];" },
  { name: 'a destructured read', source: 'const { isStreaming } = session;' },
  { name: 'a renamed destructured read', source: 'const { isIdle: idle } = session;' },
  { name: 'a parameter destructured in place', source: 'const f = ({ isStreaming }: AgentSession): boolean => isStreaming;' },
  { name: 'a waitForIdle call', source: 'await session.waitForIdle();' },
  { name: 'an optional-chained waitForIdle call', source: 'await this.runtime?.session.waitForIdle();' },
  { name: 'a waitForIdle reference', source: 'const wait = session.waitForIdle.bind(session);' },
  { name: 'a destructured waitForIdle', source: 'const { waitForIdle } = session;' },
  { name: 'a destructuring assignment', source: 'let isStreaming = false;\n({ isStreaming } = session);' },
  { name: 'a renamed destructuring assignment', source: 'let idle = false;\n({ isIdle: idle } = session);' },
];

const IGNORED: readonly { readonly name: string; readonly source: string }[] = [
  { name: 'a comment', source: '// pi turns session.isStreaming false and waitForIdle() returns at once\n/* session.isIdle */\nconst a = 1;' },
  { name: 'a string', source: "log('isStreaming is false, waitForIdle returned');" },
  { name: 'an object literal key', source: 'const shape = { isStreaming: true, isIdle: false };' },
  { name: 'an object literal assigned to a variable', source: 'let shape;\nshape = { isStreaming: true };' },
  { name: 'an interface member', source: 'interface Aside { isStreaming: boolean; isIdle(): boolean; waitForIdle?: never }' },
  { name: 'a local of the same name', source: 'const isStreaming = false;\nlet isIdle = isStreaming;' },
  { name: "the MCP manager's isIdle method call", source: 'if (timeout > 0 && this.manager.isIdle(name, timeout)) close();' },
  { name: 'a method declaration', source: 'class Manager { isIdle(name: string, timeoutMs: number): boolean { return name.length > timeoutMs; } }' },
];

describe("pi's run state is read only through the run lifecycle module", () => {
  it('finds no read of isStreaming, isIdle or waitForIdle in bundled host source outside run-lifecycle.ts', () => {
    const files = backendSourceFiles(REPO_ROOT, BUNDLED_TREES).filter((file) => file.rel !== MODULE && !file.rel.endsWith('.test.ts') && !file.rel.endsWith('.d.ts'));
    const offenders = files.flatMap((file) => runStateReads(readFileSync(file.path, 'utf8')).map((hit) => `${file.rel}:${hit}`));
    expect(offenders).toEqual([]);
  });

  it('exempts the module itself, which holds the reads', () => {
    expect(runStateReads(readFileSync(join(REPO_ROOT, MODULE), 'utf8')).length).toBeGreaterThan(0);
  });

  it.each(CAUGHT)('catches $name', ({ source }) => {
    expect(runStateReads(source)).toHaveLength(1);
  });

  it.each(IGNORED)('ignores $name', ({ source }) => {
    expect(runStateReads(source)).toEqual([]);
  });
});
