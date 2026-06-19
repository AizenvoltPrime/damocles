import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { McpSdkBundle } from '../mcp-sdk-loader';
import type { McpServerDefinition } from '../types';

const mocks = vi.hoisted(() => ({
  openExternal: vi.fn<(uri: unknown) => Promise<boolean>>(),
  ensureCallbackServer: vi.fn(),
  waitForCallback: vi.fn(),
  cancelPendingCallback: vi.fn(),
  stopCallbackServer: vi.fn(),
  reserveCallbackServer: vi.fn(),
  releaseCallbackServer: vi.fn(),
  getOAuthCallbackPort: vi.fn(() => 19876),
  getOAuthCallbackPath: vi.fn(() => '/callback'),
  sdkAuth: vi.fn(),
  finishAuth: vi.fn(),
  transportClose: vi.fn(),
}));

class MockUnauthorizedError extends Error {}

class MockStreamableHTTPClientTransport {
  constructor(_url: URL, _options: unknown) {}
  close = mocks.transportClose;
  finishAuth = mocks.finishAuth;
}

vi.mock('vscode', () => ({
  env: { openExternal: mocks.openExternal },
  Uri: { parse: (str: string) => ({ toString: () => str, fsPath: str, path: str, scheme: 'https' }) },
  window: { createOutputChannel: () => ({ appendLine: () => {}, show: () => {}, dispose: () => {} }) },
}));

vi.mock('../mcp-callback-server', () => ({
  ensureCallbackServer: mocks.ensureCallbackServer,
  waitForCallback: mocks.waitForCallback,
  cancelPendingCallback: mocks.cancelPendingCallback,
  stopCallbackServer: mocks.stopCallbackServer,
  reserveCallbackServer: mocks.reserveCallbackServer,
  releaseCallbackServer: mocks.releaseCallbackServer,
  getOAuthCallbackPort: mocks.getOAuthCallbackPort,
  getOAuthCallbackPath: mocks.getOAuthCallbackPath,
}));

function makeSdk(): McpSdkBundle {
  return {
    auth: { auth: mocks.sdkAuth, UnauthorizedError: MockUnauthorizedError },
    http: { StreamableHTTPClientTransport: MockStreamableHTTPClientTransport },
  } as unknown as McpSdkBundle;
}

const serverUrl = 'https://api.example.com/mcp';

function oauthDefinition(oauth?: McpServerDefinition['oauth']): McpServerDefinition {
  const def: McpServerDefinition = { url: serverUrl, auth: 'oauth' };
  if (oauth !== undefined) def.oauth = oauth;
  return def;
}

