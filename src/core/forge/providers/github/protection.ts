// Branch protection read from GitHub, adapted from VS Code's extensions/github/src/branchProtection.ts
// (GitHubBranchProtectionProvider), Copyright (c) Microsoft Corporation. Licensed under the MIT License
// (THIRD-PARTY-NOTICES.md).
import type { BranchProtectionRule } from '../../../../shared/forge/branch-protection';
import { field, stringField, type ForgeHttp } from '../../http';
import { ForgeHttpError, type ForgeServer } from '../../types';
import { literalPattern } from '../protection-rules';
import { githubGraphql, graphqlFailure } from './graphql';

const REPOSITORY_QUERY = `
query repositoryPermissions($owner: String!, $repo: String!) {
  repository(owner: $owner, name: $repo) {
    defaultBranchRef { name }
    viewerPermission
  }
}`;

const RULESETS_QUERY = `
query repositoryRulesets($owner: String!, $repo: String!, $cursor: String, $limit: Int = 100) {
  repository(owner: $owner, name: $repo) {
    rulesets(includeParents: true, first: $limit, after: $cursor) {
      nodes {
        name
        enforcement
        rules(type: PULL_REQUEST) { totalCount }
        conditions { refName { include exclude } }
        target
      }
      pageInfo { endCursor hasNextPage }
    }
  }
}`;

/** One query for up to PAGE_SIZE branches, each by its own variable: whether the branch rules let the viewer push to it. */
function pushRulesQuery(count: number): string {
  const indexes = Array.from({ length: count }, (_, index) => index);
  return `
query branchPushRules($owner: String!, $repo: String!, ${indexes.map((index) => `$r${index}: String!`).join(', ')}) {
  repository(owner: $owner, name: $repo) {
    ${indexes.map((index) => `r${index}: ref(qualifiedName: $r${index}) { refUpdateRule { viewerCanPush } }`).join('\n    ')}
  }
}`;
}

// a user below these can push to no branch, so no branch asks
const WRITERS: ReadonlySet<string> = new Set(['ADMIN', 'MAINTAIN', 'WRITE']);
const MAX_PAGES = 10;
const PAGE_SIZE = 100;

/** A ruleset's ref name as a branch pattern (VS Code's parseRulesetRefName); undefined for ~DEFAULT_BRANCH of a repository with none. */
export function rulesetRefGlob(refName: string, defaultBranch: string | undefined): string | undefined {
  if (refName.startsWith('refs/heads/')) return refName.slice('refs/heads/'.length);
  if (refName === '~ALL') return '**/*';
  if (refName === '~DEFAULT_BRANCH') return defaultBranch !== undefined ? literalPattern(defaultBranch) : undefined;
  return refName;
}

const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const strings = (value: unknown): string[] => list(value).filter((item): item is string => typeof item === 'string');

/** Active branch rulesets that require a pull request, as rules; a ruleset whose names all drop out protects nothing. */
export function rulesetRules(nodes: readonly unknown[], defaultBranch: string | undefined): BranchProtectionRule[] {
  return nodes.flatMap((node) => {
    if (stringField(node, 'target') !== 'BRANCH' || stringField(node, 'enforcement') !== 'ACTIVE') return [];
    const pullRequests = field(field(node, 'rules'), 'totalCount');
    if (typeof pullRequests !== 'number' || pullRequests <= 0) return [];
    const refName = field(field(node, 'conditions'), 'refName');
    const globs = (names: unknown): string[] => strings(names).flatMap((name) => rulesetRefGlob(name, defaultBranch) ?? []);
    return [{ include: globs(field(refName, 'include')), exclude: globs(field(refName, 'exclude')), syntax: 'fnmatch' as const }];
  });
}

async function rulesets(http: ForgeHttp, server: ForgeServer, token: string, owner: string, repo: string, defaultBranch: string | undefined, signal: AbortSignal): Promise<BranchProtectionRule[]> {
  const rules: BranchProtectionRule[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < MAX_PAGES; page++) {
    const answer = await githubGraphql(http, server, token, 'rulesets', RULESETS_QUERY, { owner, repo, cursor, limit: PAGE_SIZE }, signal);
    const connection = field(field(answer.data, 'repository'), 'rulesets');
    // a server without rulesets (an older GHES) answers an error for the field
    if (connection === undefined || connection === null) return rules;
    rules.push(...rulesetRules(list(field(connection, 'nodes')), defaultBranch));
    const pageInfo = field(connection, 'pageInfo');
    const next = stringField(pageInfo, 'endCursor');
    if (field(pageInfo, 'hasNextPage') !== true || next === undefined) break;
    cursor = next;
  }
  return rules;
}

