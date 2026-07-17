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

import type { AuthInteraction, AuthPrompt } from '@earendil-works/pi-ai';
import { PiRuntime } from '../pi-runtime';
import { readOpenAIAuthFromDisk } from '../openai-auth';

type Cred = { type: string; key?: string; expires?: number };

/**
 * A ModelRuntime mock backed by a real auth.json on disk (the "disk truth" contract): every
 * login/logout persists the credential before resolving, exactly like the production runtime, so
 * `getOpenAIAuthStatus`/`getClaudeAuthStatus` — which read the file — observe the mutation.
 */
function makeServices(agentDir: string) {
  const authFile = path.join(agentDir, 'auth.json');
  const readState = (): Record<string, Cred> => {
    try { return JSON.parse(fs.readFileSync(authFile, 'utf8')); } catch { return {}; }
  };
  const writeState = (state: Record<string, Cred>) => fs.writeFileSync(authFile, JSON.stringify(state));
  const modelRuntime = {
    // login(provider, type, interaction) — persists then "refreshes". For api_key we read the key
    // from the interaction (keyInteraction answers every prompt with the key); oauth stores a grant.
    login: vi.fn(async (provider: string, type: 'api_key' | 'oauth', interaction: AuthInteraction) => {
      const state = readState();
      if (type === 'api_key') {
        const key = await interaction.prompt({ type: 'secret', message: 'key' } as AuthPrompt);
        state[provider] = { type: 'api_key', key };
      } else {
        state[provider] = { type: 'oauth', expires: 123 };
      }
      writeState(state);
      return { type };
    }),
    logout: vi.fn(async (provider: string) => {
      const state = readState();
      delete state[provider];
      writeState(state);
    }),
    setRuntimeApiKey: vi.fn(async () => undefined),
    getAuth: vi.fn(async (provider: string) => {
      const cred = readState()[provider];
      return cred?.type === 'oauth' ? { auth: { apiKey: `token-${provider}` } } : undefined;
    }),
    getModel: vi.fn(() => undefined),
    hasConfiguredAuth: vi.fn((provider: string) => provider in readState()),
    getAvailableSnapshot: vi.fn(() => []),
    registerProvider: vi.fn(),
    unregisterProvider: vi.fn(),
    refresh: vi.fn(async () => ({ aborted: false, errors: new Map() })),
    completeSimple: vi.fn(),
  };
  return {
    modelRuntime,
    services: { cwd: '/cwd', agentDir, modelRuntime, settingsManager: {}, resourceLoader: {}, diagnostics: [] },
  };
}

/** A caller-supplied AuthInteraction (the codex select prompt must never reach it — PiRuntime answers it). */
function callerInteraction(): AuthInteraction {
  return { prompt: vi.fn(async () => ''), notify: vi.fn() };
}

describe('PiRuntime OpenAI/Codex auth', () => {
  let agentDir: string;
  let mock: ReturnType<typeof makeServices>;

  beforeEach(() => {
    H.ctrl.loadable = true;
    agentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-oai-rt-'));
    mock = makeServices(agentDir);
    H.fakePi.createAgentSessionServices = vi.fn().mockResolvedValue(mock.services);
  });
  afterEach(async () => {
    await PiRuntime.disposeInstance();
    fs.rmSync(agentDir, { recursive: true, force: true });
  });

  it('setOpenAIApiKey logs in an api_key under "openai" and reports it', async () => {
    const rt = PiRuntime.get('/cwd', agentDir);
    const status = await rt.setOpenAIApiKey('sk-test');
    expect(mock.modelRuntime.login).toHaveBeenCalledTimes(1);
    const [provider, type] = mock.modelRuntime.login.mock.calls[0] as [string, string, AuthInteraction];
    expect(provider).toBe('openai');
    expect(type).toBe('api_key');
    expect(status).toEqual({ apiKey: true, codex: false });
  });

  it('signInCodex logs in to "openai-codex" and the wrapped interaction answers select prompts with "browser"', async () => {
    const rt = PiRuntime.get('/cwd', agentDir);
    await rt.signInCodex(callerInteraction());
    expect(mock.modelRuntime.login).toHaveBeenCalledTimes(1);
    const call = mock.modelRuntime.login.mock.calls[0] as unknown as [string, string, AuthInteraction];
    expect(call[0]).toBe('openai-codex');
    expect(call[1]).toBe('oauth');
    // The PiRuntime-wrapped interaction intercepts the login-method select and answers 'browser'.
    await expect(call[2].prompt({ type: 'select', message: '', options: [] } as AuthPrompt)).resolves.toBe('browser');
  });

  it('signInCodex delegates non-select prompts to the caller interaction', async () => {
    const rt = PiRuntime.get('/cwd', agentDir);
    const caller = callerInteraction();
    (caller.prompt as ReturnType<typeof vi.fn>).mockResolvedValue('pasted-code');
    await rt.signInCodex(caller);
    const wrapped = (mock.modelRuntime.login.mock.calls[0] as unknown as [string, string, AuthInteraction])[2];
    await expect(wrapped.prompt({ type: 'manual_code', message: 'code?' } as AuthPrompt)).resolves.toBe('pasted-code');
    expect(caller.prompt).toHaveBeenCalledTimes(1);
  });

  it('reports api-key and codex status independently (disk-truth, now-async signouts)', async () => {
    const rt = PiRuntime.get('/cwd', agentDir);

    await rt.setOpenAIApiKey('sk-test');
    expect(rt.getOpenAIAuthStatus()).toEqual({ apiKey: true, codex: false });

    await rt.signInCodex(callerInteraction());
    expect(rt.getOpenAIAuthStatus()).toEqual({ apiKey: true, codex: true, codexExpires: 123 });

    await rt.clearOpenAIApiKey();
    expect(mock.modelRuntime.logout).toHaveBeenCalledWith('openai');
    expect(rt.getOpenAIAuthStatus()).toEqual({ apiKey: false, codex: true, codexExpires: 123 });

    await rt.signOutCodex();
    expect(mock.modelRuntime.logout).toHaveBeenCalledWith('openai-codex');
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
