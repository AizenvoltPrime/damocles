import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { SessionOptions } from '../../claude-session/types';
import type { ExtensionToWebviewMessage } from '../../../shared/types/messages';

const H = vi.hoisted(() => {
  const seq: string[] = [];
  const captured: { services: unknown[] } = { services: [] };
  let sessionCounter = 0;
  let lastSession: ReturnType<typeof makeSession> | null = null;

  function makeSession() {
    const id = `sess-${++sessionCounter}`;
    const session = {
      sessionId: id,
      subscribe: vi.fn((_listener: unknown) => {
        seq.push('subscribe');
        return () => seq.push('unsub');
      }),
      setAutoCompactionEnabled: vi.fn((enabled: boolean) => { if (!enabled) seq.push('compaction-off'); }),
      setActiveToolsByName: vi.fn(),
      bindExtensions: vi.fn(async () => undefined),
      setThinkingLevel: vi.fn(),
      prompt: vi.fn(async () => undefined),
      steer: vi.fn(async () => undefined),
      abort: vi.fn(async () => undefined),
      setModel: vi.fn(async () => undefined),
      getSessionStats: vi.fn(() => ({ sessionId: id, cost: 0, tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } })),
      getLastAssistantText: vi.fn(() => 'hi'),
      getContextUsage: vi.fn(() => undefined),
      messages: [],
    };
    lastSession = session;
    return session;
  }

  function makeServices() {
    return {
      cwd: '/cwd',
      agentDir: '/fake/agent',
      authStorage: { get: vi.fn(), has: vi.fn(() => false), hasAuth: vi.fn(() => false) },
      settingsManager: {},
      modelRegistry: {
        getAvailable: () => [{ id: 'claude-opus-4-8', name: 'Opus', api: 'anthropic-messages', provider: 'anthropic', contextWindow: 1_000_000 }],
        find: (provider: string, id: string) => (provider === 'anthropic' && id === 'claude-opus-4-8'
          ? { id, name: 'Opus', api: 'anthropic-messages', provider, contextWindow: 1_000_000 }
          : undefined),
        hasConfiguredAuth: () => true,
        getAll: () => [{ id: 'claude-opus-4-8', name: 'Opus', api: 'anthropic-messages', provider: 'anthropic', contextWindow: 1_000_000 }],
        refresh: vi.fn(),
      },
      resourceLoader: { reload: vi.fn(async () => undefined) },
      diagnostics: [],
    };
  }

  let services = makeServices();

  const fakePi = {
    createAgentSessionServices: vi.fn(async () => services),
    createAgentSessionFromServices: vi.fn(async (opts: { services: unknown }) => {
      captured.services.push(opts.services);
      return { session: makeSession() };
    }),
    createAgentSessionRuntime: vi.fn(async (factory: (o: { sessionManager: unknown; cwd: string; agentDir: string }) => Promise<{ session: unknown }>, opts: { cwd: string; agentDir: string; sessionManager: unknown }) => {
      let current = (await factory({ ...opts })).session;
      let before: (() => void) | undefined;
      let rebind: ((s: unknown) => Promise<void>) | undefined;
      let disposed = false;
      return {
        get session() { return current; },
        get services() { return services; },
        setBeforeSessionInvalidate: (cb?: () => void) => { before = cb; },
        setRebindSession: (cb?: (s: unknown) => Promise<void>) => { rebind = cb; },
        newSession: async () => {
          before?.();
          current = (await factory({ ...opts })).session;
          await rebind?.(current);
          return { cancelled: false };
        },
        dispose: async () => { disposed = true; },
        get disposed() { return disposed; },
      };
    }),
    SessionManager: { create: vi.fn(() => ({ kind: 'persistent' })), inMemory: vi.fn(() => ({ kind: 'memory' })) },
    DefaultPackageManager: class { getInstalledPath(): string | undefined { return undefined; } },
    defineTool: vi.fn((tool: unknown) => tool),
    createEditToolDefinition: vi.fn(() => ({ execute: vi.fn(async () => ({ content: [], details: undefined })) })),
  };

  return { seq, captured, fakePi, resetServices: () => { services = makeServices(); }, getServices: () => services, getLastSession: () => lastSession };
});

