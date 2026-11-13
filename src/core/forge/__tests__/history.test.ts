import { createHash } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ForgeService } from '..';
import type { HistoryAuthor } from '../../../shared/forge/history';
import { avatarKey } from '../avatars';
import type { CiRepo } from '../ci-watch';
import { FORGE_SHOW_AVATARS_SETTING } from '../types';
import { HISTORY_FIXTURES } from './support/forge-stub-history';
import { createHarness, type Harness } from './support/harness';

// History details against the stub: author pictures batched per page, cached per (server, email) with misses,
// none asked while showAvatars is off; pictures fetched lazily, a token only to the server's own origin, a third-party host
// through the SSRF guard without one, SVG, HTML and oversized bodies refused; the merged change containing a commit.

let harness: Harness;
let service: ForgeService;
const guarded: string[] = [];
let keysPublished = 0;
// the services' clock, which a test moves
let clock = Date.UTC(2026, 10, 12, 9);

const sha = (n: number): string => n.toString(16).padStart(40, '0');
const { alexios, maria, nikos, ciBot, big, notImage } = HISTORY_FIXTURES.authors;
const author = (who: { readonly name: string; readonly email: string }, n: number): HistoryAuthor => ({ sha: sha(n), email: who.email, name: who.name });

function repoOn(webUrl: string, path: string): CiRepo {
  const url = new URL(webUrl);
  return { authorityKey: 'local', projectKey: 'c:/src/history', project: 'history', endpoints: [{ remote: 'origin', fetch: { protocol: 'https', host: url.hostname, port: Number(url.port), path, aliasResolved: false } }] };
}

let gitlabRepo: CiRepo;
let githubRepo: CiRepo;
const signal = new AbortController().signal;

/** A service over the signed-in world with empty caches, so a describe depends on no other's lookups. */
async function freshService(): Promise<void> {
  service?.dispose();
  keysPublished = 0;
  service = harness.service({
    now: () => clock,
    // the SSRF guard refuses 127.0.0.1; the stub's third-party picture host stands in for a public one
    publicFetch: async (url, init) => {
      const { origin } = new URL(url);
      guarded.push(origin);
      if (origin !== harness.stub.pictures.url && origin !== harness.stub.logStorage.url) throw new Error(`${origin} is not a public address`);
      return harness.fetch(url, init);
    },
  });
  service.onAuthorAvatarKeys(() => keysPublished++);
  await service.load();
}

beforeAll(async () => {
  harness = await createHarness();
  await freshService();
  await service.signIn({ serverId: 'gitlab.com', route: 'token', token: 'glpat-stubAlexiosSApi000000008', agentShells: false });
  await service.signIn({ serverId: 'github.com', route: 'token', token: 'ghp_stubAstefanopoulosRepo0000000001', agentShells: false });
  gitlabRepo = repoOn(harness.stub.gitlab.webUrl, 'alexios-s/damocles.git');
  githubRepo = repoOn(harness.stub.github.webUrl, 'astefanopoulos/damocles.git');
}, 60_000);

afterAll(async () => {
  await harness.close();
});

beforeEach(() => {
  harness.settings[FORGE_SHOW_AVATARS_SETTING] = true;
});

afterEach(() => {
  for (const ui of [harness.stub.gitlab.history, harness.stub.github.history]) {
    ui.commits.clear();
    ui.containing.clear();
    ui.unknownCommits.clear();
    ui.failingAvatars.clear();
    ui.avatarUrls.clear();
    ui.onAvatar = undefined;
    ui.holdUsers = undefined;
  }
});

const avatarAsks = (): number => harness.stub.gitlab.avatarRequests().length;

/** A repository whose origin is the user's fork and whose upstream the repository it came from, both on the stub's GitHub. */
function forkClone(): CiRepo {
  const url = new URL(harness.stub.github.webUrl);
  const at = (remote: string, path: string) => ({ remote, fetch: { protocol: 'https' as const, host: url.hostname, port: Number(url.port), path, aliasResolved: false } });
  return { authorityKey: 'local', projectKey: 'c:/src/fork', project: 'fork', pushRemote: 'origin', endpoints: [at('origin', 'someone-else/damocles.git'), at('upstream', 'astefanopoulos/damocles.git')] };
}

