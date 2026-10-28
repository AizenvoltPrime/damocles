import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakePlatform } from '../../../__mocks__/fake-platform';
import { createFakeRemoteHost } from '../../../__mocks__/fake-remote-host';
import { installPlatform, platform } from '../../platform-host';
import { installLogSink } from '../../logger';
import { asClient, runPinnedTurn } from '../../client-snapshots';
import { readAuthFile } from '../auth-file';
import { PiRuntime } from '../pi-runtime';
import { readOpenAIAuthFromDisk } from '../openai-auth';
import { syncOpenAIRuntimeKey } from '../openai-runtime-key';
import { readClaudeAuthFromDisk, SUBSCRIPTION_SOURCE } from '../subscription';
import { fetchSubscriptionUsage } from '../subscription-usage';
import { providerAuthStatus } from '../../chat-panel/settings-manager/managers/provider-keys';
import { memoryJudgeStatus } from '../../chat-panel/settings-manager/managers/memory-judge-status';
import { openaiAuthStatusMessage } from '../../chat-panel/message-router/handlers/openai-handlers';

// A daemon's core: the target's auth.json holds a stale grant that must never be read for account state.
let agentDir: string;

beforeEach(() => {
  agentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'damocles-auth-snapshot-'));
  fs.writeFileSync(path.join(agentDir, 'auth.json'), JSON.stringify({ anthropic: { type: 'oauth', access: 'TARGET', refresh: 'TARGET', expires: 1 } }));
});

afterEach(() => {
  installPlatform(createFakePlatform());
  fs.rmSync(agentDir, { recursive: true, force: true });
});

function remoteCore() {
  const host = createFakeRemoteHost();
  installPlatform({ ...createFakePlatform(), remote: host.remote });
  host.set('clientAuth', 'client-a', {
    providers: {
      openai: { type: 'oauth', expires: 123, hasKey: true, flatFee: false },
      'openai-codex': { type: 'none', hasKey: false, flatFee: false },
      anthropic: { type: 'api_key', hasKey: true, flatFee: false },
    },
  });
  host.set('clientAuth', 'client-b', { providers: { anthropic: { type: 'oauth', expires: 7, hasKey: false, flatFee: false } } });
  return host;
}

describe('readAuthFile on a daemon\'s core', () => {
  it('returns the acting client\'s clientAuth entries in auth.json\'s shape, never the target\'s file', () => {
    remoteCore();
    expect(readAuthFile(agentDir)).toEqual({ openai: { type: 'oauth', expires: 123 }, anthropic: { type: 'api_key' } });
  });

  it('every reader follows it: OpenAI and Claude account state come from the client', () => {
    remoteCore();
    expect(readOpenAIAuthFromDisk(agentDir)).toEqual({ chatgpt: true, chatgptExpires: 123, codex: false, storedApiKey: false });
    expect(readClaudeAuthFromDisk(agentDir)).toEqual({ mode: 'apikey' });
  });

  it('a turn reads the entry of the client it pinned', async () => {
    const host = remoteCore();
    const mode = await runPinnedTurn(host.remote, 'p1', async () => {
      await Promise.resolve();
      host.setActing('client-b');
      return readClaudeAuthFromDisk(agentDir).mode;
    });
    expect(mode).toBe('apikey');
    expect(readClaudeAuthFromDisk(agentDir).mode).not.toBe('apikey');
  });

  it('the OpenAI key sync installs no runtime key and reads key presence from clientAuth, never fetching a key', async () => {
    const host = remoteCore();
    const modelRuntime = { setRuntimeApiKey: vi.fn(), removeRuntimeApiKey: vi.fn() };
    const secrets = { get: vi.fn(async () => 'sk-should-not-be-read') };
    const presence = vi.fn();
    await syncOpenAIRuntimeKey({ modelRuntime, secrets, agentDir, preferApiKey: true, onKeyPresence: presence, remote: host.remote });
    expect(presence).toHaveBeenCalledWith(true);
    expect(secrets.get).not.toHaveBeenCalled();
    expect(modelRuntime.setRuntimeApiKey).not.toHaveBeenCalled();
    expect(modelRuntime.removeRuntimeApiKey).not.toHaveBeenCalled();
  });
});

