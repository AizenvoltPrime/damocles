import { describe, expect, it, vi } from 'vitest';
import type { ScmEvent } from '../../../core/scm/scm-service';
import { createCoreEndpoint, createLoopback, createMainEndpoint, type CoreEndpoint } from '../../core-protocol';
import { CoreClient } from '../core-client';
import { createScmClient } from '../scm/scm-client';
import { authorityProjectKeys, LOCAL_PROJECT_KEYS } from '../remote/remote-project-keys';

const quiet = (): void => undefined;

function connected(): { core: CoreEndpoint; client: CoreClient } {
  const { main, core } = createLoopback();
  const client = new CoreClient(createMainEndpoint(main, quiet), (_view, attach) => attach(), LOCAL_PROJECT_KEYS);
  return { core: createCoreEndpoint(core, quiet), client };
}

const VIEW = { projectKey: 'p', state: 'ready', repos: [{ repoId: 'repo-1', root: '/p', kind: 'root' }], closedRoots: [], unsafe: [], parents: [] };
const SNAPSHOT = { repoId: 'repo-1', projectKey: 'p', status: undefined, busy: false, running: null, lastRemote: null, revision: 1 };
const REPOSITORY = { projectKey: 'p', projectPath: '/p', kind: 'root' as const, root: '/p', gitDir: '/p/.git', commonDir: '/p/.git', snapshot: SNAPSHOT };

describe('core\'s ScmService as main reads it', () => {
  it('answers ScmHost\'s synchronous reads from the mirror, which is current when the event arrives', () => {
    const scm = createScmClient({ core: (_authority, _label, work) => Promise.reject(new Error(`no core for ${String(work)}`)), gitVersion: { major: 2, minor: 45, patch: 0 }, log: quiet });
    const { core, client } = connected();
    scm.attach(client);
    const seen: Array<{ event: ScmEvent; view: unknown; repo: unknown }> = [];
    scm.onDidChange((event) => seen.push({ event, view: scm.view('p'), repo: scm.repository('repo-1')?.repo.root }));
    core.publish('scm', { kind: 'view', projectKey: 'p', view: VIEW, realPath: '/real/p' });
    core.publish('scm', { kind: 'repository', repoId: 'repo-1', repository: REPOSITORY });
    core.emit('scm.changed', { event: { kind: 'view', projectKey: 'p' } });
    core.publish('scm', { kind: 'decorations', projectKey: 'p', files: { 'a.ts': { tone: 'modified', staged: false, strike: false } } });
    expect(seen).toEqual([{ event: { kind: 'view', projectKey: 'p' }, view: VIEW, repo: '/p' }]);
    expect(scm.projectKeys()).toEqual(['p']);
    expect(scm.projectRealPath('p')).toBe('/real/p');
    expect(scm.snapshot('repo-1')).toEqual(SNAPSHOT);
    expect(scm.repository('repo-1')?.repo.info).toEqual({ gitDir: '/p/.git', commonDir: '/p/.git' });
    expect(scm.decorations('p')).toEqual({ 'a.ts': { tone: 'modified', staged: false, strike: false } });
    const handle = scm.repository('repo-1')?.repo;
    core.publish('scm', { kind: 'repository', repoId: 'repo-1', repository: { ...REPOSITORY, snapshot: { ...SNAPSHOT, revision: 2 } } });
    expect(scm.repository('repo-1')?.repo).toBe(handle);
    expect(scm.snapshot('repo-1')?.revision).toBe(2);
    // flags that change without a status landing replace only themselves
    core.publish('scm', { kind: 'repositoryState', repoId: 'repo-1', busy: true, running: 'push', lastRemote: { op: 'fetch', outcome: 'ok', stashKept: false, seq: 3 } });
    expect(scm.snapshot('repo-1')).toEqual({ ...SNAPSHOT, revision: 2, busy: true, running: 'push', lastRemote: { op: 'fetch', outcome: 'ok', stashKept: false, seq: 3 } });
    expect(scm.repository('repo-1')?.repo).toBe(handle);
  });

  it('sends the project list to each core that attaches, and forgets a detached core\'s mirror, telling ScmHost what closed', async () => {
    const scm = createScmClient({ core: () => Promise.reject(new Error('no core')), gitVersion: undefined, log: quiet });
    void scm.setProjects([{ key: 'p', path: '/p' }]);
    const first = connected();
    const setProjects = vi.fn();
    first.core.serve('scm.call', ({ method, args }) => {
      if (method === 'setProjects') setProjects(args[0]);
    });
    const attached = scm.attach(first.client);
    await vi.waitFor(() => expect(setProjects).toHaveBeenCalledWith([{ key: 'p', path: '/p' }]));
    first.core.publish('scm', { kind: 'view', projectKey: 'p', view: VIEW });
    first.core.publish('scm', { kind: 'repository', repoId: 'repo-1', repository: REPOSITORY });
    const events: ScmEvent[] = [];
    scm.onDidChange((event) => events.push(event));
    attached.dispose();
    expect(scm.view('p')).toBeUndefined();
    expect(scm.repository('repo-1')).toBeUndefined();
    expect(events).toEqual([{ kind: 'repository', repoId: 'repo-1' }, { kind: 'view', projectKey: 'p' }, { kind: 'clone' }]);
    const second = connected();
    const again = vi.fn();
    second.core.serve('scm.call', ({ method, args }) => {
      if (method === 'setProjects') again(args[0]);
    });
    scm.attach(second.client);
    await vi.waitFor(() => expect(again).toHaveBeenCalledWith([{ key: 'p', path: '/p' }]));
  });

  it('turns a commit\'s branch-name closure into core\'s scm.branchName, bytes into a Buffer and the ignored names into a Set', async () => {
    const { core, client } = connected();
    const scm = createScmClient({ core: (_authority, _label, work) => work(client), gitVersion: undefined, log: quiet });
    scm.attach(client);
    let asked: string | undefined;
    core.serve('scm.commit', async ({ branchName }) => {
      asked = await core.request('scm.branchName', { token: branchName! });
      return { ok: true } as const;
    });
    core.serve('scm.commitBlob', () => new Uint8Array([104, 105]));
    core.serve('scm.ignoredIn', () => ['dist', 'node_modules']);
    const outcome = await scm.commit('repo-1', 'msg', { scope: 'auto', amend: false, signoff: false, noVerify: false, empty: false }, { saved: [], branchName: async () => 'feature/x' });
    expect(outcome).toEqual({ ok: true });
    expect(asked).toBe('feature/x');
    const blob = await scm.commitBlob('repo-1', 'a'.repeat(40), 'a.ts');
    expect(Buffer.isBuffer(blob)).toBe(true);
    expect((blob as Buffer).toString('utf8')).toBe('hi');
    expect(await scm.ignoredIn('p', '', [{ name: 'dist', dir: true }])).toEqual(new Set(['dist', 'node_modules']));
  });
});

