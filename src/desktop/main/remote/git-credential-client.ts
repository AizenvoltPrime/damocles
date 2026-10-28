// This computer's side of a target's git credential relay (docs/invariants.md "Remote daemon and wire"): an https get is
// answered from this computer's `git credential fill` after the user's consent per pair of target host and credential host;
// an erase only drops that pair's Always consent and offers to remove what this run relayed; nothing else reaches the
// credential manager.
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { childEnv } from '../../../core/pi-session/checkpoints/exec';
import { isCredentialValue, MAX_CREDENTIAL_PASSWORD_CHARS, MAX_CREDENTIAL_USERNAME_CHARS, type GitCredentialAnswer, type GitCredentialFields } from '../../../shared/git-credential';
import type { HostTone } from '../../../shared/host-tones';
import type { GitCredentialConsent, GitCredentialConsentChoice } from '../../preload/overlay-channels';

// a DNS name or IPv4 address and an optional port, compared lowercased; anything else is refused
const CREDENTIAL_HOST = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*(?::[1-9]\d{0,4})?$/;
const MAX_FILL_OUTPUT_BYTES = 64 * 1024;

export interface GitCredentialRequest {
  readonly op: 'get' | 'erase';
  readonly fields: GitCredentialFields;
  readonly targetHelper: boolean;
}

export interface CredentialTargetHost {
  readonly name: string;
  readonly color?: HostTone;
  readonly alwaysCredentialHosts: readonly string[];
}

export interface GitCredentialClientDeps {
  // the target host as this computer's host store has it
  readonly host: (hostId: string) => CredentialTargetHost | undefined;
  // the target's daemon passes an erase on only when it names the password the relay answered (its welcome's features)
  readonly verifiesErase: (hostId: string) => boolean;
  readonly addAlways: (hostId: string, credentialHost: string) => Promise<void>;
  readonly revokeAlways: (hostId: string, credentialHost: string) => Promise<void>;
  // the overlay's consent dialog; a dismissed one answers deny
  readonly askConsent: (consent: GitCredentialConsent, signal: AbortSignal) => Promise<GitCredentialConsentChoice>;
  // `git credential fill` or `reject` on this computer with the description on stdin; resolves stdout, rejects on a failure
  readonly gitCredential: (op: 'fill' | 'reject', input: string, signal: AbortSignal | undefined) => Promise<string>;
  // a warning notification with one action; resolves the action when the user chose it
  readonly notify: (message: string, action: string) => Promise<string | undefined>;
  readonly t: (message: string, ...args: string[]) => string;
  readonly log: (line: string) => void;
}

export interface GitCredentialClient {
  handle(hostId: string, request: GitCredentialRequest, signal: AbortSignal): Promise<GitCredentialAnswer>;
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

// One consent dialog and the requests it answers; it is withdrawn once every one of them went away.
interface Asking {
  readonly targetHelper: boolean;
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

  const ask = (hostId: string, target: CredentialTargetHost, credentialHost: string, targetHelper: boolean): Asking => {
    const key = pairKey(hostId, credentialHost);
    const withdrawn = new AbortController();
    const choice = deps.askConsent({ hostName: target.name, ...(target.color !== undefined ? { hostColor: target.color } : {}), credentialHost, targetHelper }, withdrawn.signal)
      .then(async (picked) => {
        if (picked !== 'always') return picked;
        try {
          await deps.addAlways(hostId, credentialHost);
        } catch (err) {
          log(`[git-credential] Always for ${credentialHost} on ${target.name} could not be saved, so it counts as Allow once: ${message(err)}`);
        }
        return picked;
      })
      .finally(() => {
        if (asking.get(key) === entry) asking.delete(key);
      });
    const entry: Asking = { targetHelper, choice, withdrawn, waiters: 0 };
    asking.set(key, entry);
    return entry;
  };

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

  const consent = async (hostId: string, credentialHost: string, targetHelper: boolean, signal: AbortSignal): Promise<boolean> => {
    const key = pairKey(hostId, credentialHost);
    for (;;) {
      if (signal.aborted) return false;
      const target = deps.host(hostId);
      if (!target) return false;
      if (target.alwaysCredentialHosts.includes(credentialHost)) return true;
      const pending = asking.get(key);
      // a withdrawn dialog, or one without the warning this request needs, answers it only after it closed and it asks again
      if (pending && (pending.withdrawn.signal.aborted || (targetHelper && !pending.targetHelper))) {
        await pending.choice.catch(() => undefined);
        continue;
      }
      return (await join(pending ?? ask(hostId, target, credentialHost, targetHelper), signal)) !== 'deny';
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

  return {
    async handle(hostId, request, signal) {
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
      if (request.op === 'get') return get(hostId, target, credentialHost, request, signal);
      if (!deps.verifiesErase(hostId)) {
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
