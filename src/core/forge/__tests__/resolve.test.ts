import { existsSync, readFileSync } from 'node:fs';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChooseAccountAnswer, ChooseAccountRequest, ChooseAccountRows, RemoteEndpoint } from '../../../shared/forge/bindings';
import type { BindingsChange, ChooseAccountUi, ForgeGitHost, ForgeService } from '..';
import { ACCESS_CACHE_MS, ACCESS_CHECK_TIMEOUT_MS, createAccessChecker, MAX_ACCESS_CACHE_ENTRIES } from '../bindings/resolve';
import { locationOf, parseRemoteUrl } from '../remote-url';
import type { AccountRecord, ForgeServer } from '../types';
import { createHarness, type Harness } from './support/harness';
import { secretsIn } from './support/log-scan';
import type { StubServer } from './support/forge-stub';

let harness: Harness;

beforeEach(async () => {
  harness = await createHarness();
});

afterEach(async () => {
  const secrets = [harness.stub.github, harness.stub.gitlab, harness.stub.indigital, harness.stub.ghes].flatMap((server) => server.issuedSecrets());
  expect(secretsIn(harness.logs.join('\n'), secrets)).toEqual([]);
  await harness.close();
});

const PATS = {
  workAlexios: 'glpat-stubWorkAlexiosApi000001',
  alexiosS: 'glpat-stubAlexiosSApi000000008',
  alice: 'glpat-stubAliceApi00000000009',
  astef: 'glpat-stubIndigitalAstefApi00006',
  astefAdmin: 'glpat-stubIndigitalAdminApi00007',
} as const;

async function loaded(): Promise<ForgeService> {
  const service = harness.service();
  await service.load();
  return service;
}

async function signIn(service: ForgeService, serverId: string, token: string): Promise<string> {
  await service.signIn({ serverId, route: 'token', token, agentShells: false });
  const state = service.state();
  const account = state.accounts.find((item) => item.serverId === serverId && state.accounts.filter((other) => other.serverId === serverId).at(-1) === item);
  if (!account) throw new Error(`no account after signing in to ${serverId}`);
  return account.id;
}

async function addIndigital(service: ForgeService): Promise<string> {
  const outcome = await service.addServer({ url: harness.stub.indigital.webUrl, kind: 'gitlab', gitHosts: [] });
  if (!outcome.ok) throw new Error('the indigital server was not added');
  return outcome.serverId;
}

const endpoint = (remote: string, url: string): RemoteEndpoint => ({ remote, fetch: locationOf(parseRemoteUrl(url)!) });
const bindingsFile = (): unknown => {
  const file = path.join(harness.forgeDir, 'bindings.json');
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : undefined;
};

function repo(service: ForgeService, endpoints: readonly RemoteEndpoint[], projectKey = 'c:/src/damocles', authorityKey = 'local') {
  return service.repoAccounts({ projectKey, authorityKey, project: 'damocles', endpoints });
}

interface Asked {
  readonly requests: ChooseAccountRequest[];
  readonly rows: ChooseAccountRows[];
  readonly ui: ChooseAccountUi;
}

function asking(answer: (request: ChooseAccountRequest) => ChooseAccountAnswer | Promise<ChooseAccountAnswer>): Asked {
  const requests: ChooseAccountRequest[] = [];
  const rows: ChooseAccountRows[] = [];
  return { requests, rows, ui: { choose: async (request) => {
    requests.push(request);
    return answer(request);
  }, rows: (update) => rows.push(update) } };
}

