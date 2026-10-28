import { getEventListeners } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createFakePlatform } from '../../../__mocks__/fake-platform';
import { createFakeRemoteHost } from '../../../__mocks__/fake-remote-host';
import { CREDENTIAL_CLIENT_ABSENT, type BrokerAnswer, type HeldAuth } from '../../../shared/remote-user';
import type { ExtensionToWebviewMessage } from '../../../shared/types/messages';
import { runPinnedSubcall, runPinnedTurn } from '../../client-snapshots';
import { PermissionHandler } from '../../permission-handler';
import { BrokeredCredentialStore, MIN_VALIDITY_MS } from '../credential-broker';

const HOUR = 60 * 60 * 1000;
const signedIn: HeldAuth = { providers: { anthropic: { type: 'oauth', expires: Date.now() + HOUR, hasKey: false, flatFee: false }, xai: { type: 'none', hasKey: false, flatFee: false } } };
const oauth = (access: string, expiresIn = HOUR): BrokerAnswer & { type: 'oauth' } => ({ type: 'oauth', access, expiresIn, refresh: '' });

const handlers: PermissionHandler[] = [];
afterEach(async () => {
  for (const handler of handlers.splice(0)) await handler.dispose();
});

// A daemon's core with two devices; each answers on its live connection, and a device with none is absent.
function setUp() {
  let now = 1_000_000;
  const live = new Map<string, string>();
  const host = createFakeRemoteHost(async (_provider, clientId) => {
    const connection = live.get(clientId);
    if (connection === undefined) throw new Error(CREDENTIAL_CLIENT_ABSENT);
    return oauth(`${connection}-token`, MIN_VALIDITY_MS + 60_000);
  });
  const broker = new BrokeredCredentialStore({ remote: host.remote, credentialsChanged: vi.fn(), now: () => now });
  const handler = new PermissionHandler({ ...createFakePlatform(), remote: host.remote });
  handlers.push(handler);
  const posted: ExtensionToWebviewMessage[] = [];
  handler.setPostMessage((message) => posted.push(message));
  const signIn = { raise: handler.raiseSignIn.bind(handler) };
  const attach = (clientId: string, connection: string): void => {
    live.set(clientId, connection);
    host.set('clientAuth', clientId, signedIn);
  };
  const detach = (clientId: string): void => {
    live.delete(clientId);
    host.set('clientAuth', clientId, undefined);
  };
  attach('client-a', 'a1');
  attach('client-b', 'b1');
  host.setActing('client-a');
  // a turn of device a that read anthropic once, then reads it again whenever next() is called
  const turn = (signal?: AbortSignal) => {
    const reads: unknown[] = [];
    let release!: () => void;
    const gate = () => new Promise<void>((resolve) => { release = resolve; });
    let waiting = gate();
    const done = runPinnedTurn(host.remote, 'panel-1', async () => {
      reads.push(await broker.read('anthropic', signal ? { signal } : undefined));
      for (;;) {
        await waiting;
        waiting = gate();
        const credential = await broker.read('anthropic', signal ? { signal } : undefined);
        reads.push(credential);
        if (credential === undefined) return;
      }
    }, signIn);
    return { reads, done, next: () => release() };
  };
  const requests = () => posted.filter((m): m is Extract<ExtensionToWebviewMessage, { type: 'signInRequest' }> => m.type === 'signInRequest');
  const resolvedIds = () => posted.flatMap((m) => (m.type === 'signInResolved' ? [m.requestId] : []));
  return { host, broker, handler, posted, attach, detach, turn, requests, resolvedIds, advance: (ms: number) => { now += ms; } };
}

// device a goes away and its cached token passes pi's minimum validity, so the turn's next read must ask
async function waitingTurn(signal?: AbortSignal) {
  const t = setUp();
  const run = t.turn(signal);
  await vi.waitFor(() => expect(run.reads).toHaveLength(1));
  t.detach('client-a');
  t.advance(61_000);
  run.next();
  await vi.waitFor(() => expect(t.requests()).toHaveLength(1));
  return { ...t, run };
}

