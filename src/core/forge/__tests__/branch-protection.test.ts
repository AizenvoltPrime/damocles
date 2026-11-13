import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RemoteEndpoint } from '../../../shared/forge/bindings';
import { MAX_PROTECTED_REMOTES, type BranchProtectionRule } from '../../../shared/forge/branch-protection';
import { ruleProtects } from '../../scm/branch-protection';
import type { BindingStore, ProjectBinding } from '../bindings/binding-store';
import { createBranchProtectionCache, PROTECTION_FRESH_MS, PROTECTION_RETRY_MS, type BranchProtectionDeps } from '../branch-protection';
import { createForgeHttp, type ForgeHttp } from '../http';
import { githubGraphqlUrl } from '../providers/github/graphql';
import { githubBranchProtection, rulesetRefGlob, rulesetRules } from '../providers/github/protection';
import { gitlabProjectAccess, gitlabReadsAccessLevel, gitlabRepoAccess } from '../providers/gitlab/projects';
import { gitlabBranchProtection, gitlabProtectedNames, pushEntryAllows } from '../providers/gitlab/protection';
import { boundedRules, literalPattern } from '../providers/protection-rules';
import { FORGE_BRANCH_PROTECTION_SETTING, type AccountRecord, type ForgeServer } from '../types';
import { createHarness, type Harness } from './support/harness';
import type { StubServer } from './support/forge-stub';

// Branch protection from the server (docs/invariants.md "GitHub and GitLab accounts", branch protection): the GitHub ruleset
// and classic reads ported from VS Code, GitLab's protected branches against the user's push access and version, and the
// cache a commit reads without waiting.

const GITHUB_TOKEN = 'ghp_stubAstefanopoulosRepo0000000001';
const INDIGITAL_TOKEN = 'glpat-stubIndigitalAstefApi00006';

function serverOf(stub: StubServer, options: { readonly builtIn?: boolean; readonly version?: string } = {}): ForgeServer {
  const url = new URL(stub.webUrl);
  const kind = stub.spec.kind;
  return {
    record: { id: url.host, kind, flavor: kind === 'github' ? 'ghes' : 'gitlab', gitHosts: [], addedAt: 0, ...(options.version !== undefined ? { version: options.version } : {}) },
    id: url.host,
    kind,
    flavor: kind === 'github' ? 'ghes' : 'gitlab',
    builtIn: options.builtIn ?? false,
    webUrl: stub.webUrl,
    apiUrl: stub.apiUrl,
    origins: new Set([url.origin]),
  };
}

const protects = (rules: readonly BranchProtectionRule[], branch: string): boolean => rules.some((rule) => ruleProtects(rule, branch));
const signal = (): AbortSignal => new AbortController().signal;

