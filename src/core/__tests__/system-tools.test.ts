import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as ts from 'typescript';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { findBash, findOnAbsolutePath, findPwsh, isFileOrAppAlias, posixTool, posixToolAsync, resolveSshExecutable, resolveSshKeygenExecutable, windowsPowerShell, windowsSystemTool } from '../system-tools';

const SRC = path.join(__dirname, '..', '..');

let root: string;
let cwdRoot: string | undefined;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'dam-system-tools-'));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
  if (cwdRoot !== undefined) fs.rmSync(cwdRoot, { recursive: true, force: true });
  cwdRoot = undefined;
});

function folder(name: string, ...files: string[]): string {
  const dir = path.join(root, name);
  fs.mkdirSync(dir);
  for (const file of files) fs.writeFileSync(path.join(dir, file), '');
  return dir;
}

// A relative path cannot cross drives, so a folder a relative value names is made under the working folder, not temp.
function relativeFolder(name: string, ...files: string[]): string {
  if (cwdRoot === undefined) {
    const scratch = path.join(process.cwd(), 'node_modules', '.cache');
    fs.mkdirSync(scratch, { recursive: true });
    cwdRoot = fs.mkdtempSync(path.join(scratch, 'dam-system-tools-'));
  }
  const dir = path.join(cwdRoot, name);
  fs.mkdirSync(dir);
  for (const file of files) fs.writeFileSync(path.join(dir, file), '');
  return path.relative(process.cwd(), dir);
}

// Each key is a link whose target stat fails with its error code; every other path reaches the real file system.
function linksWithFailingTarget(links: Readonly<Record<string, string>>): void {
  const realLstat = fs.promises.lstat;
  const realStat = fs.promises.stat;
  vi.spyOn(fs.promises, 'lstat').mockImplementation(((file: fs.PathLike, ...rest: unknown[]) =>
    links[String(file)] !== undefined
      ? Promise.resolve({ isSymbolicLink: () => true, isFile: () => false } as fs.Stats)
      : (realLstat as (...args: unknown[]) => Promise<fs.Stats>)(file, ...rest)) as typeof fs.promises.lstat);
  vi.spyOn(fs.promises, 'stat').mockImplementation(((file: fs.PathLike, ...rest: unknown[]) => {
    const code = links[String(file)];
    return code !== undefined
      ? Promise.reject(Object.assign(new Error(`${code}: ${String(file)}`), { code }))
      : (realStat as (...args: unknown[]) => Promise<fs.Stats>)(file, ...rest);
  }) as typeof fs.promises.stat);
}

async function onPlatform<T>(platform: NodeJS.Platform, run: () => Promise<T>): Promise<T> {
  const real = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
  try {
    return await run();
  } finally {
    if (real) Object.defineProperty(process, 'platform', real);
  }
}

const pathEnv = (...entries: string[]): Record<string, string> => ({ PATH: entries.join(path.delimiter) });

// The tool this machine's OpenSSH installed, as the fallback folders find it, or undefined on a machine without it.
const installedTool = (name: string): string | undefined => ['/usr/bin', '/bin'].map((dir) => path.posix.join(dir, name)).find((file) => fs.existsSync(file) && fs.statSync(file).isFile());

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
    const relative = relativeFolder('planted', name);
    expect(path.isAbsolute(relative)).toBe(false);
    expect(findOnAbsolutePath(name, process.platform, pathEnv(relative, '.', folder('empty')))).toBeUndefined();
  });

  it('finds the tool in the first absolute PATH entry that holds it', () => {
    const name = process.platform === 'win32' ? 'ps.exe' : 'ps';
    const relative = relativeFolder('planted', name);
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

  it.skipIf(process.platform === 'win32')('posixToolAsync finds what posixTool finds, never in a relative PATH folder', async () => {
    const bin = folder('bin', 'ldconfig');
    const sbin = folder('sbin', 'ldconfig', 'bash');
    const relative = relativeFolder('planted-bash', 'bash');
    expect(await posixToolAsync('ldconfig', pathEnv(bin), [sbin])).toBe(path.join(bin, 'ldconfig'));
    expect(await posixToolAsync('bash', pathEnv(relative, bin), [sbin])).toBe(path.join(sbin, 'bash'));
    expect(await posixToolAsync('bash', pathEnv(relative, bin), [folder('empty')])).toBeUndefined();
  });
});

