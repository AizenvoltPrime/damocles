import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeSecretsStore } from '../../../__mocks__/fake-platform';
import type { SecretsStore } from '../../../platform/secrets-store';
import { createAccountStore } from '../accounts/account-store';
import { accountSecretKey, serverSecretKey } from '../accounts/token-store';
import type { CiRepo } from '../ci-watch';
import { ForgeFileInvalidChangeError } from '../forge-file';
import { githubUser } from '../providers/github/user';
import { gitlabUser } from '../providers/gitlab/user';
import type { ForgeGitHost, ForgeService } from '..';
import type { GitCredentialRequest } from '../../../shared/git-credential';
import { createHarness, lastState, signInStates, type Harness } from './support/harness';
import { CI_UI_FIXTURES } from './support/forge-stub-ci';
import { secretsIn } from './support/log-scan';

let harness: Harness;

beforeEach(async () => {
  harness = await createHarness();
});

afterEach(async () => {
  // no log line of any test holds a token, code, verifier, device code or client secret
  const secrets = [harness.stub.github, harness.stub.gitlab, harness.stub.indigital, harness.stub.ghes].flatMap((server) => server.issuedSecrets());
  expect(secretsIn(harness.logs.join('\n'), secrets)).toEqual([]);
  await harness.close();
});

async function loaded(): Promise<ForgeService> {
  const service = harness.service();
  await service.load();
  return service;
}

const account = (service: ForgeService, login: string, serverId?: string) => {
  const found = service.state().accounts.find((item) => item.login === login && (serverId === undefined || item.serverId === serverId));
  if (!found) throw new Error(`no account ${login}`);
  return found;
};

const accountSecrets = (): string[] => [...harness.secrets.entries.keys()].filter((key) => key.startsWith('damocles.forge.account.'));

const jsonResponse = (body: unknown): Response => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

/** The harness fetch, after `answer`: a Response it returns stands in for the server's answer. */
function fetchWith(answer: (url: URL, authorization: string | undefined) => Promise<Response | undefined> | Response | undefined): typeof fetch {
  return (async (input: string, init?: RequestInit) => {
    const authorization = (init?.headers as Record<string, string> | undefined)?.['Authorization'];
    return (await answer(new URL(input), authorization)) ?? harness.fetch(input, init);
  }) as typeof fetch;
}

/** A git host that resolves no project and is never asked to choose or delegate. */
function gitHost(): ForgeGitHost {
  const never = (): never => {
    throw new Error('not expected');
  };
  return {
    delegator: { run: never } as unknown as ForgeGitHost['delegator'],
    projectByRemote: () => Promise.resolve(undefined),
    projectHolding: () => undefined,
    projectLabel: () => '',
    ui: { choose: never, rows: never },
  };
}

/** A store of a password Damocles never answered: the policy answers none without delegating. */
const storeRequest = (): GitCredentialRequest => ({ op: 'store', cwd: harness.forgeDir, fields: { protocol: 'https', host: 'example.com' } });

/** A promise the test resolves, and one that resolves when the held request arrives. */
function gate(): { open: () => void; opened: Promise<void>; arrived: () => void; arrival: Promise<void> } {
  let open!: () => void;
  let arrived!: () => void;
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  const arrival = new Promise<void>((resolve) => {
    arrived = resolve;
  });
  return { open, opened, arrived, arrival };
}

