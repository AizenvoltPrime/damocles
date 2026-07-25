import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as path from 'path';
import type { SessionOptions } from '../../session-types';
import type { ExtensionToWebviewMessage } from '../../../shared/types/messages';

const H = vi.hoisted(() => {
  const seq: string[] = [];
  const captured: { services: unknown[] } = { services: [] };
  let sessionCounter = 0;
  let lastSession: ReturnType<typeof makeSession> | null = null;

  function makeSession() {
    const id = `sess-${++sessionCounter}`;
    // Per-session tool registry the MCP-reload orphan check (`missingMcpRegistryNames`) reads via
    // getAllTools(). Tests mutate `registryToolNames` to simulate an orphaned vs current registry, and
    // a mocked reload() can repopulate it.
    const registryToolNames = new Set<string>(['read', 'bash', 'Edit', 'write']);
    const session = {
      sessionId: id,
      isStreaming: false,
      isCompacting: false,
      get isIdle() { return !this.isStreaming; },
      registryToolNames,
      subscribe: vi.fn((_listener: unknown) => {
        seq.push('subscribe');
        return () => seq.push('unsub');
      }),
      setAutoCompactionEnabled: vi.fn((enabled: boolean) => { if (!enabled) seq.push('compaction-off'); }),
      compact: vi.fn(async () => ({ summary: 'summary', firstKeptEntryId: 'k1', tokensBefore: 100 })),
      abortCompaction: vi.fn(),
      setActiveToolsByName: vi.fn(),
      getActiveToolNames: vi.fn(() => ['read', 'bash', 'Edit', 'write']),
      getAllTools: vi.fn(() => [...registryToolNames].map((name) => ({ name }))),
      reload: vi.fn(async () => { seq.push(`reload:${id}`); }),
      bindExtensions: vi.fn(async () => undefined),
      setThinkingLevel: vi.fn(),
      prompt: vi.fn(async () => undefined),
      steer: vi.fn(async () => undefined),
      followUp: vi.fn(async () => undefined),
      sendCustomMessage: vi.fn(async () => undefined),
      clearQueue: vi.fn(() => ({ steering: [], followUp: [] })),
      abort: vi.fn(async () => undefined),
      setModel: vi.fn(async () => undefined),
      getSessionStats: vi.fn(() => ({ sessionId: id, cost: 0, tokens: { input: 120, output: 40, cacheRead: 30, cacheWrite: 10, total: 200 } })),
      getLastAssistantText: vi.fn(() => 'hi'),
      getContextUsage: vi.fn(() => ({ tokens: 160, contextWindow: 1_000_000, percent: 0 })),
      get systemPrompt() { return 'You are a helpful coding assistant.'; },
      sessionManager: {
        getLeafId: vi.fn(() => 'leaf-1'),
        getBranch: vi.fn(() => [
          { type: 'message', id: 'u1', message: { role: 'user', content: 'hello world' } },
          {
            type: 'message',
            id: 'a1',
            message: {
              role: 'assistant',
              content: [
                { type: 'text', text: 'doing it' },
                { type: 'toolCall', id: 't1', name: 'read', arguments: { path: 'a.ts' } },
              ],
            },
          },
          { type: 'message', id: 'r1', message: { role: 'toolResult', toolCallId: 't1', content: 'file body' } },
        ]),
        getEntry: vi.fn((_id: string) => undefined as unknown),
        getSessionFile: vi.fn(() => undefined as string | undefined),
        appendCustomEntry: vi.fn((_customType: string, _data?: unknown) => 'custom-1'),
      },
      messages: [],
    };
    lastSession = session;
    return session;
  }

  function makeServices() {
    return {
      cwd: '/cwd',
      agentDir: '/fake/agent',
      settingsManager: {
        setCompactionEnabled: vi.fn((enabled: boolean) => { if (!enabled) seq.push('compaction-off'); }),
        applyOverrides: vi.fn(),
        getCompactionSettings: vi.fn(() => ({ enabled: false, reserveTokens: 16384, keepRecentTokens: 20000 })),
        getGlobalSettings: vi.fn(() => ({})),
        getProjectSettings: vi.fn(() => ({})),
        getPackages: vi.fn(() => []),
      },
      modelRuntime: {
        getAvailableSnapshot: () => [{ id: 'claude-opus-4-8', name: 'Opus', api: 'anthropic-messages', provider: 'anthropic', contextWindow: 1_000_000 }],
        getModel: (provider: string, id: string) => (provider === 'anthropic' && id === 'claude-opus-4-8'
          ? { id, name: 'Opus', api: 'anthropic-messages', provider, contextWindow: 1_000_000 }
          : undefined),
        hasConfiguredAuth: () => true,
        getModels: () => [{ id: 'claude-opus-4-8', name: 'Opus', api: 'anthropic-messages', provider: 'anthropic', contextWindow: 1_000_000 }],
        refresh: vi.fn(),
      },
      resourceLoader: {
        reload: vi.fn(async () => undefined),
        extendResources: vi.fn(),
        getExtensions: vi.fn(() => ({ extensions: [], errors: [], runtime: {} })),
        getPrompts: vi.fn(() => ({
          prompts: [
            { name: 'review', description: 'Review code', argumentHint: '[pr]', content: 'review prompt body', filePath: '/cwd/.claude/commands/review.md', sourceInfo: { path: '/cwd/.claude/commands/review.md', scope: 'project' } },
          ],
          diagnostics: [],
        })),
        getSkills: vi.fn(() => ({
          skills: [
            { name: 'simplify', description: 'Simplify code', filePath: '/home/.claude/skills/simplify/SKILL.md', baseDir: '/home/.claude/skills/simplify', sourceInfo: { path: '/home/.claude/skills/simplify', scope: 'user' }, disableModelInvocation: false },
          ],
          diagnostics: [],
        })),
        getAgentsFiles: vi.fn(() => ({ agentsFiles: [] })),
      },
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
    SettingsManager: { inMemory: vi.fn(() => ({ kind: 'settings' })) },
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

// `start()` calls ensurePiSessionDir, which does a real fs.mkdirSync under PI_AGENT_DIR. With the agent
// dir mocked to '/fake/agent', that mkdir lands at the filesystem root and throws EACCES on Linux CI —
// initializeEarly() swallows the throw, so the live session never starts and every lifecycle assertion
// fails. Stub the FS boundary (it succeeds on Windows but not Linux, which masked this locally).
vi.mock('../session-store/session-dir', () => ({
  piSessionDir: (cwd: string) => `/fake/agent/sessions/${cwd}`,
  ensurePiSessionDir: (cwd: string) => `/fake/agent/sessions/${cwd}`,
}));

import { PiSession } from '../pi-session';
import { PiRuntime } from '../pi-runtime';
import { computePlanFilePath } from '../../paths';
import * as fsSync from 'fs';

function makeOptions(messages: ExtensionToWebviewMessage[]): SessionOptions {
  return {
    cwd: '/cwd',
    permissionHandler: { getPermissionMode: () => 'default', setPermissionRequiredNotifier: () => {}, setPlanContentResolver: () => {} } as unknown as SessionOptions['permissionHandler'],
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

    // The replacement must rebind to a FRESH runtime, else extension-registered MCP tools throw "ctx is stale".
    expect(reload).toHaveBeenCalledTimes(1);
    await session.dispose();
  });

  it('plan mode restricts the active tool set; default restores it (US-017)', async () => {
    const opts = makeOptions([]);
    opts.memoryService = { isEnabled: true } as never; // memory tools enter `full` only when the service is enabled
    const session = new PiSession(opts);
    await session.initializeEarly();
    const live = H.getLastSession();
    expect(live).not.toBeNull();
    const setActive = live!.setActiveToolsByName as ReturnType<typeof vi.fn>;

    setActive.mockClear();
    await session.setPermissionMode('plan');
    const planNames = setActive.mock.calls.at(-1)?.[0] as string[];
    expect(planNames).toContain('read');
    expect(planNames).toContain('ExitPlanMode');
    // Edit/Write stay active so the model can maintain its plan file; the gate restricts them to the
    // plan file (US-002). Active-set names: custom 'Edit' + pi-native 'write'. Shell stays out.
    expect(planNames).toContain('Edit');
    expect(planNames).toContain('write');
    // bash stays ACTIVE (callable) in plan mode; the gate classifies each command and blocks any
    // non-read-only one. The active set makes the tool reachable — the classifier is the boundary.
    expect(planNames).toContain('bash');
    // Memory module tools stay active in plan mode — extension-internal SQLite writes, never the workspace.
    expect(planNames).toContain('SearchMemories');
    expect(planNames).toContain('SaveMemory');

    await session.setPermissionMode('default');
    const fullNames = setActive.mock.calls.at(-1)?.[0] as string[];
    expect(fullNames).toContain('Edit');
    expect(fullNames).toContain('bash');
    await session.dispose();
  });

  it('plan mode keeps every enabled MCP tool in the active set, read-only or not (US-014.4)', async () => {
    const session = new PiSession(makeOptions([]));
    await session.initializeEarly();
    // Seed the live full set with one read-only-ish and one non-read MCP name via the real runtime
    // singleton — `fullActiveToolNames()` reads `getMcpClientManager().allToolNames()` live each call.
    const runtime = PiRuntime.get('/cwd', '/fake/agent');
    vi.spyOn(runtime, 'getMcpClientManager').mockReturnValue({
      allToolNames: () => ['mcp__ctx7__query_docs', 'mcp__git__commit'],
    } as unknown as ReturnType<typeof runtime.getMcpClientManager>);

    const live = H.getLastSession()!;
    const setActive = live.setActiveToolsByName as ReturnType<typeof vi.fn>;
    setActive.mockClear();
    await session.setPermissionMode('plan');

    const planNames = setActive.mock.calls.at(-1)?.[0] as string[];
    expect(planNames).toContain('mcp__ctx7__query_docs');
    expect(planNames).toContain('mcp__git__commit');
    await session.dispose();
  });

  // --- MCP first-connect: reloadForMcpToolChange (frozen-allowlist fix) ------------------------------
  function seedMcpNames(names: string[]): void {
    const runtime = PiRuntime.get('/cwd', '/fake/agent');
    vi.spyOn(runtime, 'getMcpClientManager').mockReturnValue({
      allToolNames: () => names,
    } as unknown as ReturnType<typeof runtime.getMcpClientManager>);
  }

  it('MCP tools-changed: registry already current → re-applies active set, NO reload (single-panel fix)', async () => {
    const session = new PiSession(makeOptions([]));
    await session.initializeEarly();
    seedMcpNames(['mcp__ctx7__query_docs']);
    const live = H.getLastSession()!;
    // With the frozen allowlist dropped, the single-slot refreshTools already put the mcp tool in this
    // session's registry — simulate that so the orphan check passes.
    (live.registryToolNames as Set<string>).add('mcp__ctx7__query_docs');
    const reload = live.reload as ReturnType<typeof vi.fn>;
    const setActive = live.setActiveToolsByName as ReturnType<typeof vi.fn>;
    setActive.mockClear();

    session.reloadForMcpToolChange();

    expect(reload).not.toHaveBeenCalled();
    expect(setActive).toHaveBeenCalledTimes(1);
    expect(setActive.mock.calls.at(-1)?.[0] as string[]).toContain('mcp__ctx7__query_docs');
    await session.dispose();
  });

  it('MCP tools-changed: orphaned registry → reloads, then re-applies the active set with the mcp name', async () => {
    const session = new PiSession(makeOptions([]));
    await session.initializeEarly();
    seedMcpNames(['mcp__ctx7__query_docs']);
    const live = H.getLastSession()!;
    // Orphaned runtime: the mcp tool is requested but absent from this session's registry. reload()
    // repopulates it (the mock adds the name so the post-reload active-set apply includes it).
    const reload = live.reload as ReturnType<typeof vi.fn>;
    reload.mockImplementation(async () => { (live.registryToolNames as Set<string>).add('mcp__ctx7__query_docs'); });
    const setActive = live.setActiveToolsByName as ReturnType<typeof vi.fn>;
    setActive.mockClear();

    session.reloadForMcpToolChange();
    await new Promise((r) => setTimeout(r, 0));

    expect(reload).toHaveBeenCalledTimes(1);
    expect(setActive.mock.calls.at(-1)?.[0] as string[]).toContain('mcp__ctx7__query_docs');
    await session.dispose();
  });

  it('MCP tools-changed reloads EVERY orphaned panel, not just one (guards the root cause)', async () => {
    const a = new PiSession(makeOptions([]));
    const b = new PiSession(makeOptions([]));
    await a.initializeEarly();
    const liveA = H.getLastSession()!;
    await b.initializeEarly();
    const liveB = H.getLastSession()!;
    expect(liveA).not.toBe(liveB);
    seedMcpNames(['mcp__ctx7__query_docs']); // both registries lack it → both orphaned

    a.reloadForMcpToolChange();
    b.reloadForMcpToolChange();
    await new Promise((r) => setTimeout(r, 0));

    expect(liveA.reload as ReturnType<typeof vi.fn>).toHaveBeenCalledTimes(1);
    expect(liveB.reload as ReturnType<typeof vi.fn>).toHaveBeenCalledTimes(1);
    await a.dispose();
    await b.dispose();
  });

  it('MCP tools-changed mid-stream defers the reload until the next turn (no mid-stream rebuild)', async () => {
    const session = new PiSession(makeOptions([]));
    await session.initializeEarly();
    seedMcpNames(['mcp__ctx7__query_docs']);
    const live = H.getLastSession()!;
    (live as { isStreaming: boolean }).isStreaming = true;
    const reload = live.reload as ReturnType<typeof vi.fn>;
    reload.mockImplementation(async () => { (live.registryToolNames as Set<string>).add('mcp__ctx7__query_docs'); });

    session.reloadForMcpToolChange();
    await new Promise((r) => setTimeout(r, 0));
    // Streaming → reload deferred, not run mid-turn.
    expect(reload).not.toHaveBeenCalled();

    // The turn settles; the next sendMessage flushes the deferred reload before prompting.
    (live as { isStreaming: boolean }).isStreaming = false;
    await session.sendMessage('go', undefined, 'c1', { content: 'go' });
    expect(reload).toHaveBeenCalledTimes(1);
    await session.dispose();
  });

  it('MCP tools-changed during compaction defers the reload (isCompacting guard, M1)', async () => {
    const session = new PiSession(makeOptions([]));
    await session.initializeEarly();
    seedMcpNames(['mcp__ctx7__query_docs']);
    const live = H.getLastSession()!;
    // compact() aborts first, so isStreaming is FALSE while isCompacting is true — the streaming guard
    // alone would let the reload rebuild the runtime underneath the live compaction.
    (live as { isStreaming: boolean }).isStreaming = false;
    (live as { isCompacting: boolean }).isCompacting = true;
    const reload = live.reload as ReturnType<typeof vi.fn>;

    session.reloadForMcpToolChange();
    await new Promise((r) => setTimeout(r, 0));
    expect(reload).not.toHaveBeenCalled();

    // Compaction finishes; the next turn flushes the deferred reload.
    (live as { isCompacting: boolean }).isCompacting = false;
    reload.mockImplementation(async () => { (live.registryToolNames as Set<string>).add('mcp__ctx7__query_docs'); });
    await session.sendMessage('go', undefined, 'c1', { content: 'go' });
    expect(reload).toHaveBeenCalledTimes(1);
    await session.dispose();
  });

  it('a failing session.reload() is fail-soft: contained, panel stays usable (L2)', async () => {
    const session = new PiSession(makeOptions([]));
    await session.initializeEarly();
    seedMcpNames(['mcp__ctx7__query_docs']);
    const live = H.getLastSession()!;
    const reload = live.reload as ReturnType<typeof vi.fn>;
    reload.mockRejectedValue(new Error('reload boom'));

    // Idle + orphaned → runs the reload now; the rejection must be swallowed (not thrown to the caller).
    expect(() => session.reloadForMcpToolChange()).not.toThrow();
    await new Promise((r) => setTimeout(r, 0));
    // Single-flight: even if the MCP backend races a second tools-changed, it coalesces onto the
    // in-flight reload rather than stacking a second rebuild — so the failed reload fired exactly once.
    expect(reload).toHaveBeenCalledTimes(1);
    // The panel still serves a turn afterwards (the rejection didn't poison the session).
    await expect(session.sendMessage('go', undefined, 'c1', { content: 'go' })).resolves.toBeUndefined();
    expect(live.prompt as ReturnType<typeof vi.fn>).toHaveBeenCalled();
    await session.dispose();
  });

  it('a deferred reload is dropped when the session is reset before the next turn (no stale reload, L2)', async () => {
    const session = new PiSession(makeOptions([]));
    await session.initializeEarly();
    seedMcpNames(['mcp__ctx7__query_docs']);
    const first = H.getLastSession()!;
    (first as { isStreaming: boolean }).isStreaming = true;
    session.reloadForMcpToolChange(); // orphaned + streaming → deferred

    // A reset replaces the session; the fresh one reads the current tool set, so the deferral is moot.
    session.reset();
    await new Promise((r) => setTimeout(r, 0));
    const second = H.getLastSession()!;
    expect(second).not.toBe(first);
    // Give the fresh session the mcp tool (simulating its rebuilt registry) so no reload is warranted.
    (second.registryToolNames as Set<string>).add('mcp__ctx7__query_docs');
    const reloadSecond = second.reload as ReturnType<typeof vi.fn>;

    await session.sendMessage('go', undefined, 'c1', { content: 'go' });
    // reset() cleared the stale deferral, so the next turn does NOT reload the fresh session.
    expect(reloadSecond).not.toHaveBeenCalled();
    await session.dispose();
  });

  it('an MCP reload requested mid-reset serializes behind newSession, then runs on the fresh session (L2)', async () => {
    const session = new PiSession(makeOptions([]));
    await session.initializeEarly();
    seedMcpNames(['mcp__ctx7__query_docs']);
    H.seq.length = 0;

    // Make newSession observably slow so a reload requested during it must wait for it to finish. The
    // wrapper records ordering into the shared seq alongside each session's own `reload:<id>` marker.
    const runtime = (session as unknown as { runtime: { newSession: () => Promise<unknown> } }).runtime;
    const realNewSession = runtime.newSession.bind(runtime);
    runtime.newSession = async () => {
      H.seq.push('newSession:start');
      await new Promise((r) => setTimeout(r, 5));
      const res = await realNewSession();
      H.seq.push('newSession:end');
      return res;
    };

    session.reset(); // begins the slow newSession()
    // Request a reload while the reset is in flight. runMcpReload awaits the in-flight reset, then
    // re-reads the now-current (fresh) session and reloads IT — never concurrently with newSession.
    void session.reloadForMcpToolChange();

    await new Promise((r) => setTimeout(r, 30));
    const reloadIdx = H.seq.findIndex((s) => s.startsWith('reload:'));
    const endIdx = H.seq.indexOf('newSession:end');
    expect(endIdx).toBeGreaterThan(-1);
    // The reload ran strictly after newSession completed (serialized, not concurrent).
    expect(reloadIdx).toBeGreaterThan(endIdx);
    await session.dispose();
  });

  it('a burst of MCP tools-changed events coalesces into a single reload (single-flight, L2)', async () => {
    const session = new PiSession(makeOptions([]));
    await session.initializeEarly();
    seedMcpNames(['mcp__ctx7__query_docs']);
    const live = H.getLastSession()!;
    let resolveReload!: () => void;
    const reload = live.reload as ReturnType<typeof vi.fn>;
    // Hold the first reload open so the burst's later events arrive while it is still in flight.
    reload.mockImplementation(() => new Promise<void>((res) => { resolveReload = () => { (live.registryToolNames as Set<string>).add('mcp__ctx7__query_docs'); res(); }; }));

    // Three tools-changed in the same tick (orphaned, idle): the first starts the reload, the next two
    // must coalesce onto it rather than stack three rebuilds.
    session.reloadForMcpToolChange();
    session.reloadForMcpToolChange();
    session.reloadForMcpToolChange();
    await new Promise((r) => setTimeout(r, 0));
    expect(reload).toHaveBeenCalledTimes(1);

    // When the in-flight reload settles it has made the registry current, so the coalesced re-run sees
    // nothing missing and does NOT reload again.
    resolveReload();
    await new Promise((r) => setTimeout(r, 0));
    expect(reload).toHaveBeenCalledTimes(1);
    await session.dispose();
  });

  it('getPlanFilePath slugs the committed first user message from the branch (FR-4)', async () => {
    const session = new PiSession(makeOptions([]));
    await session.initializeEarly();
    // The mock branch's first user message is 'hello world'.
    expect(path.basename(session.getPlanFilePath())).toMatch(/^hello-world-/);
    await session.dispose();
  });

  it('getPlanFilePath falls back to the first sent message before it is committed to the branch (FR-4)', async () => {
    const session = new PiSession(makeOptions([]));
    await session.initializeEarly();
    const live = H.getLastSession()!;
    // Simulate the first-turn before_agent_start window: the prompt isn't in the branch yet.
    (live.sessionManager.getBranch as ReturnType<typeof vi.fn>).mockReturnValue([]);
    expect(path.basename(session.getPlanFilePath())).toMatch(/^plan-/);

    // Internal + synthetic <…> messages are ignored; the first real prompt sets the slug from the cache.
    await session.sendMessage('<ctx> internal', undefined, undefined, undefined, { isInternal: true });
    await session.sendMessage('<reminder> synthetic');
    expect(path.basename(session.getPlanFilePath())).toMatch(/^plan-/);
    await session.sendMessage('Create a hello world file at root');
    expect(path.basename(session.getPlanFilePath())).toMatch(/^create-a-hello-world-file-at-root-/);
    await session.dispose();
  });

  it('getPlanContent returns null when no plan file exists for the session', async () => {
    const session = new PiSession(makeOptions([]));
    await session.initializeEarly();
    const planPath = session.getPlanFilePath();
    fsSync.rmSync(planPath, { force: true });
    expect(await session.getPlanContent()).toBeNull();
    await session.dispose();
  });

  it('getPlanContent returns the on-disk plan file content (located by the stable suffix)', async () => {
    const session = new PiSession(makeOptions([]));
    await session.initializeEarly();
    const sessionId = session.currentSessionId!;
    const planPath = computePlanFilePath(sessionId, 'hello world');
    fsSync.mkdirSync(path.dirname(planPath), { recursive: true });
    fsSync.writeFileSync(planPath, '# Plan: the real one', 'utf-8');
    try {
      expect(await session.getPlanContent()).toBe('# Plan: the real one');
    } finally {
      fsSync.rmSync(planPath, { force: true });
      await session.dispose();
    }
  });

  it('getPlanContent propagates a read error for a located-but-unreadable plan (does NOT mask as null)', async () => {
    const session = new PiSession(makeOptions([]));
    await session.initializeEarly();
    const sessionId = session.currentSessionId!;
    // A path that findSessionPlanFiles locates (right `-<id8>.md` suffix) but readFile cannot read as a
    // file — here a directory, which throws EISDIR. A present-but-unreadable plan must surface, not
    // silently degrade into the "no plan, re-run it" path.
    const planPath = computePlanFilePath(sessionId, 'hello world');
    fsSync.mkdirSync(planPath, { recursive: true });
    try {
      await expect(session.getPlanContent()).rejects.toThrow();
    } finally {
      fsSync.rmSync(planPath, { recursive: true, force: true });
      await session.dispose();
    }
  });

  it('getToolStatus reports group masters + per-tool enabled (layered)', () => {
    const opts = makeOptions([]);
    opts.memoryService = { isEnabled: true } as never;
    opts.compassService = { isEnabled: false } as never;
    opts.browserService = {} as never;
    const session = new PiSession(opts);
    const snap = session.getToolStatus();
    const group = (g: string) => snap.groups.find((x) => x.group === g);

    expect(group('memory')?.enabled).toBe(true);
    expect(group('memory')?.available).toBe(true);
    expect(group('compass')?.enabled).toBe(false);
    expect(group('compass')?.available).toBe(true);
    expect(group('core')?.enabled).toBe(true);

    const mem = snap.tools.find((t) => t.group === 'memory')!;
    expect(mem.toggleable).toBe(true);
    expect(mem.enabled).toBe(true); // group master on, not per-tool-disabled

    const compass = snap.tools.find((t) => t.group === 'compass')!;
    expect(compass.enabled).toBe(false); // group master off → all its tools off

    const core = snap.tools.find((t) => t.group === 'core')!;
    expect(core.toggleable).toBe(false);
    expect(core.enabled).toBe(true); // core is always on
  });

  it('refreshActiveTools re-applies the active set live for the current mode', async () => {
    const session = new PiSession(makeOptions([]));
    await session.initializeEarly();
    const live = H.getLastSession();
    const setActive = live!.setActiveToolsByName as ReturnType<typeof vi.fn>;
    setActive.mockClear();
    session.refreshActiveTools();
    expect(setActive).toHaveBeenCalledTimes(1);
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

  it('queueInput holds messages and steers them as ONE combined prompt while streaming', async () => {
    const session = new PiSession(makeOptions([]));
    await session.initializeEarly();
    const live = H.getLastSession()!;
    (live as { isStreaming: boolean }).isStreaming = true;
    const prompt = live.prompt as ReturnType<typeof vi.fn>;

    expect(session.queueInput('first', 'q1')).toBe('queued');
    expect(session.queueInput('second', 'q2')).toBe('queued');

    // Each queue re-steers the FULL combined buffer (clearing the prior steer).
    expect((live.clearQueue as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(2);
    const last = prompt.mock.calls.at(-1);
    expect(last?.[0]).toBe('first\n\nsecond');
    expect(last?.[1]).toMatchObject({ streamingBehavior: 'steer' });
    await session.dispose();
  });

  it('collapses queued chips into the combined message when pi delivers the steer', async () => {
    const messages: ExtensionToWebviewMessage[] = [];
    const session = new PiSession(makeOptions(messages));
    await session.initializeEarly();
    const live = H.getLastSession()!;
    (live as { isStreaming: boolean }).isStreaming = true;
    session.queueInput('a', 'q1');
    session.queueInput('b', 'q2');

    session.onQueuedInputsDelivered(); // adapter calls this on the user message_end delivery

    const batch = messages.find((m) => m.type === 'queueBatchProcessed');
    expect(batch).toMatchObject({ messageIds: ['q1', 'q2'], combinedContent: 'a\n\nb' });
    // Buffer cleared — a second delivery emits nothing.
    messages.length = 0;
    session.onQueuedInputsDelivered();
    expect(messages.some((m) => m.type === 'queueBatchProcessed')).toBe(false);
    await session.dispose();
  });

  it('reports a delivered batch is owed a mid-stream marker, then writes it keyed to the committed entry', async () => {
    const session = new PiSession(makeOptions([]));
    await session.initializeEarly();
    const live = H.getLastSession()!;
    (live as { isStreaming: boolean }).isStreaming = true;
    const append = live.sessionManager.appendCustomEntry as ReturnType<typeof vi.fn>;
    session.queueInput('a', 'q1');
    session.queueInput('b', 'q2');

    // Delivery (user message_end) flushes the buffer but does NOT write yet — pi hasn't committed the
    // steered entry to the tree at this point, so keying it here would mis-key to the prior turn.
    expect(session.onQueuedInputsDelivered()).toBe(true);
    expect(append.mock.calls.some((c) => c[0] === 'damocles-mid-stream')).toBe(false);

    // The adapter resolves the committed entry id at the next assistant message_start and calls back.
    session.recordMidStreamMarker('u-combined');
    const calls = append.mock.calls.filter((c) => c[0] === 'damocles-mid-stream');
    expect(calls).toHaveLength(1);
    expect(calls[0]![1]).toEqual({ userEntryId: 'u-combined' });
    await session.dispose();
  });

  it('onQueuedInputsDelivered returns false (no marker owed) when no batch was queued', async () => {
    const session = new PiSession(makeOptions([]));
    await session.initializeEarly();
    const live = H.getLastSession()!;
    const append = live.sessionManager.appendCustomEntry as ReturnType<typeof vi.fn>;

    expect(session.onQueuedInputsDelivered()).toBe(false);
    expect(append.mock.calls.some((c) => c[0] === 'damocles-mid-stream')).toBe(false);
    await session.dispose();
  });

  it('queueInput refuses (returns false) when the session is not streaming', async () => {
    const session = new PiSession(makeOptions([]));
    await session.initializeEarly();
    const live = H.getLastSession()!;
    (live as { isStreaming: boolean }).isStreaming = false;
    expect(session.queueInput('nope')).toBe(false);
    expect((live.prompt as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
    await session.dispose();
  });

  it('cancel() drops queued-but-undelivered messages and removes their chips', async () => {
    const messages: ExtensionToWebviewMessage[] = [];
    const session = new PiSession(makeOptions(messages));
    await session.initializeEarly();
    const live = H.getLastSession()!;
    (live as { isStreaming: boolean }).isStreaming = true;
    session.queueInput('pending', 'q1');
    messages.length = 0;

    session.cancel();
    expect(messages.some((m) => m.type === 'queueCancelled' && m.messageId === 'q1')).toBe(true);
    // The dropped message is not re-delivered.
    session.onQueuedInputsDelivered();
    expect(messages.some((m) => m.type === 'queueBatchProcessed')).toBe(false);
    await session.dispose();
  });

  it('sendMessage after cancel() waits for the abort to settle before prompting', async () => {
    const session = new PiSession(makeOptions([]));
    await session.initializeEarly();
    const live = H.getLastSession()!;
    let abortResolved = false;
    (live.abort as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 5));
      abortResolved = true;
    });

    session.cancel(); // fires abort async; pi is mid-teardown
    await session.sendMessage('again', undefined, 'c2', { content: 'again' });

    // The new turn must not start until the in-flight abort fully wound down.
    expect(abortResolved).toBe(true);
    expect((live.prompt as ReturnType<typeof vi.fn>)).toHaveBeenCalled();
    await session.dispose();
  });

  it('sendMessage routes via follow-up when pi is unexpectedly still streaming (no crash)', async () => {
    const session = new PiSession(makeOptions([]));
    await session.initializeEarly();
    const live = H.getLastSession()!;
    (live as { isStreaming: boolean }).isStreaming = true;

    await session.sendMessage('hi', undefined, 'c3', { content: 'hi' });
    const promptCall = (live.prompt as ReturnType<typeof vi.fn>).mock.calls.at(-1);
    expect(promptCall?.[1]).toMatchObject({ streamingBehavior: 'followUp' });
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
    void s.teamService; void s.processing; void s.currentPromptIndex;
    void s.conversationHead; void s.currentModel;

    // synchronous methods
    s.getPlanFilePath();
    s.getModelInfo(); s.setResumeSession(null); s.queueInput('hi'); s.cancel(); s.reset(); s.clear();
    s.setModel('claude-opus-4-8'); s.setMcpServers({});
    s.restartForMcpChanges(); s.setMcpStatusListener(() => {}); s.refreshActiveTools(); s.getToolStatus();
    s.seedCheckpoints([]); s.getAccumulatedCost();
    s.disableThinkingForNextQuery(); s.restoreThinkingConfig(); s.cancelBtw('b');

    // async methods
    await Promise.all([
      s.setPermissionMode('default'), s.getSupportedModels(), s.getSupportedCommands(),
      s.getMcpServerStatus(), s.reconnectMcpServerLive('m'),
      s.getMemoryInjection(0),
      s.requestContextUsage(), s.cancelAutoCompact(), s.stopTask('t'), s.interrupt(),
      s.rewindFiles('u'), s.sendBtw('b', 'q'),
      s.sendMessage('hello', undefined, 'corr-1', { content: 'hello' }),
    ]);

    expect(messages.some((m) => m.type === 'rewindError')).toBe(true);
    // btw now runs as a real ephemeral aside (US-025) — it answers rather than emitting the old
    // "not available" error.
    expect(messages.some((m) => m.type === 'btwComplete')).toBe(true);
    await s.dispose();
  });

  it('getSupportedCommands surfaces prompt templates and skills (US-015/016)', async () => {
    const session = new PiSession(makeOptions([]));
    await session.initializeEarly();

    const commands = await session.getSupportedCommands();
    const names = commands.map((c) => c.name);
    expect(names).toContain('review');
    expect(names).toContain('skill:simplify');

    const review = commands.find((c) => c.name === 'review');
    expect(review?.description).toBe('Review code');
    expect(review?.argumentHint).toBe('[pr]');
    await session.dispose();
  });

  it('requestContextUsage emits a populated ContextUsageData with clickable file paths (US-CMD)', async () => {
    const messages: ExtensionToWebviewMessage[] = [];
    const session = new PiSession(makeOptions(messages));
    await session.initializeEarly();

    await session.requestContextUsage();
    const msg = messages.find((m) => m.type === 'contextUsage');
    expect(msg).toBeDefined();
    const data = (msg as { data: import('../../../shared/types/session').ContextUsageData | null }).data;
    expect(data).not.toBeNull();
    expect(data!.totalTokens).toBe(160);
    expect(data!.maxTokens).toBe(1_000_000);
    expect(data!.messageBreakdown).toBeDefined();
    expect(data!.messageBreakdown!.userMessageTokens).toBeGreaterThan(0);
    expect(data!.messageBreakdown!.toolCallsByType.some((t) => t.name === 'read')).toBe(true);
    expect(data!.systemPromptSections?.length).toBeGreaterThan(0);
    expect(data!.skills?.skillFrontmatter[0]?.filePath).toBe('/home/.claude/skills/simplify/SKILL.md');
    expect(data!.slashCommands?.commands?.some((c) => c.filePath === '/cwd/.claude/commands/review.md')).toBe(true);
    await session.dispose();
  });

  it('getSystemPromptText shows the Damocles prompt with NO turn run (regression: pi boilerplate)', async () => {
    const session = new PiSession(makeOptions([]));
    await session.initializeEarly();
    // No prompt() turn has run, so pi's mutable agent.state.systemPrompt would hold pi's boilerplate.
    const prompt = await session.getSystemPromptText();
    expect(prompt).toBeDefined();
    expect(prompt).toContain('AI coding agent');
    expect(prompt).not.toContain('operating inside pi');
    await session.dispose();
  });

  it('/context system-prompt token count is non-zero with NO turn run (US-021)', async () => {
    const messages: ExtensionToWebviewMessage[] = [];
    const session = new PiSession(makeOptions(messages));
    await session.initializeEarly();

    await session.requestContextUsage();
    const msg = messages.find((m) => m.type === 'contextUsage');
    const data = (msg as { data: import('../../../shared/types/session').ContextUsageData | null }).data;
    expect(data).not.toBeNull();
    expect(data!.systemPromptSections?.length).toBeGreaterThan(0);
    expect(data!.systemPromptSections![0]!.tokens).toBeGreaterThan(0);
    expect(data!.systemPromptSections![0]!.name).toBe('Damocles system prompt');
    await session.dispose();
  });

  it('records an original-input sidecar when pi expanded a slash command (typed != stored)', async () => {
    const session = new PiSession(makeOptions([]));
    await session.initializeEarly();
    const live = H.getLastSession()!;
    const append = live.sessionManager.appendCustomEntry as ReturnType<typeof vi.fn>;
    const getBranch = live.sessionManager.getBranch as ReturnType<typeof vi.fn>;
    // Before the turn the branch holds a prior user entry; prompt() commits a NEW user entry holding
    // the EXPANDED body of the slash command.
    getBranch.mockReturnValue([{ type: 'message', id: 'u-prior', message: { role: 'user', content: [{ type: 'text', text: 'prior' }] } }]);
    (live.prompt as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      getBranch.mockReturnValue([
        { type: 'message', id: 'u-prior', message: { role: 'user', content: [{ type: 'text', text: 'prior' }] } },
        { type: 'message', id: 'u-new', message: { role: 'user', content: [{ type: 'text', text: 'Hello day is Tuesday' }] } },
      ]);
    });

    await session.sendMessage('Hello day is Tuesday', undefined, 'c1', { content: '/example what is the day' });

    const call = append.mock.calls.find((c) => c[0] === 'damocles-original-input');
    expect(call).toBeDefined();
    expect(call![1]).toEqual({ userEntryId: 'u-new', original: '/example what is the day' });
    await session.dispose();
  });

  it('does NOT record a sidecar for a plain message (typed == stored)', async () => {
    const session = new PiSession(makeOptions([]));
    await session.initializeEarly();
    const live = H.getLastSession()!;
    const append = live.sessionManager.appendCustomEntry as ReturnType<typeof vi.fn>;
    const getBranch = live.sessionManager.getBranch as ReturnType<typeof vi.fn>;
    getBranch.mockReturnValue([]);
    (live.prompt as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      getBranch.mockReturnValue([
        { type: 'message', id: 'u-new', message: { role: 'user', content: [{ type: 'text', text: 'just a normal message' }] } },
      ]);
    });

    await session.sendMessage('just a normal message', undefined, 'c1', { content: 'just a normal message' });

    expect(append.mock.calls.some((c) => c[0] === 'damocles-original-input')).toBe(false);
    await session.dispose();
  });

  it('does NOT record a sidecar when no new user entry was committed (pi extension command)', async () => {
    const session = new PiSession(makeOptions([]));
    await session.initializeEarly();
    const live = H.getLastSession()!;
    const append = live.sessionManager.appendCustomEntry as ReturnType<typeof vi.fn>;
    // The branch's last user entry id is unchanged across the turn (a /todos-style command commits none).
    (live.sessionManager.getBranch as ReturnType<typeof vi.fn>).mockReturnValue([
      { type: 'message', id: 'u-stable', message: { role: 'user', content: [{ type: 'text', text: 'prior turn' }] } },
    ]);
    (live.prompt as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);

    await session.sendMessage('expanded body', undefined, 'c1', { content: '/todos' });

    expect(append.mock.calls.some((c) => c[0] === 'damocles-original-input')).toBe(false);
    await session.dispose();
  });

  it('does NOT record a sidecar for a plain message stored with an IDE-context prefix (asymmetric strip)', async () => {
    const session = new PiSession(makeOptions([]));
    await session.initializeEarly();
    const live = H.getLastSession()!;
    const append = live.sessionManager.appendCustomEntry as ReturnType<typeof vi.fn>;
    const getBranch = live.sessionManager.getBranch as ReturnType<typeof vi.fn>;
    getBranch.mockReturnValue([]);
    // pi merges the IDE-context block into the stored user message; the typed text carries no prefix.
    // Stripping the stored side before comparing must collapse them to equal → no sidecar.
    (live.prompt as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      getBranch.mockReturnValue([
        {
          type: 'message',
          id: 'u-new',
          message: {
            role: 'user',
            content: [{ type: 'text', text: '<ide_opened_file>The user opened the file c:\\x.ts in the IDE. This may or may not be related to the current task.</ide_opened_file>\nwhat day is it' }],
          },
        },
      ]);
    });

    await session.sendMessage('augmented-by-ide-context', undefined, 'c1', { content: 'what day is it' });

    expect(append.mock.calls.some((c) => c[0] === 'damocles-original-input')).toBe(false);
    await session.dispose();
  });

  // --- memory candidate enqueue (consolidation wiring) ---------------------------------------------
  function memorySpy() {
    return {
      isEnabled: true,
      ensureInitialized: vi.fn(async () => {}),
      enqueueTurnCandidate: vi.fn(),
      getPersistedMemoryInjection: vi.fn(),
    };
  }
  /** Force the adapter's observedAgentRun gate true (real LLM turn) — the no-op harness prompt fires
   *  no events, so the gate stays false by default. */
  function forceAgentRun(session: PiSession): void {
    (session as unknown as { adapter: { observedAgentRun: () => boolean } }).adapter.observedAgentRun = () => true;
  }

  it('session-start modelUpdate carries the workspace default from getDefaultModel, distinct from the active model', async () => {
    // defaultModel must come from getDefaultModel(), not the active panel model. Use a distinct sentinel
    // default so the assertion holds even though resolveInitialModel keeps activeModel on the authed model.
    const messages: ExtensionToWebviewMessage[] = [];
    const opts = makeOptions(messages);
    opts.getDefaultModel = () => 'workspace-default-model';
    const session = new PiSession(opts);
    await session.initializeEarly();
    forceAgentRun(session);

    await session.sendMessage('hi', undefined, 'corr', { content: 'hi' });

    const modelUpdate = messages.find((m) => m.type === 'modelUpdate');
    expect(modelUpdate).toMatchObject({ type: 'modelUpdate', defaultModel: 'workspace-default-model' });
    expect((modelUpdate as { activeModel: string }).activeModel).not.toBe('workspace-default-model');
    await session.dispose();
  });

  it('enqueues one memory candidate per real turn with the right shape', async () => {
    const opts = makeOptions([]);
    const memory = memorySpy();
    opts.memoryService = memory as never;
    const session = new PiSession(opts);
    await session.initializeEarly();
    forceAgentRun(session);
    const live = H.getLastSession()!;
    const getBranch = live.sessionManager.getBranch as ReturnType<typeof vi.fn>;
    // Pre-prompt boundary ends at u1; prompt() commits a new user (u2) + assistant (a2).
    getBranch.mockReturnValue([{ type: 'message', id: 'u1', message: { role: 'user', content: 'old' } }]);
    (live.prompt as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      getBranch.mockReturnValue([
        { type: 'message', id: 'u1', message: { role: 'user', content: 'old' } },
        { type: 'message', id: 'u2', message: { role: 'user', content: 'hi' } },
        { type: 'message', id: 'a2', message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] } },
      ]);
    });

    await session.sendMessage('hi', undefined, 'corr', { content: 'hi' });

    expect(memory.enqueueTurnCandidate).toHaveBeenCalledTimes(1);
    expect(memory.enqueueTurnCandidate).toHaveBeenCalledWith({
      sessionId: session.memorySessionId,
      promptIndex: 0,
      userText: 'hi',
      assistantText: 'done',
      files: [],
    });
    await session.dispose();
  });

  it('does NOT enqueue a memory candidate for an internal send', async () => {
    const opts = makeOptions([]);
    const memory = memorySpy();
    opts.memoryService = memory as never;
    const session = new PiSession(opts);
    await session.initializeEarly();
    forceAgentRun(session);

    await session.sendMessage('<ctx> internal', undefined, 'corr', { content: '<ctx> internal' }, { isInternal: true });

    expect(memory.enqueueTurnCandidate).not.toHaveBeenCalled();
    await session.dispose();
  });

  it('does NOT enqueue a memory candidate when the turn ran no LLM agent (extension command)', async () => {
    const opts = makeOptions([]);
    const memory = memorySpy();
    opts.memoryService = memory as never;
    const session = new PiSession(opts);
    await session.initializeEarly();
    // Leave observedAgentRun false (harness default) — a fresh user entry on the branch still must not enqueue.
    const live = H.getLastSession()!;
    (live.sessionManager.getBranch as ReturnType<typeof vi.fn>).mockReturnValue([
      { type: 'message', id: 'u2', message: { role: 'user', content: 'hi' } },
    ]);

    await session.sendMessage('hi', undefined, 'corr', { content: 'hi' });

    expect(memory.enqueueTurnCandidate).not.toHaveBeenCalled();
    await session.dispose();
  });

  it('does NOT enqueue a memory candidate when no new user entry was committed', async () => {
    const opts = makeOptions([]);
    const memory = memorySpy();
    opts.memoryService = memory as never;
    const session = new PiSession(opts);
    await session.initializeEarly();
    forceAgentRun(session);
    const live = H.getLastSession()!;
    // The branch's last user id equals priorUserEntryId across the turn → turnExchangeAfter returns null.
    (live.sessionManager.getBranch as ReturnType<typeof vi.fn>).mockReturnValue([
      { type: 'message', id: 'u-stable', message: { role: 'user', content: 'prior turn' } },
    ]);

    await session.sendMessage('hi', undefined, 'corr', { content: 'hi' });

    expect(memory.enqueueTurnCandidate).not.toHaveBeenCalled();
    await session.dispose();
  });

  it('joins multiple post-boundary user entries (steered turn) into one candidate', async () => {
    const opts = makeOptions([]);
    const memory = memorySpy();
    opts.memoryService = memory as never;
    const session = new PiSession(opts);
    await session.initializeEarly();
    forceAgentRun(session);
    const live = H.getLastSession()!;
    const getBranch = live.sessionManager.getBranch as ReturnType<typeof vi.fn>;
    getBranch.mockReturnValue([{ type: 'message', id: 'u1', message: { role: 'user', content: 'old' } }]);
    (live.prompt as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      getBranch.mockReturnValue([
        { type: 'message', id: 'u1', message: { role: 'user', content: 'old' } },
        { type: 'message', id: 'u2', message: { role: 'user', content: 'first' } },
        { type: 'message', id: 'u3', message: { role: 'user', content: 'second' } },
        { type: 'message', id: 'a2', message: { role: 'assistant', content: [{ type: 'text', text: 'reply' }] } },
      ]);
    });

    await session.sendMessage('first', undefined, 'corr', { content: 'first' });

    expect(memory.enqueueTurnCandidate).toHaveBeenCalledTimes(1);
    expect(memory.enqueueTurnCandidate).toHaveBeenCalledWith(
      expect.objectContaining({ userText: 'first\n\nsecond', assistantText: 'reply' }),
    );
    await session.dispose();
  });

  it('requestContextUsage reports busy while a turn is processing (US-CMD)', async () => {
    const messages: ExtensionToWebviewMessage[] = [];
    const session = new PiSession(makeOptions(messages));
    await session.initializeEarly();
    const live = H.getLastSession()!;
    let resolvePrompt: () => void = () => {};
    (live.prompt as ReturnType<typeof vi.fn>).mockImplementation(() => new Promise<void>((r) => { resolvePrompt = () => r(); }));

    const turn = session.sendMessage('go', undefined, 'c1', { content: 'go' });
    while (!session.processing) await new Promise((r) => setTimeout(r, 0));
    await session.requestContextUsage();
    const busy = messages.find((m) => m.type === 'contextUsage' && m.reason === 'busy');
    expect(busy).toBeDefined();

    resolvePrompt();
    await turn;
    await session.dispose();
  });

  it('clear() emits sessionCleared on the fresh session and resets the turn (/clear)', async () => {
    const messages: ExtensionToWebviewMessage[] = [];
    const session = new PiSession(makeOptions(messages));
    await session.initializeEarly();
    const first = H.getLastSession();

    session.clear();
    await session.whenReplaced();

    expect(H.getLastSession()).not.toBe(first);
    expect(session.processing).toBe(false);
    await session.dispose();
  });

  it('compact() surfaces a "nothing to compact" refusal as a friendly info notice, not an error', async () => {
    const messages: ExtensionToWebviewMessage[] = [];
    const session = new PiSession(makeOptions(messages));
    await session.initializeEarly();
    const live = H.getLastSession()!;
    (live.compact as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('Nothing to compact (session too small)'));

    await session.compact();

    expect(messages.some((m) => m.type === 'error')).toBe(false);
    const notice = messages.find((m): m is Extract<ExtensionToWebviewMessage, { type: 'notification' }> => m.type === 'notification');
    expect(notice?.notificationType).toBe('info');
    expect(notice?.message).toContain('Nothing to compact');
    await session.dispose();
  });

  it('compact() still surfaces a genuine compaction failure as a red error', async () => {
    const messages: ExtensionToWebviewMessage[] = [];
    const session = new PiSession(makeOptions(messages));
    await session.initializeEarly();
    const live = H.getLastSession()!;
    (live.compact as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('Compaction failed: Request failed: 500'));

    await session.compact();

    expect(messages.some((m) => m.type === 'error')).toBe(true);
    expect(messages.some((m) => m.type === 'notification' && m.notificationType === 'info')).toBe(false);
    await session.dispose();
  });

  it('rewindFiles(compactionId, fork-conversation) branches at the compaction parent with no prompt (US-002)', async () => {
    const messages: ExtensionToWebviewMessage[] = [];
    const onSpawnFork = vi.fn(async () => undefined);
    const session = new PiSession({ ...makeOptions(messages), onSpawnFork });
    await session.initializeEarly();
    const live = H.getLastSession()!;
    // The compaction entry is an ordinary tree node; its parent is the last pre-compaction message.
    (live.sessionManager.getEntry as ReturnType<typeof vi.fn>).mockImplementation((id: string) =>
      id === 'comp1' ? { id: 'comp1', parentId: 'a1', type: 'compaction' } : undefined,
    );

    await session.rewindFiles('comp1', 'fork-conversation');

    expect(messages.some((m) => m.type === 'rewindError')).toBe(false);
    expect(onSpawnFork).toHaveBeenCalledTimes(1);
    const args = onSpawnFork.mock.calls[0]![0] as { forkAtUuid: string | null; promptContent?: string };
    expect(args.forkAtUuid).toBe('a1');
    expect(args.promptContent).toBeUndefined();
    await session.dispose();
  });

  it('rewindFiles fails soft when the anchor cannot be resolved (US-002 FR-7)', async () => {
    const messages: ExtensionToWebviewMessage[] = [];
    const onSpawnFork = vi.fn(async () => undefined);
    const session = new PiSession({ ...makeOptions(messages), onSpawnFork });
    await session.initializeEarly();
    const live = H.getLastSession()!;
    (live.sessionManager.getEntry as ReturnType<typeof vi.fn>).mockReturnValue(undefined);

    await session.rewindFiles('does-not-exist', 'fork-conversation');

    expect(onSpawnFork).not.toHaveBeenCalled();
    expect(messages.some((m) => m.type === 'rewindError')).toBe(true);
    await session.dispose();
  });

  it('rewindFiles forks the very first message (parentId null) through to spawnPiFork (US-002 H1)', async () => {
    const messages: ExtensionToWebviewMessage[] = [];
    const onSpawnFork = vi.fn(async () => undefined);
    const session = new PiSession({ ...makeOptions(messages), onSpawnFork });
    await session.initializeEarly();
    const live = H.getLastSession()!;
    // The first entry in a session has parentId: null — forking it means "fork from before the first
    // message". This must NOT be rejected; it flows through as forkAtUuid: null (fresh panel).
    (live.sessionManager.getEntry as ReturnType<typeof vi.fn>).mockImplementation((id: string) =>
      id === 'u1' ? { id: 'u1', parentId: null, type: 'message' } : undefined,
    );

    await session.rewindFiles('u1', 'fork-conversation');

    expect(messages.some((m) => m.type === 'rewindError')).toBe(false);
    expect(onSpawnFork).toHaveBeenCalledTimes(1);
    const args = onSpawnFork.mock.calls[0]![0] as { forkAtUuid: string | null };
    expect(args.forkAtUuid).toBeNull();
    await session.dispose();
  });

  it('forks a first message whose parent is metadata WITHOUT a branched session id (no replay of an unwritten file)', async () => {
    const messages: ExtensionToWebviewMessage[] = [];
    const onSpawnFork = vi.fn(async () => undefined);
    const session = new PiSession({ ...makeOptions(messages), onSpawnFork });
    await session.initializeEarly();
    const live = H.getLastSession()!;
    // The first USER message's parent is a metadata entry (thinking_level_change), so parentId is
    // non-null — but the root→parent branch has NO assistant message. pi defers writing such a branched
    // file to disk, so we must NOT resume it (that would 404). The fork must proceed as a fresh panel.
    (live.sessionManager.getEntry as ReturnType<typeof vi.fn>).mockImplementation((id: string) =>
      id === 'u1' ? { id: 'u1', parentId: 'meta1', type: 'message' } : undefined,
    );
    (live.sessionManager.getSessionFile as ReturnType<typeof vi.fn>).mockReturnValue('/fake/agent/sessions/cwd/src.jsonl');
    (live.sessionManager.getBranch as ReturnType<typeof vi.fn>).mockImplementation((fromId?: string) =>
      fromId === 'meta1'
        ? [
            { type: 'session', id: 'sess' },
            { type: 'model_change', id: 'mc1', parentId: 'sess' },
            { type: 'thinking_level_change', id: 'meta1', parentId: 'mc1' },
          ]
        : [],
    );

    await session.rewindFiles('u1', 'fork-conversation', 'what is the day');

    expect(messages.some((m) => m.type === 'rewindError')).toBe(false);
    expect(onSpawnFork).toHaveBeenCalledTimes(1);
    const args = onSpawnFork.mock.calls[0]![0] as { forkAtUuid: string | null; piBranchedSessionId?: string; promptContent?: string };
    expect(args.forkAtUuid).toBe('meta1');
    // No branched session id → showForked won't try to replay a never-written file; the prompt prefills.
    expect(args.piBranchedSessionId).toBeUndefined();
    expect(args.promptContent).toBe('what is the day');
    await session.dispose();
  });

  it('rewindFiles(compactionId, code-only) restores the snapshot via a compaction-keyed checkpoint (Slice 2)', async () => {
    const messages: ExtensionToWebviewMessage[] = [];
    const session = new PiSession(makeOptions(messages));
    await session.initializeEarly();
    const live = H.getLastSession()!;
    // A damocles-checkpoint whose userEntryId IS a compaction entry id — structurally identical to a
    // prompt-keyed checkpoint; only the userEntryId happens to reference a compaction entry.
    (live.sessionManager.getBranch as ReturnType<typeof vi.fn>).mockReturnValue([
      { type: 'custom', customType: 'damocles-checkpoint', data: {
        v: 2, kind: 'checkpoint', turnId: 'turn-comp', userEntryId: 'comp1',
        beforeCommit: 'snap-commit', afterCommit: 'snap-commit', prompt: '', fileCount: 1,
        fileChanges: [{ path: 'a.ts', added: 1, removed: 0 }], createdAt: new Date().toISOString(),
      } },
    ]);
    const safeCheckout = vi.fn(async () => ({ ok: true }));
    const cpSvc = (session as unknown as { checkpointService: object }).checkpointService;
    vi.spyOn(cpSvc as { getRepo: (sm: unknown) => Promise<unknown> }, 'getRepo').mockResolvedValue({ safeCheckout });

    await session.rewindFiles('comp1', 'code-only');

    expect(safeCheckout).toHaveBeenCalledWith('snap-commit');
    expect(messages.some((m) => m.type === 'rewindComplete')).toBe(true);
    expect(messages.some((m) => m.type === 'rewindError')).toBe(false);
    await session.dispose();
  });

  it('rewindFiles(compactionId, fork-and-rewind-code) restores the snapshot AND spawns the fork (Slice 2)', async () => {
    const messages: ExtensionToWebviewMessage[] = [];
    const onSpawnFork = vi.fn(async () => undefined);
    const session = new PiSession({ ...makeOptions(messages), onSpawnFork });
    await session.initializeEarly();
    const live = H.getLastSession()!;
    (live.sessionManager.getBranch as ReturnType<typeof vi.fn>).mockReturnValue([
      { type: 'custom', customType: 'damocles-checkpoint', data: {
        v: 2, kind: 'checkpoint', turnId: 'turn-comp', userEntryId: 'comp1',
        beforeCommit: 'snap-commit', afterCommit: 'snap-commit', prompt: '', fileCount: 1,
        fileChanges: [{ path: 'a.ts', added: 1, removed: 0 }], createdAt: new Date().toISOString(),
      } },
    ]);
    // The compaction entry is an ordinary tree node; its parent is the last pre-compaction message.
    (live.sessionManager.getEntry as ReturnType<typeof vi.fn>).mockImplementation((id: string) =>
      id === 'comp1' ? { id: 'comp1', parentId: 'a1', type: 'compaction' } : undefined,
    );
    const safeCheckout = vi.fn(async () => ({ ok: true }));
    const cpSvc = (session as unknown as { checkpointService: object }).checkpointService;
    vi.spyOn(cpSvc as { getRepo: (sm: unknown) => Promise<unknown> }, 'getRepo').mockResolvedValue({ safeCheckout });

    await session.rewindFiles('comp1', 'fork-and-rewind-code');

    expect(safeCheckout).toHaveBeenCalledWith('snap-commit');
    expect(messages.some((m) => m.type === 'rewindError')).toBe(false);
    expect(onSpawnFork).toHaveBeenCalledTimes(1);
    const args = onSpawnFork.mock.calls[0]![0] as { forkAtUuid: string | null };
    expect(args.forkAtUuid).toBe('a1');
    await session.dispose();
  });

  it('rewindFiles(compactionId, code-only) with NO checkpoint fails soft (guards a webview gating bug)', async () => {
    const messages: ExtensionToWebviewMessage[] = [];
    const session = new PiSession(makeOptions(messages));
    await session.initializeEarly();
    const live = H.getLastSession()!;
    // The branch holds no damocles-checkpoint for this compaction id (legacy session, or the picker
    // gating let a checkpoint-less anchor through). File rewind must refuse rather than run git.
    (live.sessionManager.getBranch as ReturnType<typeof vi.fn>).mockReturnValue([]);

    await session.rewindFiles('comp1', 'code-only');

    expect(messages.some((m) => m.type === 'rewindError' && m.message === 'No checkpoint exists for this message')).toBe(true);
    expect(messages.some((m) => m.type === 'rewindComplete')).toBe(false);
    await session.dispose();
  });
});

