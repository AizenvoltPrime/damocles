import { describe, it, expect } from 'vitest';
import { globSync, readFileSync } from 'fs';
import { join } from 'path';
import * as ts from 'typescript';

/**
 * The OS clipboard is one per machine and the desktop e2e suite runs workers in parallel, so a test touches it only while it
 * holds the `clipboard` fixture's cross-worker lock (e2e/desktop/support/clipboard.ts). This fails on clipboard access that
 * bypasses that module, and on a copy or paste action outside a function that holds the fixture.
 */

const ROOT = join(__dirname, '..', '..');
const HELPER = 'e2e/desktop/support/clipboard.ts';
const FIXTURE_TYPE = 'E2eClipboard';
const CLIPBOARD_ID = /^(?:cut|copy|paste)$|^copy[A-Z]|^damocles\.edit\.paste/;
// A copy or paste control's test id, such as a chat message's copy button.
const CLIPBOARD_TEST_ID = /(?:^|[^a-z])(?:copy|cut|paste)(?:$|[^a-z])/i;
// The OS clipboard tools a test could run in a terminal instead.
const CLIPBOARD_TOOL = /\b(?:Get-Clipboard|Set-Clipboard|clip\.exe|pbcopy|pbpaste|xclip|xsel|wl-copy|wl-paste)\b/i;
const CLIPBOARD_KEYS = new Set(['C', 'V', 'X', 'Insert']);
const CLIPBOARD_COMMANDS = new Set(['copy', 'cut', 'paste']);

// A Playwright chord ('Shift+Control+V' as well as 'Control+Shift+V') or an Electron sendInputEvent key, either way a copy or paste.
function isClipboardChord(key: string, modifiers: readonly string[]): boolean {
  const held = new Set(modifiers.map((modifier) => modifier.toLowerCase()));
  const primary = ['control', 'ctrl', 'meta', 'cmd', 'command', 'controlormeta', 'cmdorctrl'].some((modifier) => held.has(modifier));
  const name = key.toLowerCase();
  return (primary && ['c', 'v', 'x', 'insert'].includes(name)) || (held.has('shift') && (name === 'insert' || name === 'delete'));
}

function chordOf(value: string | undefined): boolean {
  if (value === undefined || !value.includes('+')) return false;
  const parts = value.split('+');
  return isClipboardChord(parts.at(-1)!, parts.slice(0, -1));
}

function property(object: ts.Expression | undefined, name: string): ts.Expression | undefined {
  if (!object || !ts.isObjectLiteralExpression(object)) return undefined;
  const found = object.properties.find((entry): entry is ts.PropertyAssignment => ts.isPropertyAssignment(entry) && ts.isIdentifier(entry.name) && entry.name.text === name);
  return found?.initializer;
}

const text = (node: ts.Node | undefined): string | undefined => (node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) ? node.text : undefined);

function calleeName(call: ts.CallExpression): string | undefined {
  const callee = call.expression;
  if (ts.isIdentifier(callee)) return callee.text;
  if (ts.isPropertyAccessExpression(callee)) return callee.name.text;
  return undefined;
}

function rootName(expression: ts.Expression): string | undefined {
  if (ts.isIdentifier(expression)) return expression.text;
  if (ts.isPropertyAccessExpression(expression)) return rootName(expression.expression);
  return undefined;
}

// The fixtures parameter of a callback passed straight to test(), test.only(), test.beforeEach() and the like.
function isTestFixtures(pattern: ts.ObjectBindingPattern): boolean {
  const parameter = pattern.parent;
  if (!ts.isParameter(parameter)) return false;
  const fn = parameter.parent;
  return fn.parameters[0] === parameter && ts.isCallExpression(fn.parent) && fn.parent.arguments.includes(fn as ts.Expression) && rootName(fn.parent.expression) === 'test';
}

function bindsClipboard(element: ts.BindingElement): boolean {
  const key = element.propertyName ?? element.name;
  return ts.isIdentifier(key) && key.text === 'clipboard';
}

// A function holds the fixture when a test destructures `clipboard` from its fixtures or it takes an E2eClipboard parameter.
function holdsFixture(fn: ts.SignatureDeclaration): boolean {
  return fn.parameters.some((parameter) => {
    if (ts.isObjectBindingPattern(parameter.name)) return isTestFixtures(parameter.name) && parameter.name.elements.some(bindsClipboard);
    const type = parameter.type;
    return type !== undefined && ts.isTypeReferenceNode(type) && ts.isIdentifier(type.typeName) && type.typeName.text === FIXTURE_TYPE;
  });
}

