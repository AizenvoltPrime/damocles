import * as path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { worktreeIsolationBlock, type WorktreeIsolation } from '../worktree-isolation';

const calls = vi.hoisted(() => ({ canonical: [] as string[] }));
vi.mock('../../canonical-path', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../canonical-path')>();
  return { ...actual, canonicalPath: (p: string) => (calls.canonical.push(p), actual.canonicalPath(p)) };
});

const root = path.resolve('/dam-iso-cost');
const iso: WorktreeIsolation = {
  workingFolder: path.join(root, 'wt'),
  projectPath: path.join(root, 'project'),
  repositoryRoot: path.join(root, 'project'),
  otherWorktrees: [path.join(root, 'other')],
  homeDir: path.join(root, 'home'),
};

describe('worktree isolation file system cost', () => {
  beforeEach(() => {
    calls.canonical.length = 0;
  });

  it('touches no path for a tool it does not check', () => {
    expect(worktreeIsolationBlock('Read', { file_path: path.join(root, 'project', 'a.ts') }, iso)).toBeUndefined();
    expect(worktreeIsolationBlock('Bash', { description: 'no command' }, iso)).toBeUndefined();
    expect(calls.canonical).toEqual([]);
  });

  it('resolves each path once per check', () => {
    expect(worktreeIsolationBlock('Bash', { command: 'git status; git status; cd src; git status; cd ..; git status' }, iso)).toBeUndefined();
    expect(calls.canonical.length).toBeGreaterThan(0);
    expect(new Set(calls.canonical).size).toBe(calls.canonical.length);
  });
});
