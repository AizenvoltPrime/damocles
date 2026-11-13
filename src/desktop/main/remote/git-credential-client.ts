// This computer's side of a target's git credential relay (docs/invariants.md "Remote daemon and wire"): an https get is
// answered from this computer's `git credential fill` after the user's consent per pair of target host and credential host;
// an erase only drops that pair's Always consent and offers to remove what this run relayed; nothing else reaches the
// credential manager. A request of a managed server's takeover (origin set) is answered from the bound account by this
// computer's core: an explicit binding, host default or Choose account answer counts as consent; for an automatic resolution core names
// the account first, and reads its token only on a second call after the user agreed to that account.
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { childEnv } from '../../../core/pi-session/checkpoints/exec';
import { isCredentialValue, MAX_CREDENTIAL_PASSWORD_CHARS, MAX_CREDENTIAL_USERNAME_CHARS, type GitCredentialAnswer, type GitCredentialFields, type GitCredentialOrigin, type GitCredentialRequest as ForgeCredentialRequest } from '../../../shared/git-credential';
import { CONSENTED_HOWS } from '../../../shared/forge/bindings';
import type { HostColor } from '../../../shared/host-colors';
import type { ForgeCredentialAccount, ForgeGitCredentialResult } from '../../core-protocol/messages';
import { MAX_CONSENT_REPO_PATH_CHARS, type AlwaysForgeAccount, type GitConsentForgeReason, type GitCredentialConsent, type GitCredentialConsentChoice } from '../../preload/overlay-channels';

// a DNS name or IPv4 address and an optional port, compared lowercased; anything else is refused
const CREDENTIAL_HOST = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*(?::[1-9]\d{0,4})?$/;
const MAX_FILL_OUTPUT_BYTES = 64 * 1024;

export interface GitCredentialRequest {
  readonly op: 'get' | 'erase';
  readonly fields: GitCredentialFields;
  readonly targetHelper: boolean;
  // a managed server's takeover on the target (feature askpass.credential.origin): who asked, and git's folder there
  readonly origin?: GitCredentialOrigin;
  readonly cwd?: string;
  // a takeover erase's: the SHA-256 of the token the target's git refused
  readonly passwordHash?: string;
}

/** This computer's core answering a target's takeover request, and the project the request maps to. */
export interface ForgeCredentialDeps {
  // forge.gitCredential with the target's authority key; consentedAccountId only after the user agreed to that account
  readonly answer: (request: ForgeCredentialRequest, origin: GitCredentialOrigin, authorityKey: string, projectKey: string | undefined, consentedAccountId: string | undefined, signal: AbortSignal) => Promise<ForgeGitCredentialResult>;
  readonly authorityKey: (hostId: string) => string;
  // the listed project of the host the target folder key names, else the one holding cwd; undefined outside every project
  readonly projectOf: (hostId: string, targetProjectKey: string | undefined, cwd: string | undefined) => string | undefined;
}

export interface CredentialTargetHost {
  readonly name: string;
  readonly color?: HostColor;
  // the credential manager relay's Always, per credential host
  readonly alwaysCredentialHosts: readonly string[];
  // an account consent's Always, per account
  readonly alwaysForgeAccounts: readonly AlwaysForgeAccount[];
}

/** What the daemon serving the requesting core listed in its welcome, read when that core attached. */
export interface CredentialDaemon {
  // askpass.credential.origin: it may be answered refused or delegate
  readonly takesForgeAnswers: boolean;
  // askpass.credential.verifiedErase: it passes an erase on only when it names the password the relay answered
  readonly verifiesErase: boolean;
}

export interface GitCredentialClientDeps {
  // the target host as this computer's host store has it
  readonly host: (hostId: string) => CredentialTargetHost | undefined;
  readonly addAlways: (hostId: string, credentialHost: string) => Promise<void>;
  readonly revokeAlways: (hostId: string, credentialHost: string) => Promise<void>;
  readonly addAlwaysAccount: (hostId: string, account: AlwaysForgeAccount) => Promise<void>;
  // the overlay's consent dialog; a dismissed one answers deny
  readonly askConsent: (consent: GitCredentialConsent, signal: AbortSignal) => Promise<GitCredentialConsentChoice>;
  readonly forge: ForgeCredentialDeps;
  // `git credential fill` or `reject` on this computer with the description on stdin; resolves stdout, rejects on a failure
  readonly gitCredential: (op: 'fill' | 'reject', input: string, signal: AbortSignal | undefined) => Promise<string>;
  // a warning notification with one action; resolves the action when the user chose it
  readonly notify: (message: string, action: string) => Promise<string | undefined>;
  readonly t: (message: string, ...args: string[]) => string;
  readonly log: (line: string) => void;
}

