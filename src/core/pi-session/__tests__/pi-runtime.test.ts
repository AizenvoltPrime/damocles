import { describe, it, expect, afterEach, beforeAll, beforeEach, vi } from 'vitest';
import { installLogSink } from '../../logger';
import { createFakePlatform, installFakePlatform } from '../../../__mocks__/fake-platform';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { pathToFileURL } from 'url';
import type { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { ModelsError } from '@earendil-works/pi-ai';
import { PiRuntime, type LiveSessionMutator } from '../pi-runtime';
import { piModelNetworkEnabled, savedCatalogCheckedAt } from '../pi-model-catalog';
import { FolderRuntime } from '../folder-runtime';
import { serializeSettingWrite } from '../../settings-write-chain';
import { McpClientManager } from '../mcp/mcp-client-manager';
import type { PersonalToolLists } from '../mcp/tool-name-migration';
import { initPiLoader, loadPiAi, nodeSupportsPi, PI_MIN_NODE_MAJOR, type PiCodingAgentModule } from '../pi-loader';
import type { SecretResolver } from '../custom-providers';
import { LEGACY_SUBSCRIPTION_REPOS, SUBSCRIPTION_SOURCE, classifySubscriptionSource } from '../subscription';
import { SUBCALL_USAGE_LEDGER_PATH } from '../../paths';
import { SUBCALL_THINKING, type StructuredSubCallPurpose } from '../subcall-model';
import { installPlatform } from '../../platform-host';
import { createFakeRemoteHost } from '../../../__mocks__/fake-remote-host';
import { dollarBilled, subscriptionProvider } from '../account-billing';
import { DEFAULT_MODELS } from '../../../shared/types/constants';
import type { HeldAuthEntry } from '../../../shared/remote-user';
import { LocalizedError } from '../../../shared/localized-text';

/** Lets a test make pi-ai fail to load; every other test loads the real module. */
const piAiLoad = vi.hoisted(() => ({ fail: false }));
vi.mock('../pi-loader', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../pi-loader')>();
  return { ...actual, loadPiAi: () => (piAiLoad.fail ? Promise.resolve(null) : actual.loadPiAi()) };
});

/** Trust and watchers for the folder runtimes built here; trusted by default, as the host is. */
const testPlatform = createFakePlatform();

/**
 * Capture what `logger.ts` ACTUALLY writes, not the format-string arguments — the credential leak this
 * guards was invisible at the argument level. Installed file-wide, as the host installs its sink once.
 */
const logLines: string[] = [];
beforeAll(() => {
  installLogSink({
    appendLine: (line: string) => void logLines.push(line),
    show: () => {},
    dispose: () => {},
  });
});

describe('PiRuntime singleton (B1)', () => {
  afterEach(async () => {
    await PiRuntime.disposeInstance();
  });

  it('returns one shared instance regardless of get() arguments', () => {
    const a = PiRuntime.get('/tmp/agent-a');
    const b = PiRuntime.get('/tmp/agent-b');
    expect(a).toBe(b);
    expect(a.agentDir).toBe('/tmp/agent-a');
    expect(PiRuntime.exists).toBe(true);
  });

  it('disposeInstance clears the singleton so a fresh instance can be created', async () => {
    const a = PiRuntime.get();
    await PiRuntime.disposeInstance();
    expect(PiRuntime.exists).toBe(false);
    const c = PiRuntime.get();
    expect(c).not.toBe(a);
  });

  it("a late unregister from a session's previous mutator leaves the new owner's entry", () => {
    // Two panels can hold one session id, on different folders; the mutator registry is process-wide.
    const runtime = PiRuntime.get();
    const older = {} as LiveSessionMutator;
    const newer = {} as LiveSessionMutator;
    runtime.registerSessionMutator('sess-x', older);
    runtime.registerSessionMutator('sess-x', newer);

    runtime.unregisterSessionMutator('sess-x', older);
    expect(runtime.getSessionMutator('sess-x')).toBe(newer);

    runtime.unregisterSessionMutator('sess-x', newer);
    expect(runtime.getSessionMutator('sess-x')).toBeUndefined();
  });

  it('a usage threshold listener that throws leaves the others notified', () => {
    const runtime = PiRuntime.get();
    const heard = vi.fn();
    const stopThrowing = PiRuntime.onUsageThreshold(() => {
      throw new Error('listener failed');
    });
    const stopHeard = PiRuntime.onUsageThreshold(heard);
    const crossing = { provider: 'anthropic', windowId: 'five_hour', windowLabel: 'Session (5hr)', threshold: 80, utilization: 81 } as const;
    try {
      (runtime.usage as unknown as { deps: { onCrossing(c: typeof crossing): void } }).deps.onCrossing(crossing);
      expect(heard).toHaveBeenCalledWith(crossing);
    } finally {
      stopThrowing();
      stopHeard();
    }
  });
});

/**
 * Every internal sub-call reaches the usage ledger through `runStructuredCompletion`, because no session
 * file records it. The ledger is best-effort: a write failure must leave the sub-call result unchanged.
 */
describe('PiRuntime.runStructuredCompletion usage ledger', () => {
  const MODEL = { id: 'claude-haiku-5-5', provider: 'anthropic' };
  const USAGE = { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { input: 0.01, output: 0.02, cacheRead: 0, cacheWrite: 0, total: 0.03 } };
  const REQ = { systemPrompt: 's', userMessage: 'u', outputToolName: 'submit_result', outputToolDescription: 'd', schema: { type: 'object' }, purpose: 'memory-extract' as const };

  function runtimeReturning(complete: () => Promise<unknown>): PiRuntime {
    const runtime = PiRuntime.get();
    const internals = runtime as unknown as { _modelRuntime: unknown; subCallModelFor: () => unknown };
    internals._modelRuntime = { hasConfiguredAuth: () => true, completeSimple: vi.fn(complete) };
    internals.subCallModelFor = () => ({ model: MODEL });
    return runtime;
  }
  const message = (stopReason: string) => ({
    role: 'assistant', api: 'anthropic-messages', provider: 'anthropic', model: 'claude-haiku-5-5', stopReason, timestamp: 0, usage: USAGE,
    content: [{ type: 'toolCall', id: '1', name: 'submit_result', arguments: { ok: true } }],
  });
  const ledger = (): Array<Record<string, unknown>> =>
    fs.existsSync(SUBCALL_USAGE_LEDGER_PATH) && fs.statSync(SUBCALL_USAGE_LEDGER_PATH).isFile()
      ? fs.readFileSync(SUBCALL_USAGE_LEDGER_PATH, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>)
      : [];

  afterEach(async () => {
    fs.rmSync(SUBCALL_USAGE_LEDGER_PATH, { recursive: true, force: true });
    await PiRuntime.disposeInstance();
  });

  it('records a completed sub-call with its purpose, attribution and full usage', async () => {
    const runtime = runtimeReturning(async () => message('toolUse'));
    expect(await runtime.runStructuredCompletion({ ...REQ, attribution: { cwd: '/ws', sessionId: 's1' } })).toEqual({ kind: 'answered', value: { ok: true } });
    expect(ledger()).toEqual([expect.objectContaining({ v: 1, type: 'subcall', purpose: 'memory-extract', provider: 'anthropic', model: 'claude-haiku-5-5', stopReason: 'toolUse', cwd: '/ws', sessionId: 's1', usage: USAGE })]);
  });

  it('records an errored sub-call, which was still billed', async () => {
    const runtime = runtimeReturning(async () => message('error'));
    expect(await runtime.runStructuredCompletion(REQ)).toEqual({ kind: 'unanswered' });
    expect(ledger()).toEqual([expect.objectContaining({ stopReason: 'error', cwd: null, sessionId: null })]);
  });

  it('records nothing for a sub-call that billed no tokens and no cost', async () => {
    const zero = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
    const runtime = runtimeReturning(async () => ({ ...message('toolUse'), usage: zero }));
    expect(await runtime.runStructuredCompletion(REQ)).toEqual({ kind: 'answered', value: { ok: true } });
    expect(ledger()).toEqual([]);
  });

  it('records nothing when the request throws before any usage exists', async () => {
    const runtime = runtimeReturning(async () => { throw new Error('network'); });
    expect(await runtime.runStructuredCompletion(REQ)).toEqual({ kind: 'unreachable' });
    expect(ledger()).toEqual([]);
  });

  it.each([
    ['a refusal', 'The model refused to complete the request', 'unanswered'],
    ['a timeout', 'Request timed out.', 'unreachable'],
    ['a 529 the provider SDK reported', '529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}', 'unreachable'],
  ])('classifies an error stop for %s with pi-ai\'s own transient classifier', async (_label, errorMessage, kind) => {
    const runtime = runtimeReturning(async () => ({ ...message('error'), content: [], errorMessage }));
    expect(await runtime.runStructuredCompletion(REQ)).toEqual({ kind });
  });

  /** pi's own setup error stop: no status, no usage, the request never left. */
  const setupFailure = (errorMessage: string) => async () => ({ ...message('error'), content: [], usage: { ...USAGE, input: 0, output: 0, totalTokens: 0 }, errorMessage });

  it.each<[string, () => Promise<unknown>]>([
    ['pi refuses to refresh the OAuth grant', async () => { throw new ModelsError('oauth', 'OAuth refresh failed for anthropic'); }],
    ['pi no longer has a credential', async () => undefined],
  ])('names a credential cause for a no-contact error stop when %s', async (_label, getAuth) => {
    const runtime = runtimeReturning(setupFailure('OAuth refresh failed for anthropic: invalid_grant'));
    const modelRuntime = (runtime as unknown as { _modelRuntime: Record<string, unknown> })._modelRuntime;
    modelRuntime.getAuth = vi.fn(getAuth);
    expect(await runtime.runStructuredCompletion(REQ)).toEqual({ kind: 'unreachable', cause: 'credential' });
    expect(modelRuntime.getAuth).toHaveBeenCalledWith(MODEL, expect.anything());
  });

  it('keeps a no-contact error stop plainly unreachable when pi still resolves the credential', async () => {
    const runtime = runtimeReturning(setupFailure('Unknown provider: anthropic'));
    (runtime as unknown as { _modelRuntime: Record<string, unknown> })._modelRuntime.getAuth = vi.fn(async () => ({ auth: { apiKey: 'k' } }));
    expect(await runtime.runStructuredCompletion(REQ)).toEqual({ kind: 'unreachable' });
  });

  it('names a credential cause when the provider has no configured credential at call time', async () => {
    const runtime = runtimeReturning(async () => message('toolUse'));
    (runtime as unknown as { _modelRuntime: Record<string, unknown> })._modelRuntime.hasConfiguredAuth = () => false;
    expect(await runtime.runStructuredCompletion(REQ)).toEqual({ kind: 'unreachable', cause: 'credential' });
  });

  it('is unreachable with no sub-call model', async () => {
    const runtime = runtimeReturning(async () => message('toolUse'));
    (runtime as unknown as { subCallModelFor: () => unknown }).subCallModelFor = () => null;
    expect(await runtime.runStructuredCompletion(REQ)).toEqual({ kind: 'unreachable' });
  });

  it('returns the result unchanged when the ledger cannot be written', async () => {
    fs.mkdirSync(SUBCALL_USAGE_LEDGER_PATH, { recursive: true });
    const runtime = runtimeReturning(async () => message('toolUse'));
    expect(await runtime.runStructuredCompletion(REQ)).toEqual({ kind: 'answered', value: { ok: true } });
  });
});

/**
 * Every sub-call names its thinking level, clamped by pi: with no level, pi runs a Claude model that cannot
 * disable thinking at adaptive `high`. Models come from the catalog files pi-ai ships, so the clamp sees real level maps.
 */
