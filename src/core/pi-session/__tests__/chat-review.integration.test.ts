import * as path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { log } from '../../logger';
import { createGitRunner, type GitRunner } from '../../scm/git-runner';
import { folder, git, GIT_PATH, HAS_GIT, makeRepo, useGitSandbox, write } from '../../scm/__tests__/git-harness';
import { worktreeGitOf } from '../../worktrees/hand-off';
import type { ChatWorktreeRecord } from '../../worktrees/registry';
import type { WorktreeGit } from '../chat-changes';
import { ChatReview, type ReviewSession } from '../chat-review';

vi.mock('../../logger', () => ({ log: vi.fn() }));

/** A worktree chat's review against real git, with its worktree folder removed under it. */
useGitSandbox();

const FAILED = '[ChatReview] recomputing the chat changes failed: %O';
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function runner(): GitRunner {
  const version = git(['version'], process.cwd()).trim().match(/(\d+)\.(\d+)\.(\d+)/)!;
  return createGitRunner({ git: { path: GIT_PATH!, version: { major: +version[1]!, minor: +version[2]!, patch: +version[3]! } }, log: { appendLine: () => undefined }, isTrusted: () => true });
}

// A linked worktree with one uncommitted change, and the review's git reads there in the order they were made.
function chatWorktree(name: string, baseCommit?: string): { project: string; root: string; calls: string[]; gate: (wait: Promise<void>) => void; session: ReviewSession } {
  const project = makeRepo(folder(name));
  const root = path.join(folder(`${name}-wt`), 'wt');
  git(['worktree', 'add', '--quiet', '-b', `damocles/${name}`, root, 'main'], project);
  write(path.join(root, 'a.txt'), 'two\n');
  const real = worktreeGitOf({ projectPath: project, worktreeRoot: root } as ChatWorktreeRecord, runner());
  const calls: string[] = [];
  let held: Promise<void> | undefined;
  const counted: WorktreeGit = {
    changedSinceBase: async (base) => {
      calls.push('changedSinceBase');
      const wait = held;
      held = undefined;
      await wait;
      return real.changedSinceBase(base);
    },
    untracked: () => {
      calls.push('untracked');
      return real.untracked();
    },
    atBase: (base, relative) => {
      calls.push('atBase');
      return real.atBase(base, relative);
    },
  };
  const session: ReviewSession = {
    branch: [],
    sessionId: 's',
    sessionFile: path.join(root, 's.jsonl'),
    sessionDir: root,
    cwd: root,
    fileCheckpoints: false,
    worktree: { root, baseCommit: baseCommit ?? git(['rev-parse', 'HEAD'], project).trim(), git: counted, sharedWith: async () => 0 },
  };
  return { project, root, calls, gate: (wait) => { held = wait; }, session };
}

function review(session: ReviewSession, published: number[] = []): ChatReview {
  return new ChatReview({
    enabled: () => true,
    session: () => session,
    pendingBaseline: () => Promise.resolve(undefined),
    publish: (totals) => published.push(totals.files),
    watchFolder: () => ({ dispose: () => undefined }),
  });
}

describe.skipIf(!HAS_GIT)('a chat review whose worktree folder is removed', { timeout: 60_000 }, () => {
  it('runs no git in the folder once the review is disposed: a queued run never starts, and dispose settles after the running one', async () => {
    vi.mocked(log).mockClear();
    const { project, root, calls, gate, session } = chatWorktree('disposed');
    let release: () => void = () => undefined;
    gate(new Promise<void>((resolve) => { release = resolve; }));
    const published: number[] = [];
    const chat = review(session, published);
    chat.schedule();
    await vi.waitFor(() => expect(calls).toEqual(['changedSinceBase']), { timeout: 5000 });
    // a second change settles while the first run waits, so its run is queued behind it
    chat.schedule();
    await sleep(700);
    const disposing = chat.dispose();
    setTimeout(release, 200);
    await disposing;
    // the session counts as closed now, so the worktree may be removed
    const readsBeforeRemoval = [...calls];
    git(['worktree', 'remove', '--force', root], project);
    await sleep(800);
    expect(readsBeforeRemoval).toEqual(['changedSinceBase', 'untracked', 'atBase']);
    expect(calls).toEqual(readsBeforeRemoval);
    expect(published).toEqual([]);
    expect(log).not.toHaveBeenCalledWith(FAILED, expect.anything());
  });

  it('logs no failure when the worktree was removed under a live review, and still logs a real failure in an existing worktree', async () => {
    vi.mocked(log).mockClear();
    const removed = chatWorktree('removed');
    const live = review(removed.session);
    live.schedule();
    git(['worktree', 'remove', '--force', removed.root], removed.project);
    await vi.waitFor(() => expect(removed.calls.length).toBeGreaterThan(0), { timeout: 5000 });
    await sleep(300);
    expect(log).not.toHaveBeenCalledWith(FAILED, expect.anything());
    expect(log).toHaveBeenCalledWith('[ChatReview] %s no longer exists, so the chat changes were not recomputed', removed.root);
    await live.dispose();

    const broken = chatWorktree('broken', 'f'.repeat(40));
    const failing = review(broken.session);
    failing.schedule();
    await vi.waitFor(() => expect(log).toHaveBeenCalledWith(FAILED, expect.anything()), { timeout: 5000 });
    await failing.dispose();
  });
});
