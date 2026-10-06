import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';

const H = vi.hoisted(() => {
  const fakePi = {
    createAgentSessionServices: vi.fn(),
    ModelRuntime: { create: vi.fn() },
    SettingsManager: { create: vi.fn(() => ({ getOrCreateDeviceId: () => '0b9c2f2e-6a0c-4c5e-9d41-3f1f0e6c2a11' })) },
    DefaultPackageManager: class {
      getInstalledPath(): string | undefined {
        return undefined;
      }
    },
  };
  return { fakePi, ctrl: { loadable: true } };
});

vi.mock('../pi-loader', () => ({
  initPiLoader: vi.fn(async () => (H.ctrl.loadable ? H.fakePi : null)),
  getPiCodingAgent: vi.fn(() => (H.ctrl.loadable ? H.fakePi : null)),
  PI_MIN_NODE_MAJOR: 22,
  nodeSupportsPi: () => true,
}));

// Only the fs-touching seed is stubbed; `cacheWarmingSetting` stays real so the mode a test configures
// travels the production path.
vi.mock('../agent-dir', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../agent-dir')>()),
  ensurePiAgentDir: (dir: string) => dir,
  PI_AGENT_DIR: '/fake/agent',
}));

import type { AuthInteraction } from '@earendil-works/pi-ai';
import { installFakePlatform, type FakePlatform } from '../../../__mocks__/fake-platform';
import { PiRuntime } from '../pi-runtime';
import { OPENAI_API_KEY_SECRET, OPENAI_PREFER_API_KEY_STATE, openaiRuntimeKeyWanted, readOpenAIAuthFromDisk } from '../openai-auth';

type Cred = { type: string; key?: string; expires?: number };

const DEVICE_ID = '0b9c2f2e-6a0c-4c5e-9d41-3f1f0e6c2a11';

/**
 * A ModelRuntime mock backed by a real auth.json on disk, so `getOpenAIAuthStatus` observes every
 * login/logout. It models pi's runtime key overlay: `getAuth` returns it before the stored credential,
 * and `logout` drops it.
 */
function makeServices(agentDir: string) {
  const authFile = path.join(agentDir, 'auth.json');
  const readState = (): Record<string, Cred> => {
    try { return JSON.parse(fs.readFileSync(authFile, 'utf8')); } catch { return {}; }
  };
  const writeState = (state: Record<string, Cred>) => fs.writeFileSync(authFile, JSON.stringify(state));
  const runtimeKeys = new Map<string, string>();
  const modelRuntime = {
    runtimeKeys,
    login: vi.fn(async (provider: string, type: 'oauth' | 'api_key', interaction: AuthInteraction, _options?: { getDeviceId?: () => string }) => {
      const state = readState();
      // pi's api_key login asks the interaction for the key and replaces the provider's one auth.json slot.
      state[provider] = type === 'api_key'
        ? { type: 'api_key', key: await interaction.prompt({ type: 'text', message: 'API key' } as never) }
        : { type: 'oauth', expires: 123 };
      writeState(state);
      return { type };
    }),
    logout: vi.fn(async (provider: string) => {
      const state = readState();
      delete state[provider];
      writeState(state);
      runtimeKeys.delete(provider);
    }),
    setRuntimeApiKey: vi.fn(async (provider: string, key: string) => {
      runtimeKeys.set(provider, key);
    }),
    removeRuntimeApiKey: vi.fn(async (provider: string) => {
      runtimeKeys.delete(provider);
    }),
    getAuth: vi.fn(async (provider: string) => {
      const override = runtimeKeys.get(provider);
      if (override) return { auth: { apiKey: override }, source: 'runtime' };
      const cred = readState()[provider];
      if (cred?.type === 'oauth') return { auth: { apiKey: `token-${provider}` }, source: 'OAuth' };
      if (cred?.type === 'api_key') return { auth: { apiKey: cred.key }, source: 'stored credential' };
      return undefined;
    }),
    getModel: vi.fn(() => undefined),
    hasConfiguredAuth: vi.fn((provider: string) => provider in readState()),
    getAvailableSnapshot: vi.fn(() => []),
    registerProvider: vi.fn(),
    unregisterProvider: vi.fn(),
    refresh: vi.fn(async () => ({ aborted: false, errors: new Map() })),
    completeSimple: vi.fn(),
  };
  return { modelRuntime, readState, writeState };
}

function callerInteraction(): AuthInteraction {
  return { prompt: vi.fn(async () => ''), notify: vi.fn() };
}

