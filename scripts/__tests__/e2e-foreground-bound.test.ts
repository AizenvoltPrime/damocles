import { globSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import * as ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { LONGEST_TEST_MS } from '../../e2e/desktop/support/foreground';

// A foreground waiter gives up after FOREGROUND_WAIT_MS, so no test may hold the foreground or an app open longer than
// LONGEST_TEST_MS: every timeout an e2e test, describe or config sets must be a literal no greater than it.
const ROOT = join(__dirname, '..', '..');
const FILES = [...globSync('e2e/**/*.ts', { cwd: ROOT }), ...globSync('playwright.*.config.ts', { cwd: ROOT })];

interface Timeout {
  readonly where: string;
  readonly ms: number | undefined;
}

const literalMs = (node: ts.Expression | undefined): number | undefined => (node && ts.isNumericLiteral(node) ? Number(node.text.replaceAll('_', '')) : undefined);

function property(object: ts.Expression | undefined, name: string): ts.PropertyAssignment | undefined {
  if (!object || !ts.isObjectLiteralExpression(object)) return undefined;
  return object.properties.find((entry): entry is ts.PropertyAssignment => ts.isPropertyAssignment(entry) && ts.isIdentifier(entry.name) && entry.name.text === name);
}

function rootName(expression: ts.Expression): string | undefined {
  if (ts.isIdentifier(expression)) return expression.text;
  if (ts.isPropertyAccessExpression(expression)) return rootName(expression.expression);
  return undefined;
}

// test.setTimeout(n), test.describe.configure({ timeout: n }) and defineConfig's (or a project's) timeout.
function timeoutsIn(file: string): Timeout[] {
  const source = ts.createSourceFile(file, readFileSync(join(ROOT, file), 'utf8'), ts.ScriptTarget.Latest, true);
  const found: Timeout[] = [];
  const at = (node: ts.Node): string => `${relative(ROOT, join(ROOT, file)).replaceAll('\\', '/')}:${source.getLineAndCharacterOfPosition(node.getStart()).line + 1}`;
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && rootName(node.expression) === 'test') {
      const method = node.expression.name.text;
      if (method === 'setTimeout') found.push({ where: at(node), ms: literalMs(node.arguments[0]) });
      const configured = method === 'configure' ? property(node.arguments[0], 'timeout') : undefined;
      if (configured) found.push({ where: at(configured), ms: literalMs(configured.initializer) });
    }
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'defineConfig') {
      const config = node.arguments[0];
      const own = property(config, 'timeout');
      if (own) found.push({ where: at(own), ms: literalMs(own.initializer) });
      const projects = property(config, 'projects')?.initializer;
      const listed = projects && ts.isArrayLiteralExpression(projects) ? projects.elements : [];
      const conditional = projects && ts.isConditionalExpression(projects) ? [projects.whenTrue, projects.whenFalse].flatMap((branch) => (ts.isArrayLiteralExpression(branch) ? [...branch.elements] : [])) : [];
      for (const project of [...listed, ...conditional]) {
        const timeout = property(project, 'timeout');
        if (timeout) found.push({ where: at(timeout), ms: literalMs(timeout.initializer) });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

describe('the foreground wait', () => {
  const timeouts = FILES.flatMap(timeoutsIn);

  it('reads every e2e timeout as a literal', () => {
    expect(timeouts.length).toBeGreaterThan(0);
    expect(timeouts.filter((timeout) => timeout.ms === undefined).map((timeout) => timeout.where)).toEqual([]);
  });

  it('is derived from the longest timeout any e2e test or config sets', () => {
    expect(timeouts.filter((timeout) => timeout.ms! > LONGEST_TEST_MS).map((timeout) => `${timeout.where} ${timeout.ms}`)).toEqual([]);
    expect(Math.max(...timeouts.map((timeout) => timeout.ms!))).toBe(LONGEST_TEST_MS);
  });
});
