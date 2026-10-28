import { PassThrough, type Duplex } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import type { SshPrompt, SshPromptAnswer } from '../../../preload/overlay-channels';
import { failureOf, hostConnection, RemoteConnections, type SshStartRequest, type SshStarted } from '../connections';
import type { SshHostRecord } from '../host-store';

const HOST: SshHostRecord = { id: 'h1', kind: 'ssh', destination: { kind: 'alias', alias: 'prod-1' }, name: 'prod-1', recentFolders: [], settings: {} };

// The transport's error: a code from the failure list, its params and ssh's stderr tail, as SshConnectError carries them.
class TransportError extends Error {
  readonly code: string;
  readonly params: Record<string, string | number>;
  readonly stderrTail: string;

  constructor(code: string, params: Record<string, string | number>, stderrTail: string) {
    super(code);
    this.code = code;
    this.params = params;
    this.stderrTail = stderrTail;
  }
}

// A transport that behaves like startSshTransport: it reports steps, asks through the hooks, rejects cancelled once the
// signal aborts, and resolves a stream whose close ends ssh.
function harness(script: (request: SshStartRequest) => Promise<SshStarted>, handshake: (stream: Duplex) => Promise<void> = async () => undefined) {
  const changed = vi.fn();
  let held: 'usable' | 'suspect' | undefined;
  let authorityConnect: Promise<void> | undefined;
  const connections: RemoteConnections = new RemoteConnections({
    host: (id) => (id === HOST.id ? HOST : undefined),
    startSsh: script,
    savePlatform: vi.fn(async () => undefined),
    installFolderSettled: vi.fn(async () => undefined),
    // Authorities.connect: the transport, then the handshake, which this stand-in completes at once unless given one
    connect: (hostId) => {
      authorityConnect = connections.transport(hostId).then(handshake);
      return authorityConnect;
    },
    connection: () => held,
    changed,
    log: () => undefined,
  });
  return {
    connections,
    changed,
    settled: () => authorityConnect?.catch(() => undefined),
    setConnected: (value: boolean) => { held = value ? 'usable' : undefined; },
    setHeld: (value: 'usable' | 'suspect' | undefined) => { held = value; },
  };
}

const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

function started(): SshStarted & { stream: PassThrough; disposed: ReturnType<typeof vi.fn> } {
  const stream = new PassThrough();
  const disposed = vi.fn();
  return { stream, stderrTail: () => 'debug1: tail', dispose: disposed, disposed };
}

