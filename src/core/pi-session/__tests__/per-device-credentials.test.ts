import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { createFakePlatform } from '../../../__mocks__/fake-platform';
import { createFakeRemoteHost } from '../../../__mocks__/fake-remote-host';
import { DEFAULT_MODELS } from '../../../shared/types/constants';
import { CREDENTIAL_CLIENT_ABSENT, type BrokerAnswer, type HeldAuth } from '../../../shared/remote-user';
import { clientHasCredential, clientHasKey, runPinnedTurn } from '../../client-snapshots';
import { installPlatform } from '../../platform-host';
import { BrokeredCredentialStore } from '../credential-broker';
import { OPENAI_API_KEY_SECRET } from '../openai-auth';
import { markCredentialSources } from '../pi-models';
import { PiRuntime } from '../pi-runtime';

const HOUR = 60 * 60 * 1000;
const HOST_ENV_KEY = 'sk-host-environment-0001';
const claude = (expires = Date.now() + HOUR): HeldAuth['providers'][string] => ({ type: 'oauth', expires, hasKey: false, flatFee: false });
const openaiKey: HeldAuth['providers'][string] = { type: 'api_key', hasKey: true, flatFee: false };

const dirs: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await PiRuntime.disposeInstance();
  installPlatform(createFakePlatform());
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

// the target's environment: only the variables named here hold a credential
function targetEnvironment(vars: Record<string, string>): void {
  for (const name of ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'ANTHROPIC_OAUTH_TOKEN']) vi.stubEnv(name, vars[name] ?? '');
}

// two devices, each with its own account: each answers only for itself, and a device with no connection is absent
function twoDevices(answer: (clientId: string, provider: string) => BrokerAnswer) {
  const live = new Set(['client-a', 'client-b']);
  const host = createFakeRemoteHost(async (provider, clientId) => {
    if (!live.has(clientId)) throw new Error(CREDENTIAL_CLIENT_ABSENT);
    return answer(clientId, provider);
  });
  for (const clientId of live) host.set('clientAuth', clientId, { providers: { anthropic: claude(), openai: openaiKey } });
  return {
    host,
    detach: (clientId: string) => {
      live.delete(clientId);
      host.set('clientAuth', clientId, undefined);
    },
  };
}

const account = (clientId: string): BrokerAnswer => ({ type: 'oauth', access: `token-of-${clientId}`, expiresIn: HOUR, refresh: '' });

async function remoteRuntime(host: ReturnType<typeof createFakeRemoteHost>, secrets: Record<string, string> = {}) {
  installPlatform({ ...createFakePlatform({ secrets }), remote: host.remote });
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'damocles-per-device-')));
  dirs.push(dir);
  const runtime = PiRuntime.get(dir);
  await runtime.init();
  return runtime;
}

