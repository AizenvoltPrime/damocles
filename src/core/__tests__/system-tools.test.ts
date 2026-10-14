import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as ts from 'typescript';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { findOnAbsolutePath, posixTool, windowsPowerShell, windowsSystemTool } from '../system-tools';

const SRC = path.join(__dirname, '..', '..');

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'dam-system-tools-'));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function folder(name: string, ...files: string[]): string {
  const dir = path.join(root, name);
  fs.mkdirSync(dir);
  for (const file of files) fs.writeFileSync(path.join(dir, file), '');
  return dir;
}

const pathEnv = (...entries: string[]): Record<string, string> => ({ PATH: entries.join(path.delimiter) });

describe('windowsSystemTool', () => {
  it('names the tool in SystemRoot\\System32, as VS Code names taskkill', () => {
    expect(windowsSystemTool('taskkill', { SystemRoot: 'D:\\Windows' })).toBe('D:\\Windows\\System32\\taskkill.exe');
    expect(windowsSystemTool('tasklist', { windir: 'E:\\Win' })).toBe('E:\\Win\\System32\\tasklist.exe');
  });

  it('never builds the path from a relative or remote root, which would resolve against the working folder or another machine', () => {
    for (const SystemRoot of ['Windows', '.\\Windows', '\\\\host\\share\\Windows', '']) {
      expect(windowsSystemTool('taskkill', { SystemRoot })).toBe('C:\\Windows\\System32\\taskkill.exe');
    }
  });

  it('falls back to C:\\Windows when neither variable is set', () => {
    expect(windowsSystemTool('taskkill', {})).toBe('C:\\Windows\\System32\\taskkill.exe');
  });

  it('names Windows PowerShell under the same root', () => {
    expect(windowsPowerShell({ SystemRoot: 'D:\\Windows' })).toBe('D:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
    expect(windowsPowerShell({ SystemRoot: '.\\Windows' })).toBe('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
  });
});

describe('findOnAbsolutePath and posixTool', () => {
  it('never takes a tool from a relative PATH entry, which resolves against the spawn folder', () => {
    const name = process.platform === 'win32' ? 'ps.exe' : 'ps';
    const relative = path.relative(process.cwd(), folder('planted', name));
    expect(path.isAbsolute(relative)).toBe(false);
    expect(findOnAbsolutePath(name, process.platform, pathEnv(relative, '.', folder('empty')))).toBeUndefined();
  });

  it('finds the tool in the first absolute PATH entry that holds it', () => {
    const name = process.platform === 'win32' ? 'ps.exe' : 'ps';
    const relative = path.relative(process.cwd(), folder('planted', name));
    const bin = folder('bin', name);
    expect(findOnAbsolutePath(name, process.platform, pathEnv(relative, folder('empty'), bin))).toBe(path.join(bin, name));
  });

  it('skips a folder named like the tool', () => {
    const name = process.platform === 'win32' ? 'ps.exe' : 'ps';
    const decoy = folder('decoy');
    fs.mkdirSync(path.join(decoy, name));
    expect(findOnAbsolutePath(name, process.platform, pathEnv(decoy))).toBeUndefined();
  });

  it.skipIf(process.platform === 'win32')('posixTool takes an absolute PATH folder first, then the folders the tool installs in', () => {
    const bin = folder('bin', 'ldconfig');
    const sbin = folder('sbin', 'ldconfig', 'bash');
    expect(posixTool('ldconfig', pathEnv(bin), [sbin])).toBe(path.join(bin, 'ldconfig'));
    expect(posixTool('bash', pathEnv(bin), [sbin])).toBe(path.join(sbin, 'bash'));
    expect(posixTool('bash', pathEnv('.', bin), [folder('empty')])).toBeUndefined();
  });
});

const CHILD_PROCESS_SPAWNERS = new Set(['spawn', 'spawnSync', 'execFile', 'execFileSync', 'fork', 'exec', 'execSync']);
const EXEC_HELPERS = new Set(['exec', 'execSafe']);
const isChildProcess = (from: string): boolean => from === 'child_process' || from === 'node:child_process';

type FunctionLike = ts.FunctionDeclaration | ts.ArrowFunction | ts.FunctionExpression;

// What starts a program in one file: callable names, each with the index of the argument naming the program, and the
// child_process namespaces.
interface Spawners {
  readonly calls: Map<string, number>;
  readonly namespaces: Set<string>;
}

function requiredModule(node: ts.Expression | undefined): string | undefined {
  if (!node || !ts.isCallExpression(node) || !ts.isIdentifier(node.expression) || node.expression.text !== 'require') return undefined;
  const [first] = node.arguments;
  return first && ts.isStringLiteralLike(first) ? first.text : undefined;
}

function isFunctionLike(node: ts.Node | undefined): node is FunctionLike {
  return node !== undefined && (ts.isFunctionDeclaration(node) || ts.isArrowFunction(node) || ts.isFunctionExpression(node));
}

/** The argument index naming the program when `callee` is a spawner, else undefined. */
function programIndex(callee: ts.Expression, spawners: Spawners): number | undefined {
  if (ts.isIdentifier(callee)) return spawners.calls.get(callee.text);
  const namespaced = ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression) && spawners.namespaces.has(callee.expression.text) && CHILD_PROCESS_SPAWNERS.has(callee.name.text);
  return namespaced ? 0 : undefined;
}

/**
 * Every spawner a file can call: child_process's (named, default, namespace and require imports), the checkpoints' exec
 * helpers, promisify() aliases of either, and local functions passing one of their parameters on as a spawner's program.
 */
function fileSpawners(source: ts.SourceFile): Spawners {
  const spawners: Spawners = { calls: new Map(), namespaces: new Set() };
  const bind = (from: string, imported: string, local: string): void => {
    const known = isChildProcess(from) ? CHILD_PROCESS_SPAWNERS : /(^|\/)exec$/.test(from) ? EXEC_HELPERS : undefined;
    if (known?.has(imported)) spawners.calls.set(local, 0);
  };
  const declarations: ts.VariableDeclaration[] = [];
  const functions: Array<{ readonly name: string; readonly fn: FunctionLike }> = [];
  const collect = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const from = node.moduleSpecifier.text;
      const clause = node.importClause;
      if (clause?.name && isChildProcess(from)) spawners.namespaces.add(clause.name.text);
      const bindings = clause?.namedBindings;
      if (bindings && ts.isNamespaceImport(bindings)) {
        if (isChildProcess(from)) spawners.namespaces.add(bindings.name.text);
      } else if (bindings) {
        for (const element of bindings.elements) bind(from, (element.propertyName ?? element.name).text, element.name.text);
      }
    }
    if (ts.isVariableDeclaration(node)) {
      const from = requiredModule(node.initializer);
      if (from !== undefined && ts.isIdentifier(node.name) && isChildProcess(from)) spawners.namespaces.add(node.name.text);
      if (from !== undefined && ts.isObjectBindingPattern(node.name)) {
        for (const element of node.name.elements) {
          const imported = element.propertyName ?? element.name;
          if (ts.isIdentifier(imported) && ts.isIdentifier(element.name)) bind(from, imported.text, element.name.text);
        }
      }
      declarations.push(node);
      if (ts.isIdentifier(node.name) && isFunctionLike(node.initializer)) functions.push({ name: node.name.text, fn: node.initializer });
    }
    if (ts.isFunctionDeclaration(node) && node.name) functions.push({ name: node.name.text, fn: node });
    ts.forEachChild(node, collect);
  };
  collect(source);
  // to a fixed point, so a wrapper of a wrapper or of a promisify alias counts too
  for (let size = -1; size !== spawners.calls.size; ) {
    size = spawners.calls.size;
    for (const declaration of declarations) {
      const init = declaration.initializer;
      if (!ts.isIdentifier(declaration.name) || !init || !ts.isCallExpression(init) || !init.arguments[0]) continue;
      const callee = init.expression;
      const promisify = ts.isIdentifier(callee) ? callee.text === 'promisify' : ts.isPropertyAccessExpression(callee) && callee.name.text === 'promisify';
      const wrapped = programIndex(init.arguments[0], spawners);
      if (promisify && wrapped !== undefined) spawners.calls.set(declaration.name.text, wrapped);
    }
    for (const { name, fn } of functions) {
      if (spawners.calls.has(name)) continue;
      const params = fn.parameters.map((param) => (ts.isIdentifier(param.name) ? param.name.text : undefined));
      const visit = (node: ts.Node): void => {
        if (ts.isCallExpression(node)) {
          const index = programIndex(node.expression, spawners);
          const program = index === undefined ? undefined : node.arguments[index];
          const param = program && ts.isIdentifier(program) ? params.indexOf(program.text) : -1;
          if (param >= 0) spawners.calls.set(name, param);
        }
        ts.forEachChild(node, visit);
      };
      if (fn.body) visit(fn.body);
    }
  }
  return spawners;
}

