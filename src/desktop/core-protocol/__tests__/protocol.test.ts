import { describe, expect, it, vi } from 'vitest';
import { createEndpoint, CoreProtocolError } from '../endpoint';
import { createLoopback } from '../loopback';
import { CORE_TO_MAIN, MAIN_TO_CORE, type CoreToMain, type MainToCore } from '../messages';
import { arr, data, INVALID, obj, opt, str } from '../schema';
import { GitError, gitErrorText, GitUntrustedError, RemoteCancelledError, StashKeptError, SyncBranchChangedError } from '../../../core/scm/errors';
import { createCoreEndpoint, createMainEndpoint } from '..';

const quiet = (): void => undefined;

function pair(onViolation?: (error: CoreProtocolError) => void) {
  const { main, core } = createLoopback();
  const options = { log: quiet, ...(onViolation ? { onViolation } : {}) };
  return {
    transports: { main, core },
    main: createEndpoint<MainToCore, CoreToMain>({ transport: main, outgoing: MAIN_TO_CORE, incoming: CORE_TO_MAIN, ...options }),
    core: createEndpoint<CoreToMain, MainToCore>({ transport: core, outgoing: CORE_TO_MAIN, incoming: MAIN_TO_CORE, ...options }),
  };
}

describe('parsers', () => {
  it('keep only the fields they know, and leave an absent optional field absent', () => {
    const parse = obj({ name: str(10), note: opt(str(10)), tags: arr(str(5), 2) });
    expect(parse({ name: 'a', tags: ['x'], extra: 1, note: undefined })).toEqual({ name: 'a', tags: ['x'] });
    expect(Object.keys(parse({ name: 'a', tags: [] }) as object)).toEqual(['name', 'tags']);
    expect(parse({ name: 'a', tags: ['x', 'y', 'z'] })).toBe(INVALID);
    expect(parse({ name: 'far too long', tags: [] })).toBe(INVALID);
  });

  it('take JSON-shaped data within its size and nothing else', () => {
    const parse = data(20);
    expect(parse({ a: [1, 'two', null, undefined, true] })).not.toBe(INVALID);
    expect(parse({ text: 'x'.repeat(30) })).toBe(INVALID);
    expect(parse(new Map([['a', 1]]))).toBe(INVALID);
    expect(parse({ frame: new ArrayBuffer(2), view: new Uint8Array(2) })).not.toBe(INVALID);
    expect(parse({ frame: new ArrayBuffer(64) })).toBe(INVALID);
    const cycle: Record<string, unknown> = {};
    cycle['self'] = cycle;
    expect(parse(cycle)).toBe(INVALID);
    const shared = { a: 1 };
    expect(parse({ left: shared, right: shared })).not.toBe(INVALID);
  });
});

describe('the loopback transport', () => {
  it('delivers a structured clone, on the caller\'s stack', () => {
    const { main, core } = createLoopback();
    const received: unknown[] = [];
    core.onMessage((raw) => received.push(raw));
    const sent = { nested: { value: 1 } };
    main.post(sent);
    sent.nested.value = 2;
    expect(received).toEqual([{ nested: { value: 1 } }]);
    expect(received[0]).not.toBe(sent);
  });

  it('refuses what cannot be cloned', () => {
    const { main, core } = createLoopback();
    core.onMessage(quiet);
    expect(() => main.post({ run: () => undefined })).toThrow(/could not be cloned/);
  });
});

