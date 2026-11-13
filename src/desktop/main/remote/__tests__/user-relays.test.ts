import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FEATURES } from '../../../../remote/protocol-version';
import { MAX_BROKER_ENV_VALUE_CHARS, MAX_BROKER_ENV_VARS, MAX_BROKER_EXPIRES_IN_MS, MAX_PLAN_MODEL_ID_CHARS, MAX_PLAN_MODEL_IDS, type BrokerAnswer, type HeldAuth } from '../../../../shared/remote-user';
import { fileURLToPath } from 'node:url';
import { readContributedConfiguration } from '../../../../core/config/read-contributed-configuration';
import { PREFER_API_KEY_SETTINGS } from '../../../../core/pi-session/provider-auth';
import { BROKER_ENV_FEATURE, brokerAnswerOf, CLIENT_PENDING_FEATURE, checkProvider, clientAuthOf, clientUserOf, relayedUserSettingKeys, UserRelays, type UserRelaysDeps, type LocalUserScope } from '../user-relays';

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

  it('keeps an API key\'s env only for a daemon that takes it, and refuses one brokerEnvOf would not keep', () => {
    const env = { CLOUDFLARE_ACCOUNT_ID: 'acct', CLOUDFLARE_GATEWAY_ID: 'gw' };
    expect(brokerAnswerOf({ type: 'api_key', key: 'cf', env }, true)).toEqual({ type: 'api_key', key: 'cf', env });
    expect(brokerAnswerOf({ type: 'api_key', key: 'cf', env })).toEqual({ type: 'api_key', key: 'cf' });
    expect(brokerAnswerOf({ type: 'api_key', key: 'cf' }, true)).toEqual({ type: 'api_key', key: 'cf' });
    const tooMany = Object.fromEntries(Array.from({ length: MAX_BROKER_ENV_VARS + 1 }, (_, i) => [`VAR_${i}`, 'v']));
    for (const bad of [tooMany, { lower: 'v' }, { LONG: 'v'.repeat(MAX_BROKER_ENV_VALUE_CHARS + 1) }, { NUMBER: 7 }, 'A=b']) {
      expect(() => brokerAnswerOf({ type: 'api_key', key: 'cf', env: bad }, true)).toThrow('env');
    }
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

describe('relayedUserSettingKeys', () => {
  const contributed = readContributedConfiguration(fileURLToPath(new URL('../../../../../', import.meta.url)));

  // A second copy beside clientAuth could disagree with it, and only the client's core applies the flag.
  it('relays every user-layer key but the machine scoped ones and the Prefer API key settings', () => {
    const keys = relayedUserSettingKeys(contributed);
    for (const key of PREFER_API_KEY_SETTINGS) expect(contributed.keys).toContain(key);
    for (const key of [...PREFER_API_KEY_SETTINGS, ...contributed.hostKeys, ...contributed.clientMachineKeys]) expect(keys).not.toContain(key);
    expect(keys).toContain('damocles.memory.judge');
  });
});

describe('UserRelays', () => {
  const homes: string[] = [];
  afterEach(async () => {
    for (const home of homes.splice(0)) await fs.rm(home, { recursive: true, force: true });
  });

  // the four first reads each local core start makes (main/index.ts startCoreServices)
  const firstReads = (user: UserRelays): Promise<unknown> => Promise.all([user.authChanged(), user.userChanged(), user.mcpChanged(), user.forgesChanged()]);
  // a daemon that reads no pending value
  const OLDER = FEATURES.filter((feature) => feature !== CLIENT_PENDING_FEATURE);

  async function relays(overrides: Partial<UserRelaysDeps> = {}): Promise<{ relays: UserRelays; lines: string[] }> {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'user-relays-'));
    homes.push(home);
    await fs.mkdir(path.join(home, '.claude'));
    await fs.writeFile(path.join(home, '.claude', 'settings.json'), JSON.stringify({ permissions: { deny: ['Bash(rm:*)'] }, env: { TOKEN: 'x' } }));
    const lines: string[] = [];
    return {
      relays: new UserRelays({
        resolveCredential: async () => ({ type: 'oauth', access: 'a', expiresIn: 60_000, refresh: '' }),
        forges: async () => [],
        clientAuth: async () => KNOWN,
        voice: true,
        homedir: home,
        userSettingKeys: () => ['damocles.language'],
        userValue: () => 'en',
        hostPolicy: () => ({ allowBypass: false }),
        savedHost: () => true,
        engineHalted: () => false,
        local: { mcpServers: async () => [] } as unknown as LocalUserScope,
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

  it('sends an API key\'s env only to a daemon whose welcome lists the feature', async () => {
    const env = { CLOUDFLARE_ACCOUNT_ID: 'acct' };
    const { relays: user } = await relays({ resolveCredential: async () => ({ type: 'api_key', key: 'cf', env }) });
    await expect(user.credentials('ssh+h1', 'openai', [BROKER_ENV_FEATURE])).resolves.toEqual({ type: 'api_key', key: 'cf', env });
    await expect(user.credentials('ssh+h1', 'openai', [])).resolves.toEqual({ type: 'api_key', key: 'cf' });
    expect(FEATURES).toContain(BROKER_ENV_FEATURE);
  });

  it('starts an attach at once with the sign-ins, user files and managed servers pending, makes them known as their reads land, and sends the servers once read', async () => {
    let loaded: ((auth: HeldAuth) => void) | undefined;
    let mcpLoaded: (() => void) | undefined;
    const SERVER = { name: 'notes', tools: [], resources: false };
    const { relays: user } = await relays({
      clientAuth: () => new Promise<HeldAuth>((resolve) => { loaded = resolve; }),
      local: { mcpServers: () => new Promise((resolve) => { mcpLoaded = () => resolve([SERVER]); }) } as unknown as LocalUserScope,
    });
    const published: Array<[string, unknown]> = [];
    const mirrors = await user.attach((topic, value) => published.push([topic, value]), 'ssh+h1', false, FEATURES).mirrors;
    expect(mirrors.clientAuth).toEqual({ providers: {}, pending: 'reading' });
    expect(mirrors.clientUser).toEqual({ settings: {}, permissionRules: [], pending: 'reading' });
    // a core would read no personal servers as none and no managed servers as no account, so they are marked not read yet
    expect(published).toEqual([['clientMcp', { servers: [], pending: 'reading' }], ['clientForges', { servers: [], pending: true }]]);
    const startup = firstReads(user);
    await vi.waitFor(() => expect(loaded && mcpLoaded).toBeDefined());
    loaded!({ providers: {} });
    mcpLoaded!();
    await startup;
    // known with no provider is a value of its own, which replaces the pending one
    expect(published).toHaveLength(6);
    expect(published.slice(2)).toEqual(expect.arrayContaining([
      ['clientAuth', { providers: {} }],
      ['clientUser', { settings: { 'damocles.language': 'en' }, permissionRules: [{ allow: [], ask: [], deny: ['Bash(rm:*)'], dir: '.claude' }] }],
      ['clientMcp', { servers: [SERVER] }],
      ['clientForges', { servers: [] }],
    ]));
    loaded = undefined;
    const again = user.authChanged();
    await vi.waitFor(() => expect(loaded).toBeDefined());
    loaded!({ providers: {} });
    await again;
    expect(published).toHaveLength(6);
  });

  // a daemon's core read the empty values a failed read left as no sign-in, so a send billed the host's own credential
  it('keeps the sign-ins pending after a failed read, saying why, until a read lands', async () => {
    let halted = true;
    let answer: () => Promise<HeldAuth> = () => Promise.reject(new Error('Damocles Core is not running'));
    const { relays: user } = await relays({ clientAuth: () => answer(), engineHalted: () => halted });
    await Promise.all([user.userChanged(), user.mcpChanged(), user.forgesChanged()]);
    const published: Array<[string, unknown]> = [];
    const older: Array<[string, unknown]> = [];
    await user.attach((topic, value) => published.push([topic, value]), 'ssh+h1', false, FEATURES).mirrors;
    const auth = () => published.filter(([topic]) => topic === 'clientAuth').map(([, value]) => value);
    await expect(user.authChanged()).rejects.toThrow('not running');
    expect(auth()).toEqual([{ providers: {}, pending: 'engineStopped' }]);
    // an older daemon would read a pending value as none, so it never hears one
    expect((await user.attach((topic, value) => older.push([topic, value]), 'ssh+h2', false, OLDER).mirrors).clientAuth).toEqual({ providers: {} });
    halted = false;
    user.engineHaltedChanged();
    expect(auth()).toEqual([{ providers: {}, pending: 'engineStopped' }, { providers: {}, pending: 'readFailed' }]);
    answer = async () => KNOWN;
    await user.authChanged();
    expect(auth()).toEqual([
      { providers: {}, pending: 'engineStopped' },
      { providers: {}, pending: 'readFailed' },
      { providers: {}, pending: 'reading' },
      { providers: { anthropic: { type: 'oauth', expiresIn: 0, hasKey: false, flatFee: false }, openai: { type: 'api_key', hasKey: true, flatFee: false } } },
    ]);
    expect(older.filter(([topic]) => topic === 'clientAuth')).toEqual([['clientAuth', auth()[3]]]);
    // a later failed read keeps the known value
    answer = () => Promise.reject(new Error('Damocles Core is not running'));
    await expect(user.authChanged()).rejects.toThrow('not running');
    expect(auth()).toHaveLength(4);
  });

  // a relaunch reattaches a remote core before the local core is ready; a core that started from the empty snapshot refused every send as signed out
  it('starts an older daemon\'s attach made before the first reads from what they read, never the empty snapshots', async () => {
    let loaded: ((auth: HeldAuth) => void) | undefined;
    const { relays: user } = await relays({ clientAuth: () => new Promise<HeldAuth>((resolve) => { loaded = resolve; }) });
    const published: Array<[string, unknown]> = [];
    const attach = user.attach((topic, value) => published.push([topic, value]), 'ssh+h1', false, OLDER);
    const startup = firstReads(user);
    await vi.waitFor(() => expect(loaded).toBeDefined());
    loaded!(KNOWN);
    await startup;
    const mirrors = await attach.mirrors;
    expect(mirrors.clientAuth).toEqual({ providers: { anthropic: { type: 'oauth', expiresIn: 0, hasKey: false, flatFee: false }, openai: { type: 'api_key', hasKey: true, flatFee: false } } });
    expect(mirrors.clientUser).toEqual({ settings: { 'damocles.language': 'en' }, permissionRules: [{ allow: [], ask: [], deny: ['Bash(rm:*)'], dir: '.claude' }] });
    // nothing reaches it as a delta: it starts from the values themselves
    expect(published).toEqual([['clientMcp', { servers: [] }], ['clientForges', { servers: [] }]]);
  });

  it('starts an older daemon\'s attach from the empty snapshot once the first sign-in read failed, since it reads no pending value', async () => {
    const { relays: user } = await relays({ clientAuth: () => Promise.reject(new Error('Damocles Core is not running')) });
    const attach = user.attach(() => undefined, 'ssh+h1', false, OLDER);
    await expect(user.authChanged()).rejects.toThrow('not running');
    await Promise.all([user.userChanged(), user.mcpChanged(), user.forgesChanged()]);
    expect((await attach.mirrors).clientAuth).toEqual({ providers: {} });
  });

  // a relaunch reattached a remote core before the local core read its personal MCP servers and forge files: the remote core
  // saw no personal servers and no forge account, so the forge tool group was not loadable and no git takeover applied
  it('starts an older daemon\'s attach made before the first reads from the real clientMcp and clientForges, with no update ahead of them', async () => {
    const SERVER = { name: 'notes', tools: [], resources: false };
    const FORGE = { id: 'gitlab.com', webUrl: 'https://gitlab.com', gitHosts: ['gitlab.com'], hasAccount: true };
    let mcpLoaded: (() => void) | undefined;
    let forgesLoaded: (() => void) | undefined;
    const { relays: user } = await relays({
      local: { mcpServers: () => new Promise((resolve) => { mcpLoaded = () => resolve([SERVER]); }) } as unknown as LocalUserScope,
      forges: () => new Promise((resolve) => { forgesLoaded = () => resolve([FORGE]); }),
    });
    const published: Array<[string, unknown]> = [];
    let settled = false;
    const attach = user.attach((topic, value) => published.push([topic, value]), 'ssh+h1', false, OLDER);
    void attach.mirrors.then(() => (settled = true));
    const startup = firstReads(user);
    await vi.waitFor(() => expect(mcpLoaded && forgesLoaded).toBeDefined());
    await new Promise((resolve) => setTimeout(resolve, 0));
    // the sign-ins and user files are read; the personal servers and forge files are not yet
    expect(settled).toBe(false);
    expect(published).toEqual([]);
    mcpLoaded!();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(settled).toBe(false);
    forgesLoaded!();
    await startup;
    await attach.mirrors;
    expect(published).toEqual([['clientMcp', { servers: [SERVER] }], ['clientForges', { servers: [FORGE] }]]);
  });

  it('starts an older daemon\'s attach once the first MCP and forge reads failed, never waiting on them', async () => {
    const { relays: user } = await relays({
      local: { mcpServers: () => Promise.reject(new Error('Damocles Core is not running')) } as unknown as LocalUserScope,
      forges: () => Promise.reject(new Error('Damocles Core is not running')),
    });
    const published: Array<[string, unknown]> = [];
    const attach = user.attach((topic, value) => published.push([topic, value]), 'ssh+h1', false, OLDER);
    await Promise.all([user.authChanged(), user.userChanged()]);
    await expect(user.mcpChanged()).rejects.toThrow('not running');
    await expect(user.forgesChanged()).rejects.toThrow('not running');
    await attach.mirrors;
    expect(published).toEqual([['clientMcp', { servers: [] }], ['clientForges', { servers: [] }]]);
  });

  it('refuses an answer the local core sent with a refresh token', async () => {
    const { relays: user } = await relays({ resolveCredential: async () => ({ type: 'oauth', access: 'a', expiresIn: 1, refresh: 'rt' }) as unknown as BrokerAnswer });
    await expect(user.credentials('loopback', 'anthropic')).rejects.toThrow('refresh token');
  });

  it('starts each attach from its values and publishes later changes to every attach, with YOLO refused', async () => {
    let auth = KNOWN;
    let language = 'en';
    const { relays: user } = await relays({ clientAuth: async () => auth, userValue: () => language });
    await firstReads(user);
    const published: Array<[string, unknown]> = [];
    const attach = user.attach((topic, value) => published.push([topic, value]), 'ssh+h1', false, FEATURES);
    expect((await attach.mirrors).clientPolicy).toEqual({ voice: true, allowBypass: false });
    // a host on this computer reaches this computer's loopback endpoints
    expect((await user.attach(() => undefined, 'loopback', true, FEATURES).mirrors).clientPolicy).toEqual({ voice: true, allowBypass: false, sharedLoopback: true });
    // the relayed MCP servers go with every attach, none here
    expect(published).toEqual([['clientMcp', { servers: [] }], ['clientForges', { servers: [] }]]);
    auth = { providers: { openai: { type: 'api_key', hasKey: true, flatFee: false } } };
    language = 'el';
    await user.authChanged();
    await user.userChanged();
    expect(published.slice(2)).toEqual([
      ['clientAuth', { providers: { openai: { type: 'api_key', hasKey: true, flatFee: false } } }],
      ['clientUser', { settings: { 'damocles.language': 'el' }, permissionRules: [{ allow: [], ask: [], deny: ['Bash(rm:*)'], dir: '.claude' }] }],
    ]);
    await user.authChanged();
    expect(published).toHaveLength(4);
    attach.subscription.dispose();
    language = 'en';
    await user.userChanged();
    expect(published).toHaveLength(4);
  });

  it('publishes a Prefer API key change in clientAuth, which the local core reads from the setting, and never in clientUser', async () => {
    const setting = new Map<string, unknown>([['damocles.language', 'en']]);
    const { relays: user } = await relays({
      clientAuth: async () => ({ providers: { openai: { type: 'api_key', hasKey: true, flatFee: false, ...(setting.get('damocles.openai.preferApiKey') === true ? { preferApiKey: true } : {}) } } }),
      userSettingKeys: () => relayedUserSettingKeys({ keys: [...PREFER_API_KEY_SETTINGS, 'damocles.language'], clientMachineKeys: new Set(), hostKeys: new Set() }),
      userValue: (key) => setting.get(key),
    });
    const published: Array<[string, unknown]> = [];
    await firstReads(user);
    const mirrors = await user.attach((topic, value) => published.push([topic, value]), 'ssh+h1', false, FEATURES).mirrors;

    setting.set('damocles.openai.preferApiKey', true);
    await user.authChanged();
    await user.userChanged();

    const sent = (topic: string) => published.filter(([t]) => t === topic).map(([, value]) => value);
    expect(mirrors.clientAuth).toEqual({ providers: { openai: { type: 'api_key', hasKey: true, flatFee: false } } });
    expect(sent('clientAuth')).toEqual([{ providers: { openai: { type: 'api_key', hasKey: true, flatFee: false, preferApiKey: true } } }]);
    expect(mirrors.clientUser).toEqual({ settings: { 'damocles.language': 'en' }, permissionRules: [{ allow: [], ask: [], deny: ['Bash(rm:*)'], dir: '.claude' }] });
    expect(sent('clientUser')).toEqual([]);
  });

  it('gives each attach its host\'s configured policy and publishes a change only to that host\'s attaches', async () => {
    const settings = new Map<string, { allowBypass: boolean; defaultPermissionMode?: 'plan' | 'acceptEdits'; agentForwarding?: boolean }>([
      ['ssh+prod', { allowBypass: false, defaultPermissionMode: 'plan' }],
      ['ssh+dev', { allowBypass: true, agentForwarding: true }],
    ]);
    const { relays: user } = await relays({ hostPolicy: (authority) => settings.get(authority) ?? { allowBypass: false } });
    await firstReads(user);
    const prod: Array<[string, unknown]> = [];
    const dev: Array<[string, unknown]> = [];
    expect((await user.attach((topic, value) => prod.push([topic, value]), 'ssh+prod', false, FEATURES).mirrors).clientPolicy).toEqual({ voice: true, allowBypass: false, defaultPermissionMode: 'plan' });
    expect((await user.attach((topic, value) => dev.push([topic, value]), 'ssh+dev', false, FEATURES).mirrors).clientPolicy).toEqual({ voice: true, allowBypass: true, agentForwarding: true });
    settings.set('ssh+prod', { allowBypass: true, defaultPermissionMode: 'acceptEdits' });
    user.policyChanged('ssh+prod');
    // an unchanged policy publishes nothing
    user.policyChanged('ssh+dev');
    expect(prod).toEqual([['clientMcp', { servers: [] }], ['clientForges', { servers: [] }], ['clientPolicy', { voice: true, allowBypass: true, defaultPermissionMode: 'acceptEdits' }]]);
    expect(dev).toEqual([['clientMcp', { servers: [] }], ['clientForges', { servers: [] }]]);
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
    const startup = firstReads(user);
    await vi.waitFor(() => expect(reads).toHaveLength(1));
    reads.pop()!();
    await startup;
    const published: unknown[] = [];
    await user.attach((_topic, value) => published.push(value), 'ssh+h1', false, FEATURES).mirrors;
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

  it('publishes clientForges only to a daemon that lists it, with ids, URLs, git hosts and account-exists alone', async () => {
    let servers: Array<Record<string, unknown>> = [];
    const { relays: user } = await relays({ forges: async () => servers as never });
    await firstReads(user);
    const listing: Array<[string, unknown]> = [];
    const older: Array<[string, unknown]> = [];
    await user.attach((topic, value) => listing.push([topic, value]), 'ssh+h1', false, FEATURES).mirrors;
    await user.attach((topic, value) => older.push([topic, value]), 'ssh+h2', false, FEATURES.filter((feature) => feature !== 'clientForges')).mirrors;
    servers = [{ id: 'gitlab.com', webUrl: 'https://gitlab.com', gitHosts: ['gitlab.com'], hasAccount: true, login: 'alexios-s', token: 'glpat-x' }];
    await Promise.all([user.forgesChanged(), user.forgesChanged()]);
    expect(listing.filter(([topic]) => topic === 'clientForges')).toEqual([['clientForges', { servers: [] }], ['clientForges', { servers: [{ id: 'gitlab.com', webUrl: 'https://gitlab.com', gitHosts: ['gitlab.com'], hasAccount: true }] }]]);
    expect(JSON.stringify(listing)).not.toMatch(/alexios-s|glpat/);
    expect(older.filter(([topic]) => topic === 'clientForges')).toEqual([]);
  });

  it('publishes no clientForges to an authority without a saved host, whose git relay answers nothing', async () => {
    const { relays: user } = await relays({ savedHost: (authority) => authority !== 'loopback', forges: async () => [{ id: 'gitlab.com', webUrl: 'https://gitlab.com', gitHosts: ['gitlab.com'], hasAccount: true }] });
    await firstReads(user);
    const loopback: Array<[string, unknown]> = [];
    await user.attach((topic, value) => loopback.push([topic, value]), 'loopback', false, FEATURES).mirrors;
    await user.forgesChanged();
    expect(loopback.filter(([topic]) => topic === 'clientForges')).toEqual([]);
  });

  it('keeps the managed servers marked not read yet after a failed read, until a read lands', async () => {
    const FORGE = { id: 'gitlab.com', webUrl: 'https://gitlab.com', gitHosts: ['gitlab.com'], hasAccount: true };
    let answer: () => Promise<never[] | Array<typeof FORGE>> = () => Promise.reject(new Error('Damocles Core is not running'));
    const { relays: user } = await relays({ forges: () => answer() });
    const published: Array<[string, unknown]> = [];
    await user.attach((topic, value) => { if (topic === 'clientForges') published.push([topic, value]); }, 'ssh+h1', false, FEATURES).mirrors;
    await expect(user.forgesChanged()).rejects.toThrow('not running');
    expect(published).toEqual([['clientForges', { servers: [], pending: true }]]);
    answer = async () => [FORGE];
    await user.forgesChanged();
    expect(published).toEqual([['clientForges', { servers: [], pending: true }], ['clientForges', { servers: [FORGE] }]]);
  });

  // a daemon's core read the empty list a failed read left as no personal servers, so a first prompt ran without them
  it('keeps the personal MCP servers marked not read yet after a failed read, saying why, until a read lands, and only toward a daemon that reads the mark', async () => {
    const SERVER = { name: 'notes', tools: [], resources: false };
    let answer: () => Promise<Array<typeof SERVER>> = () => Promise.reject(new Error('Damocles Core is not running'));
    const { relays: user } = await relays({ local: { mcpServers: () => answer() } as unknown as LocalUserScope });
    await Promise.all([user.authChanged(), user.userChanged(), user.forgesChanged()]);
    const published: Array<[string, unknown]> = [];
    const older: Array<[string, unknown]> = [];
    await user.attach((topic, value) => published.push([topic, value]), 'ssh+h1', false, FEATURES).mirrors;
    const mcp = () => published.filter(([topic]) => topic === 'clientMcp').map(([, value]) => value);
    expect(mcp()).toEqual([{ servers: [], pending: 'reading' }]);
    await expect(user.mcpChanged()).rejects.toThrow('not running');
    expect(mcp()).toEqual([{ servers: [], pending: 'reading' }, { servers: [], pending: 'readFailed' }]);
    // an older daemon would read the mark as none, so it hears the list alone
    await user.attach((topic, value) => older.push([topic, value]), 'ssh+h2', false, OLDER).mirrors;
    answer = async () => [SERVER];
    await user.mcpChanged();
    expect(mcp()).toEqual([{ servers: [], pending: 'reading' }, { servers: [], pending: 'readFailed' }, { servers: [], pending: 'reading' }, { servers: [SERVER] }]);
    expect(older.filter(([topic]) => topic === 'clientMcp')).toEqual([['clientMcp', { servers: [] }], ['clientMcp', { servers: [SERVER] }]]);
    // a later failed read keeps the list last read
    answer = () => Promise.reject(new Error('Damocles Core is not running'));
    await expect(user.mcpChanged()).rejects.toThrow('not running');
    expect(mcp()).toHaveLength(4);
  });

  it('leaves out a git host the takeover cannot name, which the daemon would refuse', async () => {
    const { relays: user } = await relays({ forges: async () => [{ id: 'git.example.com', webUrl: 'https://git.example.com', gitHosts: ['git.example.com', '[::1]:8443'], hasAccount: true }] });
    await firstReads(user);
    const published: Array<[string, unknown]> = [];
    await user.attach((topic, value) => published.push([topic, value]), 'ssh+h1', false, FEATURES).mirrors;
    expect(published.find(([topic]) => topic === 'clientForges')).toEqual(['clientForges', { servers: [{ id: 'git.example.com', webUrl: 'https://git.example.com', gitHosts: ['git.example.com'], hasAccount: true }] }]);
  });

  it('registers nothing for an attach disposed before its first reads settled', async () => {
    for (const features of [FEATURES, OLDER]) {
      let forgesLoaded: (() => void) | undefined;
      let reads = 0;
      const FORGE = { id: 'gitlab.com', webUrl: 'https://gitlab.com', gitHosts: ['gitlab.com'], hasAccount: true };
      const { relays: user } = await relays({ forges: () => (++reads === 1 ? new Promise((resolve) => { forgesLoaded = () => resolve([]); }) : Promise.resolve([FORGE])) });
      const published: Array<[string, unknown]> = [];
      const attach = user.attach((topic, value) => published.push([topic, value]), 'ssh+h1', false, features);
      const startup = firstReads(user);
      attach.subscription.dispose();
      await vi.waitFor(() => expect(forgesLoaded).toBeDefined());
      forgesLoaded!();
      await startup;
      await attach.mirrors;
      // a later change reaches every registered attach; one that starts at once heard only the marker it started with
      await user.forgesChanged();
      expect(published).toEqual(features === FEATURES ? [['clientMcp', { servers: [], pending: 'reading' }], ['clientForges', { servers: [], pending: true }]] : []);
    }
  });

  it('sends each OAuth expiry as the ms left on this computer\'s clock, never the time itself', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000_000);
    const held: HeldAuth = { providers: { anthropic: { type: 'oauth', expires: 1_000_000 + 3_600_000, hasKey: false, flatFee: false } } };
    const { relays: user } = await relays({ clientAuth: async () => held });
    const published: unknown[] = [];
    await firstReads(user);
    const attach = user.attach((_topic, value) => published.push(value), 'ssh+h1', false, FEATURES);
    expect((await attach.mirrors).clientAuth).toEqual({ providers: { anthropic: { type: 'oauth', expiresIn: 3_600_000, hasKey: false, flatFee: false } } });
    now.mockReturnValue(1_000_000 + 60_000);
    expect((await user.attach(() => undefined, 'ssh+h1', false, FEATURES).mirrors).clientAuth).toEqual({ providers: { anthropic: { type: 'oauth', expiresIn: 3_540_000, hasKey: false, flatFee: false } } });
    expect(published).toEqual([{ servers: [] }, { servers: [] }]);
    now.mockRestore();
  });
});
