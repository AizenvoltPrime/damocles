import { describe, expect, it } from 'vitest';
import { INVALID } from '../schema';
import { CORE_TO_MAIN, MAIN_TO_CORE, parseClientValues } from '../messages';
import { brokerEnvOf, MAX_BROKER_ENV_NAME_CHARS, MAX_BROKER_ENV_VALUE_CHARS, MAX_BROKER_ENV_VARS, MAX_PLAN_MODEL_ID_CHARS, MAX_PLAN_MODEL_IDS, planModelIdsOf } from '../../../shared/remote-user';

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

  // Each device's views of a remote chat show that device's own prefer-API-key choice.
  it('carries whether the client prefers its saved key, optionally, in both snapshots, and refuses a value that is not a boolean', () => {
    const entry = { type: 'oauth', hasKey: true, flatFee: false };
    expect(parseClientValues.clientAuth({ providers: { openai: { ...entry, preferApiKey: true } } })).toEqual({ providers: { openai: { ...entry, preferApiKey: true } } });
    expect(MAIN_TO_CORE.requests['user.clientAuth'].result({ providers: { xai: { ...entry, preferApiKey: true } } })).toEqual({ providers: { xai: { ...entry, preferApiKey: true } } });
    expect(parseClientValues.clientAuth({ providers: { openai: { ...entry, preferApiKey: 'yes' } } })).toBe(INVALID);
    expect(MAIN_TO_CORE.requests['user.clientAuth'].result({ providers: { xai: { ...entry, preferApiKey: 1 } } })).toBe(INVALID);
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

  it('takes an API key\'s env exactly when brokerEnvOf keeps it, toward main and toward a daemon\'s core', () => {
    const relayed = (value: unknown) => CORE_TO_MAIN.requests['user.credentials'].result(value);
    const key = { type: 'api_key', key: 'cf-key' };
    const fits = Object.fromEntries(Array.from({ length: MAX_BROKER_ENV_VARS }, (_, i) => [`VAR_${i}`.padEnd(MAX_BROKER_ENV_NAME_CHARS, 'X'), 'v'.repeat(MAX_BROKER_ENV_VALUE_CHARS)]));
    expect(parse({ ...key, env: { CLOUDFLARE_ACCOUNT_ID: 'acct' } })).toEqual({ ...key, env: { CLOUDFLARE_ACCOUNT_ID: 'acct' } });
    expect(parse(key)).toEqual(key);
    for (const env of [fits, { ...fits, ONE_MORE: 'v' }, { lower_case: 'v' }, { '1LEADING': 'v' }, { ['X'.repeat(MAX_BROKER_ENV_NAME_CHARS + 1)]: 'v' }, { LONG: 'v'.repeat(MAX_BROKER_ENV_VALUE_CHARS + 1) }, { NUMBER: 7 }, ['A'], 'A=b', {}]) {
      const label = JSON.stringify(env).slice(0, 40);
      expect(parse({ ...key, env }) !== INVALID, label).toBe(brokerEnvOf(env) !== undefined);
      expect(relayed({ ...key, env }) !== INVALID, label).toBe(brokerEnvOf(env) !== undefined);
    }
  });
});

describe('the relayed MCP servers a client publishes', () => {
  const server = { name: 'notes', tools: [{ name: 'search', exposure: 'direct' }], resources: false, timeoutMs: 600_000 };

  it('carry each tool\'s config exposure and the server\'s timeout, in the answer main reads and the timeout bounded as a Node timer', () => {
    const servers = MAIN_TO_CORE.requests['user.mcp.servers'].result;
    expect(servers([server])).toEqual([server]);
    expect(servers([{ ...server, tools: [{ name: 'search', exposure: 'hidden' }] }])).toBe(INVALID);
    expect(servers([{ ...server, timeoutMs: 0 }])).toBe(INVALID);
    expect(servers([{ ...server, timeoutMs: 2_147_483_648 }])).toBe(INVALID);
  });
});
