import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { worktreeFolderState } from '../integrate';

let base: string;
let folder: string;

beforeEach(() => {
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dam-folder-state-')));
  folder = path.join(base, 'worktrees', 'acme-abcdef', 'aaaa1111');
  fs.mkdirSync(folder, { recursive: true });
});
afterEach(() => {
  fs.rmSync(base, { recursive: true, force: true });
});

const linkTo = (gitDir: string): void => fs.writeFileSync(path.join(folder, '.git'), `gitdir: ${gitDir}\n`);
const record = (repositoryRoot: string) => ({ worktreeRoot: folder, repositoryRoot });

// A repository at `root` whose admin dir names the worktree back when `linked`.
function repository(root: string, linked: boolean): string {
  const adminDir = path.join(root, '.git', 'worktrees', 'aaaa1111');
  fs.mkdirSync(linked ? adminDir : path.join(root, '.git'), { recursive: true });
  if (linked) fs.writeFileSync(path.join(adminDir, 'gitdir'), `${path.join(folder, '.git')}\n`);
  return adminDir;
}

describe('worktreeFolderState', () => {
  it('is a worktree while its .git names a git dir that exists', async () => {
    linkTo(repository(path.join(base, 'repo'), true));
    expect(await worktreeFolderState(record(path.join(base, 'repo')))).toBe('worktree');
  });

  // An unmounted drive or a project moved before Locate: the worktree may still hold work git can re-link, so nothing deletes it.
  it('is unreachable when the git dir and the record\'s repository are both gone', async () => {
    linkTo(repository(path.join(base, 'repo'), true));
    fs.rmSync(path.join(base, 'repo'), { recursive: true });
    expect(await worktreeFolderState(record(path.join(base, 'repo')))).toBe('unreachable');
  });

  it('is a leftover when the record\'s repository is there and never had the worktree (a fresh clone)', async () => {
    linkTo(path.join(base, 'old', '.git', 'worktrees', 'aaaa1111'));
    repository(path.join(base, 'clone'), false);
    expect(await worktreeFolderState(record(path.join(base, 'clone')))).toBe('leftover');
  });

  it('is a worktree when the record\'s repository moved and still names it, before git repairs its .git', async () => {
    linkTo(path.join(base, 'old', '.git', 'worktrees', 'aaaa1111'));
    repository(path.join(base, 'moved'), true);
    expect(await worktreeFolderState(record(path.join(base, 'moved')))).toBe('worktree');
  });

  it('is a leftover without a .git and gone without its folder', async () => {
    expect(await worktreeFolderState(record(path.join(base, 'repo')))).toBe('leftover');
    expect(await worktreeFolderState({ worktreeRoot: path.join(base, 'missing'), repositoryRoot: path.join(base, 'repo') })).toBe('gone');
  });

  // A project on a share has its admin dirs there; that git dir is never opened here, so git decides whether to remove.
  it.runIf(process.platform === 'win32')('is a worktree when its .git names a git dir on another host', async () => {
    linkTo('\\\\server\\share\\repo\\.git\\worktrees\\aaaa1111');
    expect(await worktreeFolderState(record(path.join(base, 'repo')))).toBe('worktree');
  });
});
