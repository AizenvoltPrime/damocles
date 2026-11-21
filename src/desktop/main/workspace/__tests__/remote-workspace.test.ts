import { describe, expect, it } from 'vitest';
import { ALL_IGNORE_FILES } from '../../../../core/search-walk';
import type { Endpoint } from '../../../core-protocol/endpoint';
import type { ClientToWorkspace, WorkspaceToClient } from '../../../workspace/messages';
import type { SearchRequest } from '../../../workspace/search/search-runner';
import type { StreamChannel } from '../../../../remote/mux';
import { createRemoteWorkspace, LINKS_FEATURE, RangedReadsUnsupportedError, TransfersUnsupportedError, WALK_FEATURES, walksWithoutLinks } from '../remote-workspace';
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

const workspaceOver = (answers: Record<string, unknown>, sent: Array<[string, unknown]> = [], links = true) => createRemoteWorkspace({
  endpoint: fakeEndpoint(answers, sent),
  authorityKey: 'loopback',
  projectOfCwd: () => undefined,
  onClose: () => ({ dispose: () => undefined }),
  notConnected,
  watchReady: false,
  transfers: false,
  rangedReads: false,
  outside: false,
  listing: false,
  links,
  walks: true,
  searchUnsupported: () => 'Update the Damocles server on this host to search it.',
  openStream: () => { throw new Error('no transfer streams in this suite'); },
  log: () => undefined,
});

describe('the walk\'s follow mode on the wire', () => {
  it.each([
    ['lists files.links', true, { followLinks: true }],
    ['does not list files.links', false, {}],
  ])('sends a listing and a search through links as asked to a daemon that %s', async (_name, links, followed) => {
    const sent: Array<[string, unknown]> = [];
    const workspace = workspaceOver({}, sent, links);
    const sink = { files: () => undefined, end: () => undefined };
    workspace.quickOpen.list('/srv/app', { ignore: ALL_IGNORE_FILES, followLinks: true }, ['**/.git'], sink);
    workspace.quickOpen.list('/srv/app', { ignore: ALL_IGNORE_FILES, followLinks: false }, [], sink);
    workspace.search.run('/srv/app', { match: [], pattern: 'x', walk: { ignore: ALL_IGNORE_FILES, overrides: [], followLinks: true } }, { event: () => undefined, dropped: () => undefined, end: () => undefined });
    await Promise.resolve();
    expect(sent).toEqual([
      ['quickOpen.list', { runId: 1, root: '/srv/app', ignore: ALL_IGNORE_FILES, ...followed, excludes: ['**/.git'] }],
      ['quickOpen.list', { runId: 2, root: '/srv/app', ignore: ALL_IGNORE_FILES, excludes: [] }],
      ['search.run', { runId: 3, cwd: '/srv/app', match: [], pattern: 'x', walk: { ignore: ALL_IGNORE_FILES, overrides: [], ...followed } }],
    ]);
  });

  it('drops only followLinks from a search walk sent to a daemon that does not list files.links', async () => {
    const sent: Array<[string, unknown]> = [];
    const workspace = workspaceOver({}, sent, false);
    // a walk field added later must still reach an older daemon
    const walk = { ignore: ALL_IGNORE_FILES, overrides: ['!a'], followLinks: true, depth: 3 } as SearchRequest['walk'];
    workspace.search.run('/srv/app', { match: [], pattern: 'x', walk }, { event: () => undefined, dropped: () => undefined, end: () => undefined });
    await Promise.resolve();
    expect(sent).toEqual([['search.run', { runId: 1, cwd: '/srv/app', match: [], pattern: 'x', walk: { ignore: ALL_IGNORE_FILES, overrides: ['!a'], depth: 3 } }]]);
  });
});

