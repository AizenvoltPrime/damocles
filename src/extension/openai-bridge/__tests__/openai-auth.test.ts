import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as vscode from 'vscode';
import { resolveAuth, resolvePreferredAuth, OPENAI_PREFER_API_KEY_STATE } from '../openai-auth';
import { OPENAI_BRIDGE_SECRET_KEYS } from '../types';

interface Stash {
  apikey?: string;
  codexBlob?: {
    access_token: string;
    refresh_token: string;
    expires_at: number;
    chatgpt_account_id: string | null;
  };
}

function buildContext(stash: Stash): vscode.ExtensionContext {
  const secretsMap = new Map<string, string>();
  if (stash.apikey) secretsMap.set(OPENAI_BRIDGE_SECRET_KEYS.apikey, stash.apikey);
  if (stash.codexBlob) secretsMap.set(OPENAI_BRIDGE_SECRET_KEYS.codexAccessToken, JSON.stringify(stash.codexBlob));
  return {
    secrets: {
      get: async (k: string) => secretsMap.get(k),
      store: async (k: string, v: string) => { secretsMap.set(k, v); },
      delete: async (k: string) => { secretsMap.delete(k); },
      onDidChange: () => ({ dispose: () => {} }),
    },
  } as unknown as vscode.ExtensionContext;
}

function buildWorkspaceState(preferApiKey: boolean): vscode.Memento {
  return {
    get: (key: string, fallback?: unknown) => key === OPENAI_PREFER_API_KEY_STATE ? preferApiKey : fallback,
    update: async () => {},
    keys: () => [],
  } as unknown as vscode.Memento;
}

function farFutureBlob(): NonNullable<Stash['codexBlob']> {
  return {
    access_token: 'codex-token',
    refresh_token: 'codex-refresh',
    expires_at: Date.now() + 60 * 60 * 1000,
    chatgpt_account_id: 'acct_xyz',
  };
}

describe('resolveAuth', () => {
  it('returns null when the requested mode is unconfigured', async () => {
    const ctx = buildContext({});
    expect(await resolveAuth('apikey', ctx)).toBeNull();
    expect(await resolveAuth('codex', ctx)).toBeNull();
  });

  it('returns an apikey resolution when the secret is set', async () => {
    const ctx = buildContext({ apikey: 'sk-live-test' });
    const result = await resolveAuth('apikey', ctx);
    expect(result).toEqual({ mode: 'apikey', token: 'sk-live-test' });
  });

  it('returns a codex resolution with accountId from the blob', async () => {
    const ctx = buildContext({ codexBlob: farFutureBlob() });
    const result = await resolveAuth('codex', ctx);
    expect(result?.mode).toBe('codex');
    expect(result?.token).toBe('codex-token');
    expect(result?.accountId).toBe('acct_xyz');
  });
});

describe('resolvePreferredAuth', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('returns null when neither path is configured', async () => {
    const ctx = buildContext({});
    const result = await resolvePreferredAuth(ctx, buildWorkspaceState(false));
    expect(result).toBeNull();
  });

  it('prefers codex by default when both paths are configured', async () => {
    const ctx = buildContext({ apikey: 'sk', codexBlob: farFutureBlob() });
    const result = await resolvePreferredAuth(ctx, buildWorkspaceState(false));
    expect(result?.mode).toBe('codex');
  });

  it('preferApiKey=true inverts the precedence', async () => {
    const ctx = buildContext({ apikey: 'sk', codexBlob: farFutureBlob() });
    const result = await resolvePreferredAuth(ctx, buildWorkspaceState(true));
    expect(result?.mode).toBe('apikey');
  });

  it('falls back to the alternate path when the preferred one is unconfigured', async () => {
    const ctx = buildContext({ apikey: 'sk' });
    const result = await resolvePreferredAuth(ctx, buildWorkspaceState(false));
    expect(result?.mode).toBe('apikey');
  });
});
