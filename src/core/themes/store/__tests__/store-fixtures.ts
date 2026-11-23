// A throwaway Ed25519 pair and signed store lists for the store tests; never the shipped key.
import { createHash, generateKeyPairSync, sign, type KeyObject } from 'node:crypto';

export interface TestKey { readonly keyId: string; readonly publicPem: string; readonly privateKey: KeyObject; readonly publicKey: KeyObject }

export function testKey(): TestKey {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const keyId = createHash('sha256').update(publicKey.export({ type: 'spki', format: 'der' })).digest('hex').slice(0, 16);
  return { keyId, publicPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(), privateKey, publicKey };
}

export const SEEDS = { background: '#101418', panel: '#151a20', text: '#e6edf3', accent: '#4cc2ff', success: '#3fcf8e', warning: '#f0b429', danger: '#f2555a', info: '#8ab4ff' };
export const SHA_A = 'a'.repeat(64);
export const SHA_B = 'b'.repeat(64);
const DAY = 24 * 60 * 60 * 1000;

export function entry(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'aurora',
    name: 'Aurora',
    author: 'Ada',
    description: 'Northern lights.',
    kinds: ['dark'],
    version: '1.0.0',
    file: { url: 'https://github.com/ada/aurora/releases/download/v1/aurora.damocles-theme', sha256: SHA_A, bytes: 1234 },
    colors: { dark: SEEDS },
    fonts: [{ family: 'Inter', license: 'OFL-1.1' }],
    thumbnails: { dark: [{ panel: 'chat', url: `https://raw.githubusercontent.com/AizenvoltPrime/damocles-themes/main/thumbs/${SHA_B}.webp`, sha256: SHA_B }] },
    licenses: ['CC-BY-4.0'],
    hasCss: false,
    hasLayout: false,
    hasCharacters: false,
    hasMoving: false,
    minAppVersion: '3.8.0',
    ...overrides,
  };
}

export function payload(now: number, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    sequence: 5,
    issuedAt: new Date(now - DAY).toISOString(),
    expiresAt: new Date(now + 29 * DAY).toISOString(),
    entries: [entry()],
    removed: [],
    ...overrides,
  };
}

/** The envelope of `body` (a payload object or its exact text) signed with `key`. */
export function signed(key: TestKey, body: Record<string, unknown> | string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return { format: 1, keyId: key.keyId, payload: text, signature: sign(null, Buffer.from(text, 'utf8'), key.privateKey).toString('base64'), ...overrides };
}
