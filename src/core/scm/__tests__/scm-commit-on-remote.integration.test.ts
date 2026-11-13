import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { folder, freshStatus, git, harness, HAS_GIT, makeRepo, ready, sandbox, statusOf, useGitSandbox, waitFor, write, type Harness } from './git-harness';

/** ScmService.commitOnRemote with real git: `branch -r --contains`, the ahead check and the dirty check (feature scm.commitOnRemote). */
useGitSandbox();

function tracked(name: string): { work: string; origin: string } {
  const origin = path.join(folder(`${name}-root`), `${name}.git`);
  git(['init', '--quiet', '--bare', '-b', 'main', origin], sandbox);
  const work = makeRepo(folder(name));
  git(['remote', 'add', 'origin', origin], work);
  git(['push', '--quiet', '-u', 'origin', 'main'], work);
  return { work, origin };
}

function commit(work: string, file: string, text: string): string {
  write(path.join(work, file), text);
  git(['add', '.'], work);
  git(['commit', '--quiet', '-m', `change ${file}`], work);
  return git(['rev-parse', 'HEAD'], work).trim();
}

async function open(project: string, trusted = true): Promise<{ h: Harness; repoId: string }> {
  const h = harness({ trusted: [project] });
  h.service.setProjects([{ key: 'p', path: project }]);
  const repoId = (await ready(h)).repos[0]!.repoId;
  await waitFor(() => statusOf(h, repoId), 'a first status');
  if (!trusted) h.trust.revoke(project);
  return { h, repoId };
}

describe.skipIf(!HAS_GIT)('commitOnRemote', { timeout: 60_000 }, () => {
  it('answers a pushed commit on the remote, and an unpushed one ahead on HEAD\'s branch', async () => {
    const { work } = tracked('pushed');
    const pushed = git(['rev-parse', 'HEAD'], work).trim();
    const local = commit(work, 'b.txt', 'two\n');
    const { h, repoId } = await open(work);
    await freshStatus(h, repoId);
    expect(await h.service.commitOnRemote(repoId, pushed, undefined, 'origin')).toEqual({ onRemote: true, ahead: false, dirty: false });
    expect(await h.service.commitOnRemote(repoId, local, undefined, 'origin')).toEqual({ onRemote: false, ahead: true, dirty: false });
    git(['push', '--quiet', 'origin', 'main'], work);
    expect(await h.service.commitOnRemote(repoId, local, undefined, 'origin')).toMatchObject({ onRemote: true });
    h.service.dispose();
  });

  it('counts only the branches of the remote the link names', async () => {
    const { work } = tracked('fork');
    const upstream = path.join(folder('fork-upstream'), 'upstream.git');
    git(['init', '--quiet', '--bare', '-b', 'main', upstream], sandbox);
    git(['remote', 'add', 'upstream', upstream], work);
    const onUpstream = commit(work, 'up.txt', 'upstream only\n');
    git(['push', '--quiet', 'upstream', 'main'], work);
    const { h, repoId } = await open(work);
    await freshStatus(h, repoId);
    expect(await h.service.commitOnRemote(repoId, onUpstream, undefined, 'upstream')).toMatchObject({ onRemote: true });
    expect(await h.service.commitOnRemote(repoId, onUpstream, undefined, 'origin')).toEqual({ onRemote: false, ahead: true, dirty: false });
    h.service.dispose();
  });

  it('answers a commit off HEAD\'s branch as not publishable by a push', async () => {
    const { work } = tracked('side');
    git(['checkout', '--quiet', '-b', 'side'], work);
    const side = commit(work, 'side.txt', 'side\n');
    git(['checkout', '--quiet', 'main'], work);
    const { h, repoId } = await open(work);
    await freshStatus(h, repoId);
    expect(await h.service.commitOnRemote(repoId, side, undefined, 'origin')).toEqual({ onRemote: false, ahead: false, dirty: false });
    h.service.dispose();
  });

  it('reports the file as dirty when it has staged or unstaged changes', async () => {
    const { work } = tracked('dirty');
    const head = git(['rev-parse', 'HEAD'], work).trim();
    const { h, repoId } = await open(work);
    await freshStatus(h, repoId, async () => write(path.join(work, 'a.txt'), 'changed\n'));
    expect(await h.service.commitOnRemote(repoId, head, 'a.txt', 'origin')).toEqual({ onRemote: true, ahead: false, dirty: true });
    expect(await h.service.commitOnRemote(repoId, head, 'other.txt', 'origin')).toMatchObject({ dirty: false });
    h.service.dispose();
  });

  it('refuses anything but a full commit id before git runs, an unknown commit, and an untrusted project', async () => {
    const { work } = tracked('refusals');
    const head = git(['rev-parse', 'HEAD'], work).trim();
    const { h, repoId } = await open(work);
    for (const sha of ['HEAD', 'main', '--all', head.slice(0, 7), `${head} --all`, head.toUpperCase()]) {
      await expect(h.service.commitOnRemote(repoId, sha, undefined, 'origin')).rejects.toThrow('full commit id');
    }
    for (const remote of ['', 'a/b', '-x', '..']) await expect(h.service.commitOnRemote(repoId, head, undefined, remote)).rejects.toThrow('remote name');
    await expect(h.service.commitOnRemote(repoId, 'f'.repeat(40), undefined, 'origin')).rejects.toThrow('is not in this repository');
    h.service.dispose();

    const untrusted = await open(work, false);
    await expect(untrusted.h.service.commitOnRemote(untrusted.repoId, head, undefined, 'origin')).rejects.toThrow('trusted project');
    untrusted.h.service.dispose();
  });
});
