import { describe, expect, it, vi } from 'vitest';
import { GitError, RemoteCancelledError } from '../../../../core/scm/errors';
import type { FlowStart, ForkState, PublishState } from '../../../../shared/forge/publish';
import type { LocalizedText } from '../../../../shared/localized-text';
import type { OverlayAnswer, OverlayRequest } from '../../../preload/overlay-channels';
import type { CoreClient } from '../../core-client';
import { mergeRequestTemplate, PublishFlow, type PublishFlowDeps } from '../publish-flow';

// Main's publish and fork flows (docs/invariants.md "GitHub and GitLab accounts", publish and fork): a fork is offered only
// after an authorization-class failure and the server's confirmation, never on a non-fast-forward rejection; a stop before the
// push restores the remotes exactly, a failed push keeps the new layout, and the create page opens only through the guarded opener.

const DENIED = { access: 'denied' as const, serverId: 'gitlab.indigital.gr', serverName: 'gitlab.indigital.gr', kind: 'gitlab' as const, accountId: 'gitlab.indigital.gr|32', login: 'astefanopoulos', path: 'grp/damocles' };
const FORBIDDEN = new GitError('git push failed', 128, '', "remote: You are not allowed to push code to this project.\nfatal: unable to access 'https://gitlab.indigital.gr/grp/damocles.git/': The requested URL returned error: 403");
const NON_FAST_FORWARD = new GitError('git push failed', 1, '', " ! [rejected]        main -> main (fetch first)\nerror: failed to push some refs\nremote: Permission to x denied");

