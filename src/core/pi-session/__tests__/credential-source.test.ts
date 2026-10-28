import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createFauxCore, fauxAssistantMessage } from '@earendil-works/pi-ai';
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager, type AgentSession, type ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { createFakePlatform } from '../../../__mocks__/fake-platform';
import { createFakeRemoteHost } from '../../../__mocks__/fake-remote-host';
import { DEFAULT_MODELS } from '../../../shared/types/constants';
import type { ModelInfo } from '../../../shared/types/settings';
import type { HeldAuth } from '../../../shared/remote-user';
import { asClient, clientHasCredential, runPinnedTurn } from '../../client-snapshots';
import { installPlatform } from '../../platform-host';
import { openUsageDatabase } from '../../usage-stats/database';
import { indexUsage } from '../../usage-stats/indexer';
import { loadRates, queryByCredential, queryTotals } from '../../usage-stats/queries';
import { BrokeredCredentialStore, pinRunStarts, recordCredentialSources } from '../credential-broker';
import { clientProviderEndpoints } from '../custom-providers';
import { markCredentialSources, markLoopbackEndpoints, resolvePiModel } from '../pi-models';
import { PiRuntime } from '../pi-runtime';
import { DAMOCLES_CREDENTIAL_SOURCE_ENTRY } from '../session-store/constants';
import { withSettingsPolicy } from '../settings-policy';

const HOUR = 60 * 60 * 1000;
const HOST_ENV_KEY = 'sk-host-environment-0001';
const CLIENT_KEY = 'sk-client-0002';
const ALL_TIME = { startMs: 0, endMs: Number.MAX_SAFE_INTEGER };
const NO_FILTERS = { modelKeys: [], projectKeys: [] };

const dirs: string[] = [];
const tempDir = (prefix: string): string => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  dirs.push(dir);
  return dir;
};

// the target's environment: only the variables named here hold a credential, so a key on the machine running the test never counts
function targetEnvironment(vars: Record<string, string>): void {
  for (const name of ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'ANTHROPIC_OAUTH_TOKEN']) vi.stubEnv(name, vars[name] ?? '');
}

const claudeSignIn: HeldAuth = { providers: { anthropic: { type: 'oauth', expires: Date.now() + HOUR, hasKey: false, flatFee: false } } };