describe('GitHub rule translation', () => {
  it('turns ruleset ref names into branch globs: refs/heads/ dropped, ~ALL every branch, ~DEFAULT_BRANCH the default branch', () => {
    expect(rulesetRefGlob('refs/heads/release/*', 'main')).toBe('release/*');
    expect(rulesetRefGlob('~ALL', 'main')).toBe('**/*');
    expect(rulesetRefGlob('~DEFAULT_BRANCH', 'trunk')).toBe('trunk');
    expect(rulesetRefGlob('~DEFAULT_BRANCH', 'v{1}')).toBe('v{1}');
    expect(rulesetRefGlob('~DEFAULT_BRANCH', undefined)).toBeUndefined();
    const all = rulesetRules([{ target: 'BRANCH', enforcement: 'ACTIVE', rules: { totalCount: 1 }, conditions: { refName: { include: ['~ALL'], exclude: ['~DEFAULT_BRANCH'] } } }], 'main');
    expect(protects(all, 'feature/x')).toBe(true);
    expect(protects(all, 'main')).toBe(false);
  });

  it('keeps only active branch rulesets that require a pull request', () => {
    const node = (extra: Record<string, unknown>): Record<string, unknown> => ({ target: 'BRANCH', enforcement: 'ACTIVE', rules: { totalCount: 1 }, conditions: { refName: { include: ['refs/heads/main'], exclude: [] } }, ...extra });
    expect(rulesetRules([node({})], 'main')).toEqual([{ include: ['main'], exclude: [], syntax: 'fnmatch' }]);
    expect(rulesetRules([node({ enforcement: 'DISABLED' }), node({ enforcement: 'EVALUATE' }), node({ target: 'TAG' }), node({ rules: { totalCount: 0 } }), null, 'x'], 'main')).toEqual([]);
  });

  it('escapes a literal branch name, and keeps rules within the wire\'s bounds', () => {
    expect(literalPattern('fix(a)+{b}!@')).toBe('fix(a)+{b}!@');
    expect(literalPattern('a*b?[c]\\')).toBe('a\\*b\\?\\[c]\\\\');
    expect(protects([{ include: [literalPattern('a*b')], exclude: [], syntax: 'fnmatch' }], 'a*b')).toBe(true);
    expect(protects([{ include: [literalPattern('a*b')], exclude: [], syntax: 'fnmatch' }], 'axb')).toBe(false);
    const logs: string[] = [];
    const many = Array.from({ length: 120 }, (_, index) => `b${index}`);
    const bounded = boundedRules([{ include: [...many, '', 'x'.repeat(256)], exclude: ['b7'], syntax: 'fnmatch' }], (line) => logs.push(line));
    expect(bounded.map((rule) => rule.include.length)).toEqual([50, 50, 20]);
    expect(bounded.every((rule) => rule.exclude.length === 1)).toBe(true);
    expect(protects(bounded, 'b119')).toBe(true);
    expect(protects(bounded, 'b7')).toBe(false);
    expect(logs).toEqual([]);
  });

  it('leaves out a rule whose excludes do not fit, which would otherwise protect branches the server does not, and logs it', () => {
    const logs: string[] = [];
    const excludes = Array.from({ length: 51 }, (_, index) => `skip-${index}`);
    const bounded = boundedRules([
      { include: ['**/*'], exclude: excludes, syntax: 'fnmatch' },
      { include: ['*'], exclude: ['x'.repeat(256)], syntax: 'gitlab' },
      { include: ['main'], exclude: [], syntax: 'fnmatch' },
    ], (line) => logs.push(line));
    expect(bounded).toEqual([{ include: ['main'], exclude: [], syntax: 'fnmatch' }]);
    expect(protects(bounded, 'skip-50')).toBe(false);
    expect(logs).toHaveLength(2);
    expect(logs[0]).toMatch(/51 exclude patterns/);
  });

  it('asks GraphQL at api.github.com/graphql, and at /api/graphql on a GitHub Enterprise Server', () => {
    const base = { record: { id: 'x', kind: 'github', flavor: 'github.com', gitHosts: [], addedAt: 0 }, id: 'x', kind: 'github', flavor: 'github.com', builtIn: true, webUrl: 'https://github.com', origins: new Set<string>() } as const;
    expect(githubGraphqlUrl({ ...base, apiUrl: 'https://api.github.com' })).toBe('https://api.github.com/graphql');
    expect(githubGraphqlUrl({ ...base, apiUrl: 'https://api.acme.ghe.com' })).toBe('https://api.acme.ghe.com/graphql');
    expect(githubGraphqlUrl({ ...base, apiUrl: 'https://github.acme.test/api/v3' })).toBe('https://github.acme.test/api/graphql');
  });
});

describe('GitLab rule translation', () => {
  it('lets a role entry at or below the user\'s level, or the user\'s own entry, push; No one, a group and a deploy key do not', () => {
    expect(pushEntryAllows({ access_level: 30, user_id: null, group_id: null }, 32, 30)).toBe(true);
    expect(pushEntryAllows({ access_level: 40, user_id: null, group_id: null }, 32, 30)).toBe(false);
    expect(pushEntryAllows({ access_level: 0, user_id: null, group_id: null }, 32, 50)).toBe(false);
    expect(pushEntryAllows({ access_level: 40, user_id: 32, group_id: null }, 32, 10)).toBe(true);
    expect(pushEntryAllows({ access_level: 40, user_id: 99, group_id: null }, 32, 50)).toBe(false);
    expect(pushEntryAllows({ access_level: 30, user_id: null, group_id: 7 }, 32, 50)).toBe(false);
    expect(pushEntryAllows({ access_level: 30, deploy_key_id: 3 }, 32, 50)).toBe(false);
  });

  it('protects a branch whose push_access_levels all exclude the user', () => {
    const branches = [
      { name: 'main', push_access_levels: [{ access_level: 40 }] },
      { name: 'develop', push_access_levels: [{ access_level: 30 }] },
      { name: 'release/*', push_access_levels: [{ access_level: 0 }, { access_level: 40, user_id: 32 }] },
      { name: 'frozen', push_access_levels: [] },
      { push_access_levels: [] },
    ];
    expect(gitlabProtectedNames(branches, 32, 30)).toEqual(['main', 'frozen']);
    expect(gitlabProtectedNames(branches, 31, 40)).toEqual(['release/*', 'frozen']);
  });

  it('reads the access level, and so protected branches, on gitlab.com and on 16.9 or later only; an unknown version gives no rules', () => {
    const at = (version: string | undefined, builtIn = false): boolean => gitlabReadsAccessLevel({ builtIn, record: { ...(version !== undefined ? { version } : {}) } } as ForgeServer);
    expect(at('16.8.9-ee')).toBe(false);
    expect(at('16.9.0')).toBe(true);
    expect(at('17.9.1-ee')).toBe(true);
    expect(at('15.11.0')).toBe(false);
    expect(at(undefined)).toBe(false);
    expect(at('unknown')).toBe(false);
    expect(at(undefined, true)).toBe(true);
  });
});

