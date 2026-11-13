import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ForgeService } from '..';
import type { CloneAccount, CloneRow } from '../../../shared/forge/clone';
import type { RemoteEndpoint } from '../../../shared/forge/bindings';
import { checkedCloneUrl, githubSearchQuery, githubUserRepos, gitlabProjects } from '../clone-sources';
import type { ForgeHttp } from '../http';
import { FORGE_CLONE_PROTOCOL_SETTING, ForgeHttpError, type AccountRecord, type ForgeServer } from '../types';
import { createClonePicker } from '../clone-picker';
import type { StubServer } from './support/forge-stub';
import { createHarness, type Harness } from './support/harness';

// The clone picker's core side against the stub (docs/invariants.md "GitHub and GitLab accounts", clone picker): each
// account's listing and search, opaque row keys, and the clone URL rule: only the account's server or its git hosts.

let harness: Harness;
let service: ForgeService;
let indigitalId: string;
const signal = (): AbortSignal => new AbortController().signal;

let listed: readonly CloneAccount[] = [];

const accountOf = (serverId: string, login: string): string => {
  const found = listed.find((account) => account.serverId === serverId && account.login === login);
  if (!found) throw new Error(`no ${login} on ${serverId}`);
  return found.accountId;
};

async function rows(accountId: string, query: string): Promise<readonly CloneRow[]> {
  const outcome = await service.clone.search(accountId, query, signal());
  if (!('rows' in outcome)) throw new Error(`search failed: ${outcome.error}`);
  return outcome.rows;
}

const hostOf = (server: StubServer): string => new URL(server.webUrl).host;

const GITLAB: ForgeServer = {
  id: 'gitlab.example.com', kind: 'gitlab', flavor: 'gitlab', builtIn: false, webUrl: 'https://gitlab.example.com', apiUrl: 'https://gitlab.example.com/api/v4',
  origins: new Set(['https://gitlab.example.com']), record: { id: 'gitlab.example.com', kind: 'gitlab', flavor: 'gitlab', gitHosts: ['gitlab.example.com'], addedAt: 0 },
};
const GITHUB: ForgeServer = {
  id: 'github.example.com', kind: 'github', flavor: 'ghes', builtIn: false, webUrl: 'https://github.example.com', apiUrl: 'https://github.example.com/api/v3',
  origins: new Set(['https://github.example.com']), record: { id: 'github.example.com', kind: 'github', flavor: 'ghes', gitHosts: ['github.example.com'], addedAt: 0 },
};
const ME: AccountRecord = { id: 'gitlab.example.com|1', serverId: 'gitlab.example.com', userId: '1', login: 'me', auth: 'token', scopes: [], agentShells: false, addedAt: 0 };
const GITHUB_ME: AccountRecord = { ...ME, id: 'github.example.com|1', serverId: 'github.example.com' };

const gitlabJson = (repoPath: string): Record<string, unknown> => ({ path_with_namespace: repoPath, visibility: 'private', http_url_to_repo: `https://gitlab.example.com/${repoPath}.git`, ssh_url_to_repo: `git@gitlab.example.com:${repoPath}.git` });
const githubJson = (repoPath: string): Record<string, unknown> => ({ full_name: repoPath, visibility: 'public', clone_url: `https://github.example.com/${repoPath}.git` });

/** A picker on one server (GITLAB unless named) whose HTTP answers come from request, by the request's URL. */
function fakePicker(options: {
  readonly server?: ForgeServer;
  readonly accounts?: readonly AccountRecord[];
  readonly request?: (url: string) => Promise<unknown>;
  readonly needsSignIn?: () => boolean;
  readonly protocol?: () => 'https' | 'ssh';
  readonly log?: (line: string) => void;
  readonly now?: () => number;
}): ReturnType<typeof createClonePicker> {
  const request = options.request ?? (async () => []);
  return createClonePicker({
    servers: () => [options.server ?? GITLAB],
    accounts: () => options.accounts ?? [ME],
    loaded: async () => true,
    http: { request: async (req) => ({ status: 200, headers: new Headers(), notModified: false, body: await request(req.url) }), noteRateLimit: () => 0 },
    withToken: (_account, _server, run) => run('t'),
    needsSignIn: options.needsSignIn ?? (() => false),
    avatarKey: () => undefined,
    protocol: options.protocol ?? (() => 'https'),
    log: options.log ?? (() => undefined),
    now: options.now ?? (() => 0),
  });
}

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
  const view = await service.clone.accounts();
  if (!('accounts' in view)) throw new Error('no accounts');
  listed = view.accounts;
}, 60_000);

