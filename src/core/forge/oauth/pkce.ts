import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

// PKCE (RFC 7636) S256 and the OAuth state, after VS Code's github-authentication flows.ts 121-146 (MIT).

/** 32 random bytes, base64url: a code verifier (43 characters, inside RFC 7636's 43-128) or a state. */
export function randomToken(): string {
  return randomBytes(32).toString('base64url');
}

export function codeChallenge(verifier: string): string {
  return createHash('sha256').update(verifier, 'ascii').digest('base64url');
}

export interface Pkce {
  readonly verifier: string;
  readonly challenge: string;
}

export function createPkce(): Pkce {
  const verifier = randomToken();
  return { verifier, challenge: codeChallenge(verifier) };
}

/** Compares two strings in constant time over their SHA-256 digests, so neither length nor content leaks through timing. */
export function sameSecret(a: string, b: string): boolean {
  const left = createHash('sha256').update(a, 'utf8').digest();
  const right = createHash('sha256').update(b, 'utf8').digest();
  return timingSafeEqual(left, right);
}