describe('resolution order', () => {
  it('uses the only account on the server: auto, onlyAccount, with the access check\'s hint for the menu', async () => {
    const service = await loaded();
    const work = await signIn(service, 'gitlab.com', PATS.workAlexios);
    const view = await repo(service, [endpoint('origin', 'https://gitlab.com/alexios-s/damocles.git')]);
    expect(view?.servers).toEqual([expect.objectContaining({ serverId: 'gitlab.com', state: 'auto', how: 'onlyAccount', isPush: true, repoPath: 'alexios-s/damocles', account: expect.objectContaining({ id: work, login: 'work-alexios', canPush: true }) })]);
  });

  it('resolves https://alice@gitlab.com/... to alice by its username hint', async () => {
    const service = await loaded();
    await signIn(service, 'gitlab.com', PATS.workAlexios);
    const alice = await signIn(service, 'gitlab.com', PATS.alice);
    const view = await repo(service, [endpoint('origin', 'https://alice@gitlab.com/grp/sub/proj.git')]);
    // the hint wins although alice cannot see the repository
    expect(view?.servers[0]).toMatchObject({ state: 'auto', how: 'usernameHint', account: { id: alice, login: 'alice', canPush: false } });
  });

  it('ignores placeholder userinfo and lets the access check decide; two pushers leave the choice to the user', async () => {
    const service = await loaded();
    await signIn(service, 'gitlab.com', PATS.workAlexios);
    await signIn(service, 'gitlab.com', PATS.alexiosS);
    const view = await repo(service, [endpoint('origin', 'https://oauth2@gitlab.com/alexios-s/damocles.git')]);
    const [gitlab] = view!.servers;
    expect(gitlab).toMatchObject({ state: 'choose' });
    expect(gitlab).not.toHaveProperty('how');
    expect(gitlab!.accounts.map(({ login, canPush, owner }) => ({ login, canPush, owner }))).toEqual([
      { login: 'work-alexios', canPush: true, owner: false },
      { login: 'alexios-s', canPush: true, owner: true },
    ]);
    // one GraphQL project query per account
    expect(harness.stub.gitlab.accessChecks).toEqual(['alexios-s/damocles', 'alexios-s/damocles']);
  });

  it('picks the push-capable account by the access check, with group access, and each token reaches only its own server', async () => {
    const service = await loaded();
    const indigitalId = await addIndigital(service);
    const work = await signIn(service, 'gitlab.com', PATS.workAlexios);
    await signIn(service, 'gitlab.com', PATS.alexiosS);
    await signIn(service, indigitalId, PATS.astef);
    await signIn(service, indigitalId, PATS.astefAdmin);
    const view = await repo(service, [
      endpoint('origin', 'https://gitlab.com/indigital/tools/deploy.git'),
      endpoint('company', `${harness.stub.indigital.webUrl}/platform/api.git`),
    ]);
    const byServer = Object.fromEntries(view!.servers.map((server) => [server.serverId, server]));
    expect(byServer['gitlab.com']).toMatchObject({ state: 'auto', how: 'access', isPush: true, account: { id: work, canPush: true } });
    // both indigital accounts can push, astef-admin as owner: the user chooses
    expect(byServer[indigitalId]).toMatchObject({ state: 'choose', isPush: false, repoPath: 'platform/api' });
    expect(byServer[indigitalId]!.accounts.find((account) => account.login === 'astef-admin')).toMatchObject({ canPush: true, owner: true });
    const sent = (server: StubServer): string[] => server.requests.flatMap((request) => (request.credential !== undefined ? [request.credential] : []));
    expect(new Set(sent(harness.stub.gitlab))).toEqual(new Set([PATS.workAlexios, PATS.alexiosS]));
    expect(new Set(sent(harness.stub.indigital))).toEqual(new Set([PATS.astef, PATS.astefAdmin]));
    for (const server of [harness.stub.gitlab, harness.stub.indigital]) expect(server.requests.every((request) => request.origin === server.webUrl)).toBe(true);
  });

  it('falls back to the one account that can read when none can push', async () => {
    const service = await loaded();
    await signIn(service, 'gitlab.com', PATS.workAlexios);
    await signIn(service, 'gitlab.com', PATS.alexiosS);
    harness.stub.gitlab.projectAccess.set('alexios-s/notes', new Map([['alexios-s', 20]]));
    const view = await repo(service, [endpoint('origin', 'git@gitlab.com:alexios-s/notes.git')]);
    expect(view?.servers[0]).toMatchObject({ state: 'auto', how: 'access', account: { login: 'alexios-s', canPush: false } });
  });

  it('puts a binding first, and it survives a relaunch', async () => {
    const service = await loaded();
    await signIn(service, 'gitlab.com', PATS.workAlexios);
    const alexios = await signIn(service, 'gitlab.com', PATS.alexiosS);
    const changes: BindingsChange[] = [];
    service.onBindingsChanged((change) => changes.push(change));
    expect(await service.bindAccount('c:/src/damocles', 'gitlab.com', alexios)).toBe(true);
    expect(changes).toEqual([{ projectKeys: ['c:/src/damocles'] }]);
    const endpoints = [endpoint('origin', 'https://gitlab.com/indigital/tools/deploy.git')];
    expect((await repo(service, endpoints))?.servers[0]).toMatchObject({ state: 'chosen', how: 'bound', account: { id: alexios } });
    const relaunched = await loaded();
    // bound to the account that cannot push: the binding still wins, and the hint says so
    expect((await repo(relaunched, endpoints))?.servers[0]).toMatchObject({ state: 'chosen', how: 'bound', account: { id: alexios, canPush: false } });
  });

  it('binds "Use Git\'s own credentials" as null', async () => {
    const service = await loaded();
    await signIn(service, 'gitlab.com', PATS.workAlexios);
    await service.bindAccount('c:/src/damocles', 'gitlab.com', null);
    const view = await repo(service, [endpoint('origin', 'https://gitlab.com/alexios-s/damocles.git')]);
    expect(view?.servers[0]).toMatchObject({ state: 'ownCredentials' });
    expect(view?.servers[0]).not.toHaveProperty('account');
    expect(view?.servers[0]).not.toHaveProperty('how');
  });

  it('uses a remote host\'s default for its projects only, after their bindings', async () => {
    const service = await loaded();
    const indigitalId = await addIndigital(service);
    await signIn(service, indigitalId, PATS.astef);
    const admin = await signIn(service, indigitalId, PATS.astefAdmin);
    expect(await service.setHostDefault('ssh+prod-1', indigitalId, admin)).toBe(true);
    const endpoints = [endpoint('origin', `${harness.stub.indigital.webUrl}/platform/web.git`)];
    expect((await repo(service, endpoints, 'ssh+prod-1|/home/alexios/web', 'ssh+prod-1'))?.servers[0]).toMatchObject({ state: 'chosen', how: 'hostDefault', account: { id: admin } });
    // a local project of the same repository has no host default: the access check finds two pushers
    expect((await repo(service, endpoints))?.servers[0]).toMatchObject({ state: 'choose' });
    expect(service.hostDefaults('ssh+prod-1')).toEqual({ state: 'ready', servers: [
      expect.objectContaining({ serverId: indigitalId, defaultAccountId: admin, accounts: [expect.objectContaining({ login: 'astefanopoulos' }), expect.objectContaining({ login: 'astef-admin' })] }),
    ] });
  });

  it('shows "Sign in" for a known server with no account, and no server for an unknown host or no remote', async () => {
    const service = await loaded();
    await signIn(service, 'gitlab.com', PATS.workAlexios);
    expect((await repo(service, [endpoint('origin', 'https://github.com/astefanopoulos/damocles.git')]))?.servers).toEqual([expect.objectContaining({ serverId: 'github.com', state: 'signIn', accounts: [] })]);
    expect((await repo(service, [endpoint('origin', 'https://bitbucket.org/team/app.git')]))?.servers).toEqual([]);
    expect((await repo(service, []))?.servers).toEqual([]);
  });

  it('flags an unreachable check beside a chosen account in the account chip, whose binding still stands', async () => {
    const service = await loaded();
    const work = await signIn(service, 'gitlab.com', PATS.workAlexios);
    await signIn(service, 'gitlab.com', PATS.alexiosS);
    await service.bindAccount('c:/src/damocles', 'gitlab.com', work);
    harness.stub.gitlab.failAccess = true;
    expect((await repo(service, [endpoint('origin', 'https://gitlab.com/alexios-s/damocles.git')]))?.servers[0]).toMatchObject({ state: 'chosen', how: 'bound', checkFailed: true, account: { id: work } });
  });

  it('flags a check that could not reach the server, and checks again on recheck', async () => {
    const service = await loaded();
    await signIn(service, 'gitlab.com', PATS.workAlexios);
    await signIn(service, 'gitlab.com', PATS.alexiosS);
    harness.stub.gitlab.failAccess = true;
    const endpoints = [endpoint('origin', 'https://gitlab.com/indigital/tools/deploy.git')];
    expect((await repo(service, endpoints))?.servers[0]).toMatchObject({ state: 'choose', checkFailed: true });
    harness.stub.gitlab.failAccess = false;
    const view = await service.repoAccounts({ projectKey: 'c:/src/damocles', authorityKey: 'local', project: 'damocles', endpoints, recheck: true });
    expect(view?.servers[0]).toMatchObject({ state: 'auto', how: 'access', account: { login: 'work-alexios' } });
    expect(view?.servers[0]?.checkFailed).toBeUndefined();
  });

  it('drops the bindings and host defaults naming an account at sign-out', async () => {
    const service = await loaded();
    const work = await signIn(service, 'gitlab.com', PATS.workAlexios);
    await signIn(service, 'gitlab.com', PATS.alexiosS);
    await service.bindAccount('c:/src/a', 'gitlab.com', work);
    await service.setHostDefault('ssh+prod-1', 'gitlab.com', work);
    expect(service.state().accounts.find((account) => account.id === work)?.bindings).toEqual({ projects: 1, hosts: 1 });
    await service.signOut(work);
    expect(bindingsFile()).toEqual({ version: 1, projects: {}, hostDefaults: {} });
  });

  it('forgets a project, and a host\'s defaults and projects', async () => {
    const service = await loaded();
    const work = await signIn(service, 'gitlab.com', PATS.workAlexios);
    await service.bindAccount('c:/src/a', 'gitlab.com', work);
    await service.bindAccount('ssh+prod-1|/srv/api', 'gitlab.com', work);
    await service.setHostDefault('ssh+prod-1', 'gitlab.com', work);
    await service.forgetProject('c:/src/a');
    await service.forgetHost('ssh+prod-1');
    expect(bindingsFile()).toEqual({ version: 1, projects: {}, hostDefaults: {} });
  });
});