afterEach(async () => {
  vi.unstubAllEnvs();
  await PiRuntime.disposeInstance();
  installPlatform(createFakePlatform());
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('a remote chat\'s model list on a target with its own credential', () => {
  async function remoteRuntime(auth: HeldAuth) {
    const host = createFakeRemoteHost();
    host.set('clientAuth', 'client-a', auth);
    installPlatform({ ...createFakePlatform(), remote: host.remote });
    const runtime = PiRuntime.get(tempDir('damocles-source-agent-'));
    await runtime.init();
    const registry = runtime.modelRuntime!;
    const gpt = DEFAULT_MODELS.find((info) => info.backend === 'openai' && registry.getModel('openai', info.openaiModelId ?? info.value))!;
    const claude = DEFAULT_MODELS.find((info) => info.backend === undefined && info.piProvider === undefined && registry.getModel('anthropic', info.value))!;
    // the composition PiSession.modelsForView posts for the acting client
    const lookup = runtime.modelLookup!;
    const view = (): ModelInfo[] => {
      const openai = runtime.getOpenAIAuthStatus();
      const sourced = markCredentialSources([gpt, claude], lookup, openai, false, (provider) => clientHasCredential(host.remote, provider), (provider) => runtime.hostHasOwnAuth(provider));
      return markLoopbackEndpoints(sourced, lookup, openai, false, false, clientProviderEndpoints());
    };
    const signInNeeded = (info: ModelInfo): boolean => resolvePiModel(info.value, lookup, runtime.getOpenAIAuthStatus(), false).authRequired === true;
    return { host, runtime, registry, gpt, claude, view, signInNeeded };
  }

  it('marks a provider the client has no credential for and the target\'s environment has as the host\'s, selectable, with no host name', async () => {
    targetEnvironment({ OPENAI_API_KEY: HOST_ENV_KEY });
    const { host, registry, gpt, claude, view, signInNeeded } = await remoteRuntime(claudeSignIn);
    const getAuth = vi.spyOn(registry, 'getAuth');
    const env = { ...process.env };
    const [gptView, claudeView] = view();
    expect(gptView).toEqual({ ...gpt, credentialSource: 'host' });
    expect(claudeView).toEqual(claude);
    expect(signInNeeded(gpt)).toBe(false);
    // core names no host: the field is the only addition, and neither the host id nor the key travels with the list
    const posted = JSON.stringify(view());
    expect(posted).not.toContain(host.remote.hostId);
    expect(posted).not.toContain(HOST_ENV_KEY);
    // a presence check: no key fetched from the client or resolved from pi, and the environment untouched
    expect(host.remote.credentials).not.toHaveBeenCalled();
    expect(getAuth).not.toHaveBeenCalled();
    expect(process.env).toEqual(env);
  }, 60_000);

  it('leaves a provider the client holds a credential for as the client\'s sign-in', async () => {
    targetEnvironment({ OPENAI_API_KEY: HOST_ENV_KEY });
    const { host, runtime, gpt, view, signInNeeded } = await remoteRuntime({ providers: { ...claudeSignIn.providers, openai: { type: 'api_key', hasKey: true, flatFee: false } } });
    expect(view()[0]).toEqual(gpt);
    expect(signInNeeded(gpt)).toBe(false);
    // a sign-out on the client turns the same model into the host's at the next list
    host.set('clientAuth', 'client-a', claudeSignIn);
    await runtime.credentialsChanged();
    expect(view()[0]).toEqual({ ...gpt, credentialSource: 'host' });
  }, 60_000);

  it("shows another device the sign-in it lacks, never the acting device's credential as the host's", async () => {
    targetEnvironment({});
    const { host, runtime, gpt, view, signInNeeded } = await remoteRuntime({ providers: { ...claudeSignIn.providers, openai: { type: 'api_key', hasKey: true, flatFee: false } } });
    host.set('clientAuth', 'client-b', claudeSignIn);
    await runtime.credentialsChanged();
    host.setActing('client-a');
    // device b's view is built as b while device a acts
    const [gptOfB] = asClient(host.remote, 'client-b', view);
    expect(gptOfB).toEqual(gpt);
    expect(asClient(host.remote, 'client-b', () => signInNeeded(gpt))).toBe(true);
    expect(asClient(host.remote, 'client-b', () => runtime.getOpenAIAuthStatus().hostKey)).toBeUndefined();
    // device a's own view is its sign-in
    expect(asClient(host.remote, 'client-a', view)[0]).toEqual(gpt);
    expect(asClient(host.remote, 'client-a', () => signInNeeded(gpt))).toBe(false);
  }, 60_000);

  it('needs a sign-in only when neither the client nor the target has a credential', async () => {
    targetEnvironment({});
    const { gpt, view, signInNeeded } = await remoteRuntime(claudeSignIn);
    expect(view()[0]).toEqual(gpt);
    expect(signInNeeded(gpt)).toBe(true);
  }, 60_000);
});

describe('spend of a run on the target\'s own credential', () => {
  const sessions: AgentSession[] = [];
  afterEach(() => {
    for (const session of sessions.splice(0)) session.dispose();
  });

  /** A real pi session on the broker, saved under `sessionsDir`, whose scripted anthropic provider records each request's key. */
  async function remoteRun(sessionsDir: string, auth: HeldAuth, answerKey: string | undefined, prompts: number) {
    const host = createFakeRemoteHost(async () => (answerKey ? { type: 'api_key', key: answerKey } : { type: 'none' }));
    host.set('clientAuth', 'client-a', auth);
    const keys: Array<string | undefined> = [];
    const faux = createFauxCore({ api: 'anthropic-messages', provider: 'anthropic', models: [{ id: 'claude-opus-5-5' }] });
    faux.setResponses(Array.from({ length: prompts }, () => (_context: unknown, options: { apiKey?: string } | undefined) => {
      keys.push(options?.apiKey);
      return fauxAssistantMessage('done');
    }));
    const cwd = tempDir('damocles-source-run-');
    const settingsManager = withSettingsPolicy(SettingsManager.inMemory({}, { projectTrusted: true }));
    const modelRuntime = await ModelRuntime.create({ credentials: new BrokeredCredentialStore({ remote: host.remote, credentialsChanged: vi.fn() }), modelsPath: null });
    const resourceLoader = new DefaultResourceLoader({
      cwd,
      agentDir: cwd,
      settingsManager,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      extensionFactories: [(pi: ExtensionAPI) => {
        pi.registerProvider('anthropic', { baseUrl: 'https://api.anthropic.com', api: 'anthropic-messages', streamSimple: faux.streamSimple } as never);
      }],
    } as never);
    await resourceLoader.reload();
    const { session } = await createAgentSession({
      cwd,
      agentDir: cwd,
      model: modelRuntime.getModel('anthropic', 'claude-opus-5-5'),
      thinkingLevel: 'off',
      modelRuntime,
      settingsManager,
      resourceLoader,
      sessionManager: SessionManager.create(cwd, path.join(sessionsDir, 'project')),
      tools: [],
    } as never);
    sessions.push(session);
    pinRunStarts(session, host.remote, 'panel-1', { raise: () => { throw new Error('no sign-in in this test'); } });
    recordCredentialSources(session, host.remote);
    for (let i = 0; i < prompts; i++) await runPinnedTurn(host.remote, 'panel-1', () => session.prompt(`turn ${i}`));
    const file = session.sessionManager.getSessionFile()!;
    return { host, keys, file, text: fs.readFileSync(file, 'utf8') };
  }

  it('records the run\'s credential source in the session file and the usage index attributes its spend to the host', async () => {
    targetEnvironment({ ANTHROPIC_API_KEY: HOST_ENV_KEY });
    const sessionsDir = tempDir('damocles-source-sessions-');
    const hostRun = await remoteRun(sessionsDir, { providers: {} }, undefined, 2);
    // the client answered none and pi used the target's own key
    expect(hostRun.host.remote.credentials).toHaveBeenCalledWith('anthropic', 'client-a');
    expect(hostRun.keys).toEqual([HOST_ENV_KEY, HOST_ENV_KEY]);
    const signInRun = await remoteRun(sessionsDir, { providers: { anthropic: { type: 'api_key', hasKey: true, flatFee: false } } }, CLIENT_KEY, 1);
    expect(signInRun.keys).toEqual([CLIENT_KEY]);

    // one entry per changed set, never a key
    const recorded = (text: string) => text.split('\n').filter((line) => line.includes(DAMOCLES_CREDENTIAL_SOURCE_ENTRY)).map((line) => (JSON.parse(line) as { data: unknown }).data);
    expect(recorded(hostRun.text)).toEqual([{ clientProviders: [] }]);
    expect(recorded(signInRun.text)).toEqual([{ clientProviders: ['anthropic'] }]);
    for (const text of [hostRun.text, signInRun.text]) {
      expect(text).not.toContain(HOST_ENV_KEY);
      expect(text).not.toContain(CLIENT_KEY);
    }

    const db = openUsageDatabase(path.join(tempDir('damocles-source-db-'), 'usage.db'), () => {});
    await indexUsage({ db, sessionsDir, ledgerPath: path.join(sessionsDir, 'no-ledger.jsonl'), models: [], log: () => {} });
    loadRates(db, []);
    const rows = queryByCredential(db, ALL_TIME, NO_FILTERS);
    expect(Object.fromEntries(rows.map((row) => [row.credential, row.requests]))).toEqual({ host: 2, signIn: 1 });
    expect(rows.reduce((sum, row) => sum + row.requests, 0)).toBe(queryTotals(db, ALL_TIME, NO_FILTERS, 'UTC').requests);
    db.close();
  }, 60_000);
});

describe('the usage index reading credential-source entries', () => {
  const T0 = Date.parse('2025-06-10T09:00:00.000Z');
  const at = (minutes: number): string => new Date(T0 + minutes * 60_000).toISOString();
  const usage = { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, totalTokens: 150, cost: { input: 0.5, output: 0.5, cacheRead: 0, cacheWrite: 0, total: 1 } };
  const line = (value: object): string => `${JSON.stringify(value)}
`;
  const assistant = (id: string, minute: number, provider: string) => line({
    type: 'message', id, parentId: null, timestamp: at(minute),
    message: { role: 'assistant', content: [], api: 'x', provider, model: `${provider}-model`, usage, stopReason: 'stop', timestamp: T0 },
  });
  const sources = (minute: number, clientProviders: string[]) => line({ type: 'custom', customType: DAMOCLES_CREDENTIAL_SOURCE_ENTRY, id: `c${minute}`, parentId: null, timestamp: at(minute), data: { clientProviders } });

  async function byCredential(sessionsDir: string, ledgerPath: string, dbPath: string) {
    const db = openUsageDatabase(dbPath, () => {});
    try {
      await indexUsage({ db, sessionsDir, ledgerPath, models: [], log: () => {} });
      loadRates(db, []);
      const rows = queryByCredential(db, ALL_TIME, NO_FILTERS);
      expect(rows.reduce((sum, row) => sum + row.cost, 0)).toBe(queryTotals(db, ALL_TIME, NO_FILTERS, 'UTC').cost);
      return Object.fromEntries(rows.map((row) => [row.credential, row.requests]));
    } finally {
      db.close();
    }
  }

  it('attributes rows by the latest entry per file, across incremental reads, and reads the ledger mark', async () => {
    const root = tempDir('damocles-source-index-');
    const sessionsDir = path.join(root, 'sessions');
    fs.mkdirSync(path.join(sessionsDir, 'project'), { recursive: true });
    const remoteFile = path.join(sessionsDir, 'project', 'remote.jsonl');
    const localFile = path.join(sessionsDir, 'project', 'local.jsonl');
    const ledgerPath = path.join(root, 'subcalls.jsonl');
    const dbPath = path.join(root, 'usage.db');
    const header = (id: string) => line({ type: 'session', version: 3, id, timestamp: at(0), cwd: root });
    // a compaction names no provider and bills the file's latest model's
    fs.writeFileSync(remoteFile, header('remote') + sources(1, ['anthropic']) + assistant('a1', 2, 'openai') + assistant('a2', 3, 'anthropic')
      + line({ type: 'compaction', id: 'k1', parentId: null, timestamp: at(4), usage }));
    // a local core writes no entry: all its spend is the user's sign-in
    fs.writeFileSync(localFile, header('local') + assistant('l1', 2, 'openai'));
    fs.writeFileSync(ledgerPath, line({ v: 1, type: 'subcall', id: 's1', timestamp: at(5), purpose: 'session-title', provider: 'openai', model: 'gpt', stopReason: 'stop', cwd: root, sessionId: 'remote', credentialSource: 'host', usage })
      + line({ v: 1, type: 'subcall', id: 's2', timestamp: at(6), purpose: 'session-title', provider: 'openai', model: 'gpt', stopReason: 'stop', cwd: root, sessionId: 'local', usage }));
    expect(await byCredential(sessionsDir, ledgerPath, dbPath)).toEqual({ host: 2, signIn: 4 });

    // read from the stored offset: the state the earlier read ended with still applies, and a newer entry replaces it
    fs.appendFileSync(remoteFile, assistant('a3', 7, 'openai') + sources(8, ['anthropic', 'openai']) + assistant('a4', 9, 'openai'));
    expect(await byCredential(sessionsDir, ledgerPath, dbPath)).toEqual({ host: 3, signIn: 5 });
  });
});
