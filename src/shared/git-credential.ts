// The git credential relay's fields and answer as they cross from a target's core to this computer (D16, D20). git's
// credential protocol is `key=value` lines, so a line break or NUL in any value could add a key: every hop refuses one.

// a host name of 253 characters, a colon and a port
export const MAX_CREDENTIAL_HOST_CHARS = 259;
export const MAX_CREDENTIAL_PATH_CHARS = 4096;
export const MAX_CREDENTIAL_USERNAME_CHARS = 256;
export const MAX_CREDENTIAL_PASSWORD_CHARS = 4096;
// git's own protocol names are short; the relay accepts https only, and main checks that
export const MAX_CREDENTIAL_PROTOCOL_CHARS = 32;

// The SHA-256 of the password an erase names, lowercase hex: the relay compares it with what it answered, never the password.
export const PASSWORD_HASH: RegExp = /^[0-9a-f]{64}$/;

// What the target's git asked for; never a password.
export interface GitCredentialFields {
  readonly protocol: string;
  readonly host: string;
  readonly path?: string;
  readonly username?: string;
}

// notConnected: no client is attached, which the relay tells git on stderr
export type GitCredentialAnswer =
  | { readonly kind: 'credential'; readonly username: string; readonly password: string }
  | { readonly kind: 'none' }
  | { readonly kind: 'notConnected' };

export function isCredentialValue(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length <= max && !/[\0\r\n]/.test(value);
}

/** The fields, exactly protocol, host and optional path and username, each within its bound; undefined otherwise. */
export function parseCredentialFields(raw: unknown): GitCredentialFields | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined;
  const value = raw as Record<string, unknown>;
  const allowed = new Set(['protocol', 'host', 'path', 'username']);
  if (!Object.keys(value).every((key) => allowed.has(key))) return undefined;
  const { protocol, host, path, username } = value;
  if (!isCredentialValue(protocol, MAX_CREDENTIAL_PROTOCOL_CHARS) || protocol === '') return undefined;
  if (!isCredentialValue(host, MAX_CREDENTIAL_HOST_CHARS) || host === '') return undefined;
  if (path !== undefined && !isCredentialValue(path, MAX_CREDENTIAL_PATH_CHARS)) return undefined;
  if (username !== undefined && !isCredentialValue(username, MAX_CREDENTIAL_USERNAME_CHARS)) return undefined;
  return { protocol, host, ...(path !== undefined ? { path } : {}), ...(username !== undefined ? { username } : {}) };
}
