import { describe, it, expect } from 'vitest';
import { globSync, readFileSync } from 'fs';
import { join } from 'path';
import * as ts from 'typescript';

/**
 * getAllWindows() lists the newest window first, and the theme renderer's offscreen window and the notifier open and close
 * during a test, so the list's order names no window. e2e reaches the main window through `onMainWindow` or a lookup by
 * SHELL_URL (e2e/desktop/support/shell.ts). Every getAllWindows() call under e2e/ must feed a lookup that tells the windows
 * apart: `.find`, `.filter`, `.some`, `.every` or `.map` with a callback that takes the window, or a `for…of`. Any other use
 * fails here, whatever wraps the call.
 */

const ROOT = join(__dirname, '..', '..');
const LOOKUPS = new Set(['find', 'filter', 'some', 'every', 'map']);
const SCRIPT_KINDS: Readonly<Record<string, ts.ScriptKind>> = { ts: ts.ScriptKind.TS, cjs: ts.ScriptKind.JS, mjs: ts.ScriptKind.JS, js: ts.ScriptKind.JS };

const isGetAllWindows = (node: ts.Node): node is ts.CallExpression =>
  ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'getAllWindows';

// Parentheses, `!`, `as` and `satisfies` around an expression change nothing about what it is used for.
const isWrapper = (node: ts.Node): boolean =>
  ts.isParenthesizedExpression(node) || ts.isNonNullExpression(node) || ts.isAsExpression(node) || ts.isSatisfiesExpression(node) || ts.isTypeAssertionExpression(node);

function feedsLookup(call: ts.CallExpression): boolean {
  let used: ts.Node = call;
  while (isWrapper(used.parent)) used = used.parent;
  const user = used.parent;
  if (ts.isForOfStatement(user)) return user.expression === used;
  if (!ts.isPropertyAccessExpression(user) || user.expression !== used || !LOOKUPS.has(user.name.text)) return false;
  const lookup = user.parent;
  if (!ts.isCallExpression(lookup) || lookup.expression !== user) return false;
  const callback = lookup.arguments[0];
  return callback !== undefined && (ts.isArrowFunction(callback) || ts.isFunctionExpression(callback)) && callback.parameters.length > 0;
}

/** Each getAllWindows() call in `text` that feeds no lookup by predicate, as `file:line`. */
function orderedLookups(file: string, text: string): string[] {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, SCRIPT_KINDS[file.slice(file.lastIndexOf('.') + 1)] ?? ts.ScriptKind.TS);
  const found: string[] = [];
  const visit = (node: ts.Node): void => {
    if (isGetAllWindows(node) && !feedsLookup(node)) found.push(`${file}:${source.getLineAndCharacterOfPosition(node.getStart()).line + 1}`);
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

describe('e2e window lookups', () => {
  it('feed every getAllWindows() into a lookup by predicate, in every script under e2e/', () => {
    const files = globSync(Object.keys(SCRIPT_KINDS).map((extension) => `e2e/**/*.${extension}`), { cwd: ROOT })
      .map((file) => file.replaceAll('\\', '/'))
      .filter((file) => !file.includes('/node_modules/'));
    expect(files.length).toBeGreaterThan(50);
    for (const extension of ['.ts', '.cjs', '.mjs']) expect(files.some((file) => file.endsWith(extension)), extension).toBe(true);
    expect(files.flatMap((file) => orderedLookups(file, readFileSync(join(ROOT, file), 'utf8')))).toEqual([]);
  });

  it('flags every use of the list that depends on its order', () => {
    const ordered = [
      'BrowserWindow.getAllWindows()[0]!.focus();',
      'BaseWindow.getAllWindows().at(-1)!.focus();',
      '(BrowserWindow.getAllWindows())[0].focus();',
      'BrowserWindow.getAllWindows()![0].focus();',
      '(BrowserWindow.getAllWindows() as Electron.BrowserWindow[])[0].focus();',
      'const [win] = BrowserWindow.getAllWindows();',
      'const all = BrowserWindow.getAllWindows(); all[0].focus();',
      'BrowserWindow.getAllWindows().shift().focus();',
      'BrowserWindow.getAllWindows().pop().focus();',
      'BrowserWindow.getAllWindows().find(() => true).focus();',
      'BrowserWindow.getAllWindows().find(first).focus();',
      'focusFirst(BrowserWindow.getAllWindows());',
      'for (const win in BrowserWindow.getAllWindows()) focus(win);',
    ];
    for (const sample of ordered) expect(orderedLookups('probe.ts', sample), sample).toEqual(['probe.ts:1']);
    expect(orderedLookups('probe.cjs', 'const { BrowserWindow } = require("electron");\nBrowserWindow.getAllWindows()[0].focus();')).toEqual(['probe.cjs:2']);
    expect(orderedLookups('probe.mjs', 'const [win] = BrowserWindow.getAllWindows();')).toEqual(['probe.mjs:1']);
  });

  it('passes a lookup by predicate, however the call is wrapped', () => {
    const lookups = [
      'BrowserWindow.getAllWindows().find((win) => win.webContents.getURL().startsWith(url))!.focus();',
      '(BrowserWindow.getAllWindows()).find((win) => win.webContents.getURL() === url);',
      'BrowserWindow.getAllWindows()!.filter((win) => win.isVisible()).length;',
      'BaseWindow.getAllWindows().some(function (win) { return win.isFocused(); });',
      'BrowserWindow.getAllWindows().every((win) => !win.isDestroyed());',
      'BrowserWindow.getAllWindows().map((win) => win.getBounds());',
      'for (const win of BaseWindow.getAllWindows()) visit(win);',
    ];
    for (const sample of lookups) expect(orderedLookups('probe.ts', sample), sample).toEqual([]);
    expect(orderedLookups('probe.cjs', 'for (const win of BrowserWindow.getAllWindows()) visit(win);')).toEqual([]);
  });
});
