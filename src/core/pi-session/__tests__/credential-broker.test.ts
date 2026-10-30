import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createFauxCore, fauxAssistantMessage, type Credential } from '@earendil-works/pi-ai';
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager, type AgentSession, type ExtensionAPI } from '@earendil-works/pi-coding-agent';
import type { ClientSnapshots, ClientTopic, RemoteHost } from '../../../platform/remote-host';
import { CREDENTIAL_CLIENT_ABSENT, MAX_BROKER_EXPIRES_IN_MS, MAX_PLAN_MODEL_ID_CHARS, MAX_PLAN_MODEL_IDS, type BrokerAnswer, type HeldAuth } from '../../../shared/remote-user';
import { createFakePlatform } from '../../../__mocks__/fake-platform';
import { createFakeRemoteHost } from '../../../__mocks__/fake-remote-host';
import { runPinnedSubcall, runPinnedTurn } from '../../client-snapshots';
import { installPlatform } from '../../platform-host';
import { installLogSink } from '../../logger';
import { initPiLoader } from '../pi-loader';
import { BrokeredCredentialStore, MIN_VALIDITY_MS, oauthAnswerOf, pinRunStarts, STATUS_ONLY_KEY } from '../credential-broker';
import { sessionNoteDelivery } from '../note-delivery';
import { PiRuntime } from '../pi-runtime';
import { withSettingsPolicy } from '../settings-policy';

const HOUR = 60 * 60 * 1000;

// a detach keeps the client's last clientAuth, as core-host/platform/clients.ts does
function remoteHost(answer: (provider: string, clientId: string) => Promise<BrokerAnswer>) {
  let acting: string | undefined = 'client-a';
  const auth = new Map<string, HeldAuth>();
  const attached = new Set<string>(['client-a', 'client-b']);
  const listeners = new Set<(change: { topic: ClientTopic; clientId?: string; before?: unknown }) => void>();
  const clients: ClientSnapshots = {
    actor: () => undefined,
    acting: () => acting,
    attached: (id) => attached.has(id),
    auth: (id) => auth.get(id),
    user: () => undefined,
    policy: () => undefined,
    editor: () => undefined,
    terminal: () => undefined,
    language: () => undefined,
    onDidChange: (cb) => {
      listeners.add(cb);
      return { dispose: () => listeners.delete(cb) };
    },
  };
  const credentials = vi.fn(answer);
  const runProviders = vi.fn();
  const remote: RemoteHost = { hostId: 'h', clients, agentSocket: () => undefined, credentials, speak: vi.fn(), runProviders };
  return {
    remote,
    credentials,
    runProviders,
    setActing: (id: string | undefined) => { acting = id; },
    setAuth: (clientId: string, value: HeldAuth | undefined) => {
      const before = auth.get(clientId);
      if (value === undefined) attached.delete(clientId);
      else {
        attached.add(clientId);
        auth.set(clientId, value);
      }
      for (const cb of [...listeners]) cb({ topic: 'clientAuth', clientId, before });
    },
  };
}

const oauth = (access: string, expiresIn: number): BrokerAnswer => ({ type: 'oauth', access, expiresIn, refresh: '', accountId: 'acct-1' });