describe('key-presence checks on a daemon\'s core', () => {
  it('read the client\'s hasKey flags and never read a secret', async () => {
    const host = createFakeRemoteHost();
    const fake = createFakePlatform();
    const secrets = { ...fake.secrets, get: vi.fn(async () => 'sk-should-not-be-read') };
    const platform = { ...fake, secrets, remote: host.remote };
    installPlatform(platform);
    host.set('clientAuth', 'client-a', { providers: {
      deepseek: { type: 'api_key', hasKey: true, flatFee: false },
      xai: { type: 'oauth', hasKey: false, flatFee: false, expires: 5_000 },
      openai: { type: 'none', hasKey: true, flatFee: false },
    } });
    // which credential is active is the client's to say, so a daemon's core omits it
    expect(await providerAuthStatus(platform, 'deepseek')).toEqual({ type: 'providerAuthStatusChanged', provider: 'deepseek', configured: true, external: null, signedIn: false, preferApiKey: false });
    expect(await providerAuthStatus(platform, 'xai')).toEqual({
      type: 'providerAuthStatusChanged', provider: 'xai', configured: false, external: null, signedIn: true, signedInExpiresAt: 5_000, preferApiKey: false,
    });
    expect(await providerAuthStatus(platform, 'stepfun')).toMatchObject({ configured: false });
    const openai = await openaiAuthStatusMessage(platform);
    expect(openai.status.apikey).toEqual({ configured: true });
    expect(openai).not.toHaveProperty('active');
    const judge = await memoryJudgeStatus(platform);
    expect(judge.classifierCredentials.typesafe).not.toBe('ok');
    expect(secrets.get).not.toHaveBeenCalled();
  });
});

describe('a key provider\'s saved key on a daemon\'s core', () => {
  it('is the client\'s keySaved, which counts a key its sign-in outranks and no key pi holds from elsewhere', async () => {
    const host = createFakeRemoteHost();
    const platform = { ...createFakePlatform(), remote: host.remote };
    installPlatform(platform);
    host.set('clientAuth', 'client-a', { providers: {
      xai: { type: 'oauth', hasKey: false, keySaved: true, flatFee: false, expires: 5_000 },
      deepseek: { type: 'api_key', hasKey: true, keySaved: false, flatFee: false },
      openrouter: { type: 'oauth', hasKey: false, keySaved: false, flatFee: false },
      // a client that has not synced its keys yet
      minimax: { type: 'api_key', hasKey: true, flatFee: false },
    } });
    expect(await providerAuthStatus(platform, 'xai')).toEqual({
      type: 'providerAuthStatusChanged', provider: 'xai', configured: true, external: null, signedIn: true, signedInExpiresAt: 5_000, preferApiKey: false,
    });
    expect(await providerAuthStatus(platform, 'deepseek')).toMatchObject({ configured: false });
    expect(await providerAuthStatus(platform, 'minimax')).toMatchObject({ configured: true });
    // before pi starts, the judge counts the client's OpenRouter sign-in as the key status does
    expect((await memoryJudgeStatus(platform)).classifierCredentials.openrouter).toBe('ok');
  });
});

describe('subscription usage on a daemon\'s core', () => {
  it('is never fetched, so a turn\'s settle or a rate limit pulls no other provider\'s token from the client', async () => {
    remoteCore();
    const tokenRead = vi.fn(async () => 'TOKEN');
    const runtime = { getClaudeAccessToken: tokenRead, getChatGPTAccessToken: tokenRead, getCodexAccessToken: tokenRead, getOpenAIAuthStatus: () => ({ apiKey: false, chatgpt: true, codex: true }) };
    const usage = await fetchSubscriptionUsage(runtime as never);
    expect(tokenRead).not.toHaveBeenCalled();
    expect([usage.claude.status, usage.gpt.status]).toEqual(['error', 'error']);
  });

  it('says why in the user\'s language', async () => {
    remoteCore();
    vi.spyOn(platform().localization, 't').mockImplementation((message) => `el:${message}`);
    const usage = await fetchSubscriptionUsage({} as never);
    expect(usage.claude.error).toBe('el:Subscription usage is read on your computer, not on a remote host');
  });
});

