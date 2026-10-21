import { describe, expect, it, vi } from 'vitest';
import type { ScmEvent } from '../../../core/scm/scm-service';
import { createCoreEndpoint, createLoopback, createMainEndpoint, type CoreEndpoint } from '../../core-protocol';
import { CoreClient } from '../core-client';
import { createScmClient } from '../scm/scm-client';

const quiet = (): void => undefined;

function connected(): { core: CoreEndpoint; client: CoreClient } {
  const { main, core } = createLoopback();
  const client = new CoreClient(createMainEndpoint(main, quiet), (_view, attach) => attach());
  return { core: createCoreEndpoint(core, quiet), client };
}

const VIEW = { projectKey: 'p', state: 'ready', repos: [{ repoId: 'repo-1', root: '/p', kind: 'root' }], closedRoots: [], unsafe: [], parents: [] };
const SNAPSHOT = { repoId: 'repo-1', projectKey: 'p', status: undefined, busy: false, running: null, lastRemote: null, revision: 1 };
const REPOSITORY = { projectKey: 'p', projectPath: '/p', kind: 'root' as const, root: '/p', gitDir: '/p/.git', commonDir: '/p/.git', snapshot: SNAPSHOT };

describe('core\'s ScmService as main reads it', () => {
  it('answers ScmHost\'s synchronous reads from the mirror, which is current when the event arrives', () => {
    const scm = createScmClient({ core: (_label, work) => Promise.reject(new Error(`no core for ${String(work)}`)), gitVersion: { major: 2, minor: 45, patch: 0 }, log: quiet });
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
    const scm = createScmClient({ core: (_label, work) => work(client), gitVersion: undefined, log: quiet });
    scm.attach(client);
    core.serve('scm.commit', async ({ branchName }) => ({ ok: true, asked: await core.request('scm.branchName', { token: branchName! }) }));
    core.serve('scm.commitBlob', () => new Uint8Array([104, 105]));
    core.serve('scm.ignoredIn', () => ['dist', 'node_modules']);
    const outcome = await scm.commit('repo-1', 'msg', { scope: 'auto', amend: false, signoff: false, noVerify: false, empty: false }, { saved: [], branchName: async () => 'feature/x' });
    expect(outcome).toEqual({ ok: true, asked: 'feature/x' });
    const blob = await scm.commitBlob('repo-1', 'a'.repeat(40), 'a.ts');
    expect(Buffer.isBuffer(blob)).toBe(true);
    expect((blob as Buffer).toString('utf8')).toBe('hi');
    expect(await scm.ignoredIn('p', '', [{ name: 'dist', dir: true }])).toEqual(new Set(['dist', 'node_modules']));
  });
});