describe('BrokeredCredentialStore', () => {
  it('never calls modify\'s fn, which would refresh with the empty refresh token, and asks the client instead', async () => {
    const host = remoteHost(async () => oauth('fresh', HOUR));
    const broker = new BrokeredCredentialStore({ remote: host.remote, credentialsChanged: vi.fn() });
    const fn = vi.fn(async (current: Credential | undefined) => current);
    const result = await runPinnedTurn(host.remote, 'panel-1', () => broker.modify('anthropic', fn));
    expect(fn).not.toHaveBeenCalled();
    expect(host.credentials).toHaveBeenCalledWith('anthropic', 'client-a');
    expect(result).toMatchObject({ type: 'oauth', access: 'fresh', refresh: '' });
  });

  it('serves the cached credential while it stays valid past pi\'s 5 minute minimum, then asks again', async () => {
    let now = 1_000_000;
    let n = 0;
    const host = remoteHost(async () => oauth(`token-${++n}`, MIN_VALIDITY_MS + 60_000));
    const broker = new BrokeredCredentialStore({ remote: host.remote, credentialsChanged: vi.fn(), now: () => now });
    const read = () => runPinnedTurn(host.remote, 'panel-1', () => broker.read('anthropic'));
    expect(await read()).toMatchObject({ access: 'token-1' });
    expect(await read()).toMatchObject({ access: 'token-1' });
    expect(host.credentials).toHaveBeenCalledTimes(1);
    now += 61_000;
    expect(await read()).toMatchObject({ access: 'token-2' });
    expect(host.credentials).toHaveBeenCalledTimes(2);
  });

  it('asks once for concurrent reads of one provider', async () => {
    const host = remoteHost(async () => oauth('one', HOUR));
    const broker = new BrokeredCredentialStore({ remote: host.remote, credentialsChanged: vi.fn() });
    await runPinnedTurn(host.remote, 'panel-1', () => Promise.all([broker.read('openai'), broker.read('openai'), broker.read('openai')]));
    expect(host.credentials).toHaveBeenCalledTimes(1);
  });

  it.each([HOUR, -HOUR])('keeps expiresIn valid for the same span on a target clock %d ms off the client\'s', async (skew) => {
    const clientNow = 5_000_000_000;
    const targetNow = clientNow + skew;
    const host = remoteHost(async () => oauth('t', 30 * 60 * 1000));
    const broker = new BrokeredCredentialStore({ remote: host.remote, credentialsChanged: vi.fn(), now: () => targetNow });
    const credential = await runPinnedTurn(host.remote, 'panel-1', () => broker.read('anthropic'));
    expect(credential).toMatchObject({ type: 'oauth', expires: targetNow + 30 * 60 * 1000 });
  });

  it('keeps the non-secret extras, empties refresh, and sets expires after them so no extra overrides it', async () => {
    const host = remoteHost(async () => ({ ...oauth('t', HOUR), expires: 1 } as unknown as BrokerAnswer));
    const broker = new BrokeredCredentialStore({ remote: host.remote, credentialsChanged: vi.fn(), now: () => 100 });
    const credential = await runPinnedTurn(host.remote, 'panel-1', () => broker.read('openai-codex'));
    expect(credential).toEqual({ type: 'oauth', access: 't', refresh: '', accountId: 'acct-1', expires: 100 + HOUR });
  });

  it('caches an API key until a clientAuth delta changes that provider, and keeps it across a detach while a turn is pinned to that client', async () => {
    let n = 0;
    const host = remoteHost(async () => ({ type: 'api_key', key: `key-${++n}` }));
    const changed = vi.fn();
    const broker = new BrokeredCredentialStore({ remote: host.remote, credentialsChanged: changed });
    const read = (provider: string) => runPinnedTurn(host.remote, 'panel-1', () => broker.read(provider));
    host.setAuth('client-a', { providers: { openai: { type: 'api_key', hasKey: true, flatFee: false }, deepseek: { type: 'api_key', hasKey: true, flatFee: false } } });
    expect(await read('openai')).toEqual({ type: 'api_key', key: 'key-1' });
    expect(await read('deepseek')).toEqual({ type: 'api_key', key: 'key-2' });
    let settle!: () => void;
    const running = runPinnedTurn(host.remote, 'panel-2', () => new Promise<void>((resolve) => { settle = resolve; }));
    host.setAuth('client-a', undefined);
    expect(await read('openai')).toEqual({ type: 'api_key', key: 'key-1' });
    host.setAuth('client-a', { providers: { openai: { type: 'api_key', hasKey: true, flatFee: false }, deepseek: { type: 'none', hasKey: false, flatFee: false } } });
    expect(changed).toHaveBeenCalledTimes(2);
    expect(await read('openai')).toEqual({ type: 'api_key', key: 'key-1' });
    expect(await read('deepseek')).toEqual({ type: 'api_key', key: 'key-3' });
    settle();
    await running;
  });

  it('keys the cache by client: another client\'s turn asks its own client', async () => {
    const host = remoteHost(async (_provider, clientId) => oauth(`of-${clientId}`, HOUR));
    const broker = new BrokeredCredentialStore({ remote: host.remote, credentialsChanged: vi.fn() });
    expect(await runPinnedTurn(host.remote, 'p1', () => broker.read('anthropic'))).toMatchObject({ access: 'of-client-a' });
    host.setActing('client-b');
    expect(await runPinnedTurn(host.remote, 'p2', () => broker.read('anthropic'))).toMatchObject({ access: 'of-client-b' });
  });

  it('a turn keeps its pinned client while another client acts', async () => {
    const host = remoteHost(async (_provider, clientId) => oauth(`of-${clientId}`, HOUR));
    const broker = new BrokeredCredentialStore({ remote: host.remote, credentialsChanged: vi.fn() });
    const turn = runPinnedTurn(host.remote, 'p1', async () => {
      await Promise.resolve();
      host.setActing('client-b');
      return broker.read('anthropic');
    });
    expect(await turn).toMatchObject({ access: 'of-client-a' });
  });

  it('answers none as no credential, so pi falls back to the target\'s own', async () => {
    const host = remoteHost(async () => ({ type: 'none' }));
    const broker = new BrokeredCredentialStore({ remote: host.remote, credentialsChanged: vi.fn() });
    expect(await runPinnedTurn(host.remote, 'p1', () => broker.read('xai'))).toBeUndefined();
  });

  it('applies the absent-client policy only when it must ask: a cached credential is served with the client gone', async () => {
    let attached = true;
    const host = remoteHost(async () => {
      if (!attached) throw new Error(CREDENTIAL_CLIENT_ABSENT);
      return oauth('t', HOUR);
    });
    const broker = new BrokeredCredentialStore({ remote: host.remote, credentialsChanged: vi.fn() });
    await runPinnedTurn(host.remote, 'p1', () => broker.read('anthropic'));
    attached = false;
    expect(await runPinnedTurn(host.remote, 'p1', () => broker.read('anthropic'))).toMatchObject({ access: 't' });
    host.setAuth('client-a', { providers: { anthropic: { type: 'oauth', expires: Date.now() + HOUR, hasKey: false, flatFee: false }, openai: { type: 'api_key', hasKey: true, flatFee: false } } });
    const turn = runPinnedTurn(host.remote, 'p1', () => broker.read('openai'));
    await expect(turn).rejects.toThrow(/not connected/);
    const subcall = runPinnedSubcall(host.remote, () => broker.read('openai'));
    await expect(subcall).rejects.toMatchObject({ cause: 'credential' });
  });

  it('list reads the pinned client\'s clientAuth entry, never a secret', async () => {
    const host = remoteHost(async () => ({ type: 'none' }));
    host.setAuth('client-a', { providers: { anthropic: { type: 'oauth', expires: 9, hasKey: false, flatFee: false }, openai: { type: 'api_key', hasKey: true, flatFee: false }, xai: { type: 'none', hasKey: false, flatFee: false } } });
    host.setAuth('client-b', { providers: { deepseek: { type: 'api_key', hasKey: true, flatFee: false } } });
    const broker = new BrokeredCredentialStore({ remote: host.remote, credentialsChanged: vi.fn() });
    expect(await runPinnedTurn(host.remote, 'p1', () => broker.list())).toEqual([
      { providerId: 'anthropic', type: 'oauth' },
      { providerId: 'openai', type: 'api_key' },
    ]);
  });

  it('refuses delete, so a remote core never signs this computer out', async () => {
    const host = remoteHost(async () => ({ type: 'none' }));
    const broker = new BrokeredCredentialStore({ remote: host.remote, credentialsChanged: vi.fn() });
    await expect(broker.delete('anthropic')).rejects.toThrow(/User tab/);
    expect(host.credentials).not.toHaveBeenCalled();
  });

  it('never caches an answer asked for before a clientAuth delta changed its provider, and asks again after the delta', async () => {
    let release!: (answer: BrokerAnswer) => void;
    const stale = new Promise<BrokerAnswer>((resolve) => { release = resolve; });
    let n = 0;
    const host = remoteHost(async () => (++n === 1 ? stale : { type: 'api_key', key: 'key-new' }));
    const broker = new BrokeredCredentialStore({ remote: host.remote, credentialsChanged: vi.fn() });
    const read = () => runPinnedTurn(host.remote, 'p1', () => broker.read('minimax'));
    host.setAuth('client-a', { providers: { minimax: { type: 'api_key', hasKey: true, flatFee: false } } });
    const inFlight = read();
    host.setAuth('client-a', { providers: { minimax: { type: 'api_key', hasKey: true, flatFee: true } } });
    const afterDelta = read();
    release({ type: 'api_key', key: 'key-old' });
    expect(await inFlight).toEqual({ type: 'api_key', key: 'key-old' });
    expect(await afterDelta).toEqual({ type: 'api_key', key: 'key-new' });
    expect(await read()).toEqual({ type: 'api_key', key: 'key-new' });
    expect(host.credentials).toHaveBeenCalledTimes(2);
  });

  // pi gates Copilot by the credential's own list, so a cached answer must not outlive a plan change.
  it('drops a cached sign-in when only its plan model list changes, and asks the client again', async () => {
    const host = remoteHost(async () => oauth('t', HOUR));
    const credentialsChanged = vi.fn();
    const broker = new BrokeredCredentialStore({ remote: host.remote, credentialsChanged });
    const entry = { type: 'oauth', expires: Date.now() + HOUR, hasKey: false, flatFee: false } as const;
    const read = () => runPinnedTurn(host.remote, 'p1', () => broker.read('github-copilot'));
    host.setAuth('client-a', { providers: { 'github-copilot': { ...entry, availableModelIds: ['gpt-6-luna'] } } });
    await read();
    await read();
    expect(host.credentials).toHaveBeenCalledTimes(1);

    host.setAuth('client-a', { providers: { 'github-copilot': { ...entry, availableModelIds: ['gpt-6-luna', 'claude-haiku-5.5'] } } });
    await read();

    expect(host.credentials).toHaveBeenCalledTimes(2);
    await vi.waitFor(() => expect(credentialsChanged).toHaveBeenCalled());
  });

  it('records the providers each run read, for the run registry', async () => {
    const host = remoteHost(async () => oauth('t', HOUR));
    const broker = new BrokeredCredentialStore({ remote: host.remote, credentialsChanged: vi.fn() });
    await runPinnedTurn(host.remote, 'p1', async () => {
      await broker.read('anthropic');
      await broker.read('anthropic');
      await broker.read('openai');
    });
    expect(host.runProviders.mock.calls).toEqual([['p1', ['anthropic']], ['p1', ['anthropic', 'openai']]]);
  });

  it('holds nothing once disposed: no credential, clientAuth, run providers or delta count, and no answer that arrives later', async () => {
    let release!: (answer: BrokerAnswer) => void;
    const late = new Promise<BrokerAnswer>((resolve) => { release = resolve; });
    let n = 0;
    const host = remoteHost(async () => (++n === 1 ? oauth('t', HOUR) : late));
    const broker = new BrokeredCredentialStore({ remote: host.remote, credentialsChanged: vi.fn() });
    host.setAuth('client-a', { providers: { anthropic: { type: 'oauth', expires: 9, hasKey: false, flatFee: false } } });
    await runPinnedTurn(host.remote, 'p1', () => broker.read('anthropic'));
    const inFlight = runPinnedTurn(host.remote, 'p2', () => broker.read('openai'));
    await vi.waitFor(() => expect(host.credentials).toHaveBeenCalledTimes(2));
    broker.dispose();
    release({ type: 'api_key', key: 'late' });
    expect(await inFlight).toEqual({ type: 'api_key', key: 'late' });
    const held = broker as unknown as Record<'cache' | 'asking' | 'generations' | 'lastAuth' | 'used', Map<string, unknown>>;
    expect([held.cache, held.asking, held.generations, held.lastAuth, held.used].map((map) => map.size)).toEqual([0, 0, 0, 0, 0]);
  });
});

