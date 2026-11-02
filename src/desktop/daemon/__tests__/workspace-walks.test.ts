import { describe, expect, it, vi } from 'vitest';
import { createEndpoint, type CoreTransport } from '../../core-protocol/endpoint';
import { ERROR_CODEC } from '../../core-protocol/errors';
import { INVALID } from '../../core-protocol/schema';
import { CLIENT_TO_WORKSPACE, WORKSPACE_TO_CLIENT, type ClientToWorkspace, type WorkspaceToClient } from '../../workspace/messages';
import { MOVE_LEFT_LISTED } from '../../workspace/transfer-ops';
import type { TerminalHub } from '../terminal-hub';
import { createWorkspaceHost, MAX_WALKS, type WorkspaceModules } from '../workspace-host';

// Two ends of an in-memory channel; each message arrives on a later task, structured-cloned as the wire copies it.
function channel(): readonly [CoreTransport, CoreTransport] {
  const listeners = [new Set<(raw: unknown) => void>(), new Set<(raw: unknown) => void>()] as const;
  const end = (own: 0 | 1): CoreTransport => ({
    post: (message) => {
      const copy = structuredClone(message);
      setImmediate(() => listeners[own === 0 ? 1 : 0].forEach((listener) => listener(copy)));
    },
    onMessage: (listener) => {
      listeners[own].add(listener);
      return { dispose: () => listeners[own].delete(listener) };
    },
  });
  return [end(0), end(1)];
}

describe('the walks a connection holds open', () => {
  it(`refuses a walk past ${MAX_WALKS} running ones, and takes one again once a walk ended`, async () => {
    // a walk that never finishes on its own
    const endless = (): AsyncIterable<never[]> => ({
      [Symbol.asyncIterator]: () => ({
        next: async () => ({ done: false, value: [] }),
        return: async () => ({ done: true, value: undefined }),
      }),
    });
    const host = createWorkspaceHost({
      files: { walk: endless },
      hub: { detach: () => undefined } as unknown as TerminalHub,
      cli: { connected: () => ({ dispose: () => undefined }) },
      watchLimits: { roots: () => [], onReached: () => ({ dispose: () => undefined }), limit: async () => null },
    } as unknown as WorkspaceModules, () => undefined);
    const [clientEnd, hostEnd] = channel();
    const served = host.serve('test-connection', 'test-client', hostEnd, (reason) => { throw new Error(reason); }, () => undefined, () => false);
    const endpoint = createEndpoint<ClientToWorkspace, WorkspaceToClient>({ transport: clientEnd, outgoing: CLIENT_TO_WORKSPACE, incoming: WORKSPACE_TO_CLIENT, log: () => undefined, errors: ERROR_CODEC });
    const project = { key: '/srv/app', fsPath: '/srv/app', name: 'app' };
    try {
      for (let walkId = 1; walkId <= MAX_WALKS; walkId++) await endpoint.request('files.walk', { walkId, project, relativePath: '' });
      await expect(endpoint.request('files.walk', { walkId: MAX_WALKS + 1, project, relativePath: '' })).rejects.toThrow(`${MAX_WALKS} walks are already running on this connection`);
      await endpoint.request('files.walkEnd', { walkId: 1 });
      expect(await endpoint.request('files.walk', { walkId: MAX_WALKS + 1, project, relativePath: '' })).toEqual({ entries: [], done: false });
    } finally {
      endpoint.close('done');
      served.dispose();
    }
  });
});