describe.runIf(process.platform === 'win32')('findBash', () => {
  const gitBash = (programFiles: string): string => {
    fs.mkdirSync(path.join(programFiles, 'Git', 'bin'), { recursive: true });
    fs.writeFileSync(path.join(programFiles, 'Git', 'bin', 'bash.exe'), '');
    return path.join(programFiles, 'Git', 'bin', 'bash.exe');
  };

  it('takes Git for Windows\' bash before PATH, Program Files before Program Files (x86), as pi does', async () => {
    const x86 = folder('pf86');
    const onPath = folder('msys', 'bash.exe');
    expect(await findBash({ 'ProgramFiles(x86)': x86, PATH: onPath })).toBe(path.join(onPath, 'bash.exe'));
    const x86Bash = gitBash(x86);
    expect(await findBash({ 'ProgramFiles(x86)': x86, PATH: onPath })).toBe(x86Bash);
    const native = folder('pf');
    expect(await findBash({ ProgramFiles: native, 'ProgramFiles(x86)': x86, PATH: onPath })).toBe(x86Bash);
    const nativeBash = gitBash(native);
    expect(await findBash({ ProgramFiles: native, 'ProgramFiles(x86)': x86, PATH: onPath })).toBe(nativeBash);
  });

  it('falls back to an absolute PATH folder, never a relative one or a relative Program Files', async () => {
    const relative = relativeFolder('planted', 'bash.exe');
    const relativeRoot = relativeFolder('rel-pf');
    gitBash(path.resolve(relativeRoot));
    const env = { ProgramFiles: relativeRoot, PATH: [relative, folder('empty')].join(';') };
    expect(await findBash(env)).toBeUndefined();
    const msys = folder('msys', 'bash.exe');
    expect(await findBash({ ...env, PATH: [relative, msys].join(';') })).toBe(path.join(msys, 'bash.exe'));
  });
});

describe('resolveSshExecutable', () => {
  it.runIf(process.platform === 'win32')('takes an absolute PATH folder\'s ssh.exe, else Windows\' own OpenSSH client, never a relative folder', async () => {
    const systemRoot = folder('Windows');
    const relative = relativeFolder('planted-ssh', 'ssh.exe');
    expect(await resolveSshExecutable({ SystemRoot: systemRoot, PATH: relative }, 'win32')).toBeUndefined();
    fs.mkdirSync(path.join(systemRoot, 'System32', 'OpenSSH'), { recursive: true });
    fs.writeFileSync(path.join(systemRoot, 'System32', 'OpenSSH', 'ssh.exe'), '');
    expect(await resolveSshExecutable({ SystemRoot: systemRoot, PATH: relative }, 'win32')).toBe(path.join(systemRoot, 'System32', 'OpenSSH', 'ssh.exe'));
    const onPath = folder('openssh', 'ssh.exe');
    expect(await resolveSshExecutable({ SystemRoot: systemRoot, PATH: [relative, onPath].join(';') }, 'win32')).toBe(path.join(onPath, 'ssh.exe'));
  });

  it.runIf(process.platform !== 'win32')('takes an absolute PATH folder\'s ssh, never a relative folder\'s, else the one OpenSSH installs in /usr/bin', async () => {
    const relative = relativeFolder('planted-ssh', 'ssh');
    const onPath = folder('bin', 'ssh');
    expect(await resolveSshExecutable({ PATH: [relative, onPath].join(':') }, process.platform)).toBe(path.join(onPath, 'ssh'));
    expect(await resolveSshExecutable({ PATH: [relative, folder('empty')].join(':') }, process.platform)).toBe(installedTool('ssh'));
  });
});

