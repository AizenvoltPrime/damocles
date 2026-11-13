import { randomBytes } from 'node:crypto';
import * as path from 'node:path';
import { cloneAddressOf, isRemoteUrl } from '../../shared/clone-address';
import type { CloneAccount, CloneAccountsView, ClonePasteAnswer, CloneProtocol, CloneRow, CloneSearchError, CloneSource } from '../../shared/forge/clone';
import { MAX_CLONE_PASTE_CHARS, MAX_CLONE_QUERY_CHARS } from '../../shared/forge/clone';
import type { LocalizedText } from '../../shared/localized-text';
import { boundedVisible, visibleText } from '../../shared/visible-text';
import { l } from '../l10n';
import { redactUrls } from '../scm/errors';
import { checkedCloneUrl, githubSearchRepos, listingErrorOf, githubUserRepos, gitlabProjects, matchesQuery, type ListedRepo, type ListingContext } from './clone-sources';
import type { ForgeHttp } from './http';
import { locationOf, matchServer, parseRemoteUrl, type ParsedRemoteUrl, type ServerMatch } from './remote-url';
import { ForgeHttpError, type AccountRecord, type ForgeServer } from './types';

// The clone picker's core side (docs/invariants.md "GitHub and GitLab accounts", clone picker): listings per account, opaque
// row keys, and the clone URL each key stands for, which main asks for on Enter and the overlay never sees.

const MAX_KEYS = 2000;
const LISTING_TTL_MS = 60_000;
const MAX_REFUSED_TEXT_CHARS = 200;

export type CloneSearchOutcome = { readonly rows: readonly CloneRow[] } | { readonly error: CloneSearchError };

/** What main clones: the URL, the account preset and bound when known, and the polite status shown before the folder pick. */
export type CloneTarget =
  | { readonly ok: true; readonly url: string; readonly account?: { readonly serverId: string; readonly accountId: string }; readonly status: LocalizedText }
  | { readonly ok: false; readonly reason: LocalizedText };

export interface ClonePickerDeps {
  readonly servers: () => readonly ForgeServer[];
  readonly accounts: () => readonly AccountRecord[];
  /** Settles once the forge files were read: true, or false when reading them failed. */
  readonly loaded: () => Promise<boolean>;
  readonly http: ForgeHttp;
  readonly withToken: <T>(account: AccountRecord, server: ForgeServer, run: (token: string) => Promise<T>) => Promise<T>;
  readonly needsSignIn: (account: AccountRecord) => boolean;
  readonly avatarKey: (account: AccountRecord) => string | undefined;
  readonly protocol: () => CloneProtocol;
  readonly log: (line: string) => void;
  readonly now: () => number;
}

export interface ClonePicker {
  /** Waits for the forge files, so a core still reading them never answers that there is no account. */
  accounts(): Promise<CloneAccountsView>;
  search(accountId: string, query: string, signal: AbortSignal): Promise<CloneSearchOutcome>;
  paste(text: string): ClonePasteAnswer;
  target(source: CloneSource): CloneTarget;
  /** The account signed out: its listing and keys go. */
  forgetAccount(accountId: string): void;
}

interface KeyEntry {
  readonly accountId: string;
  readonly repo: ListedRepo;
}

// at least one character after `://`, so `https://` alone, as it is typed, is no address yet
const SCHEME_URL = /^[a-z][a-z0-9+.-]*:\/\/./i;

/**
 * Pasted text as a repository address: an https or ssh remote with a path, another scheme URL, or an absolute folder, with a
 * leading "git clone" dropped; undefined for anything else, which the picker searches for instead.
 */
function pastedUrl(text: string): { readonly url: string; readonly parsed?: ParsedRemoteUrl } | undefined {
  if (text.length > MAX_CLONE_PASTE_CHARS) return undefined;
  const url = cloneAddressOf(text);
  if (!isRemoteUrl(url)) return undefined;
  const parsed = parseRemoteUrl(url);
  // `https:` as it is typed reads as the scp-like host "https" with no path
  if (parsed) return parsed.path === '' ? undefined : { url, parsed };
  return SCHEME_URL.test(url) || path.posix.isAbsolute(url) || path.win32.isAbsolute(url) ? { url } : undefined;
}

