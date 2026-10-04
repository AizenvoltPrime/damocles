import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import type * as FsPromises from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

vi.mock('../../logger', () => ({ log: vi.fn() }));

// Counts HEAD opens and the handles still open, so a test can wait for a re-read that changes nothing.
const headReads = vi.hoisted(() => ({ opened: 0, open: 0 }));
vi.mock('fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof FsPromises>();
  const open: typeof actual.open = async (file, ...rest) => {
    const handle = await actual.open(file, ...rest);
    if (!/[\\/]HEAD$/.test(String(file))) return handle;
    headReads.opened++;
    headReads.open++;
    const close = handle.close.bind(handle);
    handle.close = async () => {
      try { await close(); } finally { headReads.open--; }
    };
    return handle;
  };
  return { ...actual, open, default: { ...actual, open } };
});

import { BranchTracker, findGitDir, parseHead, readHead } from '../git-head';
import { WorkspaceFolderRegistry } from '../folder-registry';
import { createFakePlatform, type FakePlatform } from '../../../__mocks__/fake-platform';

const SHA1 = '0123456789abcdef0123456789abcdef01234567';
const SHA256 = 'f'.repeat(64);

let root: string;

function write(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

/** A repository at `dir` whose HEAD holds `head`. */
function repo(dir: string, head = 'ref: refs/heads/main\n'): string {
  const gitDir = path.join(dir, '.git');
  write(path.join(gitDir, 'HEAD'), head);
  return gitDir;
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'git-head-'));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('parseHead', () => {
  it('names the branch a symbolic ref points at, with LF or CRLF', () => {
    expect(parseHead('ref: refs/heads/main\n')).toBe('main');
    expect(parseHead('ref: refs/heads/feature/x\r\n')).toBe('feature/x');
  });

  it('shortens a detached SHA-1 or SHA-256 HEAD to seven characters', () => {
    expect(parseHead(`${SHA1}\n`)).toBe('0123456');
    expect(parseHead(SHA256)).toBe('fffffff');
  });

  it('gives no branch for content git would not write', () => {
    for (const text of ['', 'garbage\n', 'ref: refs/tags/v1\n', `${SHA1}\nextra\n`, 'ref: refs/heads/\n', SHA1.toUpperCase()]) {
      expect(parseHead(text), JSON.stringify(text)).toBeUndefined();
    }
  });

  it('refuses names that are overlong, carry control or bidi-override characters, or that git refuses', () => {
    expect(parseHead(`ref: refs/heads/${'a'.repeat(255)}`)).toBe('a'.repeat(255));
    expect(parseHead(`ref: refs/heads/${'a'.repeat(256)}`)).toBeUndefined();
    expect(parseHead('ref: refs/heads/a\u0007b')).toBeUndefined();
    expect(parseHead('ref: refs/heads/main\u202Egnp')).toBeUndefined();
    expect(parseHead('ref: refs/heads/a..b')).toBeUndefined();
    expect(parseHead('ref: refs/heads/x.lock')).toBeUndefined();
    // The reftable backend keeps this placeholder in HEAD; the real HEAD lives in the reftable.
    expect(parseHead('ref: refs/heads/.invalid\n')).toBeUndefined();
  });

  it('applies every git check-ref-format rule to the branch name', () => {
    for (const name of ['a b', 'a~1', 'a^2', 'a:b', 'a?', 'a*', 'a[b', 'a\\b', 'a\u007fb', 'a.', '@', 'a@{1}', 'a//b', '/a', 'a/', 'a/.b']) {
      expect(parseHead(`ref: refs/heads/${name}\n`), JSON.stringify(name)).toBeUndefined();
    }
    for (const name of ['feature/x-1_2', 'release@v2', 'a.b', 'ünïcode', 'v1.2/fix']) {
      expect(parseHead(`ref: refs/heads/${name}\n`), JSON.stringify(name)).toBe(name);
    }
  });
});