describe('accounts: sign-in', () => {
  it('shows loading until the files are read, then the built-in servers', async () => {
    const service = harness.service();
    expect(service.state().status).toBe('loading');
    await service.load();
    const state = lastState(harness);
    expect(state.status).toBe('ready');
    expect(state.servers.map((server) => server.id)).toEqual(['github.com', 'gitlab.com']);
    expect(state.servers[1]).toMatchObject({ builtIn: true, tokenScopes: ['api'], gitHosts: ['gitlab.com', 'altssh.gitlab.com'] });
    expect(state.showAvatars).toBe(true);
  });

  it('replays the Git hosting sign-in journey: gitlab.com by token, the missing-api refusal, then "Signed in as work-alexios"', async () => {
    const service = await loaded();
    await service.signIn({ serverId: 'gitlab.com', route: 'token', token: 'glpat-stubWorkAlexiosRead00002', agentShells: false });
    expect(signInStates(harness, 'gitlab.com').at(-1)).toEqual({ phase: 'idle', error: { kind: 'input', message: { message: 'This token is missing the {0} scope. Create one with the scopes above and try again.', args: ['api'] } } });
    await service.signIn({ serverId: 'gitlab.com', route: 'token', token: 'glpat-stubWorkAlexiosApi000001', agentShells: false });
    expect(signInStates(harness, 'gitlab.com').at(-1)).toEqual({ phase: 'signedIn', accountId: 'gitlab.com|2002', login: 'work-alexios' });
    expect(account(service, 'work-alexios')).toMatchObject({ route: 'token', agentShells: false, needsSignIn: false, scopes: ['api'], name: 'Alexios at Indigital' });
    expect(harness.secrets.entries.get(accountSecretKey('gitlab.com|2002'))).toContain('glpat-stubWorkAlexiosApi000001');
    const file = readFileSync(path.join(harness.forgeDir, 'accounts.json'), 'utf8');
    expect(file).toContain('work-alexios');
    expect(file).not.toContain('glpat-');
  });

  it('signs in to GitHub in the browser with the avatar, then a second account asking which account', async () => {
    const service = await loaded();
    harness.stub.github.nextLogin = 'astefanopoulos';
    await service.signIn({ serverId: 'github.com', route: 'browser', agentShells: true });
    expect(signInStates(harness, 'github.com').map((state) => state.phase)).toEqual(['starting', 'browser', 'finishing', 'signedIn']);
    const first = account(service, 'astefanopoulos');
    expect(first).toMatchObject({ route: 'browser', agentShells: true });
    const avatar = await service.avatar(first.avatarKey!);
    expect(avatar?.mime).toBe('image/png');
    expect(service.mirror().avatarKeys).toContain(first.avatarKey);
    harness.stub.github.nextLogin = 'astef-admin';
    await service.signIn({ serverId: 'github.com', route: 'browser', agentShells: true });
    expect(harness.stub.github.authorizeParams.at(-1)).toMatchObject({ prompt: 'select_account' });
    expect(service.state().accounts.map((item) => item.login).sort()).toEqual(['astef-admin', 'astefanopoulos']);
  });

  it('opens the authorize page again while the browser phase waits', async () => {
    const service = await loaded();
    harness.autoBrowser = false;
    try {
      const running = service.signIn({ serverId: 'github.com', route: 'browser', agentShells: true });
      await expect.poll(() => signInStates(harness, 'github.com').at(-1)?.phase).toBe('browser');
      const authorize = harness.opened.at(-1)!;
      expect(authorize).toContain('/login/oauth/authorize?');
      expect(await service.openPage({ page: 'signIn', serverId: 'github.com' })).toBe(true);
      expect(harness.opened.at(-1)).toBe(authorize);
      await service.cancelSignIn('github.com');
      await running;
    } finally {
      harness.autoBrowser = true;
    }
  });

  it('closes the loopback receiver of a browser sign-in still waiting when the service is disposed', async () => {
    const service = await loaded();
    harness.autoBrowser = false;
    try {
      const running = service.signIn({ serverId: 'github.com', route: 'browser', agentShells: true });
      await expect.poll(() => signInStates(harness, 'github.com').at(-1)?.phase).toBe('browser');
      const callback = new URL(new URL(harness.opened.at(-1)!).searchParams.get('redirect_uri')!);
      expect(callback.hostname).toBe('127.0.0.1');
      // the receiver listens while the browser phase waits: a stray request is answered, not refused
      expect((await fetch(new URL('/other', callback))).status).toBeGreaterThanOrEqual(400);
      service.dispose();
      await running;
      await expect(fetch(callback)).rejects.toThrow();
      expect(accountSecrets()).toEqual([]);
    } finally {
      harness.autoBrowser = true;
    }
  });

  it('revokes the access token a second sign-in of the same user replaces, and keeps the new set', async () => {
    const service = await loaded();
    harness.stub.github.nextLogin = 'astefanopoulos';
    await service.signIn({ serverId: 'github.com', route: 'browser', agentShells: true });
    const id = account(service, 'astefanopoulos').id;
    const first = JSON.parse(harness.secrets.entries.get(accountSecretKey(id))!) as { access: string };
    await service.signIn({ serverId: 'github.com', route: 'browser', agentShells: true });
    const second = JSON.parse(harness.secrets.entries.get(accountSecretKey(id))!) as { access: string };
    expect(second.access).not.toBe(first.access);
    expect(harness.stub.github.revoked()).toEqual([first.access]);
    expect(harness.stub.github.isLive(second.access)).toBe(true);
    expect(service.state().accounts).toHaveLength(1);
  });

  it('turns avatars off with damocles.desktop.forge.showAvatars', async () => {
    const service = await loaded();
    await service.signIn({ serverId: 'github.com', route: 'browser', agentShells: true });
    harness.settings['damocles.desktop.forge.showAvatars'] = false;
    const key = service.state().accounts[0]!.avatarKey!;
    expect(service.state().showAvatars).toBe(false);
    expect(await service.avatar(key)).toBeUndefined();
    expect(service.mirror().avatarKeys).toEqual([]);
  });

  it('signs in to GitLab by device code: shows, copies and opens the code, and cancels', async () => {
    const service = await loaded();
    const running = service.signIn({ serverId: 'gitlab.com', route: 'device', agentShells: true });
    await expect.poll(() => signInStates(harness, 'gitlab.com').at(-1)?.phase).toBe('deviceCode');
    const shown = signInStates(harness, 'gitlab.com').at(-1);
    expect(shown).toMatchObject({ phase: 'deviceCode', userCode: 'DMCL1234', verificationUri: `${harness.stub.gitlab.webUrl}/oauth/device` });
    expect(await service.copySignInCode('gitlab.com')).toBe(true);
    expect(harness.clipboard).toEqual(['DMCL1234']);
    expect(await service.openPage({ page: 'signIn', serverId: 'gitlab.com' })).toBe(true);
    expect(harness.opened.at(-1)).toBe(`${harness.stub.gitlab.webUrl}/oauth/device`);
    await service.cancelSignIn('gitlab.com');
    await running;
    expect(signInStates(harness, 'gitlab.com').at(-1)).toEqual({ phase: 'idle', error: { kind: 'cancelled', message: { message: 'Sign-in cancelled.' } } });
    expect(await service.copySignInCode('gitlab.com')).toBe(false);
  });

  it('signs in to GitLab by device code once approved', async () => {
    const service = await loaded();
    const running = service.signIn({ serverId: 'gitlab.com', route: 'device', agentShells: true });
    await expect.poll(() => signInStates(harness, 'gitlab.com').at(-1)?.phase).toBe('deviceCode');
    harness.stub.gitlab.approveDevice('alexios-s');
    await running;
    expect(signInStates(harness, 'gitlab.com').at(-1)).toMatchObject({ phase: 'signedIn', login: 'alexios-s' });
    expect(account(service, 'alexios-s')).toMatchObject({ route: 'device', agentShells: true });
  });

  it('runs one sign-in at a time', async () => {
    const service = await loaded();
    const running = service.signIn({ serverId: 'gitlab.com', route: 'device', agentShells: true });
    await expect.poll(() => signInStates(harness, 'gitlab.com').at(-1)?.phase).toBe('deviceCode');
    await service.signIn({ serverId: 'github.com', route: 'token', token: 'ghp_stubAstefanopoulosRepo0000000001', agentShells: false });
    expect(signInStates(harness, 'github.com').at(-1)).toEqual({ phase: 'idle', error: { kind: 'input', message: { message: 'Finish or cancel the sign-in to {0} first.', args: ['gitlab.com'] } } });
    await service.cancelSignIn('gitlab.com');
    await running;
  });

  it('names a host the server redirected the sign-in to when it failed there, and never says the server refused the sign-in for its 401', async () => {
    const redirected = fetchWith((url) => (url.pathname.endsWith('/user') ? new Response(null, { status: 302, headers: { location: 'https://sso.example.net/login' } }) : undefined));
    const expired = Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('expired'), { code: 'CERT_HAS_EXPIRED' }) });
    const cases = [
      [() => Promise.reject(expired), { kind: 'network', message: { message: '{0} presented a certificate this computer does not trust.', args: ['sso.example.net'] } }],
      [() => Promise.resolve(new Response(null, { status: 401 })), { kind: 'provider', message: { message: '{0} could not complete the sign-in (HTTP {1}).', args: ['sso.example.net', 401] }, status: 401 }],
    ] as const;
    for (const [publicFetch, error] of cases) {
      const service = harness.service({ fetch: redirected, publicFetch });
      await service.load();
      await service.signIn({ serverId: 'github.com', route: 'browser', agentShells: true });
      expect(signInStates(harness, 'github.com').at(-1)).toEqual({ phase: 'idle', error });
    }
  });

  it('offers only the token route on built-in servers when the build has no OAuth apps', async () => {
    const service = harness.service({ overrides: {} });
    await service.load();
    const github = service.state().servers[0]!;
    expect(github.routes.token).toEqual({});
    expect(github.routes.browser).toEqual({ reason: { message: 'This build of Damocles has no OAuth app for {0}. Sign in with a token.', args: ['github.com'] } });
    expect(github.routes.device.reason).toBeDefined();
    await service.signIn({ serverId: 'github.com', route: 'browser', agentShells: true });
    expect(signInStates(harness, 'github.com').at(-1)).toMatchObject({ phase: 'idle', error: { kind: 'provider' } });
  });
});

