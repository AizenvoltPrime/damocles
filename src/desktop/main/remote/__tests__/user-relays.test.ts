import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MAX_BROKER_EXPIRES_IN_MS, MAX_PLAN_MODEL_ID_CHARS, MAX_PLAN_MODEL_IDS, type BrokerAnswer, type HeldAuth } from '../../../../shared/remote-user';
import { brokerAnswerOf, checkProvider, clientAuthOf, clientUserOf, UserRelays, type UserRelaysDeps } from '../user-relays';

const KNOWN: HeldAuth = { providers: { anthropic: { type: 'oauth', expires: 1, hasKey: false, flatFee: false }, openai: { type: 'api_key', hasKey: true, flatFee: false } } };

describe('brokerAnswerOf', () => {
  it('keeps exactly the three answer types, field by field', () => {
    expect(brokerAnswerOf({ type: 'none', key: 'leak' })).toEqual({ type: 'none' });
    expect(brokerAnswerOf({ type: 'api_key', key: 'sk-1', refresh: 'r', extra: 1 })).toEqual({ type: 'api_key', key: 'sk-1' });
    expect(brokerAnswerOf({ type: 'oauth', access: 'a', expiresIn: 1000, refresh: '', accountId: 'acct', scopes: ['x'], id_token: 'secret' }))
      .toEqual({ type: 'oauth', access: 'a', expiresIn: 1000, refresh: '', accountId: 'acct', scopes: ['x'] });
    expect(() => brokerAnswerOf({ type: 'refresh' })).toThrow('unknown type');
    expect(() => brokerAnswerOf(null)).toThrow('not an object');
  });

  it('refuses a non-empty refresh token', () => {
    expect(() => brokerAnswerOf({ type: 'oauth', access: 'a', expiresIn: 1, refresh: 'rt' })).toThrow('refresh token');
    expect(() => brokerAnswerOf({ type: 'oauth', access: 'a', expiresIn: 1 })).toThrow('refresh token');
  });

  it('bounds expiresIn: finite, non-negative, clamped to the broker maximum', () => {
    expect(() => brokerAnswerOf({ type: 'oauth', access: 'a', expiresIn: -1, refresh: '' })).toThrow('expiresIn');
    expect(() => brokerAnswerOf({ type: 'oauth', access: 'a', expiresIn: Number.NaN, refresh: '' })).toThrow('expiresIn');
    expect(() => brokerAnswerOf({ type: 'oauth', access: 'a', expiresIn: '5', refresh: '' })).toThrow('expiresIn');
    const answer = brokerAnswerOf({ type: 'oauth', access: 'a', expiresIn: Number.MAX_SAFE_INTEGER, refresh: '' }) as Extract<BrokerAnswer, { type: 'oauth' }>;
    expect(answer.expiresIn).toBe(MAX_BROKER_EXPIRES_IN_MS);
  });

  it('refuses empty or unbounded secret strings and unbounded extras', () => {
    expect(() => brokerAnswerOf({ type: 'api_key', key: '' })).toThrow('bounded');
    expect(() => brokerAnswerOf({ type: 'api_key', key: 'k'.repeat(64 * 1024 + 1) })).toThrow('bounded');
    expect(() => brokerAnswerOf({ type: 'oauth', access: 'a', expiresIn: 1, refresh: '', clientId: 7 })).toThrow('clientId');
    expect(() => brokerAnswerOf({ type: 'oauth', access: 'a', expiresIn: 1, refresh: '', scopes: Array.from({ length: 600 }, () => 's') })).toThrow('scopes');
  });

  // One rule with every other reader and sender of the list, so its bounds can move in one place.
  it('keeps a plan model list exactly when planModelIdsOf does, and refuses any other', () => {
    const oauth = { type: 'oauth', access: 'a', expiresIn: 1, refresh: '' };
    const fits = Array.from({ length: MAX_PLAN_MODEL_IDS }, (_, i) => `m${i}`.padEnd(MAX_PLAN_MODEL_ID_CHARS, 'x'));
    expect(brokerAnswerOf({ ...oauth, availableModelIds: fits })).toEqual({ ...oauth, availableModelIds: fits });
    for (const ids of [[...fits, 'one-more'], ['x'.repeat(MAX_PLAN_MODEL_ID_CHARS + 1)], [''], ['gpt-6-luna', 7], 'gpt-6-luna']) {
      expect(() => brokerAnswerOf({ ...oauth, availableModelIds: ids })).toThrow('availableModelIds');
    }
  });
});

