import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ForgeService } from '..';
import { isRepositoryName, sanitizeRepositoryName, typedRepositoryName, type PublishAccount, type PublishNamespace } from '../../../shared/forge/publish';
import type { RemoteEndpoint } from '../../../shared/forge/bindings';
import type { BindingStore } from '../bindings/binding-store';
import type { ForgeHttp, ForgeRequest } from '../http';
import { createPublisher, FORK_LIMIT_MS, githubNamespaces, MAX_NAMESPACE_PAGES, mergeRequestUrl, offersInternal, ownerValue, serverReason } from '../publish';
import { ForgeHttpError, type AccountRecord, type ForgeServer } from '../types';
import { FORGE_CLONE_PROTOCOL_SETTING } from '../types';
import { createHarness, type Harness } from './support/harness';

// Publish and fork on a denied push against the stub (docs/invariants.md "GitHub and GitLab accounts", publish and fork):
// namespaces, the Owner value rule, a refused name, the push access check that alone offers a fork, and the fork's polls.

let harness: Harness;
let service: ForgeService;
let indigitalId: string;
const signal = (): AbortSignal => new AbortController().signal;

let accounts: readonly PublishAccount[] = [];
// each account's organizations or groups as its latest listing answered them
const owners = new Map<string, readonly PublishNamespace[]>();
const accountOf = (serverName: string): PublishAccount => {
  const found = accounts.find((account) => account.serverName === serverName);
  if (!found) throw new Error(`no account on ${serverName}`);
  return found;
};
const namespacesOf = (serverName: string): readonly PublishNamespace[] => [accountOf(serverName).personal, ...(owners.get(serverName) ?? [])];
const valueOf = (serverName: string, path: string): string => {
  const found = namespacesOf(serverName).find((namespace) => namespace.path === path);
  if (!found) throw new Error(`no ${path} on ${serverName}`);
  return found.value;
};
async function listOwners(serverName: string): Promise<void> {
  const answer = await service.publishing.owners(accountOf(serverName).accountId, signal());
  if (answer.status !== 'loaded') throw new Error(`the owners of ${serverName} answered ${answer.status}`);
  owners.set(serverName, answer.owners);
}

const endpointOf = (host: string, path: string, port?: number): RemoteEndpoint => ({ remote: 'origin', fetch: { protocol: 'https', host, ...(port !== undefined ? { port } : {}), path, aliasResolved: false } });
const stubEndpoint = (webUrl: string, path: string): RemoteEndpoint => {
  const url = new URL(webUrl);
  return endpointOf(url.hostname, path, Number(url.port));
};

beforeAll(async () => {
  harness = await createHarness();
  service = harness.service();
  await service.load();
  const added = await service.addServer({ url: harness.stub.indigital.webUrl, kind: 'gitlab', gitHosts: [] });
  if (!added.ok) throw new Error('could not add the stub indigital server');
  indigitalId = added.serverId;
  await service.signIn({ serverId: indigitalId, route: 'token', token: 'glpat-stubIndigitalAstefApi00006', agentShells: false });
  await service.signIn({ serverId: 'gitlab.com', route: 'token', token: 'glpat-stubAlexiosSApi000000008', agentShells: false });
  await service.signIn({ serverId: 'github.com', route: 'token', token: 'ghp_stubAstefanopoulosRepo0000000001', agentShells: false });
  accounts = (await service.publishing.accounts()).accounts;
  for (const account of accounts) await listOwners(account.serverName);
}, 60_000);

afterAll(async () => {
  await harness.close();
});