describe('PiRuntime.runStructuredCompletion thinking level', () => {
  const PURPOSES = Object.keys(SUBCALL_THINKING) as StructuredSubCallPurpose[];
  const REQ = { systemPrompt: 's', userMessage: 'u', outputToolName: 'submit_result', outputToolDescription: 'd', schema: { type: 'object' } };

  function catalogModel(file: string, api: string, id: string): unknown {
    const url = new URL(`../../../../node_modules/@earendil-works/pi-ai/dist/providers/data/${file}`, import.meta.url);
    return (JSON.parse(fs.readFileSync(url, 'utf8')) as Record<string, Record<string, unknown>>)[api]?.[`chat:${id}`];
  }
  const HAIKU = catalogModel('anthropic.json', 'anthropic-messages', 'claude-haiku-5-5');
  const LUNA = catalogModel('openai.json', 'openai-responses', 'gpt-6-luna');

  const SONNET = catalogModel('anthropic.json', 'anthropic-messages', 'claude-sonnet-5-5');

  /**
   * Runs one sub-call per purpose and returns the options each `completeSimple` call received. With `model` the
   * sub-call model is stubbed; without it the runtime resolves the Background setting against a registry of Sonnet 5.5.
   */
  async function optionsPerPurpose(model?: unknown): Promise<Map<StructuredSubCallPurpose, Record<string, unknown>>> {
    const seen = new Map<StructuredSubCallPurpose, Record<string, unknown>>();
    const runtime = PiRuntime.get();
    const internals = runtime as unknown as { _modelRuntime: unknown; _folders: Map<string, unknown>; subCallModelFor: () => unknown };
    let current: StructuredSubCallPurpose = PURPOSES[0]!;
    internals._modelRuntime = {
      getModel: (provider: string, id: string) => (provider === 'anthropic' && id === 'claude-sonnet-5-5' ? SONNET : undefined),
      hasConfiguredAuth: () => true,
      completeSimple: vi.fn(async (_m: unknown, _c: unknown, options: Record<string, unknown>) => {
        seen.set(current, options);
        return { role: 'assistant', stopReason: 'toolUse', usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, content: [{ type: 'toolCall', id: '1', name: 'submit_result', arguments: { ok: true } }] };
      }),
    };
    if (model === undefined) internals._folders.set('/ws', {});
    else internals.subCallModelFor = () => ({ model });
    for (const purpose of PURPOSES) {
      current = purpose;
      expect(await runtime.runStructuredCompletion({ ...REQ, purpose })).toEqual({ kind: 'answered', value: { ok: true } });
    }
    return seen;
  }

  afterEach(async () => {
    piAiLoad.fail = false;
    await PiRuntime.disposeInstance();
  });

  it('sends no reasoning for the four off purposes on Haiku 5.5 and low for the others', async () => {
    expect(HAIKU).toBeDefined();
    const seen = await optionsPerPurpose(HAIKU);
    expect(seen.size).toBe(PURPOSES.length);
    for (const purpose of PURPOSES) {
      if (SUBCALL_THINKING[purpose] === 'off') expect(seen.get(purpose), purpose).not.toHaveProperty('reasoning');
      else expect(seen.get(purpose)?.reasoning, purpose).toBe('low');
    }
  });

  it('sends no reasoning for the four off purposes on GPT-6 Luna and low for the other three', async () => {
    expect(LUNA).toBeDefined();
    const seen = await optionsPerPurpose(LUNA);
    const off = PURPOSES.filter((p) => SUBCALL_THINKING[p] === 'off');
    expect(off).toEqual(['session-title', 'memory-query-expansion', 'memory-rerank', 'memory-merge']);
    for (const purpose of off) expect(seen.get(purpose), purpose).not.toHaveProperty('reasoning');
    for (const purpose of PURPOSES.filter((p) => !off.includes(p))) expect(seen.get(purpose)?.reasoning, purpose).toBe('low');
  });

  it('sends reasoning high for every purpose with the Background model and the Memory judge on Sonnet 5.5 at High', async () => {
    installFakePlatform({
      settings: {
        user: {
          'damocles.background.model': 'claude-sonnet-5-5',
          'damocles.background.effort': 'high',
          'damocles.memory.judge': 'claude-sonnet-5-5',
          'damocles.memory.judgeEffort': 'high',
        },
      },
    });
    const seen = await optionsPerPurpose();
    expect(seen.size).toBe(PURPOSES.length);
    for (const purpose of PURPOSES) expect(seen.get(purpose)?.reasoning, purpose).toBe('high');
  });

  it('logs no sub-call that answered in time', async () => {
    logLines.length = 0;
    await optionsPerPurpose(HAIKU);
    expect(logLines.filter((line) => line.includes('[PiRuntime] sub-call'))).toEqual([]);
  });

  it('logs the purpose, model, level, stop reason and time of a sub-call that failed or ran slow', async () => {
    const ZERO = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
    let now = 1_000;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    const runtime = PiRuntime.get();
    const internals = runtime as unknown as { _modelRuntime: unknown; subCallModelFor: () => unknown };
    const replies = [
      { role: 'assistant', stopReason: 'error', errorMessage: '400 invalid request', usage: ZERO, content: [] },
      { role: 'assistant', stopReason: 'toolUse', usage: ZERO, content: [{ type: 'toolCall', id: '1', name: 'submit_result', arguments: { ok: true } }] },
    ];
    internals._modelRuntime = {
      hasConfiguredAuth: () => true,
      completeSimple: vi.fn(async () => {
        const reply = replies.shift()!;
        if (reply.stopReason === 'toolUse') now += 12_000;
        return reply;
      }),
    };
    internals.subCallModelFor = () => ({ model: HAIKU });
    logLines.length = 0;

    await runtime.runStructuredCompletion({ ...REQ, purpose: 'memory-extract' });
    await runtime.runStructuredCompletion({ ...REQ, purpose: 'memory-merge' });

    const subCalls = logLines.filter((line) => line.includes('[PiRuntime] sub-call'));
    expect(subCalls).toHaveLength(2);
    expect(subCalls[0]).toMatch(/sub-call memory-extract on anthropic\/claude-haiku-5-5 at low ended with error in 0ms/);
    expect(subCalls[1]).toMatch(/sub-call memory-merge on anthropic\/claude-haiku-5-5 at off ended with toolUse in 12000ms/);
    vi.restoreAllMocks();
  });

  it('is unreachable without calling completeSimple when pi-ai fails to load', async () => {
    piAiLoad.fail = true;
    const completeSimple = vi.fn();
    const runtime = PiRuntime.get();
    const internals = runtime as unknown as { _modelRuntime: unknown; subCallModelFor: () => unknown };
    internals._modelRuntime = { hasConfiguredAuth: () => true, completeSimple };
    internals.subCallModelFor = () => ({ model: HAIKU });

    expect(await runtime.runStructuredCompletion({ ...REQ, purpose: 'memory-extract' })).toEqual({ kind: 'unreachable' });
    expect(completeSimple).not.toHaveBeenCalled();
  });
});

/**
 * The subscription plugin switch, across every folder loader. Every case asserts the invariant that
 * settings list a subscription plugin only if that plugin registered `anthropic`, plus the order of
 * settings writes, reloads and provider resets that keeps it true across a failure at any step.
 *
 * The fake keeps pi's split between in-memory and on-disk settings: `flush` writes the user settings'
 * memory to disk (or records a write error), `reload` re-reads the disk, and each folder loader's
 * `reload` re-reads the disk before loading, as pi's resource loader does. Two folder loaders share one
 * `ModelRuntime`, whose `registerProvider` merges over the previous registration, as pi's does.
 */
