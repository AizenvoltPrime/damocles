import { describe, expect, it } from 'vitest';
import type { ScmArtifacts, ScmBranchArtifact, ScmStashArtifact, ScmTagArtifact, ScmWorktreeArtifact } from '../../preload/scm-channels';
import {
  buildRepositoryRows,
  expandedGroups,
  folderRowId,
  groupRowId,
  hiddenTimes,
  repoRowId,
  sortRefByName,
  sortWorktrees,
  typeAheadIndex,
  type GroupList,
  type RepositoryEntry,
  type RepositoryGroup,
  type RepositoryRow,
  type RepositoryTreeInput,
} from '../scm/repositories-tree';

const HOUR = 3_600_000;
const NOW = Date.UTC(2026, 0, 10, 12);
const hash = (char: string): string => char.repeat(40);
const commit = (char: string, subject: string, ago: number) => ({ hash: hash(char), subject, author: 'Ada', date: NOW - ago });

const branch = (name: string, char: string, ago: number, current = false): ScmBranchArtifact =>
  ({ ref: `refs/heads/${name}`, name, commit: commit(char, `${name} work`, ago), current, upstream: null });
const tag = (name: string, char: string, ago: number, current = false): ScmTagArtifact =>
  ({ ref: `refs/tags/${name}`, name, commit: commit(char, `${name} release`, ago), annotated: false, current });

const REPO: RepositoryEntry = { repoId: 'r1', label: 'acme', displayPath: '', head: 'main' };
const NESTED: RepositoryEntry = { repoId: 'r2', label: 'lib', displayPath: 'lib', head: 'dev' };

// A coarse relative time: rows within the same hour read alike, as VS Code's fromNow does for close commits.
const timeOf = (date: number): string => `${Math.floor((NOW - date) / HOUR)}h`;

function input(lists: Partial<Record<RepositoryGroup, ScmArtifacts>>, expanded: readonly string[], repos: readonly RepositoryEntry[] = [REPO]): RepositoryTreeInput {
  return {
    repos,
    expanded: new Set(expanded),
    lists: (repoId, group): GroupList | undefined => {
      const artifacts = repoId === REPO.repoId ? lists[group] : undefined;
      return artifacts ? { state: 'ready', artifacts } : undefined;
    },
    timeOf,
    detached: 'detached',
  };
}

const summary = (rows: readonly RepositoryRow[]): string[] => rows.map((row) => {
  const indent = '  '.repeat(row.level - 1);
  switch (row.kind) {
    case 'repo': return `${indent}repo ${row.repo.label}${row.expanded ? ' v' : ' >'}`;
    case 'group': return `${indent}${row.group} ${row.count ?? '-'}${row.expanded ? ' v' : ' >'}`;
    case 'folder': return `${indent}folder ${row.label} ${row.count}${row.expanded ? ' v' : ' >'}`;
    case 'branch': return `${indent}${row.branch.current ? '@' : ''}${row.label}`;
    case 'tag': return `${indent}${row.tag.current ? '@' : ''}${row.label}`;
    case 'stash': return `${indent}stash ${row.label}`;
    case 'worktree': return `${indent}worktree ${row.label}`;
    case 'note': return `${indent}note ${row.text}`;
  }
});

describe('sortRefByName (artifactProvider.ts)', () => {
  it('puts refs in folders first, folders by name and a deeper folder first, and keeps the given order otherwise', () => {
    // for-each-ref --sort=-creatordate order: newest first
    const names = ['main', 'feat/b', 'zeta/x', 'hotfix', 'feat/a', 'feat/sub/c', 'alpha/y'];
    expect([...names.map((name) => ({ name }))].sort(sortRefByName).map((ref) => ref.name)).toEqual(['alpha/y', 'feat/sub/c', 'feat/b', 'feat/a', 'zeta/x', 'main', 'hotfix']);
  });

  it('orders worktrees with the main one first, then by name', () => {
    const worktree = (name: string, main: boolean): ScmWorktreeArtifact =>
      ({ path: `/w/${name}`, name, branch: name, commit: null, main, current: false, locked: false, prunable: false, opens: 'addProject' });
    expect([worktree('zed', false), worktree('acme', true), worktree('beta', false)].sort(sortWorktrees).map((row) => row.name)).toEqual(['acme', 'beta', 'zed']);
  });
});