describe('the workspace host\'s transfer requests', () => {
  function serve(files: Partial<WorkspaceModules['files']>): { readonly endpoint: ReturnType<typeof createEndpoint<ClientToWorkspace, WorkspaceToClient>>; readonly violations: string[]; dispose(): void } {
    const host = createWorkspaceHost({
      files,
      hub: { detach: () => undefined } as unknown as TerminalHub,
      cli: { connected: () => ({ dispose: () => undefined }) },
      watchLimits: { roots: () => [], onReached: () => ({ dispose: () => undefined }), limit: async () => null },
    } as unknown as WorkspaceModules, () => undefined);
    const [clientEnd, hostEnd] = channel();
    const violations: string[] = [];
    const served = host.serve('test-connection', 'test-client', hostEnd, (reason) => violations.push(reason), () => undefined, () => false);
    const endpoint = createEndpoint<ClientToWorkspace, WorkspaceToClient>({ transport: clientEnd, outgoing: CLIENT_TO_WORKSPACE, incoming: WORKSPACE_TO_CLIENT, log: () => undefined, errors: ERROR_CODEC, onViolation: (error) => violations.push(error.message) });
    return {
      endpoint,
      violations,
      dispose: () => {
        endpoint.close('done');
        served.dispose();
      },
    };
  }
  const project = { key: '/srv/app', fsPath: '/srv/app', name: 'app' };

  it('stops a copy or a move the client cancelled, through the request\'s signal', async () => {
    const signals: AbortSignal[] = [];
    const waitForCancel = async (signal: AbortSignal | undefined): Promise<never> => {
      signals.push(signal!);
      return new Promise((_resolve, reject) => signal!.addEventListener('abort', () => reject(new Error('This operation was aborted'))));
    };
    const { endpoint, violations, dispose } = serve({
      copy: async (_from, _rel, _to, _dir, _name, _replace, signal) => waitForCancel(signal),
      move: async (_from, _rel, _to, _dir, _name, _replace, signal) => waitForCancel(signal),
    });
    try {
      for (const method of ['files.copy', 'files.move'] as const) {
        const controller = new AbortController();
        const answer = endpoint.request(method, { from: project, relativePath: 'a.ts', to: project, toDir: 'lib', name: 'a.ts', replace: false }, controller.signal);
        await vi.waitFor(() => expect(signals).toHaveLength(method === 'files.copy' ? 1 : 2));
        controller.abort();
        await expect(answer).rejects.toThrow('This operation was aborted');
      }
      expect(signals.every((signal) => signal.aborted)).toBe(true);
      expect(violations).toEqual([]);
    } finally {
      dispose();
    }
  });

  it('serves a folder\'s mode and the check of a link made within a folder', async () => {
    const made: Array<number | undefined> = [];
    const checked: string[][] = [];
    const { endpoint, dispose } = serve({
      makeFolder: async (_project, _dir, _name, mode) => {
        made.push(mode);
        return { ok: true };
      },
      verifyLink: async (_project, relativePath, within) => {
        checked.push([relativePath, within]);
        return { ok: false, reason: 'outside' };
      },
    });
    try {
      expect(await endpoint.request('files.makeFolder', { project, relativeDir: '', name: 'private', mode: 0o700 })).toEqual({ ok: true });
      expect(await endpoint.request('files.makeFolder', { project, relativeDir: '', name: 'plain' })).toEqual({ ok: true });
      expect(await endpoint.request('files.verifyLink', { project, relativePath: 'dl/a', within: 'dl' })).toEqual({ ok: false, reason: 'outside' });
      expect(made).toEqual([0o700, undefined]);
      expect(checked).toEqual([['dl/a', 'dl']]);
    } finally {
      dispose();
    }
  });

  it('fails only the request whose answer is outside the contract, and the connection stays', async () => {
    const { endpoint, violations, dispose } = serve({
      move: async () => ({ ok: true, left: Array.from({ length: MOVE_LEFT_LISTED + 1 }, (_, index) => `f${index}`) }),
      clashes: async () => ({ ok: true, clashes: [] }),
    });
    try {
      await expect(endpoint.request('files.move', { from: project, relativePath: 'a', to: project, toDir: 'b', name: 'a', replace: false })).rejects.toThrow('Core protocol violation: the answer to files.move');
      expect(await endpoint.request('files.clashes', { project, relativeDir: '', names: [] })).toEqual({ ok: true, clashes: [] });
      expect(violations).toEqual([]);
    } finally {
      dispose();
    }
  });
});

describe('the transfer contract\'s parsers', () => {
  const identity = { dev: '2049', ino: '42', birthtimeNs: '-86400000000000' };

  it('accept the identity of an entry born before 1970', () => {
    expect(CLIENT_TO_WORKSPACE.requests['files.entry'].result({ ok: true, path: '/srv/app/old.txt', folder: false, identity })).not.toBe(INVALID);
    expect(CLIENT_TO_WORKSPACE.requests['files.deleteEntry'].params({ project: { key: '/srv/app', fsPath: '/srv/app', name: 'app' }, relativePath: 'old.txt', confirmed: identity })).not.toBe(INVALID);
    expect(CLIENT_TO_WORKSPACE.requests['files.entry'].result({ ok: true, path: '/srv/app/old.txt', folder: false, identity: { ...identity, ino: '-' } })).toBe(INVALID);
  });

  it('accept a walk entry that could not be read, and a move\'s count of what it left unlisted', () => {
    const entry = { relativePath: 'locked', kind: 'other', size: 0, mode: 0, mtimeMs: 0, identity: { dev: '0', ino: '0', birthtimeNs: '0' }, error: 'EACCES' };
    expect(CLIENT_TO_WORKSPACE.requests['files.walkNext'].result({ entries: [entry], done: true })).not.toBe(INVALID);
    const move = CLIENT_TO_WORKSPACE.requests['files.move'].result;
    expect(move({ ok: true, left: ['a'], leftMore: 7 })).not.toBe(INVALID);
    expect(move({ ok: true, left: Array.from({ length: MOVE_LEFT_LISTED + 1 }, () => 'a') })).toBe(INVALID);
  });
});
