import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import type { SecretStorage } from 'vscode';
import type { McpSdkBundle } from '../mcp-sdk-loader';
import type { McpServerDefinition } from '../types';
import type { McpAuthIdentity } from '../mcp-auth';

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

const at = (serverName: string, url = serverUrl): McpAuthIdentity => ({ serverName, serverUrl: url });

const sha256 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

/** The keychain key credentials were stored under before they were keyed by URL. */
const nameKey = (serverName: string): string => `damocles.mcp.oauth.sha256-${sha256(serverName)}`;

function secretStorage(store: Map<string, string>): SecretStorage {
  return {
    keys: async () => [...store.keys()],
    get: async (k: string) => store.get(k),
    store: async (k: string, v: string) => {
      store.set(k, v);
    },
    delete: async (k: string) => {
      store.delete(k);
    },
    onDidChange: () => ({ dispose() {} }),
  } as unknown as SecretStorage;
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
    it('saves and retrieves an entry per server identity', async () => {
      const auth = await import('../mcp-auth');
      await auth.saveAuthEntry(at('s'), { tokens: { accessToken: 'tok' } });
      expect((await auth.getAuthEntry(at('s')))?.tokens?.accessToken).toBe('tok');
      expect(await auth.getAuthEntry(at('s', 'https://other.example.com'))).toBeUndefined();
    });

    it('clears a corrupt keychain entry instead of silently discarding it (M3)', async () => {
      const auth = await import('../mcp-auth');
      const store = new Map<string, string>();
      auth.setMcpSecretStorage(secretStorage(store));

      await auth.saveAuthEntry(at('corrupt'), { tokens: { accessToken: 't' } });
      const key = [...store.keys()][0]!;
      store.set(key, '{ not valid json');

      expect(await auth.getAuthEntry(at('corrupt'))).toBeUndefined();
      expect(store.has(key)).toBe(false);
    });

    it('reports token expiry and presence', async () => {
      const auth = await import('../mcp-auth');
      expect(await auth.isTokenExpired(at('none'))).toBeNull();
      await auth.updateTokens(at('no-exp'), { accessToken: 't' });
      expect(await auth.isTokenExpired(at('no-exp'))).toBe(false);
      await auth.updateTokens(at('exp'), { accessToken: 't', expiresAt: 1 });
      expect(await auth.isTokenExpired(at('exp'))).toBe(true);
      expect(await auth.hasStoredTokens(at('exp'))).toBe(true);
      expect(await auth.hasStoredTokens(at('missing'))).toBe(false);
    });

    it('selectively clears tokens, client info, and all credentials', async () => {
      const auth = await import('../mcp-auth');
      await auth.updateTokens(at('c'), { accessToken: 't' });
      await auth.updateClientInfo(at('c'), { clientId: 'id' });
      await auth.clearTokens(at('c'));
      expect((await auth.getAuthEntry(at('c')))?.tokens).toBeUndefined();
      expect((await auth.getAuthEntry(at('c')))?.clientInfo?.clientId).toBe('id');
      await auth.clearClientInfo(at('c'));
      expect((await auth.getAuthEntry(at('c')))?.clientInfo).toBeUndefined();
      await auth.updateTokens(at('c'), { accessToken: 't' });
      await auth.clearAllCredentials(at('c'));
      expect(await auth.getAuthEntry(at('c'))).toBeUndefined();
    });
  });

  describe('two folders defining a same-named server at different URLs', () => {
    const urlA = 'https://a.example.com/mcp';
    const urlB = 'https://b.example.com/mcp';

    it('keeps each login, so the last one does not sign the other folder out', async () => {
      const { McpOAuthProvider } = await import('../mcp-oauth-provider');
      const folderA = new McpOAuthProvider(makeSdk(), 'api', urlA, {}, { onRedirect: async () => {} });
      const folderB = new McpOAuthProvider(makeSdk(), 'api', urlB, {}, { onRedirect: async () => {} });

      await folderA.saveTokens({ access_token: 'token-a', token_type: 'Bearer' });
      await folderA.saveClientInformation({ client_id: 'client-a', redirect_uris: ['http://127.0.0.1:19876/callback'] });
      await folderB.saveTokens({ access_token: 'token-b', token_type: 'Bearer' });

      expect((await folderA.tokens())?.access_token).toBe('token-a');
      expect((await folderA.clientInformation())?.client_id).toBe('client-a');
      expect((await folderB.tokens())?.access_token).toBe('token-b');
    });

    it("signing out of one folder's server leaves the other's tokens", async () => {
      const { removeAuth, getAuthStatus } = await import('../mcp-auth-flow');
      const { updateTokens } = await import('../mcp-auth');
      await updateTokens(at('api', urlA), { accessToken: 'token-a' });
      await updateTokens(at('api', urlB), { accessToken: 'token-b' });

      await removeAuth('api', urlA);

      expect(await getAuthStatus('api', urlA)).toBe('not_authenticated');
      expect(await getAuthStatus('api', urlB)).toBe('authenticated');
    });

    it("runs each folder's login, never handing one folder the other's in-flight flow", async () => {
      let finish!: () => void;
      mocks.sdkAuth.mockImplementationOnce(() => new Promise((resolve) => { finish = () => resolve('AUTHORIZED'); }));
      const { authenticate } = await import('../mcp-auth-flow');
      const cc = (url: string): McpServerDefinition => ({
        url,
        auth: 'oauth',
        oauth: { grantType: 'client_credentials', clientId: 'cc', clientSecret: 'sec' },
      });

      const loginA = authenticate(makeSdk(), 'api', urlA, cc(urlA));
      await vi.waitFor(() => expect(mocks.sdkAuth).toHaveBeenCalledTimes(1));
      const loginB = authenticate(makeSdk(), 'api', urlB, cc(urlB));
      await vi.waitFor(() => expect(mocks.sdkAuth).toHaveBeenCalledTimes(2));
      finish();

      await expect(Promise.all([loginA, loginB])).resolves.toEqual(['authenticated', 'authenticated']);
      expect(mocks.sdkAuth.mock.calls.map(([, opts]) => (opts as { serverUrl: string }).serverUrl)).toEqual([urlA, urlB]);
    });
  });

  describe('migration from name-keyed credentials', () => {
    it('moves a name-keyed keychain entry to its identity, once, and leaves another URL signed out', async () => {
      const auth = await import('../mcp-auth');
      const store = new Map<string, string>([
        [nameKey('api'), JSON.stringify({ tokens: { accessToken: 'old' }, serverUrl })],
        [nameKey('unbound'), JSON.stringify({ tokens: { accessToken: 'no-url' } })],
      ]);

      auth.setMcpSecretStorage(secretStorage(store));

      expect((await auth.getAuthEntry(at('api')))?.tokens?.accessToken).toBe('old');
      expect(await auth.getAuthEntry(at('api', 'https://other.example.com'))).toBeUndefined();
      expect(store.has(nameKey('api'))).toBe(false);
      expect(store.has(nameKey('unbound'))).toBe(false);
      expect(store.size).toBe(1);
    });

    it('moves a pre-keychain on-disk entry into the keychain and deletes the file', async () => {
      const auth = await import('../mcp-auth');
      const dir = join(authDir, `sha256-${sha256('disk')}`);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'tokens.json'), JSON.stringify({ tokens: { accessToken: 'from-disk' }, serverUrl }));
      const store = new Map<string, string>();

      auth.setMcpSecretStorage(secretStorage(store));

      expect((await auth.getAuthEntry(at('disk')))?.tokens?.accessToken).toBe('from-disk');
      expect(existsSync(dir)).toBe(false);
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

      await auth.saveAuthEntry(at('stored'), { clientInfo: { clientId: 'stored-id', clientSecret: 's' } });
      const stored = new McpOAuthProvider(makeSdk(), 'stored', serverUrl, {}, { onRedirect: async () => {} });
      expect((await stored.clientInformation())?.client_id).toBe('stored-id');

      await auth.saveAuthEntry(at('exp'), { clientInfo: { clientId: 'x', clientSecret: 's', clientSecretExpiresAt: 1 } });
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
      await auth.updateOAuthState(at('rs'), 'state');
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
      expect(await getOAuthState(at('web'))).toBeUndefined();
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
      expect(await getAuthStatus('absent', serverUrl)).toBe('not_authenticated');
      await updateTokens(at('ok'), { accessToken: 't', expiresAt: Date.now() / 1000 + 3600 });
      expect(await getAuthStatus('ok', serverUrl)).toBe('authenticated');
      await updateTokens(at('stale'), { accessToken: 't', expiresAt: Date.now() / 1000 - 3600 });
      expect(await getAuthStatus('stale', serverUrl)).toBe('expired');
      await removeAuth('ok', serverUrl);
      expect(await getAuthStatus('ok', serverUrl)).toBe('not_authenticated');
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
        // Attach the rejection handler BEFORE triggering the callback: the server defers the reject via
        // setTimeout(…, 0) (so the error page flushes first), so awaiting only after the fetch would
        // leave a brief window where the promise rejects unhandled. In real usage the OAuth flow awaits
        // waitForCallback before the browser redirect arrives, so no such window exists.
        const errRejection = expect(errPromise).rejects.toThrow(/access_denied/);
        const errResp = await fetch(`http://127.0.0.1:${port}/callback?error=access_denied&state=err-state`);
        expect(errResp.status).toBe(200);
        await errRejection;

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
