import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTokenStore } from '../accounts/token-store';
import { createForgeHttp } from '../http';
import { runWebFlow } from '../oauth/web-flow';
import { providerFor } from '../providers/provider';
import { createServerRegistry, type ServerRegistry } from '../servers';
import type { ForgeServer } from '../types';
import { createHarness, type Harness } from './support/harness';

let harness: Harness;
let registry: ServerRegistry;

beforeAll(async () => {
  harness = await createHarness();
  const deps = harness.deps();
  registry = createServerRegistry({ forgeDir: harness.forgeDir, tokens: createTokenStore(harness.secrets, () => undefined), buildOAuth: {}, overrides: deps.overrides!, log: () => undefined });
  await registry.load();
});

afterAll(async () => {
  await harness.close();
});

function flow(server: ForgeServer, login?: string) {
  const deps = harness.deps();
  const http = createForgeHttp({ fetch: harness.fetch, userAgent: 'Damocles/test', log: () => undefined });
  let waited = 0;
  const grant = runWebFlow({ http, openExternal: deps.openExternal, log: () => undefined }, server, providerFor(server.kind), {
    client: server.oauth!,
    ...(login !== undefined ? { login } : {}),
    signal: new AbortController().signal,
    onWaiting: () => (waited += 1),
  });
  return { grant, waited: () => waited };
}

describe('browser sign-in', () => {
  it('signs in to GitHub through the loopback with PKCE, asking which account', async () => {
    const before = harness.stub.github.authorizeParams.length;
    const { grant, waited } = flow(registry.get('github.com')!);
    const result = await grant;
    expect(waited()).toBe(1);
    expect(result.tokens.access).toMatch(/^gho_stub/);
    expect(result.tokens.refresh).toMatch(/^ghr_stub/);
    expect(result.tokens.accessExpiresAt).toBeGreaterThan(Date.now());
    const params = harness.stub.github.authorizeParams[before]!;
    expect(params).toMatchObject({ prompt: 'select_account', code_challenge_method: 'S256', scope: 'repo workflow read:user user:email read:org offline_access' });
    expect(params['login']).toBeUndefined();
    expect(params['redirect_uri']).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/);
  });

  it('names the login for "Sign in again" instead of asking', async () => {
    const before = harness.stub.github.authorizeParams.length;
    await flow(registry.get('github.com')!, 'astef-admin').grant;
    const params = harness.stub.github.authorizeParams[before]!;
    expect(params['login']).toBe('astef-admin');
    expect(params['prompt']).toBeUndefined();
  });

  it('signs in to GitLab on a free loopback port its portless registered URI accepts, with api and write_repository', async () => {
    const before = harness.stub.gitlab.authorizeParams.length;
    const result = await flow(registry.get('gitlab.com')!).grant;
    expect(result.scopes).toEqual(['api', 'write_repository']);
    expect(harness.stub.gitlab.authorizeParams[before]).toMatchObject({ scope: 'api write_repository', response_type: 'code' });
    const redirect = new URL(harness.stub.gitlab.authorizeParams[before]!['redirect_uri']!);
    expect([redirect.protocol, redirect.hostname, redirect.pathname]).toEqual(['http:', '127.0.0.1', '/callback']);
    expect(Number(redirect.port)).toBeGreaterThan(0);
  });

  it('meets a GitLab that refuses any redirect but a loopback IP one on the registered path, whatever its port', async () => {
    const authorize = async (redirectUri: string): Promise<number> => {
      const params = new URLSearchParams({ client_id: harness.stub.gitlab.spec.clientId, redirect_uri: redirectUri, response_type: 'code', state: 's', code_challenge: 'c', code_challenge_method: 'S256' });
      const response = await harness.fetch(`${harness.stub.gitlab.webUrl}/oauth/authorize?${params.toString()}`, { redirect: 'manual' });
      await response.body?.cancel();
      return response.status;
    };
    expect(await authorize('http://127.0.0.1:49999/callback')).toBe(302);
    expect(await authorize('http://localhost:49999/callback')).toBe(400);
    expect(await authorize('http://127.0.0.1:49999/elsewhere')).toBe(400);
    expect(await authorize('https://127.0.0.1:49999/callback')).toBe(400);
  });

  it('fails with the fix when the browser cannot open', async () => {
    const http = createForgeHttp({ fetch: harness.fetch, userAgent: 'Damocles/test', log: () => undefined });
    const server = registry.get('github.com')!;
    await expect(runWebFlow({ http, openExternal: async () => false, log: () => undefined }, server, providerFor('github'), { client: server.oauth!, signal: new AbortController().signal, onWaiting: () => undefined }))
      .rejects.toMatchObject({ kind: 'provider', text: { message: 'Damocles could not open your browser. Sign in with a device code or a token.' } });
  });

  it('stops on cancel while it waits for the browser', async () => {
    harness.autoBrowser = false;
    try {
      const controller = new AbortController();
      const http = createForgeHttp({ fetch: harness.fetch, userAgent: 'Damocles/test', log: () => undefined });
      const server = registry.get('github.com')!;
      const running = runWebFlow({ http, openExternal: harness.deps().openExternal, log: () => undefined }, server, providerFor('github'), { client: server.oauth!, signal: controller.signal, onWaiting: () => controller.abort() });
      await expect(running).rejects.toMatchObject({ kind: 'cancelled' });
    } finally {
      harness.autoBrowser = true;
    }
  });
});
