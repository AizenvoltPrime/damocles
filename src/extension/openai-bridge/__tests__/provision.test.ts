import { describe, it, expect, vi, afterEach } from 'vitest';
import * as vscode from 'vscode';
import { provisionOpenAIBridge, OpenAIAuthRequiredError } from '../provision';
import type { OpenAIBridgeProvisionDeps } from '../provision';
import type { ModelInfo } from '../../../shared/types/settings';

function buildModelInfo(overrides: Partial<ModelInfo> = {}): ModelInfo {
  return {
    value: 'gpt-5.5',
    backend: 'openai',
    openaiModelId: 'gpt-5.5',
    displayName: 'gpt-5.5',
    ...overrides,
  } as ModelInfo;
}

function buildDeps(overrides: Partial<OpenAIBridgeProvisionDeps> = {}): OpenAIBridgeProvisionDeps {
  const bridge = {
    ensureRunning: vi.fn(async () => ({ url: 'http://127.0.0.1:9999', bearer: 'b'.repeat(64) })),
  } as unknown as ReturnType<OpenAIBridgeProvisionDeps['getBridge']>;
  return {
    getBridge: vi.fn(() => bridge),
    panelId: 'panel-a',
    getOpenAIAuthStatus: vi.fn(async () => ({ codex: { signedIn: true, accountId: 'acct_x' }, apikey: { configured: true } })),
    getPreferApiKey: vi.fn(() => false),
    ...overrides,
  };
}

const TRUST = (value: boolean): void => {
  (vscode.workspace as unknown as { isTrusted: boolean }).isTrusted = value;
};

afterEach(() => {
  TRUST(true);
});

describe('provisionOpenAIBridge', () => {
  it('returns null for Anthropic-backed models', async () => {
    const result = await provisionOpenAIBridge(
      buildModelInfo({ backend: 'anthropic', value: 'claude-opus-4-8' }),
      buildDeps(),
    );
    expect(result).toBeNull();
  });

  it('returns null when modelInfo is undefined', async () => {
    const result = await provisionOpenAIBridge(undefined, buildDeps());
    expect(result).toBeNull();
  });

  it('throws when the workspace is untrusted', async () => {
    TRUST(false);
    await expect(provisionOpenAIBridge(buildModelInfo(), buildDeps())).rejects.toThrow(/trusted workspace/i);
  });

  it('throws OpenAIAuthRequiredError when deps are null', async () => {
    await expect(provisionOpenAIBridge(buildModelInfo(), null)).rejects.toBeInstanceOf(OpenAIAuthRequiredError);
  });

  it('throws OpenAIAuthRequiredError when neither auth path is configured', async () => {
    const deps = buildDeps({
      getOpenAIAuthStatus: vi.fn(async () => ({ codex: { signedIn: false }, apikey: { configured: false } })),
    });
    await expect(provisionOpenAIBridge(buildModelInfo(), deps)).rejects.toBeInstanceOf(OpenAIAuthRequiredError);
  });

  it('prefers codex when both paths are configured and preferApiKey is false', async () => {
    const ensureRunning = vi.fn(async () => ({ url: 'http://x', bearer: 'b' }));
    const bridge = { ensureRunning } as unknown as ReturnType<OpenAIBridgeProvisionDeps['getBridge']>;
    const deps = buildDeps({ getBridge: vi.fn(() => bridge) });
    const result = await provisionOpenAIBridge(buildModelInfo(), deps);
    expect(result?.authMode).toBe('codex');
    expect(ensureRunning).toHaveBeenCalledWith('panel-a', 'codex');
  });

  it('prefers apikey when preferApiKey toggle is on', async () => {
    const deps = buildDeps({ getPreferApiKey: vi.fn(() => true) });
    const result = await provisionOpenAIBridge(buildModelInfo(), deps);
    expect(result?.authMode).toBe('apikey');
  });

  it('falls through to apikey when only apikey is configured', async () => {
    const deps = buildDeps({
      getOpenAIAuthStatus: vi.fn(async () => ({ codex: { signedIn: false }, apikey: { configured: true } })),
    });
    const result = await provisionOpenAIBridge(buildModelInfo(), deps);
    expect(result?.authMode).toBe('apikey');
  });

  it('throws OpenAIAuthRequiredError when only the rejected auth-mode is configured', async () => {
    const deps = buildDeps({
      getOpenAIAuthStatus: vi.fn(async () => ({ codex: { signedIn: true }, apikey: { configured: false } })),
    });
    await expect(provisionOpenAIBridge(buildModelInfo({ openaiAuthMode: 'apikey' }), deps)).rejects.toBeInstanceOf(OpenAIAuthRequiredError);
  });
});