afterAll(async () => {
  await harness.close();
});

describe('accounts', () => {
  it('lists each signed-in account with its server, and an empty state without one', async () => {
    expect(await service.clone.accounts()).toMatchObject({
      accounts: expect.arrayContaining([
        expect.objectContaining({ login: 'astefanopoulos', serverId: indigitalId, serverName: indigitalId, kind: 'gitlab', needsSignIn: false }),
        expect.objectContaining({ login: 'alexios-s', serverId: 'gitlab.com', kind: 'gitlab' }),
        expect.objectContaining({ login: 'astefanopoulos', serverId: 'github.com', kind: 'github' }),
      ]),
      protocol: 'https',
    });
    const empty = await createHarness();
    try {
      const fresh = empty.service();
      await fresh.load();
      expect(await fresh.clone.accounts()).toEqual({ empty: 'noAccount' });
    } finally {
      await empty.close();
    }
  });

  it('waits for the forge files after a core start, so an early ask still gets the accounts', async () => {
    const restarted = harness.service();
    const early = restarted.clone.accounts();
    await restarted.load();
    expect(await early).toMatchObject({ accounts: expect.arrayContaining([expect.objectContaining({ login: 'astefanopoulos', serverId: indigitalId })]) });
  });

  it('says the accounts are not loaded, not that there are none, when reading the forge files failed', async () => {
    // a folder where servers.json should be: the read fails, which no parse can recover from
    const forgeDir = mkdtempSync(path.join(tmpdir(), 'damocles-forge-unreadable-'));
    mkdirSync(path.join(forgeDir, 'servers.json'));
    try {
      const broken = harness.service({ forgeDir });
      const early = broken.clone.accounts();
      await expect(broken.load()).rejects.toThrow();
      expect(await early).toEqual({ empty: 'notLoaded' });
    } finally {
      rmSync(forgeDir, { recursive: true, force: true });
    }
  });
});

describe('GitLab: GET /projects and GraphQL projects', () => {
  it('lists the account\'s projects newest by activity first, as namespace and name, with visibility', async () => {
    const listed = await rows(accountOf(indigitalId, 'astefanopoulos'), '');
    expect(listed.map((row) => [row.namespace, row.name, row.visibility, row.description])).toEqual([
      ['grp', 'damocles', 'private', 'Desktop agent shell'],
      ['grp/platform', 'intranet', 'internal', 'Company intranet'],
      ['grp/platform', 'api-gateway', 'private', 'Edge routing for services'],
    ]);
    expect(listed[0]!.updatedAt).toMatch(/^\d{4}-\d\d-\d\dT/);
    // GitLab 16.1 documents order_by=last_activity_at for GET /projects and no activity sort for GraphQL's projects
    expect(harness.stub.indigital.projectListings.at(-1)).toEqual({ membership: 'true', order_by: 'last_activity_at', sort: 'desc', per_page: '30' });
  });

  it('searches on the server, and leaves out an empty repository', async () => {
    const found = await rows(accountOf(indigitalId, 'astefanopoulos'), 'intra');
    expect(found.map((row) => `${row.namespace}/${row.name}`)).toEqual(['grp/platform/intranet']);
    expect(harness.stub.indigital.graphqlVariables.at(-1)).toEqual({ search: 'intra', membership: true, first: 30, searchNamespaces: true });
    const personal = await rows(accountOf('gitlab.com', 'alexios-s'), '');
    expect(personal.map((row) => row.name)).toEqual(['damocles', 'personal-site']);
  });

  it('clones a row over https on the account\'s server, preset and bound to that account, and over ssh by the setting', async () => {
    const accountId = accountOf(indigitalId, 'astefanopoulos');
    const [row] = await rows(accountId, 'intra');
    const target = service.clone.target({ accountId, key: row!.key });
    expect(target).toEqual({
      ok: true,
      url: `${harness.stub.indigital.webUrl}/grp/platform/intranet.git`,
      account: { serverId: indigitalId, accountId },
      status: expect.objectContaining({ message: 'Cloning {0} as {1} on {2}. Choose a folder next; the new project uses this account.', args: ['grp/platform/intranet', 'astefanopoulos', indigitalId] }),
    });
    harness.settings[FORGE_CLONE_PROTOCOL_SETTING] = 'ssh';
    try {
      // git signs in with the user's own SSH keys there; the account is the one the new project uses
      expect(service.clone.target({ accountId, key: row!.key })).toMatchObject({
        ok: true,
        url: `git@127.0.0.1:grp/platform/intranet.git`,
        status: { message: 'Cloning {0} from {1} with your SSH keys. Choose a folder next; the new project uses {2} on {1}.', args: ['grp/platform/intranet', indigitalId, 'astefanopoulos'] },
      });
      expect(await service.clone.accounts()).toMatchObject({ protocol: 'ssh' });
    } finally {
      delete harness.settings[FORGE_CLONE_PROTOCOL_SETTING];
    }
  });
});

