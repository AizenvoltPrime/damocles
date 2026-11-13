// A repository's remote endpoints for Git hosting accounts (docs/invariants.md "GitHub and GitLab accounts", remote
// endpoints): `git remote -v`, then for an ssh host that is a safe alias git's own ssh with `-G` (no connection) to read its
// HostName and Port, and for an https URL git's credential.username. It runs on the repository's own host, only when asked,
// never on the status path; ssh runs only in a trusted project, and its answer per ssh command and alias is kept for the
// core's run.
import * as path from 'node:path';
import type { RemoteEndpoint, RemoteLocation } from '../../shared/forge/bindings';
import { isSafeAlias } from '../../shared/ssh-alias';
import { locationOf, parseRemoteUrl, usernameHintOf } from '../forge/remote-url';
import { resolveGitExecutable } from '../git-executable';
import { runProcess } from '../process-launcher';
import { findOnAbsolutePathAsync, resolveGitShell } from '../system-tools';
import type { Remote } from './remotes';

export const SSH_QUERY_TIMEOUT_MS = 5_000;
const MAX_SSH_OUTPUT_CHARS = 256 * 1024;

/**
 * How git starts ssh for the repository, as connect.c chooses it: GIT_SSH_COMMAND, else core.sshCommand, each run through
 * git's shell as `sh -c '<command> "$@"' <command> <args>`; else GIT_SSH, else ssh, each run as a program. A query runs
 * `file` with `[...prefix, '-G', '--', alias]`.
 */
export interface GitSsh {
  readonly label: 'GIT_SSH_COMMAND' | 'core.sshCommand' | 'GIT_SSH' | 'ssh';
  readonly file: string;
  readonly prefix: readonly string[];
}

/** What gitSshOf reads. */
export interface GitSshSources {
  /** The environment git runs with. */
  readonly env: Readonly<Record<string, string | undefined>>;
  /** `git config --get core.sshCommand` in the repository; undefined when unset, a rejection when git failed. */
  readonly configured: () => Promise<string | undefined>;
  /** git's shell as an absolute path (resolveGitShell). */
  readonly shell: () => Promise<string | undefined>;
  /** The OpenSSH client as an absolute path (resolveSshExecutable). */
  readonly ssh: () => Promise<string | undefined>;
  /** GIT_SSH's program as an absolute path: itself when absolute, else an absolute PATH folder's. */
  readonly program: (name: string) => Promise<string | undefined>;
}

/** git's ssh for the repository; undefined, logged, when the one git would run cannot be found or read. */
export async function gitSshOf(sources: GitSshSources, log: (line: string) => void): Promise<GitSsh | undefined> {
  let command = sources.env['GIT_SSH_COMMAND'];
  let label: GitSsh['label'] = 'GIT_SSH_COMMAND';
  if (command === undefined) {
    try {
      command = await sources.configured();
    } catch (err) {
      log(`[scm] reading core.sshCommand failed (${errorText(err)}); ssh aliases stay as written`);
      return undefined;
    }
    label = 'core.sshCommand';
  }
  if (command !== undefined) {
    const shell = await sources.shell();
    if (shell === undefined) {
      log(`[scm] git's shell, which runs ${label}, was not found; ssh aliases stay as written`);
      return undefined;
    }
    return { label, file: shell, prefix: ['-c', `${command} "$@"`, command] };
  }
  const named = sources.env['GIT_SSH'];
  if (named !== undefined) {
    const file = await sources.program(named);
    if (file === undefined) {
      log('[scm] the program GIT_SSH names was not found; ssh aliases stay as written');
      return undefined;
    }
    return { label: 'GIT_SSH', file, prefix: [] };
  }
  const ssh = await sources.ssh();
  if (ssh === undefined) {
    log('[scm] remote endpoints: no ssh client found, aliases stay as written');
    return undefined;
  }
  return { label: 'ssh', file: ssh, prefix: [] };
}

/** gitSshOf's sources on this host, with the repository's core.sshCommand read by configured. */
export function hostGitSshSources(configured: () => Promise<string | undefined>, ssh: () => Promise<string | undefined>, env: Readonly<Record<string, string | undefined>> = process.env): GitSshSources {
  return {
    env,
    configured,
    shell: () => resolveGitShell(resolveGitExecutable()),
    ssh,
    program: (name) => (path.isAbsolute(name) ? Promise.resolve(name) : findOnAbsolutePathAsync(process.platform === 'win32' ? [name, `${name}.exe`] : name, process.platform, env)),
  };
}

export interface RemoteEndpointsDeps {
  readonly remotes: () => Promise<readonly Remote[]>;
  /** `git config --get-urlmatch credential.username <url>`; undefined when unset. */
  readonly credentialUsername: (url: string) => Promise<string | undefined>;
  /** The repository's project is trusted now; ssh -G reads the user's ssh config, whose Match exec runs commands. */
  readonly trusted: () => boolean;
  /** git's ssh for the repository (gitSshOf), asked once per read and only for an alias in a trusted project. */
  readonly gitSsh: () => Promise<GitSsh | undefined>;
  /** The answers by ssh command and alias, kept by the caller for the core's run. */
  readonly sshAnswers: Map<string, Promise<SshAnswer>>;
  readonly log: (line: string) => void;
}

