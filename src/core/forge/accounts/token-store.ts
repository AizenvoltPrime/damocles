import { createHash } from 'node:crypto';
import type { SecretsStore } from '../../../platform/secrets-store';
import type { TokenSet } from '../types';

// Forge secrets in SecretsStore (docs/invariants.md "GitHub and GitLab accounts", storage). Keys hold a hash of the id, so
// a key list names no account or server.

const sha256 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

export function accountSecretKey(accountId: string): string {
  return `damocles.forge.account.${sha256(accountId)}`;
}

export function serverSecretKey(serverId: string): string {
  return `damocles.forge.server.${sha256(serverId)}.clientSecret`;
}

function parseTokenSet(text: string): TokenSet | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof raw !== 'object' || raw === null) return undefined;
  const record = raw as Record<string, unknown>;
  const { access, refresh, accessExpiresAt, refreshExpiresAt, tokenType } = record;
  if (typeof access !== 'string' || access === '' || (tokenType !== 'oauth' && tokenType !== 'personal')) return undefined;
  return {
    access,
    tokenType,
    ...(typeof refresh === 'string' && refresh !== '' ? { refresh } : {}),
    ...(typeof accessExpiresAt === 'number' ? { accessExpiresAt } : {}),
    ...(typeof refreshExpiresAt === 'number' ? { refreshExpiresAt } : {}),
  };
}

export interface TokenStore {
  /** Undefined: no secret, or one this run cannot read (a volatile store after a restart). */
  get(accountId: string): Promise<TokenSet | undefined>;
  /** Writes both tokens of a rotation together. */
  set(accountId: string, tokens: TokenSet): Promise<void>;
  delete(accountId: string): Promise<void>;
  getClientSecret(serverId: string): Promise<string | undefined>;
  setClientSecret(serverId: string, secret: string | undefined): Promise<void>;
}

export function createTokenStore(secrets: SecretsStore, log: (line: string) => void): TokenStore {
  return {
    async get(accountId) {
      const text = await secrets.get(accountSecretKey(accountId));
      if (text === undefined) return undefined;
      const tokens = parseTokenSet(text);
      if (!tokens) log('[forge] an account secret does not parse; the account must sign in again');
      return tokens;
    },
    set: (accountId, tokens) => secrets.store(accountSecretKey(accountId), JSON.stringify(tokens)),
    delete: (accountId) => secrets.delete(accountSecretKey(accountId)),
    getClientSecret: (serverId) => secrets.get(serverSecretKey(serverId)),
    setClientSecret: (serverId, secret) => (secret === undefined ? secrets.delete(serverSecretKey(serverId)) : secrets.store(serverSecretKey(serverId), secret)),
  };
}