export interface GitCredentialClient {
  handle(hostId: string, request: GitCredentialRequest, daemon: CredentialDaemon, signal: AbortSignal): Promise<GitCredentialAnswer>;
}

/** The credential host a request may name: https only, a valid host lowercased; undefined otherwise. */
export function credentialHostOf(fields: GitCredentialFields): string | undefined {
  if (fields.protocol !== 'https') return undefined;
  const host = fields.host.toLowerCase();
  if (!CREDENTIAL_HOST.test(host) || host.length > 259) return undefined;
  const port = /:(\d+)$/.exec(host)?.[1];
  return port !== undefined && Number(port) > 65535 ? undefined : host;
}

/** git's description of the credential this computer is asked for: protocol, host and the fields the target named. */
export function credentialInput(host: string, fields: GitCredentialFields): string {
  const lines = ['protocol=https', `host=${host}`, ...(fields.path !== undefined ? [`path=${fields.path}`] : []), ...(fields.username !== undefined ? [`username=${fields.username}`] : [])];
  for (const line of lines) if (/[\0\r\n]/.test(line)) throw new RangeError('a credential field holds a line break or NUL');
  return `${lines.join('\n')}\n\n`;
}

/** The username and password `git credential fill` printed, each within its bound; undefined otherwise. */
export function parseFillOutput(stdout: string): { readonly username: string; readonly password: string } | undefined {
  if (Buffer.byteLength(stdout, 'utf8') > MAX_FILL_OUTPUT_BYTES) return undefined;
  const values = new Map<string, string>();
  for (const line of stdout.split('\n')) {
    const at = line.indexOf('=');
    if (at > 0) values.set(line.slice(0, at), line.slice(at + 1).replace(/\r$/, ''));
  }
  const username = values.get('username') ?? '';
  const password = values.get('password');
  if (!isCredentialValue(username, MAX_CREDENTIAL_USERNAME_CHARS) || !isCredentialValue(password, MAX_CREDENTIAL_PASSWORD_CHARS) || password === '') return undefined;
  return { username, password };
}

type ForgeAccount = NonNullable<GitCredentialConsent['forgeAccount']>;
type AnswerResult = Exclude<ForgeGitCredentialResult, { readonly consent: ForgeCredentialAccount }>;

// The consent dialog's account: why core chose it, and the access check's push or read answer for an access pick.
interface ConsentAccount {
  readonly shown: ForgeAccount;
  readonly always: AlwaysForgeAccount;
}

/** The dialog's reason for an automatic pick; undefined for a resolution the dialog has no words for. */
function consentReason(account: ForgeCredentialAccount): GitConsentForgeReason | undefined {
  switch (account.how) {
    case 'onlyAccount':
    case 'usernameHint':
      return account.how;
    case 'access':
      return account.canPush === true ? 'access' : 'accessRead';
    default:
      return undefined;
  }
}

/** The repository as the server names it: git's path up to its `.git` segment (LFS asks below it), without `.git`. */
function consentRepoPath(gitPath: string | undefined): string {
  const segments = (gitPath ?? '').split('/').filter((segment) => segment !== '');
  const end = segments.findIndex((segment) => segment.endsWith('.git'));
  return (end < 0 ? segments : segments.slice(0, end + 1)).join('/').replace(/\.git$/, '');
}

// One consent dialog and the requests it answers; it is withdrawn once every one of them went away.
interface Asking {
  readonly targetHelper: boolean;
  // the account the dialog names, as JSON; '' for today's relay consent
  readonly account: string;
  readonly choice: Promise<GitCredentialConsentChoice>;
  readonly withdrawn: AbortController;
  waiters: number;
}

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));

