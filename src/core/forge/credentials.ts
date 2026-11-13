// The git credential answer policy (docs/invariants.md "GitHub and GitLab accounts", answer policy): which account
// answers git's get, and what happens to its store and erase, per origin.
import { createHash, timingSafeEqual } from 'node:crypto';
import { CONSENTED_HOWS, type ResolveHow } from '../../shared/forge/bindings';
import type { GitCredentialAnswer, GitCredentialOrigin, GitCredentialRequest } from '../../shared/git-credential';
import { english } from '../l10n';
import type { BindingStore } from './bindings/binding-store';
import { resolveWithoutAccess, type Settled } from './bindings/resolve';
import type { Delegator } from './delegate';
import { ANSWERED_WINDOW_MS, type KnownSecrets } from './known-secrets';
import { locateServer, usernameHintOf } from './remote-url';
import type { AccountRecord, ForgeServer, TokenSet } from './types';

/** Why an agent shell got no credential: its account's switch is off, or no account resolved. */
export type ShellRefusalReason = 'agentShellsOff' | 'noAccount';

/** An agent shell's refusal, for the refused notice in its chat. */
export interface ShellRefusal {
  readonly origin: Extract<GitCredentialOrigin, { kind: 'agentShell' }>;
  readonly server: ForgeServer;
  readonly projectKey?: string;
  readonly account?: AccountRecord;
  readonly reason: ShellRefusalReason;
}

/** The Choose account dialog asked for this request: an account, Git's own credentials, or no choice. */
export type CredentialChoice =
  | { readonly kind: 'account'; readonly account: AccountRecord }
  | { readonly kind: 'own' }
  | { readonly kind: 'cancelled' }
  | { readonly kind: 'signInAnother' };

export interface CredentialPolicyDeps {
  readonly servers: () => readonly ForgeServer[];
  readonly accounts: () => readonly AccountRecord[];
  readonly bindings: BindingStore;
  /** The access check's one pick (push, else read) among accounts that need no sign-in; undefined when none stands alone. */
  readonly pickByAccess: (accounts: readonly AccountRecord[], server: ForgeServer, repoPath: string, signal: AbortSignal) => Promise<AccessPick | undefined>;
  /** The Choose account dialog for this request; the choice is bound to projectKey when there is one. */
  readonly ask: (input: { readonly projectKey?: string; readonly authorityKey: string; readonly server: ForgeServer; readonly repoPath: string; readonly accounts: readonly AccountRecord[] }, signal: AbortSignal) => Promise<CredentialChoice>;
  /** A live access token, refreshed first when due; rejects when the account must sign in again. */
  readonly token: (account: AccountRecord, server: ForgeServer) => Promise<TokenSet>;
  /** erase of an answered token: GET /user; on a 401 a refresh; a failed refresh marks the account "Sign in again". */
  readonly verify: (account: AccountRecord, server: ForgeServer) => Promise<void>;
  /** This computer's delegation; requests from another computer are answered delegate instead. */
  readonly delegator: Delegator;
  /** The project of authorityKey whose repository has a remote on server at repoPath; with several, the one holding cwd. */
  readonly projectByRemote: (authorityKey: string, server: ForgeServer, repoPath: string, cwd: string, signal: AbortSignal) => Promise<string | undefined>;
  /** The project of authorityKey holding cwd. */
  readonly projectHolding: (authorityKey: string, cwd: string) => string | undefined;
  readonly refused: (refusal: ShellRefusal) => void;
  readonly secrets: KnownSecrets;
  readonly log: (line: string) => void;
  readonly now: () => number;
}

/** The access check's pick and whether it can push (else it can read). */
export interface AccessPick {
  readonly account: AccountRecord;
  readonly canPush: boolean;
}

export interface CredentialContext {
  /** 'local' for this computer's helpers; a target's authority for a relayed request, which never delegates here. */
  readonly authorityKey: string;
  /** A relayed request's project, as main mapped the target's folder to one of the host's projects. */
  readonly projectKey?: string;
  /** The account the user let a target's request use, set only by main after its consent dialog. */
  readonly consentedAccountId?: string;
}

/** Whose credential it is and how it was settled; canPush only with how 'access'. */
export interface CredentialAccount {
  readonly serverId: string;
  readonly accountId: string;
  readonly login: string;
  readonly how: ResolveHow;
  readonly canPush?: boolean;
}