describe('accounts: added servers', () => {
  it('adds a self-managed GitLab, signs in by token, shows its version and proposes its git host from a project', async () => {
    const service = await loaded();
    const added = await service.addServer({ url: harness.stub.indigital.webUrl, kind: 'gitlab', gitHosts: [] });
    expect(added.ok).toBe(true);
    const serverId = (added as { serverId: string }).serverId;
    await service.signIn({ serverId, route: 'token', token: 'glpat-stubIndigitalWorkApi00004', agentShells: false });
    // recorded before the sign-in settles: the access check right after it reads the version
    expect(service.state().servers.find((server) => server.id === serverId)?.version).toBe('17.9.1-ee');
    await expect.poll(() => service.state().servers.find((server) => server.id === serverId)?.pendingGitHosts).toEqual(['git.indigital.gr']);
    const server = service.state().servers.find((item) => item.id === serverId)!;
    expect(server.gitHosts).not.toContain('git.indigital.gr');
    expect(server.routes.browser.reason).toBeDefined();
    expect(account(service, 'work-alexios', serverId).route).toBe('token');
  });

  it('manages a learned git host only once the user confirms it', async () => {
    const service = await loaded();
    const serverId = ((await service.addServer({ url: harness.stub.indigital.webUrl, kind: 'gitlab', gitHosts: [] })) as { serverId: string }).serverId;
    await service.signIn({ serverId, route: 'token', token: 'glpat-stubIndigitalWorkApi00004', agentShells: false });
    await expect.poll(() => service.state().servers.find((server) => server.id === serverId)?.pendingGitHosts).toEqual(['git.indigital.gr']);
    const managedHosts = (): string[] => service.managedServers().flatMap((server) => server.gitHosts);
    const mirrorHosts = (): string[] => service.mirror().servers.flatMap((server) => server.gitHosts);
    expect(managedHosts()).not.toContain('git.indigital.gr');
    expect(mirrorHosts()).not.toContain('git.indigital.gr');

    expect(await service.confirmGitHost(serverId, 'git.indigital.gr')).toEqual({ ok: true, serverId });
    expect(managedHosts()).toContain('git.indigital.gr');
    expect(mirrorHosts()).toContain('git.indigital.gr');
    expect(lastState(harness).servers.find((server) => server.id === serverId)).toMatchObject({ pendingGitHosts: [] });
  });

  it('drops a dismissed git host from the server and keeps it out', async () => {
    const service = await loaded();
    const serverId = ((await service.addServer({ url: harness.stub.indigital.webUrl, kind: 'gitlab', gitHosts: [] })) as { serverId: string }).serverId;
    await service.signIn({ serverId, route: 'token', token: 'glpat-stubIndigitalWorkApi00004', agentShells: false });
    await expect.poll(() => service.state().servers.find((server) => server.id === serverId)?.pendingGitHosts).toEqual(['git.indigital.gr']);
    expect(await service.dismissGitHost(serverId, 'git.indigital.gr')).toEqual({ ok: true, serverId });
    expect(lastState(harness).servers.find((server) => server.id === serverId)).toMatchObject({ pendingGitHosts: [] });
    expect(service.managedServers().flatMap((server) => server.gitHosts)).not.toContain('git.indigital.gr');
  });

  it('signs in to a self-managed GitLab in the browser with its own client id, on a free port its portless redirect URI accepts', async () => {
    const service = await loaded();
    const added = await service.addServer({ url: harness.stub.indigital.webUrl, kind: 'gitlab', clientId: harness.stub.indigital.spec.clientId, gitHosts: [] });
    const serverId = (added as { serverId: string }).serverId;
    const summary = service.state().servers.find((server) => server.id === serverId)!;
    expect(summary).toMatchObject({ oauthClientId: harness.stub.indigital.spec.clientId, redirectUri: 'http://127.0.0.1/callback', routes: { browser: {}, device: {} } });
    await service.signIn({ serverId, route: 'browser', agentShells: true });
    expect(harness.stub.indigital.authorizeParams.at(-1)!['redirect_uri']).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/);
    expect(account(service, 'work-alexios', serverId).route).toBe('browser');
  });

  it('adds a GHES server with a client id and secret, keeps the secret in SecretsStore, and signs in in the browser', async () => {
    const service = await loaded();
    const added = await service.addServer({ url: harness.stub.ghes.webUrl, kind: 'github', clientId: harness.stub.ghes.spec.clientId, clientSecret: harness.stub.ghes.spec.clientSecret!, gitHosts: [] });
    const serverId = (added as { serverId: string }).serverId;
    expect(harness.secrets.entries.get(serverSecretKey(serverId))).toBe(harness.stub.ghes.spec.clientSecret);
    expect(readFileSync(path.join(harness.forgeDir, 'servers.json'), 'utf8')).not.toContain(harness.stub.ghes.spec.clientSecret!);
    const summary = service.state().servers.find((server) => server.id === serverId)!;
    expect(summary).toMatchObject({ flavor: 'ghes', hasClientSecret: true, redirectUri: 'http://127.0.0.1/callback', routes: { browser: {} } });
    expect(JSON.stringify(service.state())).not.toContain(harness.stub.ghes.spec.clientSecret!);
    await service.signIn({ serverId, route: 'browser', agentShells: true });
    expect(signInStates(harness, serverId).at(-1)).toMatchObject({ phase: 'signedIn', login: 'astefanopoulos' });
    await expect.poll(() => service.state().servers.find((server) => server.id === serverId)?.version).toBe('3.17.2');
  });

  it('signs in to a GHES server that speaks only 2022-11-28, sending no API version until it records that one', async () => {
    const service = await loaded();
    const added = await service.addServer({ url: harness.stub.ghes.webUrl, kind: 'github', gitHosts: [] });
    const serverId = (added as { serverId: string }).serverId;
    await service.signIn({ serverId, route: 'token', token: 'ghp_stubGhesAstefanopoulosRepo0000005', agentShells: false });
    expect(signInStates(harness, serverId).at(-1)).toMatchObject({ phase: 'signedIn', login: 'astefanopoulos' });
    await expect.poll(() => JSON.parse(readFileSync(path.join(harness.forgeDir, 'servers.json'), 'utf8')) as unknown).toMatchObject({ servers: expect.arrayContaining([expect.objectContaining({ id: serverId, apiVersion: '2022-11-28' })]) });
    const api = harness.stub.ghes.requests.filter((item) => item.path.startsWith('/api/v3/'));
    expect(api.find((item) => item.path === '/api/v3/user')).toBeDefined();
    expect(api.every((item) => item.apiVersion === undefined || item.apiVersion === '2022-11-28')).toBe(true);
    expect(api.filter((item) => item.path === '/api/v3/versions').every((item) => item.apiVersion === undefined)).toBe(true);
  });

  it('offers a ghe.com tenant without its own app only the token route', async () => {
    const service = await loaded();
    const added = await service.addServer({ url: 'https://octo.ghe.com', kind: 'github', gitHosts: [] });
    expect(added).toEqual({ ok: true, serverId: 'octo.ghe.com' });
    const summary = service.state().servers.find((server) => server.id === 'octo.ghe.com')!;
    expect(summary.flavor).toBe('ghe.com');
    expect(summary.routes.browser.reason).toBeDefined();
    expect(summary.routes.device.reason).toBeDefined();
    expect(summary.routes.token).toEqual({});
  });

  it('names the fix for a refused URL and refuses a host another server owns', async () => {
    const service = await loaded();
    expect(await service.addServer({ url: 'http://gitlab.example.com', kind: 'gitlab', gitHosts: [] })).toMatchObject({ ok: false, field: 'url', message: { message: 'Use an https:// address. Damocles does not connect to servers over plain http.' } });
    expect(await service.addServer({ url: 'https://gitlab.example.com', kind: 'gitlab', gitHosts: ['github.com'] })).toMatchObject({ ok: false, field: 'gitHosts' });
    expect(await service.addServer({ url: 'https://gitlab.example.com', kind: 'gitlab', clientSecret: 'x', gitHosts: [] })).toMatchObject({ ok: false, field: 'clientSecret' });
    expect(await service.addServer({ url: 'https://ssh.github.com', kind: 'gitlab', gitHosts: [] })).toMatchObject({ ok: false, field: 'url' });
  });

  it('lets GitLab servers share a host only under disjoint path prefixes', async () => {
    const service = await loaded();
    expect(await service.addServer({ url: 'https://code.example.com/a', kind: 'gitlab', gitHosts: [] })).toEqual({ ok: true, serverId: 'code.example.com/a' });
    expect(await service.addServer({ url: 'https://code.example.com/b', kind: 'gitlab', gitHosts: [] })).toEqual({ ok: true, serverId: 'code.example.com/b' });
    expect(await service.addServer({ url: 'https://code.example.com', kind: 'gitlab', gitHosts: [] })).toMatchObject({ ok: false, field: 'url' });
    expect(await service.addServer({ url: 'https://code.example.com/a/b', kind: 'gitlab', gitHosts: [] })).toMatchObject({ ok: false, field: 'url' });
    expect(await service.addServer({ url: 'https://github.com/x', kind: 'gitlab', gitHosts: [] })).toMatchObject({ ok: false, field: 'url' });
  });

  it('removes a server after signing out its accounts', async () => {
    const service = await loaded();
    const added = await service.addServer({ url: harness.stub.indigital.webUrl, kind: 'gitlab', gitHosts: [] });
    const serverId = (added as { serverId: string }).serverId;
    await service.signIn({ serverId, route: 'token', token: 'glpat-stubIndigitalWorkApi00004', agentShells: false });
    expect(await service.removeServer(serverId)).toEqual({ ok: true, serverId });
    expect(service.state().servers.map((server) => server.id)).toEqual(['github.com', 'gitlab.com']);
    expect(service.state().accounts).toEqual([]);
    expect(await service.removeServer('github.com')).toMatchObject({ ok: false });
  });
});