describe('the endpoint', () => {
  it('answers a request with the result its handler resolves', async () => {
    const { main, core } = pair();
    main.serve('secrets.get', ({ key }) => Promise.resolve(`value of ${key}`));
    expect(await core.request('secrets.get', { key: 'k' })).toBe('value of k');
  });

  it('rejects with the handler\'s error message', async () => {
    const { main, core } = pair();
    main.serve('editor.readText', () => Promise.reject(new Error('ENOENT: no such file')));
    await expect(core.request('editor.readText', { path: '/x' })).rejects.toThrow('ENOENT: no such file');
  });

  it('aborts the handler\'s signal when the caller aborts', async () => {
    const { main, core } = pair();
    let seen: AbortSignal | undefined;
    main.serve('dialogs.pickFolder', (_options, signal) => {
      seen = signal;
      return new Promise((resolve) => signal.addEventListener('abort', () => resolve(undefined)));
    });
    const controller = new AbortController();
    const answer = core.request('dialogs.pickFolder', {}, controller.signal);
    expect(seen?.aborted).toBe(false);
    controller.abort();
    expect(seen?.aborted).toBe(true);
    expect(await answer).toBeUndefined();
  });

  it('rejects pending requests on close', async () => {
    const { main, core } = pair();
    main.serve('trust.request', () => new Promise(() => undefined));
    const pending = core.request('trust.request', { folderPath: '/p' });
    core.close('core went away');
    await expect(pending).rejects.toThrow('core went away');
    await expect(core.request('secrets.keys', {})).rejects.toThrow('core went away');
  });

  it('delivers mirror deltas in version order', () => {
    const { main, core } = pair();
    const patches: unknown[] = [];
    core.onMirror('language', (patch) => patches.push(patch));
    main.publish('language', { language: 'en' });
    main.publish('language', { language: 'el' });
    expect(patches).toEqual([{ language: 'en' }, { language: 'el' }]);
  });

  it('sends a delta before the reply that depends on it', async () => {
    const { main, core } = pair();
    const order: string[] = [];
    core.onMirror('trust', () => order.push('delta'));
    main.serve('trust.request', async ({ folderPath }) => {
      main.publish('trust', { keys: [folderPath], granted: [folderPath] });
      return true;
    });
    await core.request('trust.request', { folderPath: '/p' }).then(() => order.push('reply'));
    expect(order).toEqual(['delta', 'reply']);
  });

  // Electron's postMessage throws a plain Error for what it cannot clone, not the DOMException structuredClone throws.
  it('settles a request whose result cannot cross as a plain failure, whatever error the transport throws', async () => {
    const { main, core } = createLoopback();
    const lines: string[] = [];
    const electronLike = {
      post: (message: unknown) => {
        if ((message as { result?: unknown }).result instanceof Function) throw new Error('An object could not be cloned.');
        main.post(message);
      },
      onMessage: main.onMessage,
    };
    const mainEnd = createEndpoint<MainToCore, CoreToMain>({ transport: electronLike, outgoing: MAIN_TO_CORE, incoming: CORE_TO_MAIN, log: (line) => lines.push(line) });
    const coreEnd = createEndpoint<CoreToMain, MainToCore>({ transport: core, outgoing: CORE_TO_MAIN, incoming: MAIN_TO_CORE, log: quiet });
    mainEnd.serve('secrets.get', () => Promise.resolve((() => 'x') as unknown as string));
    await expect(coreEnd.request('secrets.get', { key: 'k' })).rejects.toThrow('An object could not be cloned.');
    expect(lines).toEqual([expect.stringContaining('response 1 could not be sent')]);
  });

  it('keeps a topic\'s version when its delta could not be sent, so the next delta is the next version', () => {
    const { main, core } = pair();
    const patches: unknown[] = [];
    core.onMirror('state', (patch) => patches.push(patch));
    expect(() => main.publish('state', { scope: 'global', key: 'k', value: () => undefined })).toThrow(/could not be cloned/);
    main.publish('state', { scope: 'global', key: 'k', value: 1 });
    expect(patches).toEqual([{ scope: 'global', key: 'k', value: 1 }]);
  });
});

describe('a protocol violation', () => {
  it('is thrown in process', () => {
    const { transports } = pair();
    expect(() => transports.main.post({ kind: 'event', name: 'secrets.changed', payload: { key: 7 } })).toThrow(CoreProtocolError);
    expect(() => transports.main.post({ kind: 'nonsense' })).toThrow(CoreProtocolError);
    expect(() => transports.core.post({ kind: 'request', id: 1, method: 'fs.deleteEverything', params: {} })).toThrow(CoreProtocolError);
  });

  it('includes a skipped mirror version', () => {
    const { transports } = pair();
    expect(() => transports.main.post({ kind: 'mirror', topic: 'language', version: 2, patch: { language: 'en' } })).toThrow(/expected v1/);
  });

  it('includes a result outside the contract, which also rejects the call', async () => {
    const violations: CoreProtocolError[] = [];
    const { main, core } = pair((error) => violations.push(error));
    main.serve('shell.openExternal', () => 'yes' as unknown as boolean);
    await expect(core.request('shell.openExternal', { url: 'https://example.com/' })).rejects.toThrow(CoreProtocolError);
    expect(violations).toHaveLength(1);
  });

  it('includes a response to no request', () => {
    const { transports } = pair();
    expect(() => transports.main.post({ kind: 'response', id: 41, ok: true, result: undefined })).toThrow(/unknown request/);
  });
});