const GROUP = { value: 'gitlab.com|alexios-s|indigital-oss', kind: 'group' as const, path: 'indigital-oss', internal: true };
const CREATED = { kind: 'created', url: 'https://gitlab.com/alexios-s/damocles-fork.git', serverId: 'gitlab.com', accountId: 'gitlab.com|2001', serverName: 'gitlab.com', login: 'alexios-s', path: 'alexios-s/damocles-fork' };

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(reason: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

// every step of these worlds answers in microtasks, so one macrotask turn lets a flow run as far as it can
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

async function ran(start: FlowStart): Promise<void> {
  expect(start).toBe('started');
  await settle();
}

interface WorldOptions {
  readonly authority?: string;
  readonly features?: readonly string[];
  readonly remotes?: readonly string[];
  readonly template?: string;
  readonly bind?: 'saved' | 'unsaved' | 'unlisted' | 'throws';
  readonly kind?: 'github' | 'gitlab';
}

function world(options: WorldOptions = {}) {
  const calls: string[] = [];
  const remotes = new Set(options.remotes ?? ['origin']);
  const failing = new Map<string, unknown>();
  const client = {
    forgePublishAccounts: vi.fn(async () => ({
      accounts: [{ accountId: 'gitlab.com|2001', serverName: 'gitlab.com', login: 'alexios-s', kind: 'gitlab' as const, personal: { value: 'gitlab.com|alexios-s|personal', kind: 'personal' as const, path: 'alexios-s', internal: true } }],
    })),
    forgePublishOwners: vi.fn(async (_params: { accountId: string }, _signal: AbortSignal): Promise<unknown> => ({ status: 'loaded', owners: [GROUP], truncated: false })),
    forgeCreateRepository: vi.fn(async (): Promise<unknown> => CREATED),
    forgePushAccess: vi.fn(async (_params: unknown, _signal: AbortSignal): Promise<unknown> => DENIED),
    forgeFork: vi.fn(async (_params: unknown, _signal: AbortSignal): Promise<unknown> => ({ kind: 'forked', url: 'https://gitlab.indigital.gr/astefanopoulos/damocles.git', path: 'astefanopoulos/damocles' })),
    forgeOpenMergeRequest: vi.fn(async (_params: unknown): Promise<unknown> => ({ url: 'https://gitlab.indigital.gr/astefanopoulos/damocles/-/merge_requests/new?x=1', serverName: 'gitlab.indigital.gr' })),
    forgeOpenOrgAccess: vi.fn(async () => true),
  };
  const step = async (name: string, work: () => void): Promise<void> => {
    calls.push(name);
    const failure = failing.get(name.split(' ')[0]!);
    if (failure !== undefined) throw failure;
    work();
  };
  // listed: the project is in the project list, which it leaves before its repository closes
  const open = { repository: true, listed: true };
  const show = vi.fn(async (_side: string, file: string): Promise<Buffer | undefined> => (options.template !== undefined && file === '.gitlab/merge_request_templates/Default.md' ? Buffer.from(options.template) : undefined));
  const scm = {
    repository: (repoId: string) => (repoId === 'repo' && open.repository ? {
      projectKey: 'c:/src/damocles',
      repo: { authority: options.authority ?? 'local', root: 'C:\\src\\damocles', show },
    } : undefined),
    remotes: vi.fn(async (_repoId: string) => [...remotes].map((name) => ({ name }))),
    renameRemote: vi.fn((_repoId: string, from: string, to: string) => step(`rename ${from} ${to}`, () => {
      remotes.delete(from);
      remotes.add(to);
    })),
    addRemote: vi.fn((_repoId: string, name: string, url: string) => step(`add ${name} ${url}`, () => void remotes.add(name))),
    removeRemote: vi.fn((_repoId: string, name: string) => step(`remove ${name}`, () => void remotes.delete(name))),
    push: vi.fn((_repoId: string, request: { remote?: string; branch?: string }) => step(`push ${request.remote} ${request.branch}`, () => undefined).then(() => true)),
  };
  const answer = deferred<OverlayAnswer>();
  const asked: OverlayRequest[] = [];
  const publishStates: PublishState[] = [];
  const forkStates: ForkState[] = [];
  const notices: string[] = [];
  const opened: string[] = [];
  const bound: unknown[] = [];
  const render = (text: LocalizedText): string => text.message.replace(/\{(\d+)\}/g, (_m, index: string) => {
    const arg = text.args?.[Number(index)];
    return typeof arg === 'object' && 'message' in arg ? render(arg) : String(arg);
  });
  const ask = vi.fn(async (request: OverlayRequest): Promise<OverlayAnswer> => {
    asked.push(request);
    return answer.promise;
  });
  const deps: PublishFlowDeps = {
    core: (_label, work) => work(client as unknown as CoreClient),
    scm: scm as unknown as PublishFlowDeps['scm'],
    features: () => options.features,
    endpoints: async () => [
      { remote: 'origin', fetch: { protocol: 'https', host: 'gitlab.indigital.gr', path: 'grp/damocles.git', aliasResolved: false } },
      { remote: 'fork', fetch: { protocol: 'https', host: 'gitlab.indigital.gr', path: 'astefanopoulos/damocles.git', aliasResolved: false } },
    ],
    serverKind: () => options.kind ?? 'gitlab',
    projectName: () => (open.listed ? 'damocles' : undefined),
    bind: async (projectKey, bind) => {
      bound.push({ projectKey, ...bind });
      if (options.bind === 'throws') throw new Error('Damocles Core stopped');
      return options.bind ?? 'saved';
    },
    openOnServer: async (url) => {
      opened.push(url);
      return true;
    },
    ask,
    pushPublishState: (state) => void publishStates.push(state),
    pushForkState: (state) => void forkStates.push(state),
    render,
    notify: {
      info: (message) => void notices.push(`info: ${message}`),
      warn: async (message, action) => {
        notices.push(`warn: ${message} [${action}]`);
        return true;
      },
      error: (message) => void notices.push(`error: ${message}`),
    },
    log: () => undefined,
  };
  return { flow: new PublishFlow(deps), client, scm, show, calls, remotes, failing, answer, ask, asked, open, publishStates, forkStates, notices, opened, bound };
}

const forkRequest = (w: ReturnType<typeof world>): Extract<OverlayRequest, { kind: 'forgeFork' }> => {
  const request = w.asked.find((item): item is Extract<OverlayRequest, { kind: 'forgeFork' }> => item.kind === 'forgeFork');
  if (!request) throw new Error('no fork dialog');
  return request;
};

describe('push failure handling', () => {
  it('never asks the server about a non-fast-forward rejection or any failure that is not authorization', async () => {
    const w = world();
    expect(await w.flow.pushRefused('repo', 'origin', 'main', NON_FAST_FORWARD)).toBe(false);
    expect(await w.flow.pushRefused('repo', 'origin', 'main', new GitError('x', 128, '', 'fatal: Could not resolve host'))).toBe(false);
    expect(w.client.forgePushAccess).not.toHaveBeenCalled();
    expect(w.asked).toEqual([]);
  });

  it('opens the fork dialog only when the server says the account cannot push', async () => {
    const w = world();
    w.client.forgePushAccess.mockResolvedValueOnce({ access: 'canPush' });
    expect(await w.flow.pushRefused('repo', 'origin', 'fix/token-refresh', FORBIDDEN)).toBe(false);
    w.client.forgePushAccess.mockResolvedValueOnce({ access: 'unknown' });
    expect(await w.flow.pushRefused('repo', 'origin', 'fix/token-refresh', FORBIDDEN)).toBe(false);
    expect(w.asked).toEqual([]);
    expect(await w.flow.pushRefused('repo', 'origin', 'fix/token-refresh', FORBIDDEN)).toBe(true);
    expect(w.client.forgePushAccess).toHaveBeenLastCalledWith({ repo: { projectKey: 'c:/src/damocles', authorityKey: 'local', endpoints: expect.any(Array) }, remote: 'origin' }, expect.any(AbortSignal));
    expect(forkRequest(w).dialog).toMatchObject({ serverName: 'gitlab.indigital.gr', kind: 'gitlab', path: 'grp/damocles', login: 'astefanopoulos', branch: 'fix/token-refresh', remote: 'origin', upstreamName: 'upstream', upstreamExists: false });
  });

  it('ends the server\'s push access check when the flows are disposed', async () => {
    const w = world();
    const signals: AbortSignal[] = [];
    w.client.forgePushAccess.mockImplementationOnce(async (_params: unknown, signal: AbortSignal) => {
      signals.push(signal);
      return { access: 'unknown' };
    });
    await w.flow.pushRefused('repo', 'origin', 'main', FORBIDDEN);
    expect(signals[0]!.aborted).toBe(false);
    w.flow.dispose();
    expect(signals[0]!.aborted).toBe(true);
  });

  it('shows the organization notice for an SSO-protected organization instead of a fork', async () => {
    const w = world({ kind: 'github' });
    w.client.forgePushAccess.mockResolvedValueOnce({ access: 'orgAccess', accountId: 'github.com|1001', org: 'indigital', text: { message: 'The {0} organization requires single sign-on.', args: ['indigital'] }, action: { message: 'Authorize Damocles for {0}', args: ['indigital'] } });
    expect(await w.flow.pushRefused('repo', 'origin', 'main', FORBIDDEN)).toBe(true);
    await settle();
    expect(w.notices).toEqual(['warn: The indigital organization requires single sign-on. [Authorize Damocles for indigital]']);
    expect(w.client.forgeOpenOrgAccess).toHaveBeenCalledWith({ accountId: 'github.com|1001', org: 'indigital' });
    expect(w.asked).toEqual([]);
  });

  it('names the original upstream-2 when upstream is taken', async () => {
    const w = world({ remotes: ['origin', 'upstream'] });
    expect(await w.flow.pushRefused('repo', 'origin', 'main', FORBIDDEN)).toBe(true);
    expect(forkRequest(w).dialog).toMatchObject({ upstreamName: 'upstream-2', upstreamExists: true });
  });

  it('offers no fork on a remote project whose daemon cannot rename remotes, and does on one that can', async () => {
    expect(await world({ authority: 'ssh+prod-1', features: ['scm.remoteEndpoints'] }).flow.pushRefused('repo', 'origin', 'main', FORBIDDEN)).toBe(false);
    expect(await world({ authority: 'ssh+prod-1', features: ['scm.renameRemote'] }).flow.pushRefused('repo', 'origin', 'main', FORBIDDEN)).toBe(true);
  });

  it('asks a GitLab server nothing when no fork could follow, and a GitHub one only for its organization notice', async () => {
    const gitlab = world({ authority: 'ssh+prod-1', features: [] });
    expect(await gitlab.flow.pushRefused('repo', 'origin', 'main', FORBIDDEN)).toBe(false);
    const notOrigin = world();
    expect(await notOrigin.flow.pushRefused('repo', 'fork', 'main', FORBIDDEN)).toBe(false);
    expect(gitlab.client.forgePushAccess).not.toHaveBeenCalled();
    expect(notOrigin.client.forgePushAccess).not.toHaveBeenCalled();
    const github = world({ kind: 'github', authority: 'ssh+prod-1', features: [] });
    expect(await github.flow.pushRefused('repo', 'origin', 'main', FORBIDDEN)).toBe(false);
    expect(github.client.forgePushAccess).toHaveBeenCalledTimes(1);
    expect(github.asked).toEqual([]);
  });
});

describe('Fork and Push', () => {
  async function opened(options: WorldOptions = {}, branch = 'fix/token-refresh') {
    const w = world(options);
    expect(await w.flow.pushRefused('repo', 'origin', branch, FORBIDDEN)).toBe(true);
    return { w, requestId: forkRequest(w).dialog.requestId };
  }

  it('forks, renames origin, adds the fork as origin, binds and pushes, then opens the create page with the branch and template', async () => {
    const { w, requestId } = await opened({ remotes: ['origin', 'upstream'], template: '## What\n' });
    await ran(w.flow.forkStart(requestId));
    expect(w.calls).toEqual(['rename origin upstream-2', 'add origin https://gitlab.indigital.gr/astefanopoulos/damocles.git', 'push origin fix/token-refresh']);
    expect(w.bound).toEqual([{ projectKey: 'c:/src/damocles', serverId: 'gitlab.indigital.gr', accountId: 'gitlab.indigital.gr|32' }]);
    expect(w.forkStates.map((state) => state.phase === 'running' ? `${state.steps.map((item) => item.state[0]).join('')}${state.cancellable ? '+' : '-'}` : state.phase)).toEqual(['appp+', 'dapp+', 'ddap+', 'ddda-', 'done']);
    expect(w.forkStates.at(-1)).toMatchObject({ phase: 'done', remotes: [{ name: 'origin', display: 'gitlab.indigital.gr/astefanopoulos/damocles' }, { name: 'upstream-2', display: 'gitlab.indigital.gr/grp/damocles' }] });
    w.answer.resolve({ kind: 'forgeFork', openMergeRequest: true });
    await settle();
    expect(w.client.forgeOpenMergeRequest).toHaveBeenCalledWith({ serverId: 'gitlab.indigital.gr', accountId: 'gitlab.indigital.gr|32', upstreamPath: 'grp/damocles', forkPath: 'astefanopoulos/damocles', branch: 'fix/token-refresh', template: '## What\n' });
    expect(w.opened).toEqual(['https://gitlab.indigital.gr/astefanopoulos/damocles/-/merge_requests/new?x=1']);
    expect(w.notices.at(-1)).toContain('Opened the new merge request page on gitlab.indigital.gr');
  });

  it('ignores a second start while one runs', async () => {
    const { w, requestId } = await opened();
    w.client.forgeFork.mockImplementationOnce(() => new Promise(() => undefined));
    expect(w.flow.forkStart(requestId)).toBe('started');
    expect(w.flow.forkStart(requestId)).toBe('ignored');
    expect(w.flow.forkStart('another')).toBe('ignored');
  });

  it('pushes the branch git named and opens its create page, though the dialog shows it with its hidden characters escaped', async () => {
    const { w, requestId } = await opened({}, 'fix\u200B');
    expect(forkRequest(w).dialog.branch).toBe('fix\\u{200B}');
    await ran(w.flow.forkStart(requestId));
    expect(w.calls.at(-1)).toBe('push origin fix\u200B');
    w.answer.resolve({ kind: 'forgeFork', openMergeRequest: true });
    await settle();
    expect(w.client.forgeOpenMergeRequest).toHaveBeenCalledWith(expect.objectContaining({ branch: 'fix\u200B' }));
  });

  it('opens the create page without a template when HEAD cannot be read', async () => {
    const { w, requestId } = await opened({ template: '## What\n' });
    await ran(w.flow.forkStart(requestId));
    w.show.mockRejectedValue(new Error('the repository closed'));
    w.answer.resolve({ kind: 'forgeFork', openMergeRequest: true });
    await settle();
    expect(w.client.forgeOpenMergeRequest).toHaveBeenCalledWith(expect.not.objectContaining({ template: expect.anything() }));
    expect(w.opened).toHaveLength(1);
  });

  it('forks nothing when the remotes changed since the dialog opened', async () => {
    const { w, requestId } = await opened();
    w.remotes.add('upstream');
    await ran(w.flow.forkStart(requestId));
    expect(w.client.forgeFork).not.toHaveBeenCalled();
    expect(w.calls).toEqual([]);
    expect(w.forkStates.at(-1)).toMatchObject({ phase: 'failed', restored: true, steps: [{ state: 'failed', failure: 'The remotes of this repository changed since the dialog opened, so nothing was forked. Push again to start over.' }, { state: 'pending' }, { state: 'pending' }, { state: 'pending' }] });
  });

  it('cancelled while the server copies: nothing changes on the remotes and the user is told', async () => {
    const { w, requestId } = await opened();
    w.client.forgeFork.mockImplementationOnce((_params, signal) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })));
    expect(w.flow.forkStart(requestId)).toBe('started');
    await settle();
    w.answer.resolve({ kind: 'dismissed' });
    await settle();
    expect(w.calls).toEqual([]);
    expect(w.notices).toEqual(['info: Fork canceled. Nothing changed on your remotes.']);
  });

  it('cancelled while the server refuses the fork: the user hears the cancel, not the refusal', async () => {
    const { w, requestId } = await opened();
    w.client.forgeFork.mockImplementationOnce((_params, signal) => new Promise((resolve) => signal.addEventListener('abort', () => resolve({ kind: 'failed', reason: { message: '{0} refused to fork {1}.', args: ['gitlab.indigital.gr', 'grp/damocles'] } }), { once: true })));
    expect(w.flow.forkStart(requestId)).toBe('started');
    await settle();
    w.answer.resolve({ kind: 'dismissed' });
    await settle();
    expect(w.calls).toEqual([]);
    expect(w.forkStates.some((state) => state.phase === 'failed')).toBe(false);
    expect(w.notices).toEqual(['info: Fork canceled. Nothing changed on your remotes.']);
  });

  it('ends a fork the server is copying when the flows are disposed', async () => {
    const { w, requestId } = await opened();
    w.client.forgeFork.mockImplementationOnce((_params, signal) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })));
    expect(w.flow.forkStart(requestId)).toBe('started');
    await settle();
    w.flow.dispose();
    await settle();
    expect(w.calls).toEqual([]);
    expect(w.notices).toEqual(['info: Fork canceled. Nothing changed on your remotes.']);
  });

  it('lets go of the forge host\'s end once the dialog closed', async () => {
    const { w, requestId } = await opened();
    await ran(w.flow.forkStart(requestId));
    w.answer.resolve({ kind: 'dismissed' });
    await settle();
    w.flow.dispose();
    expect((w.client.forgeFork.mock.calls[0]![1] as AbortSignal).aborted).toBe(false);
  });

  it('cancelled after the server accepted the fork: the remotes stay as they were and the user learns the fork stays', async () => {
    const { w, requestId } = await opened();
    w.client.forgeFork.mockImplementationOnce((_params, signal) => new Promise((resolve) => signal.addEventListener('abort', () => resolve({ kind: 'cancelled', path: 'astefanopoulos/damocles' }), { once: true })));
    expect(w.flow.forkStart(requestId)).toBe('started');
    await settle();
    w.answer.resolve({ kind: 'dismissed' });
    await settle();
    expect(w.calls).toEqual([]);
    expect(w.notices).toEqual(['info: Fork canceled. Your remotes are as they were; the fork astefanopoulos/damocles stays on gitlab.indigital.gr.']);
  });

  it.each([
    ['the rename', 'renameRemote', ['rename origin upstream', 'rename upstream origin']],
    ['the origin add', 'addRemote', ['rename origin upstream', 'add origin https://gitlab.indigital.gr/astefanopoulos/damocles.git', 'remove origin', 'rename upstream origin']],
  ] as const)('cancelled during %s: the remotes are put back and the fork stays', async (_label, method, calls) => {
    const { w, requestId } = await opened();
    const editing = deferred<void>();
    const original = w.scm[method].getMockImplementation()!;
    w.scm[method].mockImplementationOnce(async (repoId: string, a: string, b: string) => {
      await editing.promise;
      return original(repoId, a, b);
    });
    expect(w.flow.forkStart(requestId)).toBe('started');
    await settle();
    w.answer.resolve({ kind: 'dismissed' });
    await settle();
    editing.resolve();
    await settle();
    expect(w.calls).toEqual(calls);
    expect([...w.remotes]).toEqual(['origin']);
    expect(w.notices).toEqual(['info: Fork canceled. Your remotes are as they were; the fork astefanopoulos/damocles stays on gitlab.indigital.gr.']);
  });

  it('a failure before the push restores the remotes exactly and says so, and that the fork stays on the server', async () => {
    const { w, requestId } = await opened();
    w.failing.set('add', new GitError('git remote add failed', 3, '', 'error: remote origin already exists.'));
    await ran(w.flow.forkStart(requestId));
    expect(w.calls).toEqual(['rename origin upstream', 'add origin https://gitlab.indigital.gr/astefanopoulos/damocles.git', 'rename upstream origin']);
    expect([...w.remotes]).toEqual(['origin']);
    expect(w.forkStates.at(-1)).toMatchObject({ phase: 'failed', restored: true, steps: [{ state: 'done' }, { state: 'done' }, { state: 'failed', failure: 'error: remote origin already exists. The fork astefanopoulos/damocles stays on gitlab.indigital.gr.' }, { state: 'pending' }] });
  });

  // a remote daemon that dropped after git renamed: the answer is lost, the rename is not
  it('undoes a rename whose answer was lost, judged from the remotes as they are', async () => {
    const { w, requestId } = await opened();
    const rename = w.scm.renameRemote.getMockImplementation()!;
    w.scm.renameRemote.mockImplementationOnce(async (repoId, from, to) => {
      await rename(repoId, from, to);
      throw new Error('the connection to prod-1 closed');
    });
    await ran(w.flow.forkStart(requestId));
    expect(w.calls).toEqual(['rename origin upstream', 'rename upstream origin']);
    expect([...w.remotes]).toEqual(['origin']);
    expect(w.forkStates.at(-1)).toMatchObject({ phase: 'failed', restored: true });
  });

  it('a restore that fails never reports the remotes as restored', async () => {
    const { w, requestId } = await opened();
    w.failing.set('add', new GitError('git remote add failed', 3, '', 'error: could not lock config file'));
    const rename = w.scm.renameRemote.getMockImplementation()!;
    w.scm.renameRemote.mockImplementation(async (repoId, from, to) => {
      if (from === 'upstream') throw new GitError('git remote rename failed', 3, '', 'error: could not lock config file');
      return rename(repoId, from, to);
    });
    await ran(w.flow.forkStart(requestId));
    const last = w.forkStates.at(-1);
    expect(last).toMatchObject({ phase: 'failed', restored: false, restoreFailed: true });
    expect(last?.phase === 'failed' ? last.steps[2]?.failure : undefined).toContain('Damocles could not put the remotes back as they were');
  });

  it('a restore whose read of the remotes fails reports that it could not restore', async () => {
    const { w, requestId } = await opened();
    w.failing.set('add', new GitError('git remote add failed', 3, '', 'error: could not lock config file'));
    const read = w.scm.remotes.getMockImplementation()!;
    // the read before the fork answers; the restore's read fails
    w.scm.remotes.mockImplementationOnce(read).mockRejectedValueOnce(new GitError('git remote failed', 128, '', 'fatal: not a git repository'));
    await ran(w.flow.forkStart(requestId));
    const last = w.forkStates.at(-1);
    expect(last).toMatchObject({ phase: 'failed', restored: false, restoreFailed: true });
    expect(last?.phase === 'failed' ? last.steps[2]?.failure : undefined).toContain('Damocles could not put the remotes back as they were: fatal: not a git repository');
  });

  it('closing the question without forking says the push was not sent', async () => {
    const { w } = await opened();
    w.answer.resolve({ kind: 'dismissed' });
    await settle();
    expect(w.notices).toEqual(['info: Push not sent. Your commits are still on fix/token-refresh.']);
    expect(w.client.forgeFork).not.toHaveBeenCalled();
  });

  it.each([
    ['unsaved', 'could not save which account'],
    ['throws', 'could not save which account'],
    ['unlisted', 'The project was removed, so nothing was pushed.'],
  ] as const)('pushes nothing and restores the remotes when the account could not be saved for the project (%s)', async (bind, failure) => {
    const { w, requestId } = await opened({ bind });
    await ran(w.flow.forkStart(requestId));
    expect(w.calls.some((call) => call.startsWith('push'))).toBe(false);
    expect(w.calls.slice(-2)).toEqual(['remove origin', 'rename upstream origin']);
    expect([...w.remotes]).toEqual(['origin']);
    expect(w.forkStates.at(-1)).toMatchObject({ phase: 'failed', restored: true, steps: [{ state: 'done' }, { state: 'done' }, { state: 'done' }, { state: 'failed', failure: expect.stringContaining(failure) }] });
  });

  it('a failed push keeps the new layout: origin is the fork, upstream the original', async () => {
    const { w, requestId } = await opened();
    w.failing.set('push', new GitError('git push failed', 1, '', 'fatal: unable to access: Could not resolve host'));
    await ran(w.flow.forkStart(requestId));
    expect(w.calls.filter((call) => call.startsWith('rename') || call.startsWith('remove'))).toEqual(['rename origin upstream']);
    expect([...w.remotes].sort()).toEqual(['origin', 'upstream']);
    expect(w.forkStates.at(-1)).toMatchObject({ phase: 'failed', restored: false, steps: [{ state: 'done' }, { state: 'done' }, { state: 'done' }, { state: 'failed' }] });
    expect(w.forkStates.at(-1)).not.toHaveProperty('restoreFailed');
  });

  it('runs on after the dialog closes mid-push, and tells the user the outcome', async () => {
    const { w, requestId } = await opened();
    const pushing = deferred<boolean>();
    w.scm.push.mockImplementationOnce(() => pushing.promise);
    expect(w.flow.forkStart(requestId)).toBe('started');
    await settle();
    expect(w.scm.push).toHaveBeenCalled();
    w.answer.resolve({ kind: 'dismissed' });
    await settle();
    pushing.resolve(true);
    await settle();
    expect(w.notices).toEqual(['info: Pushed fix/token-refresh to your fork astefanopoulos/damocles on gitlab.indigital.gr.']);
  });
});