describe('the Repositories tree', () => {
  // main, feat/a and feat/b, each committed after the one before, so for-each-ref lists them newest first
  const branches: ScmArtifacts = { group: 'branches', rows: [branch('feat/b', 'b', 1 * HOUR), branch('feat/a', 'a', 30 * HOUR), branch('main', 'c', 50 * HOUR, true)] };

  it('shows the groups at the top level for one repository, collapsed and unread until expanded', () => {
    const rows = buildRepositoryRows(input({}, []));
    expect(summary(rows)).toEqual(['branches - >', 'stashes - >', 'tags - >', 'worktrees - >']);
    expect(rows.map((row) => [row.level, row.position, row.setSize])).toEqual([[1, 1, 4], [1, 2, 4], [1, 3, 4], [1, 4, 4]]);
    expect(expandedGroups(rows)).toEqual([]);
  });

  it('shows the collapsed feat folder before main with its HEAD mark, then b above a once feat is expanded', () => {
    const open = buildRepositoryRows(input({ branches }, [groupRowId(REPO, 'branches')]));
    expect(summary(open)).toEqual(['branches 3 v', '  folder feat 2 >', '  @main', 'stashes - >', 'tags - >', 'worktrees - >']);
    expect(expandedGroups(open)).toEqual([{ repoId: 'r1', group: 'branches' }]);
    const feat = buildRepositoryRows(input({ branches }, [groupRowId(REPO, 'branches'), folderRowId(REPO, 'branches', 'feat')]));
    expect(summary(feat).slice(0, 5)).toEqual(['branches 3 v', '  folder feat 2 v', '    b', '    a', '  @main']);
    const b = feat[2]!;
    expect(b.kind === 'branch' && [b.description, b.time, b.timeHidden]).toEqual([`${hash('b').slice(0, 7)} \u2022 feat/b work`, '1h', false]);
  });

  it('merges a chain of single-child folders into one row, labelled with its whole path as VS Code\'s compressed row is', () => {
    const rows: ScmArtifacts = { group: 'branches', rows: [branch('team/ax/fix', 'a', HOUR), branch('x/a/b/c', 'b', HOUR), branch('x/d', 'c', HOUR), branch('a/b/x', 'd', HOUR), branch('a/b/y', 'e', HOUR)] };
    const expanded = [groupRowId(REPO, 'branches'), folderRowId(REPO, 'branches', 'team/ax'), folderRowId(REPO, 'branches', 'x'), folderRowId(REPO, 'branches', 'x/a/b'), folderRowId(REPO, 'branches', 'a'), folderRowId(REPO, 'branches', 'a/b')];
    expect(summary(buildRepositoryRows(input({ branches: rows }, expanded))).slice(0, 13)).toEqual([
      'branches 5 v',
      // a folder whose only child holds two refs stays apart from it, since that child cannot be compressed
      '  folder a 2 v',
      '    folder b 2 v',
      '      x',
      '      y',
      '  folder team/ax 1 v',
      '    fix',
      '  folder x 2 v',
      '    folder x/a/b 1 v',
      '      c',
      '    d',
      'stashes - >',
      'tags - >',
    ]);
  });

  it('hides a time equal to the row above in the same folder only, and shows no time on a folder', () => {
    const rows: ScmArtifacts = { group: 'tags', rows: [tag('v2', 'a', HOUR + 10), tag('v1', 'b', HOUR + 20), tag('rc/v3', 'c', HOUR + 30, true), tag('rc/v2', 'd', HOUR + 40)] };
    const built = buildRepositoryRows(input({ tags: rows }, [groupRowId(REPO, 'tags'), folderRowId(REPO, 'tags', 'rc')]));
    const timed = built.flatMap((row) => (row.kind === 'tag' ? [`${row.label}:${row.time}:${row.timeHidden ? 'hidden' : 'shown'}`] : []));
    // rc/v3 is first in the sorted list; rc/v2 follows it in the same folder; v2 follows rc/v2 but in another folder; v1 follows v2
    expect(timed).toEqual(['v3:1h:shown', 'v2:1h:hidden', 'v2:1h:shown', 'v1:1h:hidden']);
    expect(summary(built)).toContain('    @v3');
    expect(hiddenTimes([1, 2], () => undefined, () => '', timeOf)).toEqual([false, false]);
  });

  it('describes a stash by its branch and a worktree by its branch or detached, hash and subject, the main worktree first', () => {
    const stash = (index: number, branchName: string | null, ago: number): ScmStashArtifact => ({ index, hash: hash(String(index)), description: `On x: ${index}`, branch: branchName, date: NOW - ago });
    const worktree = (name: string, main: boolean, branchName: string | null): ScmWorktreeArtifact =>
      ({ path: `/w/${name}`, name, branch: branchName, commit: commit('f', 'Fix login', HOUR), main, current: main, locked: false, prunable: false, opens: main ? 'project' : 'addProject' });
    const rows = buildRepositoryRows(input(
      { stashes: { group: 'stashes', rows: [stash(0, 'main', HOUR), stash(1, null, HOUR)] }, worktrees: { group: 'worktrees', rows: [worktree('hotfix', false, null), worktree('acme', true, 'main')] } },
      [groupRowId(REPO, 'stashes'), groupRowId(REPO, 'worktrees')],
    ));
    const described = rows.flatMap((row) => (row.kind === 'stash' || row.kind === 'worktree' ? [`${row.label} | ${row.description}${row.kind === 'stash' ? ` | ${row.timeHidden}` : ''}`] : []));
    expect(described).toEqual([
      'On x: 0 | main | false',
      'On x: 1 |  | true',
      `acme | main \u2022 ${hash('f').slice(0, 7)} \u2022 Fix login`,
      `hotfix | detached \u2022 ${hash('f').slice(0, 7)} \u2022 Fix login`,
    ]);
  });

  it('lists each repository as a row of its own with several, its groups one level down, and reads only expanded groups', () => {
    const collapsed = buildRepositoryRows(input({}, [], [REPO, NESTED]));
    expect(summary(collapsed)).toEqual(['repo acme >', 'repo lib >']);
    const open = buildRepositoryRows(input({}, [repoRowId(REPO), groupRowId(REPO, 'tags'), groupRowId(NESTED, 'branches')], [REPO, NESTED]));
    expect(summary(open)).toEqual(['repo acme v', '  branches - >', '  stashes - >', '  tags - v', '  worktrees - >', 'repo lib >']);
    // the nested repository's Branches is expanded but hidden under its collapsed row, so it is not read
    expect(expandedGroups(open)).toEqual([{ repoId: 'r1', group: 'tags' }]);
  });

  it('shows nothing under a group still loading, and a note under a failed or empty one', () => {
    const lists = new Map<RepositoryGroup, GroupList>([['branches', { state: 'loading' }], ['tags', { state: 'failed' }], ['stashes', { state: 'ready', artifacts: { group: 'stashes', rows: [] } }]]);
    const rows = buildRepositoryRows({ ...input({}, REPOSITORY_EXPANDED), lists: (_repoId, group) => lists.get(group) });
    expect(summary(rows)).toEqual(['branches - v', 'stashes 0 v', '  note empty', 'tags - v', '  note failed', 'worktrees - v']);
    expect(rows[0]!.kind === 'group' && rows[0]!.loading).toBe(true);
  });

  it('keeps row ids stable across runs: a repository is named by its place in the project, never its run id', () => {
    const nextRun: RepositoryEntry = { ...NESTED, repoId: 'another-run' };
    expect(groupRowId({ displayPath: 'lib' }, 'tags')).toBe(groupRowId(nextRun, 'tags'));
    expect(folderRowId(REPO, 'branches', 'feat')).not.toBe(folderRowId(REPO, 'tags', 'feat'));
  });
});

const REPOSITORY_EXPANDED = (['branches', 'stashes', 'tags', 'worktrees'] as const).map((group) => groupRowId(REPO, group));

describe('type-ahead', () => {
  it('finds the next row starting with the typed text, wrapping, and cycles on a repeated letter', () => {
    const labels = ['Branches', 'feat', 'main', 'Stashes', 'Tags', 'tip'];
    expect(typeAheadIndex(labels, 0, 'm')).toBe(2);
    expect(typeAheadIndex(labels, 2, 'ta')).toBe(4);
    expect(typeAheadIndex(labels, 4, 'tt')).toBe(5);
    expect(typeAheadIndex(labels, 5, 't')).toBe(4);
    expect(typeAheadIndex(labels, 0, 'q')).toBeUndefined();
  });
});
