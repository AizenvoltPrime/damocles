import { describe, expect, it, vi } from 'vitest';
import type { ScmEvent } from '../../../../core/scm/scm-service';
import type { ChooseAccountRequest, RemoteEndpoint } from '../../../../shared/forge/bindings';
import type { ForgeChooseAccountDialog } from '../../../preload/forge-channels';
import type { CoreClient } from '../../core-client';
import type { ForgeAccountAsker } from '../../overlay';
import type { ScmRepositoryRef } from '../../scm/scm-client';
import { ForgeHost, parseForgeLinkRequest, parseHistoryAuthors, type ForgeHostDeps } from '../forge-host';
import type { CiChangedEvent, CiCommitStatus, CiStatus } from '../../../../core/forge/ci-watch';
import type { CiChanged } from '../../../preload/forge-channels';
import type { RemoteBranchProtection } from '../../../../shared/forge/branch-protection';

const HEAD = '4e1a9c2b7d0f5e6a8c9b1d2e3f4a5b6c7d8e9f00';
const LOCAL_REPO = { repo: { authority: 'local', lastStatus: { upstream: { remote: 'upstream', branch: 'main' }, head: { type: 'branch', name: 'local-main' }, commit: { hash: HEAD, subject: 's' } } }, projectKey: 'c:/src/damocles', projectPath: 'c:/src/damocles', kind: 'repository' } as unknown as ScmRepositoryRef;
const REMOTE_REPO = { repo: { authority: 'ssh+prod-1', lastStatus: undefined }, projectKey: 'ssh+prod-1|/home/alexios/api', projectPath: '/home/alexios/api', kind: 'repository' } as unknown as ScmRepositoryRef;
const PROTECTED_MAIN: readonly RemoteBranchProtection[] = [{ remote: 'upstream', rules: [{ include: ['main'], exclude: [], syntax: 'gitlab' }] }];
const ENDPOINTS: RemoteEndpoint[] = [{ remote: 'origin', fetch: { protocol: 'ssh', host: 'gitlab.com', path: 'grp/proj.git', aliasResolved: true } }];

function world(overrides: { features?: readonly string[]; endpoints?: () => Promise<RemoteEndpoint[]> } = {}) {
  const listeners = new Set<(event: ScmEvent) => void>();
  const client = {
    forgePrepareGitOperation: vi.fn(async (): Promise<{ proceed: boolean; signInServerId?: string }> => ({ proceed: true })),
    forgeRepoAccounts: vi.fn(async () => ({ projectKey: 'c:/src/damocles', project: 'damocles', servers: [] })),
    forgeHostDefaults: vi.fn(async () => ({ state: 'ready' as const, servers: [] })),
    forgeCiWatch: vi.fn(async (): Promise<CiStatus | null> => ({ status: 'error', message: { message: 'Could not reach {0}. Check the connection and try again.', args: ['gitlab.com'] } })),
    forgeCiJobs: vi.fn(async (): Promise<CiStatus | null> => ({ status: 'none' })),
    forgeCiUnwatch: vi.fn(async () => undefined),
    forgeCiJobAction: vi.fn(async (): Promise<{ ok: boolean; jobId?: number }> => ({ ok: true, jobId: 9103 })),
    forgeCiWebUrl: vi.fn(async (): Promise<{ url: string; serverName: string } | null> => ({ url: 'https://gitlab.com/grp/proj/-/pipelines/4312', serverName: 'gitlab.com' })),
    forgeCiCommitStatus: vi.fn(async (): Promise<CiCommitStatus | null> => ({ status: 'none' })),
    forgeHistoryContext: vi.fn(async () => ({ kind: 'gitlab' as const, serverName: 'gitlab.com', showAvatars: true })),
    forgeHistoryAvatars: vi.fn(async (): Promise<Record<string, string>> => ({ 'a.stefanopoulos@indigital.gr': 'f'.repeat(64) })),
    forgeHistoryContaining: vi.fn(async () => ({ kind: 'mergeRequest' as const, number: 45, serverName: 'gitlab.com' })),
    onForgeCiChanged: vi.fn((listener: (event: CiChangedEvent) => void) => {
      ciEvents.push(listener);
      return { dispose: () => undefined };
    }),
    onForgeChooseAccountRows: vi.fn(() => ({ dispose: () => undefined })),
    onForgeBindingsChanged: vi.fn(() => ({ dispose: () => undefined })),
    onForgeChanged: vi.fn((listener: () => void) => {
      forgeChanged.push(listener);
      return { dispose: () => undefined };
    }),
    forgeServersRead: vi.fn(async () => ({ servers: [{ id: 'gitlab.com', webUrl: 'https://gitlab.com', gitHosts: ['gitlab.com'], hasAccount: true }] })),
    forgeLink: vi.fn(async (params: { target: { kind: string; sha?: string } }): Promise<{ url: string; serverName: string; remote: string } | { unavailable: { message: string } }> => ({ url: `https://gitlab.com/grp/proj/-/${params.target.kind === 'commit' ? 'commit' : params.target.kind === 'file' ? 'blob' : 'merge_requests'}/${params.target.sha ?? '45'}`, serverName: 'gitlab.com', remote: 'origin' })),
    forgeCloneSearch: vi.fn((_params: { accountId: string; query: string }, signal: AbortSignal) => new Promise<{ rows: [] }>((resolve, reject) => {
      searches.push({ signal, resolve: () => resolve({ rows: [] }) });
      signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    })),
    forgeBranchProtection: vi.fn(async (_params: { repo: unknown }): Promise<readonly RemoteBranchProtection[]> => PROTECTED_MAIN),
    forgeCloneTarget: vi.fn(async (): Promise<unknown> => ({ ok: true, url: 'https://gitlab.com/grp/proj.git', account: { serverId: 'gitlab.com', accountId: 'gitlab.com|7' }, status: { message: 'Cloning {0}.', args: ['grp/proj'] } })),
  };
  const ciEvents: ((event: CiChangedEvent) => void)[] = [];
  const forgeChanged: (() => void)[] = [];
  // the forge mirror's servers with an account; undefined before core published it
  const mirror: { webUrls: string[] | undefined } = { webUrls: ['https://gitlab.com'] };
  const searches: { signal: AbortSignal; resolve: () => void }[] = [];
  const opens: string[] = [];
  const popovers: { repoId: string; anchor: unknown }[] = [];
  const scm = {
    repository: (repoId: string) => (repoId === 'local-repo' ? LOCAL_REPO : repoId === 'remote-repo' ? REMOTE_REPO : undefined),
    remoteEndpoints: vi.fn(overrides.endpoints ?? (async () => ENDPOINTS)),
    remotes: vi.fn(async () => [{ name: 'origin', fetchUrl: 'git@gl-work:grp/proj.git' }]),
    commitOnRemote: vi.fn(async () => ({ onRemote: true, ahead: false, dirty: false })),
    resolveTypedCommit: vi.fn(async (repoId: string): Promise<string | undefined> => (repoId === 'local-repo' ? HEAD : undefined)),
    onDidChange: (listener: (event: ScmEvent) => void) => {
      listeners.add(listener);
      return { dispose: () => listeners.delete(listener) };
    },
  };
  const asker = { chooseForgeAccount: vi.fn(async (_dialog: ForgeChooseAccountDialog) => ({ kind: 'cancelled' as const })), pushForgeChooseAccountRows: vi.fn() };
  const opened: { serverId?: string; signIn?: boolean }[] = [];
  const logs: string[] = [];
  const copied: string[] = [];
  const clones: unknown[] = [];
  const deps: ForgeHostDeps = {
    core: (_label, work) => work(client as unknown as CoreClient),
    scm: scm as unknown as ForgeHostDeps['scm'],
    features: () => overrides.features,
    projectName: (projectKey) => (projectKey.includes('api') ? 'api' : 'damocles'),
    savedHost: (authority) => (authority === 'ssh+prod-1' ? { hostName: 'prod-1', color: 'danger' as const } : undefined),
    asker: asker as unknown as ForgeAccountAsker,
    openAccounts: (target) => opened.push(target),
    render: (text) => text.message.replace('{0}', String(text.args?.[0] ?? '')),
    openExternal: async (url) => void opens.push(url),
    serverWebUrls: () => mirror.webUrls,
    accountServers: () => mirror.webUrls?.map((webUrl) => ({ id: new URL(webUrl).host, kind: 'gitlab' as const, webUrl, record: { gitHosts: [new URL(webUrl).host] } })),
    showPipelinePopover: async (repoId, anchor) => void popovers.push({ repoId, anchor }),
    openJobLog: vi.fn(async () => undefined),
    writeClipboard: (text) => void copied.push(text),
    showClonePicker: vi.fn(async () => ({ kind: 'dismissed' as const })),
    startClone: (clone) => void clones.push(clone),
    dialogs: { ask: vi.fn(async () => ({ kind: 'dismissed' as const })), publishState: vi.fn(), forkState: vi.fn(), protectedState: vi.fn() },
    notify: { info: vi.fn(), warn: vi.fn(async () => false), error: vi.fn() },
    log: (line) => logs.push(line),
  };
  return { host: new ForgeHost(deps), deps, client, scm, asker, opened, logs, opens, copied, clones, searches, popovers, ciEvents, forgeChanged, mirror, fire: (event: ScmEvent) => listeners.forEach((listener) => listener(event)) };
}

