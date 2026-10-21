import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { folder, git, harness, HAS_GIT, makeRepo, ready, statusOf, useGitSandbox, waitFor, write, type Harness } from '../../../core/scm/__tests__/git-harness';
import { createCoreEndpoint, createLoopback, createMainEndpoint } from '../../core-protocol';
import { CoreClient } from '../core-client';
import { createScmClient } from '../scm/scm-client';

/** A repository id main holds across a core restart never names the new core's repositories. */
useGitSandbox();

const quiet = (): void => undefined;

// A core serving scm.call from a real ScmService, as core-host/scm.ts does.
function coreOf(h: Harness): CoreClient {
  const { main, core } = createLoopback();
  const client = new CoreClient(createMainEndpoint(main, quiet), (_view, attach) => attach());
  const endpoint = createCoreEndpoint(core, quiet);
  const calls = h.service as unknown as Record<string, (...args: unknown[]) => unknown>;
  endpoint.serve('scm.call', ({ method, args }) => calls[method]!.apply(h.service, [...args]));
  return client;
}

function repoWithEverything(name: string): { repo: string; linked: string } {
  const repo = makeRepo(folder(name));
  git(['switch', '--quiet', '-c', 'feature'], repo);
  write(path.join(repo, 'f.txt'), 'feature\n');
  git(['add', '.'], repo);
  git(['commit', '--quiet', '-m', 'feature work'], repo);
  git(['switch', '--quiet', 'main'], repo);
  write(path.join(repo, 'a.txt'), 'changed\n');
  git(['stash', 'push', '--quiet', '-m', 'keep me'], repo);
  const linked = path.join(folder(`${name}-linked`), 'wt');
  git(['worktree', 'add', '--quiet', '--detach', linked], repo);
  return { repo, linked };
}

describe.runIf(HAS_GIT)('a repository id across a core restart', { timeout: 60_000 }, () => {
  it('is refused by the next core, so a stale destructive call never reaches another repository', async () => {
    const a = repoWithEverything('a');
    const b = repoWithEverything('b');
    const first = harness({ trusted: [a.repo, b.repo] });
    const second = harness({ trusted: [a.repo, b.repo] });
    let running: CoreClient | undefined;
    const scm = createScmClient({ core: (_label, work) => work(running!), gitVersion: undefined, log: quiet });
    try {
      first.service.setProjects([{ key: 'a', path: a.repo }]);
      const held = (await ready(first, 1, 'a')).repos[0]!.repoId;
      running = coreOf(first);
      const attached = scm.attach(running);

      // the core restarts, and the new one opens another project first
      attached.dispose();
      first.service.dispose();
      second.service.setProjects([{ key: 'b', path: b.repo }]);
      const fresh = (await ready(second, 1, 'b')).repos[0]!.repoId;
      await waitFor(() => statusOf(second, fresh), 'a first status');
      running = coreOf(second);
      scm.attach(running);

      expect(fresh).not.toBe(held);
      await expect(scm.stashClear(held)).rejects.toThrow('Unknown repository');
      await expect(scm.deleteBranch(held, 'feature', true)).rejects.toThrow('Unknown repository');
      await expect(scm.removeWorktree(held, b.linked, true)).rejects.toThrow('Unknown repository');
      await scm.cancel(held);
      expect(git(['stash', 'list'], b.repo)).toContain('keep me');
      expect(git(['branch', '--list', 'feature'], b.repo)).toContain('feature');
      expect(git(['worktree', 'list'], b.repo)).toContain('wt');
    } finally {
      second.service.dispose();
      scm.dispose();
    }
  });
});