describe('subscription plugin migration', () => {
  // Folder creation needs the loaded pi module; the cold import takes seconds, so it is paid once here.
  beforeAll(async () => {
    if (!(await initPiLoader())) throw new Error('pi failed to load');
  }, 60_000);

  const CURRENT = SUBSCRIPTION_SOURCE;
  const LEGACY = 'https://github.com/AizenvoltPrime/pi-anthropic-oauth@8f82a2d207e12bfd313092d78333c594554f26fb';
  const LEGACY_REPO = LEGACY_SUBSCRIPTION_REPOS[0]!;
  type LoadBehavior = 'register' | 'none' | 'error';
  type Entry = string | { source: string; extensions?: string[] };
  type Pending = { name: string; config: Record<string, unknown>; extensionPath: string };

  interface Harness {
    runtime: PiRuntime;
    calls: string[];
    /** In-memory user packages. */
    memory: Entry[];
    /** User packages as written to settings.json. */
    disk: Entry[];
    providers: Map<string, Record<string, unknown>>;
    cloneDir(source: string): string;
    behavior: { current: LoadBehavior; legacy: LoadBehavior };
    startupErrors: { path: string; error: string }[];
    failInstall: boolean;
    failLegacyRemove: boolean;
    failNextFlush: boolean;
    failNextReload: boolean;
    /** A write pi queued for a field outside `packages`, as a ChatGPT sign-in's device id is; it runs at the next flush or reload. */
    queuedWrite: boolean;
    /** pi's loads of the user settings file fail, as for invalid JSON: each records a load error, keeps the
     *  previous in-memory settings, and pi drops every write until a load succeeds. */
    unloadable: boolean;
    /** Resolves when the install may proceed; lets a case act while a swap is in flight. */
    installGate: Promise<void>;
    folders: FolderRuntime[];
    /** Create a folder runtime whose loader follows the harness, labelled by the last path segment. */
    addFolder(label: string): FolderRuntime;
  }

  /** V8's parse message, which quotes the settings file. */
  const QUOTING_PARSE_MESSAGE = `Unexpected token '}', "{"token":"sk-file-text"}" is not valid JSON`;
  const tmpRoots: string[] = [];
  const spies: Array<{ mockRestore(): void }> = [];
  const restoreSpies = (): void => {
    for (const spy of spies.splice(0)) spy.mockRestore();
  };
  afterEach(async () => {
    restoreSpies();
    await PiRuntime.disposeInstance();
    for (const dir of tmpRoots.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  const sourceOf = (e: Entry): string => (typeof e === 'string' ? e : e.source);
  const identity = (source: string): string => source.replace(/[@#].*$/, '');
  const diskSources = (h: Harness): string[] => h.disk.map(sourceOf);

  function writeClone(dir: string): void {
    fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'package.json'), '{}');
    fs.writeFileSync(path.join(dir, 'src', 'index.ts'), '');
  }

  function setup(opts: { packages: Entry[]; clones: string[]; folders?: string[] }): Harness {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'damocles-sub-mig-'));
    tmpRoots.push(root);
    const calls: string[] = [];
    const runtime = PiRuntime.get(root);
    const settingsErrors: { scope: string; path?: string; error: Error }[] = [];
    let loadFailed = false;

    const modelRuntime = {
      registerProvider: (name: string, config: Record<string, unknown>) => {
        calls.push(`register:${name}:${String(config['tag'])}`);
        h.providers.set(name, { ...h.providers.get(name), ...config });
      },
      unregisterProvider: (name: string) => {
        calls.push(`unregister:${name}`);
        h.providers.delete(name);
      },
      getRegisteredProviderConfig: (name: string) => h.providers.get(name),
      hasConfiguredAuth: () => false,
      refresh: async (options: unknown) => {
        // A plugin swap must never reach the network.
        expect(options).toEqual({ allowNetwork: false });
        calls.push('refresh');
        return { aborted: false, errors: new Map() };
      },
    };

    /** What a loader reading the current disk registers: one `anthropic` per listed subscription plugin. */
    function load(): { pending: Pending[]; errors: { path: string; error: string }[] } {
      const pending: Pending[] = [];
      const errors: { path: string; error: string }[] = [];
      for (const entry of h.disk) {
        const source = sourceOf(entry);
        const kind = classifySubscriptionSource(source);
        if (kind !== 'current' && kind !== 'legacy') continue;
        const behavior = h.behavior[kind];
        if (behavior === 'none') continue;
        const extensionPath = path.join(h.cloneDir(source), 'src', 'index.ts');
        const config = kind === 'legacy' ? { tag: kind, oauth: true } : { tag: kind };
        pending.push({ name: 'anthropic', config, extensionPath });
        if (behavior === 'error') errors.push({ path: extensionPath, error: 'boom' });
      }
      return { pending, errors };
    }

    function attachLoader(folder: FolderRuntime, label: string): void {
      const runtimeState = { pendingProviderRegistrations: [] as Pending[] };
      let reloadErrors: { path: string; error: string }[] | null = null;
      (folder as unknown as { _services: unknown })._services = {
        settingsManager: { isProjectTrusted: () => true },
        resourceLoader: {
          reload: async () => {
            calls.push(`reload:${label}`);
            if (h.failNextReload) {
              h.failNextReload = false;
              throw new Error('git clone failed');
            }
            const loaded = load();
            runtimeState.pendingProviderRegistrations.push(...loaded.pending);
            reloadErrors = loaded.errors;
          },
          extendResources: () => undefined,
          getExtensions: () => ({ runtime: runtimeState, errors: reloadErrors ?? h.startupErrors }),
        },
      };
    }

    const h: Harness = {
      runtime,
      calls,
      memory: [...opts.packages],
      disk: [...opts.packages],
      providers: new Map(),
      // pi keys a clone by host and full repo path, so two owners' repos of the same name never share a directory.
      cloneDir: (source) => {
        const url = new URL(identity(source));
        return path.join(root, 'git', url.host, ...url.pathname.split('/').filter(Boolean));
      },
      behavior: { current: 'register', legacy: 'register' },
      startupErrors: [],
      failInstall: false,
      failLegacyRemove: false,
      failNextFlush: false,
      failNextReload: false,
      queuedWrite: false,
      unloadable: false,
      installGate: Promise.resolve(),
      folders: [],
      addFolder: (label) => {
        const folder = new FolderRuntime({
          pi: {} as PiCodingAgentModule,
          cwd: path.join(root, 'ws', label),
          agentDir: root,
          modelRuntime: modelRuntime as unknown as ModelRuntime,
          planModelIds: () => undefined,
          userMcp: new McpClientManager({ clientVersion: 'test' }),
          createFolderMcp: (reservedToolNames) => new McpClientManager({ clientVersion: 'test', reservedToolNames }),
          noticeMemory: { has: () => false, add: async () => {} },
          additionMemory: { has: () => false, add: async () => {} },
          projectDisabledTools: () => null,
          personalDisabledTools: () => ({ rewrite: async () => undefined, lists: () => [] }),
          toolExposureSetting: () => ({}),
          resourceExposureSetting: () => ({}),
          trust: testPlatform.trust,
          fileWatchers: testPlatform.fileWatchers,
        });
        attachLoader(folder, label);
        h.folders.push(folder);
        return folder;
      },
    };
    for (const source of opts.clones) writeClone(h.cloneDir(source));

    const userSettings = {
      getGlobalSettings: () => ({ packages: [...h.memory] }),
      setPackages: (packages: Entry[]) => {
        calls.push('setPackages');
        h.memory = [...packages];
      },
      // pi queues a write only when a setter changed something, and flush awaits that queue.
      flush: async () => {
        if (!h.queuedWrite && JSON.stringify(h.memory) === JSON.stringify(h.disk)) return;
        h.queuedWrite = false;
        calls.push('flush');
        if (loadFailed) return;
        if (h.failNextFlush) {
          h.failNextFlush = false;
          // pi's write parses the file as it is now, which another program may have broken since the load.
          settingsErrors.push({ scope: 'global', error: new SyntaxError(QUOTING_PARSE_MESSAGE) });
          return;
        }
        h.disk = [...h.memory];
      },
      drainErrors: () => settingsErrors.splice(0),
      // pi's reload awaits its write queue before it loads (settings-manager.js:363).
      reload: async () => {
        await userSettings.flush();
        loadFailed = h.unloadable;
        if (loadFailed) {
          settingsErrors.push({ scope: 'global', path: path.join(root, 'settings.json'), error: new SyntaxError(QUOTING_PARSE_MESSAGE) });
          return;
        }
        h.memory = [...h.disk];
      },
    };

    const fakePm = {
      getInstalledPath: (source: string) => {
        const dir = h.cloneDir(source);
        return fs.existsSync(dir) ? dir : undefined;
      },
      addSourceToSettings: (source: string) => {
        calls.push(`addSettings:${source}`);
        const i = h.memory.findIndex((p) => identity(sourceOf(p)) === identity(source));
        if (i === -1) h.memory.push(source);
        else h.memory[i] = source;
        return true;
      },
      removeSourceFromSettings: (source: string) => {
        calls.push(`removeSettings:${identity(source)}`);
        const before = h.memory.length;
        h.memory = h.memory.filter((p) => identity(sourceOf(p)) !== identity(source));
        return h.memory.length !== before;
      },
      install: async (source: string) => {
        calls.push(`install:${source}`);
        await h.installGate;
        if (h.failInstall) throw new Error('network down');
        writeClone(h.cloneDir(source));
      },
      remove: async (source: string) => {
        calls.push(`remove:${identity(source)}`);
        if (h.failLegacyRemove && identity(source) === LEGACY_REPO) throw new Error('EPERM');
        fs.rmSync(h.cloneDir(source), { recursive: true, force: true });
      },
    };

    const internals = runtime as unknown as {
      _modelRuntime: unknown;
      _userSettings: unknown;
      _userMcp: unknown;
      _initPromise: Promise<void>;
    };
    internals._modelRuntime = modelRuntime;
    internals._userSettings = userSettings;
    internals._userMcp = { onToolsChanged: () => () => undefined, dispose: async () => undefined };
    internals._initPromise = Promise.resolve();
    spies.push(vi.spyOn(runtime as unknown as { _packageManager(): unknown }, '_packageManager').mockReturnValue(fakePm));

    // A folder created through `folder()` gets a harness loader, and pi's services creation flushes that
    // loader's registrations into the shared model runtime, as `createAgentSessionServices` does.
    spies.push(vi.spyOn(FolderRuntime.prototype, 'createServices').mockImplementation(async function (this: FolderRuntime) {
      const label = path.basename(this.cwd);
      calls.push(`create:${label}`);
      attachLoader(this, label);
      h.folders.push(this);
      await this.reloadBare();
      const ext = this.services.resourceLoader.getExtensions();
      for (const { name, config } of ext.runtime.pendingProviderRegistrations) modelRuntime.registerProvider(name, config as Record<string, unknown>);
      ext.runtime.pendingProviderRegistrations = [];
    }));

    const registered = runtime as unknown as { _folders: Map<string, FolderRuntime>; _folderPromises: Map<string, Promise<FolderRuntime>> };
    for (const label of opts.folders ?? ['A', 'B']) {
      const folder = h.addFolder(label);
      registered._folders.set(folder.key, folder);
      registered._folderPromises.set(folder.key, Promise.resolve(folder));
    }
    return h;
  }

  type Ops = {
    _reconcileSubscriptionPin(pi: unknown, folders: readonly FolderRuntime[], created: FolderRuntime): Promise<void>;
    _setPluginInstalled(pi: unknown, installed: boolean): Promise<void>;
  };
  const reconcile = (h: Harness): Promise<void> => (h.runtime as unknown as Ops)._reconcileSubscriptionPin({}, h.folders, h.folders[0]!);
  const toggle = (h: Harness, allowance: boolean): Promise<void> => (h.runtime as unknown as Ops)._setPluginInstalled({}, allowance);

  /** Each step appears after the one before it. */
  function expectOrder(calls: string[], steps: string[]): void {
    let from = 0;
    for (const step of steps) {
      const at = calls.indexOf(step, from);
      expect(at, `${step} after index ${from} in ${calls.join(', ')}`).toBeGreaterThanOrEqual(0);
      from = at + 1;
    }
  }

  const reloads = (h: Harness): string[] => h.calls.filter((c) => c.startsWith('reload:'));

  /** A legacy-only install whose legacy plugin is registered, as at startup. */
  function legacyInstall(): Harness {
    const h = setup({ packages: [LEGACY], clones: [LEGACY] });
    h.providers.set('anthropic', { tag: 'legacy', oauth: true });
    return h;
  }

  it('(a) migrates a legacy-only install: acquire, swap, verify, then delete the legacy clone', async () => {
    const h = legacyInstall();

    await reconcile(h);

    expectOrder(h.calls, [
      `install:${CURRENT}`,
      `removeSettings:${LEGACY_REPO}`,
      'flush',
      'reload:A',
      'reload:B',
      'unregister:anthropic',
      'register:anthropic:current',
      'refresh',
    ]);
    expect(diskSources(h)).toEqual([CURRENT]);
    // Without the unregister, pi's merge would keep the legacy registration's `oauth`.
    expect(h.providers.get('anthropic')).toEqual({ tag: 'current' });
    expect(fs.existsSync(h.cloneDir(LEGACY))).toBe(false);
  });

  it('(a1) re-pins an install still listing the previous plugin pin to the current one at startup', async () => {
    const previous = 'https://github.com/gotgenes/pi-anthropic-auth@fc183fc54171c1fc511570733d8f86b9f66426f6';
    expect(classifySubscriptionSource(previous)).toBe('stale');
    const h = setup({ packages: [previous], clones: [previous] });

    await reconcile(h);

    expect(h.calls).toContain(`install:${CURRENT}`);
    expect(diskSources(h)).toEqual([CURRENT]);
    expect(h.providers.get('anthropic')).toEqual({ tag: 'current' });
  });

  it('(a2) the provider reset and flush cover every folder loader, with no gap between them', async () => {
    const h = legacyInstall();

    await reconcile(h);

    // One reset of the shared runtime, then each loader's registration, back to back: no await between
    // the unregister and the registers, or the built-in provider would serve a request in between.
    const unregister = h.calls.indexOf('unregister:anthropic');
    expect(h.calls.filter((c) => c === 'unregister:anthropic')).toHaveLength(1);
    expect(h.calls.slice(unregister, unregister + 3)).toEqual(['unregister:anthropic', 'register:anthropic:current', 'register:anthropic:current']);
    expect(h.calls.filter((c) => c === 'refresh')).toHaveLength(1);
    for (const folder of h.folders) {
      expect(folder.services.resourceLoader.getExtensions().runtime.pendingProviderRegistrations).toEqual([]);
    }
  });

  it('(b) leaves the working legacy plugin alone when the install fails', async () => {
    const h = legacyInstall();
    h.failInstall = true;

    await expect(reconcile(h)).resolves.toBeUndefined();

    expect(h.calls.filter((c) => c.startsWith('removeSettings') || c.startsWith('reload:') || c.startsWith('unregister'))).toEqual([]);
    expect(diskSources(h)).toEqual([LEGACY]);
    expect(fs.existsSync(h.cloneDir(LEGACY))).toBe(true);
  });

  it.each([
    ['registers no anthropic provider', 'none' as const, 'registered no anthropic provider'],
    ['reports a load error in its clone', 'error' as const, 'boom'],
  ])('(c/d) rolls back to the legacy plugin when the new one %s', async (_label, behavior, reason) => {
    for (const via of ['reconcile', 'toggle'] as const) {
      const h = legacyInstall();
      h.behavior.current = behavior;

      if (via === 'reconcile') {
        const logged = logLines.length;
        await expect(reconcile(h)).resolves.toBeUndefined();
        expect(logLines.slice(logged).join('\n')).toContain('subscription reconcile failed');
      } else {
        await expect(toggle(h, true)).rejects.toThrow(`subscription plugin failed to load: ${reason}`);
      }

      expect(diskSources(h)).toEqual([LEGACY]);
      expect(fs.existsSync(h.cloneDir(LEGACY))).toBe(true);
      // The verify pass and the rollback each reload both loaders.
      expect(reloads(h)).toEqual(['reload:A', 'reload:B', 'reload:A', 'reload:B']);
      expect(h.calls.lastIndexOf('register:anthropic:legacy')).toBeGreaterThan(h.calls.lastIndexOf('reload:B'));
      expect(h.providers.get('anthropic')).toEqual({ tag: 'legacy', oauth: true });
      restoreSpies();
      await PiRuntime.disposeInstance();
    }
  });

  it('(e) unlists the new plugin and falls back to the built-in provider when there is no legacy', async () => {
    const h = setup({ packages: [], clones: [] });
    h.behavior.current = 'none';

    await expect(toggle(h, true)).rejects.toThrow('registered no anthropic provider');

    expect(diskSources(h)).toEqual([]);
    expect(h.providers.has('anthropic')).toBe(false);
    expectOrder(h.calls, ['reload:A', 'reload:B', `removeSettings:${identity(CURRENT)}`, 'flush', 'reload:A', 'reload:B', 'unregister:anthropic', 'refresh']);
  });

  it('(f) with a healthy pin and a listed legacy entry, swaps without reinstalling', async () => {
    const h = setup({ packages: [CURRENT, LEGACY], clones: [CURRENT, LEGACY] });

    await toggle(h, true);

    expect(h.calls.some((c) => c.startsWith('install:'))).toBe(false);
    expect(diskSources(h)).toEqual([CURRENT]);
    expect(h.providers.get('anthropic')).toEqual({ tag: 'current' });
    expect(fs.existsSync(h.cloneDir(LEGACY))).toBe(false);
  });

  it('(g) does nothing for a healthy, registered pin with no legacy', async () => {
    const h = setup({ packages: [CURRENT], clones: [CURRENT] });
    h.providers.set('anthropic', { tag: 'current' });

    await toggle(h, true);
    await reconcile(h);

    expect(h.calls).toEqual([]);
  });

  it.each([
    ['legacy only', [LEGACY]],
    ['both listed', [CURRENT, LEGACY]],
  ])('(h) switching to extra usage removes every subscription entry (%s)', async (_label, packages) => {
    const h = setup({ packages, clones: packages });
    h.providers.set('anthropic', { tag: 'legacy', oauth: true });

    await toggle(h, false);

    expect(diskSources(h)).toEqual([]);
    expect(fs.existsSync(h.cloneDir(LEGACY))).toBe(false);
    expect(fs.existsSync(h.cloneDir(CURRENT))).toBe(false);
    // Every loader reloads before the reset, or one still holding the plugin re-flushes it at its next bind.
    expectOrder(h.calls, [`removeSettings:${LEGACY_REPO}`, 'flush', 'reload:A', 'reload:B', 'unregister:anthropic', 'refresh']);
    expect(h.providers.has('anthropic')).toBe(false);
  });

  it('(i) a failed legacy clone delete after a successful swap keeps the settings correct', async () => {
    const h = legacyInstall();
    h.failLegacyRemove = true;

    await expect(reconcile(h)).resolves.toBeUndefined();

    expect(diskSources(h)).toEqual([CURRENT]);
    expect(h.providers.get('anthropic')).toEqual({ tag: 'current' });
  });

  it('(j) unlists a current plugin that failed to load at startup', async () => {
    const h = setup({ packages: [CURRENT], clones: [CURRENT] });
    h.providers.set('anthropic', { tag: 'current' });
    h.startupErrors.push({ path: path.join(h.cloneDir(CURRENT), 'src', 'index.ts'), error: 'SyntaxError' });
    const logged = logLines.length;

    await reconcile(h);

    expect(diskSources(h)).toEqual([]);
    expectOrder(h.calls, [`removeSettings:${identity(CURRENT)}`, 'flush', 'reload:A', 'reload:B', 'unregister:anthropic', 'refresh']);
    expect(h.providers.has('anthropic')).toBe(false);
    expect(logLines.slice(logged).join('\n')).toContain('subscription plugin failed to load');
  });

  it('(j2) unlists a current plugin that loaded but registered no anthropic provider at startup', async () => {
    const h = setup({ packages: [CURRENT], clones: [CURRENT] });

    await reconcile(h);

    expect(diskSources(h)).toEqual([]);
    expect(h.calls).toContain('unregister:anthropic');
  });

  it('(k) deletes an orphan legacy clone with no provider change', async () => {
    const h = setup({ packages: [], clones: [LEGACY] });

    await reconcile(h);

    expect(fs.existsSync(h.cloneDir(LEGACY))).toBe(false);
    expect(h.calls).toEqual([`remove:${LEGACY_REPO}`]);
  });

  it('(l) a settings write that fails at the swap aborts before any reload or delete', async () => {
    const h = legacyInstall();
    h.failNextFlush = true;
    const logged = logLines.length;

    await expect(toggle(h, true)).rejects.toThrow('settings write failed (SyntaxError)');

    expect(reloads(h)).toEqual([]);
    expect(diskSources(h)).toEqual([LEGACY]);
    expect(fs.existsSync(h.cloneDir(LEGACY))).toBe(true);
    expect(h.providers.get('anthropic')).toEqual({ tag: 'legacy', oauth: true });
    expect(logLines.slice(logged).join('\n')).not.toContain('sk-file-text');
  });

  it('(l3) another writer\'s queued write that fails before a reload neither reads as an unloadable file nor fails the step', async () => {
    const h = legacyInstall();
    h.queuedWrite = true;
    h.failNextFlush = true;
    const logged = logLines.length;

    await toggle(h, true);

    expect(diskSources(h)).toEqual([CURRENT]);
    expect(h.providers.get('anthropic')).toMatchObject({ tag: 'current' });
    expect(logLines.slice(logged).join('\n')).toContain('settings write failed (global): SyntaxError');
    expect(logLines.slice(logged).join('\n')).not.toContain('sk-file-text');
  });

  it('(l2) every settings step over a user settings file pi cannot load fails, naming the file, until pi loads it', async () => {
    const h = legacyInstall();
    h.unloadable = true;
    const logged = logLines.length;
    const unreadable = `Damocles could not read ${path.join(h.runtime.agentDir, 'settings.json')}, so pi cannot save this change to it. Fix or delete the file, then try again.`;

    // pi records the load error once per load, so the second attempt is the one a drained error would let through.
    for (const allowance of [false, false, true]) {
      const failure = await toggle(h, allowance).then(() => null, (err: unknown) => err);
      expect(failure).toEqual(new LocalizedError({ message: 'Damocles could not read {0}, so pi cannot save this change to it. Fix or delete the file, then try again.', args: [path.join(h.runtime.agentDir, 'settings.json')] }));
      expect((failure as Error).message).toBe(unreadable);
    }

    expect(reloads(h)).toEqual([]);
    expect(h.calls.filter((c) => c.startsWith('remove') || c.startsWith('addSettings') || c.startsWith('unregister'))).toEqual([]);
    expect(h.memory.map(sourceOf)).toEqual([LEGACY]);
    expect(fs.existsSync(h.cloneDir(LEGACY))).toBe(true);
    expect(h.providers.get('anthropic')).toEqual({ tag: 'legacy', oauth: true });
    expect(logLines.slice(logged).join('\n')).toContain('SyntaxError');
    expect(logLines.slice(logged).join('\n')).not.toContain('sk-file-text');

    h.unloadable = false;
    await toggle(h, false);
    expect(diskSources(h)).toEqual([]);
  });

  it('(m) a verify reload that throws rolls back to the legacy plugin', async () => {
    const h = legacyInstall();
    h.failNextReload = true;

    await expect(toggle(h, true)).rejects.toThrow('subscription plugin failed to load: git clone failed');

    expect(diskSources(h)).toEqual([LEGACY]);
    expect(h.providers.get('anthropic')).toEqual({ tag: 'legacy', oauth: true });
    expect(fs.existsSync(h.cloneDir(LEGACY))).toBe(true);
  });

  it('(n) a failed repair of a listed plugin whose clone is gone unlists it', async () => {
    const h = setup({ packages: [CURRENT], clones: [] });
    h.providers.set('anthropic', { tag: 'current' });
    h.failInstall = true;

    await expect(toggle(h, true)).rejects.toThrow('network down');

    expect(diskSources(h)).toEqual([]);
    expect(h.providers.has('anthropic')).toBe(false);
  });

  it('(o) rollback does not relist a legacy entry whose clone another window deleted', async () => {
    const h = legacyInstall();
    h.behavior.current = 'none';
    const realRemove = fs.rmSync;
    // The legacy clone disappears between the swap and the rollback.
    h.calls.push = function (this: string[], ...items: string[]) {
      if (items.some((i) => i.startsWith('reload:')) && !this.some((c) => c.startsWith('reload:'))) {
        realRemove(h.cloneDir(LEGACY), { recursive: true, force: true });
      }
      return Array.prototype.push.apply(this, items);
    };

    await expect(toggle(h, true)).rejects.toThrow('registered no anthropic provider');

    expect(diskSources(h)).toEqual([]);
    expect(h.providers.has('anthropic')).toBe(false);
  });

  it('(p) rollback restores a legacy object entry with its filters', async () => {
    const entry = { source: LEGACY, extensions: ['src/index.ts'] };
    const h = setup({ packages: [entry], clones: [LEGACY] });
    h.providers.set('anthropic', { tag: 'legacy', oauth: true });
    h.behavior.current = 'none';

    await expect(toggle(h, true)).rejects.toThrow();

    expect(h.disk).toEqual([entry]);
  });

  it('(q) a later folder whose loader fails to load the plugin unlists it across every folder', async () => {
    const h = setup({ packages: [CURRENT], clones: [CURRENT], folders: ['A'] });
    h.providers.set('anthropic', { tag: 'current' });
    (h.runtime as unknown as { _pinReconciled: boolean })._pinReconciled = true;
    h.behavior.current = 'error';

    const b = await h.runtime.folder(path.join(path.dirname(h.folders[0]!.cwd), 'B'));

    expect(diskSources(h)).toEqual([]);
    expectOrder(h.calls, ['create:B', `removeSettings:${identity(CURRENT)}`, 'flush', 'reload:A', 'reload:B', 'unregister:anthropic', 'refresh']);
    expect(h.providers.has('anthropic')).toBe(false);
    expect(h.runtime.folders()).toEqual([h.folders[0], b]);
  });

  /** A promise and the function that settles it, so a case can hold one step open. */
  function deferred(): { promise: Promise<void>; release: () => void } {
    let release!: () => void;
    const promise = new Promise<void>((resolve) => {
      release = resolve;
    });
    return { promise, release };
  }

  it.each([
    ['commits', 'register' as const, [CURRENT], { tag: 'current' }],
    ['rolls back', 'none' as const, [LEGACY], { tag: 'legacy', oauth: true }],
  ])('a folder requested mid-reconcile is created only after the reconcile %s', async (_label, behavior, listed, provider) => {
    const h = setup({ packages: [LEGACY], clones: [LEGACY], folders: [] });
    h.providers.set('anthropic', { tag: 'legacy', oauth: true });
    h.behavior.current = behavior;
    const install = deferred();
    h.installGate = install.promise;
    const ws = path.join(path.dirname(h.cloneDir(LEGACY)), 'ws');

    const first = h.runtime.folder(path.join(ws, 'A'));
    await vi.waitFor(() => expect(h.calls).toContain(`install:${CURRENT}`));
    const second = h.runtime.folder(path.join(ws, 'B'));
    await new Promise((r) => setTimeout(r, 0));
    expect(h.calls).not.toContain('create:B');
    install.release();
    await Promise.all([first, second]);

    // The swap's last step (evicting the legacy clone, or the rollback's provider reset) precedes B.
    const swapEnd = behavior === 'register' ? h.calls.indexOf(`remove:${LEGACY_REPO}`) : h.calls.lastIndexOf('refresh');
    expect(swapEnd).toBeGreaterThanOrEqual(0);
    expect(h.calls.indexOf('create:B')).toBeGreaterThan(swapEnd);
    expect(diskSources(h)).toEqual(listed);
    // B flushed from settings already swapped, so no stale `oauth` merged back over the reset provider.
    expect(h.providers.get('anthropic')).toEqual(provider);
  });

  it('an allowance toggle issued while a folder is being created downloads at once, then swaps after it and reloads it too', async () => {
    const h = setup({ packages: [LEGACY], clones: [LEGACY], folders: ['A'] });
    h.providers.set('anthropic', { tag: 'legacy', oauth: true });
    (h.runtime as unknown as { _pinReconciled: boolean })._pinReconciled = true;
    const creating = deferred();
    const create = FolderRuntime.prototype.createServices as unknown as { getMockImplementation(): (this: FolderRuntime) => Promise<void> };
    const flushOnCreate = create.getMockImplementation();
    vi.spyOn(FolderRuntime.prototype, 'createServices').mockImplementation(async function (this: FolderRuntime) {
      await creating.promise;
      await flushOnCreate.call(this);
    });
    const a = h.folders[0]!;

    const b = h.runtime.folder(path.join(path.dirname(a.cwd), 'B'));
    await new Promise((r) => setTimeout(r, 0));
    const billing = h.runtime.setSubscriptionBilling(a.cwd, true);
    await vi.waitFor(() => expect(h.calls).toContain(`install:${CURRENT}`));
    expect(h.calls).not.toContain('flush');
    creating.release();
    await Promise.all([b, billing]);

    expectOrder(h.calls, [`install:${CURRENT}`, 'create:B', 'flush', 'reload:A', 'reload:B', 'unregister:anthropic', 'refresh']);
    expect(diskSources(h)).toEqual([CURRENT]);
    expect(h.providers.get('anthropic')).toEqual({ tag: 'current' });
  });

  it('a folder requested while the plugin downloads is created without waiting for the download', async () => {
    const h = setup({ packages: [LEGACY], clones: [LEGACY], folders: ['A'] });
    h.providers.set('anthropic', { tag: 'legacy', oauth: true });
    (h.runtime as unknown as { _pinReconciled: boolean })._pinReconciled = true;
    const install = deferred();
    h.installGate = install.promise;
    const a = h.folders[0]!;

    const billing = h.runtime.setSubscriptionBilling(a.cwd, true);
    await vi.waitFor(() => expect(h.calls).toContain(`install:${CURRENT}`));
    const created = await Promise.race([
      h.runtime.folder(path.join(path.dirname(a.cwd), 'B')),
      new Promise<'blocked'>((r) => setTimeout(() => r('blocked'), 1000)),
    ]);
    expect(created).not.toBe('blocked');
    expect(h.runtime.folders()).toContain(created);
    install.release();
    await billing;

    expectOrder(h.calls, [`install:${CURRENT}`, 'create:B', 'flush', 'reload:A', 'reload:B', 'unregister:anthropic', 'refresh']);
    expect(diskSources(h)).toEqual([CURRENT]);
    expect(h.providers.get('anthropic')).toEqual({ tag: 'current' });
  });

  it('two concurrent allowance toggles download the plugin once, never side by side', async () => {
    const h = setup({ packages: [], clones: [], folders: ['A'] });
    (h.runtime as unknown as { _pinReconciled: boolean })._pinReconciled = true;
    const install = deferred();
    h.installGate = install.promise;
    const a = h.folders[0]!;

    const first = h.runtime.setSubscriptionBilling(a.cwd, true);
    const second = h.runtime.setSubscriptionBilling(a.cwd, true);
    await vi.waitFor(() => expect(h.calls).toContain(`install:${CURRENT}`));
    await new Promise((r) => setTimeout(r, 0));
    expect(h.calls.filter((c) => c.startsWith('install:'))).toHaveLength(1);
    install.release();
    await Promise.all([first, second]);

    expect(h.calls.filter((c) => c.startsWith('install:'))).toHaveLength(1);
    expect(diskSources(h)).toEqual([CURRENT]);
  });

  it('a toggle to extra usage issued during a download applies after the allowance switch it follows', async () => {
    const h = setup({ packages: [], clones: [], folders: ['A'] });
    (h.runtime as unknown as { _pinReconciled: boolean })._pinReconciled = true;
    const install = deferred();
    h.installGate = install.promise;
    const a = h.folders[0]!;

    const on = h.runtime.setSubscriptionBilling(a.cwd, true);
    await vi.waitFor(() => expect(h.calls).toContain(`install:${CURRENT}`));
    const off = h.runtime.setSubscriptionBilling(a.cwd, false);
    await new Promise((r) => setTimeout(r, 0));
    install.release();
    await Promise.all([on, off]);

    expect(diskSources(h)).toEqual([]);
    expect(fs.existsSync(h.cloneDir(CURRENT))).toBe(false);
    expect(h.providers.has('anthropic')).toBe(false);
  });

  // A daemon's core bills Claude through its bundled plugin (allowance-transport.ts), never the host's pi packages.
  describe('on a daemon\'s core', () => {
    const CLAUDE = DEFAULT_MODELS.find((m) => m.value === 'claude-sonnet-5-5');
    const SUBSCRIPTION: HeldAuthEntry = { type: 'oauth', expires: Date.now() + 3_600_000, hasKey: false, flatFee: false };
    const ALLOWANCE: HeldAuthEntry = { ...SUBSCRIPTION, allowance: true };
    const PREVIOUS = 'https://github.com/gotgenes/pi-anthropic-auth@fc183fc54171c1fc511570733d8f86b9f66426f6';

    afterEach(() => {
      installFakePlatform();
    });

    function remoteSetup(anthropic: HeldAuthEntry, packages: Entry[] = [], folders: string[] = []): { h: Harness; remote: ReturnType<typeof createFakeRemoteHost> } {
      const remote = createFakeRemoteHost();
      installPlatform({ ...createFakePlatform(), remote: remote.remote });
      remote.set('clientAuth', 'client-a', { providers: { anthropic } });
      const h = setup({ packages, clones: packages.map(sourceOf), folders });
      return { h, remote };
    }

    /** The account state's billing of a Claude chat, from the runtime's live auth inputs. */
    function billing(h: Harness): { dollarBilled: boolean; subscription: string | undefined } {
      const deps = {
        modelValue: CLAUDE!.value,
        modelInfo: CLAUDE,
        claudeAuthMode: h.runtime.getClaudeAuthStatus().mode,
        openaiAuthStatus: h.runtime.getOpenAIAuthStatus(),
        preferApiKey: false,
        flatFeeKeyProviders: h.runtime.flatFeeKeyProviders(),
      };
      return { dollarBilled: dollarBilled(deps), subscription: subscriptionProvider(deps) };
    }

    // Locally the first folder would re-pin a stale and a legacy plugin: an install, settings writes and clone removals.
    it('opens a folder for an allowance client without installing, writing settings or removing a clone on the host', async () => {
      const { h } = remoteSetup(ALLOWANCE, [PREVIOUS, LEGACY]);

      const folder = await h.runtime.folder(path.join(h.runtime.agentDir, 'ws', 'A'));

      expect(h.runtime.folders()).toContain(folder);
      expect(h.calls.filter((c) => /^(install|remove|addSettings|removeSettings):/.test(c) || c === 'setPackages' || c === 'flush')).toEqual([]);
      expect(diskSources(h)).toEqual([PREVIOUS, LEGACY]);
      expect(fs.existsSync(h.cloneDir(LEGACY))).toBe(true);
    });

    // the runtime refreshes pi's availability snapshot, which reads the acting client's sign-ins, and only then tells
    // ChatPanelProvider, which republishes every panel (onActingClientRefreshed)
    it('bills the account state a view reads as the acting client chose, and refreshes pi\'s availability snapshot', async () => {
      const { h, remote } = remoteSetup(SUBSCRIPTION, [], ['A']);
      const refreshed = vi.fn();
      const stop = PiRuntime.onActingClientRefreshed(refreshed);
      remote.set('clientAuth', 'client-b', { providers: { anthropic: { type: 'api_key', hasKey: true, flatFee: false } } });
      const refreshes = h.calls.filter((c) => c === 'refresh').length;

      remote.setActing('client-b');

      expect(billing(h)).toEqual({ dollarBilled: true, subscription: undefined });
      await vi.waitFor(() => expect(refreshed).toHaveBeenCalledTimes(1));
      expect(h.calls.filter((c) => c === 'refresh')).toHaveLength(refreshes + 1);
      stop();
    });
  });
});

describe('nodeSupportsPi (B5)', () => {
  it('reflects the running Node major against the pi minimum', () => {
    const major = Number.parseInt(process.versions.node.split('.')[0] ?? '0', 10);
    expect(nodeSupportsPi()).toBe(major >= PI_MIN_NODE_MAJOR);
  });
});

/**
 * A5/A7 — `PiRuntime.syncCustomProviders` had no tests at all. `timedOut` is the single value deciding
 * between warning the user that their model was silently downgraded and saying nothing, and the outer
 * catch used to hardcode it to `false`. Everything here drives the real `custom-providers` sync against
 * an injected `ModelRuntime`, so the contract WORKSTREAM B consumes is asserted end to end.
 */
describe('PiRuntime.syncCustomProviders', () => {
  const STEPFUN_SECRET = 'damocles.explore.apiKey.stepfun';
  const DEEPSEEK_SECRET = 'damocles.deepseek.apiKey';
  const SENTINEL = 'sk-SENTINEL-MUST-NEVER-BE-LOGGED';

  beforeEach(() => {
    logLines.length = 0;
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await PiRuntime.disposeInstance();
  });

  type FakeRuntime = Record<string, unknown>;

  /** pi's runtime key overlay: a key it holds reports `runtime`, so an unchanged key is not re-applied. */
  function fakeModelRuntime(overrides: FakeRuntime = {}) {
    const keys = new Set<string>();
    return {
      registerProvider: vi.fn(),
      unregisterProvider: vi.fn(),
      setRuntimeApiKey: vi.fn(async (provider: string) => void keys.add(provider)),
      removeRuntimeApiKey: vi.fn(async (provider: string) => void keys.delete(provider)),
      logout: vi.fn(async (provider: string) => void keys.delete(provider)),
      getProviderAuthStatus: vi.fn((provider: string) => (keys.has(provider) ? { configured: true, source: 'runtime' } : { configured: false })),
      ...overrides,
    };
  }

  /** The only private reach-through: `_modelRuntime` is built by `init()`, which boots pi. */
  function attach(runtime: PiRuntime, modelRuntime: FakeRuntime): void {
    (runtime as unknown as { _modelRuntime: ModelRuntime })._modelRuntime = modelRuntime as unknown as ModelRuntime;
  }

  const secrets =
    (map: Record<string, string | undefined>): SecretResolver =>
    (key) =>
      Promise.resolve(map[key]);

  /** Replace the 3s deadline with a signal the test fires, so the timeout leg is exercised without
   *  waiting on it and no real timer is left behind. */
  function stubTimeout(signal: AbortSignal) {
    return vi.spyOn(AbortSignal, 'timeout').mockReturnValue(signal);
  }

  /** A `setRuntimeApiKey` that never settles until the forwarded signal aborts — pi's credential
   *  operations take the cross-process auth.json lock, and a contended lock is what this bounds. */
  function hangingApply() {
    let started!: () => void;
    const applyStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    const setRuntimeApiKey = vi.fn(
      (_provider: string, _key: string, options: { signal?: AbortSignal }) =>
        new Promise<void>((_resolve, reject) => {
          started();
          options.signal?.addEventListener('abort', () => reject(new DOMException('This operation was aborted', 'AbortError')), { once: true });
        }),
    );
    return { applyStarted, setRuntimeApiKey };
  }

  describe('a key provider sign-in', () => {
    const XAI_SECRET = 'damocles.xai.apiKey';

    afterEach(() => {
      installFakePlatform();
    });

    function setupSignIn(auth?: Record<string, unknown>) {
      const platform = installFakePlatform({ secrets: { [XAI_SECRET]: 'xai-key' } });
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'provider-sign-in-'));
      if (auth) fs.writeFileSync(path.join(dir, 'auth.json'), JSON.stringify(auth));
      const runtime = PiRuntime.get(dir);
      vi.spyOn(runtime, 'init').mockResolvedValue();
      const publishAccountInfo = vi.fn();
      runtime.registerSessionMutator('sess-sign-in', { publishAccountInfo, publishAvailableModels: vi.fn() } as unknown as LiveSessionMutator);
      return { runtime, dir, publishAccountInfo, platform };
    }

    const interaction = { prompt: async () => '', notify: () => undefined };
    const signInEntry = (extra: Record<string, unknown> = {}) => ({ type: 'oauth', access: 'a', refresh: 'r', expires: Date.now() + 3_600_000, ...extra });

    // ChatPanelProvider's sync listener reads every key status, and each read checks the prefer flag after an awaited secret read.
    it('starts no resync when the prefer flag changes during that provider\'s sign-in, and the sign-in\'s own sync applies it', async () => {
      const { runtime, dir, platform } = setupSignIn({ xai: signInEntry() });
      let loginStarted!: () => void;
      const started = new Promise<void>((resolve) => {
        loginStarted = resolve;
      });
      let finishLogin!: () => void;
      const login = vi.fn(() => new Promise<void>((resolve) => {
        finishLogin = () => {
          fs.writeFileSync(path.join(dir, 'auth.json'), JSON.stringify({ xai: signInEntry() }));
          resolve();
        };
        loginStarted();
      }));
      const modelRuntime = fakeModelRuntime({ login });
      attach(runtime, modelRuntime);
      await runtime.syncCustomProviders((key) => platform.secrets.get(key));
      expect(modelRuntime.setRuntimeApiKey).not.toHaveBeenCalled();

      const synced = vi.fn();
      const stop = PiRuntime.onCustomProvidersSynced(() => {
        synced();
        void platform.secrets.get(XAI_SECRET)
          .then(() => new Promise((resolve) => setImmediate(resolve)))
          .then(() => runtime.preferProviderApiKey('xai'));
      });
      try {
        const signIn = runtime.signInProvider('xai', interaction);
        await started;
        await runtime.setProviderPreferApiKey('xai', true);
        await new Promise((resolve) => setTimeout(resolve, 50));
        expect(synced).toHaveBeenCalledTimes(1);
        expect(modelRuntime.setRuntimeApiKey).not.toHaveBeenCalled();

        finishLogin();
        await signIn;
        await new Promise((resolve) => setTimeout(resolve, 50));
        expect(modelRuntime.setRuntimeApiKey).toHaveBeenCalledWith('xai', 'xai-key', expect.anything());
        expect(synced).toHaveBeenCalledTimes(2);
      } finally {
        stop();
      }
    });

    it('writes no prefer flag when init fails, so the status the panel shows stays true', async () => {
      const { runtime, platform } = setupSignIn();
      vi.spyOn(runtime, 'init').mockRejectedValue(new Error('pi failed to load'));
      await expect(runtime.setProviderPreferApiKey('xai', true)).rejects.toThrow('pi failed to load');
      expect(platform.state.global.get('damocles.xai.preferApiKey', false)).toBe(false);
    });

    // pi writes the new list, then resynchronizes its snapshot, before its login returns; a model adopted then is never checked again.
    it('reads a provider\'s plan afresh while it signs in, so the list its login writes gates at once', async () => {
      const { runtime, dir } = setupSignIn();
      expect(runtime.planModelIds('github-copilot')).toBeUndefined();
      let duringLogin: ReadonlySet<string> | undefined;
      const login = vi.fn(async () => {
        fs.writeFileSync(path.join(dir, 'auth.json'), JSON.stringify({ 'github-copilot': signInEntry({ availableModelIds: ['gpt-6-luna'] }) }));
        duringLogin = runtime.planModelIds('github-copilot');
      });
      attach(runtime, fakeModelRuntime({ login }));

      await runtime.signInProvider('github-copilot', interaction);

      expect(duringLogin).toEqual(new Set(['gpt-6-luna']));
      expect(runtime.planModelIds('github-copilot')).toEqual(new Set(['gpt-6-luna']));
    });

    // Reading a directory fails with EISDIR, as a locked auth.json fails with EBUSY or EPERM on Windows.
    it('refuses every plan model while auth.json cannot be read, and caches no such read', () => {
      const { runtime, dir } = setupSignIn();
      fs.mkdirSync(path.join(dir, 'auth.json'));
      expect(runtime.planModelIds('github-copilot')).toEqual(new Set());

      fs.rmdirSync(path.join(dir, 'auth.json'));
      fs.writeFileSync(path.join(dir, 'auth.json'), JSON.stringify({ 'github-copilot': signInEntry({ availableModelIds: ['gpt-6-luna'] }) }));
      expect(runtime.planModelIds('github-copilot')).toEqual(new Set(['gpt-6-luna']));
    });

    it('fails a sign-out while auth.json cannot be read, leaving the sign-in in place', async () => {
      const { runtime, dir } = setupSignIn();
      fs.mkdirSync(path.join(dir, 'auth.json'));
      const modelRuntime = fakeModelRuntime();
      attach(runtime, modelRuntime);

      await expect(runtime.signOutProvider('xai')).rejects.toThrow('auth.json could not be read');
      expect(modelRuntime.logout).not.toHaveBeenCalled();
    });

    it('keeps the key sync off the provider while pi signs it in, counts a stored credential as signed in, then syncs it and republishes', async () => {
      const { runtime, publishAccountInfo } = setupSignIn();
      let syncedDuringLogin: unknown[][] = [];
      const login = vi.fn(async () => {
        await runtime.syncCustomProviders(secrets({ [XAI_SECRET]: 'xai-key' }));
        syncedDuringLogin = modelRuntime.setRuntimeApiKey.mock.calls.slice();
        throw Object.assign(new Error('snapshot sync failed'), { name: 'CredentialSynchronizationError' });
      });
      const modelRuntime = fakeModelRuntime({ login });
      attach(runtime, modelRuntime);

      await runtime.signInProvider('xai', { prompt: async () => '', notify: () => undefined });

      expect(login).toHaveBeenCalledWith('xai', 'oauth', expect.anything());
      expect(syncedDuringLogin.map((call) => call[0])).not.toContain('xai');
      expect(modelRuntime.setRuntimeApiKey.mock.calls.map((call) => call[0])).toContain('xai');
      expect(publishAccountInfo).toHaveBeenCalled();
      expect(logLines.join('\n')).not.toContain('snapshot sync failed');
    });

    it('rethrows a failed sign-in after syncing the provider again', async () => {
      const { runtime } = setupSignIn();
      const modelRuntime = fakeModelRuntime({ login: vi.fn(async () => { throw new Error('xAI device code expired'); }) });
      attach(runtime, modelRuntime);

      await expect(runtime.signInProvider('xai', { prompt: async () => '', notify: () => undefined })).rejects.toThrow('xAI device code expired');
      expect(modelRuntime.setRuntimeApiKey.mock.calls.map((call) => call[0])).toContain('xai');
    });

    it('signs out only a stored sign-in, then applies the saved key again', async () => {
      const signedIn = setupSignIn({ xai: { type: 'oauth', access: 'a', refresh: 'r', expires: Date.now() + 3_600_000 } });
      // pi's logout deletes the stored credential from auth.json
      const withSignIn = fakeModelRuntime({ logout: vi.fn(async () => fs.writeFileSync(path.join(signedIn.dir, 'auth.json'), '{}')) });
      attach(signedIn.runtime, withSignIn);
      await signedIn.runtime.signOutProvider('xai');
      expect(withSignIn.logout).toHaveBeenCalledWith('xai');
      expect(withSignIn.setRuntimeApiKey).toHaveBeenCalledWith('xai', 'xai-key', expect.anything());
      expect(signedIn.publishAccountInfo).toHaveBeenCalled();
      await PiRuntime.disposeInstance();

      const keyOnly = setupSignIn({ xai: { type: 'api_key', key: 'pi-login-key' } });
      const withKey = fakeModelRuntime();
      attach(keyOnly.runtime, withKey);
      await keyOnly.runtime.signOutProvider('xai');
      expect(withKey.logout).not.toHaveBeenCalled();
    });
  });

  it('returns empty lists and no timeout before the runtime is initialized', async () => {
    const runtime = PiRuntime.get();
    const getSecret = vi.fn(async () => 'k');

    expect(await runtime.syncCustomProviders(getSecret)).toEqual({ wired: [], notWired: [], timedOut: false });
    expect(getSecret).not.toHaveBeenCalled();
  });

  it('returns empty lists and no timeout once disposed', async () => {
    const runtime = PiRuntime.get();
    attach(runtime, fakeModelRuntime());
    (runtime as unknown as { _disposed: boolean })._disposed = true;
    const getSecret = vi.fn(async () => 'k');

    expect(await runtime.syncCustomProviders(getSecret)).toEqual({ wired: [], notWired: [], timedOut: false });
    expect(getSecret).not.toHaveBeenCalled();
  });

  it('reports every wired provider, an empty notWired, and no timeout on the happy path', async () => {
    const runtime = PiRuntime.get();
    attach(runtime, fakeModelRuntime());
    const timeoutSpy = stubTimeout(new AbortController().signal);

    const result = await runtime.syncCustomProviders(secrets({ [STEPFUN_SECRET]: 'sf', [DEEPSEEK_SECRET]: 'ds' }));

    expect(result).toEqual({ wired: ['stepfun', 'deepseek'], notWired: [], timedOut: false });
    expect(timeoutSpy).toHaveBeenCalledWith(3000); // the bound the docstring and CHANGELOG name
  });

  // Each sync decides from the secrets and auth.json it read before its awaits, so two that overlap can apply a key the newer one removed.
  it('runs one sync at a time, and every call during a run shares the one follow-up queued behind it', async () => {
    const runtime = PiRuntime.get();
    stubTimeout(new AbortController().signal);
    let applyStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      applyStarted = resolve;
    });
    let finishApply!: () => void;
    const setRuntimeApiKey = vi.fn(async (_provider: string, key: string) => {
      if (key !== 'ds-1') return;
      applyStarted();
      await new Promise<void>((resolve) => {
        finishApply = resolve;
      });
    });
    attach(runtime, fakeModelRuntime({ setRuntimeApiKey }));
    const synced = vi.fn();
    const stop = PiRuntime.onCustomProvidersSynced(synced);
    try {
      const first = runtime.syncCustomProviders(secrets({ [DEEPSEEK_SECRET]: 'ds-1' }));
      await started;
      const second = runtime.syncCustomProviders(secrets({ [DEEPSEEK_SECRET]: 'ds-2' }));
      const third = runtime.syncCustomProviders(secrets({ [DEEPSEEK_SECRET]: 'ds-3' }));
      await new Promise((resolve) => setImmediate(resolve));
      expect(setRuntimeApiKey).toHaveBeenCalledTimes(1);

      finishApply();
      expect(await first).toEqual({ wired: ['deepseek'], notWired: [], timedOut: false });
      const [secondOutcome, thirdOutcome] = await Promise.all([second, third]);
      expect(secondOutcome).toBe(thirdOutcome);
      expect(secondOutcome).toEqual({ wired: ['deepseek'], notWired: [], timedOut: false });
      expect(setRuntimeApiKey.mock.calls.map((call) => [call[0], call[1]])).toEqual([['deepseek', 'ds-1'], ['deepseek', 'ds-3']]);
      expect(synced).toHaveBeenCalledTimes(2);
    } finally {
      stop();
    }
  });

  it('reports timedOut when a hanging credential operation is cut short by the deadline', async () => {
    const runtime = PiRuntime.get();
    const timeout = new AbortController();
    stubTimeout(timeout.signal);
    const { applyStarted, setRuntimeApiKey } = hangingApply();
    attach(runtime, fakeModelRuntime({ setRuntimeApiKey }));

    const pending = runtime.syncCustomProviders(secrets({ [STEPFUN_SECRET]: 'sf' }));
    await applyStarted;
    timeout.abort();

    // stepfun's secret was read, so it is known-configured despite never applying — B4 needs exactly
    // this to name the right provider in the fallback warning.
    expect(await pending).toEqual({ wired: [], notWired: ['stepfun'], timedOut: true });
    expect(logLines.join('\n')).toContain('custom provider sync timed out after 3000ms; not wired: stepfun');
  });

  it('does NOT report timedOut when the same cut-short sync was aborted by dispose()', async () => {
    // The `!` in `aborted && !this._syncAbort.signal.aborted` is the whole difference between telling
    // the user their model was downgraded and telling a closing window nothing. Inverting or dropping
    // it flips exactly this test against the previous one.
    const runtime = PiRuntime.get();
    stubTimeout(new AbortController().signal);
    const { applyStarted, setRuntimeApiKey } = hangingApply();
    attach(runtime, fakeModelRuntime({ setRuntimeApiKey }));

    const pending = runtime.syncCustomProviders(secrets({ [STEPFUN_SECRET]: 'sf' }));
    await applyStarted;
    await runtime.dispose();

    expect(await pending).toEqual({ wired: [], notWired: ['stepfun'], timedOut: false });
  });

  it('derives timedOut in the outer catch instead of hardcoding false', async () => {
    // Hardcoding `false` here told the caller "did not time out" on the one path where it certainly
    // had, so `PiSession.start` skipped the fallback warning — the exact silent downgrade this
    // release removes.
    const runtime = PiRuntime.get();
    stubTimeout(AbortSignal.abort());
    attach(
      runtime,
      fakeModelRuntime({
        getProviderAuthStatus: vi.fn(() => {
          throw new DOMException('This operation was aborted', 'AbortError');
        }),
      }),
    );

    expect(await runtime.syncCustomProviders(secrets({}))).toEqual({ wired: [], notWired: [], timedOut: true });
  });

  it('does not claim a timeout when the outer catch saw a plain failure', async () => {
    const runtime = PiRuntime.get();
    stubTimeout(AbortSignal.abort());
    attach(
      runtime,
      fakeModelRuntime({
        getProviderAuthStatus: vi.fn(() => {
          throw new Error('provider table is corrupt');
        }),
      }),
    );

    expect(await runtime.syncCustomProviders(secrets({}))).toEqual({ wired: [], notWired: [], timedOut: false });
  });

  it('notifies onCustomProvidersSynced after every sync, a failed one included, and not after unsubscribing', async () => {
    const runtime = PiRuntime.get();
    const synced = vi.fn();
    const stop = PiRuntime.onCustomProvidersSynced(synced);
    const readSecret = vi.fn(async () => undefined);
    await runtime.syncCustomProviders(readSecret);
    expect(synced).not.toHaveBeenCalled();

    const getProviderAuthStatus = vi.fn(() => ({ configured: false }));
    attach(runtime, fakeModelRuntime({ getProviderAuthStatus }));
    await runtime.syncCustomProviders(secrets({}));
    expect(synced).toHaveBeenCalledTimes(1);

    getProviderAuthStatus.mockImplementation(() => {
      throw new Error('provider table is corrupt');
    });
    await runtime.syncCustomProviders(secrets({}));
    expect(synced).toHaveBeenCalledTimes(2);

    stop();
    await runtime.syncCustomProviders(secrets({}));
    expect(synced).toHaveBeenCalledTimes(2);
  });

  // A key's kind decides a MiniMax chat's billing, so every open chat republishes when a credential changes.
  it('republishes account info to every session after a sync that changed a key, and not after an unchanged one', async () => {
    const runtime = PiRuntime.get();
    attach(runtime, fakeModelRuntime());
    const publishAccountInfo = vi.fn();
    runtime.registerSessionMutator('sess-billing', { publishAccountInfo, publishAvailableModels: vi.fn() } as unknown as LiveSessionMutator);
    const judge = vi.fn();
    const stop = PiRuntime.onMemoryJudgeChange(judge);
    try {
      await runtime.syncCustomProviders(secrets({ 'damocles.minimax.apiKey': 'sk-cp-x' }));
      expect(publishAccountInfo).toHaveBeenCalledTimes(1);
      expect([...runtime.flatFeeKeyProviders()]).toEqual(['minimax']);
      expect(judge).toHaveBeenCalledTimes(1);

      await runtime.syncCustomProviders(secrets({ 'damocles.minimax.apiKey': 'sk-cp-x' }));
      expect(publishAccountInfo).toHaveBeenCalledTimes(1);
      expect(judge).toHaveBeenCalledTimes(2);

      await runtime.syncCustomProviders(secrets({ 'damocles.minimax.apiKey': 'sk-api-x' }));
      expect(publishAccountInfo).toHaveBeenCalledTimes(2);
      expect(runtime.flatFeeKeyProviders()).toEqual(new Set());
    } finally {
      stop();
      runtime.unregisterSessionMutator('sess-billing', runtime.getSessionMutator('sess-billing')!);
    }
  });

  it('republishes account info after a failed sync, which may have changed a credential it could not report', async () => {
    const runtime = PiRuntime.get();
    stubTimeout(AbortSignal.abort());
    attach(
      runtime,
      fakeModelRuntime({
        getProviderAuthStatus: vi.fn(() => {
          throw new Error('provider table is corrupt');
        }),
      }),
    );
    const publishAccountInfo = vi.fn();
    runtime.registerSessionMutator('sess-billing', { publishAccountInfo, publishAvailableModels: vi.fn() } as unknown as LiveSessionMutator);
    await runtime.syncCustomProviders(secrets({}));
    expect(publishAccountInfo).toHaveBeenCalledTimes(1);
  });

  // A panel that has not started hears its picker providers only from this republish.
  it('reports the first sync as an account change though it changed no credential, and no later one', async () => {
    const runtime = PiRuntime.get();
    attach(runtime, fakeModelRuntime());
    const synced = vi.fn();
    const stop = PiRuntime.onCustomProvidersSynced(synced);
    try {
      await runtime.syncCustomProviders(secrets({}));
      await runtime.syncCustomProviders(secrets({}));
      expect(synced.mock.calls).toEqual([[{ accountChanged: true }], [{ accountChanged: false }]]);
    } finally {
      stop();
    }
  });

  // The removal drops its cache entry before pi takes it, so a removal that then fails reports no change.
  // pi still holds the key it failed to remove, which the provider being neither wired nor not wired reflects.
  it('republishes account info when a failed key removal changed the flat-fee providers', async () => {
    const runtime = PiRuntime.get();
    attach(runtime, fakeModelRuntime({ removeRuntimeApiKey: vi.fn(async () => { throw new Error('auth.json is locked'); }) }));
    const publishAccountInfo = vi.fn();
    runtime.registerSessionMutator('sess-billing', { publishAccountInfo, publishAvailableModels: vi.fn() } as unknown as LiveSessionMutator);
    const synced = vi.fn();
    const stop = PiRuntime.onCustomProvidersSynced(synced);
    try {
      await runtime.syncCustomProviders(secrets({ 'damocles.minimax.apiKey': 'sk-cp-x' }));
      expect(publishAccountInfo).toHaveBeenCalledTimes(1);

      expect(await runtime.syncCustomProviders(secrets({}))).toEqual({ wired: [], notWired: [], timedOut: false });
      expect(runtime.flatFeeKeyProviders()).toEqual(new Set());
      expect(publishAccountInfo).toHaveBeenCalledTimes(2);
      expect(synced.mock.calls).toEqual([[{ accountChanged: true }], [{ accountChanged: true }]]);

      await runtime.syncCustomProviders(secrets({}));
      expect(publishAccountInfo).toHaveBeenCalledTimes(2);
      expect(synced).toHaveBeenLastCalledWith({ accountChanged: false });
    } finally {
      stop();
      runtime.unregisterSessionMutator('sess-billing', runtime.getSessionMutator('sess-billing')!);
    }
  });

  it('resolves a sync whose listeners or account publishes throw, and still runs the ones after them', async () => {
    const runtime = PiRuntime.get();
    attach(runtime, fakeModelRuntime());
    const failing = { publishAccountInfo: vi.fn(() => { throw new Error('panel is gone'); }) };
    const healthy = { publishAccountInfo: vi.fn() };
    runtime.registerSessionMutator('sess-failing', failing as unknown as LiveSessionMutator);
    runtime.registerSessionMutator('sess-healthy', healthy as unknown as LiveSessionMutator);
    const judge = vi.fn();
    const later = vi.fn();
    const stops = [
      PiRuntime.onMemoryJudgeChange(() => { throw new Error('judge listener failed'); }),
      PiRuntime.onMemoryJudgeChange(judge),
      PiRuntime.onCustomProvidersSynced(() => { throw new Error('image settings failed'); }),
      PiRuntime.onCustomProvidersSynced(later),
    ];
    try {
      expect(await runtime.syncCustomProviders(secrets({ [DEEPSEEK_SECRET]: 'ds' }))).toEqual({ wired: ['deepseek'], notWired: [], timedOut: false });
      expect(healthy.publishAccountInfo).toHaveBeenCalledTimes(1);
      expect(judge).toHaveBeenCalledTimes(1);
      expect(later).toHaveBeenCalledWith({ accountChanged: true });
      expect(logLines.join('\n')).toContain('custom provider sync listener failed');
    } finally {
      for (const stop of stops) stop();
      runtime.unregisterSessionMutator('sess-failing', runtime.getSessionMutator('sess-failing')!);
      runtime.unregisterSessionMutator('sess-healthy', runtime.getSessionMutator('sess-healthy')!);
    }
  });

  it('has no flat-fee key providers before the model runtime exists', () => {
    expect(PiRuntime.get().flatFeeKeyProviders()).toEqual(new Set());
  });

  // VS Code reports no global-state change from another window, so the billing read that every turn makes is where it is seen.
  it('re-syncs the keys once when an account read finds a prefer flag another window changed', async () => {
    const fake = installFakePlatform();
    const runtime = PiRuntime.get();
    attach(runtime, fakeModelRuntime());
    await runtime.syncCustomProviders(secrets({}));
    const sync = vi.spyOn(runtime, 'syncCustomProviders').mockResolvedValue({ wired: [], notWired: [], timedOut: false });
    runtime.flatFeeKeyProviders();
    expect(sync).not.toHaveBeenCalled();

    // DeepSeek has no sign-in, so its flag cannot change which credential pi sends
    await fake.state.global.update('damocles.deepseek.preferApiKey', true);
    runtime.flatFeeKeyProviders();
    expect(sync).not.toHaveBeenCalled();

    await fake.state.global.update('damocles.xai.preferApiKey', true);
    runtime.flatFeeKeyProviders();
    runtime.flatFeeKeyProviders();
    expect(sync).toHaveBeenCalledTimes(1);
  });

  // pi's stored-credential snapshot follows auth.json only after the refresh; a failed one must not skip the key syncs.
  it('refreshes availability first on an auth.json change, and still re-applies both key rules when that refresh fails', async () => {
    const runtime = PiRuntime.get();
    const getAvailable = vi.fn(async () => {
      throw new Error('auth.json is locked');
    });
    attach(runtime, fakeModelRuntime({ getAvailable }));
    const openai = vi.spyOn(runtime as unknown as { _syncOpenAIRuntimeKeyNow: () => Promise<void> }, '_syncOpenAIRuntimeKeyNow').mockResolvedValue();
    let synced!: () => void;
    const customSynced = new Promise<void>((resolve) => {
      synced = resolve;
    });
    const custom = vi.spyOn(runtime, 'syncCustomProviders').mockImplementation(async () => {
      synced();
      return { wired: [], notWired: [], timedOut: false };
    });

    // what the watch runs for a change no flow of this process publishes
    void (runtime as unknown as { _applyAuthFileChange(): Promise<void> })._applyAuthFileChange();
    await customSynced;

    expect(getAvailable).toHaveBeenCalledWith();
    expect(getAvailable.mock.invocationCallOrder[0]).toBeLessThan(openai.mock.invocationCallOrder[0]!);
    expect(openai.mock.invocationCallOrder[0]).toBeLessThan(custom.mock.invocationCallOrder[0]!);
    expect(logLines.join('\n')).toMatch(/availability refresh after an auth\.json change failed: .*auth\.json is locked/);
  });

  it('never writes a credential carried by the failure the outer catch logs (A1)', async () => {
    const runtime = PiRuntime.get();
    stubTimeout(AbortSignal.abort());
    attach(
      runtime,
      fakeModelRuntime({
        getProviderAuthStatus: vi.fn(() => {
          throw Object.assign(new Error('failed to synchronize credential state'), {
            name: 'CredentialSynchronizationError',
            credential: { type: 'api_key', key: SENTINEL },
          });
        }),
      }),
    );

    await runtime.syncCustomProviders(secrets({}));

    const output = logLines.join('\n');
    expect(output).toContain('syncCustomProviders failed (non-fatal): CredentialSynchronizationError');
    expect(output).not.toContain(SENTINEL);
    expect(output).not.toContain('api_key');
  });

  describe('the OpenRouter catalog for the applied key', () => {
    const OPENROUTER_SECRET = 'damocles.explore.apiKey.openrouter';
    type RefreshOptions = { allowNetwork?: boolean; providers?: string[]; signal?: AbortSignal };
    type RefreshResult = { aborted: boolean; errors: Map<string, Error> };

    /**
     * pi 1.4.0's OpenRouter catalog refresh as its caller can observe it. A refresh that includes the provider supersedes
     * its running one (pi-ai models.js:127-142, 189-190), which then ends with no error and with `aborted` read off the
     * caller's signal alone (models.js:211-220, 234). Without `allowNetwork` the runtime's `PI_OFFLINE` switch applies
     * (pi-coding-agent core/model-runtime.js:97, 603; models.js:204). A networked refresh still current when its fetch
     * ends saves `{ models, checkedAt }` (remote-catalog-provider.js:178-186) under the provider id (models-store.js:92-101)
     * before it resolves (models.js:143-163). `registerProvider` and `unregisterProvider` each start an offline refresh of
     * every provider (model-runtime.js:682, 689); a runtime key change refreshes only its own provider (model-runtime.js:411),
     * and a runtime key is what `getProviderAuthStatus` reports first (model-runtime.js:441-443).
     */
    class PiOpenRouterModel {
      /** Network requests in flight, released by the test; a superseded one is already settled. */
      readonly fetches: Array<() => void> = [];
      private running: AbortController | null = null;
      readonly storePath: string;
      readonly modelNetworkEnabled: boolean;
      private readonly respondAtOnce: boolean;

      constructor(storePath: string, modelNetworkEnabled = true, respondAtOnce = false) {
        this.storePath = storePath;
        this.modelNetworkEnabled = modelNetworkEnabled;
        this.respondAtOnce = respondAtOnce;
      }

      readonly refresh = vi.fn(async (options: RefreshOptions): Promise<RefreshResult> => {
        const caller = options.signal ?? new AbortController().signal;
        if (caller.aborted) return { aborted: true, errors: new Map() };
        if (options.providers && !options.providers.includes('openrouter')) return { aborted: false, errors: new Map() };
        this.running?.abort();
        const controller = new AbortController();
        this.running = controller;
        const signal = AbortSignal.any([caller, controller.signal]);
        try {
          if (options.allowNetwork ?? this.modelNetworkEnabled) {
            await new Promise<void>((resolve, reject) => {
              if (this.respondAtOnce) resolve();
              else this.fetches.push(resolve);
              signal.addEventListener('abort', () => reject(signal.reason), { once: true });
            });
            if (!signal.aborted) this.save({ models: [], checkedAt: Date.now() });
          }
        } catch {
          // pi records no error for a provider refresh that was aborted.
        } finally {
          if (this.running === controller) this.running = null;
        }
        return { aborted: caller.aborted, errors: new Map() };
      });
      readonly registerProvider = vi.fn(() => void this.refresh({ allowNetwork: false }));
      readonly unregisterProvider = vi.fn(() => void this.refresh({ allowNetwork: false }));
      private readonly runtimeKeys = new Set<string>();
      readonly setRuntimeApiKey = vi.fn(async (provider: string) => {
        this.runtimeKeys.add(provider);
        await this.refresh({ allowNetwork: false, providers: [provider] });
      });
      readonly removeRuntimeApiKey = vi.fn(async (provider: string) => {
        this.runtimeKeys.delete(provider);
        await this.refresh({ allowNetwork: false, providers: [provider] });
      });
      readonly getProviderAuthStatus = (provider: string) => (this.runtimeKeys.has(provider) ? { configured: true, source: 'runtime' } : { configured: false });

      /** Damocles' own refreshes: pi's internal ones always pass `allowNetwork: false`. */
      catalogRefreshes(): RefreshOptions[] {
        return this.refresh.mock.calls.map(([options]) => options).filter((options) => options.allowNetwork !== false);
      }

      savedCheckedAt(): unknown {
        if (!fs.existsSync(this.storePath)) return undefined;
        return (JSON.parse(fs.readFileSync(this.storePath, 'utf8')) as Record<string, { checkedAt?: unknown }>).openrouter?.checkedAt;
      }

      private save(entry: { models: unknown[]; checkedAt: number }): void {
        const saved = fs.existsSync(this.storePath) ? (JSON.parse(fs.readFileSync(this.storePath, 'utf8')) as Record<string, unknown>) : {};
        fs.writeFileSync(this.storePath, JSON.stringify({ ...saved, openrouter: entry }, null, 2));
      }
    }

    let agentDir: string;
    beforeEach(() => {
      agentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'damocles-openrouter-catalog-'));
    });
    afterEach(() => {
      fs.rmSync(agentDir, { recursive: true, force: true });
    });

    function withPi(options: { online?: boolean; respondAtOnce?: boolean; clock?: AbortSignal } = {}) {
      const runtime = PiRuntime.get(agentDir);
      const pi = new PiOpenRouterModel(path.join(agentDir, 'models-store.json'), options.online ?? true, options.respondAtOnce ?? false);
      attach(
        runtime,
        fakeModelRuntime({
          refresh: pi.refresh,
          registerProvider: pi.registerProvider,
          unregisterProvider: pi.unregisterProvider,
          setRuntimeApiKey: pi.setRuntimeApiKey,
          removeRuntimeApiKey: pi.removeRuntimeApiKey,
          getProviderAuthStatus: pi.getProviderAuthStatus,
          modelNetworkEnabled: pi.modelNetworkEnabled,
        }),
      );
      stubTimeout(options.clock ?? new AbortController().signal);
      return { runtime, pi };
    }

    function withRefresh(refresh: (options: RefreshOptions) => Promise<unknown>) {
      const runtime = PiRuntime.get(agentDir);
      const spy = vi.fn(refresh);
      attach(runtime, fakeModelRuntime({ refresh: spy, modelNetworkEnabled: true }));
      stubTimeout(new AbortController().signal);
      return { runtime, refresh: spy };
    }

    function holdProviderSync(runtime: PiRuntime): { release: () => void; held: Promise<void> } {
      let release!: () => void;
      const held = (runtime as unknown as { _withProviderSync<T>(op: () => Promise<T>): Promise<T> })._withProviderSync(
        () => new Promise<void>((resolve) => (release = resolve)),
      );
      return { release: () => release(), held };
    }

    const settle = () => new Promise((resolve) => setTimeout(resolve, 20));
    const logged = () => logLines.join('\n');

    it("refreshes OpenRouter alone under pi's own offline switch when a key is first applied, without holding up the sync", async () => {
      const { runtime, pi } = withPi();

      const result = await runtime.syncCustomProviders(secrets({ [OPENROUTER_SECRET]: 'or-1' }));

      expect(result.wired).toContain('openrouter');
      await vi.waitFor(() => expect(pi.fetches).toHaveLength(1));
      expect(pi.catalogRefreshes()).toEqual([{ providers: ['openrouter'], signal: expect.any(AbortSignal) }]);
      expect(pi.catalogRefreshes()[0]).not.toHaveProperty('allowNetwork');
    });

    it('refreshes the catalog after an OpenRouter sign-in that applied no saved key, and not after a failed one', async () => {
      const runtime = PiRuntime.get(agentDir);
      vi.spyOn(runtime, 'init').mockResolvedValue();
      const pi = new PiOpenRouterModel(path.join(agentDir, 'models-store.json'), true, true);
      const login = vi.fn(async () => {});
      attach(runtime, fakeModelRuntime({ refresh: pi.refresh, registerProvider: pi.registerProvider, unregisterProvider: pi.unregisterProvider, login, modelNetworkEnabled: true }));
      stubTimeout(new AbortController().signal);
      const interaction = { prompt: async () => '', notify: () => undefined };

      await runtime.signInProvider('openrouter', interaction);
      await vi.waitFor(() => expect(pi.catalogRefreshes()).toEqual([{ providers: ['openrouter'], signal: expect.any(AbortSignal) }]));

      login.mockRejectedValueOnce(new Error('denied'));
      await expect(runtime.signInProvider('openrouter', interaction)).rejects.toThrow('denied');
      await settle();
      expect(pi.catalogRefreshes()).toHaveLength(1);
    });

    it('makes no catalog request while pi is offline, and says so', async () => {
      const { runtime, pi } = withPi({ online: false });

      await runtime.syncCustomProviders(secrets({ [OPENROUTER_SECRET]: 'or-1' }));
      await settle();

      expect(pi.catalogRefreshes()).toEqual([]);
      expect(logged()).toContain('OpenRouter catalog not refreshed: pi is offline (PI_OFFLINE)');
    });

    it('holds nothing queued on the provider sync, which folder creation waits on, while it runs', async () => {
      const { runtime, pi } = withPi();
      await runtime.syncCustomProviders(secrets({ [OPENROUTER_SECRET]: 'or-1' }));
      await vi.waitFor(() => expect(pi.fetches).toHaveLength(1));

      const queued = (runtime as unknown as { _withProviderSync<T>(op: () => Promise<T>): Promise<T> })._withProviderSync(async () => 'ran');

      await expect(queued).resolves.toBe('ran');
      expect(pi.catalogRefreshes()[0]!.signal!.aborted).toBe(false);
    });

    it('makes no networked call for the same key again or another provider, once a catalog is saved', async () => {
      const { runtime, pi } = withPi({ respondAtOnce: true });
      await runtime.syncCustomProviders(secrets({ [OPENROUTER_SECRET]: 'or-1' }));
      await vi.waitFor(() => expect(pi.savedCheckedAt()).toEqual(expect.any(Number)));

      await runtime.syncCustomProviders(secrets({ [OPENROUTER_SECRET]: 'or-1' }));
      await runtime.syncCustomProviders(secrets({ [OPENROUTER_SECRET]: 'or-1', [STEPFUN_SECRET]: 'sf' }));
      await settle();

      expect(pi.catalogRefreshes()).toHaveLength(1);
      expect(logged()).not.toContain('superseded');
    });

    it('retries a refresh another registration superseded once the provider sync is idle, and stops when a catalog is saved', async () => {
      const { runtime, pi } = withPi();
      await runtime.syncCustomProviders(secrets({ [OPENROUTER_SECRET]: 'or-1' }));
      await vi.waitFor(() => expect(pi.fetches).toHaveLength(1));
      const folderCreation = holdProviderSync(runtime);

      pi.registerProvider();
      await vi.waitFor(() => expect(logged()).toContain('OpenRouter catalog refresh was superseded by another refresh of the provider; retrying'));
      await settle();
      expect(pi.catalogRefreshes()).toHaveLength(1);

      folderCreation.release();
      await vi.waitFor(() => expect(pi.fetches).toHaveLength(2));
      pi.fetches[1]!();
      await vi.waitFor(() => expect(pi.savedCheckedAt()).toEqual(expect.any(Number)));
      await settle();

      expect(pi.catalogRefreshes()).toHaveLength(2);
      expect(logged()).not.toContain('superseded again');
    });

    it('logs a refresh superseded on its retry too, and leaves the list until the next key', async () => {
      const { runtime, pi } = withPi();
      await runtime.syncCustomProviders(secrets({ [OPENROUTER_SECRET]: 'or-1' }));
      await vi.waitFor(() => expect(pi.fetches).toHaveLength(1));

      pi.registerProvider();
      await vi.waitFor(() => expect(pi.fetches).toHaveLength(2));
      pi.unregisterProvider();

      await vi.waitFor(() => expect(logged()).toContain('OpenRouter catalog refresh was superseded again; the saved or shipped list stays until the next applied key'));
      await settle();
      expect(pi.catalogRefreshes()).toHaveLength(2);
      expect(pi.savedCheckedAt()).toBeUndefined();
    });

    it('aborts the running refresh when the key is removed, without a retry', async () => {
      const { runtime, pi } = withPi();
      await runtime.syncCustomProviders(secrets({ [OPENROUTER_SECRET]: 'or-1' }));
      await vi.waitFor(() => expect(pi.fetches).toHaveLength(1));
      const first = pi.catalogRefreshes()[0]!.signal!;

      await runtime.syncCustomProviders(secrets({}));
      await settle();

      expect(first.aborted).toBe(true);
      expect(pi.catalogRefreshes()).toHaveLength(1);
      expect(logged()).not.toContain('superseded');
    });

    it('bounds the wait for the provider sync with the same clock as the refresh, and says when it gave up', async () => {
      const clock = new AbortController();
      const { runtime, pi } = withPi({ clock: clock.signal });
      const folderCreation = holdProviderSync(runtime);
      await runtime.syncCustomProviders(secrets({ [OPENROUTER_SECRET]: 'or-1' }));

      clock.abort();

      await vi.waitFor(() => expect(logged()).toContain('OpenRouter catalog refresh gave up after 30000ms waiting for provider registrations'));
      folderCreation.release();
      await folderCreation.held;
      await settle();
      expect(pi.catalogRefreshes()).toEqual([]);
    });

    it('says when the clock ran out during the refresh', async () => {
      const clock = new AbortController();
      const { runtime, pi } = withPi({ clock: clock.signal });
      await runtime.syncCustomProviders(secrets({ [OPENROUTER_SECRET]: 'or-1' }));
      await vi.waitFor(() => expect(pi.fetches).toHaveLength(1));

      clock.abort();

      await vi.waitFor(() => expect(logged()).toContain('OpenRouter catalog refresh timed out after 30000ms'));
      expect(pi.catalogRefreshes()).toHaveLength(1);
    });

    it('logs a failed refresh by error name only when its message has no status, and does not throw', async () => {
      const { runtime, refresh } = withRefresh(async () => {
        throw new SyntaxError(`Unexpected token in "${SENTINEL}" is not valid JSON`);
      });

      await runtime.syncCustomProviders(secrets({ [OPENROUTER_SECRET]: 'or-1' }));
      await vi.waitFor(() => expect(refresh).toHaveBeenCalledOnce());
      await vi.waitFor(() => expect(logged()).toMatch(/OpenRouter catalog refresh failed: SyntaxError$/m));

      expect(logged()).not.toContain(SENTINEL);
    });

    it("logs a provider error the refresh reports by name and pi's HTTP status", async () => {
      const { runtime } = withRefresh(async () => ({ aborted: false, errors: new Map([['openrouter', new Error('OpenRouter model list request failed: 500')]]) }));

      await runtime.syncCustomProviders(secrets({ [OPENROUTER_SECRET]: 'or-1' }));

      await vi.waitFor(() => expect(logged()).toContain('OpenRouter catalog refresh failed: Error (HTTP 500)'));
    });

    it('aborts the running refresh when another key is applied, and on dispose', async () => {
      const { runtime, pi } = withPi();
      await runtime.syncCustomProviders(secrets({ [OPENROUTER_SECRET]: 'or-1' }));
      await vi.waitFor(() => expect(pi.fetches).toHaveLength(1));
      const first = pi.catalogRefreshes()[0]!.signal!;

      await runtime.syncCustomProviders(secrets({ [OPENROUTER_SECRET]: 'or-2' }));
      expect(first.aborted).toBe(true);
      await vi.waitFor(() => expect(pi.fetches).toHaveLength(2));
      const second = pi.catalogRefreshes()[1]!.signal!;
      expect(second.aborted).toBe(false);

      await runtime.dispose();
      expect(second.aborted).toBe(true);
      expect(logged()).not.toContain('superseded');
    });
  });

  describe("pi's catalog state as Damocles reads it, against the installed pi", () => {
    afterEach(() => {
      vi.unstubAllEnvs();
    });

    it.each([
      ['unset', undefined, true],
      ['set', '1', false],
      ['set to an empty string', '', false],
    ])("reads pi's model network switch with PI_OFFLINE %s", async (_label, value, enabled) => {
      if (value === undefined) delete process.env.PI_OFFLINE;
      else vi.stubEnv('PI_OFFLINE', value);
      const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'damocles-pi-offline-'));
      try {
        const pi = await initPiLoader();
        const modelRuntime = await pi!.ModelRuntime.create({
          authPath: path.join(agentDir, 'auth.json'),
          modelsPath: path.join(agentDir, 'models.json'),
          refreshOnCreate: false,
        });
        expect(piModelNetworkEnabled(modelRuntime)).toBe(enabled);
      } finally {
        fs.rmSync(agentDir, { recursive: true, force: true });
      }
    });

    it("reads the checkedAt pi's own models store saved for a provider", async () => {
      const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'damocles-models-store-'));
      const storePath = path.join(agentDir, 'models-store.json');
      try {
        const piStore = (await import(
          /* @vite-ignore */ pathToFileURL(path.resolve('node_modules/@earendil-works/pi-coding-agent/dist/core/models-store.js')).href
        )) as { FileModelsStore: new (path: string) => { write(provider: string, entry: unknown): Promise<void> } };
        expect(await savedCatalogCheckedAt(storePath, 'openrouter')).toBeUndefined();

        await new piStore.FileModelsStore(storePath).write('stepfun', { models: [], checkedAt: 1 });
        expect(await savedCatalogCheckedAt(storePath, 'openrouter')).toBeUndefined();

        await new piStore.FileModelsStore(storePath).write('openrouter', { models: [], checkedAt: 1_760_000_000_000 });
        expect(await savedCatalogCheckedAt(storePath, 'openrouter')).toBe(1_760_000_000_000);
      } finally {
        fs.rmSync(agentDir, { recursive: true, force: true });
      }
    });
  });
});