describe('forge host', () => {
  it('asks the local core with the repository\'s project, authority and endpoints before a push; a cancel stops it', async () => {
    const w = world();
    w.client.forgePrepareGitOperation.mockResolvedValueOnce({ proceed: false });
    expect(await w.host.prepareGitOperation('local-repo', 'push', ['upstream'])).toBe(false);
    expect(w.client.forgePrepareGitOperation).toHaveBeenCalledWith({ operation: 'push', projectKey: 'c:/src/damocles', authorityKey: 'local', project: 'damocles', remotes: ['upstream'], endpoints: ENDPOINTS });
  });

  it('runs the operation when the account cannot be resolved: the endpoints or core failed', async () => {
    const w = world({ endpoints: async () => Promise.reject(new Error('git config --get-urlmatch failed')) });
    expect(await w.host.prepareGitOperation('local-repo', 'push', ['origin'])).toBe(true);
    expect(w.logs.join('\n')).toContain('runs without asking');
    const v = world();
    v.client.forgePrepareGitOperation.mockRejectedValueOnce(new Error('core restarting'));
    expect(await v.host.prepareGitOperation('local-repo', 'fetch', [])).toBe(true);
    v.client.forgePrepareGitOperation.mockRejectedValueOnce(new Error('core restarting'));
    expect(await v.host.prepareClone('https://gitlab.com/grp/proj.git')).toEqual({ proceed: true });
  });

  it('opens Settings › Models & accounts › Git hosting at the server with sign-in open for "Sign in with another account"', async () => {
    const w = world();
    w.client.forgePrepareGitOperation.mockResolvedValueOnce({ proceed: false, signInServerId: 'gitlab.com' });
    expect(await w.host.prepareGitOperation('local-repo', 'pull', ['upstream'])).toBe(false);
    expect(w.opened).toEqual([{ serverId: 'gitlab.com', signIn: true }]);
  });

  it('reads an older daemon\'s endpoints from remotes, aliases as written', async () => {
    const w = world({ features: ['askpass.credential'] });
    await w.host.repoAccounts({ repoId: 'remote-repo' });
    expect(w.scm.remoteEndpoints).not.toHaveBeenCalled();
    expect(w.client.forgeRepoAccounts).toHaveBeenCalledWith(expect.objectContaining({
      projectKey: 'ssh+prod-1|/home/alexios/api',
      authorityKey: 'ssh+prod-1',
      endpoints: [{ remote: 'origin', fetch: { protocol: 'ssh', host: 'gl-work', path: 'grp/proj.git', aliasResolved: false } }],
    }));
    const current = world({ features: ['scm.remoteEndpoints'] });
    await current.host.repoAccounts({ repoId: 'remote-repo' });
    expect(current.scm.remoteEndpoints).toHaveBeenCalledWith('remote-repo');
  });

  it('keeps the endpoints until the repository\'s config changes, and passes the upstream remote as the push remote', async () => {
    vi.useFakeTimers();
    try {
      const w = world();
      await w.host.repoAccounts({ repoId: 'local-repo' });
      await w.host.repoAccounts({ repoId: 'local-repo', recheck: true });
      expect(w.scm.remoteEndpoints).toHaveBeenCalledTimes(1);
      expect(w.client.forgeRepoAccounts).toHaveBeenLastCalledWith(expect.objectContaining({ pushRemote: 'upstream', recheck: true }));
      w.fire({ kind: 'artifacts', repoId: 'local-repo', groups: ['branches'] });
      await vi.advanceTimersByTimeAsync(1_000);
      expect(w.scm.remoteEndpoints).toHaveBeenCalledTimes(1);
      const changed: unknown[] = [];
      w.host.onChanged((change) => changed.push(change));
      w.scm.remoteEndpoints.mockResolvedValueOnce([{ remote: 'origin', fetch: { protocol: 'https', host: 'gitlab.com', path: 'grp/proj.git', aliasResolved: false } }]);
      w.fire({ kind: 'artifacts', repoId: 'local-repo', groups: ['branches'], config: true });
      w.fire({ kind: 'artifacts', repoId: 'local-repo', groups: ['branches'], config: true });
      await vi.advanceTimersByTimeAsync(1_000);
      expect(w.scm.remoteEndpoints).toHaveBeenCalledTimes(2);
      expect(changed).toEqual([{ projectKeys: ['c:/src/damocles'] }]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('adds the host badge to the Choose account dialog for a remote project only', async () => {
    const w = world();
    const request = { requestId: 'r1', project: 'api', serverId: 'gitlab.com', server: 'gitlab.com', kind: 'gitlab', repoPath: 'grp/proj', operation: 'push', accounts: [], checking: false } as const;
    await w.host.chooseAccount({ ...request, projectKey: 'ssh+prod-1|/home/alexios/api' } as ChooseAccountRequest, new AbortController().signal);
    await w.host.chooseAccount({ ...request, projectKey: 'c:/src/damocles' } as ChooseAccountRequest, new AbortController().signal);
    expect(w.asker.chooseForgeAccount.mock.calls.map(([dialog]) => dialog.where)).toEqual([{ hostName: 'prod-1', color: 'danger' }, undefined]);
  });

  it('answers a shell read whose repository closed while its remotes were read as one it no longer has, and rejects any other failure', async () => {
    // a chat worktree's root leaving source control disposes its git queue under the read
    const closing = (): ReturnType<typeof world> => {
      const w: ReturnType<typeof world> = world({
        endpoints: async () => {
          w.scm.repository = () => undefined;
          throw Object.assign(new Error('The repository was closed'), { name: 'GitQueueDisposedError' });
        },
      });
      return w;
    };
    expect(await closing().host.repoAccounts({ repoId: 'local-repo' })).toBeNull();
    expect(await closing().host.historyContextFromShell({ repoId: 'local-repo' })).toBeNull();
    expect(await closing().host.ciStatusFromShell({ repoId: 'local-repo' })).toBeNull();
    const watched = closing();
    await expect(watched.host.ciWatchFromShell({ repoId: 'local-repo', visible: true })).resolves.toBeUndefined();
    expect(watched.client.forgeCiWatch).not.toHaveBeenCalled();
    const open = world({ endpoints: async () => Promise.reject(new Error('git config --get-urlmatch failed')) });
    await expect(open.host.repoAccounts({ repoId: 'local-repo' })).rejects.toThrow('git config --get-urlmatch failed');
    await expect(open.host.historyContextFromShell({ repoId: 'local-repo' })).rejects.toThrow('git config --get-urlmatch failed');
  });

  it('refuses host defaults for an authority no saved host has, and malformed shell calls', async () => {
    const w = world();
    await expect(w.host.hostDefaults('ssh+unknown')).rejects.toThrow('saved remote hosts');
    expect(await w.host.hostDefaults('ssh+prod-1')).toEqual({ state: 'ready', servers: [] });
    await expect(w.host.repoAccounts({ repoId: 'local-repo', extra: 1 })).rejects.toThrow('Malformed');
    await expect(w.host.chooseAccountFromShell({ repoId: 'local-repo', serverId: 'gitlab.com', accountId: 7 })).rejects.toThrow('Malformed');
    expect(await w.host.repoAccounts({ repoId: 'gone' })).toBeNull();
  });
});

describe('forge host CI', () => {
  it('watches a repository with its upstream branch and HEAD, shown only while Source Control shows it and the window is focused', async () => {
    const w = world();
    const changes: CiChanged[] = [];
    w.host.onCiChanged((changed) => changes.push(changed));
    expect(await w.host.ciStatusFromShell({ repoId: 'local-repo' })).toEqual({ status: 'error', message: 'Could not reach gitlab.com. Check the connection and try again.' });
    expect(w.client.forgeCiWatch).toHaveBeenLastCalledWith({
      id: 'status:local-repo',
      repo: { projectKey: 'c:/src/damocles', authorityKey: 'local', project: 'damocles', pushRemote: 'upstream', endpoints: ENDPOINTS, branch: 'main', sha: HEAD },
      active: false,
    });
    // the window is taken as unfocused until main says otherwise
    await w.host.ciWatchFromShell({ repoId: 'local-repo', visible: true });
    expect(w.client.forgeCiWatch).toHaveBeenLastCalledWith(expect.objectContaining({ id: 'status:local-repo', active: false }));
    w.host.setWindowFocused(true);
    expect(w.client.forgeCiWatch).toHaveBeenLastCalledWith({ id: 'status:local-repo', active: true });
    w.host.setWindowFocused(false);
    expect(w.client.forgeCiWatch).toHaveBeenLastCalledWith({ id: 'status:local-repo', active: false });
    w.host.setWindowFocused(true);
    expect(w.client.forgeCiWatch).toHaveBeenLastCalledWith({ id: 'status:local-repo', active: true });
    await w.host.ciWatchFromShell({ repoId: 'local-repo', visible: false });
    expect(w.client.forgeCiWatch).toHaveBeenLastCalledWith(expect.objectContaining({ id: 'status:local-repo', active: false }));
    expect(changes[0]).toEqual({ repoId: 'local-repo', status: { status: 'error', message: 'Could not reach gitlab.com. Check the connection and try again.' } });
  });

  it('defines a watch once when the first status read and the shown state come together, then only shows or hides it', async () => {
    const w = world();
    let answer = (_status: CiStatus | null): void => undefined;
    w.client.forgeCiWatch.mockImplementationOnce(() => new Promise((resolve) => (answer = resolve)));
    w.host.setWindowFocused(true);
    const status = w.host.ciStatusFromShell({ repoId: 'local-repo' });
    const shown = w.host.ciWatchFromShell({ repoId: 'local-repo', visible: true });
    await vi.waitFor(() => expect(w.client.forgeCiWatch).toHaveBeenCalledTimes(1));
    answer({ status: 'none' });
    await Promise.all([status, shown]);
    const params = (): unknown[] => w.client.forgeCiWatch.mock.calls.map((call) => (call as unknown[])[0]);
    expect(params()).toEqual([{ id: 'status:local-repo', repo: expect.objectContaining({ branch: 'main', sha: HEAD }), active: true }]);
    await w.host.ciWatchFromShell({ repoId: 'local-repo', visible: false });
    await w.host.ciWatchFromShell({ repoId: 'local-repo', visible: false });
    expect(params().slice(1)).toEqual([{ id: 'status:local-repo', active: false }]);
  });

  it('opens a commit\'s checks and acts on a workflow run, and refuses an action on a commit', async () => {
    const w = world();
    expect(await w.host.openOnServerFromShell({ repoId: 'local-repo', target: { sha: HEAD } })).toBe('gitlab.com');
    expect(w.client.forgeCiWebUrl).toHaveBeenLastCalledWith(expect.objectContaining({ target: { sha: HEAD } }));
    expect(await w.host.jobActionFromShell({ repoId: 'local-repo', target: { runId: 64312 }, action: 'retry' })).toBe(true);
    expect(w.client.forgeCiJobAction).toHaveBeenLastCalledWith(expect.objectContaining({ target: { runId: 64312 }, action: 'retry' }));
    w.client.forgeCiJobAction.mockClear();
    expect(await w.host.jobActionFromShell({ repoId: 'local-repo', target: { sha: HEAD }, action: 'retry' })).toBe(false);
    expect(w.client.forgeCiJobAction).not.toHaveBeenCalled();
    await expect(w.host.openOnServerFromShell({ repoId: 'local-repo', target: { sha: 'HEAD' } })).rejects.toThrow('Malformed');
  });

  it('passes core\'s pushes on to the shell and the palette', async () => {
    const w = world();
    w.host.attach(w.client as unknown as CoreClient);
    await w.host.ciStatus('local-repo');
    const changes: CiChanged[] = [];
    w.host.onCiChanged((changed) => changes.push(changed));
    const pipeline = { serverId: 'gitlab.com', serverName: 'gitlab.com', kind: 'gitlab', id: 4312, number: 4312, state: 'running', jobsDone: 3, jobsTotal: 5, failedCount: 0, canRetry: false, canCancel: true, jobs: [{ id: 9101, name: 'unit', stage: 'test', state: 'running', kind: 'job', canRetry: false, canCancel: true, hasLog: true }] } as const;
    w.ciEvents.forEach((listener) => listener({ id: 'status:local-repo', status: { status: 'ready', pipeline } }));
    expect(changes).toEqual([{ repoId: 'local-repo', status: { status: 'ready', pipeline } }]);
    expect(w.host.pipelineShown('local-repo')).toBe(true);
    expect(w.host.ciJob('local-repo', 9101)).toEqual({ name: 'unit', pipelineNumber: 4312, state: 'running' });
    // a GitHub commit's checks have no number: the job is named by its workflow
    const checks = { ...pipeline, kind: 'github', id: 0, number: 0, jobs: [{ ...pipeline.jobs[0], stage: 'CI' }] } as const;
    w.ciEvents.forEach((listener) => listener({ id: 'status:local-repo', status: { status: 'ready', pipeline: checks } }));
    expect(w.host.ciJob('local-repo', 9101)).toEqual({ name: 'unit', workflow: 'CI', state: 'running' });
  });

  it('defines every watch again on the core that attaches after a restart', async () => {
    const w = world();
    const first = w.host.attach(w.client as unknown as CoreClient);
    await w.host.ciWatchFromShell({ repoId: 'local-repo', visible: true });
    first.dispose();
    w.client.forgeCiWatch.mockClear();
    w.host.attach(w.client as unknown as CoreClient);
    await vi.waitFor(() => expect(w.client.forgeCiWatch).toHaveBeenCalledWith(expect.objectContaining({ id: 'status:local-repo', repo: expect.objectContaining({ projectKey: 'c:/src/damocles', endpoints: ENDPOINTS }) })));
  });

  it('opens a CI page only on its server\'s web origin, as https', async () => {
    const w = world();
    expect(await w.host.openOnServerFromShell({ repoId: 'local-repo', target: { pipelineId: 4312 } })).toBe('gitlab.com');
    expect(w.opens).toEqual(['https://gitlab.com/grp/proj/-/pipelines/4312']);
    w.client.forgeCiWebUrl.mockResolvedValueOnce({ url: 'https://evil.test/grp/proj/-/pipelines/4312', serverName: 'gitlab.com' });
    expect(await w.host.openOnServer('local-repo', { pipelineId: 4312 })).toBeNull();
    w.client.forgeCiWebUrl.mockResolvedValueOnce({ url: 'http://gitlab.com/grp/proj/-/pipelines/4312', serverName: 'gitlab.com' });
    expect(await w.host.openOnServer('local-repo', { pipelineId: 4312 })).toBeNull();
    expect(w.opens).toHaveLength(1);
    await expect(w.host.openOnServerFromShell({ repoId: 'local-repo', target: { url: 'https://gitlab.com' } })).rejects.toThrow('Malformed');
  });

  it('tells the job log tab of a retried job about its new id', async () => {
    const w = world();
    const moves: [string, number, number][] = [];
    w.host.onJobRetargeted((repoId, jobId, newJobId) => moves.push([repoId, jobId, newJobId]));
    expect(await w.host.jobActionFromShell({ repoId: 'local-repo', target: { jobId: 9102 }, action: 'retry' })).toBe(true);
    expect(moves).toEqual([['local-repo', 9102, 9103]]);
    await expect(w.host.jobActionFromShell({ repoId: 'local-repo', target: { jobId: 9102 }, action: 'play' })).rejects.toThrow('Malformed');
  });

  it('checks a commit status call\'s sha and opens the job list for a known repository only', async () => {
    const w = world();
    expect(await w.host.commitStatusFromShell({ repoId: 'local-repo', sha: HEAD })).toEqual({ status: 'none' });
    expect(w.client.forgeCiCommitStatus).toHaveBeenCalledWith(expect.objectContaining({ sha: HEAD, retry: false }));
    await expect(w.host.commitStatusFromShell({ repoId: 'local-repo', sha: 'HEAD' })).rejects.toThrow('Malformed');
    await w.host.showPipelineFromShell({ repoId: 'local-repo', anchor: { x: 1, y: 2, width: 3, height: 4 } });
    await w.host.showPipelineFromShell({ repoId: 'gone', anchor: { x: 1, y: 2, width: 3, height: 4 } });
    expect(w.popovers).toEqual([{ repoId: 'local-repo', anchor: { x: 1, y: 2, width: 3, height: 4 } }]);
  });
});

describe('links', () => {
  const SHA = 'b'.repeat(40);

  it('copies a permalink at HEAD to the clipboard in main and answers no address', async () => {
    const w = world();
    const result = await w.host.link({ action: 'copyPermalink', repoId: 'local-repo', path: 'src/a.ts', startLine: 3, endLine: 7 });
    expect(result).toEqual({ kind: 'copied', serverName: 'gitlab.com', label: 'src/a.ts', dirty: false });
    expect(JSON.stringify(result)).not.toContain('https:');
    expect(w.copied).toEqual([`https://gitlab.com/grp/proj/-/blob/${HEAD}`]);
    expect(w.client.forgeLink).toHaveBeenCalledWith(expect.objectContaining({ target: { kind: 'file', sha: HEAD, path: 'src/a.ts', range: { start: 3, end: 7 } } }));
    expect(w.scm.commitOnRemote).toHaveBeenCalledWith('local-repo', HEAD, 'src/a.ts', 'origin');
  });

  it('checks only the branches of the remote the link names', async () => {
    const w = world();
    w.client.forgeLink.mockResolvedValueOnce({ url: `https://gitlab.com/me/proj/-/commit/${SHA}`, serverName: 'gitlab.com', remote: 'fork' });
    await w.host.link({ action: 'openCommit', repoId: 'local-repo', sha: SHA });
    expect(w.scm.commitOnRemote).toHaveBeenCalledWith('local-repo', SHA, undefined, 'fork');
  });

  it('warns that the lines may not match when the editor holds unsaved edits', async () => {
    const w = world();
    expect(await w.host.link({ action: 'copyPermalink', repoId: 'local-repo', path: 'src/a.ts', startLine: 3, endLine: 3, modified: true })).toMatchObject({ kind: 'copied', dirty: true });
    expect(await w.host.link({ action: 'copyPermalink', repoId: 'local-repo', path: 'src/a.ts', startLine: 3, endLine: 3 })).toMatchObject({ kind: 'copied', dirty: false });
  });

  it('reads HEAD on the repository\'s core at request time, not from the status mirror', async () => {
    const w = world();
    const moved = 'c'.repeat(40);
    w.scm.resolveTypedCommit.mockResolvedValueOnce(moved);
    expect(await w.host.link({ action: 'openCommit', repoId: 'local-repo' })).toMatchObject({ kind: 'opened', label: moved.slice(0, 7) });
    expect(w.scm.resolveTypedCommit).toHaveBeenCalledWith('local-repo', 'HEAD');
    expect(w.scm.commitOnRemote).toHaveBeenCalledWith('local-repo', moved, undefined, 'origin');
  });

  it('warns of an unpushed commit and opens nothing; a dirty file still opens with the flag', async () => {
    const w = world();
    w.scm.commitOnRemote.mockResolvedValueOnce({ onRemote: false, ahead: true, dirty: false });
    expect(await w.host.link({ action: 'openCommit', repoId: 'local-repo' })).toEqual({ kind: 'unpushed', serverName: 'gitlab.com', label: HEAD.slice(0, 7), canPush: true });
    expect(w.opens).toEqual([]);
    w.scm.commitOnRemote.mockResolvedValueOnce({ onRemote: true, ahead: false, dirty: true });
    expect(await w.host.link({ action: 'openFile', repoId: 'local-repo', path: 'src/a.ts' })).toMatchObject({ kind: 'opened', dirty: true });
    expect(w.opens).toEqual([`https://gitlab.com/grp/proj/-/blob/${HEAD}`]);
  });

  it('asks a remote project\'s own core, and skips the check on a daemon without scm.commitOnRemote', async () => {
    const current = world({ features: ['scm.remoteEndpoints', 'scm.commitOnRemote'] });
    await current.host.link({ action: 'openCommit', repoId: 'remote-repo', sha: SHA });
    expect(current.scm.commitOnRemote).toHaveBeenCalledWith('remote-repo', SHA, undefined, 'origin');
    const older = world({ features: ['scm.remoteEndpoints'] });
    expect(await older.host.link({ action: 'openCommit', repoId: 'remote-repo', sha: SHA })).toMatchObject({ kind: 'opened' });
    expect(older.scm.commitOnRemote).not.toHaveBeenCalled();
    expect(older.opens).toEqual([`https://gitlab.com/grp/proj/-/commit/${SHA}`]);
  });

  it('opens nothing off a managed server\'s web origin, and says why core built nothing', async () => {
    const w = world();
    w.client.forgeLink.mockResolvedValueOnce({ url: `https://evil.example/grp/proj/-/commit/${SHA}`, serverName: 'gitlab.com', remote: 'origin' });
    expect(await w.host.link({ action: 'openCommit', repoId: 'local-repo', sha: SHA })).toMatchObject({ kind: 'unavailable' });
    w.client.forgeLink.mockResolvedValueOnce({ unavailable: { message: '{0} has no remote on a GitHub or GitLab server you are signed in to.' } });
    expect(await w.host.link({ action: 'openCommit', repoId: 'local-repo', sha: SHA })).toMatchObject({ kind: 'unavailable' });
    expect(await w.host.link({ action: 'openCommit', repoId: 'remote-repo' })).toMatchObject({ kind: 'unavailable', reason: 'This repository has no commit to link to yet.' });
    expect(w.opens).toEqual([]);
  });

  it('parses a renderer\'s request field by field', () => {
    expect(parseForgeLinkRequest({ action: 'copyPermalink', repoId: 'r', path: 'src/a b.ts', startLine: 3, endLine: 7 })).toEqual({ action: 'copyPermalink', repoId: 'r', path: 'src/a b.ts', startLine: 3, endLine: 7 });
    expect(parseForgeLinkRequest({ action: 'openCommit', repoId: 'r', sha: SHA })).toEqual({ action: 'openCommit', repoId: 'r', sha: SHA });
    expect(parseForgeLinkRequest({ action: 'openFile', repoId: 'r', path: 'a.ts', modified: true })).toEqual({ action: 'openFile', repoId: 'r', path: 'a.ts', modified: true });
    expect(parseForgeLinkRequest({ action: 'openFile', repoId: 'r', path: 'a.ts', modified: false })).toEqual({ action: 'openFile', repoId: 'r', path: 'a.ts' });
    for (const raw of [
      { action: 'openFile', repoId: 'r', path: 'a.ts', modified: 'yes' },
      { action: 'openCommit', repoId: 'r', modified: true },
      { action: 'openReference', repoId: 'r', reference: { sigil: '#', number: 1 }, modified: true },
      { action: 'openCommit', repoId: 'r', sha: 'HEAD' },
      { action: 'openCommit', repoId: 'r', sha: '--all' },
      { action: 'openCommit', repoId: 'r', path: 'a.ts' },
      { action: 'openFile', repoId: 'r' },
      { action: 'openFile', repoId: 'r', path: '../etc/passwd' },
      { action: 'openFile', repoId: 'r', path: 'a.ts', startLine: 7, endLine: 3 },
      { action: 'openFile', repoId: 'r', path: 'a.ts', endLine: 3 },
      { action: 'openFile', repoId: 'r', path: 'a.ts', startLine: 0 },
      { action: 'openFile', repoId: 'r', path: 'a.ts', url: 'https://evil.example' },
      { action: 'openUrl', repoId: 'r' },
    ]) expect(() => parseForgeLinkRequest(raw)).toThrow();
  });
});

describe('history details', () => {
  const SHA = 'b'.repeat(40);
  const alexios = { sha: SHA, email: 'a.stefanopoulos@indigital.gr', name: 'Alexios Stefanopoulos' };

  it('asks this computer\'s core with the repository main resolved, and answers nothing for a closed repository', async () => {
    const w = world();
    expect(await w.host.historyContextFromShell({ repoId: 'local-repo' })).toEqual({ kind: 'gitlab', serverName: 'gitlab.com', showAvatars: true });
    expect(w.client.forgeHistoryContext).toHaveBeenCalledWith({ repo: expect.objectContaining({ projectKey: 'c:/src/damocles', authorityKey: 'local', endpoints: ENDPOINTS }) });
    expect(await w.host.authorAvatarsFromShell({ repoId: 'local-repo', authors: [alexios] })).toEqual({ 'a.stefanopoulos@indigital.gr': 'f'.repeat(64) });
    expect(w.client.forgeHistoryAvatars).toHaveBeenCalledWith({ repo: expect.objectContaining({ projectKey: 'c:/src/damocles' }), authors: [alexios] });
    expect(await w.host.containingChangeFromShell({ repoId: 'local-repo', sha: SHA })).toEqual({ kind: 'mergeRequest', number: 45, serverName: 'gitlab.com' });
    expect(await w.host.historyContextFromShell({ repoId: 'gone' })).toBeNull();
    expect(await w.host.authorAvatarsFromShell({ repoId: 'gone', authors: [alexios] })).toEqual({});
    expect(await w.host.containingChangeFromShell({ repoId: 'gone', sha: SHA })).toBeNull();
    // an empty page asks nothing
    expect(await w.host.authorAvatarsFromShell({ repoId: 'local-repo', authors: [] })).toEqual({});
    expect(w.client.forgeHistoryAvatars).toHaveBeenCalledTimes(1);
  });

  it('asks for a chat worktree\'s repository as its project\'s, whose root key names both', async () => {
    const w = world();
    const worktree = { ...LOCAL_REPO, projectKey: `c:/src/damocles${String.fromCharCode(0)}ab12cd34` } as ScmRepositoryRef;
    const listed = w.scm.repository;
    w.scm.repository = (repoId: string) => (repoId === 'worktree-repo' ? worktree : listed(repoId));
    const named: string[] = [];
    const host = new ForgeHost({ ...w.deps, scm: w.scm as unknown as ForgeHostDeps['scm'], projectName: (projectKey) => (named.push(projectKey), 'damocles') });
    await host.historyContextFromShell({ repoId: 'worktree-repo' });
    await host.repoAccounts({ repoId: 'worktree-repo' });
    expect(w.client.forgeHistoryContext).toHaveBeenCalledWith({ repo: expect.objectContaining({ projectKey: 'c:/src/damocles' }) });
    expect(w.client.forgeRepoAccounts).toHaveBeenCalledWith(expect.objectContaining({ projectKey: 'c:/src/damocles' }));
    expect(named).toEqual(['c:/src/damocles', 'c:/src/damocles']);
  });

  it('refuses malformed history calls field by field', async () => {
    const w = world();
    await expect(w.host.containingChangeFromShell({ repoId: 'local-repo', sha: 'HEAD' })).rejects.toThrow('Malformed');
    await expect(w.host.historyContextFromShell({ repoId: 'local-repo', url: 'https://evil.example' })).rejects.toThrow('Malformed');
    await expect(w.host.authorAvatarsFromShell({ repoId: 'local-repo', authors: Array.from({ length: 101 }, () => alexios) })).rejects.toThrow('Malformed');
    for (const author of [
      { ...alexios, sha: 'HEAD' },
      { ...alexios, email: 'x'.repeat(321) },
      { ...alexios, name: `a${String.fromCharCode(0)}b` },
      { ...alexios, avatarUrl: 'https://evil.example/a.png' },
      { sha: SHA, email: 'a@b' },
    ]) expect(() => parseHistoryAuthors([author])).toThrow();
    expect(parseHistoryAuthors([alexios])).toEqual([alexios]);
    expect(w.client.forgeHistoryAvatars).not.toHaveBeenCalled();
  });

  it('opens a reference core built on the repository\'s server as a user\'s click, labelled as it reads', async () => {
    const w = world();
    expect(await w.host.link(parseForgeLinkRequest({ action: 'openReference', repoId: 'local-repo', reference: { sigil: '!', number: 45 } }))).toEqual({ kind: 'opened', serverName: 'gitlab.com', label: '!45', dirty: false });
    expect(w.client.forgeLink).toHaveBeenCalledWith({ repo: expect.objectContaining({ projectKey: 'c:/src/damocles' }), target: { kind: 'reference', reference: { sigil: '!', number: 45 } } });
    expect(w.opens).toEqual(['https://gitlab.com/grp/proj/-/merge_requests/45']);
    // no HEAD read and no published check for a reference
    expect(w.scm.resolveTypedCommit).not.toHaveBeenCalled();
    expect(w.scm.commitOnRemote).not.toHaveBeenCalled();
    w.client.forgeLink.mockResolvedValueOnce({ url: 'https://evil.example/owner/repo/-/issues/12', serverName: 'gitlab.com', remote: 'origin' });
    expect(await w.host.link({ action: 'openReference', repoId: 'local-repo', reference: { sigil: '#', number: 12, path: 'owner/repo' } })).toMatchObject({ kind: 'unavailable' });
    expect(w.opens).toHaveLength(1);
  });

  it('parses a reference strictly: sigil, number in range, a path the scanner reads, nothing else', () => {
    expect(parseForgeLinkRequest({ action: 'openReference', repoId: 'r', reference: { sigil: '#', number: 12, path: 'owner/repo' } })).toEqual({ action: 'openReference', repoId: 'r', reference: { sigil: '#', number: 12, path: 'owner/repo' } });
    for (const reference of [
      undefined,
      { sigil: '@', number: 1 },
      { sigil: '#', number: 0 },
      { sigil: '#', number: 2_147_483_648 },
      { sigil: '#', number: 1.5 },
      { sigil: '#', number: '12' },
      { sigil: '#', number: 12, path: 'repo' },
      { sigil: '#', number: 12, path: '../etc' },
      { sigil: '#', number: 12, path: 'owner/re po' },
      { sigil: '#', number: 12, path: 'https://evil.example/x' },
      { sigil: '#', number: 12, url: 'https://evil.example' },
    ]) expect(() => parseForgeLinkRequest({ action: 'openReference', repoId: 'r', reference })).toThrow();
    expect(() => parseForgeLinkRequest({ action: 'openReference', repoId: 'r', sha: SHA, reference: { sigil: '#', number: 1 } })).toThrow();
    expect(() => parseForgeLinkRequest({ action: 'openCommit', repoId: 'r', reference: { sigil: '#', number: 1 } })).toThrow();
  });
});

describe('clone picker', () => {
  it('starts the clone with core\'s checked URL and the picker\'s recursive flag, and refuses with core\'s reason', async () => {
    const w = world();
    vi.mocked(w.deps.showClonePicker).mockReturnValueOnce(new Promise(() => undefined));
    void w.host.showClonePicker(true);
    const request = vi.mocked(w.deps.showClonePicker).mock.calls[0]![0];
    expect(await w.host.cloneStart(request, { accountId: 'gitlab.com|7', key: 'k1' })).toEqual({ kind: 'started' });
    expect(w.clones).toEqual([{ url: 'https://gitlab.com/grp/proj.git', recursive: true, status: 'Cloning grp/proj.', account: { serverId: 'gitlab.com', accountId: 'gitlab.com|7' } }]);
    w.client.forgeCloneTarget.mockResolvedValueOnce({ ok: false, reason: { message: 'This repository is no longer listed. Search again.' } });
    expect(await w.host.cloneStart(request, { accountId: 'gitlab.com|7', key: 'gone' })).toEqual({ kind: 'refused', reason: 'This repository is no longer listed. Search again.' });
    expect(w.clones).toHaveLength(1);
  });

  it('starts nothing when the picker closed while core looked the address up', async () => {
    const w = world();
    let close: (answer: { kind: 'dismissed' }) => void = () => undefined;
    vi.mocked(w.deps.showClonePicker).mockReturnValueOnce(new Promise((resolve) => (close = resolve)));
    const picker = w.host.showClonePicker(false);
    const request = vi.mocked(w.deps.showClonePicker).mock.calls[0]![0];
    let answer: (target: unknown) => void = () => undefined;
    w.client.forgeCloneTarget.mockReturnValueOnce(new Promise((resolve) => (answer = resolve)));
    const start = w.host.cloneStart(request, { pasteText: 'https://gitlab.com/grp/proj.git' });
    close({ kind: 'dismissed' });
    await picker;
    answer({ ok: true, url: 'https://gitlab.com/grp/proj.git', status: { message: 'Cloning {0}.', args: ['grp/proj'] } });
    expect(await start).toEqual({ kind: 'cancelled' });
    expect(w.clones).toEqual([]);
  });

  it('aborts a section\'s older search when a newer one starts, and every search when the picker closes', async () => {
    const w = world();
    let close: (answer: { kind: 'dismissed' }) => void = () => undefined;
    vi.mocked(w.deps.showClonePicker).mockReturnValueOnce(new Promise((resolve) => (close = resolve)));
    const picker = w.host.showClonePicker(false);
    const request = vi.mocked(w.deps.showClonePicker).mock.calls[0]![0];
    expect(request).toEqual({ kind: 'cloneFromAccount', recursive: false });
    const first = w.host.cloneSearch(request, 'a|1', 'da', 1);
    const second = w.host.cloneSearch(request, 'a|1', 'dam', 2);
    const other = w.host.cloneSearch(request, 'b|2', 'dam', 3);
    await vi.waitFor(() => expect(w.searches).toHaveLength(3));
    await expect(first).rejects.toThrow('aborted');
    w.searches[1]!.resolve();
    expect(await second).toEqual({ requestId: 2, accountId: 'a|1', rows: [] });
    close({ kind: 'dismissed' });
    await picker;
    await expect(other).rejects.toThrow('aborted');
    await expect(w.host.cloneSearch(request, 'a|1', 'dam', 4)).rejects.toThrow('closed');
  });

  it('ends only the searches of the picker that closed, not those of the picker that replaced it', async () => {
    const w = world();
    const closers: ((answer: { kind: 'dismissed' }) => void)[] = [];
    vi.mocked(w.deps.showClonePicker).mockImplementation(() => new Promise((resolve) => closers.push(resolve)));
    const firstPicker = w.host.showClonePicker(false);
    const secondPicker = w.host.showClonePicker(true);
    const [oldRequest, newRequest] = vi.mocked(w.deps.showClonePicker).mock.calls.map(([request]) => request);
    const oldSearch = w.host.cloneSearch(oldRequest!, 'a|1', 'da', 1);
    const newSearch = w.host.cloneSearch(newRequest!, 'a|1', 'da', 1);
    await vi.waitFor(() => expect(w.searches).toHaveLength(2));
    closers[0]!({ kind: 'dismissed' });
    await firstPicker;
    await expect(oldSearch).rejects.toThrow('aborted');
    expect(w.searches[1]!.signal.aborted).toBe(false);
    w.searches[1]!.resolve();
    expect(await newSearch).toEqual({ requestId: 1, accountId: 'a|1', rows: [] });
    closers[1]!({ kind: 'dismissed' });
    await secondPicker;
  });

  it('opens the picker for Git: Clone by core\'s own read while core has not published the forge mirror', async () => {
    const w = world();
    w.mirror.webUrls = undefined;
    expect(await w.host.hasAccount()).toBe(true);
    expect(w.client.forgeServersRead).toHaveBeenCalledTimes(1);
    w.client.forgeServersRead.mockResolvedValueOnce({ servers: [{ id: 'gitlab.com', webUrl: 'https://gitlab.com', gitHosts: ['gitlab.com'], hasAccount: false }] });
    expect(await w.host.hasAccount()).toBe(false);
    w.mirror.webUrls = [];
    expect(await w.host.hasAccount()).toBe(false);
    expect(w.client.forgeServersRead).toHaveBeenCalledTimes(2);
  });

  it('reads the rules of a repository that opened before the forge mirror once the mirror arrives', async () => {
    const w = world();
    w.host.attach(w.client as unknown as CoreClient);
    w.mirror.webUrls = undefined;
    w.fire({ kind: 'repository', repoId: 'local-repo' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(w.client.forgeBranchProtection).not.toHaveBeenCalled();
    w.mirror.webUrls = ['https://gitlab.com'];
    w.forgeChanged.forEach((listener) => listener());
    await vi.waitFor(() => expect(w.client.forgeBranchProtection).toHaveBeenCalledTimes(1));
    // warmed once with an account, so the next status of the repository asks nothing more
    w.fire({ kind: 'repository', repoId: 'local-repo' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(w.client.forgeBranchProtection).toHaveBeenCalledTimes(1);
  });

  it('hands a commit the rules core holds for the repository, read with its endpoints, and asks again when it opens', async () => {
    const w = world();
    expect(await w.host.protectedBranches('local-repo')).toEqual(PROTECTED_MAIN);
    expect(w.client.forgeBranchProtection).toHaveBeenCalledWith({ repo: expect.objectContaining({ projectKey: 'c:/src/damocles', authorityKey: 'local', endpoints: ENDPOINTS }) });
    w.client.forgeBranchProtection.mockClear();
    // a repository that opens is read once, so core holds its rules before the first commit
    w.fire({ kind: 'repository', repoId: 'local-repo' });
    w.fire({ kind: 'repository', repoId: 'local-repo' });
    await vi.waitFor(() => expect(w.client.forgeBranchProtection).toHaveBeenCalledTimes(1));
  });

  it('never makes a commit wait or fail on the rules: a slow or failing core answers none', async () => {
    vi.useFakeTimers();
    try {
      const w = world();
      w.client.forgeBranchProtection.mockReturnValueOnce(new Promise(() => undefined));
      const slow = w.host.protectedBranches('local-repo');
      await vi.advanceTimersByTimeAsync(2_000);
      expect(await slow).toEqual([]);
      expect(w.logs.join('\n')).toContain('goes on without it');
      w.client.forgeBranchProtection.mockRejectedValueOnce(new Error('core restarting'));
      expect(await w.host.protectedBranches('local-repo')).toEqual([]);
      expect(await w.host.protectedBranches('gone')).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('reads no rules for a remote project whose daemon drops them, nor without an account', async () => {
    const older = world({ features: ['scm.remoteEndpoints'] });
    expect(await older.host.protectedBranches('remote-repo')).toEqual([]);
    expect(older.client.forgeBranchProtection).not.toHaveBeenCalled();
    const current = world({ features: ['scm.remoteEndpoints', 'scm.commit.protectedBranches'] });
    expect(await current.host.protectedBranches('remote-repo')).toEqual(PROTECTED_MAIN);
    expect(current.client.forgeBranchProtection).toHaveBeenCalledWith({ repo: expect.objectContaining({ authorityKey: 'ssh+prod-1', projectKey: 'ssh+prod-1|/home/alexios/api' }) });
    const signedOut = world();
    expect(await new ForgeHost({ ...signedOut.deps, serverWebUrls: () => [] }).protectedBranches('local-repo')).toEqual([]);
    expect(signedOut.client.forgeBranchProtection).not.toHaveBeenCalled();
  });

  it('opens Settings › Models & accounts › Git hosting after the picker answered Open Git hosting settings', async () => {
    const w = world();
    vi.mocked(w.deps.showClonePicker).mockResolvedValueOnce({ kind: 'cloneFromAccount', openAccounts: true });
    await w.host.showClonePicker(false);
    expect(w.opened).toEqual([{}]);
  });
});
