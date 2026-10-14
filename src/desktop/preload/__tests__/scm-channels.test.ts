import { describe, expect, it } from 'vitest';
import { isFullRefName, MAX_SCM_REF_LENGTH, parseScmArtifacts, parseScmCommit, parseScmCopy, parseScmFileDiff, parseScmRun } from '../scm-channels';

describe('parseScmRun: the remote operations', () => {
  it('copies each request the shell sends, with exactly its fields', () => {
    const accepted: unknown[] = [
      { op: 'fetch', repoId: 'repo-1', scope: 'default' },
      { op: 'fetch', repoId: 'repo-1', scope: 'prune' },
      { op: 'fetch', repoId: 'repo-1', scope: 'all' },
      { op: 'pull', repoId: 'repo-1', rebase: true },
      { op: 'pullFrom', repoId: 'repo-1' },
      { op: 'push', repoId: 'repo-1', to: true, force: false, followTags: false },
      { op: 'sync', repoId: 'repo-1', rebase: false },
      { op: 'publish', repoId: 'repo-1' },
      { op: 'addRemote', repoId: 'repo-1' },
      { op: 'removeRemote', repoId: 'repo-1' },
      { op: 'clone', recursive: false },
      { op: 'cancel', repoId: 'repo-1' },
      { op: 'cancelClone' },
    ];
    for (const raw of accepted) expect(parseScmRun(raw), JSON.stringify(raw)).toEqual(raw);
  });

  it('refuses a missing, extra or mistyped field, so no remote name, URL or argument rides along', () => {
    const refused: unknown[] = [
      { op: 'fetch', repoId: 'repo-1' },
      { op: 'fetch', repoId: 'repo-1', scope: 'everything' },
      { op: 'fetch', repoId: 'repo-1', scope: 'default', remote: '--upload-pack=x' },
      { op: 'pull', repoId: 'repo-1', rebase: 'yes' },
      { op: 'pull', repoId: 'repo-1', rebase: false, branch: 'main' },
      { op: 'pullFrom', repoId: 'repo-1', remote: 'origin' },
      { op: 'push', repoId: 'repo-1', to: false, force: false },
      { op: 'push', repoId: 'repo-1', to: false, force: 1, followTags: false },
      { op: 'push', repoId: 'repo-1', to: false, force: false, followTags: false, refspec: '+main' },
      { op: 'sync', repoId: '', rebase: false },
      { op: 'addRemote', repoId: 'repo-1', url: 'ext::sh' },
      { op: 'clone', recursive: false, url: 'https://example.com/a.git' },
      { op: 'clone', recursive: false, repoId: 'repo-1' },
      { op: 'clone' },
      { op: 'cancel' },
      { op: 'cancelClone', repoId: 'repo-1' },
    ];
    for (const raw of refused) expect(parseScmRun(raw), JSON.stringify(raw)).toBeUndefined();
  });
});

const HASH = 'a'.repeat(40);
const HASH256 = 'b'.repeat(64);