export function createGitCredentialClient(deps: GitCredentialClientDeps): GitCredentialClient {
  const { t, log } = deps;
  // one dialog per pair at a time; a request meanwhile shares its answer when the dialog showed what it needs
  const asking = new Map<string, Asking>();
  // what this app run relayed per pair, as `git credential reject` reads it: only an erase of one of these offers removal
  const relayed = new Map<string, string>();
  const pairKey = (hostId: string, credentialHost: string): string => JSON.stringify([hostId, credentialHost]);

  const ask = (hostId: string, target: CredentialTargetHost, credentialHost: string, targetHelper: boolean, forgeAccount: ConsentAccount | undefined): Asking => {
    const key = pairKey(hostId, credentialHost);
    const withdrawn = new AbortController();
    const choice = deps.askConsent({ hostName: target.name, ...(target.color !== undefined ? { hostColor: target.color } : {}), credentialHost, targetHelper, ...(forgeAccount ? { forgeAccount: forgeAccount.shown } : {}) }, withdrawn.signal)
      .then(async (picked) => {
        if (picked !== 'always') return picked;
        try {
          await (forgeAccount ? deps.addAlwaysAccount(hostId, forgeAccount.always) : deps.addAlways(hostId, credentialHost));
        } catch (err) {
          log(`[git-credential] Always for ${forgeAccount ? forgeAccount.always.accountId : credentialHost} on ${target.name} could not be saved, so it counts as Allow once: ${message(err)}`);
        }
        return picked;
      })
      .finally(() => {
        if (asking.get(key) === entry) asking.delete(key);
      });
    const entry: Asking = { targetHelper, account: forgeAccount ? JSON.stringify(forgeAccount.shown) : '', choice, withdrawn, waiters: 0 };
    asking.set(key, entry);
    return entry;
  };

  const alwaysFor = (target: CredentialTargetHost, credentialHost: string, forgeAccount: ConsentAccount | undefined): boolean => (forgeAccount
    ? target.alwaysForgeAccounts.some((held) => held.serverId === forgeAccount.always.serverId && held.accountId === forgeAccount.always.accountId)
    : target.alwaysCredentialHosts.includes(credentialHost));

  const join = async (entry: Asking, signal: AbortSignal): Promise<GitCredentialConsentChoice> => {
    entry.waiters++;
    const leave = (): void => {
      entry.waiters--;
      if (entry.waiters === 0) entry.withdrawn.abort();
    };
    if (signal.aborted) leave();
    else signal.addEventListener('abort', leave, { once: true });
    try {
      return await entry.choice;
    } finally {
      signal.removeEventListener('abort', leave);
    }
  };

  const consent = async (hostId: string, credentialHost: string, targetHelper: boolean, signal: AbortSignal, forgeAccount?: ConsentAccount): Promise<boolean> => {
    const key = pairKey(hostId, credentialHost);
    for (;;) {
      if (signal.aborted) return false;
      const target = deps.host(hostId);
      if (!target) return false;
      if (alwaysFor(target, credentialHost, forgeAccount)) return true;
      const pending = asking.get(key);
      // a withdrawn dialog, one without the warning this request needs, or one naming another account (or none) answers it
      // only after it closed and it asks again
      const account = forgeAccount ? JSON.stringify(forgeAccount.shown) : '';
      if (pending && (pending.withdrawn.signal.aborted || (targetHelper && !pending.targetHelper) || pending.account !== account)) {
        await pending.choice.catch(() => undefined);
        continue;
      }
      return (await join(pending ?? ask(hostId, target, credentialHost, targetHelper, forgeAccount), signal)) !== 'deny';
    }
  };

  const get = async (hostId: string, target: CredentialTargetHost, credentialHost: string, request: GitCredentialRequest, signal: AbortSignal): Promise<GitCredentialAnswer> => {
    if (!(await consent(hostId, credentialHost, request.targetHelper, signal))) {
      log(`[git-credential] ${target.name} was refused the credential for ${credentialHost}`);
      return { kind: 'none' };
    }
    let stdout: string;
    try {
      stdout = await deps.gitCredential('fill', credentialInput(credentialHost, request.fields), signal);
    } catch (err) {
      log(`[git-credential] git credential fill for ${credentialHost} found none: ${message(err)}`);
      return { kind: 'none' };
    }
    const filled = parseFillOutput(stdout);
    if (!filled) {
      log(`[git-credential] git credential fill for ${credentialHost} printed no usable credential`);
      return { kind: 'none' };
    }
    const { path: relayedPath } = request.fields;
    relayed.set(pairKey(hostId, credentialHost), credentialInput(credentialHost, { protocol: 'https', host: credentialHost, ...(relayedPath !== undefined ? { path: relayedPath } : {}), ...(filled.username !== '' ? { username: filled.username } : {}) }));
    log(`[git-credential] relayed the credential for ${credentialHost} to ${target.name}`);
    return { kind: 'credential', ...filled };
  };

  // The target's git rejected the credential the relay gave: its Always goes, and only the user may remove what this run
  // relayed, by the username it relayed, whatever the erase names.
  const erase = async (hostId: string, target: CredentialTargetHost, credentialHost: string): Promise<GitCredentialAnswer> => {
    if (target.alwaysCredentialHosts.includes(credentialHost)) await deps.revokeAlways(hostId, credentialHost);
    const key = pairKey(hostId, credentialHost);
    const relayedInput = relayed.get(key);
    relayed.delete(key);
    if (relayedInput === undefined) {
      log(`[git-credential] ${target.name} reported the credential for ${credentialHost} refused; this run relayed none, so no removal is offered`);
      return { kind: 'none' };
    }
    const remove = t('Remove the saved credential on this computer');
    void deps.notify(t('{0} reported that the credential for {1} was refused.', target.name, credentialHost), remove).then(async (choice) => {
      if (choice !== remove) return;
      await deps.gitCredential('reject', relayedInput, undefined);
      log(`[git-credential] removed the saved credential for ${credentialHost} on the user's request`);
    }).catch((err: unknown) => log(`[git-credential] removing the saved credential for ${credentialHost} failed: ${message(err)}`));
    return { kind: 'none' };
  };

  // A takeover request: answered from the bound account; delegate and refused only go to a daemon that takes them.
  const forgeAnswer = async (hostId: string, target: CredentialTargetHost, credentialHost: string, request: GitCredentialRequest & { readonly origin: GitCredentialOrigin }, daemon: CredentialDaemon, signal: AbortSignal): Promise<GitCredentialAnswer> => {
    if (request.cwd === undefined) {
      log(`[git-credential] refused ${target.name}'s takeover ${request.op} for ${credentialHost}, which names no folder`);
      return { kind: 'none' };
    }
    const authorityKey = deps.forge.authorityKey(hostId);
    const targetProject = request.origin.kind === 'agentShell' ? undefined : request.origin.projectKey;
    const projectKey = deps.forge.projectOf(hostId, targetProject, request.cwd);
    const origin: GitCredentialOrigin = request.origin.kind === 'agentShell'
      ? request.origin
      : request.origin.kind === 'engine'
        ? { kind: 'engine', interactive: request.origin.interactive, ...(projectKey !== undefined ? { projectKey } : {}) }
        : { kind: 'terminal', ...(projectKey !== undefined ? { projectKey } : {}) };
    const coreRequest: ForgeCredentialRequest = { op: request.op, cwd: request.cwd, fields: { ...request.fields, host: credentialHost }, ...(request.passwordHash !== undefined ? { passwordHash: request.passwordHash } : {}) };
    const first = await deps.forge.answer(coreRequest, origin, authorityKey, projectKey, undefined, signal);
    // an erase reaches no credential manager here: the core checks the account whose token the target refused
    if (request.op === 'erase') return { kind: 'none' };
    let result: AnswerResult;
    let consented: string | undefined;
    if (!('consent' in first)) {
      result = first;
    } else {
      const account = first.consent;
      const reason = consentReason(account);
      if (reason === undefined) {
        log(`[git-credential] refused ${target.name}'s request for ${credentialHost}: ${account.how} has no consent text`);
        return { kind: 'none' };
      }
      const repoPath = consentRepoPath(request.fields.path);
      if (repoPath.length > MAX_CONSENT_REPO_PATH_CHARS) log(`[git-credential] the consent for ${target.name} leaves out a repository path of ${repoPath.length} characters`);
      const forgeAccount: ConsentAccount = {
        shown: { serverLabel: account.serverId, login: account.login, reason, ...(repoPath !== '' && repoPath.length <= MAX_CONSENT_REPO_PATH_CHARS ? { repoPath } : {}) },
        always: { serverId: account.serverId, accountId: account.accountId },
      };
      // a background call (autofetch) never shows a dialog: without an Always for the account it gets the target's own helpers
      if (request.origin.kind === 'engine' && !request.origin.interactive && !alwaysFor(target, credentialHost, forgeAccount)) {
        log(`[git-credential] a background git call on ${target.name} asked for ${account.login} on ${account.serverId}, which needs consent; it gets the target's own helpers`);
        return daemon.takesForgeAnswers ? { kind: 'delegate' } : { kind: 'none' };
      }
      if (!(await consent(hostId, credentialHost, false, signal, forgeAccount))) {
        log(`[git-credential] ${target.name} was refused ${account.login} on ${account.serverId}`);
        return { kind: 'none' };
      }
      consented = account.accountId;
      const second = await deps.forge.answer(coreRequest, origin, authorityKey, projectKey, consented, signal);
      if ('consent' in second) {
        log(`[git-credential] ${target.name}'s request for ${credentialHost} resolved to another account after consent, so it got none`);
        return { kind: 'none' };
      }
      result = second;
    }
    const { answer, account } = result;
    if (answer.kind === 'credential') {
      // the user chose this account, in a binding, a host default, the Choose account dialog or the consent dialog; anything else gets nothing
      if (account === undefined || !(CONSENTED_HOWS.has(account.how) || account.accountId === consented)) {
        log(`[git-credential] refused ${target.name}'s request for ${credentialHost}: no consent covers ${account?.accountId ?? 'an unnamed account'}`);
        return { kind: 'none' };
      }
      log(`[git-credential] answered ${target.name}'s request for ${credentialHost} with ${account.login}${consented === undefined ? ', chosen for it' : ' after consent'}`);
      return answer;
    }
    if ((answer.kind === 'refused' || answer.kind === 'delegate') && !daemon.takesForgeAnswers) {
      log(`[git-credential] ${target.name}'s server takes no ${answer.kind} answer, so it got none`);
      return { kind: 'none' };
    }
    return answer;
  };

  return {
    async handle(hostId, request, daemon, signal) {
      const target = deps.host(hostId);
      // the loopback daemon has no saved host to consent for
      if (!target) {
        log(`[git-credential] refused a ${request.op} from ${hostId}, which is no saved host`);
        return { kind: 'none' };
      }
      const credentialHost = credentialHostOf(request.fields);
      if (credentialHost === undefined) {
        log(`[git-credential] refused ${target.name}'s ${request.op} for a ${JSON.stringify(request.fields.protocol)} credential host that is not https or not a host name`);
        return { kind: 'none' };
      }
      const { origin } = request;
      if (origin !== undefined) return forgeAnswer(hostId, target, credentialHost, { ...request, origin }, daemon, signal);
      if (request.op === 'get') return get(hostId, target, credentialHost, request, signal);
      if (!daemon.verifiesErase) {
        log(`[git-credential] ignored ${target.name}'s erase for ${credentialHost}: its server does not check that the erase refuses the credential your computer gave`);
        return { kind: 'none' };
      }
      return erase(hostId, target, credentialHost);
    },
  };
}

