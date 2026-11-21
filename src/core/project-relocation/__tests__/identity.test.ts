import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CONFIG_READ_LIMIT, identityRelation, MAX_REMOTES, normalizedRemote, readFolderIdentity, remotesOfConfig, rootsOfOutput } from '../identity';
import { FolderIdentityStore, MAX_RECORDED_FOLDERS, parseStore } from '../identity-store';
import { fileLinkedOntoDevice, folderOnAdminShare } from '../../../__mocks__/admin-share';

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'identity-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const write = (file: string, text: string): void => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
};

describe('normalizedRemote', () => {
  it('reads https, http, git, ssh and scp-like URLs as host and path, lowercase and without .git', () => {
    expect(normalizedRemote('https://github.com/Acme/Widgets.git')).toBe('github.com/acme/widgets');
    expect(normalizedRemote('http://git.example.com/team/repo/')).toBe('git.example.com/team/repo');
    expect(normalizedRemote('git://git.example.com/team/repo.git')).toBe('git.example.com/team/repo');
    expect(normalizedRemote('ssh://git@gitlab.com:2222/group/sub/repo.git')).toBe('gitlab.com/group/sub/repo');
    expect(normalizedRemote('git@github.com:acme/widgets.git')).toBe('github.com/acme/widgets');
    expect(normalizedRemote('[git@host.example:2200]:acme/widgets')).toBe('host.example/acme/widgets');
  });

  it('keeps no user, password or token', () => {
    expect(normalizedRemote('https://alice:s3cret@github.com/acme/widgets.git')).toBe('github.com/acme/widgets');
    expect(normalizedRemote('https://ghp_abcdefghijklmnopqrstuvwxyz0123456789@github.com/acme/widgets')).toBe('github.com/acme/widgets');
  });

  it('reads a local path or an empty path as no remote', () => {
    expect(normalizedRemote('/srv/git/repo.git')).toBeUndefined();
    expect(normalizedRemote('C:\\repos\\widgets')).toBeUndefined();
    expect(normalizedRemote('file:///srv/git/repo.git')).toBeUndefined();
    expect(normalizedRemote('https://github.com/')).toBeUndefined();
  });
});

describe('remotesOfConfig', () => {
  it('reads every remote section\'s url entries, quoted or commented, and nothing else', () => {
    const config = [
      '[core]',
      '\turl = https://not-a-remote.example/x',
      '[remote "origin"]',
      '\turl = "git@github.com:acme/widgets.git" ; the main one',
      '\tfetch = +refs/heads/*:refs/remotes/origin/*',
      '[Remote "upstream"] URL=https://github.com/upstream/widgets # inline header',
      '[include]',
      '\tpath = ~/.gitconfig-remotes',
      '[includeIf "gitdir:~/work/"]',
      '\tpath = other',
      '\turl = https://included.example/never',
      '[branch "main"]',
      '\tremote = origin',
    ].join('\r\n');
    expect(remotesOfConfig(config)).toEqual(['github.com/acme/widgets', 'github.com/upstream/widgets']);
  });

  it('keeps at most MAX_REMOTES remotes', () => {
    const config = Array.from({ length: MAX_REMOTES + 5 }, (_, i) => `[remote "r${i}"]\n\turl = https://example.com/r/${i}`).join('\n');
    expect(remotesOfConfig(config)).toHaveLength(MAX_REMOTES);
  });
});

