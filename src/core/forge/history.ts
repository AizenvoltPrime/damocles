import { FULL_SHA } from '../../shared/forge/links';
import { MAX_AUTHOR_KEYS, MAX_HISTORY_AUTHORS, type AuthorAvatars, type ContainingChange, type HistoryAuthor, type HistoryForgeContext } from '../../shared/forge/history';
import { avatarKey } from './avatars';
import type { CiRepo, CiResolution } from './ci-watch';
import { assignableUsers, commitAuthorPictures, mergedPullRequest, noReplyAvatarUrl, noReplyUserId, type AssignableUser } from './providers/github/history';
import { avatarOfEmail, mergedMergeRequest } from './providers/gitlab/history';
import { repoOnServer } from './remote-url';
import { checkedRepoPath, type RepoContext } from './tools/api';
import { ForgeHttpError, GITHUB_COM, type ForgeServer } from './types';

// History details (docs/invariants.md "GitHub and GitLab accounts", history details): author pictures looked up once per
// history page and kept in memory per (server, email), a display name's match per (server, repository, email), misses
// included; the merged change containing a commit, on demand.
// Pictures are fetched only when main asks for a key (avatars.ts), so no lookup holds up the Graph's history.

const MAX_PICTURE_ENTRIES = 5000;
const PICTURE_TTL_MS = 24 * 60 * 60_000;
const MISS_TTL_MS = 60 * 60_000;
const USERS_TTL_MS = 60 * 60_000;
const MAX_USER_LISTS = 50;
const MAX_CONTAINING = 500;
const NONE_TTL_MS = 5 * 60_000;
// concurrent GET /avatar?email= of one page
const GITLAB_LOOKUPS = 4;
const MAX_PICTURE_URL_CHARS = 2048;

/** What a served author key stands for: the picture's URL and the account whose token its own server's origin gets. */
export interface AuthorPicture {
  readonly serverId: string;
  readonly url: string;
  readonly accountId: string;
}

export interface HistoryDetailsDeps {
  /** The servers with an account. */
  readonly servers: () => readonly ForgeServer[];
  /** The repository's server, path and account by the 'upstream' remote order, as context names it (index.ts ciResolve). */
  readonly resolve: (repo: CiRepo, signal: AbortSignal) => Promise<CiResolution>;
  readonly showAvatars: () => boolean;
  /** New author keys were issued; the forge mirror publishes them before the answer that names them leaves core. */
  readonly keysAdded: () => void;
  readonly log: (line: string) => void;
  readonly now?: () => number;
}

export interface HistoryDetails {
  /** The repository's server as history shows it; null when no remote is on a server with an account. */
  context(repo: CiRepo): HistoryForgeContext | null;
  /** One history page's author pictures by lower-cased email; {} when showAvatars is off, before any request. */
  avatars(repo: CiRepo, authors: readonly HistoryAuthor[], signal: AbortSignal): Promise<AuthorAvatars>;
  /** The merged pull or merge request containing sha; null for none, no account, or a failure (logged). */
  containing(repo: CiRepo, sha: string, signal: AbortSignal): Promise<ContainingChange | null>;
  /** The picture behind an author key core issued. */
  picture(key: string): AuthorPicture | undefined;
  /** The author keys main may serve; none while showAvatars is off. */
  keys(): readonly string[];
}

const errorName = (err: unknown): string => (err instanceof ForgeHttpError ? `${err.name} ${err.kind}` : err instanceof Error ? err.name : typeof err);

/** Only an absolute https address is a picture core may fetch. */
function pictureUrl(value: string | undefined): string | undefined {
  if (value === undefined || value.length > MAX_PICTURE_URL_CHARS || !URL.canParse(value)) return undefined;
  return new URL(value).protocol === 'https:' ? value : undefined;
}

// 'repository': the match holds only in the repository it was made in (a display name, which a commit author sets freely)
type Note = (email: string, url: string | undefined, scope?: 'repository') => void;

/** One read shared by concurrent callers under its own signal, aborted only once every caller that joined it left. */
interface SharedRead<T> {
  readonly result: Promise<T>;
  /** Whether every caller left before it settled, so it was aborted and a new caller must start another. */
  abandoned(): boolean;
  /** The read's answer, or this caller's own abort reason when signal aborts first. */
  join(signal: AbortSignal): Promise<T>;
}

