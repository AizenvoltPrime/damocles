import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';

const H = vi.hoisted(() => {
  const fakePi = {
    createAgentSessionServices: vi.fn(),
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

vi.mock('../agent-dir', () => ({
  ensurePiAgentDir: (dir: string) => dir,
  PI_AGENT_DIR: '/fake/agent',
}));

import { PiRuntime } from '../pi-runtime';
import { readOpenAIAuthFromDisk } from '../openai-auth';

type Cred = { type: string; key?: string; expires?: number };

function makeServices() {
  const state: Record<string, Cred> = {};
  const authStorage = {
    set: vi.fn((provider: string, cred: Cred) => { state[provider] = cred; }),
    remove: vi.fn((provider: string) => { delete state[provider]; }),
    logout: vi.fn((provider: string) => { delete state[provider]; }),
    login: vi.fn(async (provider: string) => { state[provider] = { type: 'oauth', expires: 123 }; }),
    get: vi.fn((provider: string) => state[provider]),
    has: vi.fn((provider: string) => provider in state),
    hasAuth: vi.fn((provider: string) => provider in state),
  };
  const modelRegistry = { refresh: vi.fn(), getAvailable: () => [] };
  return {
    state,
    authStorage,
    modelRegistry,
    services: { cwd: '/cwd', agentDir: '/agent', authStorage, settingsManager: {}, modelRegistry, resourceLoader: {}, diagnostics: [] },
  };
}

describe('PiRuntime OpenAI/Codex auth', () => {
  let mock: ReturnType<typeof makeServices>;

  beforeEach(() => {
    H.ctrl.loadable = true;
    mock = makeServices();
    H.fakePi.createAgentSessionServices = vi.fn().mockResolvedValue(mock.services);
  });
  afterEach(async () => {
    await PiRuntime.disposeInstance();
  });

  it('setOpenAIApiKey stores an api_key under "openai" and refreshes the registry', async () => {
    const rt = PiRuntime.get('/cwd', '/agent');
    const status = await rt.setOpenAIApiKey('sk-test');
    expect(mock.authStorage.set).toHaveBeenCalledWith('openai', { type: 'api_key', key: 'sk-test' });
    expect(mock.modelRegistry.refresh).toHaveBeenCalled();
    expect(status).toEqual({ apiKey: true, codex: false });
  });

  it('signInCodex logs in to "openai-codex" with onSelect resolving to "browser"', async () => {
    const rt = PiRuntime.get('/cwd', '/agent');
    await rt.signInCodex({ onAuth: vi.fn(), onDeviceCode: vi.fn(), onPrompt: vi.fn(async () => '') });
    expect(mock.authStorage.login).toHaveBeenCalledTimes(1);
    const call = mock.authStorage.login.mock.calls[0] as unknown as [string, { onSelect: (p: unknown) => Promise<string | undefined> }];
    expect(call[0]).toBe('openai-codex');
    await expect(call[1].onSelect({ message: '', options: [] })).resolves.toBe('browser');
  });

  it('reports api-key and codex status independently', async () => {
    const rt = PiRuntime.get('/cwd', '/agent');

    await rt.setOpenAIApiKey('sk-test');
    expect(rt.getOpenAIAuthStatus()).toEqual({ apiKey: true, codex: false });

    await rt.signInCodex({ onAuth: vi.fn(), onDeviceCode: vi.fn(), onPrompt: vi.fn(async () => '') });
    expect(rt.getOpenAIAuthStatus()).toEqual({ apiKey: true, codex: true, codexExpires: 123 });

    rt.clearOpenAIApiKey();
    expect(rt.getOpenAIAuthStatus()).toEqual({ apiKey: false, codex: true, codexExpires: 123 });

    rt.signOutCodex();
    expect(rt.getOpenAIAuthStatus()).toEqual({ apiKey: false, codex: false });
  });
});

describe('readOpenAIAuthFromDisk', () => {
  it('reads independent openai + openai-codex creds from auth.json', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-oai-'));
    try {
      fs.writeFileSync(
        path.join(dir, 'auth.json'),
        JSON.stringify({
          openai: { type: 'api_key', key: 'sk-x' },
          'openai-codex': { type: 'oauth', expires: 999, access: 'a', refresh: 'r' },
        }),
      );
      expect(readOpenAIAuthFromDisk(dir)).toEqual({ apiKey: true, codex: true, codexExpires: 999 });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns all-false when auth.json is missing', () => {
    expect(readOpenAIAuthFromDisk(path.join(os.tmpdir(), 'pi-oai-missing-zzz'))).toEqual({ apiKey: false, codex: false });
  });
});
