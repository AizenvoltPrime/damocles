import { describe, expect, it } from 'vitest';
import type { Endpoint } from '../../../core-protocol/endpoint';
import type { ClientToWorkspace, WorkspaceToClient } from '../../../workspace/messages';
import { createRemoteWorkspace } from '../remote-workspace';
import { NotConnectedError } from '../workspaces';

const notConnected = (): NotConnectedError => new NotConnectedError('Local daemon is not connected.');

// An endpoint whose daemon answers each request with `answers[method]`, recording what was sent.
function fakeEndpoint(answers: Record<string, unknown>, sent: Array<[string, unknown]>): Endpoint<ClientToWorkspace, WorkspaceToClient> {
  return {
    request: async (method: string, params: unknown) => {
      sent.push([method, params]);
      return answers[method];
    },
    onEvent: () => ({ dispose: () => undefined }),
    emit: () => undefined,
  } as unknown as Endpoint<ClientToWorkspace, WorkspaceToClient>;
}

const workspaceOver = (answers: Record<string, unknown>, sent: Array<[string, unknown]> = []) => createRemoteWorkspace({
  endpoint: fakeEndpoint(answers, sent),
  authorityKey: 'loopback',
  projectOfCwd: () => undefined,
  onClose: () => ({ dispose: () => undefined }),
  notConnected,
  watchReady: false,
  log: () => undefined,
});

const project = { key: 'loopback|/srv/app', fsPath: '/srv/app', name: 'app' };

