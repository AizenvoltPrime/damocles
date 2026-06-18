import { describe, it, expect } from 'vitest';
import * as path from 'path';
import { getRepoDir, getGitDir, getIndexPath, getCheckpointsBaseDir, getWorkspaceCheckpointDir } from '../resolver';

describe('resolver', () => {
  it('derives a repo dir named after the session file basename', () => {
    const repoDir = getRepoDir('/some/where/abc123.jsonl');
    expect(path.basename(repoDir)).toBe('abc123');
    expect(repoDir.startsWith(getCheckpointsBaseDir())).toBe(true);
  });

  it('nests the repo under the session file parent-dir name (per-workspace isolation)', () => {
    const repoDir = getRepoDir('/store/--c--proj-a--/ts_uuid.jsonl');
    // <base>/<encoded-cwd>/<basename> — the workspace component isolates repos across workspaces.
    expect(repoDir).toBe(path.join(getCheckpointsBaseDir(), '--c--proj-a--', 'ts_uuid'));
    expect(path.dirname(repoDir)).toBe(getWorkspaceCheckpointDir('/store/--c--proj-a--'));
  });

  it('keeps different workspaces in disjoint subtrees for the same basename', () => {
    const a = getRepoDir('/store/--c--proj-a--/same.jsonl');
    const b = getRepoDir('/store/--c--proj-b--/same.jsonl');
    expect(a).not.toBe(b);
    expect(path.dirname(a)).not.toBe(path.dirname(b));
  });

  it('strips only the .jsonl extension', () => {
    expect(path.basename(getRepoDir('/x/my.session.jsonl'))).toBe('my.session');
  });

  it('uses the ephemeral slot when no session file is given', () => {
    expect(path.basename(getRepoDir(undefined))).toBe('ephemeral');
  });

  it('places the bare git dir and index inside the repo dir', () => {
    const repoDir = getRepoDir('/x/s.jsonl');
    expect(getGitDir(repoDir)).toBe(path.join(repoDir, '.git'));
    expect(getIndexPath(repoDir)).toBe(path.join(repoDir, 'index'));
  });

  it('roots every repo under the shared sessions base dir', () => {
    const base = getCheckpointsBaseDir();
    expect(getRepoDir('/x/a.jsonl').startsWith(base)).toBe(true);
    expect(getRepoDir(undefined).startsWith(base)).toBe(true);
    expect(base.split(path.sep)).toContain('checkpoints');
  });
});
