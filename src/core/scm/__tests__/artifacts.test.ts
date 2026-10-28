import { describe, expect, it } from 'vitest';
import { branchRows, parseCommits, parseNameStatus, parseRefs, parseStashes, parseWorktrees, remoteBranchRows, tagRows } from '../artifacts';
import { parseRemoteTags } from '../tags';
import { worktreeName, defaultWorktreePath } from '../worktrees';
import * as path from 'node:path';

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const C = 'c'.repeat(40);
const T = 'f'.repeat(40);

// for-each-ref in REF_FORMAT: refname, objectname, objecttype, *objectname, authorname, *authorname, committerdate:unix,
// *committerdate:unix, subject, *subject, HEAD, upstream:remotename, upstream:remoteref, upstream:track,nobracket
const ref = (...fields: string[]): string => fields.join('\0');

describe('ref parsing', () => {
  it('reads branches with HEAD, commit details and upstream, a gone upstream as none', () => {
    const stdout = [
      ref('refs/heads/main', A, 'commit', '', 'Ada', '', '1700000000', '', 'Fix: the thing', '', '*', 'origin', 'refs/heads/main', 'ahead 2, behind 1'),
      ref('refs/heads/feat/a', B, 'commit', '', 'Bob', '', '1690000000', '', 'feat', '', ' ', '', '', ''),
      ref('refs/heads/old', C, 'commit', '', 'Cy', '', '1680000000', '', 'old', '', ' ', 'origin', 'refs/heads/old', 'gone'),
      ref('refs/heads/even', C, 'commit', '', 'Cy', '', '1680000000', '', 'even', '', ' ', '.', 'refs/heads/main', ''),
      '',
    ].join('\n');
    expect(branchRows(parseRefs(stdout))).toEqual([
      { ref: 'refs/heads/main', name: 'main', commit: { hash: A, subject: 'Fix: the thing', author: 'Ada', date: 1_700_000_000_000 }, current: true, upstream: { remote: 'origin', branch: 'main', ahead: 2, behind: 1 } },
      { ref: 'refs/heads/feat/a', name: 'feat/a', commit: { hash: B, subject: 'feat', author: 'Bob', date: 1_690_000_000_000 }, current: false, upstream: null },
      { ref: 'refs/heads/old', name: 'old', commit: expect.objectContaining({ hash: C }), current: false, upstream: null },
      { ref: 'refs/heads/even', name: 'even', commit: expect.objectContaining({ hash: C }), current: false, upstream: { remote: '.', branch: 'main', ahead: 0, behind: 0 } },
    ]);
  });

  it('skips a malformed line and a remote\'s symbolic HEAD, and names a remote branch remote/branch', () => {
    const stdout = [
      ref('refs/remotes/origin/HEAD', A, 'commit', '', 'Ada', '', '1', '', 's', '', ' ', '', '', ''),
      ref('refs/remotes/origin/feat/x', B, 'commit', '', 'Bob', '', '2', '', 's', '', ' ', '', '', ''),
      'garbage line',
      ref('refs/heads/short', A),
    ].join('\n');
    expect(remoteBranchRows(parseRefs(stdout), ['origin'])).toEqual([{ ref: 'refs/remotes/origin/feat/x', name: 'origin/feat/x', remote: 'origin', commit: expect.objectContaining({ hash: B }) }]);
  });

  it('takes a remote branch\'s remote as the longest configured remote name that prefixes it, a refused name included', () => {
    const row = (name: string): string => ref(`refs/remotes/${name}`, A, 'commit', '', 'Ada', '', '1', '', 's', '', ' ', '', '', '');
    const stdout = [row('foo/bar/x'), row('foo/y'), row('foobar/z'), row('gone/w')].join('\n');
    expect(remoteBranchRows(parseRefs(stdout), ['foo', 'foo/bar', 'foobar']).map((entry) => [entry.name, entry.remote])).toEqual([
      ['foo/bar/x', 'foo/bar'],
      ['foo/y', 'foo'],
      ['foobar/z', 'foobar'],
      ['gone/w', 'gone'],
    ]);
  });

  it('peels an annotated tag to its commit, and marks current the first tag by name at a detached HEAD', () => {
    const stdout = [
      ref('refs/tags/v2', T, 'tag', A, '', 'Ada', '', '1700000000', 'Release 2', 'commit subject', ' ', '', '', ''),
      ref('refs/tags/b-light', A, 'commit', '', 'Ada', '', '1700000000', '', 'commit subject', '', ' ', '', '', ''),
      ref('refs/tags/tree', T, 'tree', '', '', '', '', '', '', '', ' ', '', '', ''),
    ].join('\n');
    expect(tagRows(parseRefs(stdout), A)).toEqual([
      { ref: 'refs/tags/v2', name: 'v2', commit: { hash: A, subject: 'commit subject', author: 'Ada', date: 1_700_000_000_000 }, annotated: true, current: false },
      { ref: 'refs/tags/b-light', name: 'b-light', commit: { hash: A, subject: 'commit subject', author: 'Ada', date: 1_700_000_000_000 }, annotated: false, current: true },
      { ref: 'refs/tags/tree', name: 'tree', commit: null, annotated: false, current: false },
    ]);
    expect(tagRows(parseRefs(stdout), undefined).some((tag) => tag.current)).toBe(false);
  });
});