describe('parseScmRun: branches, stash, tags and worktrees', () => {
  it('copies each request the shell sends, an optional ref, path or target included', () => {
    const absolute = process.platform === 'win32' ? 'C:\\work\\repo.worktrees\\feat' : '/work/repo.worktrees/feat';
    const accepted: unknown[] = [
      { op: 'checkout', repoId: 'repo-1', detached: false },
      { op: 'checkout', repoId: 'repo-1', detached: true, ref: 'refs/remotes/origin/feat/a' },
      { op: 'checkout', repoId: 'repo-1', detached: false, ref: 'refs/tags/v1.0' },
      { op: 'createBranch', repoId: 'repo-1', from: true },
      { op: 'createBranch', repoId: 'repo-1', from: true, ref: 'refs/heads/main' },
      { op: 'renameBranch', repoId: 'repo-1' },
      { op: 'deleteBranch', repoId: 'repo-1' },
      // a branch update-ref can create; main finds it in its own list and passes its short name through revision()
      { op: 'deleteBranch', repoId: 'repo-1', ref: 'refs/heads/-x' },
      { op: 'deleteRemoteBranch', repoId: 'repo-1' },
      { op: 'merge', repoId: 'repo-1', ref: 'refs/tags/v1' },
      { op: 'rebase', repoId: 'repo-1' },
      { op: 'stash', repoId: 'repo-1', scope: 'staged' },
      { op: 'stashChanges', repoId: 'repo-1', paths: ['src/a.ts'] },
      { op: 'stashApply', repoId: 'repo-1', pop: false, target: 'latest' },
      { op: 'stashApply', repoId: 'repo-1', pop: true, target: 'pick' },
      { op: 'stashApply', repoId: 'repo-1', pop: true, target: { index: 2, hash: HASH } },
      { op: 'stashDrop', repoId: 'repo-1', target: 'pick' },
      { op: 'stashDrop', repoId: 'repo-1', target: { index: 0, hash: HASH256 } },
      { op: 'stashDropAll', repoId: 'repo-1' },
      { op: 'viewStash', repoId: 'repo-1', target: { index: 0, hash: HASH } },
      { op: 'createTag', repoId: 'repo-1' },
      { op: 'deleteTag', repoId: 'repo-1', ref: 'refs/tags/v1' },
      { op: 'deleteRemoteTag', repoId: 'repo-1' },
      { op: 'pushTags', repoId: 'repo-1' },
      { op: 'createWorktree', repoId: 'repo-1' },
      { op: 'deleteWorktree', repoId: 'repo-1' },
      { op: 'deleteWorktree', repoId: 'repo-1', path: absolute },
    ];
    for (const raw of accepted) expect(parseScmRun(raw), JSON.stringify(raw)).toEqual(raw);
  });

  it('refuses a ref of the wrong kind or one git would refuse, a bad stash target, a relative or UNC worktree path, and extras', () => {
    const refused: unknown[] = [
      { op: 'checkout', repoId: 'repo-1' },
      { op: 'checkout', repoId: 'repo-1', detached: false, ref: 'main' },
      { op: 'checkout', repoId: 'repo-1', detached: false, ref: '--orphan' },
      { op: 'checkout', repoId: 'repo-1', detached: false, ref: 'refs/heads/' },
      { op: 'checkout', repoId: 'repo-1', detached: false, ref: 'refs/heads/a..b' },
      { op: 'checkout', repoId: 'repo-1', detached: false, ref: 'refs/heads/a b' },
      { op: 'checkout', repoId: 'repo-1', detached: false, ref: 'refs/heads/a@{1}' },
      { op: 'checkout', repoId: 'repo-1', detached: false, ref: 'refs/heads/x.lock' },
      { op: 'checkout', repoId: 'repo-1', detached: false, ref: 'refs/heads/.hidden' },
      { op: 'checkout', repoId: 'repo-1', detached: false, ref: 'refs/heads/a\\b' },
      { op: 'checkout', repoId: 'repo-1', detached: false, ref: 'refs/notes/x' },
      { op: 'checkout', repoId: 'repo-1', detached: false, ref: `refs/heads/${'a'.repeat(MAX_SCM_REF_LENGTH)}` },
      { op: 'checkout', repoId: 'repo-1', detached: false, ref: undefined },
      { op: 'deleteBranch', repoId: 'repo-1', ref: 'refs/tags/v1' },
      { op: 'deleteTag', repoId: 'repo-1', ref: 'refs/heads/main' },
      { op: 'createBranch', repoId: 'repo-1', from: 'yes' },
      { op: 'renameBranch', repoId: 'repo-1', name: 'x' },
      { op: 'stash', repoId: 'repo-1', scope: 'all' },
      { op: 'stash', repoId: 'repo-1', scope: 'default', message: 'x' },
      { op: 'stashChanges', repoId: 'repo-1', paths: ['../outside'] },
      { op: 'stashApply', repoId: 'repo-1', pop: true, target: { index: -1, hash: HASH } },
      { op: 'stashApply', repoId: 'repo-1', pop: true, target: { index: 1.5, hash: HASH } },
      { op: 'stashApply', repoId: 'repo-1', pop: true, target: { index: 1_000_000, hash: HASH } },
      { op: 'stashApply', repoId: 'repo-1', pop: true, target: { index: 0, hash: 'stash@{0}' } },
      { op: 'stashApply', repoId: 'repo-1', pop: true, target: { index: 0, hash: 'A'.repeat(40) } },
      { op: 'stashApply', repoId: 'repo-1', pop: true, target: { index: 0, hash: HASH, extra: 1 } },
      { op: 'stashDrop', repoId: 'repo-1', target: 'latest' },
      { op: 'viewStash', repoId: 'repo-1' },
      { op: 'pushTags', repoId: 'repo-1', remote: 'origin' },
      { op: 'deleteWorktree', repoId: 'repo-1', path: 'relative/wt' },
      { op: 'deleteWorktree', repoId: 'repo-1', path: '\\\\server\\share\\wt' },
      { op: 'deleteWorktree', repoId: 'repo-1', path: '/wt\nnext' },
    ];
    for (const raw of refused) expect(parseScmRun(raw), JSON.stringify(raw)).toBeUndefined();
  });

  it('checks full refnames by prefix and check-ref-format\'s rules', () => {
    expect(isFullRefName('refs/heads/feat/a', ['refs/heads/'])).toBe(true);
    expect(isFullRefName('refs/heads/feat/a', ['refs/tags/'])).toBe(false);
    for (const bad of ['refs/heads/a/', 'refs/heads/a.', 'refs/heads/a//b', 'refs/heads/a~1', 'refs/heads/a^', 'refs/heads/a:b', 'refs/heads/a?', 'refs/heads/a*', 'refs/heads/a[b', 'refs/heads/a\u0001']) {
      expect(isFullRefName(bad, ['refs/heads/']), bad).toBe(false);
    }
  });
});