describe('resolveSshKeygenExecutable', () => {
  it.runIf(process.platform === 'win32')('takes an absolute PATH folder\'s ssh-keygen.exe, else Windows\' own OpenSSH one, never a relative folder', async () => {
    const systemRoot = folder('Windows');
    const relative = relativeFolder('planted-keygen', 'ssh-keygen.exe');
    expect(await resolveSshKeygenExecutable({ SystemRoot: systemRoot, PATH: relative }, 'win32')).toBeUndefined();
    fs.mkdirSync(path.join(systemRoot, 'System32', 'OpenSSH'), { recursive: true });
    fs.writeFileSync(path.join(systemRoot, 'System32', 'OpenSSH', 'ssh-keygen.exe'), '');
    expect(await resolveSshKeygenExecutable({ SystemRoot: systemRoot, PATH: relative }, 'win32')).toBe(path.join(systemRoot, 'System32', 'OpenSSH', 'ssh-keygen.exe'));
    const onPath = folder('openssh-keygen', 'ssh-keygen.exe');
    expect(await resolveSshKeygenExecutable({ SystemRoot: systemRoot, PATH: [relative, onPath].join(';') }, 'win32')).toBe(path.join(onPath, 'ssh-keygen.exe'));
  });

  it.runIf(process.platform !== 'win32')('takes an absolute PATH folder\'s ssh-keygen, never a relative folder\'s, else the one OpenSSH installs in /usr/bin', async () => {
    const relative = relativeFolder('planted-keygen', 'ssh-keygen');
    const onPath = folder('keygen-bin', 'ssh-keygen');
    expect(await resolveSshKeygenExecutable({ PATH: [relative, onPath].join(':') }, process.platform)).toBe(path.join(onPath, 'ssh-keygen'));
    expect(await resolveSshKeygenExecutable({ PATH: [relative, folder('keygen-empty')].join(':') }, process.platform)).toBe(installedTool('ssh-keygen'));
  });
});

describe.runIf(process.platform === 'win32')('findPwsh', () => {
  const installPwsh7 = (programFiles: string): string => {
    const file = path.join(programFiles, 'PowerShell', '7', 'pwsh.exe');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '');
    return file;
  };

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('takes pwsh from an absolute PATH folder before Program Files', async () => {
    const programFiles = folder('pf');
    installPwsh7(programFiles);
    const onPath = folder('ps7', 'pwsh.exe');
    expect(await findPwsh({ ProgramFiles: programFiles, PATH: onPath })).toBe(path.join(onPath, 'pwsh.exe'));
  });

  it('finds PowerShell 7 in Program Files when no PATH folder holds pwsh', async () => {
    const programFiles = folder('pf');
    expect(await findPwsh({ ProgramFiles: programFiles, PATH: folder('empty') })).toBeUndefined();
    const installed = installPwsh7(programFiles);
    expect(await findPwsh({ ProgramFiles: programFiles, PATH: folder('empty2') })).toBe(installed);
  });

  it('ignores a relative or UNC Program Files', async () => {
    const relativeRoot = relativeFolder('rel-pf');
    installPwsh7(path.resolve(relativeRoot));
    expect(await findPwsh({ ProgramFiles: relativeRoot, PATH: folder('empty') })).toBeUndefined();
    expect(await findPwsh({ ProgramFiles: '\\\\host\\share\\Program Files', PATH: folder('empty2') })).toBeUndefined();
  });

  it('skips a PATH pwsh.exe link whose target fails for a reason an app execution alias never gives', async () => {
    const onPath = folder('ps7');
    linksWithFailingTarget({ [path.join(onPath, 'pwsh.exe')]: 'ELOOP' });
    const programFiles = folder('pf');
    const installed = installPwsh7(programFiles);
    expect(await findPwsh({ ProgramFiles: programFiles, PATH: onPath })).toBe(installed);
  });

  it('accepts a Store alias for pwsh, which findBash never takes for bash', async () => {
    const apps = folder('WindowsApps');
    const aliases = new Set([path.join(apps, 'pwsh.exe'), path.join(apps, 'bash.exe')]);
    const realLstat = fs.promises.lstat;
    const realStat = fs.promises.stat;
    const eacces = (file: string): Error => Object.assign(new Error(`EACCES: ${file}`), { code: 'EACCES' });
    vi.spyOn(fs.promises, 'lstat').mockImplementation(((file: fs.PathLike, ...rest: unknown[]) =>
      aliases.has(String(file))
        ? Promise.resolve({ isSymbolicLink: () => true, isFile: () => false } as fs.Stats)
        : (realLstat as (...args: unknown[]) => Promise<fs.Stats>)(file, ...rest)) as typeof fs.promises.lstat);
    vi.spyOn(fs.promises, 'stat').mockImplementation(((file: fs.PathLike, ...rest: unknown[]) =>
      aliases.has(String(file)) ? Promise.reject(eacces(String(file))) : (realStat as (...args: unknown[]) => Promise<fs.Stats>)(file, ...rest)) as typeof fs.promises.stat);

    expect(await findPwsh({ ProgramFiles: folder('pf'), PATH: apps })).toBe(path.join(apps, 'pwsh.exe'));
    expect(await findBash({ PATH: apps })).toBeUndefined();
  });
});