describe('GitHub: /user/repos and /search/repositories', () => {
  it('lists the account\'s repositories by last update with fork and archived pills', async () => {
    const listed = await rows(accountOf('github.com', 'astefanopoulos'), '');
    expect(listed.map((row) => [`${row.namespace}/${row.name}`, row.visibility, row.pill])).toEqual([
      ['astefanopoulos/damocles', 'private', undefined],
      ['astefanopoulos/dotfiles', 'public', undefined],
      ['astefanopoulos/vscode', 'public', 'fork'],
      ['indigital/old-portal', 'private', 'archived'],
    ]);
  });

  it('merges the listing filtered here with the server\'s search, scoped to the account by name', async () => {
    const found = await rows(accountOf('github.com', 'astefanopoulos'), 'dot');
    expect(found.map((row) => row.name)).toEqual(['dotfiles']);
    expect(harness.stub.github.searchQueries.at(-1)).toBe('dot in:name fork:true user:astefanopoulos');
  });

  it('keeps search qualifiers out of what the user typed, and reads owner/name as a name under that owner', () => {
    expect(githubSearchQuery('x user:evil org:corp is:private', 'me')).toBe('x user evil org corp in:name fork:true user:me');
    expect(githubSearchQuery('octo/hel', 'me')).toBe('hel in:name fork:true user:octo');
    // an Enterprise Managed User's handle_shortcode login
    expect(githubSearchQuery('octocat_acme/repo', 'me')).toBe('repo in:name fork:true user:octocat_acme');
    expect(githubSearchQuery('  ', 'me')).toBeUndefined();
  });

  it('reuses the recent listing for 60 s of typed queries, and reads it again for an empty query', async () => {
    let at = 0;
    const urls: string[] = [];
    const picker = fakePicker({ server: GITHUB, accounts: [GITHUB_ME], now: () => at, request: async (url) => {
      urls.push(url.split('?')[0]!);
      return url.startsWith('/user/repos') ? [githubJson('me/dotfiles'), githubJson('me/site')] : { items: [] };
    } });
    await picker.search(GITHUB_ME.id, 'dot', signal());
    await picker.search(GITHUB_ME.id, 'site', signal());
    expect(urls.filter((url) => url === '/user/repos')).toHaveLength(1);
    at = 60_001;
    await picker.search(GITHUB_ME.id, 'dot', signal());
    expect(urls.filter((url) => url === '/user/repos')).toHaveLength(2);
    await picker.search(GITHUB_ME.id, '', signal());
    await picker.search(GITHUB_ME.id, '', signal());
    expect(urls.filter((url) => url === '/user/repos')).toHaveLength(4);
  });

  it('answers a rate-limited search with the listing filtered here, and fails only when the listing fails', async () => {
    const lines: string[] = [];
    let listingFails = false;
    const picker = fakePicker({ server: GITHUB, accounts: [GITHUB_ME], log: (line) => lines.push(line), request: async (url) => {
      if (url.startsWith('/search/')) throw new ForgeHttpError('rateLimited', 'limited', { status: 403 });
      if (listingFails) throw new ForgeHttpError('network', 'down');
      return [githubJson('me/dotfiles'), githubJson('me/site')];
    } });
    expect(await picker.search(GITHUB_ME.id, 'dot', signal())).toEqual({ rows: [expect.objectContaining({ namespace: 'me', name: 'dotfiles' })] });
    expect(lines).toEqual([expect.stringContaining('rate-limited')]);
    listingFails = true;
    expect(await picker.search(GITHUB_ME.id, '', signal())).toEqual({ error: 'unreachable' });
  });
});

