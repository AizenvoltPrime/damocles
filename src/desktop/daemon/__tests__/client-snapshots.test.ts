import { afterEach, describe, expect, it, vi } from 'vitest';
import { createFakeRemoteHost } from '../../../__mocks__/fake-remote-host';
import type { PanelHost } from '../../../platform/window-service';
import { bypassAllowed, currentPin, runPinnedTurn } from '../../../core/client-snapshots';
import { allowanceProvider, clientClaudeAuthStatus } from '../../../core/pi-session/allowance-transport';
import { BrokeredCredentialStore, MIN_VALIDITY_MS } from '../../../core/pi-session/credential-broker';
import { CREDENTIAL_CLIENT_ABSENT, type ClientAuth, type ClientPolicy, type ClientUser } from '../../../shared/remote-user';
import { createCoreEndpoint, createLoopback, createMainEndpoint, type MainEndpoint } from '../../core-protocol';
import { parseClientValues, type CoreInit } from '../../core-protocol/messages';
import { createClientSnapshots, createRemoteHost } from '../../core-host/platform/clients';
import { createClientMirrors, createCoreRouter, type CoreRouter } from '../core-routes';
import type { DaemonState } from '../daemon-state';
import { createRunRegistry } from '../run-registry';

const quiet = (): void => undefined;
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

const state: DaemonState = { snapshot: () => ({}), update: async () => undefined, applyClient: () => false, flush: async () => undefined };

const values = (name: string, allowBypass = false): { clientAuth: ClientAuth; clientUser: ClientUser; clientPolicy: ClientPolicy } => ({
  clientAuth: { providers: { anthropic: { type: 'oauth', expiresIn: 1, hasKey: false, flatFee: false } } },
  clientUser: { settings: { 'damocles.model': `model-of-${name}` }, permissionRules: [{ allow: [], ask: [], deny: [`Bash(rm ${name})`], dir: '.damocles' }] },
  clientPolicy: { voice: true, allowBypass },
});

let router: CoreRouter | undefined;

function setUp() {
  const coreLoop = createLoopback();
  const daemonMain = createMainEndpoint(coreLoop.main, quiet);
  const core = createCoreEndpoint(coreLoop.core, quiet);
  router = createCoreRouter({ core: daemonMain, state, registry: createRunRegistry(), mirrors: createClientMirrors(), secrets: new Map(), e2eHooks: false, reload: vi.fn(), log: quiet });
  const snapshots = createClientSnapshots(core, { mirrors: { clientAuth: {}, clientUser: {}, clientPolicy: {}, actingClient: {} } } as unknown as CoreInit);
  const remote = createRemoteHost(core, { remote: { hostId: 'h' } } as CoreInit & { remote: { hostId: string } }, snapshots, () => undefined);
  const attach = (id: string, mirrors: ReturnType<typeof values>): { main: MainEndpoint; detach(): void } => {
    const loop = createLoopback();
    const main = createMainEndpoint(loop.main, quiet, (error) => { throw error; });
    const attached = router!.attach({
      id,
      clientId: id,
      hostId: 'h1',
      transport: loop.core,
      mirrors: { state: { global: {}, workspace: {} }, trust: { keys: [] }, folders: { folders: [] }, editor: {}, terminal: { shown: false, shortcut: '' }, language: { language: 'en' }, ...mirrors },
      close: vi.fn(),
      drained: () => Promise.resolve(), lost: () => false, onLostChange: () => ({ dispose: () => undefined }),
    });
    return { main, detach: () => attached.dispose() };
  };
  return { core, snapshots, remote, attach };
}

afterEach(() => {
  router?.dispose();
  router = undefined;
});