describe('accounts: sign-out', () => {
  function bindTo(accountId: string): void {
    mkdirSync(harness.forgeDir, { recursive: true });
    writeFileSync(path.join(harness.forgeDir, 'bindings.json'), JSON.stringify({
      version: 1,
      projects: { 'c:/work/api': { 'github.com': { account: accountId, at: 1 } }, 'ssh+prod-1|/srv/app': { 'github.com': { account: accountId, at: 2 }, 'gitlab.com': { account: null, at: 3 } } },
      hostDefaults: { 'ssh+prod-1': { 'github.com': accountId } },
    }));
  }

  it('states the projects and hosts using it, revokes, and removes the secret, the record and the bindings', async () => {
    let service = await loaded();
    await service.signIn({ serverId: 'github.com', route: 'browser', agentShells: true });
    const signedIn = account(service, 'astefanopoulos');
    const token = JSON.parse(harness.secrets.entries.get(accountSecretKey(signedIn.id))!) as { access: string };
    bindTo(signedIn.id);
    service = await loaded();
    expect(account(service, 'astefanopoulos').bindings).toEqual({ projects: 2, hosts: 1 });
    expect(await service.signOut(signedIn.id)).toEqual({ ok: true });
    expect(harness.stub.github.revoked()).toContain(token.access);
    expect(harness.stub.github.isLive(token.access)).toBe(false);
    expect(harness.secrets.entries.has(accountSecretKey(signedIn.id))).toBe(false);
    expect(service.state().accounts).toEqual([]);
    expect(service.state().notices).toEqual([]);
    const bindings = JSON.parse(readFileSync(path.join(harness.forgeDir, 'bindings.json'), 'utf8')) as unknown;
    expect(JSON.stringify(bindings)).not.toContain(signedIn.id);
    expect(bindings).toMatchObject({ projects: { 'ssh+prod-1|/srv/app': { 'gitlab.com': { account: null } } } });
  });

  it('leaves no secret behind when a refresh is queued while sign-out revokes', async () => {
    harness.stub.github.tokenTtlSeconds = 10;
    const service = await loaded();
    await service.signIn({ serverId: 'github.com', route: 'browser', agentShells: true });
    harness.stub.github.tokenTtlSeconds = 28_800;
    const signedIn = account(service, 'astefanopoulos');
    // the avatar fetch needs a token, so it queues a refresh on the account's chain beside the sign-out
    const avatar = service.avatar(signedIn.avatarKey!).catch((err: unknown) => err);
    await service.signOut(signedIn.id);
    await avatar;
    expect([...harness.secrets.entries.keys()].filter((key) => key.startsWith('damocles.forge.account.'))).toEqual([]);
  });

  it('still signs out when the revoke fails, with a notice linking the page to revoke it by hand', async () => {
    const service = await loaded();
    await service.signIn({ serverId: 'gitlab.com', route: 'browser', agentShells: true });
    harness.stub.gitlab.failRevoke = true;
    const signedIn = account(service, 'alexios-s');
    await service.signOut(signedIn.id);
    expect(service.state().accounts).toEqual([]);
    expect(harness.secrets.entries.has(accountSecretKey(signedIn.id))).toBe(false);
    const [notice] = service.state().notices;
    expect(notice).toMatchObject({ kind: 'revokeFailed', message: { message: 'Signed out {0} on {1}, but Damocles could not revoke its token. Revoke it on {1}.', args: ['alexios-s', 'gitlab.com'] } });
    expect(await service.openPage({ page: 'revoke', noticeId: notice!.id })).toBe(true);
    expect(harness.opened.at(-1)).toBe(`${harness.stub.gitlab.webUrl}/-/user_settings/applications`);
    service.dismissNotice(notice!.id);
    expect(service.state().notices).toEqual([]);
  });

  it('cannot revoke a personal access token by API, so it links the token page', async () => {
    const service = await loaded();
    await service.signIn({ serverId: 'github.com', route: 'token', token: 'ghp_stubAstefanopoulosRepo0000000001', agentShells: false });
    await service.signOut(account(service, 'astefanopoulos').id);
    const [notice] = service.state().notices;
    await service.openPage({ page: 'revoke', noticeId: notice!.id });
    expect(harness.opened.at(-1)).toBe(`${harness.stub.github.webUrl}/settings/tokens`);
    expect(harness.stub.github.isLive('ghp_stubAstefanopoulosRepo0000000001')).toBe(true);
  });
});