describe('history context', () => {
  beforeAll(freshService);

  it('names the server of a repository on a server with an account, and nothing for any other', () => {
    expect(service.historyContext(gitlabRepo)).toEqual({ kind: 'gitlab', serverName: 'gitlab.com', showAvatars: true });
    expect(service.historyContext(githubRepo)).toEqual({ kind: 'github', serverName: 'github.com', showAvatars: true });
    expect(service.historyContext(repoOn('https://code.example.com', 'grp/proj.git'))).toBeNull();
    harness.settings[FORGE_SHOW_AVATARS_SETTING] = false;
    expect(service.historyContext(gitlabRepo)).toMatchObject({ showAvatars: false });
  });

  it('in a fork clone, reads the merged change and links references on upstream, and files and commits on the tracked fork', async () => {
    const fork = forkClone();
    expect(await service.containingChange(fork, sha(50), signal)).toEqual({ kind: 'pullRequest', number: HISTORY_FIXTURES.mergedChange, serverName: 'github.com' });
    expect(service.link(fork, { kind: 'reference', reference: { sigil: '#', number: HISTORY_FIXTURES.issue } })).toMatchObject({ url: `${harness.stub.github.webUrl}/astefanopoulos/damocles/issues/${HISTORY_FIXTURES.issue}`, remote: 'upstream' });
    expect(service.link(fork, { kind: 'commit', sha: sha(50) })).toMatchObject({ url: `${harness.stub.github.webUrl}/someone-else/damocles/commit/${sha(50)}`, remote: 'origin' });
  });
});

describe('author pictures on GitLab', () => {
  beforeAll(freshService);
  const page = [author(alexios, 1), author(maria, 2), author(nikos, 3), author(ciBot, 4), author(big, 5), author(notImage, 6), { ...author(alexios, 7), email: 'A.Stefanopoulos@Indigital.GR' }];

  it('makes no avatar request and issues no key while showAvatars is off', async () => {
    harness.settings[FORGE_SHOW_AVATARS_SETTING] = false;
    const before = avatarAsks();
    expect(await service.authorAvatars(gitlabRepo, page, signal)).toEqual({});
    expect(avatarAsks()).toBe(before);
    expect(service.authorAvatarKeys()).toEqual([]);
    expect(keysPublished).toBe(0);
  });

  it('asks GET /avatar once per distinct email of a page, publishes the keys before answering, and caches hits and misses', async () => {
    const before = avatarAsks();
    const answer = await service.authorAvatars(gitlabRepo, page, signal);
    expect(harness.stub.gitlab.avatarRequests().slice(before)).toEqual(Array.from({ length: 6 }, () => 'GET /api/v4/avatar'));
    expect(Object.keys(answer).sort()).toEqual([alexios.email, big.email, maria.email, nikos.email, notImage.email].sort());
    expect(answer[alexios.email]).toBe(avatarKey('gitlab.com', `${harness.stub.gitlab.webUrl}/uploads/-/system/user/avatar/32/avatar.png`));
    expect(keysPublished).toBe(1);
    expect([...service.authorAvatarKeys()].sort()).toEqual(Object.values(answer).sort());
    // the next page with the same authors asks nothing, misses included
    expect(await service.authorAvatars(gitlabRepo, page, signal)).toEqual(answer);
    expect(avatarAsks()).toBe(before + 6);
    expect(keysPublished).toBe(1);
  });

  it('fetches a picture only when main asks: the token to the server\'s own origin, none to a third-party host behind the SSRF guard', async () => {
    const answer = await service.authorAvatars(gitlabRepo, page, signal);
    const own = await service.avatar(answer[alexios.email]!);
    expect(own?.mime).toBe('image/png');
    const ownRequest = harness.stub.gitlab.requests.find((request) => request.path === '/uploads/-/system/user/avatar/32/avatar.png');
    expect(ownRequest?.credential).toBe('glpat-stubAlexiosSApi000000008');
    guarded.length = 0;
    const third = await service.avatar(answer[maria.email]!);
    expect(third?.mime).toBe('image/png');
    const md5 = createHash('md5').update(maria.email).digest('hex');
    expect(harness.stub.pictures.requests).toEqual([{ path: `/avatar/${md5}`, authorized: false }]);
    expect(guarded).toEqual([harness.stub.pictures.url]);
  });

  it('refuses an SVG, an HTML body and a body over 512 KiB', async () => {
    const answer = await service.authorAvatars(gitlabRepo, page, signal);
    expect(await service.avatar(answer[nikos.email]!)).toBeUndefined();
    expect(await service.avatar(answer[notImage.email]!)).toBeUndefined();
    await expect(service.avatar(answer[big.email]!)).rejects.toThrow();
    expect(harness.logs.some((line) => line.includes('/avatar not shown'))).toBe(true);
    expect(harness.logs.filter((line) => line.includes('is not PNG, JPEG, GIF or WebP'))).toHaveLength(2);
  });

  it('serves no picture while showAvatars is off, and fetches none', async () => {
    const answer = await service.authorAvatars(gitlabRepo, page, signal);
    const before = harness.stub.gitlab.requests.length;
    harness.settings[FORGE_SHOW_AVATARS_SETTING] = false;
    expect(await service.avatar(answer[alexios.email]!)).toBeUndefined();
    expect(service.authorAvatarKeys()).toEqual([]);
    expect(harness.stub.gitlab.requests).toHaveLength(before);
  });
});

