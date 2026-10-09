import { describe, it, expect } from 'vitest';
import { globSync, readFileSync } from 'fs';
import { join } from 'path';
import * as ts from 'typescript';

/**
 * The OS gives keyboard focus and the pointer's hover to one window at a time, and the desktop e2e suite runs workers in
 * parallel, so a test that reads native focus or relies on hover holds the `foreground` fixture (e2e/desktop/support/
 * foreground.ts), or the `clipboard` fixture, which holds the foreground too. This fails on such a test that takes neither
 * first, and on a test that takes both.
 */

const ROOT = join(__dirname, '..', '..');
// Support helpers that report native focus, or move the pointer onto an element and keep it there.
const FOCUS_HELPERS = new Set(['viewFocused']);
const HOVER_CALLS = new Set(['hover', 'hoverTerminalText', 'holdToast']);
// The fields support helpers fill from webContents.isFocused() or BrowserWindow.isFocused().
const FOCUS_FIELDS = new Set(['focused', 'pageFocused']);

const calleeName = (call: ts.CallExpression): string | undefined => {
  const callee = call.expression;
  if (ts.isIdentifier(callee)) return callee.text;
  if (ts.isPropertyAccessExpression(callee)) return callee.name.text;
  return undefined;
};

function rootName(expression: ts.Expression): string | undefined {
  if (ts.isIdentifier(expression)) return expression.text;
  if (ts.isPropertyAccessExpression(expression)) return rootName(expression.expression);
  return undefined;
}

// What a node does that needs the foreground, if anything; `readers` are this file's functions that read native focus.
function needOf(node: ts.Node, readers: ReadonlySet<string>): string | undefined {
  if (ts.isCallExpression(node)) {
    const name = calleeName(node);
    if (name === 'isFocused' && ts.isPropertyAccessExpression(node.expression)) return 'reads isFocused()';
    if (name !== undefined && (FOCUS_HELPERS.has(name) || readers.has(name))) return `reads native focus through ${name}`;
    if (name !== undefined && HOVER_CALLS.has(name)) return `relies on hover through ${name}`;
  }
  if (ts.isPropertyAccessExpression(node) && FOCUS_FIELDS.has(node.name.text) && !(ts.isCallExpression(node.parent) && node.parent.expression === node)) return `reads native focus through .${node.name.text}`;
  return undefined;
}

function firstNeed(node: ts.Node, readers: ReadonlySet<string>): ts.Node | undefined {
  if (needOf(node, readers) !== undefined) return node;
  return ts.forEachChild(node, (child) => firstNeed(child, readers));
}

// Functions declared in the file, by name: function declarations and consts holding an arrow or function expression.
function namedFunctions(file: ts.SourceFile): Map<string, ts.Node> {
  const functions = new Map<string, ts.Node>();
  const visit = (node: ts.Node): void => {
    if (ts.isFunctionDeclaration(node) && node.name && node.body) functions.set(node.name.text, node.body);
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer && (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))) {
      functions.set(node.name.text, node.initializer.body);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return functions;
}

// The file's functions that read native focus or hover, directly or through each other.
function readersOf(file: ts.SourceFile): Set<string> {
  const functions = namedFunctions(file);
  const readers = new Set<string>();
  for (let grew = true; grew;) {
    grew = false;
    for (const [name, body] of functions) {
      if (readers.has(name) || firstNeed(body, readers) === undefined) continue;
      readers.add(name);
      grew = true;
    }
  }
  return readers;
}

// The fixture names a test's callback destructures, in order; undefined for a call that is not a test.
function testFixtures(call: ts.CallExpression): string[] | undefined {
  if (rootName(call.expression) !== 'test') return undefined;
  const callback = call.arguments.find((arg): arg is ts.ArrowFunction | ts.FunctionExpression => ts.isArrowFunction(arg) || ts.isFunctionExpression(arg));
  const pattern = callback?.parameters[0]?.name;
  if (!pattern || !ts.isObjectBindingPattern(pattern)) return callback ? [] : undefined;
  return pattern.elements.map((element) => {
    const key = element.propertyName ?? element.name;
    return ts.isIdentifier(key) ? key.text : '';
  });
}

