import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { grammarPin, refProblem, seedGrammars } from '../../e2e/remote/support/reference-package.mjs';

const ROOT = join(__dirname, '..', '..');
const SCRIPT = join(ROOT, 'e2e', 'remote', 'support', 'reference-package.mjs');
const dirs: string[] = [];
const tempDir = (prefix: string): string => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
};

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const git = (cwd: string, ...args: string[]): void => {
  const result = spawnSync('git', ['-c', 'user.name=e2e', '-c', 'user.email=e2e@example.invalid', ...args], { cwd, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`);
};

describe('the reference tag check', () => {
  it('names the owner\'s fix when the reference tag is missing, and passes once the tag names a commit', () => {
    const repo = tempDir('reference-ref-');
    git(repo, 'init', '-q');
    git(repo, 'commit', '-q', '--allow-empty', '-m', 'reference');
    expect(refProblem('remote-protocol-ref', repo)).toContain('git tag remote-protocol-ref 0c58749c && git push origin remote-protocol-ref');
    expect(refProblem('no-such-ref', repo)).toBe('no-such-ref names no commit in this clone');
    git(repo, 'tag', 'remote-protocol-ref');
    expect(refProblem('remote-protocol-ref', repo)).toBeUndefined();
  });

  it('--check fails on a ref the clone lacks before it builds anything', () => {
    const out = tempDir('reference-out-');
    const run = spawnSync(process.execPath, [SCRIPT, '--ref', 'refs/tags/no-such-reference-tag', '--check', '--target', 'linux-x64', '--out', out], { cwd: ROOT, encoding: 'utf8' });
    expect({ status: run.status, stdout: run.stdout, stderr: run.stderr.trim() }).toEqual({ status: 1, stdout: '', stderr: 'refs/tags/no-such-reference-tag names no commit in this clone' });
  });
});

describe('the reference tree\'s grammars', () => {
  const PKG = 'tree-sitter-wasms@0.1.13';
  const C_GO = ['tree-sitter-c.wasm', 'tree-sitter-go.wasm'];
  const fetchScript = (pkg: string, files: readonly string[], eol = '\n'): string =>
    [`const PKG = '${pkg}';`, '', 'const WASM_FILES = [', ...files.map((file) => `  '${file}',`), '];', ''].join(eol);
  const tree = (script: string, grammars: readonly string[] = [], name = 'fetch-grammars.ts'): string => {
    const dir = tempDir('reference-tree-');
    mkdirSync(join(dir, 'scripts'), { recursive: true });
    writeFileSync(join(dir, 'scripts', name), script);
    mkdirSync(join(dir, 'resources', 'grammars'), { recursive: true });
    for (const file of grammars) writeFileSync(join(dir, 'resources', 'grammars', file), `wasm ${file}`);
    return dir;
  };

  it('reads the pinned package and the grammar list of a fetch script', () => {
    expect(grammarPin(fetchScript(PKG, C_GO, '\r\n'))).toEqual({ pkg: PKG, files: C_GO });
    expect(grammarPin('const PKG = 1;\n')).toBeUndefined();
  });

  it('are this tree\'s when both pin the same package, whatever the line ends', () => {
    const root = tree(fetchScript(PKG, C_GO), [...C_GO, 'README.md']);
    const out = tree(fetchScript(PKG, C_GO, '\r\n'));
    expect(seedGrammars(out, root)).toEqual(C_GO);
    expect(readFileSync(join(out, 'resources', 'grammars', 'tree-sitter-go.wasm'), 'utf8')).toBe('wasm tree-sitter-go.wasm');
  });

  // The tag remote-protocol-ref predates the TypeScript scripts: its fetch script is an untyped .mjs.
  it('are seeded into a reference tree whose fetch script is the .mjs form', () => {
    const root = tree(`function fwd(p: string): string { return p; }\n${fetchScript(PKG, C_GO)}`, C_GO);
    const out = tree(`function fwd(p) { return p; }\n${fetchScript(PKG, C_GO)}`, [], 'fetch-grammars.mjs');
    expect(seedGrammars(out, root)).toEqual(C_GO);
  });

  it('are only the files on both lists', () => {
    const root = tree(fetchScript(PKG, [...C_GO, 'tree-sitter-vue.wasm']), [...C_GO, 'tree-sitter-vue.wasm']);
    expect(seedGrammars(tree(fetchScript(PKG, ['tree-sitter-go.wasm', 'tree-sitter-lua.wasm'])), root)).toEqual(['tree-sitter-go.wasm']);
  });

  it('are left to the reference tree\'s own fetch when it pins another package', () => {
    const root = tree(fetchScript(PKG, C_GO), C_GO);
    expect(seedGrammars(tree(fetchScript('tree-sitter-wasms@0.1.12', C_GO)), root)).toEqual([]);
    expect(seedGrammars(tree('const PKG = 1;\n'), root)).toEqual([]);
  });
});