describe('findGitDir and readHead', () => {
  it('finds a .git folder in the folder itself', async () => {
    const gitDir = repo(root);
    expect(await findGitDir(root)).toBe(gitDir);
    expect(await readHead(gitDir)).toBe('main');
  });

  it('finds the repository above a project opened at a subfolder', async () => {
    const gitDir = repo(root);
    const sub = path.join(root, 'packages', 'app');
    fs.mkdirSync(sub, { recursive: true });
    expect(await findGitDir(sub)).toBe(gitDir);
  });

  it('follows a .git file with a relative gitdir, as a submodule has', async () => {
    const modules = path.join(root, '.git', 'modules', 'sub');
    write(path.join(modules, 'HEAD'), 'ref: refs/heads/sub-branch\n');
    write(path.join(root, 'sub', '.git'), 'gitdir: ../.git/modules/sub\n');
    const gitDir = await findGitDir(path.join(root, 'sub'));
    expect(gitDir).toBe(modules);
    expect(await readHead(gitDir!)).toBe('sub-branch');
  });

  it('follows a .git file with an absolute gitdir, as a linked worktree has, and reads its own HEAD', async () => {
    repo(path.join(root, 'main'));
    const worktreeGitDir = path.join(root, 'main', '.git', 'worktrees', 'wt');
    write(path.join(worktreeGitDir, 'HEAD'), 'ref: refs/heads/damocles/fix-login\n');
    write(path.join(root, 'wt', '.git'), `gitdir: ${worktreeGitDir}\r\n`);
    expect(await findGitDir(path.join(root, 'wt'))).toBe(worktreeGitDir);
    expect(await readHead(worktreeGitDir)).toBe('damocles/fix-login');
  });

  it('stops at a malformed .git file instead of looking further up', async () => {
    repo(root);
    write(path.join(root, 'inner', '.git'), 'not a gitdir line\n');
    expect(await findGitDir(path.join(root, 'inner'))).toBeUndefined();
  });

  it('gives no branch for an oversized HEAD', async () => {
    const gitDir = repo(root, `ref: refs/heads/${'a'.repeat(2000)}\n`);
    expect(await readHead(gitDir)).toBeUndefined();
  });

  it('gives no branch for a HEAD that is not a regular file', async () => {
    const gitDir = path.join(root, '.git');
    fs.mkdirSync(path.join(gitDir, 'HEAD'), { recursive: true });
    expect(await readHead(gitDir)).toBeUndefined();
  });

  it.skipIf(process.platform === 'win32')('reads a FIFO named HEAD as nothing, without blocking on it', async () => {
    const gitDir = path.join(root, '.git');
    fs.mkdirSync(gitDir);
    execFileSync('mkfifo', [path.join(gitDir, 'HEAD')]);
    expect(await readHead(gitDir)).toBeUndefined();
  });

  it.runIf(process.platform === 'win32')('refuses a gitdir on another host or in the device namespace', async () => {
    for (const target of ['\\\\attacker.example\\share', '//attacker.example/share', '\\\\?\\C:\\repo\\.git', '\\\\.\\pipe\\x']) {
      write(path.join(root, 'wt', '.git'), `gitdir: ${target}\n`);
      expect(await findGitDir(path.join(root, 'wt')), target).toBeUndefined();
    }
  });

  it('finds no repository for a folder outside git', async (ctx) => {
    // A temp dir inside someone's git-tracked home cannot show this.
    if (await findGitDir(os.tmpdir())) ctx.skip();
    expect(await findGitDir(root)).toBeUndefined();
  });
});

describe('BranchTracker', () => {
  let fake: FakePlatform;

  beforeEach(() => {
    fake = createFakePlatform();
  });

  it('reads the branch, then re-reads it when the HEAD watcher fires', async () => {
    const gitDir = repo(root);
    const onChange = vi.fn();
    const tracker = new BranchTracker(fake.fileWatchers, onChange);
    tracker.setFolders([root]);
    await vi.waitFor(() => expect(tracker.branchOf(root)).toBe('main'));
    expect(onChange).toHaveBeenCalledTimes(1);

    fs.writeFileSync(path.join(gitDir, 'HEAD'), 'ref: refs/heads/feature/x\n');
    fake.fileWatchers.watcher(gitDir, 'HEAD').fireCreate(path.join(gitDir, 'HEAD'));
    await vi.waitFor(() => expect(tracker.branchOf(root)).toBe('feature/x'));
    expect(onChange).toHaveBeenCalledTimes(2);

    // An unchanged HEAD reports nothing: wait until that re-read has opened and closed HEAD before counting.
    const opensBefore = headReads.opened;
    fake.fileWatchers.watcher(gitDir, 'HEAD').fireChange(path.join(gitDir, 'HEAD'));
    await vi.waitFor(() => expect([headReads.opened - opensBefore, headReads.open]).toEqual([1, 0]));
    expect(onChange).toHaveBeenCalledTimes(2);
    tracker.dispose();
  });

  it('stops watching a folder it no longer tracks', async () => {
    const gitDir = repo(root);
    const tracker = new BranchTracker(fake.fileWatchers, () => undefined);
    tracker.setFolders([root]);
    await vi.waitFor(() => expect(tracker.branchOf(root)).toBe('main'));
    const watcher = fake.fileWatchers.watcher(gitDir, 'HEAD');
    tracker.setFolders([]);
    expect(watcher.disposed).toBe(true);
    expect(tracker.branchOf(root)).toBeUndefined();
  });

  it('feeds WorkspaceFolderRegistry.folderInfos and announces a branch change', async () => {
    repo(root);
    const platform = createFakePlatform({ folders: [{ fsPath: root, name: path.basename(root) }] });
    const registry = new WorkspaceFolderRegistry(platform.workspaceFolders, platform.state.workspace, platform.fileWatchers);
    const changes: boolean[] = [];
    registry.onDidChange((change) => changes.push(change.branchChanged));
    await vi.waitFor(() => expect(registry.folderInfos()[0]?.branch).toBe('main'));
    expect(changes).toEqual([true]);
    registry.dispose();
  });
});