describe('PiSession plan-mode force-continue (WI-3)', () => {
  beforeEach(() => {
    H.seq.length = 0;
    H.captured.services.length = 0;
    H.resetServices();
  });
  afterEach(async () => {
    await PiRuntime.disposeInstance();
  });

  type AgentEndEvt = { type: 'agent_end'; messages: unknown[] };
  const assistant = (stopReason: string): unknown => ({ role: 'assistant', stopReason, content: [{ type: 'text', text: 'here is the plan' }] });
  const exitResult = (isError: boolean): unknown => ({ role: 'toolResult', toolName: 'ExitPlanMode', isError, toolCallId: 'tc1', content: [] });
  const evt = (messages: unknown[]): AgentEndEvt => ({ type: 'agent_end', messages });

  /** Drive the `agent_end` coordinator through the registered panel context (the real dispatch path). */
  async function fireAgentEnd(session: PiSession, event: AgentEndEvt): Promise<void> {
    const live = H.getLastSession()!;
    const panel = (PiRuntime.get('/cwd', '/fake/agent') as unknown as {
      _panelRegistry: Map<string, { onAgentEnd?: (e: AgentEndEvt) => Promise<void> }>;
    })._panelRegistry.get(live.sessionId as string)!;
    await panel.onAgentEnd!(event);
  }

  /** The live session's sendCustomMessage spy + the session's adapter holdNextAgentEnd spy + the
   *  checkpoint service deferNextFinalize spy (held continuations must not mint a duplicate checkpoint). */
  function spies(session: PiSession): { send: ReturnType<typeof vi.fn>; hold: ReturnType<typeof vi.spyOn>; defer: ReturnType<typeof vi.spyOn> } {
    const live = H.getLastSession()!;
    const adapter = (session as unknown as { adapter: { holdNextAgentEnd: () => void } }).adapter;
    const checkpoint = (session as unknown as { checkpointService: { deferNextFinalize: () => void } | null }).checkpointService!;
    return {
      send: live.sendCustomMessage as ReturnType<typeof vi.fn>,
      hold: vi.spyOn(adapter, 'holdNextAgentEnd'),
      defer: vi.spyOn(checkpoint, 'deferNextFinalize'),
    };
  }

  it('plan mode + clean stop + no ExitPlanMode result ⇒ injects hidden nudge once and holds', async () => {
    const session = new PiSession(makeOptions([]));
    await session.initializeEarly();
    await session.setPermissionMode('plan');
    const { send, hold, defer } = spies(session);

    await fireAgentEnd(session, evt([assistant('stop')]));

    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]![0]).toMatchObject({ customType: 'damocles-plan-mode-nudge', display: false });
    expect(send.mock.calls[0]![1]).toMatchObject({ deliverAs: 'followUp', triggerTurn: true });
    expect(hold).toHaveBeenCalledTimes(1);
    // The held continuation must defer the checkpoint finalize so the plan turn keeps ONE checkpoint
    // (no duplicate Rewind rows per nudge round).
    expect(defer).toHaveBeenCalledTimes(1);
    await session.dispose();
  });

  it('plan mode + an APPROVED (non-error) ExitPlanMode result ⇒ no inject, no hold', async () => {
    const session = new PiSession(makeOptions([]));
    await session.initializeEarly();
    await session.setPermissionMode('plan');
    const { send, hold, defer } = spies(session);

    await fireAgentEnd(session, evt([assistant('stop'), exitResult(false)]));

    expect(send).not.toHaveBeenCalled();
    expect(hold).not.toHaveBeenCalled();
    expect(defer).not.toHaveBeenCalled();
    await session.dispose();
  });

  it('plan mode + a REJECTED (isError) ExitPlanMode result + clean stop ⇒ nudge fires', async () => {
    const session = new PiSession(makeOptions([]));
    await session.initializeEarly();
    await session.setPermissionMode('plan');
    const { send, hold } = spies(session);

    await fireAgentEnd(session, evt([exitResult(true), assistant('stop')]));

    expect(send).toHaveBeenCalledTimes(1);
    expect(hold).toHaveBeenCalledTimes(1);
    await session.dispose();
  });

  it('not in plan mode ⇒ no inject, no hold', async () => {
    const session = new PiSession(makeOptions([]));
    await session.initializeEarly();
    // default mode (never entered plan)
    const { send, hold } = spies(session);

    await fireAgentEnd(session, evt([assistant('stop')]));

    expect(send).not.toHaveBeenCalled();
    expect(hold).not.toHaveBeenCalled();
    await session.dispose();
  });

  it.each(['error', 'aborted', 'length'])('plan mode + last-assistant stopReason %s ⇒ no inject, no hold', async (reason) => {
    const session = new PiSession(makeOptions([]));
    await session.initializeEarly();
    await session.setPermissionMode('plan');
    const { send, hold } = spies(session);

    await fireAgentEnd(session, evt([assistant(reason)]));

    expect(send).not.toHaveBeenCalled();
    expect(hold).not.toHaveBeenCalled();
    await session.dispose();
  });

  it('_aborting === true ⇒ no inject, no hold', async () => {
    const session = new PiSession(makeOptions([]));
    await session.initializeEarly();
    await session.setPermissionMode('plan');
    (session as unknown as { _aborting: boolean })._aborting = true;
    const { send, hold } = spies(session);

    await fireAgentEnd(session, evt([assistant('stop')]));

    expect(send).not.toHaveBeenCalled();
    expect(hold).not.toHaveBeenCalled();
    await session.dispose();
  });

  it('plan mode + clean stop where the last assistant is a prose question (no ExitPlanMode) ⇒ nudge fires', async () => {
    const session = new PiSession(makeOptions([]));
    await session.initializeEarly();
    await session.setPermissionMode('plan');
    const { send, hold } = spies(session);

    // A prose "what should I do?" stop is still a clean stop with no ExitPlanMode — intended: redirect
    // the model to AskUserQuestion via the nudge rather than letting it stall on an unanswerable prose Q.
    const proseQuestion = { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: 'Which database should I use?' }] };
    await fireAgentEnd(session, evt([proseQuestion]));

    expect(send).toHaveBeenCalledTimes(1);
    expect(hold).toHaveBeenCalledTimes(1);
    await session.dispose();
  });

  it('background injected+held this cycle ⇒ plan-mode hold not also invoked (coordinator early-return)', async () => {
    const session = new PiSession(makeOptions([]));
    await session.initializeEarly();
    await session.setPermissionMode('plan');

    // Stub the subagent manager to report unconsumed background work, so the keep-alive injects+holds
    // and the coordinator returns before reaching the plan-mode hold.
    const mgr = (session as unknown as { subagentManager: unknown }).subagentManager as Record<string, unknown>;
    mgr.hasUnconsumedBackground = vi.fn(() => true);
    mgr.waitForBackground = vi.fn(async () => undefined);
    mgr.takeCompletedBackgroundResults = vi.fn(() => [{ type: 'Explore', description: 'd', result: 'r' }]);

    const { send, hold, defer } = spies(session);
    await fireAgentEnd(session, evt([assistant('stop')]));

    // Exactly one inject (the background results), with the background custom type — NOT the plan nudge.
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]![0]).toMatchObject({ customType: 'damocles-subagent-results' });
    expect(hold).toHaveBeenCalledTimes(1);
    // The background keep-alive also defers the checkpoint finalize (its synthesis round is the same turn).
    expect(defer).toHaveBeenCalledTimes(1);
    await session.dispose();
  });
});