/** Every test in `source` that needs the foreground without holding it first, as `line: reason`. */
function foregroundFindings(fileName: string, source: string): string[] {
  const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const readers = readersOf(file);
  const findings: string[] = [];
  const visit = (node: ts.Node): void => {
    const fixtures = ts.isCallExpression(node) ? testFixtures(node) : undefined;
    if (fixtures !== undefined) {
      const need = firstNeed(node, readers);
      const line = (at: ts.Node): number => file.getLineAndCharacterOfPosition(at.getStart(file)).line + 1;
      if (need !== undefined && fixtures[0] !== 'foreground' && fixtures[0] !== 'clipboard') findings.push(`${line(need)}: ${needOf(need, readers)} in a test that takes neither the foreground nor the clipboard fixture first`);
      if (fixtures.includes('foreground') && fixtures.includes('clipboard')) findings.push(`${line(node)}: a test takes both the foreground and the clipboard`);
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return findings;
}

describe('e2e foreground', () => {
  it('is held by every desktop e2e test that reads native focus or relies on hover', () => {
    const files = globSync('e2e/desktop/**/*.ts', { cwd: ROOT })
      .map((file) => file.replaceAll('\\', '/'))
      .filter((file) => !file.includes('/node_modules/') && !file.includes('/support/'));
    expect(files.length).toBeGreaterThan(50);
    const findings = files.flatMap((file) => foregroundFindings(file, readFileSync(join(ROOT, file), 'utf8')).map((finding) => `${file}:${finding}`));
    expect(findings).toEqual([]);
  });

  it('flags each way a test needs the foreground without it', () => {
    const needs = [
      "test('t', async ({ launch }) => { const { app } = await launch(); expect(await viewFocused(app, chat)).toBe(true); });",
      "test('t', async ({ launch }) => { await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.webContents.isFocused()); });",
      "async function shellFocused(app) { return app.evaluate(({ webContents }) => webContents.getFocusedWebContents()!.isFocused()); }\ntest('t', async ({ launch }) => { await shellFocused(app); });",
      "const popupFocused = async (app) => (await popupWindowState(app))?.focused;\nconst either = (app) => popupFocused(app);\ntest('t', async ({ launch }) => { await either(app); });",
      "test('t', async ({ launch }) => { expect((await overlayViewState(app)).focused).toBe(true); });",
      "test('t', async ({ launch }) => { await row.hover(); });",
      "test('t', async ({ launch }) => { await hoverTerminalText(shell, 'a', 'a'); });",
      "test('t', async ({ launch, foreground }) => { await row.hover(); });",
      "test('t', async ({ foreground: _foreground, clipboard, launch }) => { await launch(); });",
    ];
    for (const sample of needs) expect(foregroundFindings('sample.spec.ts', sample), sample).not.toEqual([]);
  });

  it('accepts a test that holds the foreground or the clipboard first, and DOM focus, which Playwright emulates per page', () => {
    const clean = [
      "test('t', async ({ clipboard, home, launch }) => { expect(await viewFocused(app, shell)).toBe(true); });",
      "test('t', async ({ foreground: _foreground, launch }) => { expect(await viewFocused(app, chat)).toBe(true); await row.hover(); });",
      "test('t', async ({ launch }) => { await expect(chatInput(tab)).toBeFocused(); });",
      "test('t', async ({ launch }) => { await app.evaluate(({ BrowserWindow }) => { const win = BrowserWindow.getAllWindows()[0]; win.isFocused = () => true; }); });",
      "test('t', async ({ launch }) => { expect({ focused: true }).toEqual({ focused: true }); });",
    ];
    for (const sample of clean) expect(foregroundFindings('sample.spec.ts', sample), sample).toEqual([]);
  });
});