describe('RemoteConnections', () => {
  it('reports each step and the progress, then connected', async () => {
    const bridge = started();
    const { connections } = harness(async ({ hooks }) => {
      hooks.step('authenticating');
      hooks.step('checking');
      hooks.step('installing');
      hooks.progress(0.5);
      hooks.notice({ code: 'noLinger', params: { user: 'deploy' } });
      // the probe's low limit waits for the watcher to run out for a project
      hooks.notice({ code: 'lowInotify', params: { limit: 8192, suggested: 524288 } });
      hooks.step('starting');
      return bridge;
    });
    const attemptId = connections.connect('h1', true);
    await flush();
    const attempt = connections.attempt('h1')!;
    expect(attempt).toMatchObject({ attemptId, hostId: 'h1', step: 'connected', visited: ['connecting', 'authenticating', 'checking', 'installing', 'starting'], notices: [{ code: 'noLinger', params: { user: 'deploy' } }] });
    expect(attempt.progress).toBeUndefined();
    expect(connections.notices('h1')).toEqual([{ code: 'noLinger', params: { user: 'deploy' } }]);
  });

  it('shares one attempt per host between callers', async () => {
    let starts = 0;
    let release!: (value: SshStarted) => void;
    const { connections } = harness(() => {
      starts += 1;
      return new Promise((resolve) => (release = resolve));
    });
    const first = connections.connect('h1', false);
    const second = connections.connect('h1', true);
    expect(second).toBe(first);
    await flush();
    release(started());
    await flush();
    expect(starts).toBe(1);
  });

  it('relays a prompt with its id, takes the answer, and holds an unwatched one behind the sign-in banner', async () => {
    const answers: Array<SshPromptAnswer | undefined> = [];
    const prompt: SshPrompt = { kind: 'hostKey', host: 'prod-1', keyType: 'ED25519', fingerprint: 'SHA256:abc' };
    const { connections } = harness(async ({ hooks }) => {
      answers.push(await hooks.prompt(prompt, new AbortController().signal));
      return started();
    });
    connections.connect('h1', false);
    await flush();
    const waiting = connections.attempt('h1')!;
    expect(waiting.prompt).toMatchObject({ kind: 'hostKey', fingerprint: 'SHA256:abc' });
    expect(connections.signInNeeded('h1')).toBe(true);
    // the banner's Sign in opens the dialog on it
    connections.watch('h1', true);
    expect(connections.signInNeeded('h1')).toBe(false);
    // an answer to another prompt is ignored, and a host key takes only connect or cancel
    connections.answer(waiting.attemptId, 'other', 'connect', false);
    expect(() => connections.answer(waiting.attemptId, waiting.prompt!.promptId, 'yes', false)).toThrow();
    // a prompt that offers no Remember on this computer refuses remember
    expect(() => connections.answer(waiting.attemptId, waiting.prompt!.promptId, 'connect', true)).toThrow('Remember');
    connections.answer(waiting.attemptId, waiting.prompt!.promptId, 'connect', false);
    await flush();
    expect(answers).toEqual([{ answer: 'connect', remember: false }]);
    expect(connections.attempt('h1')).toMatchObject({ step: 'connected' });
  });

  it('shows a removal stage\'s question as the host\'s prompt while it runs, refuses a connect meanwhile, and restores the attempt after', async () => {
    const { connections } = harness(async () => started());
    connections.connect('h1', true);
    await flush();
    const before = connections.attempt('h1');
    let answered: SshPromptAnswer | undefined;
    const stage = connections.withPrompts('h1', async (prompt, signal) => {
      answered = await prompt({ kind: 'secret', secretKind: 'password', text: "me@prod-1's password:" }, signal);
      return 'done';
    });
    await flush();
    const waiting = connections.attempt('h1')!;
    expect(waiting).toMatchObject({ step: 'authenticating', prompt: { kind: 'secret', secretKind: 'password' } });
    expect(() => connections.connect('h1', true)).toThrow('ssh call');
    connections.answer(waiting.attemptId, waiting.prompt!.promptId, 'secret', false);
    await expect(stage).resolves.toBe('done');
    expect(answered).toEqual({ answer: 'secret', remember: false });
    expect(connections.attempt('h1')).toEqual(before);
  });

  it('withdraws a prompt ssh stopped asking', async () => {
    const withdraw = new AbortController();
    const { connections } = harness(async ({ hooks }) => {
      const answer = hooks.prompt({ kind: 'secret', secretKind: 'password', text: 'Password:' }, withdraw.signal);
      withdraw.abort();
      expect(await answer).toBeUndefined();
      throw new TransportError('cancelled', {}, '');
    });
    connections.connect('h1', true);
    await flush();
    expect(connections.attempt('h1')?.prompt).toBeUndefined();
  });

  it('cancels through the signal, which kills ssh, and leaves the host offline rather than failed', async () => {
    let sshSignal: AbortSignal | undefined;
    const { connections, settled } = harness(({ signal, hooks }) => new Promise((_resolve, reject) => {
      sshSignal = signal;
      void hooks.prompt({ kind: 'secret', secretKind: 'passphrase', text: 'Enter passphrase' }, signal);
      signal.addEventListener('abort', () => reject(new TransportError('cancelled', {}, 'killed')));
    }));
    const attemptId = connections.connect('h1', true);
    await flush();
    connections.cancel(attemptId);
    // startSshTransport kills ssh on this signal
    expect(sshSignal?.aborted).toBe(true);
    await settled();
    await flush();
    const failure = connections.failure('h1');
    expect(failure).toEqual({ code: 'cancelled', params: {} });
    expect(hostConnection('failed', failure)).toBe('offline');
    expect(connections.stderrTail('h1')).toBe('killed');
  });

  it('cancels a transport that resolved after the cancel, ending its ssh, as offline', async () => {
    const bridge = started();
    let release!: () => void;
    const { connections, settled } = harness(() => new Promise((resolve) => {
      release = () => resolve(bridge);
    }));
    const attemptId = connections.connect('h1', true);
    await flush();
    // the transport resolves in the same turn as the cancel, before Authorities' continuation runs
    release();
    connections.cancel(attemptId);
    await settled();
    await flush();
    expect(connections.failure('h1')).toEqual({ code: 'cancelled', params: {} });
    expect(bridge.stream.destroyed).toBe(true);
    expect(bridge.disposed).toHaveBeenCalled();
  });

  it('keeps the transport\'s failure code and params, and the stderr tail for Show log', async () => {
    const { connections, settled } = harness(async () => {
      throw new TransportError('glibcTooOld', { found: '2.17', needed: '2.28' }, 'probe: glibc 2.17');
    });
    connections.connect('h1', true);
    await settled();
    await flush();
    expect(connections.attempt('h1')).toMatchObject({ step: 'failed', failure: { code: 'glibcTooOld', params: { found: '2.17', needed: '2.28' } } });
    expect(hostConnection('failed', connections.failure('h1'))).toBe('failed');
    expect(connections.stderrTail('h1')).toBe('probe: glibc 2.17');
    expect(failureOf(new Error('refused protocol 1'))).toEqual({ code: 'handshakeFailed', params: { reason: 'refused protocol 1' } });
  });

  it('ends ssh when the bridge\'s stream closes, and keeps its last stderr', async () => {
    const bridge = started();
    const { connections } = harness(async () => bridge);
    connections.connect('h1', true);
    await flush();
    bridge.stream.destroy();
    await flush();
    expect(bridge.disposed).toHaveBeenCalled();
    expect(connections.stderrTail('h1')).toBe('debug1: tail');
  });

  it('refuses a host the store does not hold, and a transport with no attempt waiting', async () => {
    const { connections } = harness(async () => started());
    expect(() => connections.connect('nope', true)).toThrow();
    await expect(connections.transport('h1')).rejects.toThrow();
  });
});