describe('sections load on their own', () => {
  it('answers unreachable for a server that does not answer, while the others still list', async () => {
    harness.stub.github.unreachable = true;
    try {
      expect(await service.clone.search(accountOf('github.com', 'astefanopoulos'), '', signal())).toEqual({ error: 'unreachable' });
      expect((await rows(accountOf('gitlab.com', 'alexios-s'), '')).length).toBe(2);
    } finally {
      harness.stub.github.unreachable = false;
    }
    expect((await rows(accountOf('github.com', 'astefanopoulos'), '')).length).toBe(4);
  });

  it('answers refused for a listing the server denies, and signInAgain for an account signed out since', async () => {
    for (const kind of ['forbidden', 'ssoRequired', 'appNotApproved'] as const) {
      const picker = fakePicker({ request: async () => Promise.reject(new ForgeHttpError(kind, 'denied', { status: 403 })) });
      expect(await picker.search(ME.id, '', signal())).toEqual({ error: 'refused' });
    }
    expect(await fakePicker({}).search('gitlab.example.com|2', '', signal())).toEqual({ error: 'signInAgain' });
  });

  it('answers signInAgain once the server refuses the token', async () => {
    const accountId = accountOf('gitlab.com', 'alexios-s');
    harness.stub.gitlab.refusedLogins.add('alexios-s');
    try {
      expect(await service.clone.search(accountId, '', signal())).toEqual({ error: 'signInAgain' });
    } finally {
      harness.stub.gitlab.refusedLogins.delete('alexios-s');
    }
  });
});