describe('names and Owner values', () => {
  it('sanitizes a name as VS Code does, and the typed form turns a space into a dash at once', () => {
    expect(sanitizeRepositoryName('  damocles fork ')).toBe('damocles-fork');
    expect(sanitizeRepositoryName('ünïcode/name')).toBe('-n-code-name');
    expect(typedRepositoryName('damocles ')).toBe('damocles-');
    expect(isRepositoryName('damocles-fork')).toBe(true);
    expect(['', '.', '..', 'a b', 'x'.repeat(101)].some(isRepositoryName)).toBe(false);
  });

  it('keeps the user namespace at personal and moves an organization or group literally named personal to ~personal', () => {
    expect(ownerValue('gitlab.com', 'alexios-s', 'personal', 'alexios-s')).toBe('gitlab.com|alexios-s|personal');
    expect(ownerValue('gitlab.com', 'alexios-s', 'group', 'personal')).toBe('gitlab.com|alexios-s|~personal');
    expect(ownerValue('github.com', 'astefanopoulos', 'org', 'personal')).toBe('github.com|astefanopoulos|~personal');
    expect(ownerValue('gitlab.indigital.gr', 'astefanopoulos', 'group', 'grp/platform')).toBe('gitlab.indigital.gr|astefanopoulos|grp/platform');
    expect(ownerValue('gitlab.com', 'alexios-s', 'group', 'personal')).not.toBe(ownerValue('gitlab.com', 'alexios-s', 'personal', 'alexios-s'));
  });

  it('offers Internal on GitLab and on a GitHub Enterprise Server organization only', () => {
    expect(offersInternal({ kind: 'gitlab', flavor: 'gitlab' }, 'personal')).toBe(true);
    expect(offersInternal({ kind: 'github', flavor: 'ghes' }, 'org')).toBe(true);
    expect(offersInternal({ kind: 'github', flavor: 'ghes' }, 'personal')).toBe(false);
    expect(offersInternal({ kind: 'github', flavor: 'github.com' }, 'org')).toBe(false);
    expect(offersInternal({ kind: 'github', flavor: 'ghe.com' }, 'org')).toBe(false);
  });

  it('reads a server refusal as its own words, escaped and bounded', () => {
    expect(serverReason({ message: 'Repository creation failed.', errors: [{ message: 'name already exists on this account' }] })).toBe('name already exists on this account');
    expect(serverReason({ message: { name: ['has already been taken'], path: ['has already been taken'], limit_reached: [] } })).toBe('name has already been taken; path has already been taken');
    expect(serverReason({ error: 'bad\u202Ename' })).not.toContain('\u202E');
    expect(serverReason({ message: 'x'.repeat(1000) })).toHaveLength(300);
    expect(serverReason({})).toBeUndefined();
  });
});