vi.mock('../pi-loader', () => ({
  initPiLoader: vi.fn(async () => H.fakePi),
  getPiCodingAgent: vi.fn(() => H.fakePi),
  PI_MIN_NODE_MAJOR: 22,
  nodeSupportsPi: () => true,
}));

vi.mock('../agent-dir', () => ({
  ensurePiAgentDir: (dir: string) => dir,
  PI_AGENT_DIR: '/fake/agent',
}));

import { PiSession } from '../pi-session';
import { PiRuntime } from '../pi-runtime';

function makeOptions(messages: ExtensionToWebviewMessage[]): SessionOptions {
  return {
    cwd: '/cwd',
    permissionHandler: { getPermissionMode: () => 'default' } as unknown as SessionOptions['permissionHandler'],
    onMessage: (m) => messages.push(m),
    model: 'claude-opus-4-8',
    resolveThinking: () => ({ thinkingDisabled: false, effort: null, maxThinkingTokens: null }),
  };
}

describe('PiSession lifecycle (US-P1-4)', () => {
  beforeEach(() => {
    H.seq.length = 0;
    H.captured.services.length = 0;
    H.resetServices();
  });
  afterEach(async () => {
    await PiRuntime.disposeInstance();
  });

  it('factory reuses PiRuntime.services (B1)', async () => {
    const session = new PiSession(makeOptions([]));
    await session.initializeEarly();
    expect(H.captured.services.length).toBeGreaterThanOrEqual(1);
    expect(H.captured.services[0]).toBe(PiRuntime.get('/cwd', '/fake/agent').services);
    expect(H.captured.services[0]).toBe(H.getServices());
  });

  it('session replacement re-subscribes once and re-disables compaction, old unsub first', async () => {
    const session = new PiSession(makeOptions([]));
    await session.initializeEarly();
    expect(H.seq).toEqual(['subscribe', 'compaction-off']);

    session.reset(); // -> runtime.newSession() exercises the replacement seam
    await new Promise((r) => setTimeout(r, 0));

    expect(H.seq.filter((s) => s === 'subscribe')).toHaveLength(2);
    expect(H.seq.filter((s) => s === 'compaction-off')).toHaveLength(2);
    const firstUnsub = H.seq.indexOf('unsub');
    const secondSubscribe = H.seq.indexOf('subscribe', H.seq.indexOf('subscribe') + 1);
    expect(firstUnsub).toBeGreaterThan(-1);
    expect(firstUnsub).toBeLessThan(secondSubscribe);
  });

  it('reloads the shared extension runtime on replacement, not the first session (stale-ctx fix)', async () => {
    const session = new PiSession(makeOptions([]));
    await session.initializeEarly();
    const reload = H.getServices().resourceLoader.reload as ReturnType<typeof vi.fn>;
    // First session binds the pristine init runtime — no reload, so startup stays cheap.
    expect(reload).not.toHaveBeenCalled();

    session.reset(); // replacement disposes the old session → its shared runtime is marked stale
    await new Promise((r) => setTimeout(r, 0));

    // The replacement must rebind to a FRESH runtime, else web_search/fetch_content throw "ctx is stale".
    expect(reload).toHaveBeenCalledTimes(1);
    await session.dispose();
  });

  it('plan mode restricts the active tool set; default restores it (US-017)', async () => {
    const session = new PiSession(makeOptions([]));
    await session.initializeEarly();
    const live = H.getLastSession();
    expect(live).not.toBeNull();
    const setActive = live!.setActiveToolsByName as ReturnType<typeof vi.fn>;

    setActive.mockClear();
    await session.setPermissionMode('plan');
    const planNames = setActive.mock.calls.at(-1)?.[0] as string[];
    expect(planNames).toContain('read');
    expect(planNames).toContain('ExitPlanMode');
    expect(planNames).not.toContain('Edit');
    expect(planNames).not.toContain('bash');

    await session.setPermissionMode('default');
    const fullNames = setActive.mock.calls.at(-1)?.[0] as string[];
    expect(fullNames).toContain('Edit');
    expect(fullNames).toContain('bash');
    await session.dispose();
  });

  it('clear() then sendMessage() prompts the fresh session, not the old one (plan clear-context)', async () => {
    const session = new PiSession(makeOptions([]));
    await session.initializeEarly();
    const first = H.getLastSession();
    expect(first).not.toBeNull();

    session.clear(); // fires newSession() async — the old session is mid-teardown
    await session.sendMessage('go', undefined, 'c1', { content: 'go' });

    const second = H.getLastSession();
    expect(second).not.toBe(first);
    expect((second!.prompt as ReturnType<typeof vi.fn>)).toHaveBeenCalled();
    expect((first!.prompt as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
    await session.dispose();
  });

  it('dispose tears down the runtime but leaves the PiRuntime singleton alive', async () => {
    const session = new PiSession(makeOptions([]));
    await session.initializeEarly();
    await session.dispose();
    expect(PiRuntime.exists).toBe(true);
    expect(session.currentSessionId).toBeNull();
  });

  it('no ChatSession method throws when called on a started session (FR-10)', async () => {
    const messages: ExtensionToWebviewMessage[] = [];
    const s = new PiSession(makeOptions(messages));
    await s.initializeEarly();

    // getters
    void s.currentSessionId; void s.persistenceSessionId; void s.memorySessionId;
    void s.teamService; void s.recallService; void s.processing; void s.currentPromptIndex;
    void s.conversationHead; void s.isRecallMode; void s.currentModel; void s.fastMode;
    void s.remoteControlStatus; void s.planPath;
    s.planPath = '/tmp/plan.md';

    // synchronous methods
    s.getModelInfo(); s.setResumeSession(null); s.queueInput('hi'); s.cancel(); s.reset(); s.clear();
    s.setModel('claude-opus-4-8'); s.setBetas([]); s.setFastMode(true); s.setMcpServers({});
    s.restartForMcpChanges(); s.setPlugins([]); s.restartForPluginChanges(); s.setProviderEnv(undefined);
    s.restartForProviderChange(); s.setBrowserService(); s.setChromeEnabled(true); s.restartForChromeChange();
    s.getLoopJobs(); s.getCheckpointForMessage('x'); s.seedCheckpoints([]); s.getAccumulatedCost();
    s.getRecallService(); s.getRecallTrajectory(0); s.refreshRecallConfig({} as never);
    s.disableThinkingForNextQuery(); s.restoreThinkingConfig(); s.cancelBtw('b');

    // async methods
    await Promise.all([
      s.setRecallSession('x'), s.setPermissionMode('default'), s.getSupportedModels(), s.getSupportedCommands(),
      s.getMcpServerStatus(), s.reconnectMcpServerLive('m'), s.reloadPlugins(), s.emitExploreHistory('sid'),
      s.enableRemoteControl(), s.disableRemoteControl(), s.cancelLoopJob('j'), s.getMemoryInjection(0),
      s.requestContextUsage(), s.cancelAutoCompact(), s.stopTask('t'), s.interrupt(),
      s.rewindFiles('u'), s.sendBtw('b', 'q'),
      s.sendMessage('hello', undefined, 'corr-1', { content: 'hello' }),
    ]);

    expect(messages.some((m) => m.type === 'rewindError')).toBe(true);
    expect(messages.some((m) => m.type === 'btwError')).toBe(true);
    await s.dispose();
  });
});