describe('checkProvider', () => {
  it('allows only a provider this computer lists', () => {
    expect(() => checkProvider('anthropic', KNOWN)).not.toThrow();
    expect(() => checkProvider('evil', KNOWN)).toThrow('not a provider this computer knows');
    expect(() => checkProvider('__proto__', KNOWN)).toThrow();
    expect(() => checkProvider('../x', KNOWN)).toThrow();
  });
});

describe('clientAuthOf', () => {
  it('keeps type, OAuth expiry, hasKey, flatFee and allowance, never a token or key', () => {
    const raw = { providers: { anthropic: { type: 'oauth', expires: 5, hasKey: false, flatFee: 'yes', access: 'a', refresh: 'r' }, minimax: { type: 'api_key', hasKey: true, flatFee: true, key: 'sk-cp-1' } } } as unknown as HeldAuth;
    expect(clientAuthOf(raw)).toEqual({ providers: { anthropic: { type: 'oauth', expires: 5, hasKey: false, flatFee: false }, minimax: { type: 'api_key', hasKey: true, flatFee: true } } });
  });

  it('keeps keySaved when the client said it, as a boolean, and adds none when it did not', () => {
    const raw = { providers: { xai: { type: 'oauth', hasKey: false, keySaved: true, flatFee: false }, deepseek: { type: 'none', hasKey: false, keySaved: false, flatFee: false }, meta: { type: 'none', hasKey: false, keySaved: 'yes', flatFee: false }, minimax: { type: 'none', hasKey: true, flatFee: false } } } as unknown as HeldAuth;
    expect(clientAuthOf(raw)).toEqual({ providers: {
      xai: { type: 'oauth', hasKey: false, keySaved: true, flatFee: false },
      deepseek: { type: 'none', hasKey: false, keySaved: false, flatFee: false },
      meta: { type: 'none', hasKey: false, flatFee: false },
      minimax: { type: 'none', hasKey: true, flatFee: false },
    } });
  });

  it('keeps preferApiKey only when the client said true', () => {
    const raw = { providers: { openai: { type: 'oauth', hasKey: true, flatFee: false, preferApiKey: true }, xai: { type: 'none', hasKey: true, flatFee: false, preferApiKey: 'yes' }, deepseek: { type: 'none', hasKey: true, flatFee: false, preferApiKey: false } } } as unknown as HeldAuth;
    expect(clientAuthOf(raw)).toEqual({ providers: {
      openai: { type: 'oauth', hasKey: true, flatFee: false, preferApiKey: true },
      xai: { type: 'none', hasKey: true, flatFee: false },
      deepseek: { type: 'none', hasKey: true, flatFee: false },
    } });
  });

  it('keeps allowance only on an OAuth sign-in', () => {
    const raw = { providers: { anthropic: { type: 'oauth', hasKey: false, flatFee: false, allowance: true }, deepseek: { type: 'api_key', hasKey: true, flatFee: false, allowance: true } } } as HeldAuth;
    expect(clientAuthOf(raw)).toEqual({ providers: { anthropic: { type: 'oauth', hasKey: false, flatFee: false, allowance: true }, deepseek: { type: 'api_key', hasKey: true, flatFee: false } } });
  });

  // A daemon's core gates as this computer's does: a list the wire cannot carry whole is no list there, as it is here.
  it('sends an OAuth sign-in\'s plan model list whole, or no list when it is outside the wire\'s bounds', () => {
    const fits = Array.from({ length: MAX_PLAN_MODEL_IDS }, (_, i) => `m${i}`);
    const sent = (ids: unknown) =>
      clientAuthOf({ providers: { 'github-copilot': { type: 'oauth', hasKey: false, flatFee: false, availableModelIds: ids } } } as unknown as HeldAuth).providers['github-copilot'];
    expect(sent(fits)?.availableModelIds).toEqual(fits);
    for (const ids of [[...fits, 'one-more'], ['x'.repeat(MAX_PLAN_MODEL_ID_CHARS + 1)], [''], ['gpt-6-luna', 7]]) {
      expect(sent(ids)).toEqual({ type: 'oauth', hasKey: false, flatFee: false });
    }
    const keyOnly = clientAuthOf({ providers: { xai: { type: 'api_key', hasKey: true, flatFee: false, availableModelIds: ['grok-4.7'] } } } as unknown as HeldAuth).providers;
    expect(keyOnly['xai']).toEqual({ type: 'api_key', hasKey: true, flatFee: false });
  });
});