describe('remote workspace client', () => {
  it('sends the native key and answers projectOfPath only with a project it sent', async () => {
    const sent: Array<[string, unknown]> = [];
    const honest = workspaceOver({ 'files.projectOfPath': { project: { key: '/srv/app', fsPath: '/srv/app', name: 'app' }, relativePath: 'a.ts', path: '/srv/app/a.ts' } }, sent);
    expect(await honest.files.projectOfPath([project], '/srv/app/a.ts')).toEqual({ project, relativePath: 'a.ts', path: '/srv/app/a.ts' });
    expect(sent[0]).toEqual(['files.projectOfPath', { projects: [{ key: '/srv/app', fsPath: '/srv/app', name: 'app' }], target: '/srv/app/a.ts' }]);
    const madeUp = workspaceOver({ 'files.projectOfPath': { project: { key: '/etc', fsPath: '/etc', name: 'etc' }, relativePath: 'passwd', path: '/etc/passwd' } });
    expect(await madeUp.files.projectOfPath([project], '/etc/passwd')).toBeUndefined();
  });

  it('refuses a project key of another authority before anything is sent', async () => {
    const sent: Array<[string, unknown]> = [];
    const workspace = workspaceOver({}, sent);
    await expect(workspace.files.confineExisting({ ...project, key: 'ssh+abc|/srv/app' }, 'a.ts')).rejects.toThrow('is not on loopback');
    await expect(workspace.files.confineExisting({ ...project, key: '/srv/app' }, 'a.ts')).rejects.toThrow('is not on loopback');
    expect(sent).toEqual([]);
  });

  it('refuses more bytes than the read asked for, and wraps the rest as a Buffer', async () => {
    const bytes = new Uint8Array(100);
    const workspace = workspaceOver({ 'files.read': { kind: 'bytes', bytes, mtimeMs: 1, dev: 1, ino: 1 } });
    expect(await workspace.files.read('/srv/app/a.bin', 10)).toEqual({ kind: 'tooLarge', bytes: 100 });
    const read = await workspace.files.read('/srv/app/a.bin', 100);
    expect(read.kind === 'bytes' && Buffer.isBuffer(read.bytes) && read.bytes.length === 100).toBe(true);
  });

  it('ends a pty host started on a connection that already closed, and tells a listener added after the end', () => {
    const emitted: string[] = [];
    const endpoint = { ...fakeEndpoint({}, []), emit: (name: string) => emitted.push(name) } as unknown as Endpoint<ClientToWorkspace, WorkspaceToClient>;
    const workspace = createRemoteWorkspace({
      endpoint,
      authorityKey: 'loopback',
      projectOfCwd: () => undefined,
      onClose: (listener) => {
        listener('network');
        return { dispose: () => undefined };
      },
      notConnected,
      watchReady: false,
      log: () => undefined,
    });
    const host = workspace.terminals.startHost();
    const exits: unknown[] = [];
    host.onExit((exit) => exits.push(exit));
    expect(exits).toEqual([{ code: 1, reason: 'disconnected: network', error: null }]);
    host.postMessage({ type: 'input', id: 'term-1', data: 'x' });
    host.kill();
    expect(emitted).toEqual([]);
  });

  it('ends every search and listing still running when the connection closes, and none it killed', async () => {
    const sent: Array<[string, unknown]> = [];
    const events = new Map<string, (payload: unknown) => void>();
    let close!: (reason: string) => void;
    const endpoint = {
      ...fakeEndpoint({}, sent),
      onEvent: (name: string, listener: (payload: unknown) => void) => {
        events.set(name, listener);
        return { dispose: () => undefined };
      },
    } as unknown as Endpoint<ClientToWorkspace, WorkspaceToClient>;
    const workspace = createRemoteWorkspace({
      endpoint,
      authorityKey: 'loopback',
      projectOfCwd: () => undefined,
      onClose: (listener) => {
        close = listener;
        return { dispose: () => undefined };
      },
      notConnected,
      watchReady: false,
      log: () => undefined,
    });
    const ends: unknown[] = [];
    workspace.search.run('/srv/app', ['--json'], { event: () => undefined, dropped: () => undefined, end: (end) => ends.push(['search', end]) });
    workspace.quickOpen.list('/srv/app', [], [], { data: () => undefined, end: (error) => ends.push(['listing', error]) });
    const killedSearch = workspace.search.run('/srv/app', ['--json'], { event: () => undefined, dropped: () => undefined, end: () => ends.push(['killed search']) });
    const killedListing = workspace.quickOpen.list('/srv/app', [], [], { data: () => undefined, end: () => ends.push(['killed listing']) });
    killedSearch.kill();
    killedListing.kill();
    await Promise.resolve();
    expect(sent.filter(([method]) => method.endsWith('.kill'))).toEqual([['search.kill', { runId: 3 }], ['quickOpen.kill', { runId: 4 }]]);
    // an end the host sent before it saw the kill reaches nobody
    events.get('search.end')!({ runId: 3, end: { code: 0, stderr: '' } });
    close('network');
    expect(ends).toEqual([['search', { error: 'The connection to the host ended: network' }], ['listing', 'The connection to the host ended: network']]);
  });

  it('fails a request the connection closes under, and one made after, as not connected rather than with the close reason', async () => {
    let close!: (reason: string) => void;
    const waiting: Array<(err: Error) => void> = [];
    // the endpoint's own close rejects what is pending with the bare reason, and every later request too
    let closedWith: string | undefined;
    const endpoint = {
      ...fakeEndpoint({}, []),
      request: () => (closedWith !== undefined ? Promise.reject(new Error(closedWith)) : new Promise((_resolve, reject) => waiting.push(reject))),
    } as unknown as Endpoint<ClientToWorkspace, WorkspaceToClient>;
    const workspace = createRemoteWorkspace({
      endpoint,
      authorityKey: 'loopback',
      projectOfCwd: () => undefined,
      onClose: (listener) => {
        close = (reason) => {
          closedWith = reason;
          for (const reject of waiting) reject(new Error(reason));
          listener(reason);
        };
        return { dispose: () => undefined };
      },
      notConnected,
      watchReady: false,
      log: () => undefined,
    });
    const pending = workspace.files.writeInPlace(project, { path: '/srv/app/a.ts', projectKey: project.key, relativePath: 'a.ts' }, Buffer.from('x'));
    close('network');
    await expect(pending).rejects.toBeInstanceOf(NotConnectedError);
    await expect(pending).rejects.toThrow('Local daemon is not connected.');
    await expect(workspace.files.realpath('/srv/app')).rejects.toBeInstanceOf(NotConnectedError);
  });

  it('settles a watch\'s ready when the daemon answers files.watch, failed answers included, only with files.watchReady', async () => {
    const answers: Array<{ resolve: () => void; reject: (err: Error) => void }> = [];
    const endpoint = {
      ...fakeEndpoint({}, []),
      request: (method: string) => (method === 'files.watch' ? new Promise<void>((resolve, reject) => answers.push({ resolve, reject })) : Promise.resolve()),
    } as unknown as Endpoint<ClientToWorkspace, WorkspaceToClient>;
    const over = (watchReady: boolean) => createRemoteWorkspace({ endpoint, authorityKey: 'loopback', projectOfCwd: () => undefined, onClose: () => ({ dispose: () => undefined }), notConnected, watchReady, log: () => undefined });
    const settled = (ready: Promise<void>): { done: boolean } => {
      const state = { done: false };
      void ready.then(() => {
        state.done = true;
      });
      return state;
    };
    const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

    const answered = settled(over(true).files.watch('/srv/app', '**', () => undefined).ready);
    const failed = settled(over(true).files.watch('/srv/app', '**', () => undefined).ready);
    const older = settled(over(false).files.watch('/srv/app', '**', () => undefined).ready);
    await flush();
    expect([answered.done, failed.done, older.done]).toEqual([false, false, true]);
    answers[0]!.resolve();
    answers[1]!.reject(new Error('EACCES'));
    await flush();
    expect([answered.done, failed.done]).toEqual([true, true]);
  });

  it('turns an entry\'s decimal identity back into bigints', async () => {
    const workspace = workspaceOver({ 'files.entry': { ok: true, path: '/srv/app/a.ts', folder: false, identity: { dev: '18446744073709551615', ino: '42', birthtimeNs: '1700000000000000000' } } });
    expect(await workspace.files.entry(project, 'a.ts')).toEqual({ ok: true, path: '/srv/app/a.ts', folder: false, identity: { dev: 18446744073709551615n, ino: 42n, birthtimeNs: 1700000000000000000n } });
  });
});