describe('author picture bounds and lifetimes on GitLab', () => {
  beforeEach(freshService);
  const authors = (count: number, from = 0): HistoryAuthor[] => Array.from({ length: count }, (_, index) => ({ sha: sha(1000 + from + index), email: `dev${from + index}@example.com`, name: `Dev ${from + index}` }));

  it('looks up at most 100 authors of one call', async () => {
    const before = avatarAsks();
    await service.authorAvatars(gitlabRepo, authors(150), signal);
    expect(avatarAsks()).toBe(before + 100);
  });

  it('keeps a picture a day and a miss an hour', async () => {
    const page = [author(alexios, 1), author(ciBot, 2)];
    const before = avatarAsks();
    const answer = await service.authorAvatars(gitlabRepo, page, signal);
    expect(Object.keys(answer)).toEqual([alexios.email]);
    clock += 59 * 60_000;
    expect(await service.authorAvatars(gitlabRepo, page, signal)).toEqual(answer);
    expect(avatarAsks()).toBe(before + 2);
    // the miss expired, the picture not yet
    clock += 2 * 60_000;
    expect(await service.authorAvatars(gitlabRepo, page, signal)).toEqual(answer);
    expect(avatarAsks()).toBe(before + 3);
    clock += 24 * 60 * 60_000;
    expect(await service.authorAvatars(gitlabRepo, page, signal)).toEqual(answer);
    expect(avatarAsks()).toBe(before + 5);
  });

  it('issues no key for a picture address that is not https or is longer than 2048 characters', async () => {
    const [plain, long, fine] = authors(3);
    harness.stub.gitlab.history.avatarUrls.set(plain!.email, 'http://pictures.example/a.png');
    harness.stub.gitlab.history.avatarUrls.set(long!.email, `https://pictures.example/${'a'.repeat(2048)}.png`);
    harness.stub.gitlab.history.avatarUrls.set(fine!.email, 'https://pictures.example/fine.png');
    expect(Object.keys(await service.authorAvatars(gitlabRepo, [plain!, long!, fine!], signal))).toEqual([fine!.email]);
  });

  it('stops at the first failed lookup and keeps nothing for the authors it did not reach, which the next page asks', async () => {
    const page = authors(10, 100);
    harness.stub.gitlab.history.failingAvatars.add(page[0]!.email);
    const before = avatarAsks();
    expect(await service.authorAvatars(gitlabRepo, page, signal)).toEqual({});
    // four lookups run at once: the failing one and the three beside it, whose misses are kept
    expect(avatarAsks()).toBe(before + 4);
    expect(harness.logs.some((line) => line.includes('author pictures on gitlab.com failed after 0 of 10'))).toBe(true);
    harness.stub.gitlab.history.failingAvatars.clear();
    await service.authorAvatars(gitlabRepo, page, signal);
    expect(avatarAsks()).toBe(before + 4 + 7);
  });

  it('answers {} and issues no key when showAvatars goes off while the lookups run', async () => {
    harness.stub.gitlab.history.onAvatar = () => {
      harness.settings[FORGE_SHOW_AVATARS_SETTING] = false;
    };
    expect(await service.authorAvatars(gitlabRepo, [author(alexios, 1)], signal)).toEqual({});
    expect(service.authorAvatarKeys()).toEqual([]);
    expect(keysPublished).toBe(0);
  });
});

