import { describe, expect, it } from 'vitest';
import { INVALID } from '../schema';
import { MAIN_TO_CORE, parseClientValues } from '../messages';
import { MAX_PLAN_MODEL_ID_CHARS, MAX_PLAN_MODEL_IDS, planModelIdsOf } from '../../../shared/remote-user';

describe('the clientAuth snapshot', () => {
  it('carries no secret field and no absolute time: the wire parser keeps only the named non-secret fields', () => {
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

  // A remote chat's key status counts a key the client saved even while its sign-in outranks it, which hasKey does not say.
  it('carries whether a key provider key is saved, optionally, in both snapshots, and refuses a value that is not a boolean', () => {
    const entry = { type: 'oauth', hasKey: false, flatFee: false };
    expect(parseClientValues.clientAuth({ providers: { xai: { ...entry, keySaved: true } } })).toEqual({ providers: { xai: { ...entry, keySaved: true } } });
    expect(MAIN_TO_CORE.requests['user.clientAuth'].result({ providers: { xai: { ...entry, keySaved: false } } })).toEqual({ providers: { xai: { ...entry, keySaved: false } } });
    expect(parseClientValues.clientAuth({ providers: { xai: entry } })).toEqual({ providers: { xai: entry } });
    expect(parseClientValues.clientAuth({ providers: { xai: { ...entry, keySaved: 'yes' } } })).toBe(INVALID);
    expect(MAIN_TO_CORE.requests['user.clientAuth'].result({ providers: { xai: { ...entry, keySaved: 1 } } })).toBe(INVALID);
  });

  // A remote chat marks the acting client's models outside its plan, so the list crosses in both snapshots, bounded.
  it('carries a sign-in\'s plan model list in both snapshots, up to 512 ids of at most 128 characters', () => {
    const entry = { type: 'oauth', hasKey: false, flatFee: false };
    const ids = Array.from({ length: MAX_PLAN_MODEL_IDS }, (_, i) => `m${i}`.padEnd(MAX_PLAN_MODEL_ID_CHARS, 'x'));
    const sent = { providers: { 'github-copilot': { ...entry, expiresIn: 1, availableModelIds: ids } } };
    const held = { providers: { 'github-copilot': { ...entry, expires: 9, availableModelIds: ids } } };
    expect(parseClientValues.clientAuth(sent)).toEqual(sent);
    expect(MAIN_TO_CORE.requests['user.clientAuth'].result(held)).toEqual(held);
    const tooMany = { providers: { 'github-copilot': { ...entry, expiresIn: 1, availableModelIds: [...ids, 'one-more'] } } };
    const tooLong = { providers: { 'github-copilot': { ...entry, expiresIn: 1, availableModelIds: ['x'.repeat(MAX_PLAN_MODEL_ID_CHARS + 1)] } } };
    expect(parseClientValues.clientAuth(tooMany)).toBe(INVALID);
    expect(parseClientValues.clientAuth(tooLong)).toBe(INVALID);
    expect(MAIN_TO_CORE.requests['user.clientAuth'].result({ providers: { 'github-copilot': { ...entry, availableModelIds: [...ids, 'one-more'] } } })).toBe(INVALID);
    for (const list of [[''], ['ok', 7]]) {
      expect(parseClientValues.clientAuth({ providers: { 'github-copilot': { ...entry, expiresIn: 1, availableModelIds: list } } })).toBe(INVALID);
    }
  });

  // A refused value closes the channel, so the parser takes exactly the lists planModelIdsOf keeps.
  it('takes exactly the plan lists planModelIdsOf keeps, in both snapshots', () => {
    const entry = { type: 'oauth', hasKey: false, flatFee: false, expiresIn: 1 };
    const tooMany = Array.from({ length: MAX_PLAN_MODEL_IDS + 1 }, (_, i) => `m${i}`);
    for (const list of [['gpt-6-luna'], [], tooMany, ['x'.repeat(MAX_PLAN_MODEL_ID_CHARS + 1)], [''], ['ok', 7]]) {
      const parsed = parseClientValues.clientAuth({ providers: { 'github-copilot': { ...entry, availableModelIds: list } } });
      expect(parsed !== INVALID, JSON.stringify(list).slice(0, 40)).toBe(planModelIdsOf(list) !== undefined);
    }
  });
});

describe('a broker answer from this computer\'s core', () => {
  const answer = { type: 'oauth', access: 'a', expiresIn: 1, refresh: '' };
  const parse = (value: unknown) => MAIN_TO_CORE.requests['user.resolveCredential'].result(value);

  it('takes exactly the plan lists planModelIdsOf keeps', () => {
    const tooMany = Array.from({ length: MAX_PLAN_MODEL_IDS + 1 }, (_, i) => `m${i}`);
    for (const list of [['gpt-6-luna'], ['x'.repeat(MAX_PLAN_MODEL_ID_CHARS)], tooMany, ['x'.repeat(MAX_PLAN_MODEL_ID_CHARS + 1)], [''], ['ok', 7]]) {
      expect(parse({ ...answer, availableModelIds: list }) !== INVALID, JSON.stringify(list).slice(0, 40)).toBe(planModelIdsOf(list) !== undefined);
    }
  });
});