describe('status reads outside a run', () => {
  it('answer from the client clientAuth entry without a secret, and never ask the client', async () => {
    const host = remoteHost(async () => oauth('SECRET', HOUR));
    host.setAuth('client-a', { providers: { anthropic: { type: 'oauth', expires: 42, hasKey: false, flatFee: false }, openai: { type: 'api_key', hasKey: true, flatFee: false }, xai: { type: 'none', hasKey: false, flatFee: false } } });
    const broker = new BrokeredCredentialStore({ remote: host.remote, credentialsChanged: vi.fn() });
    expect(await broker.read('anthropic')).toEqual({ type: 'oauth', access: '', refresh: '', expires: 42 });
    expect(await broker.read('openai')).toEqual({ type: 'api_key', key: STATUS_ONLY_KEY });
    expect(await broker.read('xai')).toBeUndefined();
    expect(await broker.modify('anthropic', vi.fn())).toEqual({ type: 'oauth', access: '', refresh: '', expires: 42 });
    expect(host.credentials).not.toHaveBeenCalled();
    expect(host.runProviders).not.toHaveBeenCalled();
  });

  // pi's Copilot provider filters its available list by the credential's own list, which the status answer must carry.
  it('pass a sign-in\'s plan model list on, with no secret', async () => {
    const host = remoteHost(async () => oauth('SECRET', HOUR));
    host.setAuth('client-a', { providers: { 'github-copilot': { type: 'oauth', expires: 42, hasKey: false, flatFee: false, availableModelIds: ['gpt-6-luna'] } } });
    const broker = new BrokeredCredentialStore({ remote: host.remote, credentialsChanged: vi.fn() });
    expect(await broker.read('github-copilot')).toEqual({ type: 'oauth', access: '', refresh: '', expires: 42, availableModelIds: ['gpt-6-luna'] });
    expect(host.credentials).not.toHaveBeenCalled();
  });

  it('pi availability check of every provider asks nothing, and a turn asks once, for its provider only', async () => {
    const host = remoteHost(async (provider) => (provider === 'openai' ? { type: 'api_key', key: 'sk-turn' } : oauth('SECRET', HOUR)));
    host.setAuth('client-a', { providers: { anthropic: { type: 'oauth', expires: Date.now() + HOUR, hasKey: false, flatFee: false }, openai: { type: 'api_key', hasKey: true, flatFee: false } } });
    const broker = new BrokeredCredentialStore({ remote: host.remote, credentialsChanged: vi.fn() });
    const runtime = await ModelRuntime.create({ credentials: broker, modelsPath: null });
    await runtime.getAvailable();
    expect(host.credentials).not.toHaveBeenCalled();
    expect(runtime.hasConfiguredAuth('anthropic')).toBe(true);
    expect(runtime.hasConfiguredAuth('openai')).toBe(true);
    const auth = await runPinnedTurn(host.remote, 'p1', async () => {
      await runtime.getAuth('openai');
      return runtime.getAuth('openai');
    });
    expect(auth?.auth.apiKey).toBe('sk-turn');
    expect(host.credentials.mock.calls).toEqual([['openai', 'client-a']]);
  });
});