describe('this computer\'s clientAuth snapshot', () => {
  afterEach(async () => {
    await PiRuntime.disposeInstance();
  });

  it('marks a key provider whose applied key bills a flat subscription, never sending the key', async () => {
    const runtime = PiRuntime.get(agentDir);
    await runtime.init();
    await runtime.syncCustomProviders(async (key) => (key === 'damocles.minimax.apiKey' ? 'sk-cp-plan' : key === 'damocles.deepseek.apiKey' ? 'sk-metered' : undefined));
    const snapshot = await runtime.clientAuthSnapshot();
    expect(snapshot.providers['minimax']).toMatchObject({ flatFee: true });
    expect(snapshot.providers['deepseek']).toMatchObject({ flatFee: false });
    expect(JSON.stringify(snapshot)).not.toContain('sk-');
  }, 60_000);

  it('sends a saved key its sign-in outranks as keySaved, while hasKey stays the key pi holds, and signals the change', async () => {
    fs.writeFileSync(path.join(agentDir, 'auth.json'), JSON.stringify({ xai: { type: 'oauth', access: 'a', refresh: 'r', expires: 9_999_999_999_999 } }));
    const runtime = PiRuntime.get(agentDir);
    await runtime.init();
    await runtime.syncCustomProviders(async () => undefined);
    const auth = vi.fn();
    const stopAuth = PiRuntime.onClientAuthChange(auth);
    // nothing pi holds changes: the sign-in outranks the key, so only keySaved does
    await runtime.syncCustomProviders(async (key) => (key === 'damocles.xai.apiKey' ? 'xai-key' : undefined));
    stopAuth();
    expect(auth).toHaveBeenCalled();
    const snapshot = await runtime.clientAuthSnapshot();
    expect(snapshot.providers['xai']).toMatchObject({ type: 'oauth', hasKey: false, keySaved: true });
    expect(snapshot.providers['deepseek']).toMatchObject({ hasKey: false, keySaved: false });
    expect(JSON.stringify(snapshot)).not.toContain('xai-key');
  }, 60_000);

  it('sends each prefer-API-key flag that is on, and signals a key provider\'s flag change that changes no key pi holds', async () => {
    const runtime = PiRuntime.get(agentDir);
    await runtime.init();
    const xaiKey = async (key: string) => (key === 'damocles.xai.apiKey' ? 'xai-key' : undefined);
    await runtime.syncCustomProviders(xaiKey);
    const auth = vi.fn();
    const stopAuth = PiRuntime.onClientAuthChange(auth);
    // no sign-in, so the key stays applied whatever the flag says
    await platform().state.global.update('damocles.xai.preferApiKey', true);
    await runtime.syncCustomProviders(xaiKey);
    stopAuth();
    expect(auth).toHaveBeenCalled();
    await platform().state.global.update('damocles.openai.preferApiKey', true);
    const snapshot = await runtime.clientAuthSnapshot();
    expect([snapshot.providers['xai']?.preferApiKey, snapshot.providers['openai']?.preferApiKey]).toEqual([true, true]);
    expect(snapshot.providers['deepseek']).not.toHaveProperty('preferApiKey');
  }, 60_000);

  it('marks a Claude sign-in that bills the allowance, so a daemon can bill its requests the same way', async () => {
    const runtime = PiRuntime.get(agentDir);
    await runtime.init();
    expect((await runtime.clientAuthSnapshot()).providers['anthropic']).toEqual({ type: 'oauth', expires: 1, hasKey: false, flatFee: false });
    fs.writeFileSync(path.join(agentDir, 'settings.json'), JSON.stringify({ packages: [SUBSCRIPTION_SOURCE] }));
    expect((await runtime.clientAuthSnapshot()).providers['anthropic']).toEqual({ type: 'oauth', expires: 1, hasKey: false, flatFee: false, allowance: true });
  }, 60_000);

  it('signals a clientAuth change for a credential change, never for a judge-only change', async () => {
    const runtime = PiRuntime.get(agentDir);
    await runtime.init();
    const auth = vi.fn();
    const stopAuth = PiRuntime.onClientAuthChange(auth);
    await platform().settings.update('damocles.memory.judge', 'off', 'user');
    expect(auth).not.toHaveBeenCalled();
    PiRuntime.notifyMemoryJudgeChange();
    expect(auth).toHaveBeenCalledTimes(1);
    stopAuth();
  }, 60_000);
});