describe('owners', () => {
  it('opens with each account\'s own namespace and asks no server for it', async () => {
    const before = harness.stub.github.requests.length + harness.stub.gitlab.requests.length;
    const view = await service.publishing.accounts();
    expect(view.accounts.find((account) => account.serverName === 'github.com')?.personal).toEqual({ value: 'github.com|astefanopoulos|personal', kind: 'personal', path: 'astefanopoulos', internal: false });
    expect(harness.stub.github.requests.length + harness.stub.gitlab.requests.length).toBe(before);
  });

  it('lists GitHub organizations and GitLab groups with create rights, nested ones included, per account', () => {
    expect(namespacesOf('github.com').map((namespace) => [namespace.kind, namespace.path, namespace.value])).toEqual([
      ['personal', 'astefanopoulos', 'github.com|astefanopoulos|personal'],
      ['org', 'damocles-app', 'github.com|astefanopoulos|damocles-app'],
      ['org', 'indigital', 'github.com|astefanopoulos|indigital'],
    ]);
    expect(namespacesOf('gitlab.com').map((namespace) => namespace.path)).toEqual(['alexios-s', 'indigital-oss']);
    expect(namespacesOf(indigitalId).map((namespace) => [namespace.kind, namespace.path, namespace.internal])).toEqual([
      ['personal', 'astefanopoulos', true],
      ['group', 'grp', true],
      ['group', 'grp/platform', true],
    ]);
    expect(namespacesOf('github.com').every((namespace) => !namespace.internal)).toBe(true);
  });

  it('answers a failed listing with why, after which only the account\'s own namespace resolves', async () => {
    harness.stub.gitlab.unreachable = true;
    try {
      const answer = await service.publishing.owners(accountOf('gitlab.com').accountId, signal());
      expect(answer).toEqual({ status: 'error', message: expect.objectContaining({ message: 'Could not reach {0}. Check the connection and try again.' }) });
      // '..' is refused only after the owner resolved, so the answer tells which owners core still accepts
      expect(await service.publishing.createRepository({ owner: valueOf('gitlab.com', 'indigital-oss'), name: '..', visibility: 'private' }, signal())).toMatchObject({ kind: 'failed', reason: { message: 'This owner is no longer listed. Open Publish again.' } });
      expect(await service.publishing.createRepository({ owner: valueOf('gitlab.com', 'alexios-s'), name: '..', visibility: 'private' }, signal())).toMatchObject({ kind: 'refused' });
    } finally {
      harness.stub.gitlab.unreachable = false;
      await listOwners('gitlab.com');
    }
    expect(await service.publishing.createRepository({ owner: valueOf('gitlab.com', 'indigital-oss'), name: '..', visibility: 'private' }, signal())).toMatchObject({ kind: 'refused' });
  });

  it('answers cancelled when its caller aborts, ending the server request, and keeps the account\'s listed owners', async () => {
    harness.stub.github.namespaceDelayMs = 5_000;
    try {
      const before = harness.stub.github.requests.length;
      const controller = new AbortController();
      const listing = service.publishing.owners(accountOf('github.com').accountId, controller.signal);
      await expect.poll(() => harness.stub.github.requests.slice(before).some((request) => request.path.endsWith('/user/orgs'))).toBe(true);
      const aborted = Date.now();
      controller.abort();
      expect(await listing).toEqual({ status: 'cancelled' });
      // the fetch ended with the abort, long before the stub answers
      expect(Date.now() - aborted).toBeLessThan(2_500);
    } finally {
      harness.stub.github.namespaceDelayMs = 0;
    }
    expect(await service.publishing.createRepository({ owner: valueOf('github.com', 'damocles-app'), name: '..', visibility: 'private' }, signal())).toMatchObject({ kind: 'refused' });
  });

  // two dialogs may list one account: each gets its answer, and core resolves values only from the one started last
  it('answers a listing another one superseded, and lets only the listing started last replace an account\'s owners', async () => {
    const before = harness.stub.github.requests.length;
    harness.stub.github.namespaceDelayMs = 500;
    try {
      const older = service.publishing.owners(accountOf('github.com').accountId, signal());
      await expect.poll(() => harness.stub.github.requests.slice(before).some((request) => request.path.endsWith('/user/orgs'))).toBe(true);
      // the stub drops the newer listing's connection, so it fails while the older one is still answered
      harness.stub.github.unreachable = true;
      expect(await service.publishing.owners(accountOf('github.com').accountId, signal())).toMatchObject({ status: 'error' });
      expect(await older).toMatchObject({ status: 'loaded', owners: [expect.objectContaining({ path: 'damocles-app' }), expect.objectContaining({ path: 'indigital' })] });
    } finally {
      harness.stub.github.namespaceDelayMs = 0;
      harness.stub.github.unreachable = false;
    }
    // the newer listing failed, so the superseded one's values stay unresolved
    expect(await service.publishing.createRepository({ owner: valueOf('github.com', 'damocles-app'), name: '..', visibility: 'private' }, signal())).toMatchObject({ kind: 'failed', reason: { message: 'This owner is no longer listed. Open Publish again.' } });
    await listOwners('github.com');
    expect(await service.publishing.createRepository({ owner: valueOf('github.com', 'damocles-app'), name: '..', visibility: 'private' }, signal())).toMatchObject({ kind: 'refused' });
  });

  it('says a listing was cut at the page bound', async () => {
    const server = { id: 'github.com', kind: 'github', apiUrl: 'https://api.github.com' } as ForgeServer;
    const full = Array.from({ length: 100 }, (_, index) => ({ login: `org-${index}` }));
    const http = { request: async () => ({ status: 200, headers: new Headers(), body: full, notModified: false }) } as unknown as ForgeHttp;
    const listed = await githubNamespaces({ http, server, token: 't', signal: signal() });
    expect(listed.cut).toBe(true);
    expect(listed.namespaces).toHaveLength(100 * MAX_NAMESPACE_PAGES);
  });
});