describe('isFileOrAppAlias', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('answers for a file, a folder and a missing path', async () => {
    const dir = folder('things', 'tool.exe');
    expect(await isFileOrAppAlias(path.join(dir, 'tool.exe'))).toBe(true);
    expect(await isFileOrAppAlias(dir)).toBe(false);
    expect(await isFileOrAppAlias(path.join(dir, 'missing.exe'))).toBe(false);
    expect(await isFileOrAppAlias(path.join(dir, 'tool.exe', 'below'))).toBe(false);
  });

  it('rejects when lstat fails for a reason other than a missing path', async () => {
    vi.spyOn(fs.promises, 'lstat').mockRejectedValue(Object.assign(new Error('EACCES'), { code: 'EACCES' }));
    await expect(isFileOrAppAlias(path.join(root, 'locked.exe'))).rejects.toThrow('EACCES');
  });

  it('takes a link whose target stat fails with EACCES as an app execution alias on Windows only, and rejects other failures', async () => {
    const eacces = path.join(root, 'alias.exe');
    const eloop = path.join(root, 'loop.exe');
    const broken = path.join(root, 'broken.exe');
    linksWithFailingTarget({ [eacces]: 'EACCES', [eloop]: 'ELOOP', [broken]: 'ENOENT' });
    for (const platform of ['win32', 'linux', 'darwin'] as const) {
      await onPlatform(platform, async () => {
        if (platform === 'win32') expect(await isFileOrAppAlias(eacces)).toBe(true);
        else await expect(isFileOrAppAlias(eacces)).rejects.toThrow('EACCES');
        await expect(isFileOrAppAlias(eloop)).rejects.toThrow('ELOOP');
        expect(await isFileOrAppAlias(broken)).toBe(false);
      });
    }
  });

  it.runIf(process.platform === 'win32')('takes a real app execution alias', async (ctx) => {
    const localAppData = process.env['LOCALAPPDATA'];
    const apps = localAppData === undefined ? undefined : path.join(localAppData, 'Microsoft', 'WindowsApps');
    const alias = apps !== undefined && fs.existsSync(apps) ? fs.readdirSync(apps).find((name) => name.endsWith('.exe')) : undefined;
    if (apps === undefined || alias === undefined) return ctx.skip();
    expect(await isFileOrAppAlias(path.join(apps, alias))).toBe(true);
  });
});