/** How a clone with a preset account reaches git: the account's token over https, the user's own SSH keys over ssh. */
function presetStatus(repoPath: string, login: string, serverId: string, protocol: CloneProtocol): LocalizedText {
  return protocol === 'ssh'
    ? l('Cloning {0} from {1} with your SSH keys. Choose a folder next; the new project uses {2} on {1}.', repoPath, serverId, login)
    : l('Cloning {0} as {1} on {2}. Choose a folder next; the new project uses this account.', repoPath, login, serverId);
}

interface ReadPaste {
  readonly url: string;
  readonly parsed?: ParsedRemoteUrl;
  readonly match?: ServerMatch<ForgeServer>;
  /** The URL's server has exactly one account and it need not sign in again: the clone is preset to it and binds it. */
  readonly preset?: { readonly account: AccountRecord; readonly server: ForgeServer };
}

export function createClonePicker(deps: ClonePickerDeps): ClonePicker {
  const keys = new Map<string, KeyEntry>();
  const listings = new Map<string, { readonly at: number; readonly repos: readonly ListedRepo[] }>();

  const usable = (): { account: AccountRecord; server: ForgeServer }[] => {
    const byId = new Map(deps.servers().map((server) => [server.id, server]));
    return deps.accounts().flatMap((account) => {
      const server = byId.get(account.serverId);
      return server ? [{ account, server }] : [];
    });
  };

  // each server with an account once: matchServer reads two entries of one server as two servers claiming its host
  const managedServers = (): ForgeServer[] => {
    const withAccounts = new Set(deps.accounts().map((account) => account.serverId));
    return deps.servers().filter((server) => withAccounts.has(server.id));
  };

  // several accounts, or one that must sign in again, preset nothing: the clone resolves and may ask once, as Git: Clone does
  function readPaste(text: string): ReadPaste | undefined {
    const pasted = pastedUrl(text);
    if (!pasted) return undefined;
    const match = pasted.parsed ? matchServer(locationOf(pasted.parsed), managedServers()) : undefined;
    if (!match) return pasted;
    const onServer = usable().filter((item) => item.server.id === match.server.id);
    const only = onServer.length === 1 ? onServer[0]! : undefined;
    return { ...pasted, match, ...(only && !deps.needsSignIn(only.account) ? { preset: only } : {}) };
  }

  // host[:port]/path without userinfo, or the redacted local path or URL, each with its hidden characters escaped
  const shownAddress = (read: ReadPaste): string =>
    read.parsed ? visibleText(`${read.parsed.host}${read.parsed.port !== undefined ? `:${read.parsed.port}` : ''}/${read.parsed.path}`) : visibleText(redactUrls(read.url));

  function issue(accountId: string, repo: ListedRepo): CloneRow {
    const key = randomBytes(12).toString('base64url');
    keys.set(key, { accountId, repo });
    while (keys.size > MAX_KEYS) keys.delete(keys.keys().next().value!);
    const cut = repo.path.lastIndexOf('/');
    return {
      key,
      namespace: repo.path.slice(0, cut),
      name: repo.path.slice(cut + 1),
      ...(repo.description !== undefined ? { description: repo.description } : {}),
      visibility: repo.visibility,
      ...(repo.pill !== undefined ? { pill: repo.pill } : {}),
      ...(repo.updatedAt !== undefined ? { updatedAt: repo.updatedAt } : {}),
    };
  }

  async function githubListing(ctx: ListingContext, accountId: string, fresh: boolean): Promise<readonly ListedRepo[]> {
    const held = listings.get(accountId);
    if (!fresh && held && deps.now() - held.at < LISTING_TTL_MS) return held.repos;
    const repos = await githubUserRepos(ctx);
    listings.set(accountId, { at: deps.now(), repos });
    return repos;
  }

  async function list(account: AccountRecord, server: ForgeServer, query: string, signal: AbortSignal): Promise<readonly ListedRepo[]> {
    return deps.withToken(account, server, async (token) => {
      const ctx: ListingContext = { http: deps.http, server, token, signal };
      if (server.kind === 'gitlab') return gitlabProjects(ctx, query);
      if (query.trim() === '') return githubListing(ctx, account.id, true);
      // the recent listing filtered here, then the server's search for what it does not hold (VS Code's getRemoteSources)
      const [listed, found] = await Promise.allSettled([githubListing(ctx, account.id, false), githubSearchRepos(ctx, query, account.login)]);
      if (listed.status === 'rejected') throw listed.reason;
      // GitHub's search has its own rate limit: a limited search leaves the filtered listing to answer alone
      if (found.status === 'rejected') {
        if (!(found.reason instanceof ForgeHttpError && found.reason.kind === 'rateLimited')) throw found.reason;
        deps.log(`[forge] searching ${account.id}'s repositories was rate-limited; the recent listing answers alone`);
      }
      const merged = new Map<string, ListedRepo>();
      for (const repo of [...listed.value.filter((item) => matchesQuery(item, query)), ...(found.status === 'fulfilled' ? found.value : [])]) if (!merged.has(repo.path)) merged.set(repo.path, repo);
      return [...merged.values()];
    });
  }

  return {
    async accounts() {
      if (!(await deps.loaded())) return { empty: 'notLoaded' };
      const listed = usable();
      if (listed.length === 0) return { empty: 'noAccount' };
      return {
        accounts: listed.map(({ account, server }): CloneAccount => {
          const avatarKey = deps.avatarKey(account);
          return { accountId: account.id, login: account.login, serverId: server.id, serverName: server.id, kind: server.kind, ...(avatarKey !== undefined ? { avatarKey } : {}), needsSignIn: deps.needsSignIn(account) };
        }),
        protocol: deps.protocol(),
      };
    },

    async search(accountId, query, signal) {
      if (query.length > MAX_CLONE_QUERY_CHARS) throw new Error('The clone search query is too long');
      const found = usable().find((item) => item.account.id === accountId);
      // signed out since the picker listed it
      if (!found) return { error: 'signInAgain' };
      const { account, server } = found;
      if (deps.needsSignIn(account)) return { error: 'signInAgain' };
      try {
        const repos = await list(account, server, query, signal);
        return { rows: repos.map((repo) => issue(account.id, repo)) };
      } catch (err) {
        if (signal.aborted || !(err instanceof ForgeHttpError)) throw err;
        deps.log(`[forge] listing ${account.id}'s repositories failed: ${err.kind}`);
        return { error: listingErrorOf(err) };
      }
    },

    paste(text) {
      const read = readPaste(text);
      if (!read) return { row: null };
      return {
        row: {
          displayPath: shownAddress(read),
          ...(read.parsed ? { protocol: read.parsed.protocol } : {}),
          ...(read.match ? { serverName: read.match.server.id } : {}),
          ...(read.preset ? { login: read.preset.account.login } : {}),
        },
      };
    },

    target(source) {
      if ('pasteText' in source) {
        const read = readPaste(source.pasteText);
        if (!read) return { ok: false, reason: l('"{0}" is not a repository URL Damocles can use.', boundedVisible(redactUrls(source.pasteText.trim()), MAX_REFUSED_TEXT_CHARS)) };
        const shown = read.match ? visibleText(read.match.repoPath) : shownAddress(read);
        if (read.preset && read.parsed) {
          const { account, server } = read.preset;
          return { ok: true, url: read.url, account: { serverId: server.id, accountId: account.id }, status: presetStatus(shown, account.login, server.id, read.parsed.protocol) };
        }
        return { ok: true, url: read.url, status: l('Cloning {0}. Choose a folder next.', shown) };
      }
      const entry = keys.get(source.key);
      if (!entry || entry.accountId !== source.accountId) return { ok: false, reason: l('This repository is no longer listed. Search again.') };
      const found = usable().find((item) => item.account.id === entry.accountId);
      if (!found) return { ok: false, reason: l('The account that listed this repository is signed out.') };
      const { account, server } = found;
      if (deps.needsSignIn(account)) return { ok: false, reason: l('Sign in again to {0} as {1} to clone this repository.', server.id, account.login) };
      const protocol = deps.protocol();
      // checked again: the server's git hosts may have changed since the listing
      const url = checkedCloneUrl(server, protocol === 'ssh' ? entry.repo.sshUrl : entry.repo.httpsUrl, entry.repo.path);
      if (url === undefined) return { ok: false, reason: l('{0} gave no {1} clone address on its own hosts for {2}.', server.id, protocol, entry.repo.path) };
      return { ok: true, url, account: { serverId: server.id, accountId: account.id }, status: presetStatus(entry.repo.path, account.login, server.id, protocol) };
    },

    forgetAccount(accountId) {
      listings.delete(accountId);
      for (const [key, entry] of keys) if (entry.accountId === accountId) keys.delete(key);
    },
  };
}