function withinFixture(node: ts.Node): boolean {
  for (let at: ts.Node | undefined = node.parent; at; at = at.parent) if (ts.isFunctionLike(at) && holdsFixture(at)) return true;
  return false;
}

// What copies or pastes through the OS clipboard without naming it: the platform keys, a middle click and the copy and paste menu items.
function triggerOf(node: ts.Node): string | undefined {
  if (ts.isCallExpression(node)) {
    const name = calleeName(node);
    const args = node.arguments;
    if (name === 'pressKeys' && CLIPBOARD_KEYS.has(text(args[2]) ?? '')) {
      const modifiers = args[3] && ts.isArrayLiteralExpression(args[3]) ? args[3].elements.map((element) => text(element) ?? (ts.isIdentifier(element) ? element.text : '')) : [];
      if (modifiers.some((modifier) => modifier === 'control' || modifier === 'meta' || modifier === 'PRIMARY' || (text(args[2]) === 'Insert' && modifier === 'shift'))) return `pressKeys ${text(args[2])}`;
    }
    if (name === 'press' && chordOf(text(args[0]))) return `press ${text(args[0])}`;
    if (name === 'sendInputEvent') {
      const keyCode = text(property(args[0], 'keyCode'));
      const modifiers = property(args[0], 'modifiers');
      const held = modifiers && ts.isArrayLiteralExpression(modifiers) ? modifiers.elements.map((element) => text(element) ?? '') : [];
      if (keyCode !== undefined && isClipboardChord(keyCode, held)) return `sendInputEvent ${keyCode}`;
    }
    if (name === 'execCommand' && CLIPBOARD_COMMANDS.has(text(args[0]) ?? '')) return `execCommand ${text(args[0])}`;
    const id = args.map(text).find((value) => value !== undefined && CLIPBOARD_ID.test(value));
    // An expectation that names an id (toBe('copy')) acts on nothing.
    if (id !== undefined && !/^to[A-Z]/.test(name ?? '')) return `${name ?? 'a call'} ${id}`;
    // A copy or paste control clicked: getByTestId('about-copy').click().
    const target = ts.isPropertyAccessExpression(node.expression) ? node.expression.expression : undefined;
    if ((name === 'click' || name === 'press') && target && ts.isCallExpression(target) && calleeName(target) === 'getByTestId' && CLIPBOARD_TEST_ID.test(text(target.arguments[0]) ?? '')) return `${text(target.arguments[0])} clicked`;
  }
  if (ts.isPropertyAssignment(node) && ts.isIdentifier(node.name) && node.name.text === 'button' && text(node.initializer) === 'middle') return 'middle click';
  return undefined;
}

/** Every clipboard use in `source` that bypasses the fixture, as `line: reason`. */
function clipboardFindings(fileName: string, source: string): string[] {
  const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const findings: string[] = [];
  const report = (node: ts.Node, reason: string): void => {
    findings.push(`${file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1}: ${reason}`);
  };
  const visit = (node: ts.Node): void => {
    // Electron's and the page's clipboard both are a `clipboard` property; only a test's fixtures may name it.
    if (ts.isPropertyAccessExpression(node) && node.name.text === 'clipboard') {
      report(node, 'reads or writes the clipboard directly; use the clipboard fixture');
    } else if (ts.isElementAccessExpression(node) && text(node.argumentExpression) === 'clipboard') {
      report(node, 'reads or writes the clipboard directly; use the clipboard fixture');
    } else if (ts.isObjectBindingPattern(node) && node.elements.some(bindsClipboard)) {
      // Fixtures set up in destructuring order and tear down in reverse, so a first `clipboard` is locked before any app launches and released after every app closed.
      if (!isTestFixtures(node)) report(node, 'reads or writes the clipboard directly; use the clipboard fixture');
      else if (!bindsClipboard(node.elements[0]!)) report(node, 'the clipboard fixture must be the first fixture a test takes');
    } else if ((ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateMiddle(node) || ts.isTemplateHead(node) || ts.isTemplateTail(node)) && CLIPBOARD_TOOL.test(node.text)) {
      report(node, 'runs an OS clipboard tool; use the clipboard fixture');
    }
    const trigger = triggerOf(node);
    if (trigger !== undefined && !withinFixture(node)) report(node, `${trigger} uses the clipboard outside a test that holds the clipboard fixture`);
    ts.forEachChild(node, visit);
  };
  visit(file);
  return findings;
}

