import { describe, expect, it, vi } from 'vitest';
import { GitError, RemoteCancelledError } from '../../../../core/scm/errors';
import type { ProtectedPushState } from '../../../../shared/forge/protected-push';
import type { FlowStart } from '../../../../shared/forge/publish';
import type { LocalizedText } from '../../../../shared/localized-text';
import type { OverlayAnswer, OverlayRequest } from '../../../preload/overlay-channels';
import type { CoreClient } from '../../core-client';
import { ProtectedPushFlow, takenProblem, type ProtectedPushDeps } from '../protected-push-flow';

// A push the server refused on a branch it protects (docs/invariants.md "GitHub and GitLab accounts", protected branch on
// push): the dialog only when the server's rules say so, a new branch's name by git's rules and the branches that exist, the
// branch made at HEAD and pushed only as new, the local branch never moved, and the create page into the protected branch.

const DECLINED = new GitError('git push failed', 1, '', 'remote: GitLab: You are not allowed to push code to protected branches on this project.\n ! [remote rejected] main -> main (pre-receive hook declined)');
const PROTECTED = { protection: 'protected' as const, serverId: 'gitlab.com', serverName: 'gitlab.com', kind: 'gitlab' as const, accountId: 'gitlab.com|2001', login: 'alexios-s', path: 'alexios-s/damocles' };

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

// every step of these worlds answers in microtasks, so one macrotask turn lets a flow run as far as it can
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

async function ran(start: FlowStart): Promise<void> {
  expect(start).toBe('started');
  await settle();
}