/** An answer for git, or, for a target's automatic resolution, the account the user must consent to first. */
export type CredentialResult =
  | { readonly answer: GitCredentialAnswer; readonly account?: CredentialAccount }
  | { readonly consent: CredentialAccount };

export interface CredentialPolicy {
  answer(request: GitCredentialRequest, origin: GitCredentialOrigin, context: CredentialContext, signal: AbortSignal): Promise<CredentialResult>;
}

const sha256 = (text: string): Buffer => createHash('sha256').update(text, 'utf8').digest();

function hashMatches(held: Buffer, named: string | undefined): boolean {
  if (named === undefined || !/^[0-9a-f]{64}$/.test(named)) return false;
  return timingSafeEqual(held, Buffer.from(named, 'hex'));
}

/** git's path as a remote path: up to and with the first `.git` segment (LFS asks under <repo>.git/info/lfs). */
function repositoryPath(path: string | undefined): string {
  if (path === undefined) return '';
  const segments = path.split('/').filter((segment) => segment !== '');
  const end = segments.findIndex((segment) => segment.endsWith('.git'));
  return (end < 0 ? segments : segments.slice(0, end + 1)).join('/');
}

/** The managed server a request names by protocol, host, port and path prefix, and the repository path when it parses. */
export function serverOfRequest(fields: GitCredentialRequest['fields'], servers: readonly ForgeServer[]): { readonly server: ForgeServer; readonly repoPath?: string } | undefined {
  if (fields.protocol !== 'https') return undefined;
  const hostPort = /^(.+?)(?::(\d{1,5}))?$/.exec(fields.host.toLowerCase());
  if (!hostPort) return undefined;
  const port = hostPort[2] !== undefined && hostPort[2] !== '443' ? Number(hostPort[2]) : undefined;
  const path = repositoryPath(fields.path);
  // a path git did not send, or one naming no repository, still maps to the server by host and the longest prefix
  return locateServer({ protocol: 'https', host: hostPort[1]!, ...(port !== undefined ? { port } : {}), path, aliasResolved: false }, servers);
}

/** The refusal git prints for an agent shell whose account's switch is off; it names the switch. */
export function agentShellsOffMessage(login: string, server: string): string {
  return english('Damocles refused git credentials for {0} on {1} to this agent shell. Turn on "Agent shells may use this account" in Settings › Models & accounts › Git hosting to allow it.', login, server);
}

export function noAccountMessage(server: string): string {
  return english('Damocles has no account chosen for {0} in this project, so this agent shell gets no git credentials. Choose one in the chat.', server);
}