export interface ClientGitDeps {
  // this computer's git, as main's probe found it (resolveGitExecutable); undefined without one
  readonly git: () => string | undefined;
  // main's launcher: a run with stdin, killed when signal aborts
  readonly run: (spec: { readonly file: string; readonly args: readonly string[]; readonly cwd: string; readonly env: Readonly<Record<string, string | undefined>> }, input: string, signal: AbortSignal | undefined) => Promise<{ readonly code: number | null; readonly stdout: string }>;
  // an askpass registration of main's askpass server whose prompts this computer's askpass bridge shows
  readonly askpassEnv: () => Promise<{ readonly env: Readonly<Record<string, string>>; dispose(): void }>;
  // where the empty working folder is made; os.tmpdir() when left out
  readonly tmpdir?: () => string;
}

/**
 * `git credential <op>` on this computer: no terminal prompt, a sign-in git asks for goes through the askpass bridge, and
 * no repository is discovered: an empty folder git searches no further up from, without repository-local GIT_* variables.
 */
export function clientGitCredential(deps: ClientGitDeps): GitCredentialClientDeps['gitCredential'] {
  return async (op, input, signal) => {
    const git = deps.git();
    if (git === undefined) throw new Error('Git was not found on this computer');
    const cwd = await fs.mkdtemp(path.join((deps.tmpdir ?? os.tmpdir)(), 'damocles-git-credential-'));
    try {
      const registration = await deps.askpassEnv();
      try {
        const env = { ...childEnv(), ...registration.env, GIT_TERMINAL_PROMPT: '0', GIT_CEILING_DIRECTORIES: path.dirname(cwd) };
        const { code, stdout } = await deps.run({ file: git, args: ['credential', op], cwd, env }, input, signal);
        if (code !== 0) throw new Error(`git credential ${op} exited with ${String(code)}`);
        return stdout;
      } finally {
        registration.dispose();
      }
    } finally {
      await fs.rm(cwd, { recursive: true, force: true });
    }
  };
}