describe('findPwsh off Windows', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('takes no PATH pwsh link whose target stat fails, since only Windows has app execution aliases', async () => {
    linksWithFailingTarget({ '/opt/ps/pwsh': 'EACCES' });
    expect(await onPlatform('linux', () => findPwsh({ PATH: '/opt/ps' }))).toBeUndefined();
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

// `run` is the name an injected runProcess takes (`deps.run({ file, ... })`)
const LAUNCH_CALLS = new Set(['launch', 'runProcess', 'run']);

/** The `file` of a process launcher start, `launcher.launch({ file, ... })`, `runProcess({ file, ... })` or `deps.run({ file, ... })`, else undefined. */
function launchedFile(node: ts.CallExpression): ts.Expression | undefined {
  const callee = node.expression;
  const name = ts.isIdentifier(callee) ? callee.text : ts.isPropertyAccessExpression(callee) ? callee.name.text : undefined;
  const [spec] = node.arguments;
  if (name === undefined || !LAUNCH_CALLS.has(name) || !spec || !ts.isObjectLiteralExpression(spec)) return undefined;
  for (const property of spec.properties) {
    if (ts.isPropertyAssignment(property) && ts.isIdentifier(property.name) && property.name.text === 'file') return property.initializer;
    if (ts.isShorthandPropertyAssignment(property) && property.name.text === 'file') return property.name;
  }
  return undefined;
}

/** The expression naming the program a call starts, when it is a spawner or a launcher start. */
function programOf(node: ts.CallExpression, spawners: Spawners): ts.Expression | undefined {
  const index = programIndex(node.expression, spawners);
  return index === undefined ? launchedFile(node) : node.arguments[index];
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
      // `const probe = opts.probe ?? defaultProbe` starts what the spawner it may hold starts
      const aliased = ts.isIdentifier(declaration.name) && init ? calleeArms(init).find((arm) => spawners.calls.has(arm)) : undefined;
      if (aliased !== undefined && ts.isIdentifier(declaration.name)) spawners.calls.set(declaration.name.text, spawners.calls.get(aliased)!);
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
          const program = programOf(node, spawners);
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

/** The identifiers an expression may call through: itself, or every arm of a choice or fallback. */
function calleeArms(expr: ts.Expression): string[] {
  const inner = unwrap(expr);
  if (ts.isIdentifier(inner)) return [inner.text];
  if (ts.isConditionalExpression(inner)) return [...calleeArms(inner.whenTrue), ...calleeArms(inner.whenFalse)];
  if (ts.isBinaryExpression(inner) && (inner.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken || inner.operatorToken.kind === ts.SyntaxKind.BarBarToken)) {
    return [...calleeArms(inner.left), ...calleeArms(inner.right)];
  }
  return [];
}

const isAbsoluteProgram = (text: string): boolean => path.posix.isAbsolute(text) || path.win32.isAbsolute(text);

// A file constant holds its initializer; a `for...of` loop variable, used inside its loop, holds the expression it iterates;
// a call of a file function yields what its return statements do.
interface Bindings {
  readonly constants: ReadonlyMap<string, ts.Expression>;
  readonly loops: ReadonlyMap<string, readonly ts.ForOfStatement[]>;
  readonly functions: ReadonlyMap<string, FunctionLike>;
}

/** The expressions a function returns: its own return statements, nested functions excluded, or an arrow's expression body. */
function returnedBy(fn: FunctionLike): ts.Expression[] {
  if (fn.body === undefined) return [];
  if (!ts.isBlock(fn.body)) return [fn.body];
  const found: ts.Expression[] = [];
  const visit = (node: ts.Node): void => {
    if (isFunctionLike(node)) return;
    if (ts.isReturnStatement(node) && node.expression) found.push(node.expression);
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(fn.body, visit);
  return found;
}

/** The object literals an expression can be: directly, through a file constant, or as an element a `for...of` variable takes. */
function objectLiterals(expr: ts.Expression, bindings: Bindings, depth: number): ts.ObjectLiteralExpression[] {
  const inner = unwrap(expr);
  if (ts.isObjectLiteralExpression(inner)) return [inner];
  if (!ts.isIdentifier(inner) || depth >= 8) return [];
  const constant = bindings.constants.get(inner.text);
  if (constant) return objectLiterals(constant, bindings, depth + 1);
  const iterated = iteratedBy(inner, bindings);
  return iterated ? iteratedElements(iterated, bindings, depth + 1).flatMap((element) => objectLiterals(element, bindings, depth + 1)) : [];
}

/** The value a named property has in an object literal, or undefined. */
function propertyValue(object: ts.ObjectLiteralExpression, name: string): ts.Expression | undefined {
  for (const property of object.properties) {
    if (ts.isPropertyAssignment(property) && (ts.isIdentifier(property.name) || ts.isStringLiteralLike(property.name)) && property.name.text === name) return property.initializer;
    if (ts.isShorthandPropertyAssignment(property) && property.name.text === name) return property.name;
  }
  return undefined;
}

function iteratedBy(use: ts.Identifier, bindings: Bindings): ts.Expression | undefined {
  return bindings.loops.get(use.text)?.find((loop) => use.pos >= loop.statement.pos && use.end <= loop.statement.end)?.expression;
}

const unwrap = (expr: ts.Expression): ts.Expression =>
  ts.isParenthesizedExpression(expr) || ts.isAsExpression(expr) || ts.isNonNullExpression(expr) || ts.isSatisfiesExpression(expr) ? unwrap(expr.expression) : expr;

/**
 * The elements an iterated expression can yield: an array literal's, spreads included, directly, through a file constant or
 * as returned by a call of a file function.
 */
function iteratedElements(expr: ts.Expression, bindings: Bindings, depth: number): ts.Expression[] {
  const inner = unwrap(expr);
  if (ts.isArrayLiteralExpression(inner)) return inner.elements.flatMap((element) => (ts.isSpreadElement(element) ? iteratedElements(element.expression, bindings, depth) : [element]));
  if (depth >= 8) return [];
  const fn = ts.isCallExpression(inner) && ts.isIdentifier(inner.expression) ? bindings.functions.get(inner.expression.text) : undefined;
  if (fn) return returnedBy(fn).flatMap((returned) => iteratedElements(returned, bindings, depth + 1));
  const constant = ts.isIdentifier(inner) ? bindings.constants.get(inner.text) : undefined;
  return constant ? iteratedElements(constant, bindings, depth + 1) : [];
}

/**
 * The bare program names an expression can evaluate to: literals, templates by their leading text, every arm of a choice or
 * fallback, file constants, each element a `for...of` loop variable takes from an array literal, and a property read off the
 * object literals such an element or constant can be.
 */
function barePrograms(expr: ts.Expression, bindings: Bindings, depth = 0): string[] {
  if (ts.isParenthesizedExpression(expr) || ts.isAsExpression(expr) || ts.isNonNullExpression(expr) || ts.isSatisfiesExpression(expr)) return barePrograms(expr.expression, bindings, depth);
  if (ts.isPropertyAccessExpression(expr) && depth < 8) {
    return objectLiterals(expr.expression, bindings, depth + 1).flatMap((object) => {
      const value = propertyValue(object, expr.name.text);
      return value ? barePrograms(value, bindings, depth + 1) : [];
    });
  }
  if (ts.isStringLiteralLike(expr)) return isAbsoluteProgram(expr.text) ? [] : [expr.text];
  // a template starting with a substitution is as absolute as that value, which the guard cannot know
  if (ts.isTemplateExpression(expr)) return expr.head.text === '' || isAbsoluteProgram(expr.head.text) ? [] : [`${expr.head.text}\${…}`];
  if (ts.isConditionalExpression(expr)) return [...barePrograms(expr.whenTrue, bindings, depth), ...barePrograms(expr.whenFalse, bindings, depth)];
  if (ts.isBinaryExpression(expr) && (expr.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken || expr.operatorToken.kind === ts.SyntaxKind.BarBarToken)) {
    return [...barePrograms(expr.left, bindings, depth), ...barePrograms(expr.right, bindings, depth)];
  }
  if (!ts.isIdentifier(expr) || depth >= 8) return [];
  const constant = bindings.constants.get(expr.text);
  if (constant) return barePrograms(constant, bindings, depth + 1);
  const iterated = iteratedBy(expr, bindings);
  return iterated ? iteratedElements(iterated, bindings, depth + 1).flatMap((element) => barePrograms(element, bindings, depth + 1)) : [];
}

/** Every spawner call in one source text whose program can be a name that is not an absolute path. */
function bareNameSpawnsIn(file: string, text: string): string[] {
  // A file naming neither seed of `fileSpawners` has no spawner, so it is not parsed.
  if (!/child_process|exec['"`]|launch\(|runProcess\(|\brun\(/.test(text)) return [];
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const spawners = fileSpawners(source);
  const constants = new Map<string, ts.Expression>();
  const loops = new Map<string, ts.ForOfStatement[]>();
  const functions = new Map<string, FunctionLike>();
  const collect = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer && (ts.getCombinedNodeFlags(node) & ts.NodeFlags.Const) !== 0) constants.set(node.name.text, node.initializer);
    if (ts.isFunctionDeclaration(node) && node.name) functions.set(node.name.text, node);
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && isFunctionLike(node.initializer)) functions.set(node.name.text, node.initializer);
    if (ts.isForOfStatement(node) && ts.isVariableDeclarationList(node.initializer)) {
      for (const declaration of node.initializer.declarations) if (ts.isIdentifier(declaration.name)) loops.set(declaration.name.text, [...(loops.get(declaration.name.text) ?? []), node]);
    }
    ts.forEachChild(node, collect);
  };
  collect(source);
  const bindings: Bindings = { constants, loops, functions };
  const found: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const program = programOf(node, spawners);
      for (const name of program ? barePrograms(program, bindings) : []) found.push(`${file}:${source.getLineAndCharacterOfPosition(node.getStart()).line + 1}: ${name}`);
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
    ['a checkpoint exec helper', "import { execSafe } from '../checkpoints/exec'; execSafe('git', ['status']);", 'git'],
    ['a launcher start', "processLauncher().launch({ file: 'rg', args: [] });", 'rg'],
    ['a collected launcher start', "const SMI = 'nvidia-smi'; runProcess({ file: SMI, args: [] });", 'nvidia-smi'],
    ['a launcher start naming its file by shorthand', "const file = 'npm'; launcher.launch({ file, args: [] });", 'npm'],
    ['a wrapper whose parameter is a launcher start\'s file', "function run(cmd: string) { return processLauncher().launch({ file: cmd, args: [] }); } run('ldconfig');", 'ldconfig'],
    ['a for...of over a constant array', "const EXES = ['/bin/pwsh', 'pwsh'] as const; function run(exe: string) { return processLauncher().launch({ file: exe, args: [] }); } for (const exe of EXES) run(exe);", 'pwsh'],
    ['a for...of over an array literal with a spread', "const MORE = ['powershell.exe']; for (const exe of ['/bin/sh', ...MORE]) runProcess({ file: exe, args: [] });", 'powershell.exe'],
    [
      'a property of the objects a file function returns, iterated and started through a fallback alias',
      "function candidates(mac: boolean) { if (mac) return [{ cc: 'clang', cxx: '/usr/bin/clang++' }]; return [{ cc: 'gcc', cxx: 'g++' }]; } async function probeOne(cxx: string) { return runProcess({ file: cxx, args: [] }); } async function ensure(opts: { probe?: typeof probeOne }) { const probe = opts.probe ?? probeOne; const list = candidates(false); for (const candidate of list) await probe(candidate.cxx); }",
      'g++',
    ],
    ['a property of a constant object', "const TOOL = { file: 'nvidia-smi' }; runProcess({ file: TOOL.file, args: [] });", 'nvidia-smi'],
    ['an injected runner', "async function install(deps: Deps) { await deps.run({ file: 'restorecon', args: [] }, { timeoutMs: 1 }); }", 'restorecon'],
    ['a local runner', "const run = deps.run ?? runProcess; const LOGINCTL = 'loginctl'; run({ file: LOGINCTL, args: [] }, { timeoutMs: 1 });", 'loginctl'],
  ])('sees a bare program through %s', (_case, text, program) => {
    expect(bareNameSpawnsIn('x.ts', text)).toEqual([`x.ts:1: ${program}`]);
  });

  it('accepts an absolute program and a value the guard cannot read', () => {
    const text = "import { spawn } from 'child_process'; declare const tool: string; function start(command: string) { return spawn(command); } spawn('/bin/ps'); spawn('C:\\\\Windows\\\\System32\\\\taskkill.exe'); start(tool); spawn(`${tool}/x`);";
    expect(bareNameSpawnsIn('x.ts', text)).toEqual([]);
  });
});