const isAbsoluteProgram = (text: string): boolean => path.posix.isAbsolute(text) || path.win32.isAbsolute(text);

/** The bare program names an expression can evaluate to: literals, templates by their leading text, every arm of a choice or fallback, and file constants. */
function barePrograms(expr: ts.Expression, constants: ReadonlyMap<string, ts.Expression>, depth = 0): string[] {
  if (ts.isParenthesizedExpression(expr) || ts.isAsExpression(expr) || ts.isNonNullExpression(expr) || ts.isSatisfiesExpression(expr)) return barePrograms(expr.expression, constants, depth);
  if (ts.isStringLiteralLike(expr)) return isAbsoluteProgram(expr.text) ? [] : [expr.text];
  // a template starting with a substitution is as absolute as that value, which the guard cannot know
  if (ts.isTemplateExpression(expr)) return expr.head.text === '' || isAbsoluteProgram(expr.head.text) ? [] : [`${expr.head.text}\${…}`];
  if (ts.isConditionalExpression(expr)) return [...barePrograms(expr.whenTrue, constants, depth), ...barePrograms(expr.whenFalse, constants, depth)];
  if (ts.isBinaryExpression(expr) && (expr.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken || expr.operatorToken.kind === ts.SyntaxKind.BarBarToken)) {
    return [...barePrograms(expr.left, constants, depth), ...barePrograms(expr.right, constants, depth)];
  }
  const constant = ts.isIdentifier(expr) && depth < 8 ? constants.get(expr.text) : undefined;
  return constant ? barePrograms(constant, constants, depth + 1) : [];
}