describe('stash list parsing (VS Code\'s parseGitStashes)', () => {
  // `stash list --format=%H%n%P%n%gd%n%gs%n%at%n%ct -z`
  const record = (hash: string, parents: string, index: number, subject: string): string => `${hash}\n${parents}\nstash@{${index}}\n${subject}\n1700000000\n1700000100\0`;

  it('reads a message, a WIP stash and a stash on a detached HEAD', () => {
    const raw = record(A, `${B} ${C}`, 0, 'On main: my message') + record(B, `${C} ${A} ${T}`, 1, 'WIP on feat/x: abc1234 subject') + record(C, A, 2, 'On (no branch): detached');
    expect(parseStashes(raw)).toEqual([
      { index: 0, hash: A, description: 'my message', branch: 'main', date: 1_700_000_100_000 },
      { index: 1, hash: B, description: 'WIP (abc1234 subject)', branch: 'feat/x', date: 1_700_000_100_000 },
      { index: 2, hash: C, description: 'detached', branch: null, date: 1_700_000_100_000 },
    ]);
  });

  it('lists a stash whose reflog message is not git\'s "On <branch>:" by that message, with no branch', () => {
    expect(parseStashes(record(A, B, 0, 'autostash'))).toEqual([{ index: 0, hash: A, description: 'autostash', branch: null, date: 1_700_000_100_000 }]);
    expect(parseStashes('')).toEqual([]);
  });

  it('never lets a stash stored with a colonless "on" message swallow the next record', () => {
    const raw = record(A, B, 0, 'on the fence') + record(B, C, 1, 'On main: kept');
    expect(parseStashes(raw)).toEqual([
      { index: 0, hash: A, description: 'on the fence', branch: null, date: 1_700_000_100_000 },
      { index: 1, hash: B, description: 'kept', branch: 'main', date: 1_700_000_100_000 },
    ]);
  });
});

describe('worktree list --porcelain parsing', () => {
  const lines = [
    'worktree /repo',
    `HEAD ${A}`,
    'branch refs/heads/main',
    '',
    'worktree /repo.worktrees/feat',
    `HEAD ${B}`,
    'detached',
    'locked reason here',
    '',
    'worktree /gone',
    `HEAD ${C}`,
    'branch refs/heads/gone',
    'prunable gitdir file points to non-existent location',
    '',
  ];

  it('reads records split by an empty line, newline or NUL terminated', () => {
    const expected = [
      { path: '/repo', head: A, branchRef: 'refs/heads/main', bare: false, locked: false, prunable: false },
      { path: '/repo.worktrees/feat', head: B, branchRef: undefined, bare: false, locked: true, prunable: false },
      { path: '/gone', head: C, branchRef: 'refs/heads/gone', bare: false, locked: false, prunable: true },
    ];
    expect(parseWorktrees(lines.join('\n'), false)).toEqual(expected);
    expect(parseWorktrees(lines.join('\0'), true)).toEqual(expected);
  });

  it('gives an unborn worktree, whose HEAD git prints as the null object name, no head', () => {
    const zero = '0'.repeat(40);
    expect(parseWorktrees(`worktree /new\nHEAD ${zero}\nbranch refs/heads/main\n\n`, false)).toEqual([{ path: '/new', head: undefined, branchRef: 'refs/heads/main', bare: false, locked: false, prunable: false }]);
  });

  it('marks a bare main worktree', () => {
    expect(parseWorktrees('worktree /bare.git\nbare\n\n', false)).toEqual([{ path: '/bare.git', head: undefined, branchRef: undefined, bare: true, locked: false, prunable: false }]);
  });

  it('reads log --no-walk commit lines', () => {
    expect(parseCommits(`${A}\0Ada\x001700000000\0subject one\n${B}\0Bob\x001600000000\0two\n`)).toEqual(new Map([
      [A, { hash: A, author: 'Ada', date: 1_700_000_000_000, subject: 'subject one' }],
      [B, { hash: B, author: 'Bob', date: 1_600_000_000_000, subject: 'two' }],
    ]));
  });
});