describe('e2e clipboard access', () => {
  it('goes through the clipboard fixture in every desktop e2e file', () => {
    const files = globSync('e2e/desktop/**/*.ts', { cwd: ROOT })
      .map((file) => file.replaceAll('\\', '/'))
      .filter((file) => !file.includes('/node_modules/') && file !== HELPER);
    expect(files.length).toBeGreaterThan(50);
    const findings = files.flatMap((file) => clipboardFindings(file, readFileSync(join(ROOT, file), 'utf8')).map((finding) => `${file}:${finding}`));
    expect(findings).toEqual([]);
  });

  it('flags each known bypass', () => {
    const bypasses = [
      "test('t', async ({ launch }) => { const { app } = await launch(); await app.evaluate(({ clipboard: board }) => board.readText()); });",
      "test('t', async ({ launch }) => { const { app } = await launch(); await app.evaluate((electron) => electron.clipboard.writeText('x')); });",
      "test('t', async ({ launch }) => { const { app } = await launch(); await app.evaluate((electron) => electron['clipboard'].readText()); });",
      "test('t', async ({ page }) => { await page.evaluate(() => navigator.clipboard.readText()); });",
      "test('t', async ({ home, launch }) => { await pressKeys(app, '/shell/', 'V', [PRIMARY]); });",
      "test('t', async ({ home, launch }) => { await pressKeys(app, '/shell/', 'C', ['control', 'shift']); });",
      "test('t', async ({ launch }) => { await shell.keyboard.press('Control+Shift+V'); });",
      "test('t', async ({ launch }) => { await screen.click({ button: 'middle' }); });",
      "test('t', async ({ launch }) => { await chooseMenuItem(app, 'paste'); });",
      "test('t', async ({ launch }) => { await menuItem(overlay, 'copyRelativePath').click(); });",
      "test('t', async ({ launch }) => { await clickMenu(app, 'damocles.edit.paste'); });",
      "test('t', async ({ launch }) => { await shell.evaluate(() => document.execCommand('paste')); });",
      "async function helper(app: ElectronApplication): Promise<void> { await pressKeys(app, '/shell/', 'V', ['control']); }",
      "const read = ({ clipboard }) => clipboard.readText();\ntest('t', async ({ launch }) => { const { app } = await launch(); await app.evaluate(read); });",
      "async function helper({ clipboard }: { clipboard: E2eClipboard }): Promise<void> { await chooseMenuItem(app, 'paste'); }",
      "test('t', async ({ launch }) => { await paletteAction(app, shell, 'copyLastCommandOutput'); });",
      "test('t', async ({ launch }) => { await tab.getByTestId('message-copy').click(); });",
      "test('t', async ({ launch }) => { await shell.keyboard.press('Shift+Delete'); });",
      "test('t', async ({ launch }) => { await shell.keyboard.press('Shift+Control+V'); });",
      "test('t', async ({ launch }) => { await app.evaluate(({ webContents }) => webContents.getAllWebContents()[0]!.sendInputEvent({ type: 'keyDown', keyCode: 'V', modifiers: ['control'] })); });",
      "test('t', async ({ launch }) => { await runInTerminal(shell, 'Get-Clipboard'); });",
      "test('t', async ({ clipboard, launch }) => { await runInTerminal(shell, `echo ${x} | xclip -o`); });",
      "test('t', async ({ home, clipboard, launch }) => { await clipboard.readText(app); });",
    ];
    for (const sample of bypasses) expect(clipboardFindings('sample.spec.ts', sample), sample).not.toEqual([]);
  });

  it('accepts clipboard use under the fixture, comments, titles and synthetic paste events', () => {
    const clean = [
      "test('copy and paste work', async ({ clipboard, launch }) => { const { app } = await launch(); await pressKeys(app, '/shell/', 'V', ['control']); expect(await clipboard.readText(app)).toBe('x'); });",
      "async function helper(app: ElectronApplication, clipboard: E2eClipboard): Promise<void> { await chooseMenuItem(app, 'cut'); await clipboard.writeText(app, ''); }",
      "// await app.evaluate(({ clipboard }) => clipboard.readText());\ntest('the clipboard is untouched', async ({ launch }) => { await pressKeys(app, '/shell/', 'K', ['control']); });",
      "test('t', async ({ launch }) => { await input.evaluate((el) => el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: new DataTransfer() }))); });",
    ];
    for (const sample of clean) expect(clipboardFindings('sample.spec.ts', sample), sample).toEqual([]);
  });
});