describe('Sign-in needed', () => {
  it('a turn whose device is away waits on its chat\'s PermissionState with kind signIn, and resumes without a click when that device attaches again', async () => {
    const t = await waitingTurn();
    const [request] = t.requests();
    expect(request).toMatchObject({ provider: 'anthropic' });
    expect(t.handler.pendingPrompts()).toEqual([{ id: request!.requestId, kind: 'signIn', request }]);
    expect(t.run.reads).toHaveLength(1);
    t.attach('client-a', 'a2');
    await vi.waitFor(() => expect(t.run.reads).toHaveLength(2));
    expect(t.run.reads[1]).toMatchObject({ access: 'a2-token' });
    expect(t.resolvedIds()).toEqual([request!.requestId]);
    expect(t.handler.pendingPrompts()).toEqual([]);
  });

  it('a push from the turn\'s own device resolves the wait; a push from another device lands only in that device\'s entry and resolves nothing', async () => {
    const t = await waitingTurn();
    t.broker.push('client-b', 'anthropic', oauth('pushed-by-b'));
    await Promise.resolve();
    expect(t.run.reads).toHaveLength(1);
    expect(t.handler.pendingPrompts()).toHaveLength(1);
    t.broker.push('client-a', 'anthropic', oauth('pushed-by-a'));
    await vi.waitFor(() => expect(t.run.reads).toHaveLength(2));
    expect(t.run.reads[1]).toMatchObject({ access: 'pushed-by-a' });
    expect(t.handler.pendingPrompts()).toEqual([]);
    t.host.setActing('client-b');
    expect(await runPinnedTurn(t.host.remote, 'panel-2', () => t.broker.read('anthropic'))).toMatchObject({ access: 'pushed-by-b' });
  });

  it('Stop aborts the wait and takes the prompt down', async () => {
    const stop = new AbortController();
    const t = await waitingTurn(stop.signal);
    stop.abort(new Error('stopped'));
    await expect(t.run.done).rejects.toThrow('stopped');
    expect(t.handler.pendingPrompts()).toEqual([]);
    expect(t.resolvedIds()).toEqual([t.requests()[0]!.requestId]);
  });

  it('a wait the chat closes on fails with the credential cause instead of waiting forever', async () => {
    const t = await waitingTurn();
    await t.handler.dispose();
    await expect(t.run.done).rejects.toMatchObject({ cause: 'credential' });
  });

  it('a structured sub-call fails at once with the credential cause and raises no prompt', async () => {
    const t = setUp();
    t.detach('client-a');
    await expect(runPinnedSubcall(t.host.remote, () => t.broker.read('anthropic'))).rejects.toMatchObject({ cause: 'credential' });
    expect(t.requests()).toEqual([]);
  });

  it('a provider the away device holds no credential for answers none at once, so pi uses the target\'s own', async () => {
    const t = setUp();
    t.detach('client-a');
    const signIn = { raise: vi.fn(() => ({ dispose: vi.fn() })) };
    expect(await runPinnedTurn(t.host.remote, 'panel-1', () => t.broker.read('xai'), signIn)).toBeUndefined();
    expect(signIn.raise).not.toHaveBeenCalled();
  });
});

