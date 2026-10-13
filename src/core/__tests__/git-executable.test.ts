import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as ts from 'typescript';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GIT_NOT_FOUND, gitExecutable, resolveGitExecutable } from '../git-executable';

const SRC = path.join(__dirname, '..', '..');
const gitName = process.platform === 'win32' ? 'git.exe' : 'git';

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'dam-git-exe-'));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function folder(name: string, withGit: boolean): string {
  const dir = path.join(root, name);
  fs.mkdirSync(dir);
  if (withGit) fs.writeFileSync(path.join(dir, gitName), '');
  return dir;
}

const pathEnv = (...entries: string[]): Record<string, string> => ({ PATH: entries.join(path.delimiter) });

describe('resolveGitExecutable', () => {
  it('never takes a git from a relative PATH entry, which resolves against the spawn folder', () => {
    const relative = path.relative(process.cwd(), folder('planted', true));
    expect(path.isAbsolute(relative)).toBe(false);
    const empty = folder('empty', false);
    expect(resolveGitExecutable(process.platform, pathEnv(relative, '.', empty))).toBeUndefined();
  });

  it('finds git in an absolute PATH entry after relative ones', () => {
    const relative = path.relative(process.cwd(), folder('planted', true));
    const bin = folder('bin', true);
    expect(resolveGitExecutable(process.platform, pathEnv(relative, '.', bin))).toBe(path.join(bin, gitName));
  });

  it('searches again when PATH changes, as when desktop merges the login-shell PATH', () => {
    const empty = folder('empty', false);
    const bin = folder('bin', true);
    expect(resolveGitExecutable(process.platform, pathEnv(empty))).toBeUndefined();
    expect(resolveGitExecutable(process.platform, pathEnv(empty, bin))).toBe(path.join(bin, gitName));
  });

  it('reports git missing, and gitExecutable throws rather than naming a bare git', () => {
    const empty = folder('empty', false);
    const saved = process.env['PATH'];
    process.env['PATH'] = empty;
    try {
      expect(resolveGitExecutable()).toBeUndefined();
      expect(() => gitExecutable()).toThrow(GIT_NOT_FOUND);
    } finally {
      process.env['PATH'] = saved;
    }
  });
});

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === '__tests__' || entry.name === '__mocks__' ? [] : sourceFiles(full);
    return /\.[cm]?[jt]s$/.test(entry.name) && !/\.(test|spec)\.[cm]?[jt]s$/.test(entry.name) && !entry.name.endsWith('.d.ts') ? [full] : [];
  });
}

/** Calls of a spawn, exec, fork or run function whose first argument is the literal `git` (or a `git …` command line). */
function bareGitSpawns(file: string): string[] {
  const source = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
  const found: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
      const callee = node.expression;
      const name = ts.isPropertyAccessExpression(callee) ? callee.name.text : ts.isIdentifier(callee) ? callee.text : '';
      const first = node.arguments?.[0];
      if (/spawn|exec|fork|run/i.test(name) && first && ts.isStringLiteralLike(first) && /^git(\.exe)?(\s|$)/i.test(first.text)) {
        found.push(`${path.relative(SRC, file)}:${source.getLineAndCharacterOfPosition(node.getStart()).line + 1}`);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

describe('git spawns', () => {
  it('name the resolved absolute git everywhere in src outside tests, never a bare git', () => {
    expect(sourceFiles(SRC).flatMap(bareGitSpawns)).toEqual([]);
  });
});