describe('reading the rules from the stub', () => {
  let harness: Harness;
  let http: ForgeHttp;

  beforeAll(async () => {
    harness = await createHarness();
    http = createForgeHttp({ fetch: harness.fetch, userAgent: 'Damocles/0.0.0-test', log: (line) => harness.logs.push(line) });
  }, 60_000);

  afterAll(async () => {
    await harness.close();
  });

  beforeEach(() => {
    for (const stub of [harness.stub.github, harness.stub.indigital]) {
      stub.protection.clear();
      stub.graphqlQueries.length = 0;
      stub.requests.length = 0;
    }
  });

  it('GitHub: the repository\'s and the organization\'s rulesets (includeParents) and classic protected branches', async () => {
    harness.stub.github.protection.set('astefanopoulos/damocles', {
      rulesets: [
        { name: 'default', include: ['~DEFAULT_BRANCH'] },
        { name: 'org releases', include: ['refs/heads/release/*'], parent: true },
        { name: 'drafts', include: ['~ALL'], enforcement: 'DISABLED' },
        { name: 'signed tags', include: ['~ALL'], target: 'TAG' },
      ],
      classic: ['legacy'],
    });
    const rules = await githubBranchProtection(http, serverOf(harness.stub.github), GITHUB_TOKEN, 'astefanopoulos/damocles', signal());
    expect(['main', 'release/1.0', 'legacy'].map((branch) => protects(rules, branch))).toEqual([true, true, true]);
    expect(['feature/x', 'release/1.0/x', 'drafts'].map((branch) => protects(rules, branch))).toEqual([false, false, false]);
    expect(harness.stub.github.graphqlQueries.map((query) => query.name)).toEqual(['repositoryPermissions', 'repositoryRulesets', 'branchPushRules']);
    // the protected branches REST lists go to GraphQL in one query, each as its own variable
    expect(harness.stub.github.graphqlQueries.at(-1)!.variables).toEqual({ owner: 'astefanopoulos', repo: 'damocles', r0: 'refs/heads/legacy' });
    expect(harness.stub.github.requests.filter((request) => request.path.endsWith('/branches')).length).toBe(1);
    // every request went to the server's own origin with its own token
    expect(harness.stub.github.requests.every((request) => request.credential === GITHUB_TOKEN)).toBe(true);
  });

  it('GitHub: a protected branch counts only while its rule refuses the viewer\'s push; a ruleset that requires no pull request protects nothing', async () => {
    harness.stub.github.protection.set('astefanopoulos/damocles', {
      // blocks force pushes and deletion only, so REST lists main as protected though a direct push is allowed
      rulesets: [{ name: 'no force pushes', include: ['refs/heads/main'], pullRequest: false }],
      classic: ['legacy', 'release'],
    });
    const server = serverOf(harness.stub.github);
    const refused = await githubBranchProtection(http, server, GITHUB_TOKEN, 'astefanopoulos/damocles', signal());
    expect(['main', 'legacy', 'release'].map((branch) => protects(refused, branch))).toEqual([false, true, true]);
    // an administrator whose rule does not include administrators pushes past it
    harness.stub.github.protection.set('astefanopoulos/damocles', { rulesets: [{ name: 'no force pushes', include: ['refs/heads/main'], pullRequest: false }], classic: ['legacy', 'release'], classicPushers: ['astefanopoulos'] });
    const admin = await githubBranchProtection(http, server, GITHUB_TOKEN, 'astefanopoulos/damocles', signal());
    expect(['main', 'legacy', 'release'].map((branch) => protects(admin, branch))).toEqual([false, false, false]);
    expect(admin).toEqual([]);
  });

  it('GitHub: no rules for a viewer who cannot write, and none for a repository the token cannot see', async () => {
    harness.stub.github.protection.set('astefanopoulos/damocles', { rulesets: [{ name: 'all', include: ['~ALL'] }] });
    harness.stub.github.projectAccess.get('astefanopoulos/damocles')!.set('astefanopoulos', 20);
    try {
      expect(await githubBranchProtection(http, serverOf(harness.stub.github), GITHUB_TOKEN, 'astefanopoulos/damocles', signal())).toEqual([]);
      expect(harness.stub.github.graphqlQueries.map((query) => query.name)).toEqual(['repositoryPermissions']);
    } finally {
      harness.stub.github.projectAccess.get('astefanopoulos/damocles')!.set('astefanopoulos', 50);
    }
    expect(await githubBranchProtection(http, serverOf(harness.stub.github), GITHUB_TOKEN, 'someone/else', signal())).toEqual([]);
  });

  it('GitLab: protected branches whose push access excludes the user, against the project\'s level', async () => {
    harness.stub.indigital.protection.set('platform/api', {
      protectedBranches: [
        { name: 'main', push: [{ access_level: 40 }] },
        { name: 'develop', push: [{ access_level: 30 }] },
        { name: '*-stable', push: [{ access_level: 0 }] },
        { name: 'hotfix', push: [{ access_level: 40 }, { user_id: 32 }] },
      ],
    });
    const rules = await gitlabBranchProtection(http, serverOf(harness.stub.indigital, { version: '17.9.1-ee' }), INDIGITAL_TOKEN, 32, 'platform/api', signal());
    expect(['main', 'team/1-stable'].map((branch) => protects(rules, branch))).toEqual([true, true]);
    expect(['develop', 'hotfix', 'feature'].map((branch) => protects(rules, branch))).toEqual([false, false, false]);
  });

  it('GitLab: no rules for a Reporter or a Guest, who cannot push at all, and none for a non-member of a public project', async () => {
    harness.stub.indigital.protection.set('platform/api', { protectedBranches: [{ name: 'main', push: [{ access_level: 40 }] }] });
    const server = serverOf(harness.stub.indigital, { version: '17.9.1-ee' });
    const access = harness.stub.indigital.projectAccess.get('platform/api')!;
    try {
      for (const level of [20, 10]) {
        access.set('astefanopoulos', level);
        expect(await gitlabBranchProtection(http, server, INDIGITAL_TOKEN, 32, 'platform/api', signal())).toEqual([]);
      }
      access.set('astefanopoulos', {});
      expect(await gitlabBranchProtection(http, server, INDIGITAL_TOKEN, 32, 'platform/api', signal())).toEqual([]);
      expect(harness.stub.indigital.requests.some((request) => request.path.endsWith('/protected_branches'))).toBe(false);
    } finally {
      access.set('astefanopoulos', 30);
    }
  });

  it('GitLab: a Developer through a group the project is shared with can push, and its rules read that level', async () => {
    harness.stub.indigital.protection.set('platform/api', { protectedBranches: [{ name: 'main', push: [{ access_level: 40 }] }, { name: 'develop', push: [{ access_level: 30 }] }] });
    const server = serverOf(harness.stub.indigital, { version: '17.9.1-ee' });
    const access = harness.stub.indigital.projectAccess.get('platform/api')!;
    try {
      // REST's project_access and group_access are both null for this user
      access.set('astefanopoulos', { shared: 30 });
      expect(await gitlabRepoAccess(http, server, INDIGITAL_TOKEN, 'platform/api', signal())).toEqual({ readable: true, canPush: true, owner: false });
      const rules = await gitlabBranchProtection(http, server, INDIGITAL_TOKEN, 32, 'platform/api', signal());
      expect(['main', 'develop'].map((branch) => protects(rules, branch))).toEqual([true, false]);
    } finally {
      access.set('astefanopoulos', 30);
    }
  });

  it('GitLab\'s access check: push from pushCode, owner from the highest role, and a non-member of a public project reads but cannot push', async () => {
    const server = serverOf(harness.stub.indigital, { version: '17.9.1-ee' });
    const access = harness.stub.indigital.projectAccess.get('platform/api')!;
    try {
      access.set('astefanopoulos', { group: 50 });
      expect(await gitlabRepoAccess(http, server, INDIGITAL_TOKEN, 'platform/api', signal())).toEqual({ readable: true, canPush: true, owner: true });
      access.set('astefanopoulos', 20);
      expect(await gitlabRepoAccess(http, server, INDIGITAL_TOKEN, 'platform/api', signal())).toEqual({ readable: true, canPush: false, owner: false });
      access.set('astefanopoulos', {});
      expect(await gitlabRepoAccess(http, server, INDIGITAL_TOKEN, 'platform/api', signal())).toEqual({ readable: true, canPush: false, owner: false });
    } finally {
      access.set('astefanopoulos', 30);
    }
    expect(await gitlabRepoAccess(http, server, INDIGITAL_TOKEN, 'secret/thing', signal())).toEqual({ readable: false, canPush: false, owner: false });
    // a server before 16.9 has no maxAccessLevel: it is asked for push access only
    expect(await gitlabProjectAccess(http, serverOf(harness.stub.indigital, { version: '16.8.0' }), INDIGITAL_TOKEN, 'platform/api', signal())).toEqual({ readable: true, canPush: true });
  });

  it('GitLab: a GraphQL answer without data is a failure, never a project the token cannot see', async () => {
    const server = serverOf(harness.stub.indigital, { version: '17.9.1-ee' });
    const fake = { request: async () => ({ status: 200, headers: new Headers(), body: { data: null, errors: [{ message: 'Internal server error' }] }, notModified: false }) } as unknown as ForgeHttp;
    await expect(gitlabProjectAccess(fake, server, INDIGITAL_TOKEN, 'platform/api', signal())).rejects.toMatchObject({ kind: 'server' });
    await expect(gitlabBranchProtection(fake, server, INDIGITAL_TOKEN, 32, 'platform/api', signal())).rejects.toMatchObject({ kind: 'server' });
  });

  it('GitLab: a server older than 16.9 or of an unknown version is not asked', async () => {
    harness.stub.indigital.protection.set('platform/api', { protectedBranches: [{ name: 'main', push: [{ access_level: 40 }] }] });
    expect(await gitlabBranchProtection(http, serverOf(harness.stub.indigital, { version: '16.8.0' }), INDIGITAL_TOKEN, 32, 'platform/api', signal())).toEqual([]);
    expect(await gitlabBranchProtection(http, serverOf(harness.stub.indigital), INDIGITAL_TOKEN, 32, 'platform/api', signal())).toEqual([]);
    expect(harness.stub.indigital.requests).toEqual([]);
  });
});