export interface SshTarget {
  readonly hostname: string;
  readonly port?: number;
}

/** A target; refused when the command rejected `-G` (a non-zero exit, or no hostname line); undefined when it did not run. */
export type SshAnswer = SshTarget | 'refused' | undefined;

const DNS_NAME = /^[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?$/;
const IPV6 = /^\[?([0-9a-f:.]*:[0-9a-f:.]*)\]?$/;

/** ssh -G's `hostname` and `port` lines; an IPv6 address, which ssh prints bare, comes back in brackets as a URL holds it. */
export function parseSshConfigDump(stdout: string): SshTarget | undefined {
  let hostname: string | undefined;
  let port: number | undefined;
  for (const line of stdout.slice(0, MAX_SSH_OUTPUT_CHARS).split(/\r?\n/)) {
    const match = /^(\S+)\s+(\S+)$/.exec(line.trim());
    if (!match) continue;
    const key = match[1]!.toLowerCase();
    if (key === 'hostname') hostname = match[2]!.toLowerCase();
    else if (key === 'port' && /^\d{1,5}$/.test(match[2]!)) port = Number(match[2]);
  }
  if (hostname === undefined) return undefined;
  const ipv6 = IPV6.exec(hostname);
  if (ipv6) hostname = `[${ipv6[1]!}]`;
  else if (!DNS_NAME.test(hostname)) return undefined;
  return { hostname, ...(port !== undefined && port !== 22 && port > 0 && port <= 65535 ? { port } : {}) };
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function querySsh(alias: string, ssh: GitSsh, deps: RemoteEndpointsDeps): Promise<SshAnswer> {
  let output: Awaited<ReturnType<typeof runProcess>>;
  try {
    output = await runProcess({ file: ssh.file, args: [...ssh.prefix, '-G', '--', alias], windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }, { timeoutMs: SSH_QUERY_TIMEOUT_MS });
  } catch (err) {
    deps.log(`[scm] ${ssh.label} -G ${alias} could not start (${errorText(err)}); the alias stays as written`);
    return undefined;
  }
  if (output.exit === null) {
    deps.log(`[scm] ${ssh.label} -G ${alias} took over ${SSH_QUERY_TIMEOUT_MS} ms; the alias stays as written`);
    return undefined;
  }
  if (output.exit.code !== 0) {
    deps.log(`[scm] ${ssh.label} -G ${alias} exited ${String(output.exit.code)}; the remote maps to no server`);
    return 'refused';
  }
  const target = parseSshConfigDump(output.stdout.toString('utf8'));
  if (target) return target;
  deps.log(`[scm] ${ssh.label} -G ${alias} printed no usable hostname line; the remote maps to no server`);
  return 'refused';
}

/** The repository's remotes as endpoints; each ssh host is queried once per call. */
export async function readRemoteEndpoints(deps: RemoteEndpointsDeps): Promise<RemoteEndpoint[]> {
  const remotes = await deps.remotes();
  const queries = deps.sshAnswers;
  let gitSsh: Promise<GitSsh | undefined> | undefined;
  const resolve = async (url: string): Promise<RemoteLocation | undefined> => {
    const parsed = parseRemoteUrl(url);
    if (!parsed) return undefined;
    if (parsed.protocol === 'https') {
      // rebuilt without userinfo, so a password written in the remote never reaches git's argv
      const bare = `https://${parsed.host}${parsed.port !== undefined ? `:${parsed.port}` : ''}/${encodeURI(parsed.path)}`;
      let user: string | undefined;
      if (usernameHintOf(parsed.user) === undefined) {
        try {
          user = await deps.credentialUsername(bare);
        } catch (err) {
          deps.log(`[scm] reading credential.username for a remote on ${parsed.host} failed (${errorText(err)}); read as unset`);
        }
      }
      return locationOf(parsed, user);
    }
    const location = locationOf(parsed);
    if (!isSafeAlias(parsed.host) || !deps.trusted()) return location;
    gitSsh ??= deps.gitSsh();
    const ssh = await gitSsh;
    if (!ssh) return location;
    const key = JSON.stringify([ssh.file, ssh.prefix, parsed.host]);
    let query = queries.get(key);
    if (!query) {
      const asked = querySsh(parsed.host, ssh, deps).then((answer) => {
        // only a target is kept; a command that did not run or refused is asked again next time
        if (typeof answer !== 'object' && queries.get(key) === asked) queries.delete(key);
        return answer;
      });
      query = asked;
      queries.set(key, query);
    }
    const target = await query;
    if (target === 'refused') return undefined;
    if (!target) return location;
    const port = parsed.port ?? target.port;
    const { port: _written, ...rest } = location;
    return { ...rest, host: target.hostname, ...(port !== undefined ? { port } : {}), aliasResolved: true };
  };
  return Promise.all(remotes.map(async (remote) => {
    const fetch = remote.fetchUrl !== undefined ? await resolve(remote.fetchUrl) : undefined;
    const push = remote.pushUrl !== undefined && remote.pushUrl !== remote.fetchUrl ? await resolve(remote.pushUrl) : undefined;
    return { remote: remote.name, ...(fetch ? { fetch } : {}), ...(push ? { push } : {}) };
  }));
}