describe('the clone URL rule', () => {
  const server = (): ForgeServer => ({
    id: 'gitlab.indigital.gr', kind: 'gitlab', flavor: 'gitlab', builtIn: false, webUrl: 'https://gitlab.indigital.gr', apiUrl: 'https://gitlab.indigital.gr/api/v4',
    origins: new Set(['https://gitlab.indigital.gr']), record: { id: 'gitlab.indigital.gr', kind: 'gitlab', flavor: 'gitlab', gitHosts: ['gitlab.indigital.gr', 'git.indigital.gr'], addedAt: 0 },
  });

  it.each([
    ['https://gitlab.indigital.gr/grp/proj.git'],
    ['git@gitlab.indigital.gr:grp/proj.git'],
    ['https://git.indigital.gr/grp/proj.git'],
    ['ssh://git@git.indigital.gr:2222/grp/proj.git'],
    ['deploy.user_1@gitlab.indigital.gr:grp/proj.git'],
  ])('keeps %s, on the server or one of its git hosts', (url) => {
    expect(checkedCloneUrl(server(), url, 'grp/proj')).toBe(url);
  });

  it.each([
    ['https://evil.example/grp/proj.git'],
    ['https://gitlab.indigital.gr.evil.example/grp/proj.git'],
    ['https://user:secret@gitlab.indigital.gr/grp/proj.git'],
    ['https://gitlab.indigital.gr/grp/other.git'],
    ['https://gitlab.indigital.gr/grp/proj.git?upload-pack=touch%20x'],
    ['http://gitlab.indigital.gr/grp/proj.git'],
    ['-oProxyCommand=calc:grp/proj.git'],
    ['-oProxyCommand=calc@gitlab.indigital.gr:grp/proj.git'],
    ['ssh://-oProxyCommand=calc@git.indigital.gr/grp/proj.git'],
    ['x;calc@gitlab.indigital.gr:grp/proj.git'],
    ['ext::sh -c touch% /tmp/pwned'],
    [' https://gitlab.indigital.gr/grp/proj.git'],
    [42],
  ])('drops %s', (url) => {
    expect(checkedCloneUrl(server(), url, 'grp/proj')).toBeUndefined();
  });

  it('drops a listed repository\'s foreign clone URL, so its row cannot clone over https', async () => {
    const http: ForgeHttp = { request: async () => ({ status: 200, headers: new Headers(), notModified: false, body: { data: { projects: { nodes: [{ fullPath: 'grp/proj', visibility: 'private', httpUrlToRepo: 'https://evil.example/grp/proj.git', sshUrlToRepo: 'git@git.indigital.gr:grp/proj.git' }] } } } }), noteRateLimit: () => 0 };
    const [listed] = await gitlabProjects({ http, server: server(), token: 't', signal: signal() }, 'proj');
    expect(listed).toMatchObject({ path: 'grp/proj', sshUrl: 'git@git.indigital.gr:grp/proj.git' });
    expect(listed!.httpsUrl).toBeUndefined();
    const github = { ...server(), kind: 'github' as const };
    const hostile: ForgeHttp = { request: async () => ({ status: 200, headers: new Headers(), notModified: false, body: [{ full_name: '../x', clone_url: 'https://gitlab.indigital.gr/../x.git' }, { full_name: 'a/b', clone_url: 'https://gitlab.indigital.gr/a/b.git', ssh_url: 'git@evil.example:a/b.git' }] }), noteRateLimit: () => 0 };
    expect(await githubUserRepos({ http: hostile, server: github, token: 't', signal: signal() })).toEqual([{ path: 'a/b', visibility: 'public', httpsUrl: 'https://gitlab.indigital.gr/a/b.git' }]);
  });

  it('refuses a key it never issued, and a key of another account', async () => {
    const indigital = accountOf(indigitalId, 'astefanopoulos');
    const [row] = await rows(indigital, '');
    expect(service.clone.target({ accountId: indigital, key: 'not-a-key' })).toMatchObject({ ok: false, reason: { message: 'This repository is no longer listed. Search again.' } });
    expect(service.clone.target({ accountId: accountOf('github.com', 'astefanopoulos'), key: row!.key })).toMatchObject({ ok: false });
  });

  it('keeps the newest 2,000 keys, and drops an account\'s keys when it signs out', async () => {
    const picker = fakePicker({ request: async () => Array.from({ length: 2001 }, (_, index) => gitlabJson(`grp/p${index}`)) });
    const outcome = await picker.search(ME.id, '', signal());
    if (!('rows' in outcome)) throw new Error('no rows');
    expect(picker.target({ accountId: ME.id, key: outcome.rows[0]!.key })).toMatchObject({ ok: false, reason: { message: 'This repository is no longer listed. Search again.' } });
    const last = outcome.rows.at(-1)!;
    expect(picker.target({ accountId: ME.id, key: last.key })).toMatchObject({ ok: true, url: 'https://gitlab.example.com/grp/p2000.git' });
    picker.forgetAccount(ME.id);
    expect(picker.target({ accountId: ME.id, key: last.key })).toMatchObject({ ok: false, reason: { message: 'This repository is no longer listed. Search again.' } });
  });

  it('refuses a row with no address of the chosen protocol, and a row whose account must sign in again', async () => {
    let mustSignIn = false;
    const picker = fakePicker({ protocol: () => 'ssh', needsSignIn: () => mustSignIn, request: async () => [{ ...gitlabJson('grp/proj'), ssh_url_to_repo: 'git@evil.example:grp/proj.git' }] });
    const outcome = await picker.search(ME.id, '', signal());
    if (!('rows' in outcome)) throw new Error('no rows');
    const key = outcome.rows[0]!.key;
    expect(picker.target({ accountId: ME.id, key })).toEqual({ ok: false, reason: expect.objectContaining({ message: '{0} gave no {1} clone address on its own hosts for {2}.', args: ['gitlab.example.com', 'ssh', 'grp/proj'] }) });
    mustSignIn = true;
    expect(picker.target({ accountId: ME.id, key })).toEqual({ ok: false, reason: expect.objectContaining({ message: 'Sign in again to {0} as {1} to clone this repository.', args: ['gitlab.example.com', 'me'] }) });
  });

  it('shows a description\'s hidden characters as escapes and its line breaks as spaces', async () => {
    const picker = fakePicker({ request: async () => [{ ...gitlabJson('grp/proj'), description: 'safe\u202Etxt.exe\nnext\u200Bline' }] });
    expect(await picker.search(ME.id, '', signal())).toEqual({ rows: [expect.objectContaining({ description: 'safe\\u{202E}txt.exe next\\u{200B}line' })] });
  });
});

