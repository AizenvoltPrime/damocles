// The credential takeover's config entries (docs/invariants.md "GitHub and GitLab accounts", takeover): for every managed
// server, git's helper list is reset for its URLs only and Damocles' helper put in it, per call or spawn; no gitconfig is
// ever written.
import * as path from 'node:path';
import { GIT_HOST, TAKEOVER_HELPER_ARG, type GitCredentialOrigin } from '../../../shared/git-credential';
import type { CredentialRegistration } from './askpass-server';
import { shQuote } from './credential-relay';

/** A server with at least one Damocles account, as the forge mirror and clientForges carry it. */
export interface ManagedServer {
  /** https://host[:port][/prefix] */
  readonly webUrl: string;
  /** host[:port] entries, the web host among them */
  readonly gitHosts: readonly string[];
}

export type ConfigEntry = readonly [key: string, value: string];

/** The https URLs a server's credentials are asked under: its web URL with any path prefix, then each other git host. */
export function managedUrls(server: ManagedServer): string[] {
  const web = new URL(server.webUrl);
  if (web.protocol !== 'https:') return [];
  const base = `https://${web.host}${web.pathname.replace(/\/+$/, '')}`;
  const others = server.gitHosts.map((host) => host.toLowerCase()).filter((host) => host !== web.host && GIT_HOST.test(host)).map((host) => `https://${host}`);
  return [...new Set([base, ...others])];
}

/**
 * Per URL: an empty helper resets the list built so far, then Damocles' helper, then useHttpPath so the helper hears the
 * repository path. These go after every other command-line entry, or a later helper would join the list again.
 */
export function managedEntries(servers: readonly ManagedServer[], helperPath: string): ConfigEntry[] {
  const helper = `!${shQuote(helperPath)} ${TAKEOVER_HELPER_ARG}`;
  const urls = [...new Set(servers.flatMap(managedUrls))];
  return urls.flatMap((url): ConfigEntry[] => [[`credential.${url}.helper`, ''], [`credential.${url}.helper`, helper], [`credential.${url}.useHttpPath`, 'true']]);
}

/** GIT_CONFIG_COUNT pairs from index start on (git 2.31 or later). */
export function asConfigPairs(entries: readonly ConfigEntry[], start = 0): Record<string, string> {
  const pairs: Record<string, string> = { GIT_CONFIG_COUNT: String(start + entries.length) };
  entries.forEach(([key, value], index) => {
    pairs[`GIT_CONFIG_KEY_${start + index}`] = key;
    pairs[`GIT_CONFIG_VALUE_${start + index}`] = value;
  });
  return pairs;
}

/** `-c key=value` arguments, for git before 2.31; a key never holds '=', which -c would split. */
export function asConfigArgs(entries: readonly ConfigEntry[]): string[] {
  return entries.flatMap(([key, value]) => {
    if (key.includes('=')) throw new RangeError('a config key holds =');
    return ['-c', `${key}=${value}`];
  });
}

/** git's sq_quote_buf: single quotes around the text, each ' and ! closed out and backslash-escaped. */
export function sqQuote(text: string): string {
  return `'${text.replace(/['!]/g, (c) => `'\\${c}'`)}'`;
}

/**
 * One GIT_CONFIG_PARAMETERS value: the inherited entries first, then each 'key=value' as git quotes it. Undefined when there is
 * nothing to set, so no empty variable is ever made (empty GIT_CONFIG_* values break pre-commit and MSYS Python on Windows).
 */
export function asConfigParams(entries: readonly ConfigEntry[], inherited: string | undefined): string | undefined {
  for (const [key, value] of entries) if (/[\0\r\n]/.test(key + value)) throw new RangeError('a config entry holds a line break or NUL');
  const parts = [...(inherited !== undefined && inherited.trim() !== '' ? [inherited.trim()] : []), ...entries.map(([key, value]) => sqQuote(`${key}=${value}`))];
  return parts.length === 0 ? undefined : parts.join(' ');
}

/** The takeover as a core's git calls and agent shells get it, per origin. */
export interface CredentialTakeover {
  // the managed servers' entries for this origin; none when no server has an account or the origin's project delegates
  entries(origin: GitCredentialOrigin): readonly ConfigEntry[];
  register(origin: GitCredentialOrigin): Promise<CredentialRegistration>;
}

let installed: CredentialTakeover | undefined;

/** Set by a desktop core (core-host/scm.ts) while its askpass server runs; the VS Code extension never sets it. */
export function installCredentialHelper(takeover: CredentialTakeover | undefined): void {
  installed = takeover;
}

export function installedCredentialHelper(): CredentialTakeover | undefined {
  return installed;
}

/** Where the desktop build and the server package put the helper git runs (dist/git-credential, unpacked from the asar). */
export function credentialHelperPath(unpackedRoot: string, platform: NodeJS.Platform = process.platform): string {
  const join = platform === 'win32' ? path.win32.join : path.posix.join;
  return join(unpackedRoot, 'dist', 'git-credential', platform === 'win32' ? 'git-credential-relay.cmd' : 'git-credential-relay.sh');
}