describe('accounts: GitHub organization access', () => {
  it('reports an SSO org as "Authorize Damocles" with GitHub\'s URL, and an unapproved app with the app page', async () => {
    const service = await loaded();
    harness.stub.github.nextLogin = 'astefanopoulos';
    await service.signIn({ serverId: 'github.com', route: 'browser', agentShells: true });
    await expect.poll(() => account(service, 'astefanopoulos').orgAccess).toEqual([{ kind: 'ssoRequired', org: 'indigital' }]);
    const sso = account(service, 'astefanopoulos');
    expect(await service.openPage({ page: 'orgAccess', accountId: sso.id, org: 'indigital' })).toBe(true);
    expect(harness.opened.at(-1)).toBe(`${harness.stub.github.webUrl}/orgs/indigital/sso?authorization_request=stub`);
    harness.stub.github.nextLogin = 'astef-admin';
    await service.signIn({ serverId: 'github.com', route: 'browser', agentShells: true });
    await expect.poll(() => account(service, 'astef-admin').orgAccess).toEqual([{ kind: 'appNotApproved', org: 'legacy-corp' }]);
    await service.openPage({ page: 'orgAccess', accountId: account(service, 'astef-admin').id, org: 'legacy-corp' });
    expect(harness.opened.at(-1)).toBe(`${harness.stub.github.webUrl}/settings/connections/applications/${harness.stub.github.spec.clientId}`);
  });

  it('checks again when Settings opens after an hour, and clears an issue the user fixed', async () => {
    let now = Date.now();
    const service = harness.service({ now: () => now });
    await service.load();
    harness.stub.github.nextLogin = 'astefanopoulos';
    await service.signIn({ serverId: 'github.com', route: 'browser', agentShells: true });
    await expect.poll(() => account(service, 'astefanopoulos').orgAccess.length).toBe(1);
    harness.stub.github.ssoAuthorized.add('astefanopoulos');
    await service.settingsOpened();
    expect(account(service, 'astefanopoulos').orgAccess).toHaveLength(1);
    now += 61 * 60_000;
    await service.settingsOpened();
    expect(account(service, 'astefanopoulos').orgAccess).toEqual([]);
  });
});