describe('create', () => {
  it('creates in the user namespace, a GitHub organization and a nested GitLab group, with a checked clone URL', async () => {
    const personal = await service.publishing.createRepository({ owner: valueOf('gitlab.com', 'alexios-s'), name: 'damocles fork', visibility: 'public' }, signal());
    expect(personal).toMatchObject({ kind: 'created', serverName: 'gitlab.com', login: 'alexios-s', path: 'alexios-s/damocles-fork', url: `${harness.stub.gitlab.webUrl}/alexios-s/damocles-fork.git` });
    const org = await service.publishing.createRepository({ owner: valueOf('github.com', 'damocles-app'), name: 'site', visibility: 'private' }, signal());
    expect(org).toMatchObject({ kind: 'created', path: 'damocles-app/site' });
    const nested = await service.publishing.createRepository({ owner: valueOf(indigitalId, 'grp/platform'), name: 'intranet-2', visibility: 'internal' }, signal());
    expect(nested).toMatchObject({ kind: 'created', path: 'grp/platform/intranet-2' });
    expect(harness.stub.indigital.created.at(-1)).toMatchObject({ path: 'grp/platform/intranet-2', visibility: 'internal' });
    expect(harness.stub.github.created.at(-1)).toMatchObject({ path: 'damocles-app/site', visibility: 'private' });
  });

  it('uses the ssh address when the clone protocol setting says so', async () => {
    harness.settings[FORGE_CLONE_PROTOCOL_SETTING] = 'ssh';
    try {
      const created = await service.publishing.createRepository({ owner: valueOf('gitlab.com', 'alexios-s'), name: 'over-ssh', visibility: 'private' }, signal());
      expect(created).toMatchObject({ kind: 'created', url: `git@${new URL(harness.stub.gitlab.webUrl).hostname}:alexios-s/over-ssh.git` });
    } finally {
      delete harness.settings[FORGE_CLONE_PROTOCOL_SETTING];
    }
  });

  it('answers a refused name with the server\'s reason, as a refusal and not an error', async () => {
    expect(await service.publishing.createRepository({ owner: valueOf(indigitalId, 'grp'), name: 'damocles', visibility: 'private' }, signal())).toEqual({
      kind: 'refused',
      reason: expect.objectContaining({ message: '{0} refused: {1}', args: [indigitalId, 'name has already been taken; path has already been taken'] }),
    });
    expect(await service.publishing.createRepository({ owner: valueOf('github.com', 'astefanopoulos'), name: 'damocles', visibility: 'private' }, signal())).toMatchObject({
      kind: 'refused',
      reason: { args: ['github.com', 'name already exists on this account'] },
    });
    expect(await service.publishing.createRepository({ owner: valueOf('github.com', 'astefanopoulos'), name: '..', visibility: 'private' }, signal())).toMatchObject({ kind: 'refused', reason: { message: 'Use letters, digits, dots, dashes or underscores.' } });
    // a refusal that is not about the name is the create step's failure, not a shaken Name field; an SSO refusal names the organization as push access does
    expect(await service.publishing.createRepository({ owner: valueOf('github.com', 'indigital'), name: 'portal-2', visibility: 'private' }, signal())).toMatchObject({
      kind: 'failed',
      reason: { message: 'The {0} organization on {1} requires single sign-on, and the token of {2} is not authorized for it.', args: ['indigital', 'github.com', 'astefanopoulos'] },
    });
    expect(await service.publishing.createRepository({ owner: valueOf('github.com', 'astefanopoulos'), name: 'internal-one', visibility: 'internal' }, signal())).toMatchObject({ kind: 'failed' });
  });

  it('resolves only Owner values it listed itself', async () => {
    expect(await service.publishing.createRepository({ owner: 'gitlab.com|alexios-s|readers', name: 'x', visibility: 'private' }, signal())).toMatchObject({ kind: 'failed', reason: { message: 'This owner is no longer listed. Open Publish again.' } });
    expect(harness.stub.gitlab.created.some((item) => item.path === 'readers/x')).toBe(false);
  });
});