describe('per-device credentials', () => {
  it('two devices signed in to different accounts each get their own token for their own turns, at the same time', async () => {
    const { host } = twoDevices(account);
    const broker = new BrokeredCredentialStore({ remote: host.remote, credentialsChanged: vi.fn() });
    host.setActing('client-a');
    const turnOfA = runPinnedTurn(host.remote, 'panel-1', async () => {
      await Promise.resolve();
      return broker.read('anthropic');
    });
    host.setActing('client-b');
    const turnOfB = runPinnedTurn(host.remote, 'panel-2', () => broker.read('anthropic'));
    expect(await turnOfA).toMatchObject({ access: 'token-of-client-a' });
    expect(await turnOfB).toMatchObject({ access: 'token-of-client-b' });
  });

  it('a turn never reads another device\'s entry: with its own device away it waits, and Continue with my sign-in moves it', async () => {
    const { host, detach } = twoDevices(account);
    const broker = new BrokeredCredentialStore({ remote: host.remote, credentialsChanged: vi.fn() });
    host.setActing('client-b');
    expect(await runPinnedTurn(host.remote, 'panel-2', () => broker.read('anthropic'))).toMatchObject({ access: 'token-of-client-b' });
    detach('client-a');
    host.setActing('client-a');
    let continueWith!: (clientId: string) => void;
    const signIn = { raise: vi.fn((_provider: string, actions: { readonly continueWith: (clientId: string) => void }) => { continueWith = actions.continueWith; return { dispose: vi.fn() }; }) };
    let read: unknown = 'pending';
    const turn = runPinnedTurn(host.remote, 'panel-1', async () => {
      read = await broker.read('anthropic');
      return read;
    }, signIn);
    await vi.waitFor(() => expect(signIn.raise).toHaveBeenCalledWith('anthropic', expect.anything()));
    expect(read).toBe('pending');
    continueWith('client-b');
    expect(await turn).toMatchObject({ access: 'token-of-client-b' });
  });

  it('two devices with different API keys for one provider each get their own key through pi', async () => {
    targetEnvironment({});
    const { host } = twoDevices((clientId, provider) => (provider === 'openai' ? { type: 'api_key', key: `sk-${clientId}` } : account(clientId)));
    const runtime = await remoteRuntime(host);
    const modelRuntime = runtime.modelRuntime!;
    host.setActing('client-a');
    const ofA = runPinnedTurn(host.remote, 'panel-1', async () => {
      await Promise.resolve();
      return modelRuntime.getAuth('openai');
    });
    host.setActing('client-b');
    const ofB = runPinnedTurn(host.remote, 'panel-2', () => modelRuntime.getAuth('openai'));
    expect((await ofA)?.auth.apiKey).toBe('sk-client-a');
    expect((await ofB)?.auth.apiKey).toBe('sk-client-b');
  }, 60_000);

  it('never installs a runtime key override on a remote core, though this host stores keys of its own', async () => {
    targetEnvironment({});
    const setRuntimeApiKey = vi.spyOn(ModelRuntime.prototype, 'setRuntimeApiKey');
    const { host } = twoDevices(account);
    const runtime = await remoteRuntime(host, { [OPENAI_API_KEY_SECRET]: 'sk-target-secret', 'damocles.openrouter.apiKey': 'sk-or-target' });
    host.set('clientAuth', 'client-a', { providers: { anthropic: claude(), openai: openaiKey } });
    await runtime.credentialsChanged();
    expect(setRuntimeApiKey).not.toHaveBeenCalled();
  }, 60_000);

  it('a key-presence check reads the device\'s clientAuth and fetches no key', async () => {
    targetEnvironment({});
    const { host } = twoDevices(account);
    const runtime = await remoteRuntime(host);
    host.setActing('client-a');
    expect(clientHasKey(host.remote, 'openai')).toBe(true);
    expect(runtime.getOpenAIAuthStatus()).toMatchObject({ apiKey: true });
    expect(host.remote.credentials).not.toHaveBeenCalled();
  }, 60_000);

  it('a provider the device holds no credential for resolves through the target\'s environment, marked as the host\'s, even with the device away', async () => {
    targetEnvironment({ OPENAI_API_KEY: HOST_ENV_KEY });
    const { host, detach } = twoDevices(account);
    host.set('clientAuth', 'client-a', { providers: { anthropic: claude() } });
    const runtime = await remoteRuntime(host);
    const modelRuntime = runtime.modelRuntime!;
    host.setActing('client-a');
    detach('client-a');
    const signIn = { raise: vi.fn(() => ({ dispose: vi.fn() })) };
    const auth = await runPinnedTurn(host.remote, 'panel-1', () => modelRuntime.getAuth('openai'), signIn);
    expect(auth?.auth.apiKey).toBe(HOST_ENV_KEY);
    expect(signIn.raise).not.toHaveBeenCalled();
    const gpt = DEFAULT_MODELS.find((info) => info.backend === 'openai' && modelRuntime.getModel('openai', info.openaiModelId ?? info.value))!;
    const [marked] = markCredentialSources([gpt], runtime.modelLookup!, runtime.getOpenAIAuthStatus(), false, (provider) => clientHasCredential(host.remote, provider), (provider) => runtime.hostHasOwnAuth(provider));
    expect(marked).toEqual({ ...gpt, credentialSource: 'host' });
  }, 60_000);
});