describe('the rules cache', () => {
  const SERVER: ForgeServer = { record: { id: 'gitlab.example.com', kind: 'gitlab', flavor: 'gitlab', gitHosts: [], addedAt: 0 }, id: 'gitlab.example.com', kind: 'gitlab', flavor: 'gitlab', builtIn: false, webUrl: 'https://gitlab.example.com', apiUrl: 'https://gitlab.example.com/api/v4', origins: new Set(['https://gitlab.example.com']) };
  const account = (userId: string): AccountRecord => ({ id: `gitlab.example.com|${userId}`, serverId: 'gitlab.example.com', userId, login: `user${userId}`, auth: 'token', scopes: ['api'], agentShells: false, addedAt: 0 });
  const MAIN: BranchProtectionRule[] = [{ include: ['main'], exclude: [], syntax: 'gitlab' }];
  const endpoint = (remote: string, path = 'grp/app.git'): RemoteEndpoint => ({ remote, fetch: { protocol: 'https', host: 'gitlab.example.com', path, aliasResolved: false } });
  const repo = { projectKey: 'c:/src/app', authorityKey: 'local', endpoints: [endpoint('origin')] };

  let bound: ProjectBinding | undefined;
  let bindings: BindingStore;
  let accounts: AccountRecord[];
  let enabled: boolean;
  let reads: { readonly accountId: string; settle: (rules: readonly BranchProtectionRule[]) => void; fail: (err: Error) => void }[];
  let logs: string[];
  let deps: BranchProtectionDeps;

  beforeEach(() => {
    vi.useFakeTimers({ now: 1_000_000 });
    bound = undefined;
    bindings = { binding: () => bound, hostDefaults: () => ({}) } as unknown as BindingStore;
    accounts = [account('1')];
    enabled = true;
    reads = [];
    logs = [];
    deps = {
      servers: () => [SERVER],
      accounts: () => accounts,
      bindings,
      usable: () => true,
      pickByAccess: async (candidates) => candidates[0],
      read: (reader) => new Promise((resolve, reject) => reads.push({ accountId: reader.id, settle: resolve, fail: reject })),
      enabled: () => enabled,
      now: () => Date.now(),
      log: (line) => logs.push(line),
    };
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('answers nothing at once with nothing held, reads in the background, and answers the rules once read', async () => {
    const cache = createBranchProtectionCache(deps);
    // the lookup returns while the read is still out: a commit never waits on it
    expect(cache.lookup(repo)).toEqual([]);
    expect(reads).toHaveLength(1);
    expect(cache.lookup(repo)).toEqual([]);
    expect(reads).toHaveLength(1);
    reads[0]!.settle(MAIN);
    await cache.idle();
    expect(cache.lookup(repo)).toEqual([{ remote: 'origin', rules: MAIN }]);
    expect(reads).toHaveLength(1);
  });

  it('reads again in the background after 30 minutes, answering the held rules meanwhile', async () => {
    const cache = createBranchProtectionCache(deps);
    cache.lookup(repo);
    reads[0]!.settle(MAIN);
    await cache.idle();
    vi.advanceTimersByTime(PROTECTION_FRESH_MS - 1);
    expect(cache.lookup(repo)).toEqual([{ remote: 'origin', rules: MAIN }]);
    expect(reads).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(cache.lookup(repo)).toEqual([{ remote: 'origin', rules: MAIN }]);
    expect(reads).toHaveLength(2);
    reads[1]!.settle([]);
    await cache.idle();
    expect(cache.lookup(repo)).toEqual([]);
    expect(reads).toHaveLength(2);
  });

  it('keeps the held rules when the server cannot be reached, and tries again only after 5 minutes', async () => {
    const cache = createBranchProtectionCache(deps);
    cache.lookup(repo);
    reads[0]!.settle(MAIN);
    await cache.idle();
    vi.advanceTimersByTime(PROTECTION_FRESH_MS);
    cache.lookup(repo);
    reads[1]!.fail(new Error('offline'));
    await cache.idle();
    expect(cache.lookup(repo)).toEqual([{ remote: 'origin', rules: MAIN }]);
    vi.advanceTimersByTime(PROTECTION_RETRY_MS - 1);
    cache.lookup(repo);
    expect(reads).toHaveLength(2);
    vi.advanceTimersByTime(1);
    cache.lookup(repo);
    expect(reads).toHaveLength(3);
    expect(logs.some((line) => line.includes('gitlab.example.com'))).toBe(true);
  });

  it('with the setting off answers nothing and reads nothing', () => {
    enabled = false;
    const cache = createBranchProtectionCache(deps);
    expect(cache.lookup(repo)).toEqual([]);
    expect(reads).toEqual([]);
  });

  it('reads by the push URL, per remote; a remote on no managed server, a project on Git\'s own credentials and a server with no account give nothing', async () => {
    const cache = createBranchProtectionCache(deps);
    const pushed: RemoteEndpoint = { remote: 'origin', fetch: { protocol: 'https', host: 'mirror.example.com', path: 'grp/app.git', aliasResolved: false }, push: endpoint('origin').fetch! };
    cache.lookup({ ...repo, endpoints: [pushed, { remote: 'mirror', fetch: { protocol: 'https', host: 'mirror.example.com', path: 'grp/app.git', aliasResolved: false } }] });
    expect(reads).toHaveLength(1);
    reads[0]!.settle(MAIN);
    await cache.idle();
    expect(cache.lookup({ ...repo, endpoints: [pushed] })).toEqual([{ remote: 'origin', rules: MAIN }]);

    bound = { account: null, at: 0 };
    expect(cache.lookup(repo)).toEqual([]);
    bound = undefined;
    accounts = [];
    expect(cache.lookup(repo)).toEqual([]);
    expect(reads).toHaveLength(1);
  });

  it('does not answer another account\'s rules: a bound account reads its own, and a signed-out account\'s are forgotten', async () => {
    accounts = [account('1'), account('2')];
    const cache = createBranchProtectionCache(deps);
    cache.lookup(repo);
    // with two accounts the access check picks, which settles first
    for (let turn = 0; turn < 5; turn++) await Promise.resolve();
    expect(reads[0]!.accountId).toBe('gitlab.example.com|1');
    reads[0]!.settle(MAIN);
    await cache.idle();
    expect(cache.lookup(repo)).toEqual([{ remote: 'origin', rules: MAIN }]);

    bound = { account: 'gitlab.example.com|2', at: 0 };
    expect(cache.lookup(repo)).toEqual([]);
    expect(reads[1]!.accountId).toBe('gitlab.example.com|2');
    reads[1]!.settle([]);
    await cache.idle();

    cache.forgetAccount('gitlab.example.com|2');
    expect(cache.lookup(repo)).toEqual([]);
    expect(reads).toHaveLength(3);
  });

  it('answers at most the wire\'s remotes, the branch\'s upstream remote first', async () => {
    const cache = createBranchProtectionCache(deps);
    const many = { ...repo, pushRemote: 'r39', endpoints: Array.from({ length: 40 }, (_, index) => endpoint(`r${index}`, `grp/app${index}.git`)) };
    cache.lookup(many);
    expect(reads).toHaveLength(MAX_PROTECTED_REMOTES);
    for (const read of reads) read.settle(MAIN);
    await cache.idle();
    const answered = cache.lookup(many);
    expect(answered).toHaveLength(MAX_PROTECTED_REMOTES);
    expect(answered[0]!.remote).toBe('r39');
  });

  describe('a refused push', () => {
    const PROTECTED = { protection: 'protected', serverId: 'gitlab.example.com', serverName: 'gitlab.example.com', kind: 'gitlab', accountId: 'gitlab.example.com|1', login: 'user1', path: 'grp/app' };

    it('waits only for a background read of its own account, and stops waiting when its signal aborts', async () => {
      accounts = [account('1'), account('2')];
      const cache = createBranchProtectionCache(deps);
      cache.lookup(repo);
      await vi.waitFor(() => expect(reads).toHaveLength(1));
      expect(reads[0]!.accountId).toBe('gitlab.example.com|1');
      // the push used account 2: the background read of account 1 is not its read
      bound = { account: 'gitlab.example.com|2', at: 0 };
      const deciding = cache.pushProtection(repo, 'origin', 'main', signal());
      await vi.waitFor(() => expect(reads).toHaveLength(2));
      expect(reads[1]!.accountId).toBe('gitlab.example.com|2');
      reads[1]!.settle(MAIN);
      expect(await deciding).toMatchObject({ protection: 'protected', accountId: 'gitlab.example.com|2' });
      reads[0]!.fail(new Error('offline'));
      await cache.idle();

      bound = { account: 'gitlab.example.com|1', at: 0 };
      vi.advanceTimersByTime(PROTECTION_RETRY_MS);
      cache.lookup(repo);
      expect(reads).toHaveLength(3);
      const controller = new AbortController();
      const waiting = cache.pushProtection(repo, 'origin', 'main', controller.signal);
      controller.abort(new Error('the push dialog closed'));
      await expect(waiting).rejects.toThrow('the push dialog closed');
      expect(reads).toHaveLength(3);
    });

    it('reads the rules once on a miss and decides from them, then answers from the cache', async () => {
      const cache = createBranchProtectionCache(deps);
      const deciding = cache.pushProtection(repo, 'origin', 'main', signal());
      await vi.waitFor(() => expect(reads).toHaveLength(1));
      reads[0]!.settle(MAIN);
      expect(await deciding).toEqual(PROTECTED);
      expect(await cache.pushProtection(repo, 'origin', 'feature/x', signal())).toEqual({ protection: 'unprotected' });
      expect(reads).toHaveLength(1);
      expect(cache.lookup(repo)).toEqual([{ remote: 'origin', rules: MAIN }]);
    });

    it('reads again for a decision once the held rules are 30 minutes old', async () => {
      const cache = createBranchProtectionCache(deps);
      cache.lookup(repo);
      reads[0]!.settle([]);
      await cache.idle();
      vi.advanceTimersByTime(PROTECTION_FRESH_MS);
      const deciding = cache.pushProtection(repo, 'origin', 'main', signal());
      await vi.waitFor(() => expect(reads).toHaveLength(2));
      reads[1]!.settle(MAIN);
      expect(await deciding).toEqual(PROTECTED);
    });

    it('waits for a background read under way instead of reading the same rules twice', async () => {
      const cache = createBranchProtectionCache(deps);
      cache.lookup(repo);
      const deciding = cache.pushProtection(repo, 'origin', 'main', signal());
      await Promise.resolve();
      reads[0]!.settle(MAIN);
      expect(await deciding).toEqual(PROTECTED);
      expect(reads).toHaveLength(1);
    });

    it('answers unknown when the background read it waited for failed, without reading again', async () => {
      const cache = createBranchProtectionCache(deps);
      cache.lookup(repo);
      const deciding = cache.pushProtection(repo, 'origin', 'main', signal());
      await Promise.resolve();
      reads[0]!.fail(new Error('offline'));
      expect(await deciding).toEqual({ protection: 'unknown' });
      expect(reads).toHaveLength(1);
    });

    it('answers unknown when the rules cannot be read, the setting is off, the project uses Git\'s own credentials or the remote is on no managed server', async () => {
      const cache = createBranchProtectionCache(deps);
      const failing = cache.pushProtection(repo, 'origin', 'main', signal());
      await vi.waitFor(() => expect(reads).toHaveLength(1));
      reads[0]!.fail(new Error('offline'));
      expect(await failing).toEqual({ protection: 'unknown' });
      expect(await cache.pushProtection(repo, 'upstream', 'main', signal())).toEqual({ protection: 'unknown' });
      bound = { account: null, at: 0 };
      expect(await cache.pushProtection(repo, 'origin', 'main', signal())).toEqual({ protection: 'unknown' });
      bound = undefined;
      enabled = false;
      expect(await cache.pushProtection(repo, 'origin', 'main', signal())).toEqual({ protection: 'unknown' });
      expect(reads).toHaveLength(1);
    });

    it('decides by the rules of the push\'s own account, never another account\'s', async () => {
      accounts = [account('1'), account('2')];
      const cache = createBranchProtectionCache(deps);
      cache.lookup(repo);
      for (let turn = 0; turn < 5; turn++) await Promise.resolve();
      reads[0]!.settle(MAIN);
      await cache.idle();
      bound = { account: 'gitlab.example.com|2', at: 0 };
      const deciding = cache.pushProtection(repo, 'origin', 'main', signal());
      await vi.waitFor(() => expect(reads).toHaveLength(2));
      expect(reads[1]!.accountId).toBe('gitlab.example.com|2');
      reads[1]!.settle([]);
      expect(await deciding).toEqual({ protection: 'unprotected' });
    });
  });
});

describe('the forge service', () => {
  let harness: Harness;

  beforeAll(async () => {
    harness = await createHarness();
  }, 60_000);

  afterAll(async () => {
    await harness.close();
  });

  it('answers a repository on gitlab.com from memory and reads it in the background; the setting off reads nothing', async () => {
    const service = harness.service();
    await service.load();
    await service.signIn({ serverId: 'gitlab.com', route: 'token', token: 'glpat-stubAlexiosSApi000000008', agentShells: false });
    harness.stub.gitlab.protection.set('alexios-s/damocles', { protectedBranches: [{ name: 'main', push: [{ access_level: 0 }] }] });
    const url = new URL(harness.stub.gitlab.webUrl);
    const repo = { projectKey: 'c:/src/damocles', authorityKey: 'local', endpoints: [{ remote: 'origin', fetch: { protocol: 'https' as const, host: url.hostname, port: Number(url.port), path: 'alexios-s/damocles.git', aliasResolved: false } }] };
    const asked = (): number => harness.stub.gitlab.requests.filter((request) => request.path.endsWith('/protected_branches')).length;

    harness.settings = { [FORGE_BRANCH_PROTECTION_SETTING]: false };
    expect(service.branchProtection(repo)).toEqual([]);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(asked()).toBe(0);

    harness.settings = {};
    expect(service.branchProtection(repo)).toEqual([]);
    await expect.poll(() => service.branchProtection(repo), { timeout: 10_000 }).toEqual([{ remote: 'origin', rules: [{ include: ['main'], exclude: [], syntax: 'gitlab' }] }]);
    expect(asked()).toBe(1);
    service.dispose();
  });
});