/**
 * GET /repos/{owner}/{repo}/branches?protected=true: the branches branch protection or any ruleset covers, a ruleset that
 * only blocks force pushes or deletion included.
 */
async function protectedBranchNames(http: ForgeHttp, server: ForgeServer, token: string, owner: string, repo: string, signal: AbortSignal): Promise<string[]> {
  const names: string[] = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    let body: unknown;
    try {
      body = (await http.request({
        server,
        url: `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/branches?protected=true&per_page=${PAGE_SIZE}&page=${page}`,
        template: '/repos/{owner}/{repo}/branches',
        credential: { bearer: token },
        signal,
      })).body;
    } catch (err) {
      // a token that may not list the branches leaves the rulesets as the only rules
      if (err instanceof ForgeHttpError && (err.kind === 'notFound' || err.kind === 'forbidden')) return names;
      throw err;
    }
    const items = list(body);
    names.push(...items.flatMap((item) => stringField(item, 'name') ?? []));
    if (items.length < PAGE_SIZE) break;
  }
  return names;
}

/**
 * The names whose branch protection rule refuses the viewer's push (Ref.refUpdateRule.viewerCanPush false); a branch with no
 * such rule, one only a ruleset covers, is left to the rulesets read above.
 */
async function pushRefusedNames(http: ForgeHttp, server: ForgeServer, token: string, owner: string, repo: string, names: readonly string[], signal: AbortSignal): Promise<string[]> {
  const refused: string[] = [];
  for (let at = 0; at < names.length; at += PAGE_SIZE) {
    const batch = names.slice(at, at + PAGE_SIZE);
    const variables = Object.fromEntries(batch.map((name, index) => [`r${index}`, `refs/heads/${name}`]));
    const answer = await githubGraphql(http, server, token, 'branchPushRules', pushRulesQuery(batch.length), { owner, repo, ...variables }, signal);
    const repository = field(answer.data, 'repository');
    if (repository === undefined || repository === null) throw graphqlFailure(answer.errors, 'GitHub answered the branch rules query without the repository', answer.ssoUrl);
    batch.forEach((name, index) => {
      if (field(field(field(repository, `r${index}`), 'refUpdateRule'), 'viewerCanPush') === false) refused.push(name);
    });
  }
  return refused;
}

/**
 * The branches of owner/repo a commit should not land on directly: active rulesets requiring a pull request (the
 * organization's included) and the protected branches whose rule refuses the viewer's push. None for a viewer who cannot
 * write.
 */
export async function githubBranchProtection(http: ForgeHttp, server: ForgeServer, token: string, repoPath: string, signal: AbortSignal): Promise<readonly BranchProtectionRule[]> {
  const [owner, repo] = repoPath.split('/');
  if (owner === undefined || repo === undefined) throw new Error('A GitHub repository path is owner/repo');
  const details = await githubGraphql(http, server, token, 'repository', REPOSITORY_QUERY, { owner, repo }, signal);
  const repository = field(details.data, 'repository');
  if (repository === undefined || repository === null) {
    if (details.errors.length > 0 && details.data == null) throw graphqlFailure(details.errors, 'GitHub answered the repository query with errors only');
    return [];
  }
  if (!WRITERS.has(stringField(repository, 'viewerPermission') ?? '')) return [];
  const defaultBranch = stringField(field(repository, 'defaultBranchRef'), 'name');
  const fromRulesets = await rulesets(http, server, token, owner, repo, defaultBranch, signal);
  const named = await protectedBranchNames(http, server, token, owner, repo, signal);
  const refused = named.length > 0 ? await pushRefusedNames(http, server, token, owner, repo, named, signal) : [];
  return [...fromRulesets, ...(refused.length > 0 ? [{ include: refused.map(literalPattern), exclude: [], syntax: 'fnmatch' as const }] : [])];
}