describe('readFolderIdentity', () => {
  it('reads the remotes and the subpath of a folder inside a repository', async () => {
    const repo = path.join(dir, 'repo');
    write(path.join(repo, '.git', 'config'), '[remote "origin"]\n\turl = https://bob:pw@github.com/acme/widgets.git\n');
    fs.mkdirSync(path.join(repo, 'packages', 'app'), { recursive: true });
    expect(await readFolderIdentity(path.join(repo, 'packages', 'app'))).toEqual({ subpath: 'packages/app', remotes: ['github.com/acme/widgets'], roots: [] });
    expect(await readFolderIdentity(repo)).toEqual({ subpath: '', remotes: ['github.com/acme/widgets'], roots: [] });
  });

  it('follows a .git file to its git dir and the commondir to the config', async () => {
    const main = path.join(dir, 'main');
    write(path.join(main, '.git', 'config'), '[remote "origin"]\n\turl = git@gitlab.com:group/project.git\n');
    write(path.join(main, '.git', 'worktrees', 'wt', 'commondir'), '../..\n');
    const worktree = path.join(dir, 'wt');
    write(path.join(worktree, '.git'), `gitdir: ${path.join(main, '.git', 'worktrees', 'wt')}\n`);
    expect(await readFolderIdentity(worktree)).toEqual({ subpath: '', remotes: ['gitlab.com/group/project'], roots: [] });
  });

  it('reads no remotes from a config over the read limit', async () => {
    const repo = path.join(dir, 'big');
    write(path.join(repo, '.git', 'config'), `[remote "origin"]\n\turl = https://github.com/acme/widgets\n#${'x'.repeat(CONFIG_READ_LIMIT)}\n`);
    expect(await readFolderIdentity(repo)).toEqual({ subpath: '', remotes: [], roots: [] });
  });

  it('stops at a .git link, as git does, and reads nothing through it', async () => {
    const outer = path.join(dir, 'outer');
    write(path.join(outer, '.git', 'config'), '[remote "origin"]\n\turl = https://github.com/acme/outer.git\n');
    const inner = path.join(outer, 'inner');
    fs.mkdirSync(inner);
    const target = path.join(dir, 'elsewhere', '.git');
    fs.symlinkSync(target, path.join(inner, '.git'), process.platform === 'win32' ? 'junction' : 'dir');
    // a link whose target is missing is still an entry, so the walk never reaches the outer repository
    expect(await readFolderIdentity(inner)).toBeUndefined();
    write(path.join(target, 'config'), '[remote "origin"]\n\turl = https://github.com/acme/linked.git\n');
    expect(await readFolderIdentity(inner)).toBeUndefined();
  });

  it('answers undefined for a folder that is gone or lies in no repository', async () => {
    expect(await readFolderIdentity(path.join(dir, 'gone'))).toBeUndefined();
    fs.mkdirSync(path.join(dir, 'plain'));
    // the temp folder may lie inside some repository; a .git file git cannot use stops the search as git stops
    write(path.join(dir, '.git'), 'not a gitdir line\n');
    expect(await readFolderIdentity(path.join(dir, 'plain'))).toBeUndefined();
  });
});

describe('rootsOfOutput and identityRelation', () => {
  it('keeps only object ids', () => {
    expect(rootsOfOutput(`${'a'.repeat(40)}\nwarning: x\n${'b'.repeat(64)}\r\n`)).toEqual(['a'.repeat(40), 'b'.repeat(64)]);
  });

  it('is same on a shared remote or root, different when comparable and disjoint, unknown otherwise', () => {
    const id = (remotes: string[], roots: string[]) => ({ subpath: '', remotes, roots });
    expect(identityRelation(id(['h/a'], []), id(['h/b', 'h/a'], []))).toBe('same');
    expect(identityRelation(id(['h/fork'], ['r1']), id(['h/upstream'], ['r1']))).toBe('same');
    expect(identityRelation(id(['h/a'], []), id(['h/b'], []))).toBe('different');
    expect(identityRelation(id([], ['r1']), id(['h/b'], ['r2']))).toBe('different');
    expect(identityRelation(id(['h/a'], []), id([], ['r1']))).toBe('unknown');
    expect(identityRelation(id([], []), id([], []))).toBe('unknown');
  });
});