describe('client snapshots on a daemon\'s core', () => {
  it('are keyed by client id, follow the client that acted last, and leave with their client', async () => {
    const { snapshots, attach } = setUp();
    const a = attach('connection-1', values('a'));
    attach('connection-2', values('b'));
    await flush();
    expect(snapshots.user('connection-1')?.settings).toEqual({ 'damocles.model': 'model-of-a' });
    expect(snapshots.user('connection-2')?.settings).toEqual({ 'damocles.model': 'model-of-b' });
    expect(snapshots.acting()).toBe('connection-2');
    a.main.publish('clientPolicy', { value: { voice: false, allowBypass: false } });
    await flush();
    expect(snapshots.acting()).toBe('connection-1');
    expect(snapshots.policy('connection-1')).toEqual({ voice: false, allowBypass: false });
    a.detach();
    await flush();
    expect(snapshots.user('connection-1')).toBeUndefined();
    expect(snapshots.policy('connection-1')).toBeUndefined();
    expect(snapshots.acting()).toBe('connection-2');
  });

  it('keep a detached client\'s last clientAuth, so its running turn and the turns of its reattach bill the allowance it chose', async () => {
    const { snapshots, remote, attach } = setUp();
    const allowance: ClientAuth = { providers: { anthropic: { type: 'oauth', expiresIn: 3_600_000, hasKey: false, flatFee: false, allowance: true } } };
    const anthropic = allowanceProvider(remote, (() => 'extra usage') as never, (() => 'allowance') as never);
    const send = (): unknown => (anthropic.streamSimple as unknown as (...args: unknown[]) => unknown)({}, {}, {});
    const first = attach('connection-1', { ...values('a'), clientAuth: allowance });
    await flush();
    const running = await runPinnedTurn(remote, 'panel-1', async () => {
      const attached = send();
      first.detach();
      await flush();
      const detached = [send(), clientClaudeAuthStatus(remote, true).mode];
      // the app relaunched: its first attach may carry an empty clientAuth, which the delta read at launch then fills
      const second = attach('connection-2', { ...values('a'), clientAuth: { providers: {} } });
      second.main.publish('clientAuth', { value: allowance });
      await flush();
      return [attached, ...detached, send()];
    });
    expect(running).toEqual(['allowance', 'allowance', 'allowance', 'allowance']);
    expect(snapshots.acting()).toBe('connection-2');
    expect(await runPinnedTurn(remote, 'panel-1', async () => [send(), clientClaudeAuthStatus(remote, true).mode])).toEqual(['allowance', 'allowance']);
  });

  it('stamp the sending client\'s id, so a client cannot write another client\'s entry or name the acting client', async () => {
    const { snapshots, attach } = setUp();
    const a = attach('connection-1', values('a'));
    attach('connection-2', values('b'));
    await flush();
    a.main.publish('clientUser', { clientId: 'connection-2', value: { settings: { forged: true }, permissionRules: [] } });
    a.main.publish('actingClient', { clientId: 'connection-2' });
    await flush();
    expect(snapshots.user('connection-2')?.settings).toEqual({ 'damocles.model': 'model-of-b' });
    expect(snapshots.user('connection-1')?.settings).toEqual({ forged: true });
    expect(snapshots.acting()).toBe('connection-1');
  });

  it('pin a turn to the client acting when it starts, whoever acts later', async () => {
    const { snapshots, remote, attach } = setUp();
    const a = attach('connection-1', values('a'));
    const b = attach('connection-2', values('b', true));
    a.main.publish('clientPolicy', { value: values('a').clientPolicy });
    await flush();
    const pinned = await runPinnedTurn(remote, 'panel-1', async () => {
      b.main.publish('clientPolicy', { value: values('b', true).clientPolicy });
      await flush();
      expect(snapshots.acting()).toBe('connection-2');
      return { pin: currentPin(remote), bypass: bypassAllowed({ remote }) };
    });
    expect(pinned.pin.clientId).toBe('connection-1');
    expect(pinned.pin.user?.permissionRules).toEqual([{ allow: [], ask: [], deny: ['Bash(rm a)'], dir: '.damocles' }]);
    expect(pinned.bypass).toBe(false);
    expect(bypassAllowed({ remote })).toBe(true);
  });

  it('stamp each clientAuth expiresIn on this host\'s clock as it arrives, in the init and in each delta', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(5_000_000);
    const entry = (expiresIn: number) => ({ providers: { anthropic: { type: 'oauth' as const, expiresIn, hasKey: false, flatFee: false } } });
    const init = createClientSnapshots(createCoreEndpoint(createLoopback().core, quiet), { mirrors: { clientAuth: { 'connection-9': entry(1_000) }, clientUser: {}, clientPolicy: {}, actingClient: {} } } as unknown as CoreInit);
    expect(init.auth('connection-9')?.providers['anthropic']).toEqual({ type: 'oauth', expires: 5_001_000, hasKey: false, flatFee: false });
    const { snapshots, attach } = setUp();
    const a = attach('connection-1', values('a'));
    now.mockReturnValue(7_000_000);
    a.main.publish('clientAuth', { value: entry(60_000) });
    await flush();
    expect(snapshots.auth('connection-1')?.providers['anthropic']).toEqual({ type: 'oauth', expires: 7_060_000, hasKey: false, flatFee: false });
    now.mockRestore();
    init.dispose();
  });

  it('carry only the clientUser allowlist: no env, apiKeyHelper, hooks or tokens survive the wire', () => {
    const parsed = parseClientValues.clientUser({
      settings: { 'damocles.model': 'm' },
      permissionRules: [{ allow: ['Read'], ask: [], deny: [], dir: '.claude', hooks: { PreToolUse: [] } }],
      env: { ANTHROPIC_API_KEY: 'sk-ant' },
      apiKeyHelper: 'echo sk',
      hooks: { PreToolUse: [{ command: 'curl evil' }] },
      token: 'oauth-token',
    });
    expect(parsed).toEqual({ settings: { 'damocles.model': 'm' }, permissionRules: [{ allow: ['Read'], ask: [], deny: [], dir: '.claude' }] });
  });

  it('send the broker\'s ask only to the pinned client, and refuse with a coded reason when it is gone', async () => {
    const { core, attach } = setUp();
    const a = attach('connection-1', values('a'));
    const b = attach('connection-2', values('b'));
    const askedA = vi.fn(async () => ({ type: 'api_key' as const, key: 'key-a' }));
    const askedB = vi.fn(async () => ({ type: 'api_key' as const, key: 'key-b' }));
    a.main.serve('user.credentials', askedA);
    b.main.serve('user.credentials', askedB);
    await flush();
    expect(await core.request('user.credentials', { provider: 'openai', clientId: 'connection-1' })).toEqual({ type: 'api_key', key: 'key-a' });
    expect(askedB).not.toHaveBeenCalled();
    a.detach();
    await flush();
    await expect(core.request('user.credentials', { provider: 'openai', clientId: 'connection-1' })).rejects.toThrow(CREDENTIAL_CLIENT_ABSENT);
    expect(askedB).not.toHaveBeenCalled();
  });

  it('refuse to speak a reply of a chat no client shows, and so does the fake core tests use', async () => {
    const { remote } = setUp();
    const fake = createFakeRemoteHost();
    const host = {} as PanelHost;
    await expect(remote.speak(host, 'Done.')).rejects.toThrow('The chat that replied has no view');
    await expect(fake.remote.speak(host, 'Done.')).rejects.toThrow('The chat that replied has no view');
    fake.showView(host);
    await expect(fake.remote.speak(host, 'Done.')).resolves.toBeUndefined();
  });
});