describe('accounts: storage', () => {
  it('keeps the last records of an unparsable accounts.json, refuses changes, and reveals the file', async () => {
    mkdirSync(harness.forgeDir, { recursive: true });
    writeFileSync(path.join(harness.forgeDir, 'accounts.json'), '{ not json');
    const service = await loaded();
    const state = service.state();
    expect(state.status).toBe('error');
    expect(state.error?.kind).toBe('brokenFile');
    expect(state.error?.message).toEqual({ message: 'Damocles could not read {0}. Fix or remove the file, then restart Damocles. Until then, account changes are not saved.', args: ['accounts.json'] });
    await service.signIn({ serverId: 'gitlab.com', route: 'token', token: 'glpat-stubWorkAlexiosApi000001', agentShells: false });
    expect(signInStates(harness, 'gitlab.com').at(-1)).toMatchObject({ phase: 'idle', error: { kind: 'provider', message: { message: 'Damocles could not save the account because {0} does not parse.', args: ['accounts.json'] } } });
    expect(readFileSync(path.join(harness.forgeDir, 'accounts.json'), 'utf8')).toBe('{ not json');
    expect(await service.revealBrokenFile()).toEqual({ ok: true });
    expect(harness.revealed).toEqual([path.join(harness.forgeDir, 'accounts.json')]);
  });

  it('answers sign-out, the switch, the server forms and Show file with a refusal naming only the broken file, never throwing', async () => {
    const service = await loaded();
    await service.signIn({ serverId: 'gitlab.com', route: 'token', token: 'glpat-stubWorkAlexiosApi000001', agentShells: false });
    const id = account(service, 'work-alexios').id;
    writeFileSync(path.join(harness.forgeDir, 'accounts.json'), '{ not json');
    const broken = { ok: false, message: { message: 'Damocles could not save the change because {0} does not parse.', args: ['accounts.json'] } };
    expect(await service.setAgentShells(id, true)).toEqual(broken);
    expect(await service.signOut(id)).toEqual(broken);
    const added = await service.addServer({ url: harness.stub.indigital.webUrl, kind: 'gitlab', gitHosts: [] });
    expect(added).toMatchObject({ ok: true });
    expect(await service.removeServer((added as { serverId: string }).serverId)).toEqual(broken);
    expect(JSON.stringify(lastState(harness))).not.toContain(harness.forgeDir);
    expect(await service.revealBrokenFile()).toEqual({ ok: true });
  });

  it('refuses a change to an account or server another view removed', async () => {
    const service = await loaded();
    expect(await service.signOut('gitlab.com|404')).toEqual({ ok: false, message: { message: 'This account is no longer signed in.' } });
    expect(await service.setAgentShells('gitlab.com|404', true)).toEqual({ ok: false, message: { message: 'This account is no longer signed in.' } });
    expect(await service.removeServer('gone.example.com')).toEqual({ ok: false, message: { message: 'This server is no longer in the list.' } });
  });

  it('logs an unexpected failure by name and answers the generic refusal', async () => {
    const service = harness.service({ revealPath: () => Promise.reject(new TypeError('/home/me/forge/accounts.json is gone')) });
    mkdirSync(harness.forgeDir, { recursive: true });
    writeFileSync(path.join(harness.forgeDir, 'accounts.json'), '{ not json');
    await service.load();
    expect(await service.revealBrokenFile()).toEqual({ ok: false, message: { message: 'Damocles could not show the file.' } });
    expect(harness.logs).toContain('[forge] showing accounts.json failed: TypeError');
    expect(harness.logs.join('\n')).not.toContain('is gone');
  });

  it('answers Show file with a refusal when no file is broken', async () => {
    const service = await loaded();
    expect(await service.revealBrokenFile()).toEqual({ ok: false, message: { message: 'No Git hosting file needs fixing.' } });
    expect(harness.revealed).toEqual([]);
  });

  it('marks an account whose secret this run cannot read as "Sign in again"', async () => {
    let service = await loaded();
    await service.signIn({ serverId: 'gitlab.com', route: 'token', token: 'glpat-stubWorkAlexiosApi000001', agentShells: false });
    harness.secrets = createFakeSecretsStore();
    service = await loaded();
    expect(account(service, 'work-alexios').needsSignIn).toBe(true);
  });

  it('asks only the account whose secret read fails to sign in again, and loads the rest', async () => {
    let service = await loaded();
    await service.signIn({ serverId: 'gitlab.com', route: 'token', token: 'glpat-stubWorkAlexiosApi000001', agentShells: false });
    await service.signIn({ serverId: 'gitlab.com', route: 'token', token: 'glpat-stubAlexiosSApi000000008', agentShells: false });
    const locked = accountSecretKey(account(service, 'work-alexios').id);
    const fake = harness.secrets;
    const secrets: SecretsStore = { ...fake, get: (key) => (key === locked ? Promise.reject(new Error('keychain locked')) : fake.get(key)) };
    service = harness.service({ secrets });
    await service.load();
    expect(service.state().status).toBe('ready');
    expect(account(service, 'work-alexios').needsSignIn).toBe(true);
    expect(account(service, 'alexios-s').needsSignIn).toBe(false);
    expect(harness.logs).toContain('[forge] reading the secret of gitlab.com|2002 failed: Error');
  });

  // remote hosts' managed servers (forge.servers) wait on this, and a locked keychain can hold a secret read for good
  it('says the files were read before it reads any account\'s secret, with the servers and which have an account', async () => {
    let service = await loaded();
    await service.signIn({ serverId: 'gitlab.com', route: 'token', token: 'glpat-stubWorkAlexiosApi000001', agentShells: false });
    const fake = harness.secrets;
    let asked = false;
    const secrets: SecretsStore = {
      ...fake,
      get: (key) => {
        if (!key.startsWith('damocles.forge.account.')) return fake.get(key);
        asked = true;
        return new Promise<undefined>(() => undefined);
      },
    };
    service = harness.service({ secrets });
    void service.load();
    await service.filesRead();
    await vi.waitFor(() => expect(asked).toBe(true));
    expect(service.state().status).toBe('loading');
    expect(service.mirror().servers.find((server) => server.id === 'gitlab.com')).toMatchObject({ hasAccount: true });
  });

  it('answers a git credential request that arrives while the files are read, once they are', async () => {
    const service = harness.service();
    service.connectGit(gitHost());
    const answer = service.gitCredential(storeRequest(), { kind: 'terminal' }, { authorityKey: 'local' }, new AbortController().signal);
    await service.load();
    await expect(answer).resolves.toEqual({ answer: { kind: 'none' } });
  });

  it('refuses git credentials and changes with the restart wording after the files could not be read', async () => {
    mkdirSync(path.join(harness.forgeDir, 'servers.json'), { recursive: true });
    const service = harness.service();
    service.connectGit(gitHost());
    await expect(service.load()).rejects.toThrow();
    await expect(service.gitCredential(storeRequest(), { kind: 'terminal' }, { authorityKey: 'local' }, new AbortController().signal)).rejects.toThrow('The Git hosting accounts could not be read');
    expect(service.state().error?.kind).toBe('loadFailed');
    expect(await service.setAgentShells('gitlab.com|2002', true)).toEqual({ ok: false, message: { message: 'Damocles could not read its Git hosting accounts. Restart Damocles to try again.' } });
    expect(await service.confirmGitHost('gitlab.indigital.gr', 'git.indigital.gr')).toEqual({ ok: false, message: { message: 'Damocles could not read its Git hosting accounts. Restart Damocles to try again.' } });
  });

  it('changes the agent-shell switch and republishes', async () => {
    const service = await loaded();
    await service.signIn({ serverId: 'gitlab.com', route: 'token', token: 'glpat-stubWorkAlexiosApi000001', agentShells: false });
    await service.setAgentShells('gitlab.com|2002', true);
    expect(lastState(harness).accounts[0]!.agentShells).toBe(true);
  });

  it('writes nothing for a change accounts.json would not read back', async () => {
    const store = createAccountStore(harness.forgeDir, (line) => harness.logs.push(line));
    await store.load();
    const record = { id: 'gitlab.com|1', serverId: 'gitlab.com', userId: '1', login: '', auth: 'token', scopes: [], agentShells: false, addedAt: 1 } as const;
    await expect(store.update((current) => ({ ...current, accounts: [record] }))).rejects.toBeInstanceOf(ForgeFileInvalidChangeError);
    expect(existsSync(path.join(harness.forgeDir, 'accounts.json'))).toBe(false);
    expect(store.value().accounts).toEqual([]);
    expect(store.broken()).toBe(false);
  });

  it('marks "Sign in again" for the run when accounts.json refuses the write, so a refused CI read is sent once', async () => {
    const service = await loaded();
    await service.signIn({ serverId: 'gitlab.com', route: 'token', token: 'glpat-stubWorkAlexiosApi000001', agentShells: false });
    writeFileSync(path.join(harness.forgeDir, 'accounts.json'), '{ not json');
    harness.stub.gitlab.refusedLogins.add('work-alexios');
    const url = new URL(harness.stub.gitlab.webUrl);
    const repo: CiRepo = {
      authorityKey: 'local',
      projectKey: 'c:/src/deploy',
      project: 'deploy',
      endpoints: [{ remote: 'origin', fetch: { protocol: 'https', host: url.hostname, port: Number(url.port), path: 'indigital/tools/deploy.git', aliasResolved: false } }],
      branch: CI_UI_FIXTURES.branch,
    };
    const sent = (): number => harness.stub.gitlab.requests.filter((request) => request.authorized).length;
    const before = sent();
    await service.ci.watch('w', repo, true);
    // a loop would read again on every publish; give it time to show
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(sent() - before).toBe(1);
    expect(account(service, 'work-alexios').needsSignIn).toBe(true);
    expect(service.state().status).toBe('error');
    service.ci.unwatch('w');
  });

  it('signs out an account whose server is no longer in servers.json, without a revoke', async () => {
    let service = await loaded();
    const added = await service.addServer({ url: harness.stub.indigital.webUrl, kind: 'gitlab', gitHosts: [] });
    const serverId = (added as { serverId: string }).serverId;
    await service.signIn({ serverId, route: 'token', token: 'glpat-stubIndigitalWorkApi00004', agentShells: false });
    await expect.poll(() => service.state().servers.find((server) => server.id === serverId)?.pendingGitHosts).toContain('git.indigital.gr');
    const id = account(service, 'work-alexios', serverId).id;
    const serversFile = path.join(harness.forgeDir, 'servers.json');
    const servers = JSON.parse(readFileSync(serversFile, 'utf8')) as { servers: { id: string }[] };
    writeFileSync(serversFile, JSON.stringify({ ...servers, servers: servers.servers.filter((server) => server.id !== serverId) }));
    service = await loaded();
    await service.signOut(id);
    expect(harness.secrets.entries.has(accountSecretKey(id))).toBe(false);
    expect(readFileSync(path.join(harness.forgeDir, 'accounts.json'), 'utf8')).not.toContain(id);
    expect(harness.stub.indigital.counts.revokes).toBe(0);
    expect(harness.logs).toContain(`[forge] ${id}'s server is not in servers.json; its token is deleted without a revoke`);
  });
});