describe('walksWithoutLinks', () => {
  it('is true only for a daemon that walks and lists no files.links, whose search alone fails on a daemon that cannot walk', () => {
    expect(walksWithoutLinks([...WALK_FEATURES])).toBe(true);
    expect(walksWithoutLinks([...WALK_FEATURES, LINKS_FEATURE])).toBe(false);
    expect(walksWithoutLinks([])).toBe(false);
    expect(walksWithoutLinks([WALK_FEATURES[0]!])).toBe(false);
  });
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
    await expect(workspace.files.confineExisting({ ...project, key: 'ssh+abc|/srv/app' }, 'a.ts', 'throughLinks')).rejects.toThrow('is not on loopback');
    await expect(workspace.files.confineExisting({ ...project, key: '/srv/app' }, 'a.ts', 'withinProject')).rejects.toThrow('is not on loopback');
    expect(sent).toEqual([]);
  });

  it('asks to follow links only for throughLinks, and marks an older daemon\'s outside as one it could not follow', async () => {
    const native = { key: '/srv/app', fsPath: '/srv/app', name: 'app' };
    const outside = { ok: false, reason: 'outside' };
    const oldDaemon = { ok: false, reason: 'outside', refusal: 'oldDaemon' };
    const answers = { 'files.confineExisting': outside, 'files.confineMissing': outside, 'tree.list': outside, 'files.entry': outside, 'files.createEntry': outside, 'files.renameEntry': outside, 'files.deleteEntry': outside };
    const sent: Array<[string, unknown]> = [];
    const old = workspaceOver(answers, sent, false);
    expect(await old.files.confineExisting(project, 'out/a.ts', 'throughLinks')).toEqual(oldDaemon);
    expect(await old.files.confineMissing(project, 'out/b.ts', 'throughLinks')).toEqual(oldDaemon);
    expect(await old.files.confineExisting(project, 'out/a.ts', 'withinProject')).toEqual(outside);
    expect(await old.tree.list(project, 'out', [])).toEqual(oldDaemon);
    expect(await old.files.entry(project, 'out/a.ts')).toEqual(oldDaemon);
    expect(await old.files.createEntry(project, 'out', 'c.ts', 'file')).toEqual(oldDaemon);
    expect(await old.files.renameEntry(project, 'out/a.ts', 'd.ts')).toEqual(oldDaemon);
    expect(await old.files.deleteEntry(project, 'out/a.ts', { dev: 1n, ino: 2n, birthtimeNs: 3n })).toEqual(oldDaemon);
    expect(sent.slice(0, 4)).toEqual([
      ['files.confineExisting', { project: native, relativePath: 'out/a.ts', links: 'follow' }],
      ['files.confineMissing', { project: native, relativePath: 'out/b.ts', links: 'follow' }],
      ['files.confineExisting', { project: native, relativePath: 'out/a.ts' }],
      ['tree.list', { project: native, relativeDir: 'out', excludes: [], links: 'follow' }],
    ]);
    const current = workspaceOver(answers);
    expect(await current.files.confineExisting(project, 'out/a.ts', 'throughLinks')).toEqual(outside);
    expect(await current.tree.list(project, 'out', [])).toEqual(outside);
    expect(await current.files.entry(project, 'out/a.ts')).toEqual(outside);
  });

  it('reads a listing\'s and an entry operation\'s share refusal from a daemon that lists files.links', async () => {
    const share = { ok: false, reason: 'outside', refusal: 'share' };
    const workspace = workspaceOver({ 'tree.list': share, 'files.entry': share, 'files.createEntry': share, 'files.renameEntry': share, 'files.deleteEntry': share });
    expect(await workspace.tree.list(project, 'share/deeper', [])).toEqual(share);
    expect(await workspace.files.entry(project, 'share/a.ts')).toEqual(share);
    expect(await workspace.files.createEntry(project, 'share', 'b.ts', 'file')).toEqual(share);
    expect(await workspace.files.renameEntry(project, 'share/a.ts', 'c.ts')).toEqual(share);
    expect(await workspace.files.deleteEntry(project, 'share/a.ts', { dev: 1n, ino: 2n, birthtimeNs: 3n })).toEqual(share);
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
      transfers: false,
      rangedReads: false,
      outside: false,
      listing: false,
      links: true,
      walks: true,
      searchUnsupported: () => 'Update the Damocles server on this host to search it.',
      openStream: () => { throw new Error('no transfer streams in this suite'); },
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
      transfers: false,
      rangedReads: false,
      outside: false,
      listing: false,
      links: true,
      walks: true,
      searchUnsupported: () => 'Update the Damocles server on this host to search it.',
      openStream: () => { throw new Error('no transfer streams in this suite'); },
      log: () => undefined,
    });
    const ends: unknown[] = [];
    workspace.search.run('/srv/app', { match: [], pattern: 'x', walk: { ignore: ALL_IGNORE_FILES, overrides: [] } }, { event: () => undefined, dropped: () => undefined, end: (end) => ends.push(['search', end]) });
    workspace.quickOpen.list('/srv/app', { ignore: ALL_IGNORE_FILES, followLinks: false }, [], { files: () => undefined, end: (error) => ends.push(['listing', error]) });
    const killedSearch = workspace.search.run('/srv/app', { match: [], pattern: 'x', walk: { ignore: ALL_IGNORE_FILES, overrides: [] } }, { event: () => undefined, dropped: () => undefined, end: () => ends.push(['killed search']) });
    const killedListing = workspace.quickOpen.list('/srv/app', { ignore: ALL_IGNORE_FILES, followLinks: false }, [], { files: () => undefined, end: () => ends.push(['killed listing']) });
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
      transfers: false,
      rangedReads: false,
      outside: false,
      listing: false,
      links: true,
      walks: true,
      searchUnsupported: () => 'Update the Damocles server on this host to search it.',
      openStream: () => { throw new Error('no transfer streams in this suite'); },
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
    const over = (watchReady: boolean) => createRemoteWorkspace({ endpoint, authorityKey: 'loopback', projectOfCwd: () => undefined, onClose: () => ({ dispose: () => undefined }), notConnected, watchReady, transfers: false, rangedReads: false, outside: false, listing: false, links: true, walks: true, searchUnsupported: () => 'Update the Damocles server on this host to search it.', openStream: () => { throw new Error('no transfer streams in this suite'); }, log: () => undefined });
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

  it('sends no transfer request to a daemon that does not list the transfer features, and fails each with TransfersUnsupportedError', async () => {
    const sent: Array<[string, unknown]> = [];
    const { files } = workspaceOver({}, sent);
    const identity = { dev: 1n, ino: 2n, birthtimeNs: 3n };
    async function* none(): AsyncGenerator<Uint8Array> {}
    const calls: Array<() => Promise<unknown>> = [
      async () => {
        for await (const page of files.walk(project, 'src')) return page;
        return undefined;
      },
      () => files.clashes(project, 'src', ['a.ts']),
      () => files.copy(project, 'a.ts', project, 'src', 'b.ts', false),
      () => files.move(project, 'a.ts', project, 'src', 'b.ts', false),
      () => files.makeFolder(project, '', 'lib', 0o755),
      () => files.makeLink(project, '', 'to-a', 'a.ts', false, ''),
      () => files.verifyLink(project, 'to-a', ''),
      () => files.removeFolder(project, 'lib', identity),
      () => files.receiveFile(project, 'src', 'b.ts', none(), { mode: 0o644, mtimeMs: 0, replace: false, size: 0 }),
      () => files.readFile(project, 'a.ts'),
    ];
    for (const call of calls) await expect(call()).rejects.toBeInstanceOf(TransfersUnsupportedError);
    expect(sent).toEqual([]);
    expect(await files.realpath('/srv/app')).toBeUndefined();
    expect(sent.map(([method]) => method)).toEqual(['files.realpath']);
  });

  it('fails a ranged read whose answer is not exactly the span asked for, clamped to the file, or names no resolved path, and releases its stream', async () => {
    const cases: Array<[offset: number, length: number, answer: { size: number; offset: number; length: number; resolvedPath?: string | undefined }, ok: boolean]> = [
      [10, 5, { size: 100, offset: 10, length: 5 }, true],
      [200, 5, { size: 100, offset: 100, length: 0 }, true],
      [-5, 5, { size: 100, offset: 95, length: 5 }, true],
      [-500, 500, { size: 100, offset: 0, length: 100 }, true],
      [98, 5, { size: 100, offset: 98, length: 2 }, true],
      [0, Number.MAX_SAFE_INTEGER, { size: 100, offset: 0, length: 100 }, true],
      // fewer than the file holds of the span, so a response declaring the span would end short
      [10, 5, { size: 100, offset: 10, length: 4 }, false],
      [0, Number.MAX_SAFE_INTEGER, { size: 100, offset: 0, length: 99 }, false],
      // more than asked for, from another offset, past the end of the file, or a suffix that does not start where the end is
      [10, 5, { size: 100, offset: 10, length: 6 }, false],
      [10, 5, { size: 100, offset: 11, length: 5 }, false],
      [98, 5, { size: 100, offset: 98, length: 5 }, false],
      [200, 5, { size: 100, offset: 200, length: 0 }, false],
      [-5, 5, { size: 100, offset: 0, length: 5 }, false],
      [-5, 5, { size: 100, offset: 96, length: 5 }, false],
      // the span, with no resolved path for the deny list
      [10, 5, { size: 100, offset: 10, length: 5, resolvedPath: undefined }, false],
    ];
    for (const [offset, length, answer, ok] of cases) {
      const ended: number[] = [];
      const stream = { id: 7, closed: false, write: () => true, end: () => ended.push(7), onData: () => ({ dispose: () => undefined }), onEnd: () => ({ dispose: () => undefined }), onDrain: () => ({ dispose: () => undefined }), pause: () => undefined, resume: () => undefined } satisfies StreamChannel;
      const logged: string[] = [];
      const { files } = createRemoteWorkspace({ endpoint: fakeEndpoint({ 'files.readFileRange': { ok: true, resolvedPath: 'media/clip.mp4', ...answer } }, []), authorityKey: 'loopback', projectOfCwd: () => undefined, onClose: () => ({ dispose: () => undefined }), notConnected, watchReady: false, transfers: true, rangedReads: true, outside: false, listing: false, links: true, walks: true, searchUnsupported: () => 'Update the Damocles server on this host to search it.', openStream: () => stream, log: (line) => logged.push(line) });
      const read = await files.readFileRange(project, 'clip.mp4', offset, length);
      const label = JSON.stringify([offset, length, answer]);
      if (ok) {
        expect(read, label).toMatchObject({ ok: true, resolvedPath: 'media/clip.mp4', ...answer });
        expect(ended, label).toEqual([]);
        if (read.ok) await read.chunks[Symbol.asyncIterator]().return?.();
      } else {
        expect(read, label).toEqual({ ok: false, reason: 'failed' });
        expect(ended, label).toEqual([7]);
        expect(logged, label).toHaveLength(1);
      }
    }
  });

  it('answers a folder as one, and a link or FIFO as no folder, from a daemon that may leave folder out', async () => {
    const stream = { id: 7, closed: false, write: () => true, end: () => undefined, onData: () => ({ dispose: () => undefined }), onEnd: () => ({ dispose: () => undefined }), onDrain: () => ({ dispose: () => undefined }), pause: () => undefined, resume: () => undefined } satisfies StreamChannel;
    for (const [answer, folder] of [[{ ok: false, reason: 'notAFile', folder: true }, true], [{ ok: false, reason: 'notAFile', folder: false }, false], [{ ok: false, reason: 'notAFile' }, false]] as const) {
      const { files } = createRemoteWorkspace({ endpoint: fakeEndpoint({ 'files.readFileRange': answer }, []), authorityKey: 'loopback', projectOfCwd: () => undefined, onClose: () => ({ dispose: () => undefined }), notConnected, watchReady: false, transfers: true, rangedReads: true, outside: false, listing: false, links: true, walks: true, searchUnsupported: () => 'Update the Damocles server on this host to search it.', openStream: () => stream, log: () => undefined });
      expect(await files.readFileRange(project, 'docs', 0, 1)).toEqual({ ok: false, reason: 'notAFile', folder });
    }
  });

  it('sends no ranged read to a daemon that does not list files.readFileRange.resolvedPath', async () => {
    const sent: Array<[string, unknown]> = [];
    const { files } = createRemoteWorkspace({ endpoint: fakeEndpoint({}, sent), authorityKey: 'loopback', projectOfCwd: () => undefined, onClose: () => ({ dispose: () => undefined }), notConnected, watchReady: false, transfers: true, rangedReads: false, outside: false, listing: false, links: true, walks: true, searchUnsupported: () => 'Update the Damocles server on this host to search it.', openStream: () => { throw new Error('no stream for a refused read'); }, log: () => undefined });
    await expect(files.readFileRange(project, 'clip.mp4', 0, 1)).rejects.toBeInstanceOf(RangedReadsUnsupportedError);
    expect(sent).toEqual([]);
  });

  it('reads every transfer request\'s outside from an older daemon as oldDaemon, and passes a current daemon\'s refusal and words on', async () => {
    const stream = { id: 7, closed: false, write: () => true, end: () => undefined, onData: () => ({ dispose: () => undefined }), onEnd: () => ({ dispose: () => undefined }), onDrain: () => ({ dispose: () => undefined }), pause: () => undefined, resume: () => undefined } satisfies StreamChannel;
    const over = (answer: unknown, links: boolean) => createRemoteWorkspace({
      endpoint: { ...fakeEndpoint({}, []), request: async () => answer } as unknown as Endpoint<ClientToWorkspace, WorkspaceToClient>,
      authorityKey: 'loopback', projectOfCwd: () => undefined, onClose: () => ({ dispose: () => undefined }), notConnected, watchReady: false, transfers: true, rangedReads: false, outside: false, listing: false, links, walks: true,
      searchUnsupported: () => 'Update the Damocles server on this host to search it.', openStream: () => stream, log: () => undefined,
    }).files;
    async function* none(): AsyncGenerator<Uint8Array> {
      // a file of no bytes
    }
    const identity = { dev: 1n, ino: 2n, birthtimeNs: 3n };
    const calls = (files: ReturnType<typeof over>) => [
      files.clashes(project, 'out', ['a.ts']),
      files.receiveFile(project, 'out', 'a.ts', none(), { mode: 0o644, mtimeMs: 0, replace: false, size: 0 }),
      files.readFile(project, 'out/a.ts'),
      files.copy(project, 'a.ts', project, 'out', 'a.ts', false),
      files.move(project, 'a.ts', project, 'out', 'a.ts', false),
      files.makeFolder(project, 'out', 'lib'),
      files.makeLink(project, 'out', 'l', 'a.ts', false),
      files.verifyLink(project, 'out/l', 'out'),
      files.removeFolder(project, 'out/lib', identity),
    ];
    const results = async (answer: unknown, links: boolean) => Promise.all(calls(over(answer, links)));
    const oldDaemon = { ok: false, reason: 'outside', refusal: 'oldDaemon' };
    expect(await results({ ok: false, reason: 'outside' }, false)).toEqual(Array.from({ length: 9 }, () => oldDaemon));
    const share = { ok: false, reason: 'outside', refusal: 'share' };
    expect(await results(share, true)).toEqual(Array.from({ length: 9 }, () => share));
    const failed = { ok: false, reason: 'failed', error: { message: 'The drive {0} did not answer within a second.', args: ['Q:\\'] } };
    expect(await results(failed, false)).toEqual(Array.from({ length: 9 }, () => failed));
  });

  it('sends a folder\'s mode and a copy\'s cancel to a daemon that carries transfers', async () => {
    const requests: Array<[string, unknown, AbortSignal | undefined]> = [];
    const endpoint = {
      ...fakeEndpoint({}, []),
      request: async (method: string, params: unknown, signal?: AbortSignal) => {
        requests.push([method, params, signal]);
        return { ok: true };
      },
    } as unknown as Endpoint<ClientToWorkspace, WorkspaceToClient>;
    const { files } = createRemoteWorkspace({ endpoint, authorityKey: 'loopback', projectOfCwd: () => undefined, onClose: () => ({ dispose: () => undefined }), notConnected, watchReady: false, transfers: true, rangedReads: false, outside: false, listing: false, links: true, walks: true, searchUnsupported: () => 'Update the Damocles server on this host to search it.', openStream: () => { throw new Error('no transfer streams in this suite'); }, log: () => undefined });
    const controller = new AbortController();
    await files.makeFolder(project, '', 'lib', 0o700);
    await files.copy(project, 'a.ts', project, 'lib', 'a.ts', false, controller.signal);
    expect(requests.map(([method, params, signal]) => [method, params, signal])).toEqual([
      ['files.makeFolder', { project: { key: '/srv/app', fsPath: '/srv/app', name: 'app' }, relativeDir: '', name: 'lib', mode: 0o700, links: 'follow' }, undefined],
      ['files.copy', { from: { key: '/srv/app', fsPath: '/srv/app', name: 'app' }, relativePath: 'a.ts', to: { key: '/srv/app', fsPath: '/srv/app', name: 'app' }, toDir: 'lib', name: 'a.ts', replace: false, links: 'follow' }, controller.signal],
    ]);
  });
});