describe('a pin names a device across its connections', () => {
  it('a turn pinned to a device whose connection closes gets its next credential from the device\'s new connection, and never from another device', async () => {
    const { remote } = setUp();
    let now = 1_000_000;
    const broker = new BrokeredCredentialStore({ remote, credentialsChanged: vi.fn(), now: () => now });
    const connect = (connection: string, device: string, name: string) => {
      const loop = createLoopback();
      const main = createMainEndpoint(loop.main, quiet, (error) => { throw error; });
      main.serve('user.credentials', async () => ({ type: 'oauth' as const, access: `token-${connection}`, expiresIn: MIN_VALIDITY_MS + 60_000, refresh: '' as const }));
      const attached = router!.attach({
        id: connection,
        clientId: device,
        hostId: 'h1',
        transport: loop.core,
        mirrors: { state: { global: {}, workspace: {} }, trust: { keys: [] }, folders: { folders: [] }, editor: {}, terminal: { shown: false, shortcut: '' }, language: { language: 'en' }, ...values(name) },
        close: vi.fn(),
        drained: () => Promise.resolve(), lost: () => false, onLostChange: () => ({ dispose: () => undefined }),
      });
      return { detach: () => attached.dispose() };
    };
    const first = connect('connection-1', 'device-a', 'a');
    await flush();
    const raised: string[] = [];
    const signIn = { raise: (provider: string) => { raised.push(provider); return { dispose: vi.fn() }; } };
    const reads: unknown[] = [];
    let next!: () => void;
    const turn = runPinnedTurn(remote, 'panel-1', async () => {
      reads.push(await broker.read('anthropic'));
      await new Promise<void>((resolve) => { next = resolve; });
      reads.push(await broker.read('anthropic'));
    }, signIn);
    await vi.waitFor(() => expect(reads).toHaveLength(1));
    first.detach();
    await flush();
    now += 61_000;
    next();
    await vi.waitFor(() => expect(raised).toEqual(['anthropic']));
    connect('connection-2', 'device-b', 'b');
    await flush();
    expect(reads).toHaveLength(1);
    connect('connection-3', 'device-a', 'a');
    await turn;
    expect(reads).toEqual([expect.objectContaining({ access: 'token-connection-1' }), expect.objectContaining({ access: 'token-connection-3' })]);
    broker.dispose();
  });

  it('a turn pinned to a device whose connection is lost waits behind Sign-in needed, and asks the same connection again once it resumed', async () => {
    const { remote } = setUp();
    let now = 1_000_000;
    const broker = new BrokeredCredentialStore({ remote, credentialsChanged: vi.fn(), now: () => now });
    const loop = createLoopback();
    const main = createMainEndpoint(loop.main, quiet, (error) => { throw error; });
    let asks = 0;
    main.serve('user.credentials', async () => ({ type: 'oauth' as const, access: `token-${++asks}`, expiresIn: MIN_VALIDITY_MS + 60_000, refresh: '' as const }));
    let lost = false;
    const lostChange = new Set<() => void>();
    router!.attach({
      id: 'connection-1',
      clientId: 'device-a',
      hostId: 'h1',
      transport: loop.core,
      mirrors: { state: { global: {}, workspace: {} }, trust: { keys: [] }, folders: { folders: [] }, editor: {}, terminal: { shown: false, shortcut: '' }, language: { language: 'en' }, ...values('a') },
      close: vi.fn(),
      drained: () => Promise.resolve(),
      lost: () => lost,
      onLostChange: (listener) => {
        lostChange.add(listener);
        return { dispose: () => { lostChange.delete(listener); } };
      },
    });
    const setLost = (value: boolean): void => {
      lost = value;
      for (const listener of [...lostChange]) listener();
    };
    await flush();
    const raised: string[] = [];
    const signIn = { raise: (provider: string) => { raised.push(provider); return { dispose: vi.fn() }; } };
    const reads: unknown[] = [];
    let next!: () => void;
    const turn = runPinnedTurn(remote, 'panel-1', async () => {
      reads.push(await broker.read('anthropic'));
      await new Promise<void>((resolve) => { next = resolve; });
      reads.push(await broker.read('anthropic'));
    }, signIn);
    await vi.waitFor(() => expect(reads).toHaveLength(1));
    setLost(true);
    await flush();
    now += 61_000;
    next();
    await vi.waitFor(() => expect(raised).toEqual(['anthropic']));
    expect(asks).toBe(1);
    setLost(false);
    await turn;
    expect(reads).toEqual([expect.objectContaining({ access: 'token-1' }), expect.objectContaining({ access: 'token-2' })]);
    broker.dispose();
  });
});