describe('clientUserOf', () => {
  it('carries only the permission rules and the given setting values, never env, apiKeyHelper, hooks or tokens', () => {
    const files = [
      { dir: '.damocles' as const, settings: { permissions: { allow: ['Bash(npm test)'], deny: ['Read(./.env)', 3], ask: [], defaultMode: 'bypassPermissions', additionalDirectories: ['/'] }, env: { ANTHROPIC_API_KEY: 'LEAK-ENV' }, apiKeyHelper: 'LEAK-HELPER', hooks: { PreToolUse: ['LEAK-HOOK'] } } },
      { dir: '.claude' as const, settings: { permissions: { ask: ['Bash(git push:*)'] }, oauthToken: 'LEAK-TOKEN' } },
    ];
    const user = clientUserOf(files, new Map<string, unknown>([['damocles.language', 'el'], ['damocles.unset', undefined]]));
    expect(user).toEqual({ settings: { 'damocles.language': 'el' }, permissionRules: [{ allow: ['Bash(npm test)'], ask: [], deny: ['Read(./.env)'], dir: '.damocles' }, { allow: [], ask: ['Bash(git push:*)'], deny: [], dir: '.claude' }] });
    const text = JSON.stringify(user);
    for (const leak of ['LEAK-', 'ANTHROPIC_API_KEY', 'apiKeyHelper', 'PreToolUse', 'oauthToken', 'bypassPermissions', 'additionalDirectories']) expect(text).not.toContain(leak);
  });
});

describe('clientUserOf per file', () => {
  it('keeps the lists of each file apart, so a carve-out never reaches the deny of another', () => {
    const user = clientUserOf([
      { dir: '.damocles', settings: { permissions: { deny: ['Bash(rm:*)'] } } },
      { dir: '.claude', settings: { permissions: {} } },
      { dir: '.claude', settings: { permissions: { deny: ['!Bash(rm:*)'], ask: ['Bash(git push:*)'] } } },
    ], new Map());
    expect(user.permissionRules).toEqual([
      { allow: [], ask: [], deny: ['Bash(rm:*)'], dir: '.damocles' },
      { allow: [], ask: ['Bash(git push:*)'], deny: ['!Bash(rm:*)'], dir: '.claude' },
    ]);
  });
});

