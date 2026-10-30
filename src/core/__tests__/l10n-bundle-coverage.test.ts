import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import * as ts from 'typescript';

/**
 * A view renders a key its catalog lacks in English, so a message missing from a bundle shows a Greek user English instead of
 * failing; a bundle key nothing renders is dead weight a translator still keeps up, and an empty translation renders as nothing.
 */

const ROOT = path.join(__dirname, '..', '..', '..');

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === '__tests__' ? [] : sourceFiles(full);
    return full.endsWith('.ts') && !full.endsWith('.d.ts') ? [full] : [];
  });
}

const parsed = new Map<string, ts.SourceFile>();
function parse(file: string): ts.SourceFile {
  let source = parsed.get(file);
  if (!source) {
    source = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
    parsed.set(file, source);
  }
  return source;
}

const isText = (node: ts.Node): node is ts.StringLiteral | ts.NoSubstitutionTemplateLiteral => ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node);
const isConstantName = (name: string): boolean => /^[A-Z_][A-Z0-9_]*$/.test(name);

// The function whose parameter `name` is, seen from `node`, with the parameter's position.
function parameterOf(node: ts.Node, name: string): { readonly fn: ts.SignatureDeclaration; readonly index: number } | undefined {
  for (let at: ts.Node | undefined = node.parent; at; at = at.parent) {
    if (!ts.isFunctionLike(at)) continue;
    const index = at.parameters.findIndex((parameter) => ts.isIdentifier(parameter.name) && parameter.name.text === name);
    if (index >= 0) return { fn: at, index };
  }
  return undefined;
}

// What a function is called by in its file: its own name, or the variable, property or field it is assigned to.
function nameOf(fn: ts.SignatureDeclaration): string | undefined {
  if ((ts.isFunctionDeclaration(fn) || ts.isMethodDeclaration(fn)) && fn.name && ts.isIdentifier(fn.name)) return fn.name.text;
  const holder = fn.parent;
  if ((ts.isVariableDeclaration(holder) || ts.isPropertyAssignment(holder) || ts.isPropertyDeclaration(holder)) && ts.isIdentifier(holder.name)) return holder.name.text;
  return undefined;
}

// The initializer of a top-level `const name = ...` in source.
function constantOf(source: ts.SourceFile, name: string): ts.Expression | undefined {
  for (const statement of source.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name) && declaration.name.text === name) return declaration.initializer;
    }
  }
  return undefined;
}

// The file `name` is imported from, by a relative import of source.
function importedFrom(source: ts.SourceFile, name: string): ts.SourceFile | undefined {
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier) || !statement.moduleSpecifier.text.startsWith('.')) continue;
    const bindings = statement.importClause?.namedBindings;
    if (!bindings || !ts.isNamedImports(bindings) || !bindings.elements.some((element) => element.name.text === name)) continue;
    const file = `${path.resolve(path.dirname(source.fileName), statement.moduleSpecifier.text)}.ts`;
    return fs.existsSync(file) ? parse(file) : undefined;
  }
  return undefined;
}

/**
 * The messages an argument of a translating call names: a string literal, a same-file string constant, a string property of
 * a constant object this file declares or imports, or a parameter, which names what every call of its function in the same
 * file passes there. Only a translating call's own argument must resolve; one passed on through a parameter may be anything.
 */
function messagesOf(argument: ts.Expression, source: ts.SourceFile, seen: Set<ts.Node>, direct = true): string[] {
  if (isText(argument)) return [argument.text];
  if (seen.has(argument)) return [];
  seen.add(argument);
  const where = path.relative(ROOT, source.fileName);
  if (ts.isIdentifier(argument)) {
    const parameter = parameterOf(argument, argument.text);
    if (parameter) {
      const name = nameOf(parameter.fn);
      if (name === undefined) return [];
      const calls: ts.CallExpression[] = [];
      const visit = (node: ts.Node): void => {
        if (ts.isCallExpression(node)) {
          const callee = node.expression;
          if ((ts.isIdentifier(callee) && callee.text === name) || (ts.isPropertyAccessExpression(callee) && callee.name.text === name)) calls.push(node);
        }
        ts.forEachChild(node, visit);
      };
      visit(source);
      return calls.flatMap((call) => {
        const passed = call.arguments[parameter.index];
        return passed ? messagesOf(passed, source, seen, false) : [];
      });
    }
    const constant = constantOf(source, argument.text);
    if (constant && isText(constant)) return [constant.text];
    if (direct && isConstantName(argument.text)) throw new Error(`${where}: ${argument.text} does not name a string constant in the same file`);
    return [];
  }
  if (direct && ts.isPropertyAccessExpression(argument) && ts.isIdentifier(argument.expression) && isConstantName(argument.expression.text)) {
    const owner = argument.expression.text;
    const declared = constantOf(source, owner) ?? (() => {
      const imported = importedFrom(source, owner);
      return imported && constantOf(imported, owner);
    })();
    const property = declared && ts.isObjectLiteralExpression(declared)
      ? declared.properties.find((candidate) => ts.isPropertyAssignment(candidate) && ts.isIdentifier(candidate.name) && candidate.name.text === argument.name.text)
      : undefined;
    if (!property || !ts.isPropertyAssignment(property) || !isText(property.initializer)) throw new Error(`${where}: ${owner}.${argument.name.text} is not a string of a constant object`);
    return [property.initializer.text];
  }
  return [];
}