describe('the artifacts request, the commit pair diff sources and the stash copy kinds', () => {
  it('takes a known group only', () => {
    expect(parseScmArtifacts({ repoId: 'repo-1', group: 'remoteBranches' })).toEqual({ repoId: 'repo-1', group: 'remoteBranches' });
    expect(parseScmArtifacts({ repoId: 'repo-1', group: 'notes' })).toBeUndefined();
    expect(parseScmArtifacts({ repoId: 'repo-1', group: 'tags', pattern: 'refs/' })).toBeUndefined();
  });

  it('takes a stash or refs source of full object names', () => {
    expect(parseScmFileDiff({ repoId: 'r', source: { kind: 'stash', index: 3, hash: HASH }, path: 'a.txt' })).toEqual({ repoId: 'r', source: { kind: 'stash', index: 3, hash: HASH }, path: 'a.txt' });
    expect(parseScmFileDiff({ repoId: 'r', source: { kind: 'refs', left: HASH, right: HASH256 }, path: 'a.txt' })?.source).toEqual({ kind: 'refs', left: HASH, right: HASH256 });
    for (const source of [{ kind: 'refs', left: 'HEAD', right: HASH }, { kind: 'refs', left: HASH }, { kind: 'stash', index: 0 }, { kind: 'stash', index: 0, hash: HASH, extra: 1 }, { kind: 'commit', hash: HASH }]) {
      expect(parseScmFileDiff({ repoId: 'r', source, path: 'a.txt' }), JSON.stringify(source)).toBeUndefined();
    }
  });

  it('names a stash row by its hash for branchName and stashName, and a change by its path for the path kinds', () => {
    expect(parseScmCopy({ repoId: 'r', kind: 'stashName', value: HASH })).toEqual({ repoId: 'r', kind: 'stashName', value: HASH });
    expect(parseScmCopy({ repoId: 'r', kind: 'branchName', value: HASH256 })).toEqual({ repoId: 'r', kind: 'branchName', value: HASH256 });
    expect(parseScmCopy({ repoId: 'r', kind: 'branchName', value: 'main' })).toBeUndefined();
    expect(parseScmCopy({ repoId: 'r', kind: 'path', value: HASH })).toEqual({ repoId: 'r', kind: 'path', value: HASH });
    expect(parseScmCopy({ repoId: 'r', kind: 'tagName', value: HASH })).toBeUndefined();
  });

  it('refuses a path kind naming a control character on every platform, though a POSIX file name may hold one', () => {
    const platform = process.platform;
    try {
      for (const value of ['linux', 'win32'] as const) {
        Object.defineProperty(process, 'platform', { value, configurable: true });
        for (const kind of ['path', 'relativePath']) {
          expect(parseScmCopy({ repoId: 'r', kind, value: 'src/a.ts\ncurl x' }), `${value} ${kind}`).toBeUndefined();
          expect(parseScmCopy({ repoId: 'r', kind, value: 'src/a\u007f.ts' }), `${value} ${kind}`).toBeUndefined();
        }
      }
    } finally {
      Object.defineProperty(process, 'platform', { value: platform, configurable: true });
    }
  });
});