describe('diff --name-status parsing', () => {
  it('maps letters as VS Code\'s parseGitChanges does, keeping a rename\'s and a copy\'s source', () => {
    const raw = ['M', 'a.txt', 'A', 'new.txt', 'D', 'gone.txt', 'R087', 'old name.txt', 'new name.txt', 'C100', 'src.txt', 'copy.txt', 'T', 'link', ''].join('\0');
    expect(parseNameStatus(raw).map((change) => [change.status, change.letter, change.path, change.originalPath])).toEqual([
      ['MODIFIED', 'M', 'a.txt', undefined],
      ['INDEX_ADDED', 'A', 'new.txt', undefined],
      ['DELETED', 'D', 'gone.txt', undefined],
      ['INDEX_RENAMED', 'R', 'new name.txt', 'old name.txt'],
      ['INDEX_COPIED', 'C', 'copy.txt', 'src.txt'],
      ['TYPE_CHANGED', 'T', 'link', undefined],
    ]);
  });

  it('stops at an unknown letter or a truncated rename', () => {
    expect(parseNameStatus(['M', 'a', 'X', 'b', 'M', 'c'].join('\0'))).toHaveLength(1);
    expect(parseNameStatus(['R100', 'a'].join('\0'))).toEqual([]);
  });
});

describe('remote tags and worktree names', () => {
  it('lists each remote tag once with the commit it names, an annotated tag\'s peeled ^{} object, and leaves out a name that is an option', () => {
    const stdout = [`${A}\trefs/tags/v1`, `${B}\trefs/tags/v1^{}`, `${C}\trefs/tags/light`, `${A}\trefs/tags/-x`, `${A}\trefs/heads/main`, ''].join('\n');
    expect(parseRemoteTags(stdout)).toEqual([{ name: 'v1', commit: B }, { name: 'light', commit: C }]);
  });

  it('names a worktree folder from its branch without branchPrefix, and puts it beside the repository', () => {
    expect(worktreeName('me/feat/x', 'me/')).toBe('feat-x');
    expect(worktreeName('feat/x', '')).toBe('feat-x');
    expect(defaultWorktreePath(path.join('/work', 'repo'), 'feat-x', false)).toBe(path.join('/work', 'repo.worktrees', 'feat-x'));
    expect(defaultWorktreePath(path.join('/work', 'wt'), 'feat-x', true)).toBe(path.join('/work', 'feat-x'));
  });

  it('puts it beside the repository in the path rules of the host the repository is on', () => {
    expect(defaultWorktreePath('/srv/repo', 'feat-x', false, path.posix)).toBe('/srv/repo.worktrees/feat-x');
    expect(defaultWorktreePath('/srv/wt', 'feat-x', true, path.posix)).toBe('/srv/feat-x');
    expect(defaultWorktreePath('C:\\work\\repo', 'feat-x', false, path.win32)).toBe('C:\\work\\repo.worktrees\\feat-x');
    expect(defaultWorktreePath('C:\\work\\wt', 'feat-x', true, path.win32)).toBe('C:\\work\\feat-x');
  });
});
