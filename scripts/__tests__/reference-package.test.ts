import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
// @ts-expect-error -- plain .mjs script, no types
import { refProblem, seedGrammars } from '../../e2e/remote/support/reference-package.mjs';

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
    expect(refProblem('remote-protocol-ref', repo)).toContain('git tag remote-protocol-ref 1e8eec04 && git push origin remote-protocol-ref');
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
  const tree = (script: string, grammars: string[] = []): string => {
    const dir = tempDir('reference-tree-');
    mkdirSync(join(dir, 'scripts'), { recursive: true });
    writeFileSync(join(dir, 'scripts', 'fetch-grammars.mjs'), script);
    mkdirSync(join(dir, 'resources', 'grammars'), { recursive: true });
    for (const name of grammars) writeFileSync(join(dir, 'resources', 'grammars', name), `wasm ${name}`);
    return dir;
  };

  it('are this tree\'s when both fetch the same grammars, whatever the line ends', () => {
    const root = tree('const PKG = 1;\n', ['tree-sitter-c.wasm', 'tree-sitter-go.wasm', 'README.md']);
    const out = tree('const PKG = 1;\r\n');
    expect(seedGrammars(out, root)).toEqual(['tree-sitter-c.wasm', 'tree-sitter-go.wasm']);
    expect(readFileSync(join(out, 'resources', 'grammars', 'tree-sitter-go.wasm'), 'utf8')).toBe('wasm tree-sitter-go.wasm');
  });

  it('are left to the reference tree\'s own fetch when its script differs', () => {
    const root = tree('const PKG = 1;\n', ['tree-sitter-c.wasm']);
    expect(seedGrammars(tree('const PKG = 2;\n'), root)).toEqual([]);
  });
});