describe('PiRuntime sub-call model', () => {
  const HAIKU = { id: 'claude-haiku-5-5', provider: 'anthropic', reasoning: true, cost: { input: 1, output: 5 } };
  const STEP = { id: 'step-5-preview', provider: 'stepfun', reasoning: true, cost: { input: 0.2, output: 0.8 } };

  function runtimeWith(authed: Set<string>): PiRuntime {
    const runtime = PiRuntime.get();
    const internals = runtime as unknown as { _modelRuntime: unknown; _folders: Map<string, unknown> };
    internals._modelRuntime = {
      getModel: (provider: string, id: string) => [HAIKU, STEP].find((m) => m.provider === provider && m.id === id),
      hasConfiguredAuth: (provider: string) => authed.has(provider),
    };
    internals._folders.set('/ws', {});
    return runtime;
  }

  afterEach(async () => {
    vi.restoreAllMocks();
    await PiRuntime.disposeInstance();
  });

  it('ignores the Explore settings', () => {
    installFakePlatform({ settings: { user: { 'damocles.explore.model': 'step-5-preview', 'damocles.explore.effort': 'high' } } });
    const runtime = runtimeWith(new Set(['anthropic', 'stepfun']));
    expect(runtime.describeSubCallModel()).toMatchObject({ provider: 'anthropic', id: 'claude-haiku-5-5' });
  });

  it('treats a picked Background model whose provider is signed out as no model, not a fallback', () => {
    installFakePlatform({ settings: { user: { 'damocles.background.model': 'step-5-preview' } } });
    const authed = new Set(['anthropic']);
    const runtime = runtimeWith(authed);

    expect(runtime.hasAuthedSubCallModel('memory-extract')).toBe(false);
    expect(runtime.describeSubCallModel()).toBeNull();
    authed.add('stepfun');
    expect(runtime.describeSubCallModel()).toMatchObject({ provider: 'stepfun', id: 'step-5-preview', inputPerMTok: 0.2, outputPerMTok: 0.8 });
  });

  it('reports the effort an audit call runs at: the purpose level on Automatic, the picked effort otherwise', async () => {
    await loadPiAi();
    installFakePlatform();
    expect(runtimeWith(new Set(['anthropic'])).describeSubCallModel()).toMatchObject({ id: 'claude-haiku-5-5', effort: SUBCALL_THINKING['memory-audit'] });
    await PiRuntime.disposeInstance();

    installFakePlatform({ settings: { user: { 'damocles.background.model': 'step-5-preview', 'damocles.background.effort': 'high' } } });
    expect(runtimeWith(new Set(['stepfun'])).describeSubCallModel()).toMatchObject({ id: 'step-5-preview', effort: 'high' });
  });
});