describe('author pictures on GitHub', () => {
  beforeAll(freshService);

  it('uses the no-reply address, then one assignableUsers per repository, then one commitAuthors per page', async () => {
    const github = harness.stub.github;
    const queries = github.graphqlQueries.length;
    github.history.commits.set(sha(12), maria.email);
    github.history.commits.set(sha(13), nikos.email);
    github.history.commits.set(sha(14), 'nobody@example.com');
    harness.settings[FORGE_SHOW_AVATARS_SETTING] = false;
    expect(await service.authorAvatars(githubRepo, [author(alexios, 10)], signal)).toEqual({});
    expect(github.avatarRequests()).toEqual([]);
    harness.settings[FORGE_SHOW_AVATARS_SETTING] = true;

    const first = await service.authorAvatars(githubRepo, [
      author(alexios, 10),
      { sha: sha(11), email: '1001+astefanopoulos@users.noreply.github.com', name: 'Alexios Stefanopoulos' },
      author(maria, 12),
      author(nikos, 13),
      { sha: sha(14), email: 'nobody@example.com', name: 'Nobody' },
      { sha: sha(15), email: 'admin@indigital.gr', name: 'Alexios (admin)' },
    ], signal);
    expect(first['1001+astefanopoulos@users.noreply.github.com']).toBe(avatarKey('github.com', 'https://avatars.githubusercontent.com/u/1001?s=64'));
    expect(first[alexios.email]).toBe(avatarKey('github.com', `${github.webUrl}/avatars/astefanopoulos.png`));
    // matched by display name among the assignable users, as VS Code does
    expect(first['admin@indigital.gr']).toBe(avatarKey('github.com', `${github.webUrl}/avatars/astef-admin.png`));
    expect(first[maria.email]).toBeDefined();
    expect(first[nikos.email]).toBeDefined();
    expect(first['nobody@example.com']).toBeUndefined();
    const asked = () => github.graphqlQueries.slice(queries);
    expect(asked().map((query) => query.name)).toEqual(['assignableUsers', 'commitAuthors']);
    expect(asked()[1]!.variables).toMatchObject({ owner: 'astefanopoulos', repo: 'damocles', c0: sha(12), c1: sha(13), c2: sha(14) });

    // nobody's commit has no GitHub user, which is kept; someone's is not on the server, which is not
    const page = [author(maria, 20), { sha: sha(21), email: 'someone@example.com', name: 'Someone' }, { sha: sha(22), email: 'nobody@example.com', name: 'Nobody' }];
    const second = await service.authorAvatars(githubRepo, page, signal);
    expect(second[maria.email]).toBe(first[maria.email]);
    expect(asked().map((query) => query.name)).toEqual(['assignableUsers', 'commitAuthors', 'commitAuthors']);
    expect(asked()[2]!.variables).toMatchObject({ c0: sha(21) });
    expect(Object.keys(asked()[2]!.variables).filter((name) => /^c\d+$/.test(name))).toEqual(['c0']);
    // once pushed, the same author is looked up again by that commit
    github.history.commits.set(sha(21), maria.email);
    expect(await service.authorAvatars(githubRepo, page, signal)).toMatchObject({ 'someone@example.com': first[maria.email] });
    expect(asked().map((query) => query.name)).toEqual(['assignableUsers', 'commitAuthors', 'commitAuthors', 'commitAuthors']);
    // the no-reply picture needed no request at all
    expect(github.avatarRequests().filter((request) => request.startsWith('GET'))).toEqual([]);
  });

  it('keeps a match by display name to its repository, so another repository looks the author up itself', async () => {
    const github = harness.stub.github;
    const queries = github.graphqlQueries.length;
    const other = repoOn(harness.stub.github.webUrl, 'astefanopoulos/other.git');
    const impostor = { sha: sha(60), email: 'impostor@example.com', name: 'Alexios (admin)' };
    expect(await service.authorAvatars(githubRepo, [impostor], signal)).toEqual({ 'impostor@example.com': avatarKey('github.com', `${github.webUrl}/avatars/astef-admin.png`) });
    await service.authorAvatars(other, [impostor], signal);
    // the other repository read its own assignable users rather than reuse the match (damocles' list is the hour's)
    expect(github.graphqlQueries.slice(queries).filter((query) => query.name === 'assignableUsers').map((query) => query.variables)).toEqual([expect.objectContaining({ repo: 'other' })]);
  });

  it('shares one assignable users read between pages, and the page that started it leaving ends only its own wait', async () => {
    const github = harness.stub.github;
    await freshService();
    const queries = github.graphqlQueries.length;
    const usersAsked = (): number => github.graphqlQueries.slice(queries).filter((query) => query.name === 'assignableUsers').length;
    let release!: () => void;
    github.history.holdUsers = () => new Promise<void>((resolve) => (release = resolve));
    const leaving = new AbortController();
    const first = service.authorAvatars(githubRepo, [{ sha: sha(70), email: 'admin@indigital.gr', name: 'Alexios (admin)' }], leaving.signal);
    await vi.waitFor(() => expect(usersAsked()).toBe(1));
    const second = service.authorAvatars(githubRepo, [{ sha: sha(71), email: 'other-admin@indigital.gr', name: 'Alexios (admin)' }], signal);
    // the read is held until release, so this only gives the second page time to join it
    await new Promise((resolve) => setTimeout(resolve, 100));
    leaving.abort();
    expect(await first).toEqual({});
    release();
    expect(Object.keys(await second)).toEqual(['other-admin@indigital.gr']);
    expect(usersAsked()).toBe(1);
  });

  it('answers {} and logs when the server does not answer, and never throws', async () => {
    harness.stub.github.unreachable = true;
    try {
      expect(await service.authorAvatars(githubRepo, [{ sha: sha(30), email: 'late@example.com', name: 'Late' }], signal)).toEqual({});
    } finally {
      harness.stub.github.unreachable = false;
    }
    expect(harness.logs.some((line) => line.includes('author pictures on github.com failed'))).toBe(true);
  });
});

