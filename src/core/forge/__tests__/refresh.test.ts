import { createServer, type AddressInfo } from 'node:net';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeSecretsStore } from '../../../__mocks__/fake-platform';
import { createRefresher } from '../accounts/refresh';
import { createTokenStore } from '../accounts/token-store';
import { createForgeHttp } from '../http';
import { createServerRegistry } from '../servers';
import type { AccountRecord, ForgeServer, TokenSet } from '../types';
import { createHarness, type Harness } from './support/harness';

let harness: Harness;

afterAll(async () => {
  await harness.close();
});

beforeEach(async () => {
  if (!harness) harness = await createHarness();
  harness.stub.github.tokenTtlSeconds = 10;
  harness.stub.gitlab.tokenTtlSeconds = 10;
});

async function world() {
  const deps = harness.deps();
  const registry = createServerRegistry({ forgeDir: harness.forgeDir, tokens: createTokenStore(harness.secrets, () => undefined), buildOAuth: {}, overrides: deps.overrides!, log: () => undefined });
  await registry.load();
  const http = createForgeHttp({ fetch: harness.fetch, userAgent: 'Damocles/test', log: () => undefined });
  return { registry, http };
}

/** Signs in through the stub's device flow and stores the grant, as accounts.ts does. */
async function signedIn(server: ForgeServer, login: string, secrets = harness.secrets): Promise<{ account: AccountRecord; tokens: TokenSet }> {
  const stub = server.kind === 'github' ? harness.stub.github : harness.stub.gitlab;
  const deviceStart = await harness.fetch(`${stub.webUrl}${server.kind === 'github' ? '/login/device/code' : '/oauth/authorize_device'}`, { method: 'POST', body: new URLSearchParams({ client_id: stub.spec.clientId }) });
  const { device_code: deviceCode } = await deviceStart.json() as { device_code: string };
  stub.approveDevice(login);
  const grant = await harness.fetch(`${stub.webUrl}${server.kind === 'github' ? '/login/oauth/access_token' : '/oauth/token'}`, { method: 'POST', body: new URLSearchParams({ client_id: stub.spec.clientId, device_code: deviceCode, grant_type: 'urn:ietf:params:oauth:grant-type:device_code' }) });
  const body = await grant.json() as { access_token: string; refresh_token: string; expires_in: number };
  const tokens: TokenSet = { access: body.access_token, refresh: body.refresh_token, accessExpiresAt: Date.now() + body.expires_in * 1000, tokenType: 'oauth' };
  const account: AccountRecord = { id: `${server.id}|${login}`, serverId: server.id, userId: login, login, auth: 'device', scopes: [], agentShells: true, clientId: server.oauth!.clientId, addedAt: 0 };
  await createTokenStore(secrets, () => undefined).set(account.id, tokens);
  return { account, tokens };
}