describe('the facade', () => {
  it('pairs main\'s and core\'s endpoints over one transport pair', async () => {
    const { main, core } = createLoopback();
    const mainEnd = createMainEndpoint(main, quiet);
    const coreEnd = createCoreEndpoint(core, quiet);
    const handler = vi.fn(() => Promise.resolve('PROXY x:1'));
    mainEnd.serve('network.resolveProxy', handler);
    expect(await coreEnd.request('network.resolveProxy', { url: 'https://a/' })).toBe('PROXY x:1');
    expect(handler).toHaveBeenCalledWith({ url: 'https://a/' }, expect.any(AbortSignal));
  });
});

describe('source control errors across the channel', () => {
  const pairWith = (onViolation?: (error: CoreProtocolError) => void) => {
    const { main, core } = createLoopback();
    return { main: createMainEndpoint(main, quiet, onViolation), core: createCoreEndpoint(core, quiet, onViolation), transports: { main, core } };
  };

  it('are rebuilt in main as the classes ScmHost acts on, with their fields', async () => {
    const { main, core } = pairWith();
    const confirmed = { branch: 'main', remote: 'origin', upstreamBranch: 'main' };
    const errors: Error[] = [
      new StashKeptError({ message: 'Your changes are in the stash' }, 'failed', 'a'.repeat(40), new GitError('git pull exited with 1', 1, 'out', 'error: conflict in a.ts')),
      new SyncBranchChangedError({ message: 'The branch changed' }, 'push', confirmed, null),
      new RemoteCancelledError(),
      new GitUntrustedError(),
      new GitError('git fetch exited with 128', 128, 'ignored', 'fatal: unable to access'),
    ];
    let next = 0;
    core.serve('scm.call', () => Promise.reject(errors[next++]));
    const rebuilt: unknown[] = [];
    for (let i = 0; i < errors.length; i++) rebuilt.push(await main.request('scm.call', { method: 'fetch', args: ['repo-1', {}] }).catch((err: unknown) => err));
    const [stash, sync, cancelled, untrusted, git] = rebuilt as [StashKeptError, SyncBranchChangedError, Error, Error, GitError];
    expect(stash).toBeInstanceOf(StashKeptError);
    expect({ text: stash.text, message: stash.message, outcome: stash.outcome, stash: stash.stash }).toEqual({ text: { message: 'Your changes are in the stash' }, message: 'Your changes are in the stash', outcome: 'failed', stash: 'a'.repeat(40) });
    expect(stash.cause).toBeInstanceOf(GitError);
    expect(gitErrorText(stash.cause)).toBe('error: conflict in a.ts');
    expect(sync).toBeInstanceOf(SyncBranchChangedError);
    expect({ text: sync.text, stage: sync.stage, confirmed: sync.confirmed, found: sync.found }).toEqual({ text: { message: 'The branch changed' }, stage: 'push', confirmed, found: null });
    expect(cancelled).toBeInstanceOf(RemoteCancelledError);
    expect(untrusted).toBeInstanceOf(GitUntrustedError);
    expect(git).toBeInstanceOf(GitError);
    expect({ exitCode: git.exitCode, stderr: git.stderr, stdout: git.stdout }).toEqual({ exitCode: 128, stderr: 'fatal: unable to access', stdout: '' });
  });

  it('cross as their message when the contract names no class for them', async () => {
    const { main, core } = pairWith();
    core.serve('scm.call', () => Promise.reject(new TypeError('boom')));
    const err = await main.request('scm.call', { method: 'refresh', args: ['repo-1'] }).catch((error: unknown) => error);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(TypeError);
    expect((err as Error).message).toBe('boom');
  });

  it('are a violation when they name a class outside the contract or carry the wrong fields', async () => {
    const violations: CoreProtocolError[] = [];
    const transports = createLoopback();
    const main = createMainEndpoint(transports.main, quiet, (error) => violations.push(error));
    transports.core.onMessage((raw) => {
      const request = raw as { kind: string; id: number };
      if (request.kind !== 'request') return;
      const fault = request.id === 1 ? { name: 'ProcessExit', data: {} } : { name: 'StashKeptError', data: { outcome: 'exploded' } };
      transports.core.post({ kind: 'response', id: request.id, ok: false, error: 'x', fault });
    });
    await expect(main.request('scm.call', { method: 'refresh', args: [] })).rejects.toThrow(CoreProtocolError);
    await expect(main.request('scm.call', { method: 'refresh', args: [] })).rejects.toThrow(CoreProtocolError);
    expect(violations.map((violation) => violation.message)).toEqual(['Core protocol violation: error ProcessExit of scm.call', 'Core protocol violation: error StashKeptError of scm.call']);
  });
});

