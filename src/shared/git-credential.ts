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

// notConnected: no client is attached, which the relay tells git on stderr. refused: the helper prints quit=1 and the
// message, so git asks nothing else. delegate: the user's own helpers answer; it crosses only from main to a daemon core,
// since this computer's core runs the delegation itself and answers its helpers credential or none.
export type GitCredentialAnswer =
  | { readonly kind: 'credential'; readonly username: string; readonly password: string }
  | { readonly kind: 'none' }
  | { readonly kind: 'notConnected' }
  | { readonly kind: 'refused'; readonly message: string }
  | { readonly kind: 'delegate' };

export const MAX_REFUSED_MESSAGE_CHARS = 1000;

// A client's managed servers as a daemon's core sees them (feature clientForges): ids, URLs, git hosts and whether an
// account exists; never a login or a token.
export interface ClientForgeServer {
  readonly id: string;
  readonly webUrl: string;
  readonly gitHosts: readonly string[];
  readonly hasAccount: boolean;
}

// pending (feature client.pending): the client has not read its servers yet, so `servers` is empty and never read as none
export interface ClientForges {
  readonly servers: readonly ClientForgeServer[];
  readonly pending?: boolean;
}

// a git host the takeover can name in a credential URL: a lowercase DNS name or IPv4 address and an optional port
export const GIT_HOST: RegExp = /^[a-z0-9.-]+(?::[1-9]\d{0,4})?$/;

export const CLIENT_FORGES_FEATURE = 'clientForges';
export const CREDENTIAL_ORIGIN_FEATURE = 'askpass.credential.origin';

export type GitCredentialOp = 'get' | 'store' | 'erase';

// The helper argument the takeover's entries pass ahead of the operation; only that helper stops git when it cannot answer.
export const TAKEOVER_HELPER_ARG = '--takeover';

// Who asked (docs/invariants.md "GitHub and GitLab accounts", origins and nonces): Damocles' own git call, an agent's shell
// or an integrated terminal; a terminal outside every project has no projectKey. An agent shell's origin is one shell process:
// its tool call, and on a daemon's core the client its turn was pinned to.
export type GitCredentialOrigin =
  | { readonly kind: 'engine'; readonly projectKey?: string; readonly interactive: boolean; readonly presetAccountId?: string }
  | { readonly kind: 'agentShell'; readonly panelId: string; readonly sessionId: string; readonly toolCallId?: string; readonly clientId?: string }
  | { readonly kind: 'terminal'; readonly projectKey?: string };

// What a helper asked for. password: a store's or erase's, sent only by a helper on the answering computer, which needs it
// to delegate the operation; passwordHash: its SHA-256, the only form that crosses to another computer.
export interface GitCredentialRequest {
  readonly op: GitCredentialOp;
  readonly cwd: string;
  readonly fields: GitCredentialFields;
  readonly password?: string;
  readonly passwordHash?: string;
}

const MAX_ORIGIN_ID_CHARS = 4096;

/** An origin as it crossed a process boundary, rebuilt field by field; undefined when it is not one. */
export function parseCredentialOrigin(raw: unknown): GitCredentialOrigin | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined;
  const value = raw as Record<string, unknown>;
  const id = (key: string): string | undefined => {
    const item = value[key];
    return typeof item === 'string' && item !== '' && item.length <= MAX_ORIGIN_ID_CHARS && !/[\0\r\n]/.test(item) ? item : undefined;
  };
  const optional = (key: string): { readonly ok: boolean; readonly value: string | undefined } => (value[key] === undefined ? { ok: true, value: undefined } : { ok: id(key) !== undefined, value: id(key) });
  const allowed = (keys: readonly string[]): boolean => Object.keys(value).every((key) => keys.includes(key));
  switch (value['kind']) {
    case 'engine': {
      const project = optional('projectKey');
      const preset = optional('presetAccountId');
      if (!allowed(['kind', 'projectKey', 'interactive', 'presetAccountId']) || typeof value['interactive'] !== 'boolean' || !project.ok || !preset.ok) return undefined;
      return { kind: 'engine', interactive: value['interactive'], ...(project.value !== undefined ? { projectKey: project.value } : {}), ...(preset.value !== undefined ? { presetAccountId: preset.value } : {}) };
    }
    case 'agentShell': {
      const panelId = id('panelId');
      const sessionId = id('sessionId');
      const toolCallId = optional('toolCallId');
      const clientId = optional('clientId');
      if (!allowed(['kind', 'panelId', 'sessionId', 'toolCallId', 'clientId']) || panelId === undefined || sessionId === undefined || !toolCallId.ok || !clientId.ok) return undefined;
      return { kind: 'agentShell', panelId, sessionId, ...(toolCallId.value !== undefined ? { toolCallId: toolCallId.value } : {}), ...(clientId.value !== undefined ? { clientId: clientId.value } : {}) };
    }
    case 'terminal': {
      const project = optional('projectKey');
      if (!allowed(['kind', 'projectKey']) || !project.ok) return undefined;
      return { kind: 'terminal', ...(project.value !== undefined ? { projectKey: project.value } : {}) };
    }
    default:
      return undefined;
  }
}

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