function world(options: { readonly authority?: string; readonly features?: readonly string[]; readonly local?: readonly string[]; readonly remote?: readonly string[]; readonly template?: string; readonly unpushed?: number; readonly ignoresCase?: boolean } = {}) {
  const calls: string[] = [];
  const local = [...(options.local ?? ['main'])];
  const client = {
    forgePushProtection: vi.fn(async (_params: unknown, _signal: AbortSignal): Promise<unknown> => PROTECTED),
    forgeOpenMergeRequest: vi.fn(async (): Promise<unknown> => ({ url: 'https://gitlab.com/alexios-s/damocles/-/merge_requests/new?x=1', serverName: 'gitlab.com' })),
  };
  // git's ref rules as check-ref-format --branch applies them, for the names these tests use
  const isValidBranchName = vi.fn(async (name: string) => name !== '' && !name.startsWith('-') && !/\.\.|[\s~^:?*[\\]|\.lock$|\/$/.test(name));
  // the commits HEAD has that no ref of the named remote holds, as rev-list counts them on the project's core
  const unpushedCount = vi.fn(async (_remote: string) => options.unpushed ?? 2);
  const ignoresCase = vi.fn(async () => options.ignoresCase ?? false);
  const pushFailures: unknown[] = [];
  const head = { branch: 'main', hash: 'c'.repeat(40) };
  const scm = {
    currentStatus: vi.fn(async () => ({ head: { type: 'branch', name: head.branch }, commit: { hash: head.hash, subject: 'local' } })),
    repository: (repoId: string) => (repoId === 'repo' ? {
      projectKey: 'c:/src/damocles',
      repo: {
        authority: options.authority ?? 'local',
        isValidBranchName,
        unpushedCount,
        ignoresCase,
        show: vi.fn(async (_side: string, file: string) => (options.template !== undefined && file === '.gitlab/merge_request_templates/Default.md' ? Buffer.from(options.template) : undefined)),
      },
    } : undefined),
    artifacts: vi.fn(async () => ({ group: 'branches', rows: local.map((name) => ({ name })) })),
    remoteBranches: vi.fn(async () => [...(options.remote ?? ['main'])]),
    createBranch: vi.fn(async (_repoId: string, name: string, start: string): Promise<void> => {
      calls.push(`createBranch ${name} ${start}`);
      local.push(name);
    }),
    push: vi.fn(async (_repoId: string, request: Record<string, unknown>) => {
      calls.push(`push ${JSON.stringify(request)}`);
      const failure = pushFailures.shift();
      if (failure !== undefined) throw failure;
      return true;
    }),
  };
  const answer = deferred<OverlayAnswer>();
  const asked: OverlayRequest[] = [];
  const states: ProtectedPushState[] = [];
  const notices: string[] = [];
  const opened: string[] = [];
  const render = (text: LocalizedText): string => text.message.replace(/\{(\d+)\}/g, (_m, index: string) => String(text.args?.[Number(index)]));
  const deps: ProtectedPushDeps = {
    core: (_label, work) => work(client as unknown as CoreClient),
    scm: scm as unknown as ProtectedPushDeps['scm'],
    features: () => options.features,
    endpoints: async () => [{ remote: 'origin', fetch: { protocol: 'https', host: 'gitlab.com', path: 'alexios-s/damocles.git', aliasResolved: false } }],
    openOnServer: async (url) => {
      opened.push(url);
      return true;
    },
    ask: async (request) => {
      asked.push(request);
      return answer.promise;
    },
    pushState: (state) => void states.push(state),
    render,
    notify: {
      info: (message) => void notices.push(`info: ${message}`),
      error: (message) => void notices.push(`error: ${message}`),
    },
    log: () => undefined,
  };
  return { flow: new ProtectedPushFlow(deps), client, scm, calls, local, answer, asked, states, notices, opened, pushFailures, isValidBranchName, unpushedCount, ignoresCase, head };
}

const dialogOf = (w: ReturnType<typeof world>): Extract<OverlayRequest, { kind: 'forgeProtectedBranch' }>['dialog'] => {
  const request = w.asked.find((item): item is Extract<OverlayRequest, { kind: 'forgeProtectedBranch' }> => item.kind === 'forgeProtectedBranch');
  if (!request) throw new Error('no protected-branch dialog');
  return request.dialog;
};

describe('when the protected-branch dialog opens', () => {
  it('opens only for a refused push whose branch the server protects for the account, naming it and the unpushed commits', async () => {
    const w = world();
    expect(await w.flow.pushRefused('repo', 'origin', 'main', 'main', DECLINED)).toBe(true);
    expect(w.client.forgePushProtection).toHaveBeenCalledWith({ repo: { projectKey: 'c:/src/damocles', authorityKey: 'local', endpoints: [expect.objectContaining({ remote: 'origin' })] }, remote: 'origin', branch: 'main' }, expect.any(AbortSignal));
    expect(dialogOf(w)).toEqual({ requestId: expect.any(String), branch: 'main', serverName: 'gitlab.com', kind: 'gitlab', login: 'alexios-s', remote: 'origin', localBranch: 'main', unpushedCount: 2, suggestedName: 'alexios-s/main' });
  });

  it('keeps today\'s behaviour when the server says the branch is not protected or cannot say, and never asks about a non-fast-forward', async () => {
    const w = world();
    w.client.forgePushProtection.mockResolvedValueOnce({ protection: 'unprotected' });
    expect(await w.flow.pushRefused('repo', 'origin', 'main', 'main', DECLINED)).toBe(false);
    w.client.forgePushProtection.mockResolvedValueOnce({ protection: 'unknown' });
    expect(await w.flow.pushRefused('repo', 'origin', 'main', 'main', DECLINED)).toBe(false);
    w.client.forgePushProtection.mockRejectedValueOnce(new Error('Damocles Core stopped'));
    expect(await w.flow.pushRefused('repo', 'origin', 'main', 'main', DECLINED)).toBe(false);
    expect(await w.flow.pushRefused('repo', 'origin', 'main', 'main', new GitError('x', 1, '', ' ! [rejected] main -> main (non-fast-forward)'))).toBe(false);
    expect(await w.flow.pushRefused('repo', 'origin', 'main', 'main', new GitError('x', 128, '', "fatal: Authentication failed for 'https://gitlab.com/a/b.git/'"))).toBe(false);
    expect(w.client.forgePushProtection).toHaveBeenCalledTimes(3);
    expect(w.asked).toEqual([]);
  });

  it('counts the commits the refused remote lacks, whatever the local branch\'s upstream is', async () => {
    const w = world({ unpushed: 4 });
    await w.flow.pushRefused('repo', 'fork', 'main', 'main', DECLINED);
    expect(w.unpushedCount).toHaveBeenCalledWith('fork');
    expect(dialogOf(w).unpushedCount).toBe(4);
  });

  it('offers no new branch on a remote project whose daemon cannot push a branch only as new or count what the remote lacks', async () => {
    expect(await world({ authority: 'ssh+prod-1', features: ['scm.remoteEndpoints'] }).flow.pushRefused('repo', 'origin', 'main', 'main', DECLINED)).toBe(false);
    expect(await world({ authority: 'ssh+prod-1', features: ['scm.push.createOnly'] }).flow.pushRefused('repo', 'origin', 'main', 'main', DECLINED)).toBe(false);
    const remote = world({ authority: 'ssh+prod-1', features: ['scm.push.createOnly', 'scm.unpushedCount'] });
    expect(await remote.flow.pushRefused('repo', 'origin', 'main', 'main', DECLINED)).toBe(true);
  });

  it('never rejects: a check that fails while the dialog is prepared leaves the push\'s own failure to show', async () => {
    const w = world();
    w.isValidBranchName.mockRejectedValueOnce(new Error('the remote core went away'));
    expect(await w.flow.pushRefused('repo', 'origin', 'main', 'main', DECLINED)).toBe(false);
    w.unpushedCount.mockRejectedValueOnce(new Error('the remote core went away'));
    expect(await w.flow.pushRefused('repo', 'origin', 'main', 'main', DECLINED)).toBe(false);
    expect(w.asked).toEqual([]);
  });

  it('suggests the next free name, and none when every candidate is taken', async () => {
    const taken = world({ local: ['main', 'alexios-s/main'], remote: ['main', 'alexios-s/main-2'] });
    await taken.flow.pushRefused('repo', 'origin', 'main', 'main', DECLINED);
    expect(dialogOf(taken).suggestedName).toBe('alexios-s/main-3');
    // a branch named after the login is a folder git cannot put branches under
    const blocked = world({ local: ['main', 'alexios-s'] });
    await blocked.flow.pushRefused('repo', 'origin', 'main', 'main', DECLINED);
    expect(dialogOf(blocked).suggestedName).toBe('');
  });
});

describe('the branch name', () => {
  it('is refused when git\'s rules refuse it, or a local or remote branch holds it or its folders', () => {
    const names = { local: ['main', 'feature/a'], remote: ['main', 'release/1.x', 'hotfix'] };
    expect(takenProblem('main', names, false)).toBe('existsLocally');
    expect(takenProblem('release/1.x', names, false)).toBe('existsOnRemote');
    expect(takenProblem('feature', names, false)).toBe('conflicts');
    expect(takenProblem('hotfix/x', names, false)).toBe('conflicts');
    expect(takenProblem('alexios-s/main', names, false)).toBeUndefined();
  });

  // loose refs on a case-insensitive file system: git cannot hold Main beside main
  it('is taken in any letter case when the repository ignores case', () => {
    const names = { local: ['main', 'Feature/a'], remote: ['Release'] };
    expect(takenProblem('Main', names, true)).toBe('existsLocally');
    expect(takenProblem('release', names, true)).toBe('existsOnRemote');
    expect(takenProblem('feature', names, true)).toBe('conflicts');
    expect(takenProblem('Main', names, false)).toBeUndefined();
  });

  it('is checked in any letter case only where git ignores case, and a daemon that cannot say is read as case-sensitive', async () => {
    const folding = world({ ignoresCase: true });
    await folding.flow.pushRefused('repo', 'origin', 'main', 'main', DECLINED);
    expect(await folding.flow.checkName(dialogOf(folding).requestId, 'MAIN')).toEqual({ name: 'MAIN', problem: 'existsLocally' });
    const older = world({ authority: 'ssh+prod-1', features: ['scm.push.createOnly', 'scm.unpushedCount'], ignoresCase: true });
    await older.flow.pushRefused('repo', 'origin', 'main', 'main', DECLINED);
    expect(older.ignoresCase).not.toHaveBeenCalled();
    expect(await older.flow.checkName(dialogOf(older).requestId, 'MAIN')).toEqual({ name: 'MAIN' });
  });

  it('is checked through git on the project\'s core, with the branches read fresh', async () => {
    const w = world({ remote: ['main', 'taken'] });
    await w.flow.pushRefused('repo', 'origin', 'main', 'main', DECLINED);
    const { requestId } = dialogOf(w);
    expect(await w.flow.checkName(requestId, '')).toEqual({ name: '', problem: 'empty' });
    expect(await w.flow.checkName(requestId, 'bad..name')).toEqual({ name: 'bad..name', problem: 'invalid' });
    expect(await w.flow.checkName(requestId, '-x')).toEqual({ name: '-x', problem: 'invalid' });
    expect(await w.flow.checkName(requestId, 'taken')).toEqual({ name: 'taken', problem: 'existsOnRemote' });
    expect(await w.flow.checkName(requestId, 'alexios-s/fix')).toEqual({ name: 'alexios-s/fix' });
    expect(w.isValidBranchName).toHaveBeenCalledWith('bad..name');
  });
});

describe('Push to a New Branch', () => {
  it('re-checks the name, creates it at HEAD, pushes it only as new with upstream, and leaves the local branch alone', async () => {
    const w = world();
    await w.flow.pushRefused('repo', 'origin', 'main', 'main', DECLINED);
    const { requestId } = dialogOf(w);
    await ran(w.flow.push(requestId, 'alexios-s/main'));
    expect(w.calls).toEqual([
      `createBranch alexios-s/main ${'c'.repeat(40)}`,
      `push ${JSON.stringify({ remote: 'origin', branch: 'alexios-s/main', setUpstream: true, followTags: false, force: false, createOnly: true })}`,
    ]);
    expect(w.states.map((state) => state.phase)).toEqual(['running', 'running', 'done']);
    expect(w.states.at(-1)).toEqual({ requestId, phase: 'done', name: 'alexios-s/main', steps: [{ step: 'branch', state: 'done' }, { step: 'push', state: 'done' }] });
  });

  // an agent shell, a terminal or another window may switch branches while the dialog is open
  it('creates nothing when HEAD left the refused branch since the dialog opened, and starts at the commit it read', async () => {
    const w = world();
    await w.flow.pushRefused('repo', 'origin', 'main', 'main', DECLINED);
    const { requestId } = dialogOf(w);
    w.head.branch = 'feature';
    await ran(w.flow.push(requestId, 'alexios-s/main'));
    expect(w.calls).toEqual([]);
    expect(w.states.at(-1)).toEqual({ requestId, phase: 'failed', name: 'alexios-s/main', steps: [{ step: 'branch', state: 'failed', failure: 'The repository is no longer on main, so no branch was created. Switch back to main and push again.' }, { step: 'push', state: 'pending' }] });
    w.head.branch = 'main';
    w.head.hash = 'd'.repeat(40);
    await ran(w.flow.push(requestId, 'alexios-s/main'));
    expect(w.calls[0]).toBe(`createBranch alexios-s/main ${'d'.repeat(40)}`);
  });

  it('refuses a name main\'s own check refuses, running nothing, and takes another', async () => {
    const w = world();
    await w.flow.pushRefused('repo', 'origin', 'main', 'main', DECLINED);
    const { requestId } = dialogOf(w);
    await ran(w.flow.push(requestId, 'main'));
    expect(w.states).toEqual([{ requestId, phase: 'refused', name: 'main', problem: 'existsLocally' }]);
    expect(w.calls).toEqual([]);
    await ran(w.flow.push(requestId, 'alexios-s/main'));
    expect(w.states.at(-1)).toMatchObject({ phase: 'done' });
  });

  it('shows git\'s words when the server refuses the new branch, with the branch step done', async () => {
    const w = world();
    await w.flow.pushRefused('repo', 'origin', 'main', 'main', DECLINED);
    const { requestId } = dialogOf(w);
    w.pushFailures.push(new GitError('git push failed', 1, '', ' ! [rejected]        alexios-s/main -> alexios-s/main (stale info)\nerror: failed to push some refs'));
    await ran(w.flow.push(requestId, 'alexios-s/main'));
    expect(w.states.at(-1)).toEqual({ requestId, phase: 'failed', name: 'alexios-s/main', steps: [{ step: 'branch', state: 'done' }, { step: 'push', state: 'failed', failure: 'error: failed to push some refs' }] });
  });

  it('opens the create page from the new branch into the protected one, with the template, on Open Merge Request', async () => {
    const w = world({ template: '## Why\n' });
    await w.flow.pushRefused('repo', 'origin', 'main', 'main', DECLINED);
    const { requestId } = dialogOf(w);
    await ran(w.flow.push(requestId, 'alexios-s/main'));
    w.answer.resolve({ kind: 'forgeProtectedBranch', openMergeRequest: true });
    await vi.waitFor(() => expect(w.opened).toEqual(['https://gitlab.com/alexios-s/damocles/-/merge_requests/new?x=1']));
    expect(w.client.forgeOpenMergeRequest).toHaveBeenCalledWith({ serverId: 'gitlab.com', accountId: 'gitlab.com|2001', upstreamPath: 'alexios-s/damocles', forkPath: 'alexios-s/damocles', branch: 'alexios-s/main', targetBranch: 'main', template: '## Why\n' });
    expect(w.notices).toEqual(['info: Opened the new merge request page on gitlab.com, from alexios-s/main into main.']);
  });

  it('says the push was not sent when the dialog closes before any step', async () => {
    const w = world();
    await w.flow.pushRefused('repo', 'origin', 'main', 'main', DECLINED);
    w.answer.resolve({ kind: 'dismissed' });
    await settle();
    expect(w.notices).toEqual(['info: Push not sent. Your commits are still on main.']);
    expect(w.calls).toEqual([]);
  });

  it('runs on after the dialog closes mid-push, and tells the user the outcome', async () => {
    const w = world();
    await w.flow.pushRefused('repo', 'origin', 'main', 'main', DECLINED);
    const { requestId } = dialogOf(w);
    const pushing = deferred<boolean>();
    w.scm.push.mockImplementationOnce(() => pushing.promise);
    expect(w.flow.push(requestId, 'alexios-s/main')).toBe('started');
    await settle();
    expect(w.scm.push).toHaveBeenCalled();
    w.answer.resolve({ kind: 'dismissed' });
    await settle();
    pushing.resolve(true);
    await settle();
    expect(w.notices).toEqual(['info: Pushed alexios-s/main to origin. main is unchanged.']);
  });

  it('creates and pushes nothing when the dialog closes while the name is checked again, and says the push was not sent once', async () => {
    const w = world();
    await w.flow.pushRefused('repo', 'origin', 'main', 'main', DECLINED);
    const { requestId } = dialogOf(w);
    const reading = deferred<string[]>();
    w.scm.remoteBranches.mockImplementationOnce(() => reading.promise);
    expect(w.flow.push(requestId, 'alexios-s/main')).toBe('started');
    await settle();
    w.answer.resolve({ kind: 'dismissed' });
    await settle();
    reading.resolve(['main']);
    await settle();
    expect(w.calls).toEqual([]);
    expect(w.scm.currentStatus).not.toHaveBeenCalled();
    expect(w.notices).toEqual(['info: Push not sent. Your commits are still on main.']);
    expect(w.states).toEqual([]);
  });

  it('ignores a second push while one runs', async () => {
    const w = world();
    await w.flow.pushRefused('repo', 'origin', 'main', 'main', DECLINED);
    const { requestId } = dialogOf(w);
    w.scm.push.mockImplementationOnce(() => new Promise(() => undefined));
    expect(w.flow.push(requestId, 'alexios-s/main')).toBe('started');
    expect(w.flow.push(requestId, 'alexios-s/other')).toBe('ignored');
    expect(w.flow.push('another', 'alexios-s/main')).toBe('ignored');
  });

  it('fails the branch step with git\'s words when the branch cannot be created, and pushes nothing', async () => {
    const w = world();
    await w.flow.pushRefused('repo', 'origin', 'main', 'main', DECLINED);
    const { requestId } = dialogOf(w);
    w.scm.createBranch.mockRejectedValueOnce(new GitError('git checkout failed', 128, '', "fatal: cannot lock ref 'refs/heads/alexios-s/main'"));
    await ran(w.flow.push(requestId, 'alexios-s/main'));
    expect(w.scm.push).not.toHaveBeenCalled();
    expect(w.states.at(-1)).toEqual({ requestId, phase: 'failed', name: 'alexios-s/main', steps: [{ step: 'branch', state: 'failed', failure: "fatal: cannot lock ref 'refs/heads/alexios-s/main'" }, { step: 'push', state: 'pending' }] });
  });

  it('says the push was canceled when the user stops it', async () => {
    const w = world();
    await w.flow.pushRefused('repo', 'origin', 'main', 'main', DECLINED);
    const { requestId } = dialogOf(w);
    w.pushFailures.push(new RemoteCancelledError());
    await ran(w.flow.push(requestId, 'alexios-s/main'));
    expect(w.states.at(-1)).toMatchObject({ phase: 'failed', steps: [{ step: 'branch', state: 'done' }, { step: 'push', state: 'failed', failure: 'The push was canceled.' }] });
  });

  it('compares HEAD with the branch git named and pushes to the remote git named, though the dialog escapes them', async () => {
    const w = world();
    w.head.branch = 'main\u200B';
    await w.flow.pushRefused('repo', 'origin', 'main', 'main\u200B', DECLINED);
    expect(dialogOf(w).localBranch).toBe('main\\u{200B}');
    await ran(w.flow.push(dialogOf(w).requestId, 'alexios-s/main'));
    expect(w.states.at(-1)).toMatchObject({ phase: 'done' });
  });

  it('suggests no name when the login and branch make one longer than a branch name may be', async () => {
    const w = world();
    // 70 + '/' + 190 characters: past the 255 a branch name may hold
    w.client.forgePushProtection.mockResolvedValueOnce({ ...PROTECTED, login: 'l'.repeat(70) });
    expect(await w.flow.pushRefused('repo', 'origin', 'b'.repeat(190), 'main', DECLINED)).toBe(true);
    expect(dialogOf(w).suggestedName).toBe('');
  });
});