describe('a chat\'s activity and worktree state', () => {
  const activity = {
    state: 'requires_action',
    pendingKinds: ['approval'],
    pendingPrompts: [
      { id: 'toolu_1', kind: 'approval', owner: { kind: 'main' }, summary: { message: 'edit {0}', args: ['a.ts'] } },
      { id: 'toolu_2', kind: 'approval', owner: { kind: 'team', teamId: 't', agentId: 'a', agentName: 'Reviewer' } },
    ],
    background: false,
  };
  const worktree = {
    panelId: 'panel-1',
    projectPath: '/p',
    workingFolder: '/w',
    worktreeId: 'wt-1',
    busy: false,
    state: { phase: 'settingUp', place: 'worktree', canHandOff: false, sharedWith: 2, setupStep: { command: 'npm ci', index: 1, total: 2 } },
  };

  it('reach main with the fields main acts on', () => {
    const { main, transports } = pair();
    const received: unknown[] = [];
    main.onEvent('chat.activity', (payload) => received.push(payload));
    main.onEvent('chat.worktreeState', ({ event }) => received.push(event));
    transports.core.post({ kind: 'event', name: 'chat.activity', payload: { panelId: 'panel-1', activity: { ...activity, extra: 1 } } });
    transports.core.post({ kind: 'event', name: 'chat.worktreeState', payload: { event: worktree } });
    expect(received).toEqual([{ panelId: 'panel-1', activity }, worktree]);
  });

  it('are a violation when a field main acts on is malformed', () => {
    const { transports } = pair();
    const prompt = activity.pendingPrompts[0]!;
    expect(() => transports.core.post({ kind: 'event', name: 'chat.activity', payload: { panelId: 'p', activity: { ...activity, pendingPrompts: [{ ...prompt, id: 7 }] } } })).toThrow(CoreProtocolError);
    expect(() => transports.core.post({ kind: 'event', name: 'chat.activity', payload: { panelId: 'p', activity: { ...activity, state: 'busy' } } })).toThrow(CoreProtocolError);
    expect(() => transports.core.post({ kind: 'event', name: 'chat.worktreeState', payload: { event: { ...worktree, state: { ...worktree.state, phase: 'gone' } } } })).toThrow(CoreProtocolError);
    expect(() => transports.core.post({ kind: 'event', name: 'chat.worktreeState', payload: { event: { ...worktree, busy: 'no' } } })).toThrow(CoreProtocolError);
  });
});