describe('RemoteConnections joining a live connection', () => {
  it('joins the connected attempt while the connection is up, and starts a new one once it dropped', async () => {
    let starts = 0;
    const { connections, setConnected } = harness(async () => {
      starts += 1;
      return started();
    });
    const first = connections.connect('h1', false);
    await flush();
    setConnected(true);
    expect(connections.connect('h1', false)).toBe(first);
    expect(starts).toBe(1);
    setConnected(false);
    expect(connections.connect('h1', false)).not.toBe(first);
    await flush();
    expect(starts).toBe(2);
  });
});

describe('RemoteConnections with a suspect connection', () => {
  it('joins it, since only the keepalive timeout decides a drop, unless the caller forces a reconnect', async () => {
    let starts = 0;
    const { connections, setHeld } = harness(async () => {
      starts += 1;
      return started();
    });
    const first = connections.connect('h1', false);
    await flush();
    setHeld('suspect');
    expect(connections.connect('h1', false)).toBe(first);
    expect(connections.connect('h1', true)).toBe(first);
    expect(starts).toBe(1);
    expect(connections.connect('h1', false, { force: true })).not.toBe(first);
    await flush();
    expect(starts).toBe(2);
  });
});

describe('RemoteConnections ended by the user', () => {
  it('reports cancelled once its signal aborted, whatever the handshake threw on the way out', async () => {
    const bridge = started();
    let failHandshake!: (err: Error) => void;
    const { connections, settled } = harness(async () => bridge, () => new Promise((_resolve, reject) => (failHandshake = reject)));
    const attemptId = connections.connect('h1', true);
    await flush();
    const outcome = connections.outcome(attemptId)!;
    connections.cancel(attemptId);
    // the cancel destroyed the stream under the resume's hello
    failHandshake(new Error('The connection closed: the transport closed'));
    await settled();
    await expect(outcome).rejects.toMatchObject({ code: 'cancelled' });
    expect(connections.failure('h1')).toEqual({ code: 'cancelled', params: {} });
    expect(hostConnection('failed', connections.failure('h1'))).toBe('offline');
  });

  it('cancelHost ends a connect attempt, as Disconnect Host does, and leaves a removal stage alone', async () => {
    let sshSignal: AbortSignal | undefined;
    const { connections, settled } = harness(({ signal }) => {
      sshSignal = signal;
      return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new TransportError('cancelled', {}, ''))));
    });
    connections.connect('h1', false);
    await flush();
    connections.cancelHost('h1');
    expect(sshSignal?.aborted).toBe(true);
    await settled();
    await flush();
    let stageSignal: AbortSignal | undefined;
    void connections.withPrompts('h1', async (_prompt, signal) => {
      stageSignal = signal;
      return new Promise(() => undefined);
    });
    connections.cancelHost('h1');
    expect(stageSignal?.aborted).toBe(false);
  });

  // a fresh reconnect (a Forward SSH agent change) must not join the attempt it just cancelled, or the loop stops with it
  it('cancelHost settles only once the cancelled attempt did, so a loop attempt after it starts afresh', async () => {
    let starts = 0;
    const { connections } = harness(({ signal }) => {
      starts++;
      // ssh takes a moment to exit after the abort
      return new Promise((_resolve, reject) => signal.addEventListener('abort', () => setTimeout(() => reject(new TransportError('cancelled', {}, '')), 20)));
    });
    connections.connect('h1', false);
    await flush();
    await connections.cancelHost('h1');
    const attempt = connections.loopAttempt('h1', new AbortController().signal, true);
    expect(attempt.joined).toBe(false);
    await flush();
    expect(starts).toBe(2);
  });

  it('forget ends the host\'s attempt and keeps nothing of it', async () => {
    let sshSignal: AbortSignal | undefined;
    const { connections, changed } = harness(({ signal, hooks }) => {
      sshSignal = signal;
      hooks.notice({ code: 'noLinger', params: { user: 'deploy' } });
      return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new TransportError('cancelled', {}, 'killed'))));
    });
    connections.connect('h1', false);
    await flush();
    expect(connections.notices('h1')).toHaveLength(1);
    connections.forget('h1');
    expect(sshSignal?.aborted).toBe(true);
    changed.mockClear();
    await flush();
    expect(connections.attempt('h1')).toBeUndefined();
    expect(connections.notices('h1')).toEqual([]);
    expect(connections.stderrTail('h1')).toBe('');
    // the cancelled attempt settles without reporting for the forgotten host
    expect(changed).not.toHaveBeenCalled();
  });
});

