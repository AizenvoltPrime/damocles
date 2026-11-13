import { describe, expect, it } from 'vitest';
import { codeChallenge, createPkce, randomToken, sameSecret } from '../oauth/pkce';

describe('PKCE S256', () => {
  it('matches RFC 7636 appendix B', () => {
    expect(codeChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
  });

  it('makes a 43-character unreserved verifier and its unpadded challenge, fresh each time', () => {
    const pkce = createPkce();
    expect(pkce.verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(pkce.challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(pkce.challenge).toBe(codeChallenge(pkce.verifier));
    expect(createPkce().verifier).not.toBe(pkce.verifier);
    expect(randomToken()).not.toBe(randomToken());
  });

  it('compares state values whatever their lengths', () => {
    const state = randomToken();
    expect(sameSecret(state, state)).toBe(true);
    expect(sameSecret(state, `${state}x`)).toBe(false);
    expect(sameSecret(state, '')).toBe(false);
  });
});