describe('scm calls across authorities', () => {
  const REMOTE_REPOSITORY = { ...REPOSITORY, projectKey: '/srv/app', projectPath: '/srv/app', root: '/srv/app', snapshot: { ...SNAPSHOT, repoId: 'repo-r', projectKey: '/srv/app' } };

  function remoteConnected(): { core: CoreEndpoint; client: CoreClient } {
    const { main, core } = createLoopback();
    const client = new CoreClient(createMainEndpoint(main, quiet), (_view, attach) => attach(), authorityProjectKeys('loopback', quiet));
    return { core: createCoreEndpoint(core, quiet), client };
  }

  function twoCores() {
    const local = connected();
    const remote = remoteConnected();
    const clients: Record<string, CoreClient> = { local: local.client, loopback: remote.client };
    const asked: string[] = [];
    const scm = createScmClient({
      core: (authority, _label, work) => {
        asked.push(authority);
        return work(clients[authority]!);
      },
      gitVersion: undefined,
      log: quiet,
    });
    const calls = { local: [] as Array<[string, readonly unknown[]]>, loopback: [] as Array<[string, readonly unknown[]]> };
    local.core.serve('scm.call', ({ method, args }) => void calls.local.push([method, args]));
    remote.core.serve('scm.call', ({ method, args }) => void calls.loopback.push([method, args]));
    return { scm, local, remote, calls, asked };
  }

  it('sends a repository\'s calls to the core that published it, and a project\'s to its authority with its key as that core knows it', async () => {
    const { scm, local, remote, calls } = twoCores();
    scm.attach(local.client);
    scm.attach(remote.client);
    local.core.publish('scm', { kind: 'repository', repoId: 'repo-1', repository: REPOSITORY });
    remote.core.publish('scm', { kind: 'repository', repoId: 'repo-r', repository: REMOTE_REPOSITORY });
    expect(scm.repository('repo-r')).toMatchObject({ projectKey: 'loopback|/srv/app', repo: { authority: 'loopback' } });
    await scm.stage('repo-r', ['a.ts']);
    await scm.stage('repo-1', ['b.ts']);
    await scm.init('loopback|/srv/app');
    expect(calls.loopback).toEqual([['stage', ['repo-r', ['a.ts']]], ['init', ['/srv/app']]]);
    expect(calls.local).toEqual([['stage', ['repo-1', ['b.ts']]]]);
  });

  it('splits the project list and the autofetch project by authority, each core getting only its own keys, as it knows them', async () => {
    const { scm, local, remote, calls } = twoCores();
    void scm.setProjects([{ key: 'p', path: '/p' }, { key: 'loopback|/srv/app', path: '/srv/app' }]);
    void scm.setAutofetchProject('loopback|/srv/app');
    scm.attach(local.client);
    scm.attach(remote.client);
    await vi.waitFor(() => expect(calls.loopback).toHaveLength(2));
    await vi.waitFor(() => expect(calls.local).toHaveLength(2));
    expect(calls.local).toEqual([['setProjects', [[{ key: 'p', path: '/p' }]]], ['setAutofetchProject', [undefined]]]);
    expect(calls.loopback).toEqual([['setProjects', [[{ key: '/srv/app', path: '/srv/app' }]]], ['setAutofetchProject', ['/srv/app']]]);
  });

  it('a detach forgets only its own authority\'s views and repositories', () => {
    const { scm, local, remote } = twoCores();
    scm.attach(local.client);
    const detach = scm.attach(remote.client);
    local.core.publish('scm', { kind: 'view', projectKey: 'p', view: VIEW });
    local.core.publish('scm', { kind: 'repository', repoId: 'repo-1', repository: REPOSITORY });
    remote.core.publish('scm', { kind: 'view', projectKey: '/srv/app', view: { ...VIEW, projectKey: '/srv/app' } });
    remote.core.publish('scm', { kind: 'repository', repoId: 'repo-r', repository: REMOTE_REPOSITORY });
    const events: ScmEvent[] = [];
    scm.onDidChange((event) => events.push(event));
    detach.dispose();
    expect(scm.projectKeys()).toEqual(['p']);
    expect(scm.repository('repo-1')).toBeDefined();
    expect(scm.repository('repo-r')).toBeUndefined();
    expect(events).toEqual([{ kind: 'repository', repoId: 'repo-r' }, { kind: 'view', projectKey: 'loopback|/srv/app' }]);
  });

  it('runs clone and cancelClone on this computer only', async () => {
    const { scm, local, remote, calls, asked } = twoCores();
    scm.attach(remote.client);
    void scm.cancelClone();
    expect(calls.loopback).toEqual([]);
    scm.attach(local.client);
    void scm.cancelClone();
    await vi.waitFor(() => expect(calls.local).toEqual([['cancelClone', []]]));
    await scm.clone('https://example.com/a.git', '/parent', false);
    expect(asked).toEqual(['local']);
    expect(calls.loopback).toEqual([]);
  });

  it('refuses a core\'s patch for a repository another authority published', () => {
    const { scm, local, remote } = twoCores();
    scm.attach(local.client);
    scm.attach(remote.client);
    local.core.publish('scm', { kind: 'repository', repoId: 'repo-1', repository: REPOSITORY });
    remote.core.publish('scm', { kind: 'repository', repoId: 'repo-1', repository: { ...REMOTE_REPOSITORY, snapshot: { ...REMOTE_REPOSITORY.snapshot, repoId: 'repo-1' } } });
    remote.core.publish('scm', { kind: 'repositoryState', repoId: 'repo-1', busy: true, running: 'push', lastRemote: null });
    expect(scm.repository('repo-1')).toMatchObject({ projectKey: 'p', repo: { authority: 'local' } });
    expect(scm.snapshot('repo-1')?.busy).toBe(false);
    remote.core.publish('scm', { kind: 'repository', repoId: 'repo-1' });
    expect(scm.repository('repo-1')).toBeDefined();
  });
});
