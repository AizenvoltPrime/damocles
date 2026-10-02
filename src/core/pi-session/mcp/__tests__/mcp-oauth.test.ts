import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { createServer as createHttpServer, get as httpGet } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import type { SecretsStore } from '../../../../platform/secrets-store';
import { createFakePlatform } from '../../../../__mocks__/fake-platform';
import type { McpServerDefinition } from '../types';
import type { McpAuthIdentity } from '../mcp-auth';
import { startFakeOAuthServer, type FakeOAuthServer, type FakeOAuthServerOptions } from './fake-oauth-server';

const serverUrl = 'https://api.example.com/mcp';

const at = (serverName: string, url = serverUrl): McpAuthIdentity => ({ serverName, serverUrl: url });

const sha256 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

/** The keychain key credentials were stored under before they were keyed by URL. */
const nameKey = (serverName: string): string => `damocles.mcp.oauth.sha256-${sha256(serverName)}`;

function secretStorage(store: Map<string, string>): SecretsStore {
  return {
    isPersistent: true,
    keys: async () => [...store.keys()],
    get: async (k: string) => store.get(k),
    store: async (k: string, v: string) => {
      store.set(k, v);
    },
    delete: async (k: string) => {
      store.delete(k);
    },
    onDidChange: () => ({ dispose: () => {} }),
  };
}

/** A loopback port nothing listens on right now. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as { port: number };
      probe.close(() => resolve(port));
    });
  });
}

const openExternal = vi.fn<(url: string) => Promise<boolean>>();
const servers: FakeOAuthServer[] = [];
let keychain: Map<string, string>;

async function fakeServer(options: FakeOAuthServerOptions = {}): Promise<FakeOAuthServer> {
  const server = await startFakeOAuthServer(options);
  servers.push(server);
  return server;
}

/** The browser: consent at the authorization server, then follow its redirect to the callback server. */
function browserFor(server: FakeOAuthServer): void {
  openExternal.mockImplementation(async (url) => {
    const callback = await server.approve(url);
    await fetch(callback);
    return true;
  });
}

const oauthModule = () => import('@earendil-works/pi-mcp/oauth');

/** The network past loopback: a request to any other host is recorded and fails as an unreachable host does. */
function recordOutsideRequests(): string[] {
  const outside: string[] = [];
  const realFetch = globalThis.fetch;
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input);
    if (url.hostname !== '127.0.0.1' && url.hostname !== 'localhost') {
      outside.push(url.href);
      throw new TypeError('fetch failed');
    }
    return realFetch(input, init);
  });
  return outside;
}

/** Shortens the OAuth request timeout (15 s) to a real 200 ms one, and returns the spy that saw the requested length. */
function shortOAuthTimeout() {
  const realTimeout = AbortSignal.timeout.bind(AbortSignal);
  return vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms) => realTimeout(ms === 15_000 ? 200 : ms));
}

/** Connect a pi-mcp client with the provider the server manager would use, list tools, and close. */
async function connectWithFactoryProvider(name: string, definition: McpServerDefinition & { url: string }) {
  const { createMcpAuthProviderFactory } = await import('../mcp-auth-flow');
  const { McpClient, StreamableHttpTransport } = await import('@earendil-works/pi-mcp');
  const authProvider = createMcpAuthProviderFactory(await oauthModule())(name, definition.url, definition);
  expect(authProvider).toBeDefined();
  const client = new McpClient({ name: 'Damocles', version: 'test' });
  try {
    await client.connect(new StreamableHttpTransport({ url: definition.url, authProvider: authProvider!, openGetStream: false }));
    return await client.listTools();
  } finally {
    await client.close();
  }
}

