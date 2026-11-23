// The community store list's signing keys (docs/invariants.md "Desktop themes"). A compromised key is removed in a release
// and `next` is promoted to `current`. The current private key lives only in the themes repo's store-signing environment;
// the next one stays offline with the maintainer until it is promoted.
import { createHash, createPublicKey, type KeyObject } from 'node:crypto';

export interface StoreKey {
  // the first 16 hex characters of the SHA-256 of the key's SPKI DER
  readonly keyId: string;
  readonly spkiPem: string;
}

export const STORE_KEYS: { readonly current: StoreKey; readonly next?: StoreKey } = {
  current: {
    keyId: '187953e23cec5c03',
    spkiPem: '-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEA7ATh1wQmPJ+MKCqNWKxnsn2ivJqS/8zgxS2TYnvBVXc=\n-----END PUBLIC KEY-----\n',
  },
  next: {
    keyId: '822af0c838fe5f14',
    spkiPem: '-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEAmhHIDYjfd6WMTn/yoDjQagWQbvznkdq/K+DrEIyDcJ4=\n-----END PUBLIC KEY-----\n',
  },
};

/** The keyId of an Ed25519 public key in SPKI PEM; throws for a key of another type. */
export function keyIdOf(spkiPem: string): string {
  const key = createPublicKey(spkiPem);
  if (key.asymmetricKeyType !== 'ed25519') throw new Error(`A store key must be Ed25519, not ${key.asymmetricKeyType ?? 'unknown'}`);
  return createHash('sha256').update(key.export({ type: 'spki', format: 'der' })).digest('hex').slice(0, 16);
}

/**
 * The keys a store list may be signed with, by keyId. `e2eTestKeyPem` is the e2e hooks' test key, which the caller passes only
 * when CoreInit.e2eHooks is on.
 */
export function trustedStoreKeys(e2eTestKeyPem?: string): ReadonlyMap<string, KeyObject> {
  const keys = new Map<string, KeyObject>();
  for (const key of [STORE_KEYS.current, STORE_KEYS.next]) {
    if (key === undefined) continue;
    if (keyIdOf(key.spkiPem) !== key.keyId) throw new Error(`Store key ${key.keyId} does not match its public key`);
    keys.set(key.keyId, createPublicKey(key.spkiPem));
  }
  if (e2eTestKeyPem !== undefined) keys.set(keyIdOf(e2eTestKeyPem), createPublicKey(e2eTestKeyPem));
  return keys;
}