describe('push access', () => {
  const repo = (endpoint: RemoteEndpoint): { authorityKey: string; endpoints: readonly RemoteEndpoint[] } => ({ authorityKey: 'local', endpoints: [endpoint] });

  it('says denied only when the server confirms the account reads but cannot push', async () => {
    expect(await service.publishing.pushAccess(repo(stubEndpoint(harness.stub.indigital.webUrl, 'grp/damocles.git')), 'origin', signal())).toEqual({
      access: 'denied', serverId: indigitalId, serverName: indigitalId, kind: 'gitlab', accountId: accountOf(indigitalId).accountId, login: 'astefanopoulos', path: 'grp/damocles',
    });
    expect(await service.publishing.pushAccess(repo(stubEndpoint(harness.stub.indigital.webUrl, 'platform/api.git')), 'origin', signal())).toEqual({ access: 'canPush' });
    // a repository the account cannot see is no fork
    expect(await service.publishing.pushAccess(repo(stubEndpoint(harness.stub.indigital.webUrl, 'secret/thing.git')), 'origin', signal())).toEqual({ access: 'unknown' });
    expect(await service.publishing.pushAccess(repo(endpointOf('example.org', 'a/b.git')), 'origin', signal())).toEqual({ access: 'unknown' });
  });

  it('answers an SSO-protected organization with the org notice instead of a fork', async () => {
    const outcome = await service.publishing.pushAccess(repo(stubEndpoint(harness.stub.github.webUrl, 'indigital/portal.git')), 'origin', signal());
    expect(outcome).toMatchObject({ access: 'orgAccess', org: 'indigital', action: { message: 'Authorize Damocles for {0}', args: ['indigital'] } });
    expect(await service.openPage({ page: 'orgAccess', accountId: accountOf('github.com').accountId, org: 'indigital' })).toBe(true);
    expect(harness.opened.at(-1)).toBe(`${harness.stub.github.webUrl}/orgs/indigital/sso?authorization_request=stub`);
  });
});

describe('fork', () => {
  it('forks on GitLab, waits for import_status, and reuses an existing fork of the same upstream', async () => {
    const account = accountOf(indigitalId);
    const before = harness.stub.indigital.requests.length;
    const forked = await service.publishing.fork({ serverId: indigitalId, accountId: account.accountId, path: 'grp/damocles' }, signal());
    expect(forked).toEqual({ kind: 'forked', path: 'astefanopoulos/damocles', url: `${harness.stub.indigital.webUrl}/astefanopoulos/damocles.git` });
    const polls = harness.stub.indigital.requests.slice(before).filter((request) => request.method === 'GET' && /^\/api\/v4\/projects\/\d+$/.test(request.path));
    expect(polls).toHaveLength(3);
    expect(await service.publishing.fork({ serverId: indigitalId, accountId: account.accountId, path: 'grp/damocles' }, signal())).toMatchObject({ kind: 'forked', path: 'astefanopoulos/damocles' });
  });

  it('forks on GitHub, uses the path GitHub answered, and polls until the fork exists', async () => {
    harness.stub.github.projectAccess.set('damocles-app/tools', new Map([['astefanopoulos', 20]]));
    harness.stub.github.projectAccess.set('astefanopoulos/tools', new Map([['astefanopoulos', 50]]));
    const forked = await service.publishing.fork({ serverId: 'github.com', accountId: accountOf('github.com').accountId, path: 'damocles-app/tools' }, signal());
    expect(forked).toEqual({ kind: 'forked', path: 'astefanopoulos/tools-1', url: `${harness.stub.github.webUrl}/astefanopoulos/tools-1.git` });
  });

  it('fails with the server\'s words, and gives up after two minutes on a fork that never finishes', async () => {
    harness.stub.indigital.failFork = true;
    try {
      expect(await service.publishing.fork({ serverId: indigitalId, accountId: accountOf(indigitalId).accountId, path: 'platform/web' }, signal())).toMatchObject({ kind: 'failed', reason: { message: '{0} could not complete the request (HTTP {1}).', args: [indigitalId, 500] } });
    } finally {
      harness.stub.indigital.failFork = false;
    }
    let clock = 0;
    const slow = harness.service({ now: () => (clock += 20_000) });
    await slow.load();
    harness.stub.indigital.forkPolls = Infinity;
    try {
      const views = (await slow.publishing.accounts()).accounts;
      const account = views.find((item) => item.serverName === indigitalId)!;
      expect(await slow.publishing.fork({ serverId: indigitalId, accountId: account.accountId, path: 'platform/web' }, signal())).toEqual({
        kind: 'failed', reason: expect.objectContaining({ message: 'The fork is taking longer than {0} minutes on {1}.', args: [2, indigitalId] }),
      });
      expect(FORK_LIMIT_MS).toBe(120_000);
    } finally {
      harness.stub.indigital.forkPolls = 2;
    }
  });

  it('stops polling once cancelled, and answers the fork the server already made', async () => {
    harness.stub.gitlab.projectAccess.set('grp/sub/slow', new Map([['alexios-s', 20]]));
    harness.stub.gitlab.forkPolls = Infinity;
    const controller = new AbortController();
    const polls = (): number => harness.stub.gitlab.requests.filter((request) => request.method === 'GET' && /^\/api\/v4\/projects\/\d+$/.test(request.path)).length;
    try {
      const forking = service.publishing.fork({ serverId: 'gitlab.com', accountId: accountOf('gitlab.com').accountId, path: 'grp/sub/slow' }, controller.signal);
      await expect.poll(polls).toBeGreaterThan(0);
      controller.abort();
      expect(await forking).toEqual({ kind: 'cancelled', path: 'alexios-s/slow' });
      const after = polls();
      await new Promise((resolve) => setTimeout(resolve, 1_500));
      expect(polls()).toBe(after);
    } finally {
      harness.stub.gitlab.forkPolls = 2;
    }
  });
});