describe('PiRuntime OpenAI auth', () => {
  let agentDir: string;
  let mock: ReturnType<typeof makeServices>;
  let platform: FakePlatform;

  beforeEach(() => {
    H.ctrl.loadable = true;
    platform = installFakePlatform();
    agentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-oai-rt-'));
    mock = makeServices(agentDir);
    H.fakePi.ModelRuntime.create = vi.fn().mockResolvedValue(mock.modelRuntime);
  });
  afterEach(async () => {
    await PiRuntime.disposeInstance();
    fs.rmSync(agentDir, { recursive: true, force: true });
  });

  it('init moves an auth.json key into the secret store before the auth.json watcher exists, then applies it', async () => {
    mock.writeState({ openai: { type: 'api_key', key: 'sk-plain' } });
    let watcherAtLogout: boolean | undefined;
    mock.modelRuntime.logout.mockImplementationOnce(async (provider: string) => {
      watcherAtLogout = platform.fileWatchers.watchers.some((w) => w.glob === 'auth.json');
      const state = mock.readState();
      delete state[provider];
      mock.writeState(state);
      mock.modelRuntime.runtimeKeys.delete(provider);
    });
    const rt = PiRuntime.get(agentDir);

    await rt.init();

    expect(watcherAtLogout).toBe(false);
    expect(platform.fileWatchers.watchers.some((w) => w.glob === 'auth.json')).toBe(true);
    expect(platform.secrets.entries.get(OPENAI_API_KEY_SECRET)).toBe('sk-plain');
    expect(mock.readState()).toEqual({});
    expect(mock.modelRuntime.runtimeKeys.get('openai')).toBe('sk-plain');
    expect(rt.getOpenAIAuthStatus()).toEqual({ apiKey: true, chatgpt: false, codex: false });
  });

  it('tells auth-file listeners after an outside change to auth.json was republished', async () => {
    const rt = PiRuntime.get(agentDir);
    await rt.init();
    const heard = vi.fn();
    const stop = PiRuntime.onAuthFileChange(heard);
    mock.writeState({ anthropic: { type: 'api_key', key: 'sk-ant' } });
    platform.fileWatchers.watcher(agentDir, 'auth.json').fireChange(path.join(agentDir, 'auth.json'));
    await vi.waitFor(() => expect(heard).toHaveBeenCalledOnce());
    stop();
  });

  it('setOpenAIApiKey writes only the secret, never auth.json, and applies the runtime key', async () => {
    const rt = PiRuntime.get(agentDir);
    const status = await rt.setOpenAIApiKey('sk-test');
    expect(platform.secrets.entries.get(OPENAI_API_KEY_SECRET)).toBe('sk-test');
    expect(mock.modelRuntime.login).not.toHaveBeenCalled();
    expect(mock.readState()).toEqual({});
    expect(mock.modelRuntime.runtimeKeys.get('openai')).toBe('sk-test');
    expect(status).toEqual({ apiKey: true, chatgpt: false, codex: false });
  });

  it('clearOpenAIApiKey deletes the secret and the runtime key and never logs out', async () => {
    const rt = PiRuntime.get(agentDir);
    await rt.setOpenAIApiKey('sk-test');
    const status = await rt.clearOpenAIApiKey();
    expect(platform.secrets.entries.has(OPENAI_API_KEY_SECRET)).toBe(false);
    expect(mock.modelRuntime.runtimeKeys.has('openai')).toBe(false);
    expect(mock.modelRuntime.logout).not.toHaveBeenCalled();
    expect(status).toEqual({ apiKey: false, chatgpt: false, codex: false });
  });

  it('signInChatGPT logs in to openai with the user settings device id, removes the Codex grant and re-applies the rule', async () => {
    mock.writeState({ 'openai-codex': { type: 'oauth', expires: 9 } });
    const rt = PiRuntime.get(agentDir);
    const folder = vi.spyOn(rt, 'folder');
    await rt.setOpenAIApiKey('sk-test');
    expect(mock.modelRuntime.runtimeKeys.get('openai')).toBe('sk-test');

    const status = await rt.signInChatGPT(callerInteraction());

    const [provider, type, , options] = mock.modelRuntime.login.mock.calls[0]!;
    expect([provider, type]).toEqual(['openai', 'oauth']);
    expect(options?.getDeviceId?.()).toBe(DEVICE_ID);
    // Process-wide: one settings manager mints the id, and no folder runtime is built for it.
    expect(H.fakePi.SettingsManager.create).toHaveBeenCalledWith(agentDir, agentDir);
    expect(folder).not.toHaveBeenCalled();
    expect(mock.modelRuntime.logout).toHaveBeenCalledWith('openai-codex');
    // pi's login keeps the runtime key; the rule no longer wants it once ChatGPT is signed in.
    expect(mock.modelRuntime.runtimeKeys.has('openai')).toBe(false);
    expect(status).toEqual({ apiKey: true, chatgpt: true, chatgptExpires: 123, codex: false });
  });

  it('signOutChatGPT logs out openai and re-applies the key that the logout dropped', async () => {
    mock.writeState({ openai: { type: 'oauth', expires: 5 } });
    const rt = PiRuntime.get(agentDir);
    await platform.state.workspace.update(OPENAI_PREFER_API_KEY_STATE, true);
    await rt.setOpenAIApiKey('sk-test');
    expect(mock.modelRuntime.runtimeKeys.get('openai')).toBe('sk-test');

    const status = await rt.signOutChatGPT();

    expect(mock.modelRuntime.logout).toHaveBeenCalledWith('openai');
    expect(mock.modelRuntime.runtimeKeys.get('openai')).toBe('sk-test');
    expect(status).toEqual({ apiKey: true, chatgpt: false, codex: false });
  });

  it('signOutCodex removes only the Codex grant', async () => {
    mock.writeState({ openai: { type: 'oauth', expires: 5 }, 'openai-codex': { type: 'oauth', expires: 9 } });
    const rt = PiRuntime.get(agentDir);
    const status = await rt.signOutCodex();
    expect(mock.modelRuntime.logout).toHaveBeenCalledWith('openai-codex');
    expect(mock.modelRuntime.logout).not.toHaveBeenCalledWith('openai');
    expect(status).toEqual({ apiKey: false, chatgpt: true, chatgptExpires: 5, codex: false });
  });

  it('getChatGPTAccessToken returns the grant only while ChatGPT is the active credential, never the API key', async () => {
    mock.writeState({ openai: { type: 'oauth', expires: 5 } });
    const rt = PiRuntime.get(agentDir);
    expect(await rt.getChatGPTAccessToken()).toBe('token-openai');

    await rt.setOpenAIApiKey('sk-test');
    expect(await rt.getChatGPTAccessToken()).toBe('token-openai');

    await platform.state.workspace.update(OPENAI_PREFER_API_KEY_STATE, true);
    await rt.syncOpenAIRuntimeKey();
    expect(await rt.getChatGPTAccessToken()).toBeUndefined();
  });

  it('getChatGPTAccessToken refuses a non-OAuth resolution', async () => {
    mock.writeState({ openai: { type: 'oauth', expires: 5 } });
    const rt = PiRuntime.get(agentDir);
    await rt.init();
    mock.modelRuntime.runtimeKeys.set('openai', 'sk-stray');
    expect(await rt.getChatGPTAccessToken()).toBeUndefined();
  });

  it('re-syncs when another window changes the key secret', async () => {
    const rt = PiRuntime.get(agentDir);
    await rt.init();
    await platform.secrets.store(OPENAI_API_KEY_SECRET, 'sk-other-window');
    await vi.waitFor(() => expect(mock.modelRuntime.runtimeKeys.get('openai')).toBe('sk-other-window'));
    expect(rt.getOpenAIAuthStatus().apiKey).toBe(true);

    await platform.secrets.delete(OPENAI_API_KEY_SECRET);
    await vi.waitFor(() => expect(mock.modelRuntime.runtimeKeys.has('openai')).toBe(false));
    expect(rt.getOpenAIAuthStatus().apiKey).toBe(false);
  });

  it('a flow abort ends a sign-in that holds the credential chain, and a sign-out queued behind it then runs', async () => {
    const rt = PiRuntime.get(agentDir);
    const abort = new AbortController();
    mock.modelRuntime.login.mockImplementationOnce((_p, _t, interaction) =>
      new Promise((_resolve, reject) => interaction.signal!.addEventListener('abort', () => reject(new Error('Login cancelled')))),
    );
    const signIn = rt.signInChatGPT({ ...callerInteraction(), signal: abort.signal });
    await vi.waitFor(() => expect(mock.modelRuntime.login).toHaveBeenCalled());

    abort.abort();
    await expect(signIn).rejects.toThrow('Login cancelled');
    await expect(rt.signOutChatGPT()).resolves.toEqual({ apiKey: false, chatgpt: false, codex: false });
  });

  it('republishes the account state on a key secret change while a pending sign-in holds the chain', async () => {
    const rt = PiRuntime.get(agentDir);
    await rt.init();
    const session = { publishAccountInfo: vi.fn() };
    rt.registerSessionMutator('s1', session as never);
    const abort = new AbortController();
    mock.modelRuntime.login.mockImplementationOnce((_p, _t, interaction) =>
      new Promise((_resolve, reject) => interaction.signal!.addEventListener('abort', () => reject(new Error('Login cancelled')))),
    );
    const signIn = rt.signInChatGPT({ ...callerInteraction(), signal: abort.signal });
    await vi.waitFor(() => expect(mock.modelRuntime.login).toHaveBeenCalled());

    await platform.secrets.store(OPENAI_API_KEY_SECRET, 'sk-other-window');
    await vi.waitFor(() => expect(session.publishAccountInfo).toHaveBeenCalledTimes(1));

    abort.abort();
    await expect(signIn).rejects.toThrow('Login cancelled');
    await vi.waitFor(() => expect(session.publishAccountInfo).toHaveBeenCalledTimes(2));
    expect(mock.modelRuntime.runtimeKeys.get('openai')).toBe('sk-other-window');
  });

  it('reports a sign-in that pi stored before a CredentialSynchronizationError as signed in', async () => {
    mock.writeState({ 'openai-codex': { type: 'oauth', expires: 9 } });
    const rt = PiRuntime.get(agentDir);
    mock.modelRuntime.login.mockImplementationOnce(async (provider: string) => {
      mock.writeState({ ...mock.readState(), [provider]: { type: 'oauth', expires: 123 } });
      throw Object.assign(new Error('Credential login committed for openai, but local synchronization failed'), {
        name: 'CredentialSynchronizationError',
      });
    });

    await expect(rt.signInChatGPT(callerInteraction())).resolves.toEqual({ apiKey: false, chatgpt: true, chatgptExpires: 123, codex: false });
    expect(mock.modelRuntime.logout).toHaveBeenCalledWith('openai-codex');
  });

  it('reports a sign-in as signed in when removing the legacy Codex grant afterwards fails', async () => {
    mock.writeState({ 'openai-codex': { type: 'oauth', expires: 9 } });
    const rt = PiRuntime.get(agentDir);
    mock.modelRuntime.logout.mockRejectedValueOnce(new Error('auth.json is locked'));

    await expect(rt.signInChatGPT(callerInteraction())).resolves.toEqual({
      apiKey: false,
      chatgpt: true,
      chatgptExpires: 123,
      codex: true,
      codexExpires: 9,
    });
  });

  it('keeps the key presence current when pi fails after a secret change from another window', async () => {
    const rt = PiRuntime.get(agentDir);
    await rt.init();
    mock.modelRuntime.setRuntimeApiKey.mockRejectedValueOnce(new Error('refresh failed'));

    await platform.secrets.store(OPENAI_API_KEY_SECRET, 'sk-other-window');

    await vi.waitFor(() => expect(mock.modelRuntime.setRuntimeApiKey).toHaveBeenCalled());
    await vi.waitFor(() => expect(rt.getOpenAIAuthStatus().apiKey).toBe(true));
  });

  it('applies a secret change made while init reads the secret', async () => {
    let releaseFirstRead!: () => void;
    const firstReadReleased = new Promise<void>((resolve) => { releaseFirstRead = resolve; });
    const realGet = platform.secrets.get;
    let reads = 0;
    platform.secrets.get = async (name: string) => {
      const value = await realGet(name);
      if (name === OPENAI_API_KEY_SECRET && reads++ === 0) await firstReadReleased;
      return value;
    };
    const rt = PiRuntime.get(agentDir);
    const init = rt.init();
    await vi.waitFor(() => expect(reads).toBe(1));

    await platform.secrets.store(OPENAI_API_KEY_SECRET, 'sk-during-init');
    releaseFirstRead();
    await init;

    await vi.waitFor(() => expect(mock.modelRuntime.runtimeKeys.get('openai')).toBe('sk-during-init'));
    expect(rt.getOpenAIAuthStatus().apiKey).toBe(true);
  });

  it('a retried init keeps one key secret listener', async () => {
    const watch = platform.fileWatchers.watch;
    platform.fileWatchers.watch = () => {
      platform.fileWatchers.watch = watch;
      throw new Error('watcher unavailable');
    };
    const rt = PiRuntime.get(agentDir);
    await expect(rt.init()).rejects.toThrow('watcher unavailable');
    await rt.init();
    mock.modelRuntime.setRuntimeApiKey.mockClear();

    await platform.secrets.store(OPENAI_API_KEY_SECRET, 'sk-once');

    await vi.waitFor(() => expect(mock.modelRuntime.setRuntimeApiKey).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(mock.modelRuntime.setRuntimeApiKey).toHaveBeenCalledTimes(1);
  });

  describe('with a secret store that is not persistent', () => {
    beforeEach(() => {
      platform = installFakePlatform({ secretsPersistent: false });
    });

    it('init leaves the auth.json key where it is, counts it as configured, and pi keeps using it', async () => {
      mock.writeState({ openai: { type: 'api_key', key: 'sk-plain' } });
      const rt = PiRuntime.get(agentDir);

      await rt.init();

      expect(mock.readState()).toEqual({ openai: { type: 'api_key', key: 'sk-plain' } });
      expect(platform.secrets.entries.size).toBe(0);
      expect(mock.modelRuntime.logout).not.toHaveBeenCalled();
      expect(mock.modelRuntime.runtimeKeys.has('openai')).toBe(false);
      expect(await mock.modelRuntime.getAuth('openai')).toEqual({ auth: { apiKey: 'sk-plain' }, source: 'stored credential' });
      expect(rt.getOpenAIAuthStatus()).toEqual({ apiKey: true, chatgpt: false, codex: false });
    });

    it('setOpenAIApiKey writes the new key to auth.json, so a restart cannot bring back the previous one', async () => {
      mock.writeState({ openai: { type: 'api_key', key: 'sk-old' }, 'openai-codex': { type: 'oauth', expires: 9 } });
      const rt = PiRuntime.get(agentDir);

      const status = await rt.setOpenAIApiKey('sk-new');

      expect(mock.readState()).toEqual({ openai: { type: 'api_key', key: 'sk-new' }, 'openai-codex': { type: 'oauth', expires: 9 } });
      expect(platform.secrets.entries.size).toBe(0);
      expect(await mock.modelRuntime.getAuth('openai')).toEqual({ auth: { apiKey: 'sk-new' }, source: 'stored credential' });
      expect(status.apiKey).toBe(true);
    });

    it('setOpenAIApiKey keeps a ChatGPT grant in auth.json and holds the key for this run only', async () => {
      mock.writeState({ openai: { type: 'oauth', expires: 5 } });
      const rt = PiRuntime.get(agentDir);

      const status = await rt.setOpenAIApiKey('sk-new');

      expect(mock.readState()).toEqual({ openai: { type: 'oauth', expires: 5 } });
      expect(await platform.secrets.get(OPENAI_API_KEY_SECRET)).toBe('sk-new');
      expect(status).toMatchObject({ apiKey: true, chatgpt: true });
    });

    it('clearOpenAIApiKey also removes the key left in auth.json', async () => {
      mock.writeState({ openai: { type: 'api_key', key: 'sk-plain' }, 'openai-codex': { type: 'oauth', expires: 9 } });
      const rt = PiRuntime.get(agentDir);

      const status = await rt.clearOpenAIApiKey();

      expect(mock.readState()).toEqual({ 'openai-codex': { type: 'oauth', expires: 9 } });
      expect(status).toEqual({ apiKey: false, chatgpt: false, codex: true, codexExpires: 9 });
    });
  });
});

describe('openaiRuntimeKeyWanted', () => {
  it.each([
    [false, false, false, false],
    [false, true, true, false],
    [true, false, false, true],
    [true, false, true, true],
    [true, true, false, false],
    [true, true, true, true],
  ])('apiKey=%s chatgpt=%s prefer=%s -> %s', (apiKey, chatgpt, prefer, wanted) => {
    expect(openaiRuntimeKeyWanted({ apiKey, chatgpt }, prefer)).toBe(wanted);
  });
});

describe('readOpenAIAuthFromDisk', () => {
  it('reads the ChatGPT grant, the Codex grant and a legacy api_key from auth.json', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-oai-'));
    try {
      fs.writeFileSync(
        path.join(dir, 'auth.json'),
        JSON.stringify({
          openai: { type: 'oauth', expires: 777, access: 'a', refresh: 'r' },
          'openai-codex': { type: 'oauth', expires: 999, access: 'a', refresh: 'r' },
        }),
      );
      expect(readOpenAIAuthFromDisk(dir)).toEqual({ chatgpt: true, chatgptExpires: 777, codex: true, codexExpires: 999, storedApiKey: false });
      fs.writeFileSync(path.join(dir, 'auth.json'), JSON.stringify({ openai: { type: 'api_key', key: 'sk-x' } }));
      expect(readOpenAIAuthFromDisk(dir)).toEqual({ chatgpt: false, codex: false, storedApiKey: true });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns all-false when auth.json is missing', () => {
    expect(readOpenAIAuthFromDisk(path.join(os.tmpdir(), 'pi-oai-missing-zzz'))).toEqual({ chatgpt: false, codex: false, storedApiKey: false });
  });
});