function sharedRead<T>(start: (signal: AbortSignal) => Promise<T>): SharedRead<T> {
  const controller = new AbortController();
  const result = start(controller.signal);
  let settled = false;
  let waiting = 0;
  const done = (): void => {
    settled = true;
  };
  result.then(done, done);
  return {
    result,
    abandoned: () => controller.signal.aborted,
    join(signal) {
      if (signal.aborted) return Promise.reject(signal.reason);
      waiting++;
      return new Promise<T>((resolve, reject) => {
        let left = false;
        const leave = (): void => {
          if (left) return;
          left = true;
          waiting--;
          signal.removeEventListener('abort', onAbort);
        };
        const onAbort = (): void => {
          leave();
          if (waiting === 0 && !settled) controller.abort(signal.reason);
          reject(signal.reason);
        };
        signal.addEventListener('abort', onAbort, { once: true });
        result.then((value) => {
          leave();
          resolve(value);
        }, (err: unknown) => {
          leave();
          reject(err);
        });
      });
    },
  };
}

export function createHistoryDetails(deps: HistoryDetailsDeps): HistoryDetails {
  const now = deps.now ?? Date.now;
  const { log } = deps;
  // "<serverId>\0<email>", or "<serverId>\0<repoPath>\0<email>" for a match by display name → the picture, or a miss; Map order
  // is least recently used first. NUL never reaches an email (main refuses it) or a checked repository path.
  const pictures = new Map<string, { readonly url?: string; readonly at: number }>();
  const users = new Map<string, { readonly at: number; readonly read: SharedRead<AssignableUser[]> }>();
  const keys = new Map<string, AuthorPicture>();
  const containing = new Map<string, { readonly change: ContainingChange | null; readonly at: number }>();
  // a commit's merged change being read, by the containing key; concurrent asks of one commit share it
  const containingReads = new Map<string, SharedRead<ContainingChange | null>>();

  function touch<V>(map: Map<string, V>, key: string, value: V, max: number): void {
    map.delete(key);
    map.set(key, value);
    while (map.size > max) map.delete(map.keys().next().value!);
  }

  const pictureKey = (serverId: string, repoPath: string, email: string, scope?: 'repository'): string =>
    (scope === 'repository' ? `${serverId}\0${repoPath}\0${email}` : `${serverId}\0${email}`);

  function heldPicture(serverId: string, repoPath: string, email: string): { readonly url?: string } | undefined {
    for (const key of [pictureKey(serverId, repoPath, email, 'repository'), pictureKey(serverId, repoPath, email)]) {
      const held = pictures.get(key);
      if (!held || now() - held.at >= (held.url !== undefined ? PICTURE_TTL_MS : MISS_TTL_MS)) continue;
      touch(pictures, key, held, MAX_PICTURE_ENTRIES);
      return held;
    }
    return undefined;
  }

  /** The repository's assignable users, read once an hour and shared by concurrent pages. */
  function usersOf(ctx: RepoContext): Promise<AssignableUser[]> {
    const key = `${ctx.server.id}\0${ctx.repoPath}`;
    const held = users.get(key);
    if (held && !held.read.abandoned() && now() - held.at < USERS_TTL_MS) return held.read.join(ctx.signal);
    const read = sharedRead((signal) => assignableUsers({ ...ctx, signal }));
    touch(users, key, { at: now(), read }, MAX_USER_LISTS);
    read.result.catch(() => {
      // a failed read is not kept; its callers log it
      if (users.get(key)?.read === read) users.delete(key);
    });
    return read.join(ctx.signal);
  }

  async function lookUpGithub(ctx: RepoContext, pending: readonly HistoryAuthor[], note: Note): Promise<void> {
    const rest: HistoryAuthor[] = [];
    for (const author of pending) {
      const userId = ctx.server.id === GITHUB_COM ? noReplyUserId(author.email) : undefined;
      if (userId !== undefined) note(author.email, noReplyAvatarUrl(userId));
      else rest.push(author);
    }
    if (rest.length === 0) return;
    const known = await usersOf(ctx);
    const left: HistoryAuthor[] = [];
    for (const author of rest) {
      const byEmail = known.find((item) => item.email === author.email);
      const byName = byEmail ? undefined : known.find((item) => item.name !== undefined && item.name === author.name);
      if (byEmail) note(author.email, byEmail.avatarUrl);
      else if (byName) note(author.email, byName.avatarUrl, 'repository');
      else left.push(author);
    }
    if (left.length === 0) return;
    const byCommit = await commitAuthorPictures(ctx, left.map((author) => author.sha));
    // a commit the server lacks is not noted, so a later page asks again, perhaps with a pushed commit of that author
    for (const author of left) {
      const picture = byCommit.get(author.sha);
      if (picture !== undefined) note(author.email, picture ?? undefined);
    }
  }

  async function lookUpGitlab(ctx: RepoContext, pending: readonly HistoryAuthor[], note: Note): Promise<void> {
    let next = 0;
    let failure: { readonly err: unknown } | undefined;
    const worker = async (): Promise<void> => {
      while (failure === undefined && next < pending.length) {
        const author = pending[next++]!;
        try {
          note(author.email, await avatarOfEmail(ctx, author.email));
        } catch (err) {
          failure ??= { err };
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(GITLAB_LOOKUPS, pending.length) }, worker));
    if (failure) throw failure.err;
  }

  return {
    context(repo) {
      const found = repoOnServer(repo, deps.servers(), 'upstream');
      if (!found || checkedRepoPath(found.server.kind, found.repoPath) === undefined) return null;
      return { kind: found.server.kind, serverName: found.server.id, showAvatars: deps.showAvatars() };
    },

    async avatars(repo, authors, signal) {
      if (!deps.showAvatars()) return {};
      const byEmail = new Map<string, HistoryAuthor>();
      for (const author of authors.slice(0, MAX_HISTORY_AUTHORS)) {
        const email = author.email.trim().toLowerCase();
        if (email !== '' && FULL_SHA.test(author.sha) && !byEmail.has(email)) byEmail.set(email, { ...author, email });
      }
      if (byEmail.size === 0) return {};
      const resolution = await deps.resolve(repo, signal);
      if (resolution.kind === 'error') log(`[forge] author pictures of ${repo.project}: the account did not resolve`);
      if (resolution.kind !== 'target') return {};
      const { target } = resolution;
      const { server } = target;
      const found = new Map<string, string>();
      const pending: HistoryAuthor[] = [];
      for (const [email, author] of byEmail) {
        const held = heldPicture(server.id, target.repoPath, email);
        if (held === undefined) pending.push(author);
        else if (held.url !== undefined) found.set(email, held.url);
      }
      if (pending.length > 0) {
        const note: Note = (email, url, scope) => {
          const checked = pictureUrl(url);
          touch(pictures, pictureKey(server.id, target.repoPath, email, scope), { ...(checked !== undefined ? { url: checked } : {}), at: now() }, MAX_PICTURE_ENTRIES);
          if (checked !== undefined) found.set(email, checked);
        };
        try {
          await target.run((ctx) => (server.kind === 'github' ? lookUpGithub(ctx, pending, note) : lookUpGitlab(ctx, pending, note)), signal);
        } catch (err) {
          log(`[forge] author pictures on ${server.id} failed after ${found.size} of ${byEmail.size}: ${errorName(err)}`);
        }
      }
      // the setting went off while the lookups ran
      if (!deps.showAvatars()) return {};
      const answer: Record<string, string> = {};
      let added = false;
      for (const [email, url] of found) {
        const key = avatarKey(server.id, url);
        added ||= !keys.has(key);
        touch(keys, key, { serverId: server.id, url, accountId: target.accountId }, MAX_AUTHOR_KEYS);
        answer[email] = key;
      }
      if (added) deps.keysAdded();
      return answer;
    },

    async containing(repo, sha, signal) {
      if (!FULL_SHA.test(sha)) return null;
      const resolution = await deps.resolve(repo, signal);
      if (resolution.kind === 'error') log(`[forge] the merged change of a commit of ${repo.project}: the account did not resolve`);
      if (resolution.kind !== 'target') return null;
      const { target } = resolution;
      const key = `${target.server.id}\0${target.repoPath}\0${sha}`;
      const held = containing.get(key);
      if (held && (held.change !== null || now() - held.at < NONE_TTL_MS)) {
        touch(containing, key, held, MAX_CONTAINING);
        return held.change;
      }
      let read = containingReads.get(key);
      if (!read || read.abandoned()) {
        const started = sharedRead(async (readSignal): Promise<ContainingChange | null> => {
          let number: number | undefined;
          try {
            number = await target.run((ctx) => (target.server.kind === 'github' ? mergedPullRequest(ctx, sha) : mergedMergeRequest(ctx, sha)), readSignal);
          } catch (err) {
            if (readSignal.aborted) throw err;
            // a commit the server does not have yet (unpushed): GitHub answers 422, GitLab 404
            const unknown = err instanceof ForgeHttpError && (err.kind === 'notFound' || err.status === 422);
            log(`[forge] the merged change of a commit on ${target.server.id} ${unknown ? 'is unknown there' : 'failed'}: ${errorName(err)}`);
            if (!unknown) return null;
          }
          const change: ContainingChange | null = number !== undefined ? { kind: target.server.kind === 'github' ? 'pullRequest' : 'mergeRequest', number, serverName: target.serverName } : null;
          touch(containing, key, { change, at: now() }, MAX_CONTAINING);
          return change;
        });
        const forget = (): void => {
          if (containingReads.get(key) === started) containingReads.delete(key);
        };
        started.result.then(forget, forget);
        containingReads.set(key, started);
        read = started;
      }
      return read.join(signal);
    },

    picture: (key) => keys.get(key),

    keys: () => (deps.showAvatars() ? [...keys.keys()] : []),
  };
}