describe('ask once before the user\'s own git operation', () => {
  const prepare = (service: ForgeService, asked: Asked, url: string, operation: 'push' | 'clone' = 'push') => service.prepareGitOperation({
    operation,
    ...(operation === 'clone' ? {} : { projectKey: 'c:/src/damocles' }),
    authorityKey: 'local',
    project: 'damocles',
    remotes: [],
    endpoints: [endpoint('origin', url)],
  }, asked.ui, new AbortController().signal);

  it('takes the 1 s fast path with exactly one push-capable account: no dialog, nothing written', async () => {
    const service = await loaded();
    await signIn(service, 'gitlab.com', PATS.workAlexios);
    await signIn(service, 'gitlab.com', PATS.alexiosS);
    const asked = asking(() => ({ kind: 'cancelled' }));
    expect(await prepare(service, asked, 'https://gitlab.com/indigital/tools/deploy.git')).toEqual({ proceed: true });
    expect(asked.requests).toEqual([]);
    expect(bindingsFile()).toBeUndefined();
  });

  it('asks when two accounts can push, preselects the owner, and remembers the choice', async () => {
    const service = await loaded();
    const work = await signIn(service, 'gitlab.com', PATS.workAlexios);
    const alexios = await signIn(service, 'gitlab.com', PATS.alexiosS);
    const changes: BindingsChange[] = [];
    service.onBindingsChanged((change) => changes.push(change));
    const asked = asking(() => ({ kind: 'account', accountId: work }));
    expect(await prepare(service, asked, 'https://gitlab.com/alexios-s/damocles.git')).toEqual({ proceed: true });
    expect(asked.requests).toEqual([expect.objectContaining({ projectKey: 'c:/src/damocles', project: 'damocles', serverId: 'gitlab.com', server: 'gitlab.com', kind: 'gitlab', repoPath: 'alexios-s/damocles', operation: 'push', checking: false, preselectId: alexios })]);
    expect(changes).toEqual([{ projectKeys: ['c:/src/damocles'], chosen: { projectKey: 'c:/src/damocles', serverId: 'gitlab.com', accountId: work, operation: 'push' } }]);
    expect((await repo(service, [endpoint('origin', 'https://gitlab.com/alexios-s/damocles.git')]))?.servers[0]).toMatchObject({ state: 'chosen', how: 'bound', account: { id: work } });
    // asked once: the next push resolves by the binding
    const again = asking(() => ({ kind: 'cancelled' }));
    expect(await prepare(service, again, 'https://gitlab.com/alexios-s/damocles.git')).toEqual({ proceed: true });
    expect(again.requests).toEqual([]);
  });

  it('announces a terminal credential request\'s choice without a git operation, which the request does not name', async () => {
    const service = await loaded();
    const work = await signIn(service, 'gitlab.com', PATS.workAlexios);
    await signIn(service, 'gitlab.com', PATS.alexiosS);
    const changes: BindingsChange[] = [];
    service.onBindingsChanged((change) => changes.push(change));
    const asked = asking(() => ({ kind: 'account', accountId: work }));
    const never = (): never => {
      throw new Error('not expected');
    };
    service.connectGit({ delegator: { run: never }, projectByRemote: async () => undefined, projectHolding: () => undefined, projectLabel: () => 'damocles', ui: asked.ui } as unknown as ForgeGitHost);
    const request = { op: 'get' as const, cwd: harness.forgeDir, fields: { protocol: 'https', host: 'gitlab.com', path: 'alexios-s/damocles.git' } };
    const result = await service.gitCredential(request, { kind: 'terminal', projectKey: 'c:/src/damocles' }, { authorityKey: 'local' }, new AbortController().signal);
    expect(result).toMatchObject({ account: { accountId: work, how: 'choice' } });
    expect(changes).toEqual([{ projectKeys: ['c:/src/damocles'], chosen: { projectKey: 'c:/src/damocles', serverId: 'gitlab.com', accountId: work } }]);
  });

  it('opens in checking while the access check runs, sends row updates, and a cancel stops the operation with nothing bound', async () => {
    const service = await loaded();
    await signIn(service, 'gitlab.com', PATS.workAlexios);
    await signIn(service, 'gitlab.com', PATS.alexiosS);
    harness.stub.gitlab.accessDelayMs = 1_500;
    let settleRows!: () => void;
    const rowsDone = new Promise<void>((resolve) => (settleRows = resolve));
    const asked = asking(async () => {
      await rowsDone;
      return { kind: 'cancelled' };
    });
    const originalRows = asked.ui.rows;
    const ui: ChooseAccountUi = { choose: asked.ui.choose, rows: (rows) => {
      originalRows(rows);
      if (!rows.checking) settleRows();
    } };
    const result = await service.prepareGitOperation({ operation: 'pull', projectKey: 'c:/src/damocles', authorityKey: 'local', project: 'damocles', remotes: ['origin'], endpoints: [endpoint('origin', 'https://gitlab.com/alexios-s/damocles.git')] }, ui, new AbortController().signal);
    expect(result).toEqual({ proceed: false });
    expect(asked.requests[0]).toMatchObject({ checking: true, accounts: [expect.objectContaining({ checking: true }), expect.objectContaining({ checking: true })] });
    expect(asked.rows.at(-1)).toMatchObject({ requestId: asked.requests[0]!.requestId, checking: false, accounts: [expect.objectContaining({ canPush: true }), expect.objectContaining({ canPush: true, owner: true })] });
    expect(bindingsFile()).toBeUndefined();
  }, 20_000);

  it('answers "Sign in with another account" with the server to sign in to, and the operation does not run', async () => {
    const service = await loaded();
    await signIn(service, 'gitlab.com', PATS.workAlexios);
    await signIn(service, 'gitlab.com', PATS.alexiosS);
    const asked = asking(() => ({ kind: 'signInAnother' }));
    expect(await prepare(service, asked, 'https://gitlab.com/alexios-s/damocles.git')).toEqual({ proceed: false, signInServerId: 'gitlab.com' });
  });

  it('gives a clone\'s choice back for its new project instead of writing it', async () => {
    const service = await loaded();
    await signIn(service, 'gitlab.com', PATS.workAlexios);
    const alexios = await signIn(service, 'gitlab.com', PATS.alexiosS);
    const asked = asking(() => ({ kind: 'account', accountId: alexios }));
    expect(await prepare(service, asked, 'https://gitlab.com/alexios-s/damocles.git', 'clone')).toEqual({ proceed: true, bind: { serverId: 'gitlab.com', accountId: alexios } });
    expect(asked.requests[0]?.projectKey).toBeUndefined();
    expect(bindingsFile()).toBeUndefined();
  });

  it('refuses an answer naming another server\'s account', async () => {
    const service = await loaded();
    const indigitalId = await addIndigital(service);
    const astef = await signIn(service, indigitalId, PATS.astef);
    await signIn(service, 'gitlab.com', PATS.workAlexios);
    await signIn(service, 'gitlab.com', PATS.alexiosS);
    const asked = asking(() => ({ kind: 'account', accountId: astef }));
    await expect(prepare(service, asked, 'https://gitlab.com/alexios-s/damocles.git')).rejects.toThrow('another server');
    expect(bindingsFile()).toBeUndefined();
  });
});