describe('UserRelays', () => {
  const homes: string[] = [];
  afterEach(async () => {
    for (const home of homes.splice(0)) await fs.rm(home, { recursive: true, force: true });
  });

  async function relays(overrides: Partial<UserRelaysDeps> = {}): Promise<{ relays: UserRelays; lines: string[] }> {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'user-relays-'));
    homes.push(home);
    await fs.mkdir(path.join(home, '.claude'));
    await fs.writeFile(path.join(home, '.claude', 'settings.json'), JSON.stringify({ permissions: { deny: ['Bash(rm:*)'] }, env: { TOKEN: 'x' } }));
    const lines: string[] = [];
    return {
      relays: new UserRelays({
        resolveCredential: async () => ({ type: 'oauth', access: 'a', expiresIn: 60_000, refresh: '' }),
        clientAuth: async () => KNOWN,
        voice: true,
        homedir: home,
        userSettingKeys: () => ['damocles.language'],
        userValue: () => 'en',
        hostPolicy: () => ({ allowBypass: false }),
        log: (line) => lines.push(line),
        ...overrides,
      }),
      lines,
    };
  }

  it('answers a known provider with this computer\'s checked credential, logging the provider and never the secret', async () => {
    const { relays: user, lines } = await relays();
    await expect(user.credentials('loopback', 'anthropic')).resolves.toEqual({ type: 'oauth', access: 'a', expiresIn: 60_000, refresh: '' });
    await expect(user.credentials('loopback', 'evil')).rejects.toThrow('not a provider');
    expect(lines).toEqual(['[remote] user.credentials anthropic for loopback']);
  });

  it('judges an ask that arrives while the local core start\'s sign-in read is under way against that read, never the empty snapshot', async () => {
    let loaded: ((auth: HeldAuth) => void) | undefined;
    const { relays: user } = await relays({ clientAuth: () => new Promise<HeldAuth>((resolve) => { loaded = resolve; }) });
    // the local core became ready and its runtime is still loading this computer's sign-ins
    const startup = user.authChanged();
    await vi.waitFor(() => expect(loaded).toBeDefined());
    const asked = user.credentials('ssh+h1', 'openai');
    loaded!(KNOWN);
    await startup;
    await expect(asked).resolves.toEqual({ type: 'oauth', access: 'a', expiresIn: 60_000, refresh: '' });
  });

  it('refuses an answer the local core sent with a refresh token', async () => {
    const { relays: user } = await relays({ resolveCredential: async () => ({ type: 'oauth', access: 'a', expiresIn: 1, refresh: 'rt' }) as unknown as BrokerAnswer });
    await expect(user.credentials('loopback', 'anthropic')).rejects.toThrow('refresh token');
  });

  it('starts each attach from its values and publishes later changes to every attach, with YOLO refused', async () => {
    const { relays: user } = await relays();
    const published: Array<[string, unknown]> = [];
    const attach = user.attach((topic, value) => published.push([topic, value]), 'ssh+h1', false);
    expect(attach.mirrors.clientPolicy).toEqual({ voice: true, allowBypass: false });
    // a host on this computer reaches this computer's loopback endpoints
    expect(user.attach(() => undefined, 'loopback', true).mirrors.clientPolicy).toEqual({ voice: true, allowBypass: false, sharedLoopback: true });
    await user.authChanged();
    await user.userChanged();
    expect(published).toEqual([
      ['clientAuth', { providers: { anthropic: { type: 'oauth', expiresIn: 0, hasKey: false, flatFee: false }, openai: { type: 'api_key', hasKey: true, flatFee: false } } }],
      ['clientUser', { settings: { 'damocles.language': 'en' }, permissionRules: [{ allow: [], ask: [], deny: ['Bash(rm:*)'], dir: '.claude' }] }],
    ]);
    await user.authChanged();
    expect(published).toHaveLength(2);
    attach.subscription.dispose();
    await user.userChanged();
    expect(published).toHaveLength(2);
  });

  it('gives each attach its host\'s configured policy and publishes a change only to that host\'s attaches', async () => {
    const settings = new Map<string, { allowBypass: boolean; defaultPermissionMode?: 'plan' | 'acceptEdits'; agentForwarding?: boolean }>([
      ['ssh+prod', { allowBypass: false, defaultPermissionMode: 'plan' }],
      ['ssh+dev', { allowBypass: true, agentForwarding: true }],
    ]);
    const { relays: user } = await relays({ hostPolicy: (authority) => settings.get(authority) ?? { allowBypass: false } });
    const prod: Array<[string, unknown]> = [];
    const dev: Array<[string, unknown]> = [];
    expect(user.attach((topic, value) => prod.push([topic, value]), 'ssh+prod', false).mirrors.clientPolicy).toEqual({ voice: true, allowBypass: false, defaultPermissionMode: 'plan' });
    expect(user.attach((topic, value) => dev.push([topic, value]), 'ssh+dev', false).mirrors.clientPolicy).toEqual({ voice: true, allowBypass: true, agentForwarding: true });
    settings.set('ssh+prod', { allowBypass: true, defaultPermissionMode: 'acceptEdits' });
    user.policyChanged('ssh+prod');
    // an unchanged policy publishes nothing
    user.policyChanged('ssh+dev');
    expect(prod).toEqual([['clientPolicy', { voice: true, allowBypass: true, defaultPermissionMode: 'acceptEdits' }]]);
    expect(dev).toEqual([]);
  });

  it('publishes the snapshot read last when refreshes overlap, however their reads finish', async () => {
    const older: HeldAuth = { providers: { anthropic: { type: 'api_key', hasKey: true, flatFee: false } } };
    const newer: HeldAuth = { providers: { openai: { type: 'api_key', hasKey: true, flatFee: false } } };
    let current = older;
    const reads: Array<() => void> = [];
    const { relays: user } = await relays({
      clientAuth: () => {
        const snapshot = current;
        return new Promise((resolve) => reads.push(() => resolve(snapshot)));
      },
    });
    const published: unknown[] = [];
    user.attach((_topic, value) => published.push(value), 'ssh+h1', false);
    let settled = 0;
    const first = user.authChanged().then(() => settled++);
    current = newer;
    const second = user.authChanged().then(() => settled++);
    // the newest read in flight answers first, as when the earlier one is slow
    while (settled < 2) {
      reads.pop()?.();
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    await Promise.all([first, second]);
    expect(published.at(-1)).toEqual({ providers: { openai: { type: 'api_key', hasKey: true, flatFee: false } } });
  });

  it('sends each OAuth expiry as the ms left on this computer\'s clock, never the time itself', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000_000);
    const held: HeldAuth = { providers: { anthropic: { type: 'oauth', expires: 1_000_000 + 3_600_000, hasKey: false, flatFee: false } } };
    const { relays: user } = await relays({ clientAuth: async () => held });
    const published: unknown[] = [];
    user.attach((_topic, value) => published.push(value), 'ssh+h1', false);
    await user.authChanged();
    now.mockReturnValue(1_000_000 + 60_000);
    expect(user.attach(() => undefined, 'ssh+h1', false).mirrors.clientAuth).toEqual({ providers: { anthropic: { type: 'oauth', expiresIn: 3_540_000, hasKey: false, flatFee: false } } });
    expect(published).toEqual([{ providers: { anthropic: { type: 'oauth', expiresIn: 3_600_000, hasKey: false, flatFee: false } } }]);
    now.mockRestore();
  });
});