describe('refresh', () => {
  it('refreshes a token expiring in 10 s once for two concurrent calls, and stores the rotated set before use', async () => {
    const { registry, http } = await world();
    const server = registry.get('github.com')!;
    const { account, tokens } = await signedIn(server, 'astefanopoulos');
    // the refreshed token lasts GitHub's 8 h, so the second call needs no refresh of its own
    harness.stub.github.tokenTtlSeconds = 28_800;
    const store = createTokenStore(harness.secrets, () => undefined);
    const refresher = createRefresher({ http, tokens: store, log: () => undefined, needsSignIn: vi.fn() });
    const before = harness.stub.github.counts.refreshes;
    const [first, second] = await Promise.all([refresher.accessToken(account, server), refresher.accessToken(account, server)]);
    expect(harness.stub.github.counts.refreshes - before).toBe(1);
    expect(first).toBe(second);
    expect(first).not.toBe(tokens.access);
    const stored = await store.get(account.id);
    expect(stored).toMatchObject({ access: first, tokenType: 'oauth' });
    expect(stored!.refresh).not.toBe(tokens.refresh);
    expect(harness.stub.github.isLive(first)).toBe(true);
  });

  it('dates the refreshed tokens by the clock it was given, on GitHub and GitLab', async () => {
    const { registry, http } = await world();
    const at = Date.now() + 3_600_000;
    for (const [id, ttl] of [['github.com', 28_800], ['gitlab.com', 7200]] as const) {
      const server = registry.get(id)!;
      const { account } = await signedIn(server, server.kind === 'github' ? 'astefanopoulos' : 'work-alexios');
      (server.kind === 'github' ? harness.stub.github : harness.stub.gitlab).tokenTtlSeconds = ttl;
      const store = createTokenStore(harness.secrets, () => undefined);
      await createRefresher({ http, tokens: store, log: () => undefined, needsSignIn: vi.fn(), now: () => at }).accessToken(account, server);
      expect((await store.get(account.id))!.accessExpiresAt).toBe(at + ttl * 1000);
    }
  });

  it('keeps the rotated tokens across a core restart, and the restarted core uses them', async () => {
    const { registry, http } = await world();
    const server = registry.get('gitlab.com')!;
    const { account } = await signedIn(server, 'work-alexios');
    const firstCore = createRefresher({ http, tokens: createTokenStore(harness.secrets, () => undefined), log: () => undefined, needsSignIn: vi.fn() });
    const rotated = await firstCore.accessToken(account, server);
    // a new core: fresh instances over the same SecretsStore contents
    const restartedSecrets = createFakeSecretsStore(Object.fromEntries(harness.secrets.entries));
    const restarted = createRefresher({ http, tokens: createTokenStore(restartedSecrets, () => undefined), log: () => undefined, needsSignIn: vi.fn(), now: () => Date.now() - 60 * 60_000 });
    expect(await restarted.accessToken(account, server)).toBe(rotated);
    // the rotated refresh token still works after the restart: the next refresh succeeds
    const later = createRefresher({ http, tokens: createTokenStore(restartedSecrets, () => undefined), log: () => undefined, needsSignIn: vi.fn() });
    const next = await later.accessToken(account, server);
    expect(next).not.toBe(rotated);
    expect(harness.stub.gitlab.isLive(next)).toBe(true);
  });

  it('marks the account "Sign in again" when the server refuses the refresh token', async () => {
    const { registry, http } = await world();
    const server = registry.get('github.com')!;
    const { account, tokens } = await signedIn(server, 'astef-admin');
    const store = createTokenStore(harness.secrets, () => undefined);
    // the refresh token was used elsewhere already (single use)
    await store.set(account.id, { ...tokens, refresh: 'ghr_stubrefresh_unknown' });
    const needsSignIn = vi.fn(async () => undefined);
    const refresher = createRefresher({ http, tokens: store, log: () => undefined, needsSignIn });
    await expect(refresher.accessToken(account, server)).rejects.toMatchObject({ kind: 'unauthorized' });
    expect(needsSignIn).toHaveBeenCalledWith(account.id);
  });

  it('keeps the current token through a 502 from the token endpoint until it expires', async () => {
    const { registry, http } = await world();
    const server = registry.get('gitlab.com')!;
    const { account, tokens } = await signedIn(server, 'alexios-s');
    harness.stub.gitlab.failTokenEndpoint = true;
    try {
      const refresher = createRefresher({ http, tokens: createTokenStore(harness.secrets, () => undefined), log: () => undefined, needsSignIn: vi.fn() });
      expect(await refresher.accessToken(account, server)).toBe(tokens.access);
      const expired = createRefresher({ http, tokens: createTokenStore(harness.secrets, () => undefined), log: () => undefined, needsSignIn: vi.fn(), now: () => Date.now() + 60_000 });
      await expect(expired.accessToken(account, server)).rejects.toMatchObject({ kind: 'server', status: 502 });
    } finally {
      harness.stub.gitlab.failTokenEndpoint = false;
    }
  });

  it('keeps the current token through a refused connection until it expires', async () => {
    const { registry, http } = await world();
    const server = registry.get('gitlab.com')!;
    const { account, tokens } = await signedIn(server, 'alexios-s');
    const closed = createServer();
    await new Promise<void>((resolve) => closed.listen(0, '127.0.0.1', resolve));
    const port = (closed.address() as AddressInfo).port;
    await new Promise<void>((resolve) => closed.close(() => resolve()));
    const unreachable: ForgeServer = { ...server, webUrl: `https://127.0.0.1:${port}`, origins: new Set([...server.origins, `https://127.0.0.1:${port}`]) };
    const refresher = createRefresher({ http, tokens: createTokenStore(harness.secrets, () => undefined), log: () => undefined, needsSignIn: vi.fn() });
    expect(await refresher.accessToken(account, unreachable)).toBe(tokens.access);
    const expired = createRefresher({ http, tokens: createTokenStore(harness.secrets, () => undefined), log: () => undefined, needsSignIn: vi.fn(), now: () => Date.now() + 60_000 });
    await expect(expired.accessToken(account, unreachable)).rejects.toMatchObject({ kind: 'network' });
  });

  it('marks the account "Sign in again" on any OAuth error code, GitHub\'s incorrect_client_credentials included', async () => {
    const { registry } = await world();
    const answering = ((url: string, init?: RequestInit) => (new URL(url).pathname === '/login/oauth/access_token'
      ? Promise.resolve(new Response(JSON.stringify({ error: 'incorrect_client_credentials', error_description: 'The client_id and/or client_secret passed are incorrect.' }), { status: 200, headers: { 'content-type': 'application/json' } }))
      : harness.fetch(url, init))) as typeof fetch;
    const http = createForgeHttp({ fetch: answering, userAgent: 'Damocles/test', log: () => undefined });
    const server = registry.get('github.com')!;
    const { account } = await signedIn(server, 'astefanopoulos');
    const needsSignIn = vi.fn(async () => undefined);
    const logs: string[] = [];
    const refresher = createRefresher({ http, tokens: createTokenStore(harness.secrets, () => undefined), log: (line) => logs.push(line), needsSignIn });
    await expect(refresher.accessToken({ ...account, auth: 'browser' }, server)).rejects.toMatchObject({ kind: 'unauthorized' });
    expect(needsSignIn).toHaveBeenCalledWith(account.id);
    expect(logs.join('\n')).not.toContain('incorrect');
  });

  it('rotates once for two callers refused for the same token, and both get the rotated one', async () => {
    harness.stub.github.tokenTtlSeconds = 28_800;
    const { registry, http } = await world();
    const server = registry.get('github.com')!;
    const { account, tokens } = await signedIn(server, 'astefanopoulos');
    const refresher = createRefresher({ http, tokens: createTokenStore(harness.secrets, () => undefined), log: () => undefined, needsSignIn: vi.fn() });
    const before = harness.stub.github.counts.refreshes;
    const [first, second] = await Promise.all([refresher.refreshNow(account, server, tokens.access), refresher.refreshNow(account, server, tokens.access)]);
    expect(harness.stub.github.counts.refreshes - before).toBe(1);
    expect(first).not.toBe(tokens.access);
    expect(second).toBe(first);
    expect(harness.stub.github.isLive(first)).toBe(true);
  });

  it('sends GitHub\'s client secret only for a browser-route token, and GitLab\'s client id only', async () => {
    const sent: URLSearchParams[] = [];
    const recording = ((url: string, init?: RequestInit) => {
      if (typeof init?.body === 'string') sent.push(new URLSearchParams(init.body));
      return harness.fetch(url, init);
    }) as typeof fetch;
    const { registry } = await world();
    const http = createForgeHttp({ fetch: recording, userAgent: 'Damocles/test', log: () => undefined });
    const github = registry.get('github.com')!;
    const device = await signedIn(github, 'astefanopoulos');
    await createRefresher({ http, tokens: createTokenStore(harness.secrets, () => undefined), log: () => undefined, needsSignIn: vi.fn() }).accessToken(device.account, github);
    expect(sent.at(-1)!.has('client_secret')).toBe(false);
    const browser = await signedIn(github, 'astef-admin');
    await createRefresher({ http, tokens: createTokenStore(harness.secrets, () => undefined), log: () => undefined, needsSignIn: vi.fn() }).accessToken({ ...browser.account, auth: 'browser' }, github);
    expect(sent.at(-1)!.get('client_secret')).toBe(harness.stub.github.spec.clientSecret);
    const gitlab = registry.get('gitlab.com')!;
    const gl = await signedIn(gitlab, 'work-alexios');
    await createRefresher({ http, tokens: createTokenStore(harness.secrets, () => undefined), log: () => undefined, needsSignIn: vi.fn() }).accessToken(gl.account, gitlab);
    expect([...sent.at(-1)!.keys()].sort()).toEqual(['client_id', 'grant_type', 'redirect_uri', 'refresh_token']);
  });

  it('leaves a token that expires later than 5 min alone', async () => {
    harness.stub.github.tokenTtlSeconds = 3600;
    const { registry, http } = await world();
    const server = registry.get('github.com')!;
    const { account, tokens } = await signedIn(server, 'astefanopoulos');
    const before = harness.stub.github.counts.refreshes;
    expect(await createRefresher({ http, tokens: createTokenStore(harness.secrets, () => undefined), log: () => undefined, needsSignIn: vi.fn() }).accessToken(account, server)).toBe(tokens.access);
    expect(harness.stub.github.counts.refreshes).toBe(before);
  });
});