describe('oauthAnswerOf', () => {
  it('sends only the access token, its validity and the allowlisted extras, never the refresh token', () => {
    const answer = oauthAnswerOf({ type: 'oauth', access: 'a', refresh: 'SECRET', expires: 1_000 + HOUR, clientId: 'c', scopes: ['s'], enterpriseUrl: 'e', idToken: 'SECRET2' }, 1_000);
    expect(answer).toEqual({ type: 'oauth', access: 'a', expiresIn: HOUR, refresh: '', clientId: 'c', scopes: ['s'], enterpriseUrl: 'e' });
    expect(JSON.stringify(answer)).not.toContain('SECRET');
  });

  it('sends a plan model list whole, and none where planModelIdsOf takes it as no list', () => {
    const stored = { access: 'a', expires: HOUR };
    expect(oauthAnswerOf({ ...stored, availableModelIds: ['gpt-6-luna'] }, 0)).toMatchObject({ availableModelIds: ['gpt-6-luna'] });
    const tooMany = Array.from({ length: MAX_PLAN_MODEL_IDS + 1 }, (_, i) => `m${i}`);
    for (const ids of [tooMany, ['x'.repeat(MAX_PLAN_MODEL_ID_CHARS + 1)], [''], ['gpt-6-luna', 7]]) {
      expect(oauthAnswerOf({ ...stored, availableModelIds: ids }, 0)).not.toHaveProperty('availableModelIds');
    }
  });

  it('clamps a never-expiring credential (OpenRouter) and an expired one', () => {
    expect(oauthAnswerOf({ access: 'a', expires: Number.MAX_SAFE_INTEGER }, 0)).toMatchObject({ expiresIn: MAX_BROKER_EXPIRES_IN_MS });
    expect(oauthAnswerOf({ access: 'a', expires: 5 }, 10)).toMatchObject({ expiresIn: 0 });
  });
});