describe('pasted addresses', () => {
  it('makes a row of a URL, naming a managed server and its one account, and searches anything else', () => {
    expect(service.clone.paste(`${harness.stub.indigital.webUrl}/grp/damocles.git`)).toEqual({ row: { displayPath: `${hostOf(harness.stub.indigital)}/grp/damocles.git`, protocol: 'https', serverName: indigitalId, login: 'astefanopoulos' } });
    expect(service.clone.paste('git clone https://user:pw@example.org/a/b.git')).toEqual({ row: { displayPath: 'example.org/a/b.git', protocol: 'https' } });
    expect(service.clone.paste('git clone C:\\My Repos\\tool')).toEqual({ row: { displayPath: 'C:\\My Repos\\tool' } });
    for (const text of ['intra', 'grp/damocles', 'x:y z', '']) expect(service.clone.paste(text)).toEqual({ row: null });
  });

  it('reads no address yet from a URL still being typed, before its path', () => {
    for (const text of ['https:', 'https:/', 'https://', 'https://gitlab.example.org', 'git@gitlab.example.org:']) expect(service.clone.paste(text), text).toEqual({ row: null });
  });

  it('shows a decoded path\'s hidden characters as escapes, in the row and in the status', () => {
    expect(service.clone.paste('https://example.org/a/%E2%80%AEb%0A.git')).toEqual({ row: { displayPath: 'example.org/a/\\u{202E}b\\u{A}.git', protocol: 'https' } });
    expect(service.clone.target({ pasteText: 'https://example.org/a/%E2%80%AEb.git' })).toMatchObject({ ok: true, status: { args: ['example.org/a/\\u{202E}b.git'] } });
  });

  it('names a refused paste with its credentials redacted before it is cut', () => {
    // the 200-character cut falls inside the userinfo, after "secret"
    const refused = service.clone.target({ pasteText: `x${' '.repeat(180)}https://user:secret-token@example.org/a.git y` });
    expect(refused).toMatchObject({ ok: false, reason: { message: '"{0}" is not a repository URL Damocles can use.' } });
    expect(JSON.stringify(refused)).not.toContain('secret');
  });

  it('presets the account on a managed server with one account, and leaves an unknown server to a plain clone', () => {
    expect(service.clone.target({ pasteText: `${harness.stub.indigital.webUrl}/grp/damocles.git` })).toMatchObject({ ok: true, url: `${harness.stub.indigital.webUrl}/grp/damocles.git`, account: { serverId: indigitalId } });
    const plain = service.clone.target({ pasteText: 'https://example.org/a/b.git' });
    expect(plain).toEqual({ ok: true, url: 'https://example.org/a/b.git', status: expect.objectContaining({ message: 'Cloning {0}. Choose a folder next.' }) });
    expect(service.clone.target({ pasteText: '-oProxyCommand=calc' })).toMatchObject({ ok: false });
  });

  it('presets nothing on a server with several accounts, or whose one account must sign in again, so the clone asks once', () => {
    const several = fakePicker({ accounts: [ME, { ...ME, id: 'gitlab.example.com|2', userId: '2', login: 'other' }] });
    expect(several.paste('https://gitlab.example.com/grp/proj.git')).toEqual({ row: { displayPath: 'gitlab.example.com/grp/proj.git', protocol: 'https', serverName: 'gitlab.example.com' } });
    expect(several.target({ pasteText: 'https://gitlab.example.com/grp/proj.git' })).toEqual({ ok: true, url: 'https://gitlab.example.com/grp/proj.git', status: expect.objectContaining({ message: 'Cloning {0}. Choose a folder next.', args: ['grp/proj'] }) });
    const signedOut = fakePicker({ needsSignIn: () => true });
    expect(signedOut.paste('git@gitlab.example.com:grp/proj.git')).toEqual({ row: { displayPath: 'gitlab.example.com/grp/proj.git', protocol: 'ssh', serverName: 'gitlab.example.com' } });
    expect(signedOut.target({ pasteText: 'git@gitlab.example.com:grp/proj.git' })).not.toHaveProperty('account');
  });
});

describe('links through the service', () => {
  it('builds a link only on a server with an account', () => {
    const url = new URL(harness.stub.indigital.webUrl);
    const endpoints: RemoteEndpoint[] = [{ remote: 'origin', fetch: { protocol: 'https', host: url.hostname, port: Number(url.port), path: 'grp/proj.git', aliasResolved: false } }];
    const sha = 'a'.repeat(40);
    expect(service.link({ authorityKey: 'local', project: 'proj', endpoints }, { kind: 'file', sha, path: 'src/a.ts', range: { start: 3, end: 7 } })).toEqual({ url: `${harness.stub.indigital.webUrl}/grp/proj/-/blob/${sha}/src/a.ts#L3-7`, serverName: indigitalId, remote: 'origin' });
    const unknown: RemoteEndpoint[] = [{ remote: 'origin', fetch: { protocol: 'https', host: 'gitlab.example.org', path: 'grp/proj.git', aliasResolved: false } }];
    expect(service.link({ authorityKey: 'local', project: 'proj', endpoints: unknown }, { kind: 'commit', sha })).toMatchObject({ unavailable: { message: '{0} has no remote on a GitHub or GitLab server you are signed in to.' } });
  });
});
