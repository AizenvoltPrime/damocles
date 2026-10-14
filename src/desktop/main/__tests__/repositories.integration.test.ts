import { execFileSync } from 'node:child_process';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ScmArtifacts } from '../../preload/scm-channels';
import { buildRepositoryRows, folderRowId, groupRowId, REPOSITORY_GROUPS, type GroupList, type RepositoryEntry, type RepositoryGroup } from '../../shell/scm/repositories-tree';
import { folder, git, GIT_PATH, harness, HAS_GIT, makeRepo, ready, statusOf, useGitSandbox, waitFor, write } from '../../../core/scm/__tests__/git-harness';

/** The Repositories section's groups (D58) built from the artifacts core lists for a real repository. */
useGitSandbox();

// A commit with a fixed date, so for-each-ref --sort=-creatordate orders the branches as written.
function commitOn(repo: string, file: string, message: string, date: string): void {
  write(path.join(repo, file), `${message}\n`);
  git(['add', '.'], repo);
  execFileSync(GIT_PATH!, ['commit', '--quiet', '-m', message], { cwd: repo, env: { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date }, stdio: 'ignore' });
}

describe.runIf(HAS_GIT)('the Repositories groups against a real repository', () => {
  it('builds Branches with folders and a merged chain, Stashes, Tags and Worktrees from the artifacts git lists', async () => {
    const repo = makeRepo(folder('acme'));
    commitOn(repo, 'main.txt', 'main work', '2025-01-01T10:00:00Z');
    for (const [name, date] of [['feat/a', '2025-01-02T10:00:00Z'], ['feat/b', '2025-01-03T10:00:00Z'], ['team/ax/fix', '2025-01-04T10:00:00Z']] as const) {
      git(['switch', '--quiet', '-c', name, 'main'], repo);
      commitOn(repo, `${name.replace(/\//g, '-')}.txt`, `${name} work`, date);
    }
    git(['switch', '--quiet', 'main'], repo);
    git(['tag', 'v1.0'], repo);
    write(path.join(repo, 'a.txt'), 'changed\n');
    git(['stash', 'push', '--quiet', '-m', 'wip'], repo);
    const linked = path.join(folder('linked'), 'acme-hotfix');
    git(['worktree', 'add', '--quiet', '--detach', linked], repo);

    const h = harness({ trusted: [repo] });
    try {
      h.service.setProjects([{ key: 'p', path: repo }]);
      const repoId = (await ready(h)).repos[0]!.repoId;
      await waitFor(() => statusOf(h, repoId), 'a first status');
      const lists = new Map<RepositoryGroup, GroupList>();
      for (const group of REPOSITORY_GROUPS) {
        const artifacts = await h.service.artifacts(repoId, group);
        // main's own Open routing marks worktree rows (ScmHost.artifacts); the tree reads only their order and text here
        const shown = (artifacts.group === 'worktrees' ? { group: 'worktrees', rows: artifacts.rows.map((row) => ({ ...row, opens: 'addProject' as const })) } : artifacts) as ScmArtifacts;
        lists.set(group, { state: 'ready', artifacts: shown });
      }
      const entry: RepositoryEntry = { repoId, label: 'acme', displayPath: '', head: 'main' };
      const expanded = [...REPOSITORY_GROUPS.map((group) => groupRowId(entry, group)), folderRowId(entry, 'branches', 'feat'), folderRowId(entry, 'branches', 'team/ax')];
      const rows = buildRepositoryRows({ repos: [entry], expanded: new Set(expanded), lists: (_repoId, group) => lists.get(group), timeOf: (date) => new Date(date).toISOString().slice(0, 10), detached: 'detached' });

      const shown = rows.map((row) => {
        const indent = '  '.repeat(row.level - 1);
        switch (row.kind) {
          case 'group': return `${indent}${row.group} ${row.count}`;
          case 'folder': return `${indent}folder ${row.label}`;
          case 'branch': return `${indent}${row.branch.current ? '@' : ''}${row.label} | ${row.description.split(' \u2022 ')[1]} | ${row.time}`;
          case 'tag': return `${indent}${row.label}`;
          case 'stash': return `${indent}${row.label} | ${row.description}`;
          case 'worktree': return `${indent}${row.label} | ${row.description.split(' \u2022 ')[0]}`;
          default: return `${indent}${row.kind}`;
        }
      });
      expect(shown).toEqual([
        'branches 4',
        '  folder feat',
        '    b | feat/b work | 2025-01-03',
        '    a | feat/a work | 2025-01-02',
        '  folder team/ax',
        '    fix | team/ax/fix work | 2025-01-04',
        '  @main | main work | 2025-01-01',
        'stashes 1',
        '  wip | main',
        'tags 1',
        '  v1.0',
        'worktrees 2',
        `  ${path.basename(repo)} | main`,
        '  acme-hotfix | detached',
      ]);
      const b = rows.find((row) => row.kind === 'branch' && row.label === 'b');
      expect(b?.kind === 'branch' && b.description.split(' \u2022 ')[0]).toBe(git(['rev-parse', '--short=7', 'feat/b'], repo).trim());
    } finally {
      h.service.dispose();
    }
  });
});