describe('accounts: the agent-shells switch across sign-ins', () => {
  it('keeps the switch off through Sign in again by the browser, and takes the token route\'s value on Sign in again by a token', async () => {
    const service = await loaded();
    harness.stub.github.nextLogin = 'astefanopoulos';
    await service.signIn({ serverId: 'github.com', route: 'browser', agentShells: true });
    const id = account(service, 'astefanopoulos').id;
    await service.setAgentShells(id, false);
    await service.signIn({ serverId: 'github.com', route: 'browser', agentShells: false, reauthAccountId: id });
    expect(signInStates(harness, 'github.com').at(-1)).toMatchObject({ phase: 'signedIn' });
    expect(account(service, 'astefanopoulos').agentShells).toBe(false);
    await service.signIn({ serverId: 'github.com', route: 'token', token: 'ghp_stubAstefanopoulosRepo0000000001', agentShells: true, reauthAccountId: id });
    expect(account(service, 'astefanopoulos')).toMatchObject({ route: 'token', agentShells: true });
  });

  it('keeps the stored switch when Add account signs in as an account already here', async () => {
    const service = await loaded();
    harness.stub.github.nextLogin = 'astefanopoulos';
    await service.signIn({ serverId: 'github.com', route: 'browser', agentShells: true });
    const id = account(service, 'astefanopoulos').id;
    await service.setAgentShells(id, false);
    await service.signIn({ serverId: 'github.com', route: 'browser', agentShells: true });
    expect(signInStates(harness, 'github.com').at(-1)).toMatchObject({ phase: 'signedIn' });
    expect(account(service, 'astefanopoulos').agentShells).toBe(false);
  });
});

describe('accounts: "Sign in again" and the token a request was refused', () => {
  it('keeps the account in its place in the list, with the new sign-in date', async () => {
    let now = 1_000;
    const service = harness.service({ now: () => now });
    await service.load();
    harness.stub.github.nextLogin = 'astefanopoulos';
    await service.signIn({ serverId: 'github.com', route: 'browser', agentShells: true });
    harness.stub.github.nextLogin = 'astef-admin';
    await service.signIn({ serverId: 'github.com', route: 'browser', agentShells: true });
    now = 2_000;
    harness.stub.github.nextLogin = 'astefanopoulos';
    await service.signIn({ serverId: 'github.com', route: 'browser', agentShells: true, reauthAccountId: account(service, 'astefanopoulos').id });
    expect(service.state().accounts.map((item) => item.login)).toEqual(['astefanopoulos', 'astef-admin']);
    expect(account(service, 'astefanopoulos').addedAt).toBe(2_000);
    const stored = JSON.parse(readFileSync(path.join(harness.forgeDir, 'accounts.json'), 'utf8')) as { accounts: { login: string }[] };
    expect(stored.accounts.map((item) => item.login)).toEqual(['astefanopoulos', 'astef-admin']);
  });

  it('leaves a new sign-in unmarked when a request still holding the token it replaced is refused', async () => {
    let now = Date.now();
    const at = gate();
    // the access token whose /user/orgs request waits at the gate
    const held: { token?: string } = {};
    const service = harness.service({
      now: () => now,
      fetch: fetchWith(async (url, authorization) => {
        if (held.token !== undefined && authorization === `Bearer ${held.token}` && url.pathname.endsWith('/user/orgs')) {
          at.arrived();
          await at.opened;
        }
        return undefined;
      }),
    });
    await service.load();
    harness.stub.github.nextLogin = 'astefanopoulos';
    await service.signIn({ serverId: 'github.com', route: 'browser', agentShells: true });
    await expect.poll(() => account(service, 'astefanopoulos').orgAccess.length).toBe(1);
    const id = account(service, 'astefanopoulos').id;
    const replaced = (JSON.parse(harness.secrets.entries.get(accountSecretKey(id))!) as { access: string }).access;
    held.token = replaced;
    now += 61 * 60_000;
    const checking = service.settingsOpened();
    await at.arrival;
    await service.signIn({ serverId: 'github.com', route: 'browser', agentShells: true, reauthAccountId: id });
    expect(harness.stub.github.isLive(replaced)).toBe(false);
    at.open();
    await checking;
    expect(harness.logs.some((line) => line.includes(`checking ${id}'s organization access failed: ForgeHttpError unauthorized`))).toBe(true);
    expect(account(service, 'astefanopoulos').needsSignIn).toBe(false);
  });
});