describe('FolderIdentityStore', () => {
  const identity = { subpath: '', remotes: ['github.com/acme/widgets'], roots: [] as string[] };

  it('writes mode 0600 entries keyed by folder, keeps recorded roots when a read has none, and drops a folder that is no repository', async () => {
    const store = new FolderIdentityStore({ file: path.join(dir, 'folder-identities.json'), log: () => undefined });
    const folder = path.join(dir, 'acme');
    await store.record([{ folder, identity: { ...identity, roots: ['c'.repeat(40)] } }], 1);
    await store.record([{ folder, identity }], 2);
    expect(await store.get(folder)).toEqual({ path: folder, ...identity, roots: ['c'.repeat(40)], seenAt: 2 });
    if (process.platform !== 'win32') expect(fs.statSync(store.file).mode & 0o777).toBe(0o600);
    await store.record([{ folder, identity: undefined }], 3);
    expect(await store.entries()).toEqual([]);
  });

  it('keeps a remote whose path held an encoded space, and an scp remote whose ssh alias has an underscore, with their roots', async () => {
    const store = new FolderIdentityStore({ file: path.join(dir, 'folder-identities.json'), log: () => undefined });
    const remotes = [normalizedRemote('https://dev.azure.com/org/My%20Project/_git/repo')!, normalizedRemote('github_work:org/repo.git')!];
    expect(remotes).toEqual(['dev.azure.com/org/my project/_git/repo', 'github_work/org/repo']);
    const folder = path.join(dir, 'acme');
    await store.record([{ folder, identity: { subpath: '', remotes, roots: ['c'.repeat(40)] } }], 1);
    expect(await store.entries()).toEqual([{ path: folder, subpath: '', remotes, roots: ['c'.repeat(40)], seenAt: 1 }]);
  });

  it.runIf(process.platform === 'win32')('reads and writes through a store folder linked onto a share, as the user moved it there (win32)', async (ctx) => {
    const real = folderOnAdminShare(ctx, path.join(dir, 'data'));
    try {
      const store = new FolderIdentityStore({ file: path.join(dir, 'data', 'folder-identities.json'), log: () => undefined });
      const folder = path.join(dir, 'acme');
      await store.record([{ folder, identity }], 1);
      expect(await store.entries()).toEqual([{ path: folder, ...identity, seenAt: 1 }]);
      expect(fs.existsSync(path.join(real, 'folder-identities.json'))).toBe(true);
    } finally {
      fs.rmSync(real, { recursive: true, force: true });
    }
  });

  it.runIf(process.platform === 'win32')('neither reads nor writes a store file that links off its folder (win32)', async (ctx) => {
    const file = path.join(dir, 'folder-identities.json');
    fileLinkedOntoDevice(ctx, file);
    const lines: string[] = [];
    const store = new FolderIdentityStore({ file, log: (line) => lines.push(line) });
    expect(await store.entries()).toEqual([]);
    expect(lines).toEqual([`[FolderIdentities] ${file} links to a network share or WSL path, so it is not read`]);
    await expect(store.record([{ folder: path.join(dir, 'acme'), identity }], 1)).rejects.toMatchObject({ name: 'ConfigWriteRefused' });
  });

  it('keeps the MAX_RECORDED_FOLDERS seen last', async () => {
    const store = new FolderIdentityStore({ file: path.join(dir, 'folder-identities.json'), log: () => undefined });
    const reads = Array.from({ length: MAX_RECORDED_FOLDERS + 3 }, (_, i) => ({ folder: path.join(dir, `p${i}`), identity }));
    await store.record(reads.slice(0, 3), 1);
    await store.record(reads.slice(3), 2);
    const kept = await store.entries();
    expect(kept).toHaveLength(MAX_RECORDED_FOLDERS);
    expect(kept.some((entry) => entry.path === reads[0]!.folder)).toBe(false);
  });

  it('reads an entry carrying a credential, a bad root or a relative path as none', () => {
    const entry = (extra: object) => ({ path: path.join(dir, 'a'), subpath: '', remotes: [], roots: [], seenAt: 1, ...extra });
    const text = JSON.stringify({ version: 1, folders: {
      a: entry({ remotes: ['alice:pw@github.com/acme/widgets'] }),
      b: entry({ roots: ['not-a-commit'] }),
      c: entry({ path: 'relative/path' }),
      d: entry({ remotes: ['github.com/acme/widgets'] }),
      e: entry({ remotes: ['alice@github.com/acme/widgets'] }),
      f: entry({ remotes: ['GitHub.com/acme/widgets'] }),
      g: entry({ remotes: ['github.com/acme/wid\ngets'] }),
      h: entry({ remotes: ['github.com:2222/acme/widgets'] }),
    } });
    expect(parseStore(text, () => undefined)).toEqual([entry({ remotes: ['github.com/acme/widgets'] })]);
    expect(parseStore('{ broken', () => undefined)).toEqual([]);
  });
});