export function createCredentialPolicy(deps: CredentialPolicyDeps): CredentialPolicy {
  // the SHA-256 of each token answered and of each credential the user's helpers gave, for the store and erase that follow
  const answeredTokens = new Map<string, { readonly hash: Buffer; readonly accountId: string; readonly until: number }>();
  const delegated = new Map<string, { readonly hash: Buffer; readonly until: number }>();
  const keyOf = (request: GitCredentialRequest, originKey: string): string => JSON.stringify([originKey, request.fields.protocol, request.fields.host.toLowerCase(), repositoryPath(request.fields.path)]);
  const originKeyOf = (origin: GitCredentialOrigin, context: CredentialContext): string => JSON.stringify([context.authorityKey, origin]);
  const expire = (): void => {
    const now = deps.now();
    for (const [key, entry] of answeredTokens) if (entry.until <= now) answeredTokens.delete(key);
    for (const [key, entry] of delegated) if (entry.until <= now) delegated.delete(key);
  };

  const accountOf = (account: AccountRecord, how: ResolveHow, canPush: boolean | undefined): CredentialAccount =>
    ({ serverId: account.serverId, accountId: account.id, login: account.login, how, ...(canPush !== undefined ? { canPush } : {}) });

  // git prints it in a terminal and to the agent, so it is English as the model reads it
  const refusal = (message: string): CredentialResult => ({ answer: { kind: 'refused', message } });

  const delegate = async (request: GitCredentialRequest, origin: GitCredentialOrigin, context: CredentialContext, signal: AbortSignal): Promise<CredentialResult> => {
    if (context.authorityKey !== 'local') return { answer: { kind: 'delegate' } };
    const interactive = origin.kind === 'terminal' || (origin.kind === 'engine' && origin.interactive);
    const agentShell = origin.kind === 'agentShell';
    const filled = await deps.delegator.run({ op: request.op, cwd: request.cwd, fields: request.fields, ...(request.password !== undefined ? { password: request.password } : {}), interactive, agentShell }, signal);
    if (request.op !== 'get') return { answer: { kind: 'none' } };
    if (!filled) return { answer: { kind: 'none' } };
    // the agent's shell prints what git is given, so the user's own password is masked there as a token is
    if (agentShell) deps.secrets.answered(filled.password, deps.now());
    delegated.set(keyOf(request, originKeyOf(origin, context)), { hash: sha256(filled.password), until: deps.now() + ANSWERED_WINDOW_MS });
    return { answer: { kind: 'credential', ...filled } };
  };

  const answerWith = async (account: AccountRecord, server: ForgeServer, how: ResolveHow, canPush: boolean | undefined, request: GitCredentialRequest): Promise<CredentialResult> => {
    let tokens: TokenSet;
    try {
      tokens = await deps.token(account, server);
    } catch {
      deps.log(`[forge] ${account.id} must sign in again, so git got no credential for ${server.id}`);
      return refusal(english('{0} on {1} must sign in again. Sign in in Settings › Models & accounts › Git hosting, then try again.', account.login, server.id));
    }
    // a GitLab OAuth token authenticates git as oauth2; a personal or GitHub token with the login
    const username = server.kind === 'gitlab' && tokens.tokenType === 'oauth' ? 'oauth2' : account.login;
    deps.secrets.answered(tokens.access, deps.now());
    answeredTokens.set(keyOf(request, account.id), { hash: sha256(tokens.access), accountId: account.id, until: deps.now() + ANSWERED_WINDOW_MS });
    deps.log(`[forge] answered git's credential request for ${server.id} with ${account.id} (${how})`);
    return { answer: { kind: 'credential', username, password: tokens.access }, account: accountOf(account, how, canPush) };
  };

  const refuseShell = (origin: GitCredentialOrigin, server: ForgeServer, projectKey: string | undefined, account: AccountRecord | undefined, reason: ShellRefusalReason, context: CredentialContext): CredentialResult => {
    // a target's panel ids name no chat of this computer's core
    if (origin.kind === 'agentShell' && context.authorityKey === 'local') deps.refused({ origin, server, ...(projectKey !== undefined ? { projectKey } : {}), ...(account ? { account } : {}), reason });
    deps.log(`[forge] refused git credentials for ${server.id} to an agent shell: ${reason}`);
    return refusal(account ? agentShellsOffMessage(account.login, server.id) : noAccountMessage(server.id));
  };

  const get = async (request: GitCredentialRequest, origin: GitCredentialOrigin, context: CredentialContext, signal: AbortSignal): Promise<CredentialResult> => {
    expire();
    const matched = serverOfRequest(request.fields, deps.servers());
    const accounts = matched ? deps.accounts().filter((account) => account.serverId === matched.server.id) : [];
    // a server no longer managed, or signed out of, since the spawn: the user's own helpers answer
    if (!matched || accounts.length === 0) return delegate(request, origin, context, signal);
    const { server, repoPath } = matched;
    const { authorityKey } = context;
    // an engine call names its project; a terminal's or shell's folder may hold another repository than its project's
    const named = origin.kind === 'engine' ? origin.projectKey ?? context.projectKey : undefined;
    const byRemote = named === undefined && repoPath !== undefined ? await deps.projectByRemote(authorityKey, server, repoPath, request.cwd, signal) : undefined;
    const originProject = origin.kind === 'terminal' ? origin.projectKey : undefined;
    const projectKey = named ?? byRemote ?? originProject ?? context.projectKey ?? deps.projectHolding(authorityKey, request.cwd);
    // only this computer's own clone presets an account: a target's preset would answer as bound and skip the consent
    const preset = origin.kind === 'engine' && origin.presetAccountId !== undefined && authorityKey === 'local' ? accounts.find((account) => account.id === origin.presetAccountId) : undefined;
    const usernameHint = usernameHintOf(request.fields.username);
    let settled: Settled | undefined = preset
      ? { how: 'bound', account: preset }
      : resolveWithoutAccess({ ...(projectKey !== undefined ? { projectKey } : {}), authorityKey, server, ...(usernameHint !== undefined ? { usernameHint } : {}) }, accounts, deps.bindings);
    let canPush: boolean | undefined;
    if (!settled && repoPath !== undefined) {
      const picked = await deps.pickByAccess(accounts, server, repoPath, signal);
      if (picked) {
        settled = { how: 'access', account: picked.account };
        canPush = picked.canPush;
      }
    }
    if (settled?.account === null) return delegate(request, origin, context, signal);
    if (settled) {
      const account = settled.account!;
      if (origin.kind === 'agentShell' && !account.agentShells) return refuseShell(origin, server, projectKey, account, 'agentShellsOff', context);
      // a target gets an automatic pick's token only once the user agreed to that very account
      if (authorityKey !== 'local' && !CONSENTED_HOWS.has(settled.how) && context.consentedAccountId !== account.id) {
        deps.log(`[forge] a request from ${authorityKey} for ${server.id} resolved to ${account.id} (${settled.how}), which needs the user's consent`);
        return { consent: accountOf(account, settled.how, canPush) };
      }
      return answerWith(account, server, settled.how, canPush, request);
    }
    if (origin.kind === 'agentShell') return refuseShell(origin, server, projectKey, undefined, 'noAccount', context);
    const interactive = origin.kind === 'terminal' || (origin.kind === 'engine' && origin.interactive);
    // background (autofetch): the user's own helpers with GCM_INTERACTIVE=never, as before accounts existed
    if (!interactive) return delegate(request, origin, context, signal);
    const choice = await deps.ask({ ...(projectKey !== undefined ? { projectKey } : {}), authorityKey, server, repoPath: repoPath ?? '', accounts }, signal);
    switch (choice.kind) {
      case 'own': return delegate(request, origin, context, signal);
      case 'cancelled': return refusal(english('No account was chosen for {0}, so git got no credentials.', server.id));
      case 'signInAnother': return refusal(english('Sign in to {0} in Settings › Models & accounts › Git hosting, then try again.', server.id));
      case 'account': return answerWith(choice.account, server, 'choice', undefined, request);
    }
  };

  // git calls store after the credential worked: Damocles' own token is never handed on; the user's helpers keep theirs
  const store = async (request: GitCredentialRequest, origin: GitCredentialOrigin, context: CredentialContext, signal: AbortSignal): Promise<CredentialResult> => {
    expire();
    if ([...answeredTokens.values()].some((entry) => hashMatches(entry.hash, request.passwordHash))) return { answer: { kind: 'none' } };
    const entry = delegated.get(keyOf(request, originKeyOf(origin, context)));
    if (entry && hashMatches(entry.hash, request.passwordHash) && context.authorityKey === 'local') return delegate(request, origin, context, signal);
    return { answer: { kind: 'none' } };
  };

  const erase = async (request: GitCredentialRequest, origin: GitCredentialOrigin, context: CredentialContext, signal: AbortSignal): Promise<CredentialResult> => {
    expire();
    const ours = [...answeredTokens.values()].find((entry) => hashMatches(entry.hash, request.passwordHash));
    if (ours) {
      const account = deps.accounts().find((candidate) => candidate.id === ours.accountId);
      const server = account ? deps.servers().find((candidate) => candidate.id === account.serverId) : undefined;
      if (account && server) {
        // git waits for erase; the check runs on, and its outcome reaches the account's state
        void deps.verify(account, server).catch((err: unknown) => deps.log(`[forge] checking ${account.id} after git refused its token failed: ${err instanceof Error ? err.name : typeof err}`));
      }
      return { answer: { kind: 'none' } };
    }
    const key = keyOf(request, originKeyOf(origin, context));
    const entry = delegated.get(key);
    if (entry && hashMatches(entry.hash, request.passwordHash) && context.authorityKey === 'local') {
      delegated.delete(key);
      return delegate(request, origin, context, signal);
    }
    return { answer: { kind: 'none' } };
  };

  return {
    answer(request, origin, context, signal) {
      switch (request.op) {
        case 'get': return get(request, origin, context, signal);
        case 'store': return store(request, origin, context, signal);
        case 'erase': return erase(request, origin, context, signal);
      }
    },
  };
}