describe('core\'s text main renders', () => {
  const outcome = { kind: 'error', message: { message: 'The provider refused: {0}', args: ['overloaded'] } };
  const rateLimit = { kind: 'rateLimit', windowId: 'five_hour', windowLabel: { message: 'Session (5hr)' }, resetsAt: 1 };
  const crossing = { provider: 'anthropic', windowId: 'five_hour', windowLabel: { message: 'Weekly {0}', args: ['Opus'] }, threshold: 80, utilization: 81.5, planName: 'Max 20x' };

  it('reaches main as LocalizedText in a turn outcome and a usage crossing', () => {
    const { main, transports } = pair();
    const received: unknown[] = [];
    main.onEvent('chat.turnSettled', ({ outcome: settled }) => received.push(settled));
    main.onEvent('chat.usageThreshold', ({ crossing: crossed }) => received.push(crossed));
    for (const settled of [outcome, rateLimit, { kind: 'completed', durationMs: 5 }, { kind: 'cancelled' }]) transports.core.post({ kind: 'event', name: 'chat.turnSettled', payload: { panelId: 'p', outcome: settled } });
    transports.core.post({ kind: 'event', name: 'chat.usageThreshold', payload: { crossing } });
    expect(received).toEqual([outcome, rateLimit, { kind: 'completed', durationMs: 5 }, { kind: 'cancelled' }, crossing]);
  });

  it('is a violation at the parse when it is not LocalizedText', () => {
    const { transports } = pair();
    const settle = (settled: unknown) => (): void => transports.core.post({ kind: 'event', name: 'chat.turnSettled', payload: { panelId: 'p', outcome: settled } });
    expect(settle({ kind: 'error', message: 'The provider refused' })).toThrow(CoreProtocolError);
    expect(settle({ ...rateLimit, windowLabel: 'Session (5hr)' })).toThrow(CoreProtocolError);
    expect(settle({ kind: 'exploded' })).toThrow(CoreProtocolError);
    expect(() => transports.core.post({ kind: 'event', name: 'chat.usageThreshold', payload: { crossing: { ...crossing, windowLabel: 'Weekly' } } })).toThrow(CoreProtocolError);
    expect(() => transports.core.post({ kind: 'event', name: 'chat.usageThreshold', payload: { crossing: { ...crossing, threshold: 50 } } })).toThrow(CoreProtocolError);
  });

  it('reaches main as LocalizedText in a catalog refusal, and a string there is a violation', async () => {
    const violations: CoreProtocolError[] = [];
    const { main, core } = pair((error) => violations.push(error));
    const refusal = { ok: false, reason: 'invalid', message: { message: 'A chat name is at most {0} characters.', args: [200] } };
    let answer: unknown = refusal;
    core.serve('catalog.rename', () => answer as never);
    expect(await main.request('catalog.rename', { sessionId: 's', name: 'n' })).toEqual(refusal);
    answer = { ok: true };
    expect(await main.request('catalog.rename', { sessionId: 's', name: 'n' })).toEqual({ ok: true });
    answer = { ok: false, reason: 'failed', message: 'disk full' };
    await expect(main.request('catalog.rename', { sessionId: 's', name: 'n' })).rejects.toThrow(CoreProtocolError);
    expect(violations).toHaveLength(1);
  });

  it('reaches main as LocalizedText in a commit\'s failure, and a string there is a violation', async () => {
    const violations: CoreProtocolError[] = [];
    const { main, core } = pair((error) => violations.push(error));
    const request = { repoId: 'r', message: 'm', variant: {}, saved: [] };
    const refusal = { ok: false, reason: 'failed', error: { message: 'Invalid branch name' } };
    let answer: unknown = refusal;
    core.serve('scm.commit', () => answer as never);
    expect(await main.request('scm.commit', request)).toEqual(refusal);
    answer = { ok: false, reason: 'nothingToCommit' };
    expect(await main.request('scm.commit', request)).toEqual({ ok: false, reason: 'nothingToCommit' });
    answer = { ok: true };
    expect(await main.request('scm.commit', request)).toEqual({ ok: true });
    answer = { ok: false, reason: 'failed', error: 'Invalid branch name' };
    await expect(main.request('scm.commit', request)).rejects.toThrow(CoreProtocolError);
    answer = { ok: false, reason: 'failed' };
    await expect(main.request('scm.commit', request)).rejects.toThrow(CoreProtocolError);
    answer = { ok: false, reason: 'exploded' };
    await expect(main.request('scm.commit', request)).rejects.toThrow(CoreProtocolError);
    expect(violations).toHaveLength(3);
  });
});

describe('the scm namespace', () => {
  it('refuses a method outside SCM_CALLS', () => {
    const { transports } = pair();
    expect(() => transports.main.post({ kind: 'request', id: 1, method: 'scm.call', params: { method: 'dispose', args: [] } })).toThrow(CoreProtocolError);
  });

  it('takes a repository\'s flags field by field, a remote operation only by its name', () => {
    const { transports } = pair();
    const flags = { kind: 'repositoryState', repoId: 'r', busy: true, running: 'push', lastRemote: { op: 'fetch', outcome: 'cancelled', stashKept: false, seq: 1 } };
    transports.core.post({ kind: 'mirror', topic: 'scm', version: 1, patch: flags });
    expect(() => transports.core.post({ kind: 'mirror', topic: 'scm', version: 2, patch: { ...flags, running: 'clone' } })).toThrow(CoreProtocolError);
    expect(() => transports.core.post({ kind: 'mirror', topic: 'scm', version: 2, patch: { ...flags, busy: 'yes' } })).toThrow(CoreProtocolError);
  });
});

describe('a message name', () => {
  it('is a violation when it names an inherited property or holds a character that could forge a log line', () => {
    const { transports } = pair();
    expect(() => transports.main.post({ kind: 'event', name: 'constructor', payload: {} })).toThrow(CoreProtocolError);
    expect(() => transports.main.post({ kind: 'mirror', topic: 'toString', version: 1, patch: {} })).toThrow(CoreProtocolError);
    expect(() => transports.main.post({ kind: 'panel', panelId: 'p', op: 'hasOwnProperty', payload: {} })).toThrow(CoreProtocolError);
    expect(() => transports.main.post({ kind: 'event', name: 'secrets.changed\n[core] forged', payload: { key: 'k' } })).toThrow(/malformed envelope/);
  });
});