describe('PiSession.steerSubagent (Slice 2 — /steer live flow)', () => {
  afterEach(async () => {
    await PiRuntime.disposeInstance();
  });

  it('emits subagentSteered with the record toolCallId as toolUseId and the manager status', async () => {
    const messages: ExtensionToWebviewMessage[] = [];
    const session = new PiSession(makeOptions(messages));
    await session.initializeEarly();

    const record: Record<string, unknown> = { type: 'Explore', description: 'find things', toolCallId: 'tool-42' };
    const steer = vi.fn(async () => 'steered' as const);
    (session as unknown as { subagentManager: unknown }).subagentManager = {
      steer,
      getRecord: vi.fn(() => record),
      dispose: vi.fn(),
    };

    await session.steerSubagent('agent-1', 'focus on tests');

    expect(steer).toHaveBeenCalledWith('agent-1', 'focus on tests');
    const emitted = messages.find((m) => m.type === 'subagentSteered');
    expect(emitted).toMatchObject({
      type: 'subagentSteered',
      agentId: 'agent-1',
      toolUseId: 'tool-42',
      agentType: 'Explore',
      description: 'find things',
      message: 'focus on tests',
      status: 'steered',
    });
    // A delivered steer is recorded on the record so the parent sees it when it consumes the result.
    expect(record.userSteers).toEqual(['focus on tests']);
    await session.dispose();
  });

  it('persists a damocles-steer sidecar entry (raw message, no marker) so reload replays the chip', async () => {
    const session = new PiSession(makeOptions([]));
    await session.initializeEarly();
    const record: Record<string, unknown> = { type: 'Explore', description: 'find things', toolCallId: 'tool-42' };
    (session as unknown as { subagentManager: unknown }).subagentManager = {
      steer: vi.fn(async () => 'steered' as const),
      getRecord: vi.fn(() => record),
      dispose: vi.fn(),
    };
    const appendCustomEntry = vi.fn();
    (session as unknown as { runtime: unknown }).runtime = { session: { sessionManager: { appendCustomEntry } }, dispose: vi.fn() };

    await session.steerSubagent('agent-1', 'focus on tests');

    expect(appendCustomEntry).toHaveBeenCalledWith('damocles-steer', {
      agentId: 'agent-1',
      agentType: 'Explore',
      description: 'find things',
      message: 'focus on tests',
    });
    await session.dispose();
  });

  it('does NOT persist a sidecar entry for a non-deliverable steer (finished)', async () => {
    const session = new PiSession(makeOptions([]));
    await session.initializeEarly();
    const record: Record<string, unknown> = { type: 'Explore', description: 'd', toolCallId: 't1' };
    (session as unknown as { subagentManager: unknown }).subagentManager = {
      steer: vi.fn(async () => 'finished' as const),
      getRecord: vi.fn(() => record),
      dispose: vi.fn(),
    };
    const appendCustomEntry = vi.fn();
    (session as unknown as { runtime: unknown }).runtime = { session: { sessionManager: { appendCustomEntry } }, dispose: vi.fn() };

    await session.steerSubagent('agent-1', 'too late');

    expect(appendCustomEntry).not.toHaveBeenCalled();
    await session.dispose();
  });

  it('ignores an empty steer message (no emit, no persistence)', async () => {
    const messages: ExtensionToWebviewMessage[] = [];
    const session = new PiSession(makeOptions(messages));
    await session.initializeEarly();
    const steer = vi.fn(async () => 'steered' as const);
    (session as unknown as { subagentManager: unknown }).subagentManager = { steer, getRecord: vi.fn(), dispose: vi.fn() };

    await session.steerSubagent('agent-1', '   ');

    expect(steer).not.toHaveBeenCalled();
    expect(messages.find((m) => m.type === 'subagentSteered')).toBeUndefined();
    await session.dispose();
  });

  it('records the user steer on a queued agent so the parent still becomes aware of it', async () => {
    const session = new PiSession(makeOptions([]));
    await session.initializeEarly();
    const record: Record<string, unknown> = { type: 'Explore', description: 'd', toolCallId: 't1' };
    (session as unknown as { subagentManager: unknown }).subagentManager = {
      steer: vi.fn(async () => 'queued' as const),
      getRecord: vi.fn(() => record),
      dispose: vi.fn(),
    };

    await session.steerSubagent('agent-1', 'skip the UI');

    expect(record.userSteers).toEqual(['skip the UI']);
    await session.dispose();
  });

  it('no manager / unknown id → status not-found, toolUseId null, and no userSteers write', async () => {
    const messages: ExtensionToWebviewMessage[] = [];
    const session = new PiSession(makeOptions(messages));
    await session.initializeEarly();
    // subagentManager stays null (no subagent engine ever built) → treated as 'not-found'.

    await session.steerSubagent('ghost', 'hello');

    const emitted = messages.find((m) => m.type === 'subagentSteered');
    expect(emitted).toMatchObject({
      type: 'subagentSteered',
      agentId: 'ghost',
      toolUseId: null,
      message: 'hello',
      status: 'not-found',
    });
    expect((emitted as { agentType?: string }).agentType).toBeUndefined();
    await session.dispose();
  });

  it('does NOT write userSteers when the manager reports a non-deliverable status (finished)', async () => {
    const session = new PiSession(makeOptions([]));
    await session.initializeEarly();
    const record: Record<string, unknown> = { type: 'Explore', description: 'd', toolCallId: 't1' };
    (session as unknown as { subagentManager: unknown }).subagentManager = {
      steer: vi.fn(async () => 'finished' as const),
      getRecord: vi.fn(() => record),
      dispose: vi.fn(),
    };

    await session.steerSubagent('agent-1', 'too late');

    expect(record.userSteers).toBeUndefined();
    await session.dispose();
  });
});
