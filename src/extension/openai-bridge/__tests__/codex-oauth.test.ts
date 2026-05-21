import { describe, it, expect, vi, afterEach } from 'vitest';
import type * as vscode from 'vscode';
import { extractCodexJwtClaims, getValidAccessToken } from '../codex-oauth';
import { OPENAI_BRIDGE_SECRET_KEYS } from '../types';

function makeJwt(payload: Record<string, unknown>): string {
  const enc = (obj: Record<string, unknown>): string => Buffer.from(JSON.stringify(obj)).toString('base64url');
  const header = enc({ alg: 'none', typ: 'JWT' });
  const body = enc(payload);
  return `${header}.${body}.signature`;
}

describe('extractCodexJwtClaims', () => {
  it('returns null for tokens that lack three segments', () => {
    expect(extractCodexJwtClaims('not-a-jwt')).toBeNull();
    expect(extractCodexJwtClaims('only.two')).toBeNull();
  });

  it('returns null for tokens with a malformed payload segment', () => {
    expect(extractCodexJwtClaims('aaa.bbb.ccc')).toBeNull();
  });

  it('extracts top-level email and name claims', () => {
    const token = makeJwt({ email: 'user@example.com', name: 'Test User' });
    const claims = extractCodexJwtClaims(token);
    expect(claims).toEqual({ email: 'user@example.com', name: 'Test User' });
  });

  it('extracts the OpenAI auth-namespace chatgpt_account_id', () => {
    const token = makeJwt({
      'https://api.openai.com/auth': {
        chatgpt_account_id: 'acct_abc123',
        chatgpt_plan_type: 'plus',
      },
    });
    const claims = extractCodexJwtClaims(token);
    expect(claims).toEqual({
      chatgpt_account_id: 'acct_abc123',
      chatgpt_plan_type: 'plus',
    });
  });

  it('ignores non-string claims to defeat smuggled payload tampering', () => {
    const token = makeJwt({ email: 42, name: { nested: true } });
    const claims = extractCodexJwtClaims(token);
    expect(claims).toEqual({});
  });

  it('survives base64url padding edge cases', () => {
    const claim = makeJwt({ email: 'a@b.c' });
    expect(extractCodexJwtClaims(claim)?.email).toBe('a@b.c');
  });
});

function buildContextWithExpiringBlob(): { context: vscode.ExtensionContext; secretsMap: Map<string, string> } {
  const expiredBlob = {
    access_token: 'old-access',
    refresh_token: 'refresh-token-xyz',
    expires_at: Date.now() - 60_000,
    chatgpt_account_id: 'acct_test',
  };
  const secretsMap = new Map<string, string>([
    [OPENAI_BRIDGE_SECRET_KEYS.codexAccessToken, JSON.stringify(expiredBlob)],
  ]);
  const context = {
    secrets: {
      get: async (k: string) => secretsMap.get(k),
      store: async (k: string, v: string) => { secretsMap.set(k, v); },
      delete: async (k: string) => { secretsMap.delete(k); },
      onDidChange: () => ({ dispose: () => {} }),
    },
  } as unknown as vscode.ExtensionContext;
  return { context, secretsMap };
}

describe('getValidAccessToken — refresh-token mutex against thundering-herd', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('serializes parallel callers through a single upstream refresh', async () => {
    const { context } = buildContextWithExpiringBlob();
    let upstreamRefreshes = 0;
    let releaseUpstream: (() => void) | null = null;

    const stubFetch = vi.spyOn(globalThis, 'fetch').mockImplementation((async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url.startsWith('https://auth.openai.com/oauth/token')) {
        upstreamRefreshes++;
        await new Promise<void>(resolve => { releaseUpstream = resolve; });
        return new Response(JSON.stringify({
          access_token: 'new-access',
          refresh_token: 'new-refresh',
          expires_in: 3600,
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      throw new Error(`unexpected fetch target ${url}`);
    }) as typeof fetch);

    const onExpired = vi.fn();
    const pending = Promise.all([
      getValidAccessToken({ context, onExpired }),
      getValidAccessToken({ context, onExpired }),
      getValidAccessToken({ context, onExpired }),
      getValidAccessToken({ context, onExpired }),
      getValidAccessToken({ context, onExpired }),
    ]);

    await new Promise(r => setTimeout(r, 40));
    expect(upstreamRefreshes).toBe(1);

    releaseUpstream?.();
    const results = await pending;

    expect(upstreamRefreshes).toBe(1);
    for (const r of results) {
      expect(r?.access_token).toBe('new-access');
    }

    stubFetch.mockRestore();
  });
});