describe('RemoteConnections and the reconnect loop', () => {
  it('joins an attempt the loop did not start, which the loop\'s signal never cancels', async () => {
    let sshSignal: AbortSignal | undefined;
    let release!: (value: SshStarted) => void;
    const { connections } = harness(({ signal }) => {
      sshSignal = signal;
      return new Promise((resolve) => (release = resolve));
    });
    const watchedId = connections.connect('h1', true);
    await flush();
    const loop = new AbortController();
    const attempt = connections.loopAttempt('h1', loop.signal, false);
    expect(attempt.joined).toBe(true);
    loop.abort();
    expect(sshSignal?.aborted).toBe(false);
    release(started());
    await expect(attempt.outcome).resolves.toBeUndefined();
    expect(connections.attempt('h1')).toMatchObject({ attemptId: watchedId, step: 'connected' });
  });

  it('starts its own attempt unwatched, which its signal cancels until it settles', async () => {
    const signals: AbortSignal[] = [];
    const { connections } = harness(({ signal }) => {
      signals.push(signal);
      return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new TransportError('cancelled', {}, ''))));
    });
    const loop = new AbortController();
    const attempt = connections.loopAttempt('h1', loop.signal, false);
    expect(attempt.joined).toBe(false);
    await flush();
    expect(connections.isWatched('h1')).toBe(false);
    loop.abort();
    expect(signals[0]!.aborted).toBe(true);
    await expect(attempt.outcome).rejects.toMatchObject({ code: 'cancelled' });

    const removed = vi.spyOn(AbortSignal.prototype, 'removeEventListener');
    const next = new AbortController();
    const second = connections.loopAttempt('h1', next.signal, false);
    await flush();
    connections.cancel(connections.attempt('h1')!.attemptId);
    await second.outcome.catch(() => undefined);
    expect(removed.mock.contexts).toContain(next.signal);
    removed.mockRestore();
  });

  it('tells the loop when a user watches the attempt and when stage 1 runs on the target', async () => {
    let report!: SshStartRequest['hooks'];
    const { connections } = harness(({ hooks }) => {
      report = hooks;
      return new Promise(() => undefined);
    });
    connections.connect('h1', false);
    await flush();
    report.step('authenticating');
    expect(connections.staging('h1')).toBe(false);
    report.step('checking');
    expect(connections.staging('h1')).toBe(true);
    report.step('installing');
    report.progress(0.4);
    expect(connections.staging('h1')).toBe(true);
    expect(connections.isWatched('h1')).toBe(false);
    connections.watch('h1', true);
    expect(connections.isWatched('h1')).toBe(true);
  });
});

describe('the changed host key command', () => {
  it('puts one quoted command in the failure the dialog shows and copies', () => {
    expect(failureOf(new TransportError('hostKeyChanged', { host: '[127.0.0.1]:59225' }, ''))).toEqual({ code: 'hostKeyChanged', params: { host: '[127.0.0.1]:59225', command: 'ssh-keygen -R "[127.0.0.1]:59225"' } });
    expect(failureOf(new TransportError('hostKeyChanged', { host: 'prod-1.example.com' }, '')).params['command']).toBe('ssh-keygen -R prod-1.example.com');
    expect(failureOf(new TransportError('hostKeyChanged', {}, ''))).toEqual({ code: 'hostKeyChanged', params: {} });
  });
});