describe('what a server answers to a create or a fork', () => {
  const SERVER_ID = 'git.example.com';
  const serverOf = (kind: 'github' | 'gitlab'): ForgeServer => ({
    record: { id: SERVER_ID, kind, flavor: kind === 'github' ? 'ghes' : 'gitlab', gitHosts: [SERVER_ID], addedAt: 0 },
    id: SERVER_ID,
    kind,
    flavor: kind === 'github' ? 'ghes' : 'gitlab',
    builtIn: false,
    webUrl: `https://${SERVER_ID}`,
    apiUrl: kind === 'github' ? `https://${SERVER_ID}/api/v3` : `https://${SERVER_ID}/api/v4`,
    origins: new Set([`https://${SERVER_ID}`]),
  });
  const ACCOUNT: AccountRecord = { id: `${SERVER_ID}|1`, serverId: SERVER_ID, userId: '1', login: 'astef', auth: 'token', scopes: [], agentShells: false, addedAt: 0 };

  /** A publisher over one server whose every answer answer() scripts; sleep waits for the caller's abort. */
  function scripted(kind: 'github' | 'gitlab', answer: (request: ForgeRequest) => { readonly status: number; readonly body: unknown }, options: { readonly signedIn?: boolean } = {}) {
    const requests: ForgeRequest[] = [];
    const http = {
      request: async (request: ForgeRequest) => {
        requests.push(request);
        const { status, body } = answer(request);
        if (status >= 400 && !(request.acceptStatuses ?? []).includes(status)) throw new ForgeHttpError('server', `HTTP ${status}`, { status });
        return { status, headers: new Headers(), body, notModified: false };
      },
      noteRateLimit: () => 0,
    } as unknown as ForgeHttp;
    const publisher = createPublisher({
      servers: () => [serverOf(kind)],
      accounts: () => [ACCOUNT],
      loaded: async () => true,
      bindings: {} as BindingStore,
      http,
      withToken: (_account, _server, run) => run('t'),
      needsSignIn: () => options.signedIn === false,
      pickByAccess: async () => undefined,
      noteOrgAccess: () => undefined,
      protocol: () => 'https',
      log: () => undefined,
      now: () => 0,
      sleep: (_ms, wait) => new Promise((_resolve, reject) => wait.addEventListener('abort', () => reject(wait.reason), { once: true })),
    });
    return { publisher, requests };
  }
  const PERSONAL = ownerValue(SERVER_ID, 'astef', 'personal', 'astef');

  it('names a created repository whose clone address is on another host, names another path, or is missing, as created but unusable', async () => {
    for (const cloneUrl of ['https://evil.example/astef/site.git', `https://${SERVER_ID}/astef/other.git`, undefined]) {
      const { publisher } = scripted('github', () => ({ status: 201, body: { full_name: 'astef/site', ...(cloneUrl !== undefined ? { clone_url: cloneUrl } : {}) } }));
      expect(await publisher.createRepository({ owner: PERSONAL, name: 'site', visibility: 'private' }, signal())).toMatchObject({ kind: 'createdUnusable', serverName: SERVER_ID, path: 'astef/site' });
    }
    // an answer naming no path still made the repository the request asked for
    const unnamed = scripted('gitlab', () => ({ status: 201, body: { id: 9 } }));
    expect(await unnamed.publisher.createRepository({ owner: PERSONAL, name: 'site', visibility: 'private' }, signal())).toMatchObject({ kind: 'createdUnusable', path: 'astef/site', reason: { message: '{0} answered without the repository\'s path.' } });
  });

  it('refuses a GitHub fork answer naming another owner, and a fork whose clone address is not on the server at its path', async () => {
    const other = scripted('github', (request) => (request.method === 'POST' ? { status: 202, body: { full_name: 'someone/b' } } : { status: 200, body: {} }));
    expect(await other.publisher.fork({ serverId: SERVER_ID, accountId: ACCOUNT.id, path: 'grp/b' }, signal())).toMatchObject({ kind: 'failed' });
    expect(other.requests.filter((request) => request.method !== 'POST')).toEqual([]);
    const foreign = scripted('github', (request) => (request.method === 'POST' ? { status: 202, body: { full_name: 'astef/b' } } : { status: 200, body: { clone_url: 'https://evil.example/astef/b.git' } }));
    expect(await foreign.publisher.fork({ serverId: SERVER_ID, accountId: ACCOUNT.id, path: 'grp/b' }, signal())).toMatchObject({ kind: 'failed', reason: { message: '{0} gave no {1} clone address on its own hosts for {2}.' } });
  });

  it('GitLab: refuses a name clash with a project that is not a fork of upstream, and reuses one whose upstream differs in letter case only', async () => {
    const project = (forkOf: string) => (request: ForgeRequest) => {
      if (request.method === 'POST') return { status: 409, body: { message: { name: ['has already been taken'] } } };
      if (request.url === `/projects/${encodeURIComponent('astef/b')}`) return { status: 200, body: { id: 5, path_with_namespace: 'astef/b', forked_from_project: { path_with_namespace: forkOf } } };
      return { status: 200, body: { id: 5, path_with_namespace: 'astef/b', import_status: 'finished', http_url_to_repo: `https://${SERVER_ID}/astef/b.git` } };
    };
    expect(await scripted('gitlab', project('other/b')).publisher.fork({ serverId: SERVER_ID, accountId: ACCOUNT.id, path: 'grp/b' }, signal())).toMatchObject({ kind: 'failed', reason: { message: '{0} refused to fork {1}: {2}' } });
    expect(await scripted('gitlab', project('Grp/B')).publisher.fork({ serverId: SERVER_ID, accountId: ACCOUNT.id, path: 'grp/b' }, signal())).toEqual({ kind: 'forked', path: 'astef/b', url: `https://${SERVER_ID}/astef/b.git` });
  });

  it('answers a signed-out account with a sign-in text, for a fork and for the create page', async () => {
    const { publisher, requests } = scripted('github', () => ({ status: 200, body: {} }), { signedIn: false });
    expect(await publisher.fork({ serverId: SERVER_ID, accountId: ACCOUNT.id, path: 'grp/b' }, signal())).toEqual({
      kind: 'failed', reason: { message: 'The account for {0} is signed out. Sign in again in Settings › Models & accounts › Git hosting, then push again.', args: [SERVER_ID] },
    });
    expect(await publisher.mergeRequestPage({ serverId: SERVER_ID, accountId: ACCOUNT.id, upstreamPath: 'grp/b', forkPath: 'grp/b', branch: 'astef/main', targetBranch: 'main' }, signal())).toEqual({
      unavailable: { message: 'The account for {0} is signed out. Sign in again in Settings › Models & accounts › Git hosting.', args: [SERVER_ID] },
    });
    expect(requests).toEqual([]);
  });

  it('offers only the namespaces whose Owner value fits the wire, in ordinal order', async () => {
    const long = Array.from({ length: 20 }, () => 'g'.repeat(60)).join('/');
    const { publisher } = scripted('gitlab', () => ({
      status: 200,
      body: { data: { currentUser: { groups: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [{ id: 'gid://gitlab/Group/3', fullPath: 'beta' }, { id: 'gid://gitlab/Group/2', fullPath: long }, { id: 'gid://gitlab/Group/1', fullPath: 'Alpha' }] } } } },
    }));
    const answer = await publisher.owners(ACCOUNT.id, signal());
    expect(answer.status === 'loaded' ? answer.owners.map((owner) => owner.path) : answer).toEqual(['Alpha', 'beta']);
  });
});