describe("PiRuntime: the retired-tool migration's damocles.tools.disabled lists", () => {
  const KEY = 'damocles.tools.disabled';
  type Internals = {
    rewriteDisabledToolLists(scopes: readonly ('user' | 'local')[], rename: (name: string) => string): Promise<void>;
    personalDisabledToolLists(scopes: readonly ('user' | 'local')[]): PersonalToolLists;
    projectDisabledToolList(): unknown;
  };
  const rename = (name: string) => (name === 'mcp__s__get_a' ? 'mcp__s__read_mcp_resource(s://a)' : name);
  afterEach(async () => {
    await PiRuntime.disposeInstance();
  });

  it('rewrites each scope in place, keeping every other entry where it was, duplicates included, and writes a scope it leaves unchanged not at all', async () => {
    const platform = installFakePlatform({ settings: { user: { [KEY]: ['x', 'mcp__s__get_a', 7, 'x'] }, local: { [KEY]: ['y', 'y'] } } });
    const update = vi.spyOn(platform.settings, 'update');
    const runtime = PiRuntime.get() as unknown as Internals;

    await runtime.rewriteDisabledToolLists(['user', 'local'], rename);

    expect(platform.settings.inspect(KEY).userValue).toEqual(['x', 'mcp__s__read_mcp_resource(s://a)', 7, 'x']);
    expect(platform.settings.inspect(KEY).localValue).toEqual(['y', 'y']);
    expect(update).toHaveBeenCalledExactlyOnceWith(KEY, ['x', 'mcp__s__read_mcp_resource(s://a)', 7, 'x'], 'user');
  });

  it("names the personal lists by their scope's file, or the user scope by the setting where the host keeps no file", () => {
    installFakePlatform({ settings: { user: { [KEY]: ['a', 3] }, local: { [KEY]: ['b'] }, scopeFiles: { local: '/repo/.damocles/settings.local.json' } } });
    const lists = (PiRuntime.get() as unknown as Internals).personalDisabledToolLists(['user', 'local']).lists();
    expect(lists).toEqual([{ setting: KEY, scope: 'user', names: ['a'] }, { path: '/repo/.damocles/settings.local.json', names: ['b'] }]);
  });

  it('logs each damocles.tools.disabled entry that can turn nothing off, by file and index', () => {
    installFakePlatform({
      settings: {
        user: { [KEY]: ['mcp__s__read_mcp_resource', 'mcp__s__read_mcp_resource(s://a)', 'mcp__*__read_mcp_resource(*)', 'mcp__s__get_a(x)', 'Bash'] },
        scopeFiles: { user: '/home/me/.damocles/settings.json' },
      },
    });
    logLines.length = 0;

    (PiRuntime.get() as unknown as { logInertDisabledToolEntries(): void }).logInertDisabledToolEntries();

    const inert = logLines.filter((line) => line.includes(`${KEY}[`));
    expect(inert.map((line) => /\[(\d+)\]/.exec(line)![1])).toEqual(['0', '2', '3']);
    expect(inert.every((line) => line.includes('/home/me/.damocles/settings.json'))).toBe(true);
  });

  it('runs on the settings write chain, so a Tools-panel toggle racing it is not lost', async () => {
    const platform = installFakePlatform({ settings: { user: { [KEY]: ['mcp__s__get_a'] } } });
    // A store's write lands after an await, which is when a read-modify-write off the chain loses the other one.
    const write = platform.settings.update.bind(platform.settings);
    vi.spyOn(platform.settings, 'update').mockImplementation(async (...args) => {
      await new Promise((resolve) => setTimeout(resolve, 0));
      return write(...args);
    });
    const runtime = PiRuntime.get() as unknown as Internals;
    const toggle = serializeSettingWrite(async () => {
      const current = platform.settings.inspect<string[]>(KEY).userValue ?? [];
      await platform.settings.update(KEY, [...current, 'mcp__git__push'], 'user');
    });

    await Promise.all([runtime.rewriteDisabledToolLists(['user'], rename), toggle]);

    expect(platform.settings.inspect(KEY).userValue).toEqual(['mcp__s__read_mcp_resource(s://a)', 'mcp__git__push']);
  });

  it("names the project scope's list by its file, or by the setting where the host keeps no file", () => {
    installFakePlatform({ settings: { project: { [KEY]: ['mcp__s__get_a'] }, scopeFiles: { project: '/repo/.damocles/settings.json' } } });
    expect((PiRuntime.get() as unknown as Internals).projectDisabledToolList()).toEqual({ path: '/repo/.damocles/settings.json', names: ['mcp__s__get_a'] });
  });

  it('names the setting on a host whose project scope has no file, as VS Code workspace settings have none', async () => {
    installFakePlatform({ settings: { project: { [KEY]: ['mcp__s__get_a', 3] } } });
    expect((PiRuntime.get() as unknown as Internals).projectDisabledToolList()).toEqual({ setting: KEY, names: ['mcp__s__get_a'] });
  });
});
