import type { ForgeSignInRoute, ForgeSignInState } from '../../../shared/forge/accounts';
import { l } from '../../l10n';
import type { BindingStore } from '../bindings/binding-store';
import { ForgeFileBrokenError, type ForgeFile } from '../forge-file';
import type { ForgeHttp } from '../http';
import { runDeviceFlow } from '../oauth/device-flow';
import { signInWithToken } from '../oauth/token-sign-in';
import { runWebFlow } from '../oauth/web-flow';
import { gitlabVersion, oldGitLabText, supportedGitLabVersion } from '../providers/gitlab/user';
import { providerFor, type ForgeUser, type TokenGrant } from '../providers/provider';
import type { ServerRegistry } from '../servers';
import { ForgeHttpError, ForgeSignInError, type AccountRecord, type ForgeServer, type TokenSet } from '../types';
import { makeAccountId, MAX_ACCOUNT_TEXT, type AccountsFile } from './account-store';
import type { Refresher } from './refresh';
import type { TokenStore } from './token-store';

// Sign-in, sign-out and the account records (docs/invariants.md "GitHub and GitLab accounts").

export interface AccountsDeps {
  readonly store: ForgeFile<AccountsFile>;
  readonly tokens: TokenStore;
  readonly bindings: BindingStore;
  readonly servers: ServerRegistry;
  readonly http: ForgeHttp;
  readonly refresher: Refresher;
  readonly openExternal: (url: string) => Promise<boolean>;
  readonly log: (line: string) => void;
  readonly now: () => number;
  /** Waits ms, rejecting when signal aborts; the device flow's poll interval. */
  readonly sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

export interface SignInRequest {
  readonly serverId: string;
  readonly route: ForgeSignInRoute;
  readonly token?: string;
  readonly agentShells: boolean;
  readonly reauthAccountId?: string;
  readonly signal: AbortSignal;
  readonly onState: (state: ForgeSignInState) => void;
  /** The page the browser route opened, which "Open the page again" opens. */
  readonly onPage?: (url: string) => void;
}

export interface SignedIn {
  readonly account: AccountRecord;
  readonly server: ForgeServer;
}

export interface SignOutResult {
  readonly account: AccountRecord;
  /** Set when the token could not be revoked by API: the page where the user revokes it. */
  readonly revokePage?: string;
}

export interface Accounts {
  list(): readonly AccountRecord[];
  get(accountId: string): AccountRecord | undefined;
  signIn(request: SignInRequest): Promise<SignedIn>;
  signOut(accountId: string): Promise<SignOutResult>;
  setAgentShells(accountId: string, agentShells: boolean): Promise<void>;
  /** Marks the account "Sign in again", in accounts.json while it parses; the caller holds the account's chain. */
  markNeedsSignIn(accountId: string): Promise<void>;
}

function errorKind(err: unknown): string {
  return err instanceof ForgeHttpError ? err.kind : err instanceof Error ? err.name : typeof err;
}

/** Throws ForgeFileBrokenError when one of the files a change writes did not parse in this run. */
export function assertWritable(...files: readonly ForgeFile<unknown>[]): void {
  const broken = files.find((file) => file.broken());
  if (broken) throw new ForgeFileBrokenError(broken.filePath);
}

/** An account another view signed out before this change reached core. */
const goneAccount = (): ForgeSignInError => new ForgeSignInError('provider', l('This account is no longer signed in.'));

export function createAccounts(deps: AccountsDeps): Accounts {
  const { store, tokens, servers, http } = deps;

  function serverOf(serverId: string): ForgeServer {
    const server = servers.get(serverId);
    if (!server) throw new ForgeSignInError('provider', l('This server is no longer in the list.'));
    return server;
  }

  // version: the server's, where the route read it (GitLab's, for its floor)
  async function runRoute(request: SignInRequest, server: ForgeServer, reauth: AccountRecord | undefined): Promise<{ user: ForgeUser; grant: TokenGrant; version?: string }> {
    const provider = providerFor(server.kind);
    const { signal, onState } = request;
    if (request.route === 'token') {
      onState({ phase: 'finishing' });
      return signInWithToken(http, server, provider, request.token ?? '');
    }
    const client = server.oauth!;
    const grant = request.route === 'browser'
      ? await runWebFlow({ http, openExternal: deps.openExternal, log: deps.log, now: deps.now }, server, provider, {
        client,
        ...(reauth && server.kind === 'github' ? { login: reauth.login } : {}),
        signal,
        onWaiting: (url) => {
          request.onPage?.(url);
          onState({ phase: 'browser' });
        },
      })
      : await runDeviceFlow({ http, log: deps.log, now: deps.now, ...(deps.sleep ? { sleep: deps.sleep } : {}) }, server, provider, {
        client,
        signal,
        onCode: (code) => onState({ phase: 'deviceCode', ...code }),
      });
    onState({ phase: 'finishing' });
    try {
      const user = await provider.currentUser(http, server, grant.tokens.access);
      if (server.kind !== 'gitlab') return { user, grant };
      const { version } = await gitlabVersion(http, server, grant.tokens.access);
      if (version !== undefined && !supportedGitLabVersion(version)) throw new ForgeSignInError('provider', oldGitLabText(version));
      return { user, grant, ...(version !== undefined ? { version } : {}) };
    } catch (err) {
      await discardGrant(server, grant);
      throw err;
    }
  }

  /** Best effort: a fresh OAuth grant Damocles does not keep is revoked, so it does not stay live on the server. */
  async function discardGrant(server: ForgeServer, grant: TokenGrant): Promise<void> {
    if (grant.tokens.tokenType !== 'oauth') return;
    try {
      if (!(await providerFor(server.kind).revoke(http, server, server.oauth, grant.tokens))) deps.log(`[forge] ${server.id} cannot revoke a discarded grant by API`);
    } catch (err) {
      deps.log(`[forge] revoking a discarded ${server.id} grant failed: ${errorKind(err)}`);
    }
  }

  async function upsert(server: ForgeServer, user: ForgeUser, grant: TokenGrant, request: SignInRequest): Promise<AccountRecord> {
    const id = makeAccountId(server.id, user.id);
    const previousRecord = store.value().accounts.find((account) => account.id === id);
    const record: AccountRecord = {
      id,
      serverId: server.id,
      userId: user.id,
      login: user.login,
      ...(user.name !== undefined ? { name: user.name } : {}),
      ...(user.avatarUrl !== undefined ? { avatarUrl: user.avatarUrl } : {}),
      auth: request.route,
      scopes: grant.scopes.filter((scope) => scope !== '' && scope.length <= MAX_ACCOUNT_TEXT),
      // only Sign in again of this account changes the switch; any other sign-in landing on it keeps the user's choice
      agentShells: previousRecord !== undefined && request.reauthAccountId !== id ? previousRecord.agentShells : request.agentShells,
      ...(request.route !== 'token' && server.oauth ? { clientId: server.oauth.clientId } : {}),
      addedAt: deps.now(),
    };
    // on the account's chain: a refresh of the replaced set cannot store it over the new one
    await deps.refresher.exclusive(record, server, async () => {
      if (servers.get(server.id) === undefined) throw new ForgeSignInError('provider', l('This server is no longer in the list.'));
      const previous = await tokens.get(id);
      // the secret lands before the record names it
      await tokens.set(id, grant.tokens);
      try {
        // a sign-in to an account already here keeps its place in the list
        await store.update((current) => ({
          version: 1,
          accounts: current.accounts.some((account) => account.id === id) ? current.accounts.map((account) => (account.id === id ? record : account)) : [...current.accounts, record],
        }));
      } catch (err) {
        try {
          if (previous) await tokens.set(id, previous);
          else await tokens.delete(id);
        } catch (rollbackErr) {
          deps.log(`[forge] restoring ${id}'s secret after a failed write failed: ${errorKind(rollbackErr)}`);
        }
        throw err;
      }
      if (previous?.tokenType === 'oauth' && previous.access !== grant.tokens.access) await revokeReplaced(server, previousRecord, previous);
    });
    return record;
  }

  /** A sign-in replaced a live OAuth token set: its access token is revoked through the app's revoke endpoint. */
  async function revokeReplaced(server: ForgeServer, previous: AccountRecord | undefined, held: TokenSet): Promise<void> {
    const clientId = previous?.clientId ?? server.oauth?.clientId;
    const client = server.oauth && server.oauth.clientId === clientId ? server.oauth : undefined;
    try {
      if (!(await providerFor(server.kind).revoke(http, server, client, held))) deps.log(`[forge] ${server.id} cannot revoke a replaced token by API`);
    } catch (err) {
      deps.log(`[forge] revoking a replaced ${server.id} token failed: ${errorKind(err)}`);
    }
  }

  async function revoke(account: AccountRecord, server: ForgeServer, token: () => Promise<string>): Promise<string | undefined> {
    const provider = providerFor(server.kind);
    const held = await tokens.get(account.id);
    const clientId = held?.tokenType === 'oauth' ? account.clientId ?? server.oauth?.clientId : undefined;
    const page = provider.revokePage(server, clientId);
    if (!held) return page;
    const client = server.oauth && server.oauth.clientId === clientId ? server.oauth : undefined;
    try {
      const access = held.tokenType === 'oauth' ? await token() : held.access;
      return (await provider.revoke(http, server, client, { ...held, access })) ? undefined : page;
    } catch (err) {
      deps.log(`[forge] ${account.id} revoke failed: ${errorKind(err)}`);
      return page;
    }
  }

  return {
    list: () => store.value().accounts,
    get: (accountId) => store.value().accounts.find((account) => account.id === accountId),

    async signIn(request) {
      assertWritable(store);
      const server = serverOf(request.serverId);
      const availability = servers.routes(server)[request.route];
      if (availability.reason !== undefined) throw new ForgeSignInError('provider', availability.reason);
      const reauth = request.reauthAccountId !== undefined ? store.value().accounts.find((account) => account.id === request.reauthAccountId && account.serverId === server.id) : undefined;
      const { user, grant, version } = await runRoute(request, server, reauth);
      let account: AccountRecord;
      try {
        if (request.signal.aborted) throw new ForgeSignInError('cancelled', l('Sign-in cancelled.'));
        // the access check and branch protection read the version, and may run as soon as the sign-in settles
        if (version !== undefined && !server.builtIn) await servers.recordVersion(server.id, { version }, deps.now());
        account = await upsert(server, user, grant, request);
      } catch (err) {
        await discardGrant(server, grant);
        throw err;
      }
      deps.log(`[forge] signed in ${account.id} on ${server.id} by ${request.route}`);
      return { account, server: servers.get(server.id) ?? server };
    },

    async signOut(accountId) {
      const account = store.value().accounts.find((item) => item.id === accountId);
      if (!account) throw goneAccount();
      assertWritable(store, deps.bindings.file);
      const server = servers.get(account.serverId);
      let revokePage: string | undefined;
      if (server) {
        // no refresh may store a rotated set between the revoke and the delete
        revokePage = await deps.refresher.exclusive(account, server, async (token) => {
          const page = await revoke(account, server, token);
          await tokens.delete(account.id);
          return page;
        });
      } else {
        deps.log(`[forge] ${account.id}'s server is not in servers.json; its token is deleted without a revoke`);
        await tokens.delete(account.id);
      }
      await store.update((current) => ({ version: 1, accounts: current.accounts.filter((item) => item.id !== accountId) }));
      await deps.bindings.removeAccount(accountId);
      deps.log(`[forge] signed out ${account.id}${revokePage !== undefined ? '; its token was not revoked' : ''}`);
      return { account, ...(revokePage !== undefined ? { revokePage } : {}) };
    },

    async setAgentShells(accountId, agentShells) {
      if (!store.value().accounts.some((account) => account.id === accountId)) throw goneAccount();
      await store.update((current) => ({ version: 1, accounts: current.accounts.map((account) => (account.id === accountId ? { ...account, agentShells } : account)) }));
    },

    async markNeedsSignIn(accountId) {
      const account = store.value().accounts.find((item) => item.id === accountId);
      if (!account || account.needsSignIn === true || store.broken()) return;
      const at = deps.now();
      await store.update((current) => ({ version: 1, accounts: current.accounts.map((item) => (item.id === accountId ? { ...item, needsSignIn: true, needsSignInAt: at } : item)) }));
    },
  };
}