describe('access checker', () => {
  const server = { id: 'gitlab.com' } as ForgeServer;
  const account = (id: string): AccountRecord => ({ id, serverId: 'gitlab.com', userId: id, login: id, auth: 'token', scopes: ['api'], agentShells: false, addedAt: 0 });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('gives up on a check after 10 s, as unreachable, and does not keep that answer', async () => {
    vi.useFakeTimers();
    const signals: AbortSignal[] = [];
    let calls = 0;
    const checker = createAccessChecker({
      check: (_account, _server, _path, signal) => {
        calls += 1;
        signals.push(signal);
        return new Promise(() => undefined);
      },
      now: () => 0,
      log: () => undefined,
    });
    const outcome = checker.run([account('a')], server, 'grp/proj', false).get('a')!;
    await vi.advanceTimersByTimeAsync(ACCESS_CHECK_TIMEOUT_MS - 1);
    let settled = false;
    void outcome.then(() => (settled = true));
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await outcome).toEqual({ kind: 'unreachable' });
    expect(signals[0]?.aborted).toBe(true);
    expect(checker.cached('a', 'grp/proj')).toBeUndefined();
    void checker.run([account('a')], server, 'grp/proj', false);
    expect(calls).toBe(2);
  });

  it('keeps an answer for an hour, per account and repository, and checks all accounts in parallel', async () => {
    let now = 0;
    const started: string[] = [];
    const checker = createAccessChecker({
      check: async (checked) => {
        started.push(checked.id);
        return { readable: true, canPush: checked.id === 'a', owner: false };
      },
      now: () => now,
      log: () => undefined,
    });
    const first = checker.run([account('a'), account('b')], server, 'grp/proj', false);
    // both started before either answered
    expect(started).toEqual(['a', 'b']);
    expect(await first.get('a')).toEqual({ kind: 'checked', readable: true, canPush: true, owner: false });
    await first.get('b');
    now = ACCESS_CACHE_MS - 1;
    await checker.run([account('a')], server, 'grp/proj', false).get('a');
    expect(started).toEqual(['a', 'b']);
    await checker.run([account('a')], server, 'grp/other', false).get('a');
    expect(started).toEqual(['a', 'b', 'a']);
    now = ACCESS_CACHE_MS + 1;
    await checker.run([account('a')], server, 'grp/proj', false).get('a');
    expect(started).toEqual(['a', 'b', 'a', 'a']);
  });

  it('drops expired answers when it keeps one, and past its cap the least recently used first', async () => {
    let now = 0;
    const checker = createAccessChecker({ check: async () => ({ readable: true, canPush: false, owner: false }), now: () => now, log: () => undefined });
    const { cached } = checker;
    await checker.run([account('old')], server, 'grp/old', false).get('old');
    now = ACCESS_CACHE_MS;
    for (let index = 0; index < MAX_ACCESS_CACHE_ENTRIES; index++) {
      await checker.run([account('a')], server, `grp/p${index}`, false).get('a');
      // a read moves the first answer last, so the cap drops the second instead
      if (index === 1) expect(cached('a', 'grp/p0')).toBeDefined();
    }
    now = ACCESS_CACHE_MS - 1;
    expect(cached('old', 'grp/old')).toBeUndefined();
    now = ACCESS_CACHE_MS;
    await checker.run([account('a')], server, 'grp/last', false).get('a');
    expect(cached('a', 'grp/p0')).toBeDefined();
    expect(cached('a', 'grp/p1')).toBeUndefined();
    expect(cached('a', 'grp/p2')).toBeDefined();
    expect(cached('a', 'grp/last')).toBeDefined();
  });
});