describe('the merged change containing a commit', () => {
  beforeAll(freshService);
  const merged = HISTORY_FIXTURES.mergedChange;

  it('answers the merged merge request on GitLab and the merged pull request on GitHub, cached', async () => {
    const asked = harness.stub.gitlab.history.containingRequests;
    expect(await service.containingChange(gitlabRepo, sha(40), signal)).toEqual({ kind: 'mergeRequest', number: merged, serverName: 'gitlab.com' });
    expect(await service.containingChange(gitlabRepo, sha(40), signal)).toEqual({ kind: 'mergeRequest', number: merged, serverName: 'gitlab.com' });
    expect(harness.stub.gitlab.history.containingRequests).toBe(asked + 1);
    expect(await service.containingChange(githubRepo, sha(40), signal)).toEqual({ kind: 'pullRequest', number: merged, serverName: 'github.com' });
  });

  it('asks the server once for concurrent asks of one commit', async () => {
    const asked = harness.stub.gitlab.history.containingRequests;
    const answers = await Promise.all([1, 2, 3].map(() => service.containingChange(gitlabRepo, sha(44), signal)));
    expect(answers).toEqual([1, 2, 3].map(() => ({ kind: 'mergeRequest', number: merged, serverName: 'gitlab.com' })));
    expect(harness.stub.gitlab.history.containingRequests).toBe(asked + 1);
  });

  it('counts a commit GitHub does not have (422) as none for 5 minutes, then asks again', async () => {
    const github = harness.stub.github.history;
    github.unknownCommits.add(sha(45));
    const asked = github.containingRequests;
    expect(await service.containingChange(githubRepo, sha(45), signal)).toBeNull();
    expect(harness.logs.some((line) => line.includes('the merged change of a commit on github.com is unknown there'))).toBe(true);
    clock += 4 * 60_000;
    expect(await service.containingChange(githubRepo, sha(45), signal)).toBeNull();
    expect(github.containingRequests).toBe(asked + 1);
    github.unknownCommits.delete(sha(45));
    clock += 2 * 60_000;
    expect(await service.containingChange(githubRepo, sha(45), signal)).toMatchObject({ number: merged });
    expect(github.containingRequests).toBe(asked + 2);
  });

  it('answers null for an open-only change, for none and for a failure, which is logged and asked again', async () => {
    harness.stub.gitlab.history.containing.set(sha(41), [{ number: 44, state: 'opened' }]);
    expect(await service.containingChange(gitlabRepo, sha(41), signal)).toBeNull();
    harness.stub.gitlab.history.containing.set(sha(42), []);
    expect(await service.containingChange(gitlabRepo, sha(42), signal)).toBeNull();
    expect(await service.containingChange(gitlabRepo, 'HEAD', signal)).toBeNull();
    const asked = harness.stub.gitlab.history.containingRequests;
    harness.stub.gitlab.unreachable = true;
    try {
      expect(await service.containingChange(gitlabRepo, sha(43), signal)).toBeNull();
    } finally {
      harness.stub.gitlab.unreachable = false;
    }
    expect(harness.logs.some((line) => line.includes('the merged change of a commit on gitlab.com failed'))).toBe(true);
    expect(await service.containingChange(gitlabRepo, sha(43), signal)).toMatchObject({ number: merged });
    expect(harness.stub.gitlab.history.containingRequests).toBe(asked + 1);
  });
});