describe('pi\'s availability refresh inside a turn', () => {
  const dirs: string[] = [];
  const tempDir = (prefix: string): string => {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
    dirs.push(dir);
    return dir;
  };

  afterEach(async () => {
    await PiRuntime.disposeInstance();
    installPlatform(createFakePlatform());
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('asks the client nothing when a folder or a subagent is built inside a turn\'s pin', async () => {
    const host = createFakeRemoteHost(async () => ({ type: 'api_key', key: 'sk-client' }));
    host.set('clientAuth', 'client-a', { providers: { anthropic: { type: 'api_key', hasKey: true, flatFee: false } } });
    installPlatform({ ...createFakePlatform(), remote: host.remote });
    const workspace = tempDir('damocles-broker-ws-');
    const runtime = PiRuntime.get(tempDir('damocles-broker-agent-'));
    await runtime.init();
    const folder = await runPinnedTurn(host.remote, 'p1', () => runtime.folder(workspace));
    expect(host.remote.credentials).not.toHaveBeenCalled();
    const subagent = await runPinnedTurn(host.remote, 'p1', () =>
      folder.createSubagentSession({ cwd: workspace, systemPrompt: 'probe', tools: [], customTools: [], extensionFactory: () => {}, store: { kind: 'memory' } }));
    expect(host.remote.credentials).not.toHaveBeenCalled();
    folder.forgetSubagentSession(subagent);
  }, 60_000);

  it('asks the client nothing for the pass pi starts itself when a provider is unregistered or registered inside a turn\'s pin', async () => {
    const host = createFakeRemoteHost(async () => ({ type: 'api_key', key: 'sk-client' }));
    host.set('clientAuth', 'client-a', { providers: { anthropic: { type: 'api_key', hasKey: true, flatFee: false } } });
    installPlatform({ ...createFakePlatform(), remote: host.remote });
    const runtime = PiRuntime.get(tempDir('damocles-broker-agent-'));
    await runtime.init();
    const modelRuntime = runtime.modelRuntime!;
    const refresh = vi.spyOn(modelRuntime, 'refresh');
    runPinnedTurn(host.remote, 'p1', () => {
      modelRuntime.unregisterProvider('xai');
      modelRuntime.registerProvider('xai', { baseUrl: 'https://api.x.ai/v1', api: 'openai-completions', apiKey: 'XAI_API_KEY', models: [] } as never);
    });
    expect(refresh).toHaveBeenCalledTimes(2);
    await Promise.all(refresh.mock.results.map((result) => result.value));
    expect(host.remote.credentials).not.toHaveBeenCalled();
  }, 60_000);
});

describe('a disposed runtime\'s token broker', () => {
  const dirs: string[] = [];
  const tempDir = (prefix: string): string => {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
    dirs.push(dir);
    return dir;
  };

  afterEach(async () => {
    await PiRuntime.disposeInstance();
    installPlatform(createFakePlatform());
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  async function remoteRuntime() {
    const host = createFakeRemoteHost(async () => ({ type: 'api_key', key: 'sk-client' }));
    host.set('clientAuth', 'client-a', { providers: { anthropic: { type: 'api_key', hasKey: true, flatFee: false } } });
    installPlatform({ ...createFakePlatform(), remote: host.remote });
    const runtime = PiRuntime.get(tempDir('damocles-broker-agent-'));
    await runtime.init();
    const broker = (runtime as unknown as { _broker: BrokeredCredentialStore })._broker;
    const logged: string[] = [];
    installLogSink({ appendLine: (line) => void logged.push(line), show: () => undefined, dispose: () => undefined });
    return { host, runtime, broker, logged };
  }

  it('holds none of the devices\' credentials and asks no device once the runtime is disposed', async () => {
    const { host, broker } = await remoteRuntime();
    const read = () => runPinnedTurn(host.remote, 'p1', () => broker.read('anthropic'));
    expect(await read()).toEqual({ type: 'api_key', key: 'sk-client' });
    expect(await read()).toEqual({ type: 'api_key', key: 'sk-client' });
    expect(host.remote.credentials).toHaveBeenCalledTimes(1);

    await PiRuntime.disposeInstance();

    const held = broker as unknown as Record<'cache' | 'asking' | 'lastAuth', Map<string, unknown>>;
    expect([held.cache.size, held.asking.size, held.lastAuth.size]).toEqual([0, 0, 0]);
    await expect(read()).rejects.toMatchObject({ cause: 'credential', text: { message: 'Damocles stopped on this host, so it has no sign-in for {0}.', args: ['anthropic'] } });
    expect(host.remote.credentials).toHaveBeenCalledTimes(1);
  }, 60_000);

  it('passes no clientAuth delta to the runtime once it is disposed', async () => {
    const { host, runtime, logged } = await remoteRuntime();
    const credentialsChanged = vi.spyOn(runtime, 'credentialsChanged');
    await PiRuntime.disposeInstance();

    host.set('clientAuth', 'client-a', { providers: { anthropic: { type: 'api_key', hasKey: true, flatFee: false }, openai: { type: 'api_key', hasKey: true, flatFee: false } } });
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(credentialsChanged).not.toHaveBeenCalled();
    expect(logged.filter((line) => line.includes('[PiRuntime]'))).toEqual([]);
  }, 60_000);

  it('ends a delta\'s handling that was under way when the runtime was disposed, with no sync, publication or failure', async () => {
    const { host, runtime, logged } = await remoteRuntime();
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const refresh = vi.spyOn(runtime.modelRuntime!, 'refresh').mockImplementation((async () => {
      await held;
      return { errors: new Map(), aborted: false };
    }) as never);
    const work = [
      vi.spyOn(runtime as unknown as { _syncOpenAIRuntimeKeyNow: () => Promise<void> }, '_syncOpenAIRuntimeKeyNow'),
      vi.spyOn(runtime, 'syncCustomProviders'),
      vi.spyOn(runtime.usage, 'credentialsChanged'),
    ];
    let published = 0;
    const stops = [PiRuntime.onMemoryJudgeChange(() => void published++), PiRuntime.onAuthFileChange(() => void published++), PiRuntime.onClientAuthChange(() => void published++)];
    try {
      host.set('clientAuth', 'client-a', { providers: { anthropic: { type: 'api_key', hasKey: true, flatFee: false }, openai: { type: 'api_key', hasKey: true, flatFee: false } } });
      await vi.waitFor(() => expect(refresh).toHaveBeenCalled());
      await PiRuntime.disposeInstance();
      release();
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect([...work.map((spy) => spy.mock.calls.length), published]).toEqual([0, 0, 0, 0]);
      expect(logged.filter((line) => line.includes('[PiRuntime]'))).toEqual([]);
    } finally {
      for (const stop of stops) stop();
    }
  }, 60_000);

  it('ends a delta\'s handling whose key sync was running when the runtime was disposed, telling the auth-file listeners nothing', async () => {
    const { host, runtime } = await remoteRuntime();
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const keySync = vi.spyOn(runtime, 'syncCustomProviders').mockImplementationOnce(async () => {
      await held;
      return { wired: [], notWired: [], timedOut: false };
    });
    let told = 0;
    const stop = PiRuntime.onAuthFileChange(() => void told++);
    try {
      host.set('clientAuth', 'client-a', { providers: { anthropic: { type: 'api_key', hasKey: true, flatFee: false }, openai: { type: 'api_key', hasKey: true, flatFee: false } } });
      await vi.waitFor(() => expect(keySync).toHaveBeenCalled());
      await PiRuntime.disposeInstance();
      release();
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(told).toBe(0);
    } finally {
      stop();
    }
  }, 60_000);

  it('ends a delta that waited for an init the dispose overtook, publishing nothing', async () => {
    const host = createFakeRemoteHost(async () => ({ type: 'api_key', key: 'sk-client' }));
    installPlatform({ ...createFakePlatform(), remote: host.remote });
    const runtime = PiRuntime.get(tempDir('damocles-broker-agent-'));
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const pi = (await initPiLoader())!;
    const createModelRuntime = pi.ModelRuntime.create.bind(pi.ModelRuntime);
    const create = vi.spyOn(pi.ModelRuntime, 'create').mockImplementationOnce((async (...args: Parameters<typeof createModelRuntime>) => {
      await held;
      return createModelRuntime(...args);
    }) as never);
    let published = 0;
    const stops = [PiRuntime.onMemoryJudgeChange(() => void published++), PiRuntime.onAuthFileChange(() => void published++), PiRuntime.onClientAuthChange(() => void published++)];
    try {
      const init = runtime.init();
      await vi.waitFor(() => expect(create).toHaveBeenCalled());
      host.set('clientAuth', 'client-a', { providers: { openai: { type: 'api_key', hasKey: true, flatFee: false } } });
      const disposed = PiRuntime.disposeInstance();
      release();
      await expect(init).rejects.toThrow(/disposed/);
      await disposed;
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(published).toBe(0);
    } finally {
      create.mockRestore();
      for (const stop of stops) stop();
    }
  }, 60_000);

  it('republishes nothing for an acting client change whose refresh was running when the runtime was disposed', async () => {
    const { host, runtime } = await remoteRuntime();
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const refresh = vi.spyOn(runtime.modelRuntime!, 'refresh').mockImplementation((async () => {
      await held;
      return { errors: new Map(), aborted: false };
    }) as never);
    let published = 0;
    const stops = [PiRuntime.onActingClientRefreshed(() => void published++), PiRuntime.onClientAuthChange(() => void published++)];
    try {
      host.setActing('client-b');
      await vi.waitFor(() => expect(refresh).toHaveBeenCalled());
      await PiRuntime.disposeInstance();
      release();
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(published).toBe(0);
    } finally {
      for (const stop of stops) stop();
    }
  }, 60_000);
});

describe('a run started outside every pin', () => {
  const dirs: string[] = [];
  const sessions: AgentSession[] = [];
  afterEach(() => {
    for (const session of sessions.splice(0)) session.dispose();
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  /** A real pi session on the broker, whose scripted anthropic provider records the key each request carries. */
  async function brokeredSession() {
    const host = createFakeRemoteHost(async () => ({ type: 'api_key', key: 'sk-client' }));
    host.set('clientAuth', 'client-a', { providers: { anthropic: { type: 'api_key', hasKey: true, flatFee: false } } });
    const keys: Array<string | undefined> = [];
    const faux = createFauxCore({ api: 'anthropic-messages', provider: 'anthropic', models: [{ id: 'claude-opus-5-5' }] });
    faux.setResponses([(_context, options) => {
      keys.push(options?.apiKey);
      return fauxAssistantMessage('done');
    }]);
    const cwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'damocles-broker-run-')));
    dirs.push(cwd);
    let extension: ExtensionAPI | undefined;
    const settingsManager = withSettingsPolicy(SettingsManager.inMemory({}, { projectTrusted: true }));
    const modelRuntime = await ModelRuntime.create({ credentials: new BrokeredCredentialStore({ remote: host.remote, credentialsChanged: vi.fn() }), modelsPath: null });
    const resourceLoader = new DefaultResourceLoader({
      cwd,
      agentDir: cwd,
      settingsManager,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      extensionFactories: [(pi: ExtensionAPI) => {
        pi.registerProvider('anthropic', { baseUrl: 'https://api.anthropic.com', api: 'anthropic-messages', streamSimple: faux.streamSimple } as never);
        extension = pi;
      }],
    } as never);
    await resourceLoader.reload();
    const { session } = await createAgentSession({
      cwd,
      agentDir: cwd,
      model: modelRuntime.getModel('anthropic', 'claude-opus-5-5'),
      thinkingLevel: 'off',
      modelRuntime,
      settingsManager,
      resourceLoader,
      sessionManager: SessionManager.inMemory(cwd),
      tools: [],
    } as never);
    sessions.push(session);
    pinRunStarts(session, host.remote, 'panel-1', { raise: () => { throw new Error('no sign-in in this test'); } });
    if (!extension) throw new Error('the extension never loaded');
    return { host, session, keys, extension };
  }

  it('a cancel note on an idle session runs pinned, so its request carries the client\'s key and never the placeholder', async () => {
    const { host, session, keys } = await brokeredSession();
    await sessionNoteDelivery(() => session)('skip it', () => undefined);
    expect(keys).toEqual(['sk-client']);
    expect(keys).not.toContain(STATUS_ONLY_KEY);
    expect(host.remote.credentials).toHaveBeenCalledWith('anthropic', 'client-a');
    expect(host.remote.runProviders).toHaveBeenCalledWith('panel-1', ['anthropic']);
  }, 60_000);

  it('a run started inside a turn keeps that turn\'s pin, whoever acts when it starts', async () => {
    const { host, session, keys } = await brokeredSession();
    host.set('clientAuth', 'client-b', { providers: { anthropic: { type: 'api_key', hasKey: true, flatFee: false } } });
    await runPinnedTurn(host.remote, 'panel-1', async () => {
      host.setActing('client-b');
      await session.prompt('a subagent task from a tool');
    });
    expect(keys).toEqual(['sk-client']);
    expect(vi.mocked(host.remote.credentials).mock.calls).toEqual([['anthropic', 'client-a']]);
  }, 60_000);

  it('an extension\'s triggerTurn on an idle session runs pinned, so its request carries the client\'s key', async () => {
    const { host, session, keys, extension } = await brokeredSession();
    extension.sendMessage({ customType: 'probe', content: 'go', display: false }, { triggerTurn: true });
    await vi.waitFor(() => expect(keys).toHaveLength(1));
    await session.agent.waitForIdle();
    expect(keys).toEqual(['sk-client']);
    expect(host.remote.credentials).toHaveBeenCalledWith('anthropic', 'client-a');
  }, 60_000);
});

describe('a pin names a device', () => {
  const ANTHROPIC: HeldAuth = { providers: { anthropic: { type: 'oauth', expires: Date.now() + HOUR, hasKey: false, flatFee: false } } };

  // each device answers on its current connection; a device with none is absent, as the daemon routes user.credentials by device id
  function devices(now: () => number) {
    const connections = new Map<string, string>();
    const host = remoteHost(async (_provider, clientId) => {
      const connection = connections.get(clientId);
      if (connection === undefined) throw new Error(CREDENTIAL_CLIENT_ABSENT);
      return oauth(`${connection}-token`, MIN_VALIDITY_MS + 60_000);
    });
    const broker = new BrokeredCredentialStore({ remote: host.remote, credentialsChanged: vi.fn(), now });
    const prompts: string[] = [];
    let resolved = 0;
    const signIn = {
      raise: (provider: string) => {
        prompts.push(provider);
        return { dispose: () => { resolved++; } };
      },
    };
    return {
      host,
      broker,
      signIn,
      prompts,
      resolved: () => resolved,
      attach: (clientId: string, connection: string) => {
        connections.set(clientId, connection);
        host.setAuth(clientId, ANTHROPIC);
      },
      detach: (clientId: string) => {
        connections.delete(clientId);
        host.setAuth(clientId, undefined);
      },
    };
  }
  const cached = (broker: BrokeredCredentialStore) => [...(broker as unknown as { cache: Map<string, unknown> }).cache.keys()];

  it('a detached device\'s entries survive while a turn pinned to it runs, and are gone once the last one settles', async () => {
    const d = devices(Date.now);
    d.attach('client-a', 'connection-1');
    const settles: Array<() => void> = [];
    const turn = () => runPinnedTurn(d.host.remote, 'p1', async () => {
      await d.broker.read('anthropic');
      await new Promise<void>((resolve) => settles.push(resolve));
    });
    const first = turn();
    const second = turn();
    await vi.waitFor(() => expect(settles).toHaveLength(2));
    d.detach('client-a');
    expect(cached(d.broker)).toEqual(['client-a\nanthropic']);
    settles[0]!();
    await first;
    expect(cached(d.broker)).toEqual(['client-a\nanthropic']);
    expect(await runPinnedTurn(d.host.remote, 'p2', () => d.broker.read('anthropic'))).toMatchObject({ access: 'connection-1-token' });
    expect(cached(d.broker)).toEqual(['client-a\nanthropic']);
    settles[1]!();
    await second;
    await vi.waitFor(() => expect(cached(d.broker)).toEqual([]));
    expect(d.host.credentials).toHaveBeenCalledTimes(1);
    // a turn that later pins to that device asks again
    await expect(runPinnedTurn(d.host.remote, 'p3', () => d.broker.read('anthropic'))).rejects.toThrow(/not connected/);
    expect(d.host.credentials).toHaveBeenCalledTimes(2);
  });

  it('an attached device keeps its entries with no turn pinned, and loses them once it detaches', async () => {
    const d = devices(Date.now);
    d.attach('client-a', 'connection-1');
    await runPinnedTurn(d.host.remote, 'p1', () => d.broker.read('anthropic'));
    expect(cached(d.broker)).toEqual(['client-a\nanthropic']);
    d.detach('client-a');
    expect(cached(d.broker)).toEqual([]);
  });

  it('a turn pinned to a device whose connection closes and reattaches gets its next credential from the new connection, and another device\'s attach never serves it', async () => {
    let now = 1_000_000;
    const d = devices(() => now);
    d.attach('client-a', 'connection-1');
    const reads: unknown[] = [];
    let next!: () => void;
    const turn = runPinnedTurn(d.host.remote, 'p1', async () => {
      reads.push(await d.broker.read('anthropic'));
      await new Promise<void>((resolve) => { next = resolve; });
      reads.push(await d.broker.read('anthropic'));
    }, d.signIn);
    await vi.waitFor(() => expect(reads).toHaveLength(1));
    d.detach('client-a');
    now += 61_000;
    next();
    await vi.waitFor(() => expect(d.prompts).toEqual(['anthropic']));
    d.host.setActing('client-b');
    d.attach('client-b', 'connection-2');
    await Promise.resolve();
    expect(reads).toHaveLength(1);
    expect(d.host.credentials.mock.calls.filter(([, clientId]) => clientId === 'client-b')).toEqual([]);
    d.attach('client-a', 'connection-3');
    await turn;
    expect(reads).toEqual([expect.objectContaining({ access: 'connection-1-token' }), expect.objectContaining({ access: 'connection-3-token' })]);
    expect(d.resolved()).toBe(1);
  });
});

describe('the provider sign-ins a remote chat runs on', () => {
  // each sign-in as pi stores it on the client: the refresh token and an id token stay there
  const stored = (provider: string): Record<string, unknown> => ({
    type: 'oauth',
    access: `access-${provider}`,
    refresh: 'REFRESH-SECRET',
    idToken: 'ID-SECRET',
    expires: Date.now() + HOUR,
    ...(provider === 'github-copilot' ? { enterpriseUrl: 'ghe.example.com' } : {}),
  });

  it.each([
    ['github-copilot', { apiKey: 'access-github-copilot', baseUrl: 'https://copilot-api.ghe.example.com' }],
    ['kimi-coding', { headers: { Authorization: 'Bearer access-kimi-coding' } }],
    ['meta', { apiKey: 'access-meta' }],
    ['xai', { apiKey: 'access-xai' }],
    ['openrouter', { apiKey: 'access-openrouter' }],
  ])('%s: a turn on the target authenticates with the device\'s access token and the extras pi needs, never its refresh token', async (provider, auth) => {
    const answer = oauthAnswerOf(stored(provider), Date.now());
    expect(JSON.stringify(answer)).not.toMatch(/SECRET/);
    const host = remoteHost(async () => answer);
    host.setAuth('client-a', { providers: { [provider]: { type: 'oauth', expires: Date.now() + HOUR, hasKey: false, flatFee: false } } });
    const broker = new BrokeredCredentialStore({ remote: host.remote, credentialsChanged: vi.fn() });
    const runtime = await ModelRuntime.create({ credentials: broker, modelsPath: null, refreshOnCreate: false });
    const resolved = await runPinnedTurn(host.remote, 'p1', () => runtime.getAuth(provider));
    expect(resolved?.auth).toMatchObject(auth);
    expect(host.credentials.mock.calls).toEqual([[provider, 'client-a']]);
  });
});
