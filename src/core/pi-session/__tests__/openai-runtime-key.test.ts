import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { syncOpenAIRuntimeKey } from '../openai-runtime-key';
import { OPENAI_API_KEY_SECRET } from '../openai-auth';

/** A runtime with pi's overlay semantics: logout drops the runtime key, login keeps it. */
function fakeRuntime() {
  const runtimeKeys = new Map<string, string>();
  return {
    runtimeKeys,
    setRuntimeApiKey: vi.fn(async (provider: string, key: string) => { runtimeKeys.set(provider, key); }),
    removeRuntimeApiKey: vi.fn(async (provider: string) => { runtimeKeys.delete(provider); }),
    logout: vi.fn(async (provider: string) => { runtimeKeys.delete(provider); }),
  };
}

describe('syncOpenAIRuntimeKey', () => {
  let agentDir: string;

  beforeEach(() => {
    agentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-oai-key-'));
  });
  afterEach(() => {
    fs.rmSync(agentDir, { recursive: true, force: true });
  });

  function writeChatGPT(signedIn: boolean): void {
    fs.writeFileSync(path.join(agentDir, 'auth.json'), JSON.stringify(signedIn ? { openai: { type: 'oauth', expires: 1 } } : {}));
  }

  function secrets(key: string | undefined) {
    return { get: vi.fn(async (name: string) => (name === OPENAI_API_KEY_SECRET ? key : undefined)) };
  }

  it.each([
    // key, chatgpt, prefer, runtime key applied
    [undefined, false, false, false],
    [undefined, true, true, false],
    ['sk-1', false, false, true],
    ['sk-1', false, true, true],
    ['sk-1', true, false, false],
    ['sk-1', true, true, true],
  ])('secret=%s chatgpt=%s prefer=%s -> applied=%s', async (key, chatgpt, preferApiKey, applied) => {
    writeChatGPT(chatgpt);
    const modelRuntime = fakeRuntime();
    const onKeyPresence = vi.fn();

    await syncOpenAIRuntimeKey({ modelRuntime, secrets: secrets(key), agentDir, preferApiKey, onKeyPresence });

    expect(onKeyPresence).toHaveBeenCalledExactlyOnceWith(key !== undefined);
    expect(modelRuntime.runtimeKeys.get('openai')).toBe(applied ? key : undefined);
    expect(applied ? modelRuntime.setRuntimeApiKey : modelRuntime.removeRuntimeApiKey).toHaveBeenCalledTimes(1);
    expect(modelRuntime.logout).not.toHaveBeenCalled();
  });

  it('applies the key again after a logout dropped it, with no applied-key cache', async () => {
    writeChatGPT(false);
    const modelRuntime = fakeRuntime();
    const deps = { modelRuntime, secrets: secrets('sk-1'), agentDir, preferApiKey: false, onKeyPresence: () => {} };
    await syncOpenAIRuntimeKey(deps);
    await modelRuntime.logout('openai');
    expect(modelRuntime.runtimeKeys.has('openai')).toBe(false);

    await syncOpenAIRuntimeKey(deps);

    expect(modelRuntime.runtimeKeys.get('openai')).toBe('sk-1');
    expect(modelRuntime.setRuntimeApiKey).toHaveBeenCalledTimes(2);
  });

  it('never calls logout, even when it drops the runtime key under a ChatGPT grant', async () => {
    writeChatGPT(true);
    const modelRuntime = fakeRuntime();
    modelRuntime.runtimeKeys.set('openai', 'sk-1');

    await syncOpenAIRuntimeKey({ modelRuntime, secrets: secrets('sk-1'), agentDir, preferApiKey: false, onKeyPresence: () => {} });

    expect(modelRuntime.runtimeKeys.has('openai')).toBe(false);
    expect(modelRuntime.logout).not.toHaveBeenCalled();
  });

  it('propagates a pi failure for the caller to describe, after reporting the key presence', async () => {
    writeChatGPT(false);
    const modelRuntime = fakeRuntime();
    modelRuntime.setRuntimeApiKey.mockRejectedValueOnce(new Error('refresh failed'));
    const onKeyPresence = vi.fn();
    await expect(syncOpenAIRuntimeKey({ modelRuntime, secrets: secrets('sk-1'), agentDir, preferApiKey: false, onKeyPresence })).rejects.toThrow('refresh failed');
    expect(onKeyPresence).toHaveBeenCalledExactlyOnceWith(true);
  });

  it.each([
    ['setRuntimeApiKey', 'sk-1'],
    ['removeRuntimeApiKey', undefined],
  ] as const)('counts a %s that pi committed before a CredentialSynchronizationError as applied', async (method, key) => {
    writeChatGPT(false);
    const modelRuntime = fakeRuntime();
    // pi changes the runtime key, then throws when the model snapshot sync after it fails.
    const committed = modelRuntime[method].getMockImplementation()!;
    modelRuntime[method].mockImplementationOnce(async (provider: string, value?: string) => {
      await (committed as (p: string, v?: string) => Promise<void>)(provider, value);
      throw Object.assign(new Error('Credential committed, but local synchronization failed'), {
        name: 'CredentialSynchronizationError',
        credential: { type: 'api_key', key },
      });
    });

    await expect(
      syncOpenAIRuntimeKey({ modelRuntime, secrets: secrets(key), agentDir, preferApiKey: false, onKeyPresence: () => {} }),
    ).resolves.toBeUndefined();
    expect(modelRuntime.runtimeKeys.get('openai')).toBe(key);
  });
});