/** Every spawner call in one source text whose program can be a name that is not an absolute path. */
function bareNameSpawnsIn(file: string, text: string): string[] {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const spawners = fileSpawners(source);
  const constants = new Map<string, ts.Expression>();
  const collect = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer && (ts.getCombinedNodeFlags(node) & ts.NodeFlags.Const) !== 0) constants.set(node.name.text, node.initializer);
    ts.forEachChild(node, collect);
  };
  collect(source);
  const found: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const index = programIndex(node.expression, spawners);
      const program = index === undefined ? undefined : node.arguments[index];
      for (const name of program ? barePrograms(program, constants) : []) found.push(`${file}:${source.getLineAndCharacterOfPosition(node.getStart()).line + 1}: ${name}`);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === '__tests__' || entry.name === '__mocks__' ? [] : sourceFiles(full);
    return /\.[cm]?[jt]s$/.test(entry.name) && !/\.(test|spec)\.[cm]?[jt]s$/.test(entry.name) && !entry.name.endsWith('.d.ts') ? [full] : [];
  });
}

describe('process spawns', () => {
  it('name an absolute program everywhere in src outside tests, never a bare name a relative PATH entry could plant', () => {
    const found = sourceFiles(SRC).flatMap((file) => bareNameSpawnsIn(path.relative(SRC, file).replace(/\\/g, '/'), fs.readFileSync(file, 'utf8')));
    expect(found).toEqual([]);
  });

  it.each([
    ['a promisify alias', "import { execFile } from 'child_process'; import { promisify } from 'util'; const run = promisify(execFile); run('which', ['x']);", 'which'],
    ['util.promisify of a namespace member', "import * as cp from 'child_process'; import * as util from 'util'; const run = util.promisify(cp.execFile); run('which');", 'which'],
    ['a default import', "import cp from 'node:child_process'; cp.spawn('tool');", 'tool'],
    ['a require', "const { execFileSync: run } = require('child_process'); run('ps');", 'ps'],
    ['a template literal', "import { spawn } from 'child_process'; const ext = '.exe'; spawn(`powershell${ext}`);", 'powershell${…}'],
    ['a wrapper whose parameter reaches the spawner', "import { spawn } from 'child_process'; function start(command: string, args: string[]) { return spawn(command, args); } start('bash', []);", 'bash'],
    ['a wrapper of a wrapper', "import { spawn } from 'child_process'; const run = (args: string[], cmd: string) => spawn(cmd, args); const outer = (c: string) => run([], c); outer('nvidia-smi');", 'nvidia-smi'],
    ['a constant', "import { spawn } from 'child_process'; const SMI = 'nvidia-smi'; spawn(SMI);", 'nvidia-smi'],
    ['either arm of a choice', "import { spawn } from 'child_process'; declare const win: boolean; spawn(win ? 'powershell.exe' : '/bin/bash');", 'powershell.exe'],
    ['a fallback', "import { spawn } from 'child_process'; declare const found: string | undefined; spawn(found ?? 'bash');", 'bash'],
  ])('sees a bare program through %s', (_case, text, program) => {
    expect(bareNameSpawnsIn('x.ts', text)).toEqual([`x.ts:1: ${program}`]);
  });

  it('accepts an absolute program and a value the guard cannot read', () => {
    const text = "import { spawn } from 'child_process'; declare const tool: string; function start(command: string) { return spawn(command); } spawn('/bin/ps'); spawn('C:\\\\Windows\\\\System32\\\\taskkill.exe'); start(tool); spawn(`${tool}/x`);";
    expect(bareNameSpawnsIn('x.ts', text)).toEqual([]);
  });
});