describe('the Repositories rows: Compare with..., a worktree\'s Open and the ref copy kinds', () => {
  const worktree = process.platform === 'win32' ? 'C:\\work\\wt' : '/work/wt';

  it('takes Compare with... on a branch or tag refname and Open on an absolute local worktree path', () => {
    for (const raw of [{ op: 'compareRef', repoId: 'r', ref: 'refs/heads/feat/a' }, { op: 'compareRef', repoId: 'r', ref: 'refs/tags/v1.0' }, { op: 'openWorktree', repoId: 'r', path: worktree }]) {
      expect(parseScmRun(raw), JSON.stringify(raw)).toEqual(raw);
    }
    const refused: unknown[] = [
      { op: 'compareRef', repoId: 'r', ref: 'refs/remotes/origin/main' },
      { op: 'compareRef', repoId: 'r', ref: 'feat/a' },
      // refused for the space; without it the name is a valid refname, accepted by design as refs/heads/-x is
      { op: 'compareRef', repoId: 'r', ref: 'refs/heads/--upload-pack=x y' },
      { op: 'compareRef', repoId: 'r' },
      { op: 'compareRef', repoId: 'r', ref: 'refs/heads/main', left: 'refs/heads/x' },
      { op: 'openWorktree', repoId: 'r', path: 'relative/wt' },
      { op: 'openWorktree', repoId: 'r', path: '\\\\server\\share' },
      { op: 'openWorktree', repoId: 'r' },
      { op: 'openWorktree', repoId: 'r', path: worktree, select: true },
    ];
    for (const raw of refused) expect(parseScmRun(raw), JSON.stringify(raw)).toBeUndefined();
  });

  it('names each copy\'s row in the forms its kind may take, and nothing else', () => {
    const accepted: Array<[string, string]> = [
      ['branchName', 'refs/heads/feat/a'],
      ['branchName', worktree],
      ['branchName', HASH],
      ['tagName', 'refs/tags/v1.0'],
      ['commitHash', 'refs/heads/main'],
      ['commitHash', 'refs/tags/v1.0'],
      ['commitHash', worktree],
      ['worktreePath', worktree],
    ];
    for (const [kind, value] of accepted) expect(parseScmCopy({ repoId: 'r', kind, value }), kind + value).toEqual({ repoId: 'r', kind, value });
    const refused: Array<[string, string]> = [
      ['tagName', 'refs/heads/main'],
      ['tagName', worktree],
      ['commitHash', HASH],
      ['commitHash', 'refs/remotes/origin/main'],
      ['worktreePath', HASH],
      ['worktreePath', 'relative'],
      ['stashName', 'refs/heads/main'],
      ['branchName', 'refs/heads/a..b'],
    ];
    for (const [kind, value] of refused) expect(parseScmCopy({ repoId: 'r', kind, value }), kind + value).toBeUndefined();
  });
});

describe('parseScmCommit: Commit & Push and Commit & Sync', () => {
  const commit = { repoId: 'repo-1', message: 'm', variant: { scope: 'auto', amend: false, signoff: false, noVerify: false, empty: false } };

  it('takes postCommit push or sync, and a commit without it', () => {
    expect(parseScmCommit(commit)).toEqual(commit);
    expect(parseScmCommit({ ...commit, postCommit: 'push' })).toEqual({ ...commit, postCommit: 'push' });
    expect(parseScmCommit({ ...commit, postCommit: 'sync' })).toEqual({ ...commit, postCommit: 'sync' });
  });

  it('refuses any other postCommit', () => {
    for (const postCommit of ['none', 'pull', undefined, null, 1]) expect(parseScmCommit({ ...commit, postCommit }), String(postCommit)).toBeUndefined();
  });
});