describe('mcp oauth', () => {
  const originalOAuthDir = process.env['MCP_OAUTH_DIR'];
  let authDir: string;

  beforeEach(() => {
    authDir = mkdtempSync(join(tmpdir(), 'damocles-mcp-oauth-'));
    process.env['MCP_OAUTH_DIR'] = authDir;
    vi.resetModules();
    for (const fn of Object.values(mocks)) fn.mockReset();
    mocks.getOAuthCallbackPort.mockReturnValue(19876);
    mocks.getOAuthCallbackPath.mockReturnValue('/callback');
    mocks.openExternal.mockResolvedValue(true);
    mocks.sdkAuth.mockResolvedValue('AUTHORIZED');
    mocks.finishAuth.mockResolvedValue(undefined);
    mocks.transportClose.mockResolvedValue(undefined);
  });

  afterEach(() => {
    rmSync(authDir, { recursive: true, force: true });
    if (originalOAuthDir === undefined) {
      delete process.env['MCP_OAUTH_DIR'];
    } else {
      process.env['MCP_OAUTH_DIR'] = originalOAuthDir;
    }
  });

  describe('mcp-auth storage', () => {
    it('saves, retrieves, and URL-validates auth entries', async () => {
      const auth = await import('../mcp-auth');
      await auth.saveAuthEntry('s', { tokens: { accessToken: 'tok' }, serverUrl }, serverUrl);
      expect((await auth.getAuthEntry('s'))?.tokens?.accessToken).toBe('tok');
      expect((await auth.getAuthForUrl('s', serverUrl))?.tokens?.accessToken).toBe('tok');
      expect(await auth.getAuthForUrl('s', 'https://other.example.com')).toBeUndefined();
    });

    it('returns undefined when the stored entry has no serverUrl', async () => {
      const auth = await import('../mcp-auth');
      await auth.saveAuthEntry('legacy', { tokens: { accessToken: 'tok' } });
      expect(await auth.getAuthForUrl('legacy', serverUrl)).toBeUndefined();
    });

    it('clears a corrupt keychain entry instead of silently discarding it (M3)', async () => {
      const auth = await import('../mcp-auth');
      const store = new Map<string, string>();
      auth.setMcpSecretStorage({
        get: async (k: string) => store.get(k),
        store: async (k: string, v: string) => {
          store.set(k, v);
        },
        delete: async (k: string) => {
          store.delete(k);
        },
        onDidChange: () => ({ dispose() {} }),
      } as unknown as import('vscode').SecretStorage);

      await auth.saveAuthEntry('corrupt', { tokens: { accessToken: 't' }, serverUrl }, serverUrl);
      const key = [...store.keys()][0]!;
      store.set(key, '{ not valid json');

      expect(await auth.getAuthEntry('corrupt')).toBeUndefined();
      expect(store.has(key)).toBe(false);
    });

    it('clears URL-bound state when tokens move to a different server URL', async () => {
      const auth = await import('../mcp-auth');
      await auth.saveAuthEntry(
        'm',
        {
          tokens: { accessToken: 'old' },
          clientInfo: { clientId: 'c' },
          codeVerifier: 'v',
          oauthState: 'st',
          serverUrl: 'https://old.example.com',
        },
        'https://old.example.com',
      );
      await auth.updateTokens('m', { accessToken: 'new' }, 'https://new.example.com');
      expect(await auth.getAuthForUrl('m', 'https://old.example.com')).toBeUndefined();
      const moved = await auth.getAuthForUrl('m', 'https://new.example.com');
      expect(moved?.tokens?.accessToken).toBe('new');
      expect(moved?.clientInfo).toBeUndefined();
      expect(moved?.codeVerifier).toBeUndefined();
      expect(moved?.oauthState).toBeUndefined();
    });

    it('reports token expiry and presence', async () => {
      const auth = await import('../mcp-auth');
      expect(await auth.isTokenExpired('none')).toBeNull();
      await auth.updateTokens('no-exp', { accessToken: 't' });
      expect(await auth.isTokenExpired('no-exp')).toBe(false);
      await auth.updateTokens('exp', { accessToken: 't', expiresAt: 1 });
      expect(await auth.isTokenExpired('exp')).toBe(true);
      expect(await auth.hasStoredTokens('exp')).toBe(true);
      expect(await auth.hasStoredTokens('missing')).toBe(false);
    });

    it('selectively clears tokens, client info, and all credentials', async () => {
      const auth = await import('../mcp-auth');
      await auth.updateTokens('c', { accessToken: 't' });
      await auth.updateClientInfo('c', { clientId: 'id' });
      await auth.clearTokens('c');
      expect((await auth.getAuthEntry('c'))?.tokens).toBeUndefined();
      expect((await auth.getAuthEntry('c'))?.clientInfo?.clientId).toBe('id');
      await auth.clearClientInfo('c');
      expect((await auth.getAuthEntry('c'))?.clientInfo).toBeUndefined();
      await auth.updateTokens('c', { accessToken: 't' });
      await auth.clearAllCredentials('c');
      expect(await auth.getAuthEntry('c')).toBeUndefined();
    });
  });

  describe('McpOAuthProvider', () => {
    it('derives redirect URL + metadata for a public client', async () => {
      const { McpOAuthProvider } = await import('../mcp-oauth-provider');
      const provider = new McpOAuthProvider(makeSdk(), 'p', serverUrl, {}, { onRedirect: async () => {} });
      expect(provider.redirectUrl).toBe('http://127.0.0.1:19876/callback');
      expect(provider.clientMetadata.redirect_uris).toEqual(['http://127.0.0.1:19876/callback']);
      expect(provider.clientMetadata.token_endpoint_auth_method).toBe('none');
      expect(provider.clientMetadata.grant_types).toEqual(['authorization_code', 'refresh_token']);
    });

    it('emits client_credentials metadata with no redirect URIs', async () => {
      const { McpOAuthProvider } = await import('../mcp-oauth-provider');
      const provider = new McpOAuthProvider(
        makeSdk(),
        'p',
        serverUrl,
        { grantType: 'client_credentials', clientSecret: 'sec' },
        { onRedirect: async () => {} },
      );
      expect(provider.redirectUrl).toBeUndefined();
      expect(provider.clientMetadata.redirect_uris).toEqual([]);
      expect(provider.clientMetadata.grant_types).toEqual(['client_credentials']);
      expect(provider.clientMetadata.token_endpoint_auth_method).toBe('client_secret_post');
    });

    it('prefers config clientId, then stored client info, validating URL + secret expiry', async () => {
      const { McpOAuthProvider } = await import('../mcp-oauth-provider');
      const auth = await import('../mcp-auth');

      const cfg = new McpOAuthProvider(
        makeSdk(),
        's',
        serverUrl,
        { clientId: 'cfg', clientSecret: 'cfg-sec' },
        { onRedirect: async () => {} },
      );
      expect(await cfg.clientInformation()).toEqual({ client_id: 'cfg', client_secret: 'cfg-sec' });

      await auth.saveAuthEntry('stored', { clientInfo: { clientId: 'stored-id', clientSecret: 's' }, serverUrl }, serverUrl);
      const stored = new McpOAuthProvider(makeSdk(), 'stored', serverUrl, {}, { onRedirect: async () => {} });
      expect((await stored.clientInformation())?.client_id).toBe('stored-id');

      await auth.saveAuthEntry(
        'exp',
        { clientInfo: { clientId: 'x', clientSecret: 's', clientSecretExpiresAt: 1 }, serverUrl },
        serverUrl,
      );
      const expired = new McpOAuthProvider(makeSdk(), 'exp', serverUrl, {}, { onRedirect: async () => {} });
      expect(await expired.clientInformation()).toBeUndefined();
    });

    it('round-trips tokens and converts expires_in to a positive remaining window', async () => {
      const { McpOAuthProvider } = await import('../mcp-oauth-provider');
      const provider = new McpOAuthProvider(makeSdk(), 't', serverUrl, {}, { onRedirect: async () => {} });
      await provider.saveTokens({
        access_token: 'a',
        token_type: 'Bearer',
        refresh_token: 'r',
        expires_in: 3600,
        scope: 'read',
      });
      const tokens = await provider.tokens();
      expect(tokens?.access_token).toBe('a');
      expect(tokens?.refresh_token).toBe('r');
      expect(tokens?.scope).toBe('read');
      expect(tokens?.expires_in).toBeGreaterThan(0);
      expect(tokens?.expires_in).toBeLessThanOrEqual(3600);
    });

    it('redirects only when a flow state exists, else throws UnauthorizedError', async () => {
      const { McpOAuthProvider } = await import('../mcp-oauth-provider');
      const auth = await import('../mcp-auth');

      let captured: URL | undefined;
      const withState = new McpOAuthProvider(makeSdk(), 'rs', serverUrl, {}, {
        onRedirect: async (url) => {
          captured = url;
        },
      });
      await auth.updateOAuthState('rs', 'state', serverUrl);
      const target = new URL('https://auth.example.com/authorize');
      await withState.redirectToAuthorization(target);
      expect(captured).toBe(target);

      const noState = new McpOAuthProvider(makeSdk(), 'ns', serverUrl, {}, { onRedirect: async () => {} });
      await expect(noState.redirectToAuthorization(target)).rejects.toBeInstanceOf(MockUnauthorizedError);
    });

    it('invalidateCredentials honors the requested scope', async () => {
      const { McpOAuthProvider } = await import('../mcp-oauth-provider');
      const provider = new McpOAuthProvider(makeSdk(), 'inv', serverUrl, {}, { onRedirect: async () => {} });
      await provider.saveTokens({ access_token: 't', token_type: 'Bearer' });
      await provider.saveClientInformation({ client_id: 'c', client_secret: 's', redirect_uris: ['http://localhost/cb'] });

      await provider.invalidateCredentials('tokens');
      expect(await provider.tokens()).toBeUndefined();
      expect((await provider.clientInformation())?.client_id).toBe('c');

      await provider.invalidateCredentials('all');
      expect(await provider.clientInformation()).toBeUndefined();
    });
  });

  describe('extractOAuthConfig / supportsOAuth', () => {
    it('detects OAuth support from the definition', async () => {
      const { supportsOAuth } = await import('../mcp-auth-flow');
      expect(supportsOAuth({ url: serverUrl })).toBe(true);
      expect(supportsOAuth({ url: serverUrl, auth: 'oauth' })).toBe(true);
      expect(supportsOAuth({ url: serverUrl, auth: 'bearer' })).toBe(false);
      expect(supportsOAuth({ url: serverUrl, oauth: false })).toBe(false);
      expect(supportsOAuth({ command: 'npx' })).toBe(false);
      expect(supportsOAuth({})).toBe(false);
    });

    it('trims and validates OAuth metadata fields', async () => {
      const { extractOAuthConfig } = await import('../mcp-auth-flow');
      const cfg = extractOAuthConfig(
        oauthDefinition({
          redirectUri: '  http://localhost:3118/callback  ',
          clientName: '  Custom  ',
          clientUri: '  https://example.com/custom  ',
        }),
      );
      expect(cfg.redirectUri).toBe('http://localhost:3118/callback');
      expect(cfg.clientName).toBe('Custom');
      expect(cfg.clientUri).toBe('https://example.com/custom');

      expect(() => extractOAuthConfig(oauthDefinition({ clientName: 123 as unknown as string }))).toThrow(
        /clientName must be a string/,
      );
      expect(extractOAuthConfig({ url: serverUrl, oauth: false })).toEqual({});
    });
  });

  describe('flow: client_credentials', () => {
    it('authenticates non-interactively without callback server or browser', async () => {
      const { authenticate } = await import('../mcp-auth-flow');
      const status = await authenticate(makeSdk(), 'svc', serverUrl, {
        url: serverUrl,
        auth: 'oauth',
        oauth: { grantType: 'client_credentials', clientId: 'cc', clientSecret: 'sec' },
      });
      expect(status).toBe('authenticated');
      expect(mocks.sdkAuth).toHaveBeenCalledTimes(1);
      expect(mocks.ensureCallbackServer).not.toHaveBeenCalled();
      expect(mocks.openExternal).not.toHaveBeenCalled();
    });

    it('deduplicates concurrent authentication attempts for one server', async () => {
      const { authenticate } = await import('../mcp-auth-flow');
      const def: McpServerDefinition = {
        url: serverUrl,
        auth: 'oauth',
        oauth: { grantType: 'client_credentials', clientId: 'cc', clientSecret: 'sec' },
      };
      const [a, b] = await Promise.all([
        authenticate(makeSdk(), 'svc', serverUrl, def),
        authenticate(makeSdk(), 'svc', serverUrl, def),
      ]);
      expect(a).toBe('authenticated');
      expect(b).toBe('authenticated');
      expect(mocks.sdkAuth).toHaveBeenCalledTimes(1);
    });
  });

  describe('flow: authorization_code via browser + callback', () => {
    it('opens the browser, waits for the callback, and finishes auth', async () => {
      mocks.sdkAuth.mockImplementationOnce(async (provider: { redirectToAuthorization: (u: URL) => Promise<void> }) => {
        await provider.redirectToAuthorization(new URL('https://auth.example.com/authorize'));
        return 'REDIRECT';
      });
      mocks.waitForCallback.mockResolvedValueOnce('auth-code');
      const { authenticate } = await import('../mcp-auth-flow');
      const { getOAuthState } = await import('../mcp-auth');

      const status = await authenticate(makeSdk(), 'web', serverUrl, oauthDefinition());

      expect(status).toBe('authenticated');
      expect(mocks.openExternal).toHaveBeenCalledTimes(1);
      expect(mocks.finishAuth).toHaveBeenCalledWith('auth-code');
      expect(mocks.transportClose).toHaveBeenCalledTimes(1);
      expect(await getOAuthState('web')).toBeUndefined();
      expect(mocks.ensureCallbackServer).toHaveBeenCalledWith(
        expect.objectContaining({ strictPort: false, reserveState: true, oauthState: expect.any(String) }),
      );
    });

    it('still waits for the callback when the browser cannot open', async () => {
      mocks.sdkAuth.mockImplementationOnce(async (provider: { redirectToAuthorization: (u: URL) => Promise<void> }) => {
        await provider.redirectToAuthorization(new URL('https://auth.example.com/authorize'));
        return 'REDIRECT';
      });
      mocks.openExternal.mockResolvedValueOnce(false);
      mocks.waitForCallback.mockResolvedValueOnce('manual-code');
      const { authenticate } = await import('../mcp-auth-flow');

      await expect(authenticate(makeSdk(), 'browser-fail', serverUrl, oauthDefinition())).resolves.toBe(
        'authenticated',
      );
      expect(mocks.finishAuth).toHaveBeenCalledWith('manual-code');
      expect(mocks.cancelPendingCallback).not.toHaveBeenCalled();
    });

    it('enforces a strict callback port for pre-registered clients', async () => {
      mocks.sdkAuth.mockImplementationOnce(async (provider: { redirectToAuthorization: (u: URL) => Promise<void> }) => {
        await provider.redirectToAuthorization(new URL('https://auth.example.com/authorize'));
        return 'REDIRECT';
      });
      const { startAuth } = await import('../mcp-auth-flow');
      const result = await startAuth(makeSdk(), 'reg', serverUrl, oauthDefinition({ clientId: 'registered' }));
      expect(result.authorizationUrl).toBe('https://auth.example.com/authorize');
      expect(mocks.ensureCallbackServer).toHaveBeenCalledWith(
        expect.objectContaining({ strictPort: true, reserveState: true }),
      );
    });

    it('rejects malformed and non-local redirect URIs', async () => {
      const { startAuth } = await import('../mcp-auth-flow');
      await expect(
        startAuth(makeSdk(), 'bad', serverUrl, oauthDefinition({ redirectUri: 'not a url' })),
      ).rejects.toThrow(/Invalid OAuth redirectUri/);
      await expect(
        startAuth(makeSdk(), 'remote', serverUrl, oauthDefinition({ redirectUri: 'https://example.com:3118/cb' })),
      ).rejects.toThrow(/localhost or loopback/);
      await expect(
        startAuth(makeSdk(), 'noport', serverUrl, oauthDefinition({ redirectUri: 'http://localhost/cb' })),
      ).rejects.toThrow(/explicit numeric port/);
    });
  });

  describe('status', () => {
    it('reports auth status and removes credentials', async () => {
      const { getAuthStatus, removeAuth } = await import('../mcp-auth-flow');
      const { updateTokens } = await import('../mcp-auth');
      expect(await getAuthStatus('absent')).toBe('not_authenticated');
      await updateTokens('ok', { accessToken: 't', expiresAt: Date.now() / 1000 + 3600 });
      expect(await getAuthStatus('ok')).toBe('authenticated');
      await updateTokens('stale', { accessToken: 't', expiresAt: Date.now() / 1000 - 3600 });
      expect(await getAuthStatus('stale')).toBe('expired');
      await removeAuth('ok');
      expect(await getAuthStatus('ok')).toBe('not_authenticated');
    });
  });

  describe('integration contract', () => {
    it('createMcpAuthProviderFactory builds a provider only for OAuth servers', async () => {
      const { createMcpAuthProviderFactory } = await import('../mcp-auth-flow');
      const { McpOAuthProvider } = await import('../mcp-oauth-provider');
      const factory = createMcpAuthProviderFactory(makeSdk());
      expect(factory('s', serverUrl, oauthDefinition())).toBeInstanceOf(McpOAuthProvider);
      expect(factory('s', serverUrl, { url: serverUrl, auth: 'bearer' })).toBeUndefined();
      expect(factory('s', serverUrl, { command: 'npx' })).toBeUndefined();
    });

    it('authenticateMcpServer returns ok on success and a structured error otherwise', async () => {
      const { authenticateMcpServer } = await import('../mcp-auth-flow');

      const ok = await authenticateMcpServer(makeSdk(), 'svc', {
        url: serverUrl,
        auth: 'oauth',
        oauth: { grantType: 'client_credentials', clientId: 'cc', clientSecret: 'sec' },
      });
      expect(ok).toEqual({ ok: true });

      const unsupported = await authenticateMcpServer(makeSdk(), 'bearer', { url: serverUrl, auth: 'bearer' });
      expect(unsupported.ok).toBe(false);
      expect(unsupported.error).toMatch(/does not support OAuth/);

      mocks.sdkAuth.mockRejectedValueOnce(new Error('boom'));
      const failed = await authenticateMcpServer(makeSdk(), 'svc2', {
        url: serverUrl,
        auth: 'oauth',
        oauth: { grantType: 'client_credentials', clientId: 'cc' },
      });
      expect(failed.ok).toBe(false);
      expect(failed.error).toBe('boom');
    });
  });

  describe('callback server (real)', () => {
    it('binds, captures a code by state, escapes errors, and rejects bad state', async () => {
      const cb = await vi.importActual<typeof import('../mcp-callback-server')>('../mcp-callback-server');
      try {
        await cb.ensureCallbackServer();
        expect(cb.isCallbackServerRunning()).toBe(true);

        const port = cb.getOAuthCallbackPort();
        const codePromise = cb.waitForCallback('good-state');
        const ok = await fetch(`http://127.0.0.1:${port}/callback?code=the-code&state=good-state`);
        expect(ok.status).toBe(200);
        // The success response carries the live ?code= URL — it must forbid caching/referrer leakage (H2).
        expect(ok.headers.get('cache-control')).toMatch(/no-store/);
        expect(ok.headers.get('referrer-policy')).toBe('no-referrer');
        expect(ok.headers.get('content-security-policy')).toBeTruthy();
        expect(await codePromise).toBe('the-code');

        const errPromise = cb.waitForCallback('err-state');
        const errResp = await fetch(`http://127.0.0.1:${port}/callback?error=access_denied&state=err-state`);
        expect(errResp.status).toBe(200);
        await expect(errPromise).rejects.toThrow(/access_denied/);

        const missing = await fetch(`http://127.0.0.1:${port}/callback?code=x`);
        expect(missing.status).toBe(400);

        const wrong = await fetch(`http://127.0.0.1:${port}/callback?code=x&state=unknown`);
        expect(wrong.status).toBe(400);

        const notFound = await fetch(`http://127.0.0.1:${port}/nope`);
        expect(notFound.status).toBe(404);

        const wrongMethod = await fetch(`http://127.0.0.1:${port}/callback`, { method: 'POST' });
        expect(wrongMethod.status).toBe(405);
      } finally {
        await cb.stopCallbackServer();
        expect(cb.isCallbackServerRunning()).toBe(false);
      }
    });
  });
});