describe('mcp oauth', () => {
  const originalOAuthDir = process.env['MCP_OAUTH_DIR'];
  let authDir: string;

  beforeEach(async () => {
    authDir = mkdtempSync(join(tmpdir(), 'damocles-mcp-oauth-'));
    process.env['MCP_OAUTH_DIR'] = authDir;
    vi.resetModules();
    // resetModules gives the flow a fresh platform-host, so the platform is installed into that one.
    const fake = createFakePlatform();
    openExternal.mockReset();
    openExternal.mockResolvedValue(true);
    fake.shell.openExternal = openExternal;
    (await import('../../../platform-host')).installPlatform(fake);
    keychain = new Map();
    (await import('../mcp-auth')).setMcpSecretStorage(secretStorage(keychain));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    const { shutdownOAuth } = await import('../mcp-auth-flow');
    await shutdownOAuth();
    await (await import('../mcp-callback-server')).stopCallbackServer();
    await Promise.all(servers.splice(0).map((server) => server.close()));
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

    it('clears a corrupt keychain entry instead of silently discarding it', async () => {
      const auth = await import('../mcp-auth');
      await auth.saveAuthEntry(at('corrupt'), { tokens: { accessToken: 't' } });
      const key = [...keychain.keys()][0]!;
      keychain.set(key, '{"tokens":{"accessToken":sk-SECRETVALUE}}');
      const lines: string[] = [];
      (await import('../../../logger')).installLogSink({ appendLine: (line) => lines.push(line), show: () => {}, dispose: () => {} });

      expect(await auth.getAuthEntry(at('corrupt'))).toBeUndefined();
      expect(keychain.has(key)).toBe(false);
      expect(lines.some((line) => line.includes('Corrupt auth entry for corrupt'))).toBe(true);
      expect(lines.join('\n')).not.toContain('SECRET');
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

  describe('McpOAuthStateStore adapter over the keychain', () => {
    it('loads a sign-in stored before the upgrade, so it keeps working without a new login', async () => {
      const server = await fakeServer();
      const auth = await import('../mcp-auth');
      // A grant the server issued earlier, stored in the pre-upgrade AuthEntry shape.
      await connectFirstGrant(server);
      const issued = server.issued.at(-1)!;
      await auth.saveAuthEntry(at('legacy', server.mcpUrl), {
        tokens: { accessToken: issued.accessToken, refreshToken: 'refresh-unused', expiresAt: Date.now() / 1000 + 3600, scope: issued.scope },
        clientInfo: { clientId: 'dcr-client-1' },
      });

      const state = await auth.createOAuthStateStore(at('legacy', server.mcpUrl), { interactive: false }).load();
      expect(state).toMatchObject({
        serverUrl: server.mcpUrl,
        tokens: { access_token: issued.accessToken, refresh_token: 'refresh-unused', token_type: 'Bearer' },
        clientInformation: { client_id: 'dcr-client-1' },
      });
      expect(state?.tokensExpireAt).toBeGreaterThan(Date.now());

      const before = server.tokenRequests.length;
      await expect(connectWithFactoryProvider('legacy', { url: server.mcpUrl, auth: 'oauth' })).resolves.toEqual([
        { name: 'whoami', inputSchema: { type: 'object' } },
      ]);
      expect(server.mcpBearers.at(-1)).toBe(issued.accessToken);
      expect(server.tokenRequests.length).toBe(before);
      expect(openExternal).not.toHaveBeenCalled();
    });

    it('maps saved state back to the stored entry, with expiry in seconds', async () => {
      const auth = await import('../mcp-auth');
      const store = auth.createOAuthStateStore(at('rt'), { interactive: true });
      const expireAt = Date.now() + 60_000;
      await store.save({
        serverUrl,
        tokens: { access_token: 'a', token_type: 'Bearer', refresh_token: 'r', scope: 'read' },
        tokensExpireAt: expireAt,
        clientInformation: { client_id: 'cid', client_secret: 'sec' },
        codeVerifier: 'verifier',
        oauthState: 'state',
      });

      const entry = await auth.getAuthEntry(at('rt'));
      expect(entry?.tokens).toMatchObject({ accessToken: 'a', refreshToken: 'r', scope: 'read' });
      expect(entry?.tokens?.expiresAt).toBeCloseTo(expireAt / 1000, 0);
      expect(entry?.clientInfo).toMatchObject({ clientId: 'cid', clientSecret: 'sec' });
      expect(await store.load()).toMatchObject({ codeVerifier: 'verifier', oauthState: 'state' });
    });

    it('treats a client whose secret expired as absent', async () => {
      const auth = await import('../mcp-auth');
      await auth.saveAuthEntry(at('exp'), { clientInfo: { clientId: 'x', clientSecret: 's', clientSecretExpiresAt: 1 } });
      const state = await auth.createOAuthStateStore(at('exp'), { interactive: false }).load();
      expect(state?.clientInformation).toBeUndefined();
    });

    it('never lets a background refresh overwrite the verifier and state of a sign-in in progress', async () => {
      const auth = await import('../mcp-auth');
      await auth.saveAuthEntry(at('bg'), { codeVerifier: 'interactive-verifier', oauthState: 'interactive-state' });
      const background = auth.createOAuthStateStore(at('bg'), { interactive: false });
      const loaded = await background.load();
      await background.save({
        ...loaded!,
        serverUrl,
        codeVerifier: 'background-verifier',
        oauthState: 'background-state',
        tokens: { access_token: 'refreshed', token_type: 'Bearer' },
      });

      const entry = await auth.getAuthEntry(at('bg'));
      expect(entry?.codeVerifier).toBe('interactive-verifier');
      expect(entry?.oauthState).toBe('interactive-state');
      expect(entry?.tokens?.accessToken).toBe('refreshed');
    });

    it('never lets one connection\u2019s stale load overwrite another connection\u2019s newer grant of the same identity', async () => {
      const auth = await import('../mcp-auth');
      await auth.saveAuthEntry(at('shared'), { tokens: { accessToken: 'old', refreshToken: 'old-refresh' }, clientInfo: { clientId: 'old-client' } });
      const folderA = auth.createOAuthStateStore(at('shared'), { interactive: false });
      const folderB = auth.createOAuthStateStore(at('shared'), { interactive: true });

      // pi-mcp's provider update: load, change one field, save, with the lock held only around the save.
      const staleA = await folderA.load();
      const loadedB = await folderB.load();
      await folderB.save({
        ...loadedB,
        tokens: { access_token: 'new', token_type: 'Bearer', refresh_token: 'new-refresh' },
        clientInformation: { client_id: 'new-client' },
      });
      await folderA.save({ ...staleA, discovery: { authorizationServerUrl: 'https://as.example.com' } });

      const entry = await auth.getAuthEntry(at('shared'));
      expect(entry?.tokens).toMatchObject({ accessToken: 'new', refreshToken: 'new-refresh' });
      expect(entry?.clientInfo?.clientId).toBe('new-client');
    });

    it('still applies a connection\u2019s own token change after a load', async () => {
      const auth = await import('../mcp-auth');
      await auth.saveAuthEntry(at('own'), { tokens: { accessToken: 'old', refreshToken: 'r' }, clientInfo: { clientId: 'c' } });
      const store = auth.createOAuthStateStore(at('own'), { interactive: false });

      const invalidated = { ...(await store.load()) };
      delete invalidated.tokens;
      delete invalidated.clientInformation;
      await store.save(invalidated);

      const entry = await auth.getAuthEntry(at('own'));
      expect(entry?.tokens).toBeUndefined();
      expect(entry?.clientInfo).toBeUndefined();
    });

    it('keeps two folders\u2019 same-named servers at different URLs apart', async () => {
      const auth = await import('../mcp-auth');
      const urlA = 'https://a.example.com/mcp';
      const urlB = 'https://b.example.com/mcp';
      await auth.createOAuthStateStore(at('api', urlA), { interactive: true }).save({ serverUrl: urlA, tokens: { access_token: 'token-a', token_type: 'Bearer' } });
      await auth.createOAuthStateStore(at('api', urlB), { interactive: true }).save({ serverUrl: urlB, tokens: { access_token: 'token-b', token_type: 'Bearer' } });

      expect((await auth.getAuthEntry(at('api', urlA)))?.tokens?.accessToken).toBe('token-a');
      expect((await auth.getAuthEntry(at('api', urlB)))?.tokens?.accessToken).toBe('token-b');

      const { removeAuth, getAuthStatus } = await import('../mcp-auth-flow');
      await removeAuth('api', urlA);
      expect(await getAuthStatus('api', urlA)).toBe('not_authenticated');
      expect(await getAuthStatus('api', urlB)).toBe('authenticated');
    });
  });

  describe('interactive sign-in against a fake authorization server', () => {
    it('discovers the server (RFC 9728, RFC 8414), registers as "Damocles", and signs in with PKCE', async () => {
      const server = await fakeServer({ scopesSupported: ['read'] });
      browserFor(server);
      const { authenticateMcpServer, getAuthStatus } = await import('../mcp-auth-flow');

      await expect(authenticateMcpServer(await oauthModule(), 'web', { url: server.mcpUrl, auth: 'oauth' })).resolves.toEqual({ ok: true });

      expect(server.metadataRequests).toEqual(
        expect.arrayContaining(['/.well-known/oauth-protected-resource/mcp', '/.well-known/oauth-authorization-server']),
      );
      expect(server.registrations).toHaveLength(1);
      expect(server.registrations[0]).toMatchObject({ client_name: 'Damocles' });
      const authorize = server.authorizeRequests[0]!;
      expect(authorize.searchParams.get('code_challenge_method')).toBe('S256');
      expect(authorize.searchParams.get('scope')).toBe('read');
      expect(authorize.searchParams.get('resource')).toBe(server.mcpUrl);
      expect(server.registrations[0]?.['redirect_uris']).toEqual([authorize.searchParams.get('redirect_uri')]);
      expect(await getAuthStatus('web', server.mcpUrl)).toBe('authenticated');
      expect(openExternal).toHaveBeenCalledTimes(1);

      await expect(connectWithFactoryProvider('web', { url: server.mcpUrl, auth: 'oauth' })).resolves.toHaveLength(1);
    });

    it('registers with oauth.clientName when the config sets one', async () => {
      const server = await fakeServer();
      browserFor(server);
      const { authenticateMcpServer } = await import('../mcp-auth-flow');

      await authenticateMcpServer(await oauthModule(), 'named', { url: server.mcpUrl, auth: 'oauth', oauth: { clientName: 'Acme Agent' } });

      expect(server.registrations[0]).toMatchObject({ client_name: 'Acme Agent' });
    });

    it('rejects a code whose iss names another issuer, and stores no tokens', async () => {
      const server = await fakeServer({ callbackIss: () => 'https://evil.example.com' });
      browserFor(server);
      const { authenticateMcpServer, getAuthStatus } = await import('../mcp-auth-flow');

      const result = await authenticateMcpServer(await oauthModule(), 'iss', { url: server.mcpUrl, auth: 'oauth' });

      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/issuer/i);
      expect(server.tokenRequests.filter((r) => r.params.get('grant_type') === 'authorization_code')).toHaveLength(0);
      expect(await getAuthStatus('iss', server.mcpUrl)).toBe('not_authenticated');
    });

    it('rejects a code without iss when the server promised one', async () => {
      const server = await fakeServer({ callbackIss: () => null });
      browserFor(server);
      const { authenticateMcpServer, getAuthStatus } = await import('../mcp-auth-flow');

      const result = await authenticateMcpServer(await oauthModule(), 'no-iss', { url: server.mcpUrl, auth: 'oauth' });

      expect(result.ok).toBe(false);
      expect(await getAuthStatus('no-iss', server.mcpUrl)).toBe('not_authenticated');
    });

    it('uses oauth.authServerMetadataUrl instead of discovery and trusts its issuer', async () => {
      const server = await fakeServer({ discoverable: false, issuer: () => 'https://issuer.example.com' });
      browserFor(server);
      const { authenticateMcpServer, getAuthStatus } = await import('../mcp-auth-flow');

      const configured = await authenticateMcpServer(await oauthModule(), 'configured', {
        url: server.mcpUrl,
        auth: 'oauth',
        oauth: { authServerMetadataUrl: server.customMetadataUrl },
      });

      expect(configured).toEqual({ ok: true });
      expect(server.metadataRequests).toContain('/custom/as-metadata');
      expect(server.metadataRequests).not.toContain('/.well-known/oauth-authorization-server');
      // The configured document's endpoints differ from the ones pi-mcp falls back to.
      expect(server.requestPaths).toEqual(expect.arrayContaining(['/custom/register', '/custom/authorize', '/custom/token']));
      expect(server.requestPaths).not.toEqual(expect.arrayContaining(['/register']));
      expect(server.authorizeRequests[0]?.pathname).toBe('/custom/authorize');
      expect(server.tokenRequests.map((r) => r.path)).toEqual(['/custom/token']);
      expect(await getAuthStatus('configured', server.mcpUrl)).toBe('authenticated');
    });

    it('refreshes a connection through oauth.authServerMetadataUrl', async () => {
      const server = await fakeServer({ discoverable: false, issuer: () => 'https://issuer.example.com' });
      browserFor(server);
      const definition = { url: server.mcpUrl, auth: 'oauth' as const, oauth: { authServerMetadataUrl: server.customMetadataUrl } };
      const { authenticateMcpServer } = await import('../mcp-auth-flow');
      await expect(authenticateMcpServer(await oauthModule(), 'configured-refresh', definition)).resolves.toEqual({ ok: true });
      server.revokeAccessTokens();
      vi.resetModules();
      (await import('../mcp-auth')).setMcpSecretStorage(secretStorage(keychain));

      await expect(connectWithFactoryProvider('configured-refresh', definition)).resolves.toHaveLength(1);

      expect(server.tokenRequests.at(-1)).toMatchObject({ path: '/custom/token' });
      expect(server.tokenRequests.at(-1)?.params.get('grant_type')).toBe('refresh_token');
    });

    it('accepts a code without iss when the server never promised one', async () => {
      const server = await fakeServer({ issParameterSupported: false, callbackIss: () => null });
      browserFor(server);
      const { authenticateMcpServer, getAuthStatus } = await import('../mcp-auth-flow');

      await expect(authenticateMcpServer(await oauthModule(), 'no-promise', { url: server.mcpUrl, auth: 'oauth' })).resolves.toEqual({ ok: true });

      expect(await getAuthStatus('no-promise', server.mcpUrl)).toBe('authenticated');
    });

    it('still rejects a mismatched iss when another connection dropped the discovery during the callback wait', async () => {
      const server = await fakeServer({ callbackIss: () => 'https://evil.example.com' });
      const oauth = await oauthModule();
      const auth = await import('../mcp-auth');
      const { createAuthorizationCodeProvider } = await import('../mcp-oauth-provider');
      const config = { clientId: 'pre-registered', callbackPort: await freePort() };
      // A connection of the same identity in another folder, whose refresh failed with invalid_client.
      const connection = createAuthorizationCodeProvider(oauth, {
        serverUrl: server.mcpUrl,
        config,
        redirectUrl: 'http://127.0.0.1/callback',
        store: auth.createOAuthStateStore(at('mixup', server.mcpUrl), { interactive: false }),
        onRedirect: () => {},
      });
      openExternal.mockImplementation(async (url) => {
        await connection.invalidateCredentials('all');
        await fetch(await server.approve(url));
        return true;
      });
      const { authenticateMcpServer, getAuthStatus } = await import('../mcp-auth-flow');

      const result = await authenticateMcpServer(oauth, 'mixup', { url: server.mcpUrl, auth: 'oauth', oauth: config });

      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/issuer/i);
      expect(server.tokenRequests.filter((r) => r.params.get('grant_type') === 'authorization_code')).toHaveLength(0);
      expect(await getAuthStatus('mixup', server.mcpUrl)).toBe('not_authenticated');
    });

    it('exchanges the code at the authorization server it checked iss against, even after the stored discovery was dropped', async () => {
      const server = await fakeServer();
      const oauth = await oauthModule();
      const auth = await import('../mcp-auth');
      const { createAuthorizationCodeProvider } = await import('../mcp-oauth-provider');
      const config = { clientId: 'pre-registered', callbackPort: await freePort() };
      const connection = createAuthorizationCodeProvider(oauth, {
        serverUrl: server.mcpUrl,
        config,
        redirectUrl: 'http://127.0.0.1/callback',
        store: auth.createOAuthStateStore(at('pinned', server.mcpUrl), { interactive: false }),
        onRedirect: () => {},
      });
      openExternal.mockImplementation(async (url) => {
        await connection.invalidateCredentials('discovery');
        await fetch(await server.approve(url));
        return true;
      });
      const { authenticateMcpServer } = await import('../mcp-auth-flow');

      await expect(authenticateMcpServer(oauth, 'pinned', { url: server.mcpUrl, auth: 'oauth', oauth: config })).resolves.toEqual({ ok: true });

      expect(server.metadataRequests).toEqual(['/.well-known/oauth-protected-resource/mcp', '/.well-known/oauth-authorization-server']);
      expect(server.tokenRequests.map((r) => r.params.get('grant_type'))).toEqual(['authorization_code']);
    });

    it('rebinds the stored client\u2019s registered callback port in a fresh process, keeping the client', async () => {
      const server = await fakeServer();
      browserFor(server);
      const definition = { url: server.mcpUrl, auth: 'oauth' as const };
      const first = await import('../mcp-auth-flow');
      await expect(first.authenticateMcpServer(await oauthModule(), 'rebind', definition)).resolves.toEqual({ ok: true });
      const registeredRedirect = server.registrations[0]?.['redirect_uris'];
      await first.shutdownOAuth();
      // A fresh process: no callback port remembered from an earlier flow.
      vi.resetModules();
      const fake = createFakePlatform();
      fake.shell.openExternal = openExternal;
      (await import('../../../platform-host')).installPlatform(fake);
      (await import('../mcp-auth')).setMcpSecretStorage(secretStorage(keychain));
      await (await import('../mcp-auth')).updateTokens(at('rebind', server.mcpUrl), { accessToken: 'expired', expiresAt: 1 });
      const second = await import('../mcp-auth-flow');
      // A new connection: a pooled one to the same port would still reach the first module's server.
      openExternal.mockImplementation(async (url) => {
        const callback = await server.approve(url);
        await new Promise<void>((resolve, reject) => {
          httpGet(callback, { agent: false }, (response) => response.resume().on('end', resolve)).on('error', reject);
        });
        return true;
      });

      await expect(second.authenticateMcpServer(await oauthModule(), 'rebind', definition)).resolves.toEqual({ ok: true });

      expect(server.registrations).toHaveLength(1);
      expect(server.authorizeRequests.at(-1)?.searchParams.get('redirect_uri')).toBe((registeredRedirect as string[])[0]);
    });

    it('refreshes an expired access token on the next connect without opening the browser', async () => {
      const server = await fakeServer();
      browserFor(server);
      const { authenticateMcpServer } = await import('../mcp-auth-flow');
      await authenticateMcpServer(await oauthModule(), 'refresh', { url: server.mcpUrl, auth: 'oauth' });
      openExternal.mockClear();
      server.revokeAccessTokens();

      await expect(connectWithFactoryProvider('refresh', { url: server.mcpUrl, auth: 'oauth' })).resolves.toHaveLength(1);

      expect(server.tokenRequests.at(-1)?.params.get('grant_type')).toBe('refresh_token');
      expect(openExternal).not.toHaveBeenCalled();
    });

    it('reports needs-auth at connect when there is no grant, without opening the browser', async () => {
      const server = await fakeServer();
      await expect(connectWithFactoryProvider('fresh', { url: server.mcpUrl, auth: 'oauth' })).rejects.toMatchObject({
        name: 'McpOAuthAuthorizationRequiredError',
      });
      expect(openExternal).not.toHaveBeenCalled();
      expect(server.mcpBearers[0]).toBeUndefined();
      // A background connect must not register a client or start a sign-in the user never asked for.
      expect(server.registrations).toHaveLength(0);
      const entry = await (await import('../mcp-auth')).getAuthEntry(at('fresh', server.mcpUrl));
      expect(entry?.codeVerifier).toBeUndefined();
      expect(entry?.oauthState).toBeUndefined();
    });

    it('clears the stored verifier and state when a sign-in ends, whether it succeeded or failed', async () => {
      const server = await fakeServer({ callbackIss: () => 'https://evil.example.com' });
      browserFor(server);
      const { authenticateMcpServer } = await import('../mcp-auth-flow');
      const auth = await import('../mcp-auth');

      await authenticateMcpServer(await oauthModule(), 'ends', { url: server.mcpUrl, auth: 'oauth' });

      const entry = await auth.getAuthEntry(at('ends', server.mcpUrl));
      expect(entry?.codeVerifier).toBeUndefined();
      expect(entry?.oauthState).toBeUndefined();
    });

    it('reports a failed sign-in in one bounded line', async () => {
      const server = await fakeServer();
      openExternal.mockImplementation(async (url) => {
        const redirect = new URL(new URL(url).searchParams.get('redirect_uri')!);
        redirect.searchParams.set('error', 'access_denied');
        redirect.searchParams.set('error_description', `denied\n${'x'.repeat(1000)}`);
        redirect.searchParams.set('state', new URL(url).searchParams.get('state')!);
        await fetch(redirect);
        return true;
      });
      const { authenticateMcpServer } = await import('../mcp-auth-flow');

      const result = await authenticateMcpServer(await oauthModule(), 'denied', { url: server.mcpUrl, auth: 'oauth' });

      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/denied/);
      expect(result.error).not.toContain('\n');
      expect(result.error!.length).toBeLessThanOrEqual(301);
    });

    it('binds a pre-registered client strictly on the configured callback port', async () => {
      const server = await fakeServer();
      browserFor(server);
      const port = await freePort();
      vi.stubEnv('MCP_OAUTH_CALLBACK_PORT', String(port));
      try {
        vi.resetModules();
        const fake = createFakePlatform();
        fake.shell.openExternal = openExternal;
        (await import('../../../platform-host')).installPlatform(fake);
        (await import('../mcp-auth')).setMcpSecretStorage(secretStorage(keychain));
        const { authenticateMcpServer } = await import('../mcp-auth-flow');

        await authenticateMcpServer(await oauthModule(), 'registered', { url: server.mcpUrl, auth: 'oauth', oauth: { clientId: 'pre-registered' } });

        expect(server.registrations).toHaveLength(0);
        expect(server.authorizeRequests[0]?.searchParams.get('client_id')).toBe('pre-registered');
        expect(server.authorizeRequests[0]?.searchParams.get('redirect_uri')).toBe(`http://127.0.0.1:${port}/callback`);
      } finally {
        vi.unstubAllEnvs();
      }
    });

    it('turns an insufficient_scope challenge into a step-up sign-in for the merged scope, without a refresh', async () => {
      const server = await fakeServer({ scopesSupported: ['read'], requiredScope: 'admin' });
      browserFor(server);
      const { authenticateMcpServer, hasScopeChallenge } = await import('../mcp-auth-flow');
      await authenticateMcpServer(await oauthModule(), 'step', { url: server.mcpUrl, auth: 'oauth' });
      expect(server.issued.at(-1)?.scope).toBe('read');

      await expect(connectWithFactoryProvider('step', { url: server.mcpUrl, auth: 'oauth' })).rejects.toMatchObject({
        name: 'McpOAuthAuthorizationRequiredError',
      });
      expect(hasScopeChallenge('step', server.mcpUrl)).toBe(true);

      const grantsBefore = server.tokenRequests.length;
      await expect(authenticateMcpServer(await oauthModule(), 'step', { url: server.mcpUrl, auth: 'oauth' })).resolves.toEqual({ ok: true });

      const stepUp = server.authorizeRequests.at(-1)!;
      expect(stepUp.searchParams.get('scope')?.split(' ').sort()).toEqual(['admin', 'read']);
      expect(server.tokenRequests.slice(grantsBefore).map((r) => r.params.get('grant_type'))).toEqual(['authorization_code']);
      expect(hasScopeChallenge('step', server.mcpUrl)).toBe(false);
      await expect(connectWithFactoryProvider('step', { url: server.mcpUrl, auth: 'oauth' })).resolves.toHaveLength(1);
    });

    it('sends oauth.callbackUrl byte for byte as the redirect URI and listens on its port', async () => {
      const server = await fakeServer();
      browserFor(server);
      const port = await freePort();
      const callbackUrl = `http://localhost:${port}/oauth/done`;
      const { authenticateMcpServer } = await import('../mcp-auth-flow');

      await expect(
        authenticateMcpServer(await oauthModule(), 'cb-url', { url: server.mcpUrl, auth: 'oauth', oauth: { callbackUrl } }),
      ).resolves.toEqual({ ok: true });

      expect(server.authorizeRequests[0]?.searchParams.get('redirect_uri')).toBe(callbackUrl);
      expect(server.tokenRequests.at(-1)?.params.get('redirect_uri')).toBe(callbackUrl);
    });

    it('listens on oauth.callbackPort when only a port is configured', async () => {
      const server = await fakeServer();
      browserFor(server);
      const port = await freePort();
      const { authenticateMcpServer } = await import('../mcp-auth-flow');

      await authenticateMcpServer(await oauthModule(), 'cb-port', { url: server.mcpUrl, auth: 'oauth', oauth: { callbackPort: port } });

      expect(server.authorizeRequests[0]?.searchParams.get('redirect_uri')).toBe(`http://127.0.0.1:${port}/callback`);
    });

    it('fails clearly when the configured callback port is taken, instead of moving to another port', async () => {
      const server = await fakeServer();
      browserFor(server);
      const holder = createServer();
      await new Promise<void>((resolve) => holder.listen(0, '127.0.0.1', resolve));
      const { port } = holder.address() as { port: number };
      try {
        const { authenticateMcpServer } = await import('../mcp-auth-flow');
        const result = await authenticateMcpServer(await oauthModule(), 'taken', { url: server.mcpUrl, auth: 'oauth', oauth: { callbackPort: port } });
        expect(result.ok).toBe(false);
        expect(result.error).toMatch(/already in use/);
        expect(openExternal).not.toHaveBeenCalled();
      } finally {
        await new Promise<void>((resolve) => holder.close(() => resolve()));
      }
    });
  });

  describe('endpoint rules: https or loopback, bounded, and no registration from a connection', () => {
    it('never follows a redirect, so a 307 cannot re-send a token request body to another endpoint', async () => {
      let targetHits = 0;
      const target = createHttpServer((_req, res) => { targetHits++; res.end('{}'); });
      await new Promise<void>((resolve) => target.listen(0, '127.0.0.1', resolve));
      const targetPort = (target.address() as AddressInfo).port;
      const origin = createHttpServer((_req, res) => {
        res.writeHead(307, { location: `http://127.0.0.1:${targetPort}/token` }).end();
      });
      await new Promise<void>((resolve) => origin.listen(0, '127.0.0.1', resolve));
      const { createOAuthFetch } = await import('../mcp-oauth-provider');
      try {
        const response = await createOAuthFetch(await oauthModule())(`http://127.0.0.1:${(origin.address() as AddressInfo).port}/token`, {
          method: 'POST',
          body: new URLSearchParams({ grant_type: 'authorization_code', client_secret: 'SECRET' }),
        });

        expect(response.status).toBe(307);
        expect(targetHits).toBe(0);
      } finally {
        await Promise.all([target, origin].map((s) => new Promise((resolve) => s.close(resolve))));
      }
    });

    it('refuses an http registration endpoint on another host and sends it nothing', async () => {
      const outside = recordOutsideRequests();
      const server = await fakeServer({ registrationEndpoint: () => 'http://register.example.test/register' });
      browserFor(server);
      const { authenticateMcpServer } = await import('../mcp-auth-flow');

      const result = await authenticateMcpServer(await oauthModule(), 'plain-dcr', { url: server.mcpUrl, auth: 'oauth' });

      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/non-HTTPS endpoint http:\/\/register\.example\.test/);
      expect(outside).toEqual([]);
      expect(openExternal).not.toHaveBeenCalled();
    });

    it('refuses a discovered http authorization server on another host and sends it nothing', async () => {
      const outside = recordOutsideRequests();
      const server = await fakeServer({ authorizationServers: () => ['http://as.example.test'] });
      browserFor(server);
      const { authenticateMcpServer } = await import('../mcp-auth-flow');

      const result = await authenticateMcpServer(await oauthModule(), 'plain-as', { url: server.mcpUrl, auth: 'oauth' });

      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/non-HTTPS endpoint http:\/\/as\.example\.test/);
      expect(outside).toEqual([]);
    });

    it('refuses an http registration endpoint on another host for client_credentials, so no client secret comes back in clear text', async () => {
      const outside = recordOutsideRequests();
      const server = await fakeServer({ registrationEndpoint: () => 'http://register.example.test/register' });
      const { authenticateMcpServer } = await import('../mcp-auth-flow');

      const result = await authenticateMcpServer(await oauthModule(), 'plain-cc', {
        url: server.mcpUrl,
        auth: 'oauth',
        oauth: { grantType: 'client_credentials' },
      });

      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/non-HTTPS endpoint/);
      expect(outside).toEqual([]);
    });

    it('opens no browser for an http authorization endpoint on another host', async () => {
      const server = await fakeServer({ authorizationEndpoint: () => 'http://login.example.test/authorize' });
      const { authenticateMcpServer } = await import('../mcp-auth-flow');

      const result = await authenticateMcpServer(await oauthModule(), 'plain-authorize', { url: server.mcpUrl, auth: 'oauth' });

      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/non-HTTPS endpoint http:\/\/login\.example\.test/);
      expect(openExternal).not.toHaveBeenCalled();
    });

    it('times a sign-in out when the authorization server stalls', async () => {
      const timeouts = shortOAuthTimeout();
      const server = await fakeServer({ stalledPaths: ['/.well-known/oauth-authorization-server'] });
      const { authenticateMcpServer } = await import('../mcp-auth-flow');

      const result = await authenticateMcpServer(await oauthModule(), 'stalled', { url: server.mcpUrl, auth: 'oauth' });

      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/timeout|aborted/i);
      expect(timeouts).toHaveBeenCalledWith(15_000);
      expect(openExternal).not.toHaveBeenCalled();
    });

    it('signs out locally when revocation discovery stalls', async () => {
      shortOAuthTimeout();
      const server = await fakeServer({ stalledPaths: ['/.well-known/oauth-authorization-server'] });
      const auth = await import('../mcp-auth');
      await auth.saveAuthEntry(at('stalled-out', server.mcpUrl), { tokens: { accessToken: 'a' }, clientInfo: { clientId: 'c' } });
      const { revokeAndRemoveAuth } = await import('../mcp-auth-flow');

      await revokeAndRemoveAuth(await oauthModule(), 'stalled-out', { url: server.mcpUrl, auth: 'oauth' });

      expect(await auth.getAuthEntry(at('stalled-out', server.mcpUrl))).toBeUndefined();
      expect(server.revocations).toEqual([]);
    });

    it('releases the revocation response instead of leaving its body open', async () => {
      const server = await fakeServer({ endlessRevocationBody: true });
      const auth = await import('../mcp-auth');
      await auth.saveAuthEntry(at('revoke-body', server.mcpUrl), { tokens: { accessToken: 'a' }, clientInfo: { clientId: 'c' } });
      const { revokeAndRemoveAuth } = await import('../mcp-auth-flow');

      await revokeAndRemoveAuth(await oauthModule(), 'revoke-body', { url: server.mcpUrl, auth: 'oauth' });

      expect(server.revocations.map((r) => r.params.get('token_type_hint'))).toEqual(['access_token']);
      await expect(Promise.race([server.revocationBodyClosed.then(() => 'closed'), new Promise((r) => setTimeout(() => r('open'), 2000))])).resolves.toBe('closed');
    });

    it('revokes at the endpoint of oauth.authServerMetadataUrl', async () => {
      const server = await fakeServer({ discoverable: false });
      const auth = await import('../mcp-auth');
      await auth.saveAuthEntry(at('revoke-configured', server.mcpUrl), { tokens: { accessToken: 'a', refreshToken: 'r' }, clientInfo: { clientId: 'c' } });
      const { revokeAndRemoveAuth } = await import('../mcp-auth-flow');

      await revokeAndRemoveAuth(await oauthModule(), 'revoke-configured', {
        url: server.mcpUrl,
        auth: 'oauth',
        oauth: { authServerMetadataUrl: server.customMetadataUrl },
      });

      expect(server.revocations.map((r) => [r.path, r.params.get('token_type_hint')])).toEqual([
        ['/custom/revoke', 'refresh_token'],
        ['/custom/revoke', 'access_token'],
      ]);
    });

    it('a connection holding a refresh token but no client asks for sign-in instead of registering one', async () => {
      const server = await fakeServer();
      await (await import('../mcp-auth')).saveAuthEntry(at('no-client', server.mcpUrl), {
        tokens: { accessToken: 'stale', refreshToken: 'refresh-of-a-lost-client' },
      });

      await expect(connectWithFactoryProvider('no-client', { url: server.mcpUrl, auth: 'oauth' })).rejects.toMatchObject({
        name: 'McpOAuthAuthorizationRequiredError',
      });

      expect(server.registrations).toHaveLength(0);
      expect(server.metadataRequests).toEqual([]);
      expect(openExternal).not.toHaveBeenCalled();
    });

    it('a connection whose refresh is answered invalid_client asks for sign-in instead of registering again', async () => {
      const server = await fakeServer({ invalidClientOnRefresh: true });
      await (await import('../mcp-auth')).saveAuthEntry(at('dropped-client', server.mcpUrl), {
        tokens: { accessToken: 'stale', refreshToken: 'refresh-1' },
        clientInfo: { clientId: 'dcr-client-gone', redirectUris: ['http://127.0.0.1:1/callback'] },
      });

      await expect(connectWithFactoryProvider('dropped-client', { url: server.mcpUrl, auth: 'oauth' })).rejects.toMatchObject({
        name: 'McpOAuthAuthorizationRequiredError',
      });

      expect(server.tokenRequests.map((r) => r.params.get('grant_type'))).toEqual(['refresh_token']);
      expect(server.registrations).toHaveLength(0);
      expect(server.requestPaths).not.toContain('/register');
    });

    it('a connection whose refresh is answered invalid_client registers nothing even when its discovery is dropped before the retry', async () => {
      const server = await fakeServer({ invalidClientOnRefresh: true });
      const auth = await import('../mcp-auth');
      const id = at('dropped-discovery', server.mcpUrl);
      const storage = secretStorage(keychain);
      const read = storage.get;
      storage.get = async (key) => {
        // After the refused refresh, every keychain read races a sign-out of the same identity, which drops its discovery.
        if (server.tokenRequests.length > 0) void auth.removeAuthEntry(id);
        return read(key);
      };
      auth.setMcpSecretStorage(storage);
      await auth.saveAuthEntry(id, {
        tokens: { accessToken: 'stale', refreshToken: 'refresh-1' },
        clientInfo: { clientId: 'dcr-client-gone', redirectUris: ['http://127.0.0.1:1/callback'] },
      });

      await expect(connectWithFactoryProvider('dropped-discovery', { url: server.mcpUrl, auth: 'oauth' })).rejects.toMatchObject({
        name: 'McpOAuthAuthorizationRequiredError',
      });

      expect(server.registrations).toHaveLength(0);
      expect(server.requestPaths).not.toContain('/register');
    });
  });

  describe('client_credentials', () => {
    const clientCredentials = { clientId: 'svc-client', clientSecret: 'svc-secret' };
    const ccDefinition = (url: string): McpServerDefinition & { url: string } => ({
      url,
      auth: 'oauth',
      oauth: { grantType: 'client_credentials', ...clientCredentials },
    });

    it('signs in non-interactively with discovery and a token POST, never opening a browser', async () => {
      const server = await fakeServer({ clientCredentials });
      const { authenticateMcpServer } = await import('../mcp-auth-flow');

      await expect(authenticateMcpServer(await oauthModule(), 'svc', ccDefinition(server.mcpUrl))).resolves.toEqual({ ok: true });

      const grant = server.tokenRequests.at(-1)!;
      expect(grant.params.get('grant_type')).toBe('client_credentials');
      expect(openExternal).not.toHaveBeenCalled();
      expect(server.authorizeRequests).toHaveLength(0);
    });

    it('connects with a fetched token and fetches a new one after a 401', async () => {
      const server = await fakeServer({ clientCredentials });

      await expect(connectWithFactoryProvider('svc', ccDefinition(server.mcpUrl))).resolves.toHaveLength(1);
      server.revokeAccessTokens();
      await expect(connectWithFactoryProvider('svc', ccDefinition(server.mcpUrl))).resolves.toHaveLength(1);

      const grants = server.tokenRequests.filter((r) => r.params.get('grant_type') === 'client_credentials');
      expect(grants.length).toBeGreaterThanOrEqual(2);
      expect(openExternal).not.toHaveBeenCalled();
    });

    it('reports a rejected client secret as a failed sign-in', async () => {
      const server = await fakeServer({ clientCredentials });
      const { authenticateMcpServer } = await import('../mcp-auth-flow');

      const result = await authenticateMcpServer(await oauthModule(), 'bad', {
        url: server.mcpUrl,
        auth: 'oauth',
        oauth: { grantType: 'client_credentials', clientId: 'svc-client', clientSecret: 'wrong' },
      });

      expect(result.ok).toBe(false);
      expect(result.error).not.toContain('wrong');
    });

    it('signs two folders\u2019 same-named servers in against their own servers', async () => {
      const a = await fakeServer({ clientCredentials });
      const b = await fakeServer({ clientCredentials });
      const { authenticateMcpServer, getAuthStatus } = await import('../mcp-auth-flow');
      const oauth = await oauthModule();

      const results = await Promise.all([
        authenticateMcpServer(oauth, 'api', ccDefinition(a.mcpUrl)),
        authenticateMcpServer(oauth, 'api', ccDefinition(b.mcpUrl)),
      ]);

      expect(results).toEqual([{ ok: true }, { ok: true }]);
      expect(a.issued).toHaveLength(1);
      expect(b.issued).toHaveLength(1);
      expect(await getAuthStatus('api', a.mcpUrl)).toBe('authenticated');
      expect(await getAuthStatus('api', b.mcpUrl)).toBe('authenticated');
    });

    it('stores a token with expires_in: null as not expiring, so it is not fetched again per request', async () => {
      const server = await fakeServer({ clientCredentials, expiresIn: null });
      const { authenticateMcpServer, getAuthStatus } = await import('../mcp-auth-flow');

      await expect(authenticateMcpServer(await oauthModule(), 'no-expiry', ccDefinition(server.mcpUrl))).resolves.toEqual({ ok: true });

      expect((await (await import('../mcp-auth')).getAuthEntry(at('no-expiry', server.mcpUrl)))?.tokens?.expiresAt).toBeUndefined();
      expect(await getAuthStatus('no-expiry', server.mcpUrl)).toBe('authenticated');
    });

    it('keeps a step-up scope when a connection fetches its next token', async () => {
      const server = await fakeServer({ clientCredentials, requiredScope: 'admin' });
      const definition: McpServerDefinition & { url: string } = {
        url: server.mcpUrl,
        auth: 'oauth',
        oauth: { grantType: 'client_credentials', scope: 'read', ...clientCredentials },
      };
      await expect(connectWithFactoryProvider('cc-step', definition)).rejects.toMatchObject({ name: 'McpOAuthAuthorizationRequiredError' });
      const { authenticateMcpServer } = await import('../mcp-auth-flow');
      await expect(authenticateMcpServer(await oauthModule(), 'cc-step', definition)).resolves.toEqual({ ok: true });
      server.revokeAccessTokens();

      await expect(connectWithFactoryProvider('cc-step', definition)).resolves.toHaveLength(1);

      expect(server.tokenRequests.at(-1)?.params.get('scope')?.split(' ').sort()).toEqual(['admin', 'read']);
    });

    it('gets its token through oauth.authServerMetadataUrl', async () => {
      const server = await fakeServer({ clientCredentials, discoverable: false });

      await expect(
        connectWithFactoryProvider('cc-configured', { ...ccDefinition(server.mcpUrl), oauth: { grantType: 'client_credentials', ...clientCredentials, authServerMetadataUrl: server.customMetadataUrl } }),
      ).resolves.toHaveLength(1);

      expect(server.tokenRequests.map((r) => r.path)).toEqual(['/custom/token']);
    });
  });

  describe('stepUpScope (pi-mcp port)', () => {
    it('adds the challenged scopes to the granted ones, once each', async () => {
      const { stepUpScope } = await import('../mcp-oauth-provider');
      expect(stepUpScope('read write', 'admin read')).toBe('read write admin');
      expect(stepUpScope(undefined, 'admin')).toBe('admin');
      expect(stepUpScope('read', undefined)).toBeUndefined();
      expect(stepUpScope('read', '')).toBeUndefined();
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

    it('treats a server sending its own Authorization header as not OAuth, unless auth says oauth', async () => {
      // A rejected static token is then a failed row, not a sign-in prompt.
      const { supportsOAuth } = await import('../mcp-auth-flow');
      expect(supportsOAuth({ url: serverUrl, headers: { authorization: 'Bearer x' } })).toBe(false);
      expect(supportsOAuth({ url: serverUrl, headers: { Authorization: 'Bearer x' } })).toBe(false);
      expect(supportsOAuth({ url: serverUrl, headers: { authorization: 'Bearer x' }, auth: 'oauth' })).toBe(true);
      expect(supportsOAuth({ url: serverUrl, headers: { 'X-Api-Key': 'k' } })).toBe(true);
      expect(supportsOAuth({ url: serverUrl, auth: false })).toBe(false);
    });

    it('reads the oauth block as configured, and nothing for oauth:false', async () => {
      const { extractOAuthConfig } = await import('../mcp-auth-flow');
      const oauth = { callbackUrl: 'http://localhost:3118/callback', clientName: 'Custom', authServerMetadataUrl: 'https://a.example/m' };
      expect(extractOAuthConfig({ url: serverUrl, auth: 'oauth', oauth })).toEqual(oauth);
      expect(extractOAuthConfig({ url: serverUrl, oauth: false })).toEqual({});
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
      const factory = createMcpAuthProviderFactory(await oauthModule());
      expect(factory('s', serverUrl, { url: serverUrl, auth: 'oauth' })).toBeDefined();
      expect(factory('s', serverUrl, { url: serverUrl, auth: 'bearer' })).toBeUndefined();
      expect(factory('s', serverUrl, { command: 'npx' })).toBeUndefined();
    });

    it('authenticateMcpServer returns a structured error for a server without OAuth', async () => {
      const { authenticateMcpServer } = await import('../mcp-auth-flow');
      const unsupported = await authenticateMcpServer(await oauthModule(), 'bearer', { url: serverUrl, auth: 'bearer' });
      expect(unsupported.ok).toBe(false);
      expect(unsupported.error).toMatch(/does not support OAuth/);
    });
  });

  describe('callback server (real)', () => {
    it('binds, captures a code and iss by state, escapes errors, and rejects bad state', async () => {
      const cb = await import('../mcp-callback-server');
      try {
        // A reserved flow keeps the server up across the checks; it closes when the last one settles.
        await cb.ensureCallbackServer({ oauthState: 'keeper-state', reserveState: true });
        expect(cb.isCallbackServerRunning()).toBe(true);

        const port = cb.getOAuthCallbackPort();
        const codePromise = cb.waitForCallback('good-state');
        const ok = await fetch(`http://127.0.0.1:${port}/callback?code=the-code&state=good-state&iss=https%3A%2F%2Fas.example.com`);
        expect(ok.status).toBe(200);
        // The success response carries the live ?code= URL, so it must forbid caching and referrer leakage.
        expect(ok.headers.get('cache-control')).toMatch(/no-store/);
        expect(ok.headers.get('referrer-policy')).toBe('no-referrer');
        expect(ok.headers.get('content-security-policy')).toBeTruthy();
        expect(await codePromise).toEqual({ code: 'the-code', iss: 'https://as.example.com' });

        const noIss = cb.waitForCallback('no-iss');
        await fetch(`http://127.0.0.1:${port}/callback?code=c2&state=no-iss`);
        expect(await noIss).toEqual({ code: 'c2' });

        const errPromise = cb.waitForCallback('err-state');
        // Attach the rejection handler before the callback: the server defers the reject so the error page flushes first.
        const errRejection = expect(errPromise).rejects.toThrow(/access_denied/);
        const errResp = await fetch(`http://127.0.0.1:${port}/callback?error=access_denied&state=err-state`);
        expect(errResp.status).toBe(200);
        await errRejection;

        expect((await fetch(`http://127.0.0.1:${port}/callback?code=x`)).status).toBe(400);
        expect((await fetch(`http://127.0.0.1:${port}/callback?code=x&state=unknown`)).status).toBe(400);
        expect((await fetch(`http://127.0.0.1:${port}/nope`)).status).toBe(404);
        expect((await fetch(`http://127.0.0.1:${port}/callback`, { method: 'POST' })).status).toBe(405);

        cb.releaseCallbackServer('keeper-state');
        expect(cb.isCallbackServerRunning()).toBe(false);
      } finally {
        await cb.stopCallbackServer();
        expect(cb.isCallbackServerRunning()).toBe(false);
      }
    });
  });
});

/** Sign in once through the real flow so the fake server has issued a grant the test can reuse. */
async function connectFirstGrant(server: FakeOAuthServer): Promise<void> {
  browserFor(server);
  const { authenticateMcpServer } = await import('../mcp-auth-flow');
  await expect(authenticateMcpServer(await oauthModule(), 'seed', { url: server.mcpUrl, auth: 'oauth' })).resolves.toEqual({ ok: true });
  openExternal.mockClear();
}
