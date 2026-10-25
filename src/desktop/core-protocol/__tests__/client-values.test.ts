import { describe, expect, it } from 'vitest';
import { MAIN_TO_CORE, parseClientValues } from '../messages';

describe('the clientAuth snapshot', () => {
  it('carries no secret field and no absolute time: the wire parser keeps type, expiresIn, hasKey, flatFee and allowance only', () => {
    const parsed = parseClientValues.clientAuth({
      providers: { anthropic: { type: 'oauth', expiresIn: 1, expires: 9, hasKey: false, flatFee: true, access: 'SECRET', refresh: 'SECRET', key: 'SECRET' } },
    });
    expect(parsed).toEqual({ providers: { anthropic: { type: 'oauth', expiresIn: 1, hasKey: false, flatFee: true } } });
  });

  it('keeps whether the client bills a Claude sign-in to the allowance, in the snapshot main reads and in the mirror a daemon gets', () => {
    const entry = { type: 'oauth', hasKey: false, flatFee: false, allowance: true };
    expect(parseClientValues.clientAuth({ providers: { anthropic: { ...entry, expiresIn: 1 } } })).toEqual({ providers: { anthropic: { ...entry, expiresIn: 1 } } });
    expect(MAIN_TO_CORE.requests['user.clientAuth'].result({ providers: { anthropic: { ...entry, expires: 9 } } })).toEqual({ providers: { anthropic: { ...entry, expires: 9 } } });
  });
});