describe('Publish', () => {
  const unpublished = (options: WorldOptions = {}) => world({ remotes: [], ...options });
  const requestOf = (w: ReturnType<typeof world>): Extract<OverlayRequest, { kind: 'forgePublish' }>['dialog'] => (w.asked[0] as Extract<OverlayRequest, { kind: 'forgePublish' }>).dialog;

  it('keeps the zero-remote warning when no account can publish, and says when the repository or its project closed', async () => {
    const w = unpublished();
    w.client.forgePublishAccounts.mockResolvedValueOnce({ accounts: [] });
    expect(await w.flow.publish('repo', 'main')).toBe('noAccount');
    expect(await w.flow.publish('gone', 'main')).toBe('closed');
    const listing = w.client.forgePublishAccounts.getMockImplementation()!;
    w.client.forgePublishAccounts.mockImplementationOnce(async () => {
      w.open.listed = false;
      return listing();
    });
    expect(await w.flow.publish('repo', 'main')).toBe('closed');
    expect(w.asked).toEqual([]);
  });

  it('creates, adds it as origin, binds the account and pushes', async () => {
    const w = unpublished();
    expect(await w.flow.publish('repo', 'main')).toBe('shown');
    const dialog = requestOf(w);
    expect(dialog).toMatchObject({ project: 'damocles', branch: 'main', defaultOwner: 'gitlab.com|alexios-s|personal', defaultName: 'damocles' });
    await ran(w.flow.publishSubmit(dialog.requestId, 'gitlab.com|alexios-s|personal', 'damocles fork', 'public'));
    expect(w.client.forgeCreateRepository).toHaveBeenCalledWith({ owner: 'gitlab.com|alexios-s|personal', name: 'damocles fork', visibility: 'public' });
    expect(w.calls).toEqual(['add origin https://gitlab.com/alexios-s/damocles-fork.git', 'push origin main']);
    expect(w.bound).toEqual([{ projectKey: 'c:/src/damocles', serverId: 'gitlab.com', accountId: 'gitlab.com|2001' }]);
    expect(w.publishStates.at(-1)).toMatchObject({ phase: 'done', target: { serverName: 'gitlab.com', path: 'alexios-s/damocles-fork', login: 'alexios-s', branch: 'main' } });
  });

  it('pushes the branch git named and shows it with its hidden characters escaped', async () => {
    const w = unpublished();
    await w.flow.publish('repo', 'main\u202E');
    const dialog = requestOf(w);
    expect(dialog.branch).toBe('main\\u{202E}');
    await ran(w.flow.publishSubmit(dialog.requestId, 'gitlab.com|alexios-s|personal', 'damocles', 'private'));
    expect(w.calls.at(-1)).toBe('push origin main\u202E');
    expect(w.publishStates.at(-1)).toMatchObject({ phase: 'done', target: { branch: 'main\\u{202E}' } });
  });

  it('opens one Publish per repository, and tells the user when its dialog cannot show', async () => {
    const w = unpublished();
    expect(await w.flow.publish('repo', 'main')).toBe('shown');
    expect(await w.flow.publish('repo', 'main')).toBe('shown');
    expect(w.asked).toHaveLength(1);
    const failing = unpublished();
    failing.ask.mockRejectedValueOnce(new Error('the window has no overlay'));
    expect(await failing.flow.publish('repo', 'main')).toBe('shown');
    await settle();
    expect(failing.notices).toEqual(['error: Publish could not open.']);
    // the session that could not show is gone, so Publish opens again
    expect(await failing.flow.publish('repo', 'main')).toBe('shown');
    expect(failing.ask).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['a remote was added since it opened', (w: ReturnType<typeof world>) => void w.remotes.add('origin')],
    ['the repository closed', (w: ReturnType<typeof world>) => void (w.open.repository = false)],
  ])('creates nothing when %s', async (_label, change) => {
    const w = unpublished();
    await w.flow.publish('repo', 'main');
    change(w);
    await ran(w.flow.publishSubmit(requestOf(w).requestId, 'gitlab.com|alexios-s|personal', 'damocles', 'private'));
    expect(w.client.forgeCreateRepository).not.toHaveBeenCalled();
    expect(w.publishStates.at(-1)).toMatchObject({ phase: 'failed', steps: [{ state: 'failed', failure: 'This repository changed since Publish opened.' }, { state: 'pending' }, { state: 'pending' }] });
  });

  it('ignores a second submit while one runs, and one after the dialog closed', async () => {
    const w = unpublished();
    await w.flow.publish('repo', 'main');
    const { requestId } = requestOf(w);
    w.client.forgeCreateRepository.mockImplementationOnce(() => new Promise(() => undefined));
    expect(w.flow.publishSubmit(requestId, 'gitlab.com|alexios-s|personal', 'damocles', 'private')).toBe('started');
    expect(w.flow.publishSubmit(requestId, 'gitlab.com|alexios-s|personal', 'damocles', 'private')).toBe('ignored');
    expect(w.flow.publishSubmit('another', 'gitlab.com|alexios-s|personal', 'damocles', 'private')).toBe('ignored');
  });

  it('shows a refused name with the server\'s reason and takes another submit', async () => {
    const w = unpublished();
    await w.flow.publish('repo', 'main');
    const { requestId } = requestOf(w);
    w.client.forgeCreateRepository.mockResolvedValueOnce({ kind: 'refused', reason: { message: '{0} refused: {1}', args: ['gitlab.com', 'name has already been taken'] } });
    await ran(w.flow.publishSubmit(requestId, 'gitlab.com|alexios-s|personal', 'damocles', 'private'));
    expect(w.publishStates.at(-1)).toEqual({ requestId, phase: 'refused', reason: 'gitlab.com refused: name has already been taken' });
    expect(w.calls).toEqual([]);
    await ran(w.flow.publishSubmit(requestId, 'gitlab.com|alexios-s|personal', 'damocles-2', 'private'));
    expect(w.publishStates.at(-1)).toMatchObject({ phase: 'done' });
  });

  it('a created repository Damocles cannot add marks Create done and fails Origin, saying the repository exists', async () => {
    const w = unpublished();
    await w.flow.publish('repo', 'main');
    const { requestId } = requestOf(w);
    w.client.forgeCreateRepository.mockResolvedValueOnce({ kind: 'createdUnusable', serverName: 'gitlab.com', path: 'alexios-s/damocles', reason: { message: '{0} answered without the repository\'s path.', args: ['gitlab.com'] } });
    await ran(w.flow.publishSubmit(requestId, 'gitlab.com|alexios-s|personal', 'damocles', 'private'));
    expect(w.calls).toEqual([]);
    expect(w.publishStates.at(-1)).toMatchObject({
      phase: 'failed',
      target: { path: 'alexios-s/damocles' },
      steps: [{ state: 'done' }, { state: 'failed', failure: 'alexios-s/damocles exists on gitlab.com, but Damocles cannot add it as origin: gitlab.com answered without the repository\'s path.' }, { state: 'pending' }],
    });
  });

  it('cancelled while the server creates: nothing is added and the user learns the repository stays', async () => {
    const w = unpublished();
    await w.flow.publish('repo', 'main');
    const { requestId } = requestOf(w);
    const creating = deferred<unknown>();
    w.client.forgeCreateRepository.mockImplementationOnce(() => creating.promise);
    expect(w.flow.publishSubmit(requestId, 'gitlab.com|alexios-s|personal', 'damocles fork', 'public')).toBe('started');
    await settle();
    w.answer.resolve({ kind: 'dismissed' });
    await settle();
    creating.resolve(CREATED);
    await settle();
    expect(w.calls).toEqual([]);
    expect(w.notices).toEqual(['info: Publish canceled. alexios-s/damocles-fork stays on gitlab.com.']);
  });

  it('cancelled while origin is added: the origin goes again and the user learns the repository stays', async () => {
    const w = unpublished();
    await w.flow.publish('repo', 'main');
    const adding = deferred<void>();
    const add = w.scm.addRemote.getMockImplementation()!;
    w.scm.addRemote.mockImplementationOnce(async (repoId, name, url) => {
      await adding.promise;
      return add(repoId, name, url);
    });
    expect(w.flow.publishSubmit(requestOf(w).requestId, 'gitlab.com|alexios-s|personal', 'damocles fork', 'public')).toBe('started');
    await settle();
    w.answer.resolve({ kind: 'dismissed' });
    await settle();
    adding.resolve();
    await settle();
    expect(w.calls).toEqual(['add origin https://gitlab.com/alexios-s/damocles-fork.git', 'remove origin']);
    expect([...w.remotes]).toEqual([]);
    expect(w.notices).toEqual(['info: Publish canceled. alexios-s/damocles-fork stays on gitlab.com.']);
  });

  it('tells the user when the origin it added cannot be removed after a cancel', async () => {
    const w = unpublished();
    await w.flow.publish('repo', 'main');
    const adding = deferred<void>();
    const add = w.scm.addRemote.getMockImplementation()!;
    w.scm.addRemote.mockImplementationOnce(async (repoId, name, url) => {
      await adding.promise;
      return add(repoId, name, url);
    });
    w.failing.set('remove', new GitError('git remote remove failed', 3, '', 'error: could not lock config file'));
    expect(w.flow.publishSubmit(requestOf(w).requestId, 'gitlab.com|alexios-s|personal', 'damocles fork', 'public')).toBe('started');
    await settle();
    w.answer.resolve({ kind: 'dismissed' });
    await settle();
    adding.resolve();
    await settle();
    expect(w.notices).toEqual(['error: Damocles could not remove the origin remote it added: error: could not lock config file', 'info: Publish canceled. alexios-s/damocles-fork stays on gitlab.com.']);
  });

  it.each([
    ['unsaved', 'Damocles could not save which account this project uses, so nothing was pushed. Settings › Models & accounts › Git hosting says why.'],
    ['throws', 'Damocles could not save which account this project uses, so nothing was pushed.'],
    ['unlisted', 'The project was removed, so nothing was pushed.'],
  ] as const)('pushes nothing when the account could not be saved (%s)', async (bind, failure) => {
    const w = unpublished({ bind });
    await w.flow.publish('repo', 'main');
    await ran(w.flow.publishSubmit(requestOf(w).requestId, 'gitlab.com|alexios-s|personal', 'damocles', 'private'));
    expect(w.calls.some((call) => call.startsWith('push'))).toBe(false);
    expect(w.publishStates.at(-1)).toMatchObject({ phase: 'failed', steps: [{ state: 'done' }, { state: 'done' }, { state: 'failed', failure }] });
  });

  it.each([
    ['git\'s words', new GitError('git push failed', 1, '', 'fatal: unable to access: Could not resolve host'), 'fatal: unable to access: Could not resolve host'],
    ['a canceled push', new RemoteCancelledError(), 'The push was canceled. alexios-s/damocles-fork is origin; push again to publish main.'],
  ])('a failed push fails its step with %s', async (_label, error, failure) => {
    const w = unpublished();
    await w.flow.publish('repo', 'main');
    w.failing.set('push', error);
    await ran(w.flow.publishSubmit(requestOf(w).requestId, 'gitlab.com|alexios-s|personal', 'damocles-fork', 'private'));
    expect(w.publishStates.at(-1)).toMatchObject({ phase: 'failed', steps: [{ state: 'done' }, { state: 'done' }, { state: 'failed', failure }] });
  });

  it('runs on after the dialog closes mid-push, and tells the user the outcome', async () => {
    const w = unpublished();
    await w.flow.publish('repo', 'main');
    const pushing = deferred<boolean>();
    w.scm.push.mockImplementationOnce(() => pushing.promise);
    expect(w.flow.publishSubmit(requestOf(w).requestId, 'gitlab.com|alexios-s|personal', 'damocles fork', 'public')).toBe('started');
    await settle();
    expect(w.scm.push).toHaveBeenCalled();
    w.answer.resolve({ kind: 'dismissed' });
    await settle();
    pushing.resolve(true);
    await settle();
    expect(w.notices).toEqual(['info: Published gitlab.com/alexios-s/damocles-fork. This project now uses alexios-s on gitlab.com.']);
  });

  it('refuses an owner the dialog did not offer, and one listed before a failed Try again', async () => {
    const w = unpublished();
    await w.flow.publish('repo', 'main');
    const { requestId } = requestOf(w);
    expect(() => w.flow.publishSubmit(requestId, 'gitlab.com|alexios-s|readers', 'x', 'private')).toThrow('did not offer');
    expect(() => w.flow.publishSubmit(requestId, GROUP.value, 'x', 'private')).toThrow('did not offer');
    expect(await w.flow.publishOwners(requestId, 'gitlab.com|2001')).toEqual({ status: 'loaded', owners: [GROUP], truncated: false });
    w.client.forgePublishOwners.mockResolvedValueOnce({ status: 'error', message: { message: 'Could not reach {0}. Check the connection and try again.', args: ['gitlab.com'] } });
    expect(await w.flow.publishOwners(requestId, 'gitlab.com|2001')).toEqual({ status: 'error', message: 'Could not reach gitlab.com. Check the connection and try again.' });
    expect(() => w.flow.publishSubmit(requestId, GROUP.value, 'x', 'private')).toThrow('did not offer');
    expect(w.client.forgeCreateRepository).not.toHaveBeenCalled();
  });

  it('opens at once with each account\'s own namespace, before any listing, and publishes to a group listed in the dialog', async () => {
    const w = unpublished();
    expect(await w.flow.publish('repo', 'main')).toBe('shown');
    expect(w.client.forgePublishOwners).not.toHaveBeenCalled();
    const dialog = requestOf(w);
    expect(dialog.accounts).toEqual([{ accountId: 'gitlab.com|2001', serverName: 'gitlab.com', login: 'alexios-s', kind: 'gitlab', personal: { value: 'gitlab.com|alexios-s|personal', kind: 'personal', path: 'alexios-s', internal: true } }]);
    expect(await w.flow.publishOwners(dialog.requestId, 'gitlab.com|2001')).toEqual({ status: 'loaded', owners: [GROUP], truncated: false });
    await ran(w.flow.publishSubmit(dialog.requestId, GROUP.value, 'site', 'private'));
    expect(w.client.forgeCreateRepository).toHaveBeenCalledWith({ owner: GROUP.value, name: 'site', visibility: 'private' });
    expect(w.publishStates.at(-1)).toMatchObject({ phase: 'done', target: { path: 'alexios-s/damocles-fork' } });
  });

  it('aborts a listing when the dialog closes, and a newer listing of the account aborts the older', async () => {
    const w = unpublished();
    await w.flow.publish('repo', 'main');
    const { requestId } = requestOf(w);
    const signals: AbortSignal[] = [];
    // core answers cancelled once main's abort reaches it, as the core protocol's cancel does
    w.client.forgePublishOwners.mockImplementation((_params, signal) => {
      signals.push(signal);
      return new Promise((resolve) => signal.addEventListener('abort', () => resolve({ status: 'cancelled' }), { once: true }));
    });
    const older = w.flow.publishOwners(requestId, 'gitlab.com|2001');
    const newer = w.flow.publishOwners(requestId, 'gitlab.com|2001');
    expect(await older).toEqual({ status: 'cancelled' });
    expect(signals[0]!.aborted).toBe(true);
    expect(signals[1]!.aborted).toBe(false);
    w.answer.resolve({ kind: 'dismissed' });
    expect(await newer).toEqual({ status: 'cancelled' });
    expect(signals[1]!.aborted).toBe(true);
  });

  it('answers cancelled, not an error, when its own abort ends the request with a rejection', async () => {
    const w = unpublished();
    await w.flow.publish('repo', 'main');
    const { requestId } = requestOf(w);
    w.client.forgePublishOwners.mockImplementationOnce((_params, signal) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('The request was cancelled')), { once: true })));
    const listing = w.flow.publishOwners(requestId, 'gitlab.com|2001');
    w.answer.resolve({ kind: 'dismissed' });
    expect(await listing).toEqual({ status: 'cancelled' });
    // a rejection main did not cause is the account's error, which the dialog shows with Try again
    const again = unpublished();
    await again.flow.publish('repo', 'main');
    const other = requestOf(again).requestId;
    again.client.forgePublishOwners.mockRejectedValueOnce(new Error('Damocles Core stopped'));
    expect(await again.flow.publishOwners(other, 'gitlab.com|2001')).toEqual({ status: 'error', message: 'Damocles could not list the organizations and groups of alexios-s on gitlab.com.' });
  });
});

describe('the create page\'s template', () => {
  it('is left out, with a log line, when HEAD cannot be read', async () => {
    const logs: string[] = [];
    const repo = { show: vi.fn(async (): Promise<Buffer | undefined> => Promise.reject(new Error('the repository closed'))) };
    expect(await mergeRequestTemplate(repo, 'github', (line) => logs.push(line))).toBeUndefined();
    expect(logs).toEqual(['[forge] reading the merge request template failed, so the create page opens without it: the repository closed']);
  });
});