describe('OpenAI account state on a daemon\'s core', () => {
  afterEach(async () => {
    await PiRuntime.disposeInstance();
  });

  it('reads the key of the client a turn pins, else the acting one, never the one the last key sync saw', () => {
    const host = createFakeRemoteHost();
    installPlatform({ ...createFakePlatform(), remote: host.remote });
    host.set('clientAuth', 'client-a', { providers: { openai: { type: 'none', hasKey: true, flatFee: false } } });
    host.set('clientAuth', 'client-b', { providers: { openai: { type: 'none', hasKey: false, flatFee: false } } });
    const runtime = PiRuntime.get(agentDir);
    // what a key sync under client-a recorded
    (runtime as unknown as { _openaiKeyPresent: boolean })._openaiKeyPresent = true;
    host.setActing('client-b');
    expect(runtime.getOpenAIAuthStatus().apiKey).toBe(false);
    host.setActing('client-a');
    const pinnedToA = runPinnedTurn(host.remote, 'p1', () => {
      host.setActing('client-b');
      return runtime.getOpenAIAuthStatus().apiKey;
    });
    expect(pinnedToA).toBe(true);
  });

  it('reads the prefer-API-key flags of the client it reads as, never the acting client\'s state mirror', async () => {
    const host = createFakeRemoteHost();
    const fake = createFakePlatform();
    installPlatform({ ...fake, remote: host.remote });
    await fake.state.global.update('damocles.openai.preferApiKey', true);
    await fake.state.global.update('damocles.xai.preferApiKey', true);
    const signedInWithKey = { type: 'oauth', expires: 9_999_999_999_999, hasKey: true, flatFee: false } as const;
    host.set('clientAuth', 'client-a', { providers: { openai: { ...signedInWithKey, preferApiKey: true }, xai: { ...signedInWithKey, preferApiKey: true } } });
    host.set('clientAuth', 'client-b', { providers: { openai: signedInWithKey, xai: signedInWithKey } });
    host.setActing('client-a');
    const runtime = PiRuntime.get(agentDir);

    const flags = (clientId: string) => asClient(host.remote, clientId, () => [runtime.preferOpenAIApiKey(), runtime.preferProviderApiKey('xai')]);
    expect([flags('client-a'), flags('client-b')]).toEqual([[true, true], [false, false]]);
    await PiRuntime.disposeInstance();
    // before pi starts, the judge reads them too: the preferred key is the request credential, else the sign-in is
    const judge = (clientId: string) => asClient(host.remote, clientId, () => memoryJudgeStatus(platform())).then((status) => status.classifierCredentials.openai);
    expect([await judge('client-a'), await judge('client-b')]).toEqual(['ok', 'chatgpt-active']);
  });
});

describe('a clientAuth delta on a daemon\'s core', () => {
  afterEach(async () => {
    await PiRuntime.disposeInstance();
  });

  it('logs a failed application of the change instead of leaving its rejection unhandled', async () => {
    const host = remoteCore();
    const runtime = PiRuntime.get(agentDir);
    await runtime.init();
    const lines: string[] = [];
    installLogSink({ appendLine: (line: string) => void lines.push(line), show: () => {}, dispose: () => {} });
    vi.spyOn(runtime, 'credentialsChanged').mockRejectedValue(new Error('refresh broke'));
    host.set('clientAuth', 'client-a', { providers: { anthropic: { type: 'none', hasKey: false, flatFee: false } } });
    await vi.waitFor(() => expect(lines.some((line) => line.includes('applying a clientAuth change failed') && line.includes('refresh broke'))).toBe(true));
  }, 60_000);
});