describe('create page', () => {
  it('builds the GitHub compare page and the GitLab new merge request page on the web origin, with the branch and the template', () => {
    expect(mergeRequestUrl({ kind: 'github', webUrl: 'https://github.com' }, { upstreamPath: 'grp/damocles', forkPath: 'astef/damocles', branch: 'fix/token-refresh', template: '## Why\n' }))
      .toBe('https://github.com/grp/damocles/compare/astef:fix/token-refresh?expand=1&body=%23%23+Why%0A');
    expect(mergeRequestUrl({ kind: 'gitlab', webUrl: 'https://gitlab.indigital.gr' }, { upstreamPath: 'grp/damocles', forkPath: 'astefanopoulos/damocles', branch: 'fix/token-refresh', targetProjectId: 42, template: 'T' }))
      .toBe('https://gitlab.indigital.gr/astefanopoulos/damocles/-/merge_requests/new?merge_request%5Bsource_branch%5D=fix%2Ftoken-refresh&merge_request%5Btarget_project_id%5D=42&merge_request%5Bdescription%5D=T');
    expect(mergeRequestUrl({ kind: 'gitlab', webUrl: 'https://gitlab.com' }, { upstreamPath: 'a/b', forkPath: 'c/b', branch: 'main' })).toBeUndefined();
    // a template whose encoding passes the address bound is left out
    expect(mergeRequestUrl({ kind: 'github', webUrl: 'https://github.com' }, { upstreamPath: 'a/b', forkPath: 'c/b', branch: 'main', template: 'α'.repeat(4000) })).toBe('https://github.com/a/b/compare/c:main?expand=1');
    expect(mergeRequestUrl({ kind: 'github', webUrl: 'https://github.com' }, { upstreamPath: 'a/b', forkPath: 'c/b', branch: '-bad' })).toBeUndefined();
    expect(mergeRequestUrl({ kind: 'github', webUrl: 'https://github.com' }, { upstreamPath: '../x', forkPath: 'c/b', branch: 'main' })).toBeUndefined();
  });

  it('targets the protected branch a new branch of the same repository came from', () => {
    expect(mergeRequestUrl({ kind: 'github', webUrl: 'https://github.com' }, { upstreamPath: 'grp/damocles', forkPath: 'grp/damocles', branch: 'astef/release/1.x', targetBranch: 'release/1.x' }))
      .toBe('https://github.com/grp/damocles/compare/release/1.x...grp:astef/release/1.x?expand=1');
    expect(mergeRequestUrl({ kind: 'gitlab', webUrl: 'https://gitlab.com' }, { upstreamPath: 'grp/damocles', forkPath: 'grp/damocles', branch: 'alexios-s/main', targetBranch: 'main', targetProjectId: 7 }))
      .toBe('https://gitlab.com/grp/damocles/-/merge_requests/new?merge_request%5Bsource_branch%5D=alexios-s%2Fmain&merge_request%5Btarget_project_id%5D=7&merge_request%5Btarget_branch%5D=main');
    expect(mergeRequestUrl({ kind: 'github', webUrl: 'https://github.com' }, { upstreamPath: 'a/b', forkPath: 'a/b', branch: 'x', targetBranch: 'bad..name' })).toBeUndefined();
  });

  it('reads the upstream project id for GitLab and builds the page on the server', async () => {
    const page = await service.publishing.mergeRequestPage({ serverId: indigitalId, accountId: accountOf(indigitalId).accountId, upstreamPath: 'grp/damocles', forkPath: 'astefanopoulos/damocles', branch: 'main' }, signal());
    expect(page).toEqual({ url: `${harness.stub.indigital.webUrl}/astefanopoulos/damocles/-/merge_requests/new?merge_request%5Bsource_branch%5D=main&merge_request%5Btarget_project_id%5D=42`, serverName: indigitalId });
  });
});
