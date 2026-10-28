// The git credential relay of a daemon's core (docs/invariants.md "Remote daemon and wire"): the helper git runs as its
// last credential.helper, and the variables the processes Damocles spawns on the target get. process.env is only read.
import { createHash, timingSafeEqual } from 'node:crypto';
import type { GitCredentialFields } from '../../../shared/git-credential';

// git network calls that may ask for credentials; every other runner call gets no relay
export const CREDENTIAL_SUBCOMMANDS: ReadonlySet<string> = new Set(['fetch', 'pull', 'push', 'clone', 'ls-remote', 'submodule']);

// The relay's capability: a helper holding this nonce may ask only `credential` operations, never a prompt.
export const CREDENTIAL_NONCE_VARIABLE = 'DAMOCLES_CREDENTIAL_NONCE';

export interface CredentialRelay {
  // the absolute path of git-credential-relay.sh or .cmd in the installed server package
  readonly helper: string;
  // the helper's node and dist/askpass-main.js
  readonly node: string;
  readonly main: string;
  // core's askpass server
  readonly handle: string;
  // 64 hex digits
  readonly nonce: string;
}

// The relay a daemon owns for its life: each of its cores listens at handle and accepts nonce for credential requests
// only, so a terminal started before a core, or across a core restart, keeps a working relay.
export interface RelayIdentity {
  readonly helper: string;
  readonly handle: string;
  readonly nonce: string;
}

/** A POSIX sh single-quoted literal; git runs a `!` helper through sh, Git for Windows' sh included. */
export function shQuote(value: string): string {
  if (/[\n\r\0]/.test(value)) throw new RangeError('a helper path holds a line break or NUL');
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/** The config pair that makes git ask the relay after the target's own helpers. */
export function relayHelperConfig(relay: Pick<CredentialRelay, 'helper'>): readonly [string, string] {
  return ['credential.helper', `!${shQuote(relay.helper)}`];
}

/** What the helper reads: never DAMOCLES_ASKPASS_NONCE, GIT_ASKPASS or SSH_ASKPASS, which carry the prompt capability. */
export function relayVariables(relay: CredentialRelay): Record<string, string> {
  return {
    DAMOCLES_ASKPASS_NODE: relay.node,
    DAMOCLES_ASKPASS_MAIN: relay.main,
    DAMOCLES_ASKPASS_HANDLE: relay.handle,
    [CREDENTIAL_NONCE_VARIABLE]: relay.nonce,
  };
}

// a count git accepts: GIT_CONFIG_COUNT pairs a shell or terminal inherits stay ahead of the relay's
function inheritedPairs(base: Readonly<Record<string, string | undefined>>): number {
  const count = base['GIT_CONFIG_COUNT'];
  return count !== undefined && /^(0|[1-9]\d{0,3})$/.test(count) ? Number(count) : 0;
}

/** A daemon's: the forwarded-agent socket a spawn gets, undefined for none; absent elsewhere, where SSH_AUTH_SOCK is the user's. */
export interface SpawnAgent {
  readonly socket: string | undefined;
}

/** SSH_AUTH_SOCK as a spawn on a daemon gets it: its client's proxy socket, or no value, so an inherited one never applies. */
export function agentVariables(agent: SpawnAgent | undefined): Record<string, string | undefined> {
  return agent ? { SSH_AUTH_SOCK: agent.socket } : {};
}

/**
 * The variables an agent shell or a terminal adds to its environment: the relay's, its helper pair appended after the
 * pairs base already holds, and SSH_AUTH_SOCK from agent, a value of undefined removing the variable.
 */
export function spawnCredentialVariables(base: Readonly<Record<string, string | undefined>>, relay: CredentialRelay | undefined, agent: SpawnAgent | undefined): Record<string, string | undefined> {
  const variables = agentVariables(agent);
  if (!relay) return variables;
  const index = inheritedPairs(base);
  const [key, value] = relayHelperConfig(relay);
  return { ...variables, ...relayVariables(relay), GIT_CONFIG_COUNT: String(index + 1), [`GIT_CONFIG_KEY_${index}`]: key, [`GIT_CONFIG_VALUE_${index}`]: value };
}

export interface RelayedPasswords {
  answered(fields: GitCredentialFields, password: string): void;
  // true, once, when passwordHash is the SHA-256 of the password last answered for the fields' credential host
  refused(fields: GitCredentialFields, passwordHash: string): boolean;
}

/**
 * The hash of the password the relay last answered per credential host. git sends erase to every helper, also when one of
 * the target's own supplied the refused credential, so only an erase naming this password reaches the client.
 */
export function createRelayedPasswords(): RelayedPasswords {
  const hashes = new Map<string, Buffer>();
  const keyOf = (fields: GitCredentialFields): string => `${fields.protocol}://${fields.host.toLowerCase()}`;
  return {
    answered: (fields, password) => {
      hashes.set(keyOf(fields), createHash('sha256').update(password, 'utf8').digest());
    },
    refused: (fields, passwordHash) => {
      const key = keyOf(fields);
      const answered = hashes.get(key);
      const named = Buffer.from(passwordHash, 'hex');
      if (answered === undefined || named.length !== answered.length || !timingSafeEqual(answered, named)) return false;
      hashes.delete(key);
      return true;
    },
  };
}

let installed: (() => CredentialRelay | undefined) | undefined;

/** Set by a daemon's core and cleared when it closes: read answers the relay while core's askpass server listens; a local core never relays. */
export function installCredentialRelay(read: (() => CredentialRelay | undefined) | undefined): void {
  installed = read;
}

export function installedCredentialRelay(): CredentialRelay | undefined {
  return installed?.();
}