describe('accounts: grants Damocles does not keep', () => {
  it('revokes the grant of a sign-in cancelled after the code exchange', async () => {
    const at = gate();
    let hold = true;
    const service = harness.service({
      fetch: fetchWith(async (url) => {
        if (hold && url.pathname.endsWith('/user')) {
          hold = false;
          at.arrived();
          await at.opened;
        }
        return undefined;
      }),
    });
    await service.load();
    const running = service.signIn({ serverId: 'github.com', route: 'browser', agentShells: true });
    await at.arrival;
    const cancelling = service.cancelSignIn('github.com');
    at.open();
    await cancelling;
    await running;
    expect(signInStates(harness, 'github.com').at(-1)).toMatchObject({ phase: 'idle', error: { kind: 'cancelled' } });
    expect(harness.stub.github.revoked()).toHaveLength(1);
    expect(accountSecrets()).toEqual([]);
    expect(service.state().accounts).toEqual([]);
  });

  it('refuses a login with a line break or a bidi control, and revokes the grant', async () => {
    for (const login of ['astef\nadmin', 'astef\u202Eadmin']) {
      const service = harness.service({ fetch: fetchWith((url) => (url.pathname.endsWith('/user') ? jsonResponse({ id: 501, login }) : undefined)) });
      await service.load();
      await service.signIn({ serverId: 'github.com', route: 'browser', agentShells: true });
      expect(signInStates(harness, 'github.com').at(-1)).toEqual({ phase: 'idle', error: { kind: 'provider', message: { message: '{0} could not complete the sign-in.', args: ['github.com'] } } });
      expect(service.state().accounts).toEqual([]);
    }
    expect(harness.stub.github.revoked()).toHaveLength(2);
    expect(accountSecrets()).toEqual([]);
    expect(existsSync(path.join(harness.forgeDir, 'accounts.json'))).toBe(false);
  });

  it('refuses a GitLab browser sign-in below 16.1 with the token route\'s words, and revokes the grant', async () => {
    const service = harness.service({ fetch: fetchWith((url) => (url.pathname.endsWith('/api/v4/version') ? jsonResponse({ version: '16.0.8-ee' }) : undefined)) });
    await service.load();
    await service.signIn({ serverId: 'gitlab.com', route: 'browser', agentShells: true });
    expect(signInStates(harness, 'gitlab.com').at(-1)).toEqual({ phase: 'idle', error: { kind: 'provider', message: { message: 'This server runs GitLab {0}. Damocles needs GitLab 16.1 or later.', args: ['16.0.8-ee'] } } });
    expect(harness.stub.gitlab.revoked()).toHaveLength(1);
    expect(accountSecrets()).toEqual([]);
    expect(service.state().accounts).toEqual([]);
  });

  it('deletes the secret and revokes the grant when accounts.json cannot be written', async () => {
    const service = await loaded();
    mkdirSync(path.join(harness.forgeDir, 'accounts.json'));
    await service.signIn({ serverId: 'gitlab.com', route: 'browser', agentShells: true });
    expect(signInStates(harness, 'gitlab.com').at(-1)).toMatchObject({ phase: 'idle', error: { kind: 'provider' } });
    expect(accountSecrets()).toEqual([]);
    expect(harness.stub.gitlab.revoked()).toHaveLength(1);
  });

  it('puts the previous secret back when accounts.json cannot be written, and logs a failed restore under the write\'s own error', async () => {
    const fake = harness.secrets;
    let failStore: number | undefined;
    const secrets: SecretsStore = {
      ...fake,
      store: async (key, value) => {
        if (failStore !== undefined && --failStore === 0) throw new Error('store refused');
        await fake.store(key, value);
      },
    };
    const service = harness.service({ secrets });
    await service.load();
    await service.signIn({ serverId: 'gitlab.com', route: 'browser', agentShells: true });
    const id = account(service, 'alexios-s').id;
    const first = harness.secrets.entries.get(accountSecretKey(id));
    // a folder where the file was: every later write fails, and the run keeps the record it read
    const accountsFile = path.join(harness.forgeDir, 'accounts.json');
    rmSync(accountsFile);
    mkdirSync(accountsFile);
    await service.signIn({ serverId: 'gitlab.com', route: 'browser', agentShells: true });
    expect(harness.secrets.entries.get(accountSecretKey(id))).toBe(first);
    expect(harness.stub.gitlab.revoked()).toHaveLength(1);
    failStore = 2;
    await service.signIn({ serverId: 'gitlab.com', route: 'browser', agentShells: true });
    expect(harness.logs).toContain(`[forge] restoring ${id}'s secret after a failed write failed: Error`);
    expect(harness.logs.some((line) => /sign-in to gitlab\.com by browser ended: provider \(JsonConfigWriteError\)/.test(line))).toBe(true);
  });
});

describe('accounts: removing a server', () => {
  it('ends a sign-in waiting for its device code, so no secret or account of it is left', async () => {
    const service = await loaded();
    const added = await service.addServer({ url: harness.stub.indigital.webUrl, kind: 'gitlab', clientId: harness.stub.indigital.spec.clientId, gitHosts: [] });
    const serverId = (added as { serverId: string }).serverId;
    const running = service.signIn({ serverId, route: 'device', agentShells: true });
    await expect.poll(() => signInStates(harness, serverId).at(-1)?.phase).toBe('deviceCode');
    const removal = service.removeServer(serverId);
    harness.stub.indigital.approveDevice('work-alexios');
    expect(await removal).toEqual({ ok: true, serverId });
    await running;
    expect(signInStates(harness, serverId).at(-1)).toMatchObject({ phase: 'idle', error: { kind: 'cancelled' } });
    expect(accountSecrets()).toEqual([]);
    expect(existsSync(path.join(harness.forgeDir, 'accounts.json')) ? readFileSync(path.join(harness.forgeDir, 'accounts.json'), 'utf8') : '').not.toContain(serverId);
    expect(service.state().accounts).toEqual([]);
  });
});

describe('accounts: the login a server answers', () => {
  it('takes only a login the server issues', () => {
    expect(githubUser({ id: 1, login: 'astef-admin' }).login).toBe('astef-admin');
    expect(gitlabUser({ id: 1, username: 'project_42_bot' }).login).toBe('project_42_bot');
    for (const login of ['', 'a\nb', 'a\u202Eb', '-lead', 'a'.repeat(40), 'a b']) expect(() => githubUser({ id: 1, login })).toThrow();
    for (const login of ['', 'a\nb', 'a\u202Eb', '.lead', 'a'.repeat(256), 'a/b']) expect(() => gitlabUser({ id: 1, username: login })).toThrow();
  });
});
