import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { folderTrust } from '../index';
import { runRepairStep } from '../steps/repair';

let base: string;
let repository: string;
let worktree: string;

// A repository whose chat worktree's .git names an admin dir of the folder the repository was moved from.
beforeEach(() => {
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dam-folder-trust-')));
  repository = path.join(base, 'new', 'repo');
  worktree = path.join(base, 'worktrees', 'repo-abcdef', 'aaaa1111');
  fs.mkdirSync(path.join(repository, '.git', 'worktrees'), { recursive: true });
  fs.mkdirSync(worktree, { recursive: true });
  fs.writeFileSync(path.join(worktree, '.git'), `gitdir: ${path.join(base, 'old', 'repo', '.git', 'worktrees', 'aaaa1111')}\n`);
});
afterEach(() => {
  fs.rmSync(base, { recursive: true, force: true });
});

const windowTrusted = { isTrusted: () => true, onDidChangeTrust: () => ({ dispose: () => undefined }) };

describe('folderTrust', () => {
  it('a window-wide trust runs no repair git in a moved folder the window does not have open', async () => {
    const git = vi.fn(async () => ({ code: 0, stdout: '', stderr: '' }));
    const trust = folderTrust(windowTrusted, { folders: () => [{ fsPath: path.join(base, 'unrelated'), name: 'unrelated' }] });
    const outcome = await runRepairStep({ project: repository, repository, worktrees: [{ worktreeId: 'aaaa1111', root: worktree }], log: () => undefined }, { isTrusted: (folder) => trust.isTrusted(folder), git });
    expect(outcome).toEqual({ kind: 'waiting', failure: { code: 'untrusted', params: { count: 1 } } });
    expect(git).not.toHaveBeenCalled();
  });

  it('trusts an open folder of a trusted window, and nothing in an untrusted one', () => {
    const folders = { folders: () => [{ fsPath: repository, name: 'repo' }] };
    expect(folderTrust(windowTrusted, folders).isTrusted(repository)).toBe(true);
    expect(folderTrust({ ...windowTrusted, isTrusted: () => false }, folders).isTrusted(repository)).toBe(false);
  });
});