/**
 * Every message a process renders through a bundle: core's `l()` in every file that imports it (core, the desktop processes,
 * VS Code) and in core/l10n.ts, which declares it; VS Code's own `vscode.l10n.t`; and desktop main's and its services' `t`.
 * The desktop shell's renderers translate with their own catalogs and are not read.
 */
function translatedMessages(): Map<string, string> {
  const messages = new Map<string, string>();
  const files = ['src/core', 'src/desktop', 'src/vscode'].flatMap((dir) => sourceFiles(path.join(ROOT, dir)));
  for (const file of files) {
    const where = path.relative(ROOT, file);
    const text = fs.readFileSync(file, 'utf8');
    const callsL = where === path.join('src', 'core', 'l10n.ts') || /import\s*\{[^}]*\bl\b[^}]*\}\s*from\s*['"][^'"]*\/l10n['"]/.test(text);
    const callsVsCode = where.startsWith(path.join('src', 'vscode'));
    const callsT = where.startsWith(path.join('src', 'desktop')) && !where.startsWith(path.join('src', 'desktop', 'shell'));
    if (!callsL && !callsVsCode && !callsT) continue;
    const source = parse(file);
    const translates = (callee: ts.Expression): boolean =>
      (callsL && ts.isIdentifier(callee) && callee.text === 'l')
      || (callsVsCode && ts.isPropertyAccessExpression(callee) && callee.name.text === 't' && callee.expression.getText(source) === 'vscode.l10n')
      || (callsT && ((ts.isIdentifier(callee) && callee.text === 't') || (ts.isPropertyAccessExpression(callee) && callee.name.text === 't')));
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && node.arguments[0] && translates(node.expression)) {
        for (const message of messagesOf(node.arguments[0], source, new Set())) messages.set(message, where);
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return messages;
}

describe('extension l10n bundles', () => {
  const messages = translatedMessages();

  it('finds the messages it checks (guards the scan itself from matching nothing)', () => {
    expect(messages.size).toBeGreaterThan(100);
    expect(messages.has('Tool information isn\'t available for "{0}".')).toBe(true);
    expect(messages.has('Back')).toBe(true);
    // each passed to `l` as a same-file constant
    expect([
      'No {0} credential is saved, so {1} could not run. Add an API key in Settings › Models & accounts.',
      'No {0} credential is saved, so {1} could not run. Sign in to {0} in Settings › Models & accounts.',
      'No {0} credential is saved, so {1} could not run. Sign in or add an API key in Settings › Models & accounts.',
      'No credential is set up for {0}, so {1} could not run. Pick a model from a provider you are signed in to.',
    ].filter((message) => !messages.has(message))).toEqual([]);
  });

  it.each(['bundle.l10n.json', 'bundle.l10n.el.json'])('%s has every message core, the desktop processes and VS Code render', (bundle) => {
    const table = JSON.parse(fs.readFileSync(path.join(ROOT, 'l10n', bundle), 'utf8')) as Record<string, string>;
    const missing = [...messages].filter(([message]) => !Object.hasOwn(table, message)).map(([message, file]) => `${file}: ${message}`);

    expect(missing).toEqual([]);
  });

  it('sees a message that reaches a translating call through a parameter, a property of a constant object or core/l10n.ts', () => {
    expect([
      // shellFailure(action, message) passes message to t
      'Damocles could not restart the engine: {0}',
      // placeholderNaming(t, template, value) passes template to t
      'Pick a remote to publish the branch "{0}" to:',
      // branchTitle(message, fallback) passes both to commands.ts's t
      'Merge into {0}',
      'Merge into branch',
      // t(ERROR_PAGE_STRINGS.title), a constant of shared/panel-html.ts
      'Session failed to restore',
      // verbatim()'s l('{0}', text), in the file that declares l
      '{0}',
    ].filter((message) => !messages.has(message))).toEqual([]);
  });

  it.each(['bundle.l10n.json', 'bundle.l10n.el.json'])('%s holds no message nothing renders', (bundle) => {
    const table = JSON.parse(fs.readFileSync(path.join(ROOT, 'l10n', bundle), 'utf8')) as Record<string, string>;
    expect(Object.keys(table).filter((key) => !messages.has(key))).toEqual([]);
  });

  it.each(['bundle.l10n.json', 'bundle.l10n.el.json'])('%s translates every message to some text', (bundle) => {
    const table = JSON.parse(fs.readFileSync(path.join(ROOT, 'l10n', bundle), 'utf8')) as Record<string, unknown>;
    expect(Object.entries(table).filter(([, value]) => typeof value !== 'string' || value.trim() === '').map(([key]) => key)).toEqual([]);
  });
});