describe('Continue with my sign-in', () => {
  it('only an explicit click from an attached device moves the waiting turn, and then the turn and its token cache are that device\'s', async () => {
    const t = await waitingTurn();
    const requestId = t.requests()[0]!.requestId;
    // a click that names no device, or a device that is not attached, moves nothing
    t.handler.continueWithSignIn(requestId);
    t.host.setActor('client-c');
    t.handler.continueWithSignIn(requestId);
    await Promise.resolve();
    expect(t.run.reads).toHaveLength(1);
    expect(t.host.remote.credentials).not.toHaveBeenCalledWith('anthropic', 'client-c');
    t.host.setActor('client-b');
    t.handler.continueWithSignIn(requestId);
    await vi.waitFor(() => expect(t.run.reads).toHaveLength(2));
    expect(t.run.reads[1]).toMatchObject({ access: 'b1-token' });
    expect(t.resolvedIds()).toEqual([requestId]);
    // device a coming back no longer serves the moved turn
    const askedA = () => vi.mocked(t.host.remote.credentials).mock.calls.filter(([, clientId]) => clientId === 'client-a').length;
    const before = askedA();
    t.attach('client-a', 'a2');
    t.advance(61_000);
    t.run.next();
    await vi.waitFor(() => expect(t.run.reads).toHaveLength(3));
    expect(t.run.reads[2]).toMatchObject({ access: 'b1-token' });
    expect(askedA()).toBe(before);
    expect(vi.mocked(t.host.remote.credentials).mock.calls.at(-1)).toEqual(['anthropic', 'client-b']);
  });

  it('a click on a prompt that is no longer open moves nothing', async () => {
    const t = await waitingTurn();
    const requestId = t.requests()[0]!.requestId;
    t.attach('client-a', 'a2');
    await vi.waitFor(() => expect(t.run.reads).toHaveLength(2));
    t.host.setActor('client-b');
    t.handler.continueWithSignIn(requestId);
    t.advance(61_000);
    t.run.next();
    await vi.waitFor(() => expect(t.run.reads).toHaveLength(3));
    expect(t.run.reads[2]).toMatchObject({ access: 'a2-token' });
  });
});

describe('a wait whose device comes back', () => {
  it('asks the device afresh once it attached again, never through an ask made while it was away', async () => {
    // every ask stays open until the test answers it
    const asks: Array<{ readonly clientId: string; readonly resolve: (answer: BrokerAnswer) => void; readonly reject: (err: Error) => void }> = [];
    const host = createFakeRemoteHost((_provider, clientId) => new Promise<BrokerAnswer>((resolve, reject) => asks.push({ clientId, resolve, reject })));
    const broker = new BrokeredCredentialStore({ remote: host.remote, credentialsChanged: vi.fn() });
    host.set('clientAuth', 'client-a', signedIn);
    host.setActing('client-a');
    const raised: string[] = [];
    const signIn = { raise: (provider: string) => { raised.push(provider); return { dispose: vi.fn() }; } };
    // device a is away: turn 1's ask answers absent and the turn waits
    host.set('clientAuth', 'client-a', undefined);
    const first = runPinnedTurn(host.remote, 'panel-1', () => broker.read('anthropic'), signIn);
    await vi.waitFor(() => expect(asks).toHaveLength(1));
    asks[0]!.reject(new Error(CREDENTIAL_CLIENT_ABSENT));
    await vi.waitFor(() => expect(raised).toEqual(['anthropic']));
    // turn 2 asks while the device is still away, and that ask is still out when it attaches again
    const second = runPinnedTurn(host.remote, 'panel-2', () => broker.read('anthropic'), signIn);
    await vi.waitFor(() => expect(asks).toHaveLength(2));
    host.set('clientAuth', 'client-a', signedIn);
    await vi.waitFor(() => expect(asks).toHaveLength(3));
    asks[1]!.reject(new Error(CREDENTIAL_CLIENT_ABSENT));
    asks[2]!.resolve(oauth('a-again'));
    expect(await first).toMatchObject({ access: 'a-again' });
    expect(await second).toMatchObject({ access: 'a-again' });
  });

  it('leaves no listener on the run\'s signal once its wait ended', async () => {
    const stop = new AbortController();
    const before = getEventListeners(stop.signal, 'abort').length;
    const t = await waitingTurn(stop.signal);
    t.attach('client-a', 'a2');
    await vi.waitFor(() => expect(t.run.reads).toHaveLength(2));
    expect(getEventListeners(stop.signal, 'abort')).toHaveLength(before);
  });

  it('keeps no token a detached device pushed while no turn is pinned to it', async () => {
    // a device no other test's turn is pinned to
    const t = setUp();
    t.attach('client-p', 'p1');
    t.detach('client-p');
    t.broker.push('client-p', 'anthropic', oauth('pushed-while-away'));
    t.attach('client-p', 'p2');
    t.host.setActing('client-p');
    expect(await runPinnedTurn(t.host.remote, 'panel-2', () => t.broker.read('anthropic'))).toMatchObject({ access: 'p2-token' });
  });
});
