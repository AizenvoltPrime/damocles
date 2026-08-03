import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as path from 'path';
import * as os from 'os';
import type { SessionOptions } from '../../session-types';
import type { ExtensionToWebviewMessage } from '../../../shared/types/messages';

const H = vi.hoisted(() => {
  const seq: string[] = [];
  const captured: { services: unknown[] } = { services: [] };
  let sessionCounter = 0;
  let lastSession: ReturnType<typeof makeSession> | null = null;
  // Opt-in: a test can swap the structural sessionManager fake for a REAL pi SessionManager on a
  // tmpdir, so the on-disk no-append-after-rm invariant is exercised rather than simulated.
  let sessionManagerFactory: (() => unknown) | null = null;

  function makeSession() {
    const id = `sess-${++sessionCounter}`;
    const sessionManager = (sessionManagerFactory?.() ?? {
      getSessionName: vi.fn((): string | undefined => undefined),
      appendSessionInfo: vi.fn((_name: string) => 'info-1'),
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
    }) as {
      getSessionName: (() => string | undefined);
      appendSessionInfo: ((name: string) => unknown);
      getSessionFile: (() => string | undefined);
      [k: string]: unknown;
    };
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
      // Mirrors pi's AgentSession.setSessionName, which appends through the manager — so a real
      // manager really writes to disk here and the fake stays structurally honest.
      setSessionName: vi.fn((name: string) => { sessionManager.appendSessionInfo(name); }),
      sessionManager,
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

  return {
    seq,
    captured,
    fakePi,
    resetServices: () => { services = makeServices(); },
    getServices: () => services,
    getLastSession: () => lastSession,
    setSessionManagerFactory: (f: (() => unknown) | null) => { sessionManagerFactory = f; },
  };
});

// The AI title sub-call, controllable per test. Defaults to "no title", so every other turn-driving
// test leaves the auto-title path inert; the title tests swap in their own resolution timing.
const TITLE = vi.hoisted(() => ({ impl: async (): Promise<string | null> => null }));
vi.mock('../session-title', () => ({ generateSessionTitle: () => TITLE.impl() }));

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

import * as vscode from 'vscode';
import { PiSession } from '../pi-session';
import { PiRuntime } from '../pi-runtime';
import { getPiCodingAgent } from '../pi-loader';
import { resolveAgentToolset } from '../subagents/agent-toolset';
import { DEFAULT_AGENTS } from '../subagents/default-agents';
import { computePlanFilePath } from '../../paths';
import { PLAN_MODE_EXCLUDED_TOOLS, PI_NATIVE_ACTIVE_TOOLS, WEB_TOOLS } from '../pi-models';
import { fullActiveToolNames, type ToolStatusDeps } from '../tool-status';
import { BROWSER_PI_TOOL_NAMES } from '../tools/browser-tools';
import { MEMORY_PI_TOOL_NAMES } from '../tools/memory-tools';
import { COMPASS_PI_TOOL_NAMES } from '../tools/compass-tools';
import { TEAM_MAIN_PI_TOOL_NAMES, TEAM_AGENT_PI_TOOL_NAMES } from '../tools/team-tools';
import { deferredToolNames } from '../tools/deferred-tools';
import { CUSTOM_TOOL_NAMES } from '../tools';
import { FULL_TOOL_CATALOG } from '../tools/tool-catalog';
import { TOOL_ENTER_PLAN_MODE, TOOL_BROWSER_REQUEST_INPUT, TOOL_TOOL_SEARCH, TOOL_EDIT } from '../../../shared/tool-names';
import type { MemoryService } from '../../memory';
import type { CompassService } from '../../compass';
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

  it('plan mode keeps every LOADED MCP tool in the active set, read-only or not (US-014.4)', async () => {
    // Subject unchanged and still the security-relevant one: plan mode does NOT filter MCP tools by
    // their read-only annotation. Slice 2 defers MCP tools until ToolSearch loads them, so the test now
    // loads both first — but the assertion that matters is untouched: once loaded, the NON-read-only
    // `mcp__git__commit` survives plan mode exactly as the read-only one does. A source change that
    // reintroduced read-only filtering in plan mode still fails here.
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

    // Deferred baseline first: neither is active until ToolSearch loads it.
    setActive.mockClear();
    session.refreshActiveTools();
    const beforeLoad = setActive.mock.calls.at(-1)?.[0] as string[];
    expect(beforeLoad).not.toContain('mcp__ctx7__query_docs');
    expect(beforeLoad).not.toContain('mcp__git__commit');

    session.activateDeferredTools(['mcp__ctx7__query_docs', 'mcp__git__commit']);
    setActive.mockClear();
    await session.setPermissionMode('plan');

    const planNames = setActive.mock.calls.at(-1)?.[0] as string[];
    expect(planNames).toContain('mcp__ctx7__query_docs');
    expect(planNames).toContain('mcp__git__commit');
    await session.dispose();
  });

  it('plan mode carries the browser tools when the browser is enabled, and none when it is off', async () => {
    const cfg = vi.spyOn(vscode.workspace, 'getConfiguration');
    const withBrowser = (enabled: boolean) => {
      cfg.mockImplementation(((section?: string) => ({
        get: (key: string, def?: unknown) => (section === 'damocles.browser' && key === 'enabled' ? enabled : def),
        update: () => Promise.resolve(),
      })) as unknown as typeof vscode.workspace.getConfiguration);
    };

    withBrowser(true);
    const session = new PiSession(makeOptions([]));
    await session.initializeEarly();
    const live = H.getLastSession()!;
    const setActive = live.setActiveToolsByName as ReturnType<typeof vi.fn>;

    // Slice 2: browser tools are deferred, so the test loads them before asserting plan mode carries
    // them. Subject unchanged — the BROWSER MASTER FLAG governs plan-mode membership, not plan mode.
    session.activateDeferredTools([...BROWSER_PI_TOOL_NAMES]);
    setActive.mockClear();
    await session.setPermissionMode('plan');
    const withOn = setActive.mock.calls.at(-1)?.[0] as string[];
    for (const name of BROWSER_PI_TOOL_NAMES) expect(withOn, name).toContain(name);
    expect(withOn).toContain(TOOL_BROWSER_REQUEST_INPUT);

    // …and the off case is now STRICTLY STRONGER than before Slice 2: the tools are absent even though
    // ToolSearch activated them. That is the eligibility-beats-activated-preference invariant (§2.2) —
    // the activated set is a preference, never an override, so turning the subsystem off wins.
    withBrowser(false);
    setActive.mockClear();
    await session.setPermissionMode('plan');
    const withOff = setActive.mock.calls.at(-1)?.[0] as string[];
    for (const name of BROWSER_PI_TOOL_NAMES) expect(withOff, name).not.toContain(name);

    cfg.mockRestore();
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
    // Slice 2: the MCP tool is deferred, so it only reaches the active set once loaded. Loading it here
    // keeps the final assertion end-to-end; the RELOAD DECISION under test is untouched.
    session.activateDeferredTools(['mcp__ctx7__query_docs']);
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
    // Slice 2: deferred until loaded (see the sibling test above). The ORPHAN DETECTION under test is
    // unaffected — `missingMcpRegistryNames` reads the ELIGIBLE set, not the active one, so a deferred
    // MCP tool still triggers the rebuild. That is exactly what this assertion pair proves.
    session.activateDeferredTools(['mcp__ctx7__query_docs']);
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
    // `reset()` chains `runtime.newSession()` onto `resetPromise`; a bare macrotask tick does not drain
    // that chain, so the fresh session's first apply would not have happened yet. `whenReplaced()` is
    // the public seam for exactly this wait (credit: extension-host's harness finding).
    session.reset();
    await session.whenReplaced();
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

  // `'pending'` is pi 0.83.0's initial value for a streaming assistant message, resolved before
  // `agent_end`. The hold gates on an allowlist (`=== 'stop'`), so an unresolved reason cannot nudge —
  // pinned here so the allowlist is stated rather than assumed by whoever reads the guard next.
  it.each(['error', 'aborted', 'length', 'pending'])('plan mode + last-assistant stopReason %s ⇒ no inject, no hold', async (reason) => {
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

describe('PiSession — subagent model resolution', () => {
  // These tests mutate the shared fake services (auth state), so each starts from a fresh set.
  beforeEach(() => {
    H.resetServices();
  });
  afterEach(async () => {
    await PiRuntime.disposeInstance();
  });

  /** Run `fn` with every provider unauthed, restoring the stub afterwards. Restoring locally (rather
   *  than relying on this block's beforeEach) keeps the mutation from reaching a later describe — the
   *  services object is shared file-wide and the next block does not reset it. */
  async function withoutAuth<T>(fn: () => T): Promise<T> {
    const runtime = H.getServices().modelRuntime;
    const original = runtime.hasConfiguredAuth;
    runtime.hasConfiguredAuth = () => false;
    try {
      return fn();
    } finally {
      runtime.hasConfiguredAuth = original;
    }
  }

  /** The private resolver, as the AgentManager engine calls it. Note it takes ONLY an agent config —
   *  there is no spawn-time model argument, which is the point of the precedence. */
  // "Game Designer" deliberately, never "Explore" — that name takes the Explore-settings branch and
  // would silently bypass the precedence these tests pin.
  type Cfg = { name: string; description: string; model?: string; filePath?: string };
  function resolve(session: PiSession, cfg: Cfg) {
    return (session as unknown as { resolveSubagentModel: (c: Cfg) => { model?: unknown; modelLabel?: string; error?: string } })
      .resolveSubagentModel(cfg);
  }

  it('inherits the session model when the template declares none', async () => {
    const session = new PiSession(makeOptions([]));
    await session.initializeEarly();
    const res = resolve(session, { name: 'Game Designer', description: 'd' });
    expect(res.error).toBeUndefined();
    expect(res.model).toMatchObject({ id: 'claude-opus-4-8', provider: 'anthropic' });
    await session.dispose();
  });

  it('honors the template `model:` over the session model', async () => {
    const session = new PiSession(makeOptions([]));
    await session.initializeEarly();
    const res = resolve(session, { name: 'Game Designer', description: 'd', model: 'claude-opus-4-8' });
    expect(res.error).toBeUndefined();
    expect(res.model).toMatchObject({ id: 'claude-opus-4-8', provider: 'anthropic' });
    await session.dispose();
  });

  it('surfaces a template model that does not exist instead of silently using the session model', async () => {
    const session = new PiSession(makeOptions([]));
    await session.initializeEarly();
    const res = resolve(session, { name: 'Game Designer', description: 'd', model: 'claude-sonnet-4.5', filePath: '/agents/gd.md' });
    expect(res.model).toBeUndefined();
    // A broken pin must be visible and point at the file to fix — hiding it behind a fallback would
    // leave the template silently wrong forever.
    expect(res.error).toContain('claude-sonnet-4.5');
    expect(res.error).toContain('/agents/gd.md');
    await session.dispose();
  });

  it('rejects a resolvable-but-unauthed template model rather than spawning a session that fails at first request', async () => {
    const session = new PiSession(makeOptions([]));
    await session.initializeEarly();
    const res = await withoutAuth(() => resolve(session, { name: 'Game Designer', description: 'd', model: 'claude-opus-4-8' }));
    expect(res.model).toBeUndefined();
    // Branched cause: the model exists, so the fix is signing in — not editing the template.
    expect(res.error).toContain('not signed in');
    await session.dispose();
  });

  it('requires auth on the `provider/modelId` form too, not just curated values', async () => {
    const session = new PiSession(makeOptions([]));
    await session.initializeEarly();
    // The direct-lookup fallback skips resolvePiModel entirely, so without its own auth check this
    // form silently re-admits a model auth just rejected.
    const res = await withoutAuth(() => resolve(session, { name: 'Game Designer', description: 'd', model: 'anthropic/claude-opus-4-8' }));
    expect(res.model).toBeUndefined();
    expect(res.error).toContain('not available');
    await session.dispose();
  });

  it('accepts the `provider/modelId` form when its provider IS authed', async () => {
    const session = new PiSession(makeOptions([]));
    await session.initializeEarly();
    const res = resolve(session, { name: 'Game Designer', description: 'd', model: 'anthropic/claude-opus-4-8' });
    expect(res.error).toBeUndefined();
    expect(res.model).toMatchObject({ id: 'claude-opus-4-8', provider: 'anthropic' });
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

/**
 * Slice 1 guards for the plan-mode active-set INVERSION (inclusion allowlist → exclusion list). These
 * operate on the pure `fullActiveToolNames` + `PLAN_MODE_EXCLUDED_TOOLS` pair rather than a live session,
 * so they state the set algebra directly.
 */
describe('plan-mode active set — exclusion model', () => {
  const fullyEnabled: ToolStatusDeps = {
    webEnabled: true,
    teamEnabled: true,
    teamAvailable: true,
    memoryService: { isEnabled: true } as unknown as MemoryService,
    compassService: { isEnabled: true } as unknown as CompassService,
    browserAvailable: true,
    browserEnabled: true,
    mcpEnabled: true,
    mcpToolNames: ['mcp__git__status', 'mcp__git__commit'],
    disabled: new Set<string>(),
  };

  const planSet = (): string[] => {
    const excluded = new Set(PLAN_MODE_EXCLUDED_TOOLS);
    return fullActiveToolNames(fullyEnabled).filter((n) => !excluded.has(n));
  };

  /**
   * The plan-mode tool set, PINNED. This is the decision point: because the gateable module tools
   * (memory/compass/browser/team) are auto-allowed by `runPermissionGate` BEFORE its plan-mode branch,
   * `PLAN_MODE_EXCLUDED_TOOLS` is their only plan-mode control — so a tool silently reaching plan mode is
   * a security change, not a UX one.
   *
   * A live-constant expectation cannot catch that: a 26th entry in `BROWSER_SPECS` would satisfy
   * `toContain(...BROWSER_PI_TOOL_NAMES)` while granting the planner a tool nobody reviewed. Pinning the
   * names means ANY new tool anywhere fails here until someone decides whether it belongs in plan mode.
   *
   * When this test fails, do not just paste the new name in. Decide first: should a PLANNING agent be
   * able to call it? If no, add it to `PLAN_MODE_EXCLUDED_TOOLS`. If yes, add it here with that reasoning
   * in the commit message.
   *
   * Do NOT "fix" this list when a deferred group is missing from a live plan-mode request: `planSet()`
   * filters `fullActiveToolNames`, which is ELIGIBILITY, not the deferred active set.
   */
  const PINNED_PLAN_MODE_TOOLS = [
    'Agent', 'AskUserQuestion', 'BrowserAccessibility', 'BrowserAct', 'BrowserClick', 'BrowserClose',
    'BrowserConsole', 'BrowserDownloads', 'BrowserDrag', 'BrowserElement', 'BrowserEvaluate',
    'BrowserFill', 'BrowserHover', 'BrowserIntercept', 'BrowserNavigate', 'BrowserNetwork',
    'BrowserOpen', 'BrowserQuery', 'BrowserRequestInput', 'BrowserScreenshot', 'BrowserScroll',
    'BrowserSelect', 'BrowserSnapshot', 'BrowserTabs', 'BrowserType', 'BrowserUpload', 'BrowserWait',
    'CodeSearch', 'CompassBlastRadius', 'CompassBuild', 'CompassContext', 'CompassDeadCode',
    'CompassQuery', 'CompassReviewContext', 'CompassSearch', 'CompassStats', 'Edit', 'ExitPlanMode',
    'FeedRead', 'ForgetMemory', 'GetMemoryDetails', 'GetMemoryHistory', 'GetRelatedMemories',
    'GetSubagentResult', 'ListNotes', 'PowerShell', 'ResetObservationStaleness', 'SaveMemory',
    'SaveNote', 'SaveObservation', 'SearchMemories', 'SteerSubagent', 'TaskCreate', 'TaskGet',
    'TaskList', 'TaskUpdate', 'ToolSearch', 'UnforgetMemory', 'UpdateMemory', 'WebFetch', 'WebSearch',
    'YouTubeTranscript', 'bash', 'find', 'grep', 'ls', 'read', 'write',
  ];
  // `ToolSearch` (Slice 2) was added here after answering this block's question deliberately: SHOULD a
  // planning agent be able to call it? Yes — with browser/compass/MCP deferred, ToolSearch is the only
  // route back to them, so excluding it would leave a planner permanently unable to load a tool it needs
  // to research with, while plan mode is exactly where research happens. It is also read-only by
  // construction: it activates tools, and every activated tool still passes through the gate on use, so
  // it grants no capability the planner did not already have. Deliberately NOT in
  // `PLAN_MODE_EXCLUDED_TOOLS` (brief §2.5).

  it('matches the pinned plan-mode tool set exactly (no tool arrives unreviewed)', () => {
    const deps = { ...fullyEnabled, mcpEnabled: false, mcpToolNames: [] };
    const excluded = new Set(PLAN_MODE_EXCLUDED_TOOLS);
    const actual = fullActiveToolNames(deps).filter((n) => !excluded.has(n));
    expect(actual.sort()).toEqual([...PINNED_PLAN_MODE_TOOLS].sort());
  });

  // The old INCLUSION expression, reproduced verbatim from the pre-inversion `applyActiveToolsForMode`.
  // Kept deliberately: it is the only assertion that states the inversion's behavioral delta as a set
  // difference, so it fails loudly if a later edit widens plan mode while updating the pinned list above.
  const LEGACY_READONLY = ['read', 'grep', 'find', 'ls', 'WebSearch', 'WebFetch', 'CodeSearch', 'FeedRead', 'YouTubeTranscript'];
  const LEGACY_INTERACTIVE = ['AskUserQuestion', 'TaskCreate', 'TaskUpdate', 'TaskList', 'TaskGet', 'ExitPlanMode', 'Agent', 'GetSubagentResult', 'SteerSubagent'];
  const LEGACY_PLAN_FILE = ['Edit', 'write'];
  const LEGACY_SHELL = ['bash', 'PowerShell'];

  // Slice 2 widened `gained` by exactly one name: `ToolSearch` joined the eligible universe. The delta
  // is still stated as a set difference (not relaxed to a `toContain`), so a later edit that widens plan
  // mode by anything else still fails here even after the pinned list above is updated.
  it('differs from the pre-inversion set by EXACTLY the browser tools plus ToolSearch', () => {
    const legacyAllowed = new Set([...LEGACY_READONLY, ...LEGACY_INTERACTIVE, ...LEGACY_PLAN_FILE, ...LEGACY_SHELL, ...COMPASS_PI_TOOL_NAMES, ...MEMORY_PI_TOOL_NAMES]);
    const legacy = fullActiveToolNames(fullyEnabled).filter((n) => legacyAllowed.has(n) || n.startsWith('mcp__'));

    const gained = planSet().filter((n) => !legacy.includes(n));
    const lost = legacy.filter((n) => !planSet().includes(n));

    expect(gained.sort()).toEqual([...BROWSER_PI_TOOL_NAMES, TOOL_TOOL_SEARCH].sort());
    expect(lost).toEqual([]);
  });

  it('excludes EnterPlanMode and the team main tools, and nothing else', () => {
    expect([...PLAN_MODE_EXCLUDED_TOOLS].sort()).toEqual([TOOL_ENTER_PLAN_MODE, ...TEAM_MAIN_PI_TOOL_NAMES].sort());
    const names = planSet();
    expect(names).not.toContain(TOOL_ENTER_PLAN_MODE);
    for (const n of TEAM_MAIN_PI_TOOL_NAMES) expect(names, n).not.toContain(n);
  });

  it('keeps every tool the planner needs — interactive, shell, plan-file, module, web and MCP', () => {
    const names = planSet();
    for (const n of ['ExitPlanMode', 'AskUserQuestion', 'TaskCreate', 'TaskUpdate', 'TaskList', 'TaskGet', 'Agent', 'GetSubagentResult', 'SteerSubagent', 'Edit', 'write', 'bash', 'PowerShell', 'mcp__git__commit']) {
      expect(names, n).toContain(n);
    }
    for (const n of [...MEMORY_PI_TOOL_NAMES, ...COMPASS_PI_TOOL_NAMES, ...BROWSER_PI_TOOL_NAMES, ...WEB_TOOLS, ...PI_NATIVE_ACTIVE_TOOLS]) {
      expect(names, n).toContain(n);
    }
    for (const n of CUSTOM_TOOL_NAMES) {
      if (n === TOOL_ENTER_PLAN_MODE) continue;
      expect(names, n).toContain(n);
    }
  });

  // The root-cause guard, stated as the DEFAULT rather than as a per-group expectation. Asserting
  // "every group except team must be present" would be an anti-guard: correctly excluding a future
  // mutating subsystem would fail CI, while forgetting to exclude it would pass. What actually needs
  // protecting is that exclusion is DELIBERATE — a subsystem is absent from plan mode only because its
  // names are in PLAN_MODE_EXCLUDED_TOOLS, never because an allowlist forgot it.
  it('omits a catalog group only when its names are explicitly excluded', () => {
    const names = new Set(planSet());
    const excluded = new Set(PLAN_MODE_EXCLUDED_TOOLS);
    // Toggleable entries only: the core group's catalog names are webview DISPLAY names (`Read`,
    // `Glob`), not the pi-native active-set names (`read`, `find`), so they never match by identity.
    // Every toggleable subsystem names its tools by active-set identity, which is what plan mode filters.
    // The `team_*` AGENT tools are catalogued for the panel but built per team-agent, so they are in no
    // panel active set in ANY mode — their absence says nothing about plan mode.
    const agentOnly = new Set(TEAM_AGENT_PI_TOOL_NAMES);
    for (const entry of FULL_TOOL_CATALOG.filter((e) => e.toggleable && !agentOnly.has(e.name))) {
      if (names.has(entry.name)) continue;
      expect(
        excluded.has(entry.name),
        `${entry.name} (group ${entry.group}) is absent from plan mode but not in PLAN_MODE_EXCLUDED_TOOLS`,
      ).toBe(true);
    }
  });
});

/**
 * Slice 2: deferred tools in the live panel. The property under test is DURABILITY — Damocles calls
 * `refreshActiveTools()` on many unrelated events (settings toggles, MCP connects, permission-mode
 * changes), and before this slice any one of them would have silently deactivated a tool ToolSearch
 * had loaded mid-conversation. These drive the real `PiSession` seam (`activateDeferredTools`) and read
 * what actually reached `session.setActiveToolsByName`.
 */
describe('PiSession — ToolSearch activation survives every recompute (Slice 2)', () => {
  // `PiRuntime` is a per-cwd SINGLETON: without disposing it between cases, a later session reuses the
  // previous test's runtime and `H.getLastSession()` returns a stale session that this panel never
  // bound — every active-set assertion then reads an array nobody wrote. Mirrors the lifecycle block.
  beforeEach(() => {
    H.seq.length = 0;
    H.captured.services.length = 0;
    H.resetServices();
  });
  afterEach(async () => {
    await PiRuntime.disposeInstance();
  });

  /**
   * Browser AND web enabled. A helper leaving web disabled would make every "no web tool is active"
   * assertion below pass for the wrong reason — INELIGIBLE rather than deferred.
   */
  const subsystemsOn = () => {
    const cfg = vi.spyOn(vscode.workspace, 'getConfiguration');
    cfg.mockImplementation(((section?: string) => ({
      get: (key: string, def?: unknown) => {
        if (section === 'damocles.browser' && key === 'enabled') return true;
        if (section === 'damocles' && key === 'pi.webSearch.enabled') return true;
        return def;
      },
      update: () => Promise.resolve(),
    })) as unknown as typeof vscode.workspace.getConfiguration);
    return cfg;
  };

  const lastActive = (live: NonNullable<ReturnType<typeof H.getLastSession>>): string[] =>
    ((live.setActiveToolsByName as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[0] ?? []) as string[];

  it('starts a session with ToolSearch active and NO browser/compass/web/MCP tool active', async () => {
    // The demoable baseline: the first `setActiveToolsByName` of a session must already be the deferred
    // one. A wiring that applied deferral only on later recomputes would still pay the full schema cost
    // on exactly the request this feature exists to shrink — the first one.
    const cfg = subsystemsOn();
    const session = new PiSession(makeOptions([]));
    await session.initializeEarly();
    const runtime = PiRuntime.get('/cwd', '/fake/agent');
    vi.spyOn(runtime, 'getMcpClientManager').mockReturnValue({
      allToolNames: () => ['mcp__ctx7__query_docs'],
      // `deferrableToolsSnapshot()` also asks the CLIENT for statuses and blurbs (never pi's registry —
      // that recurses through ToolSearch's own description getter), so both are stubbed.
      getServerStatuses: () => [],
      getAllToolDescriptors: () => [],
    } as unknown as ReturnType<typeof runtime.getMcpClientManager>);
    const live = H.getLastSession()!;

    session.refreshActiveTools();
    const names = lastActive(live);

    expect(names).toContain(TOOL_TOOL_SEARCH);
    for (const n of BROWSER_PI_TOOL_NAMES) expect(names, n).not.toContain(n);
    for (const n of COMPASS_PI_TOOL_NAMES) expect(names, n).not.toContain(n);
    for (const n of WEB_TOOLS) expect(names, n).not.toContain(n);
    expect(names.filter((n) => n.startsWith('mcp__'))).toEqual([]);
    // ELIGIBLE yet absent from the active set — the distinction pure absence cannot make. The snapshot is
    // eligibility ∩ deferrable, so presence there says "held back", not "not available"; without it this
    // would pass identically against a build that just left web off.
    for (const n of WEB_TOOLS) expect(session.deferrableToolsSnapshot().names, n).toContain(n);
    // Everything NOT deferrable is untouched — this is a targeted deferral, not a smaller tool set.
    expect(names).toContain('read');
    expect(names).toContain('Edit');
    for (const n of CUSTOM_TOOL_NAMES) expect(names, n).toContain(n);

    cfg.mockRestore();
    await session.dispose();
  });

  it('keeps activated tools across refreshActiveTools() — an unrelated toggle cannot unload them', async () => {
    // The clobber bug this slice fixes, stated end-to-end: activate, then fire the exact call every
    // settings toggle makes. Without durable per-session state the recompute silently drops them.
    const cfg = subsystemsOn();
    const session = new PiSession(makeOptions([]));
    await session.initializeEarly();
    const live = H.getLastSession()!;

    session.activateDeferredTools([...BROWSER_PI_TOOL_NAMES]);
    for (const n of BROWSER_PI_TOOL_NAMES) expect(lastActive(live), n).toContain(n);

    session.refreshActiveTools();
    for (const n of BROWSER_PI_TOOL_NAMES) expect(lastActive(live), n).toContain(n);
    // Compass was never asked for and must not ride along.
    for (const n of COMPASS_PI_TOOL_NAMES) expect(lastActive(live), n).not.toContain(n);

    cfg.mockRestore();
    await session.dispose();
  });

  it('refreshActiveTools also republishes ToolSearch, so a toggle reaches the description', async () => {
    // The active set and the ADVERTISED inventory are two different surfaces. pi captures a tool's
    // `description` at wrap time, so recomputing the active set alone leaves the model reading a menu
    // from before the toggle — live F5 caught exactly that (browser disabled, still advertised). The
    // republish is what asks pi to re-wrap, and this pins that the one funnel every toggle already goes
    // through drives BOTH surfaces.
    const cfg = subsystemsOn();
    const session = new PiSession(makeOptions([]));
    await session.initializeEarly();
    const runtime = PiRuntime.get('/cwd', '/fake/agent');
    const republish = vi.spyOn(runtime, 'republishToolSearch');

    session.refreshActiveTools();

    expect(republish).toHaveBeenCalled();
    cfg.mockRestore();
    republish.mockRestore();
    await session.dispose();
  });

  /**
   * INVARIANT 2, end to end. pi's `wrapToolDefinition` copies `description` as a plain STRING, so a live
   * getter alone goes stale and `pi.registerTool` is the only public re-wrap trigger. Toggling
   * `damocles.pi.webSearch.enabled` must therefore reach `republishToolSearch()` — otherwise the model
   * keeps ordering from a menu that still lists `web (5)` after the user turned web off, and gets an
   * inert group; or, worse for adoption, never learns web exists after the user turns it ON.
   *
   * The chain is FOUR hops, and no test covered it end to end before this slice:
   *   `extension.ts` onDidChangeConfiguration → `PiRuntime.refreshWebSearch()`
   *     → `_refreshAllActiveTools()` → the refresher `PiSession.bindSession` registered
   *     → `PiSession.reloadForMcpToolChange()` → `refreshActiveTools()` → `republishToolSearch()`
   *
   * Entry is `refreshWebSearch()` — the seam `extension.ts`'s one-line listener calls — and everything
   * after it is the REAL wiring, not a spy. That matters because each hop was individually plausible
   * while the composition was unpinned: `_refreshAllActiveTools` iterates a map a session must have
   * registered itself into, and `reloadForMcpToolChange` only reaches `refreshActiveTools` on its
   * registry-current fast path. A break anywhere in the middle is silent — the toggle appears to work,
   * the active set is right, and only the advertised menu is wrong.
   */
  it('toggling web republishes ToolSearch through the full refreshWebSearch chain (invariant 2)', async () => {
    const cfg = subsystemsOn();
    const session = new PiSession(makeOptions([]));
    await session.initializeEarly();
    const runtime = PiRuntime.get('/cwd', '/fake/agent');
    const live = H.getLastSession()!;
    const republish = vi.spyOn(runtime, 'republishToolSearch');

    await runtime.refreshWebSearch();

    // The description surface: reached, so the next wrap re-materializes the inventory.
    expect(republish).toHaveBeenCalled();
    // …and the active-set surface too, recomputed in the same pass — the two must not drift apart, which
    // is the failure the republish exists to prevent in the first place.
    const names = lastActive(live);
    expect(names).toContain(TOOL_TOOL_SEARCH);
    for (const n of WEB_TOOLS) expect(names, n).not.toContain(n);

    cfg.mockRestore();
    republish.mockRestore();
    await session.dispose();
  });

  it('survives the plan-mode round trip, and plan still excludes EnterPlanMode + the team tools', async () => {
    // `PLAN_MODE_EXCLUDED_TOOLS` is subtracted from the union, and the two sets are disjoint, so the
    // subtraction and the union commute. Asserting the round trip proves that concretely: entering and
    // leaving plan mode recomputes from `toolSearchActivated` rather than from the last applied array,
    // so neither transition can clobber a loaded tool — while plan mode keeps its own exclusions intact.
    const cfg = subsystemsOn();
    const opts = makeOptions([]);
    opts.teamService = { dispose: () => {}, cancelActiveTeam: () => {} } as never;
    const session = new PiSession(opts);
    await session.initializeEarly();
    const live = H.getLastSession()!;

    session.activateDeferredTools([...BROWSER_PI_TOOL_NAMES]);

    await session.setPermissionMode('plan');
    const planNames = lastActive(live);
    for (const n of BROWSER_PI_TOOL_NAMES) expect(planNames, n).toContain(n);
    expect(planNames).toContain(TOOL_TOOL_SEARCH);
    expect(planNames).not.toContain(TOOL_ENTER_PLAN_MODE);
    for (const n of TEAM_MAIN_PI_TOOL_NAMES) expect(planNames, n).not.toContain(n);

    await session.setPermissionMode('default');
    const defaultNames = lastActive(live);
    for (const n of BROWSER_PI_TOOL_NAMES) expect(defaultNames, n).toContain(n);
    expect(defaultNames).toContain(TOOL_ENTER_PLAN_MODE);

    cfg.mockRestore();
    await session.dispose();
  });

  it('drops an activated tool when its subsystem is turned off (eligibility beats the preference)', async () => {
    // The acceptance criterion "a user-disabled browser tool stays absent even after ToolSearch loads
    // the group", driven through the live session rather than the pure function.
    const cfg = vi.spyOn(vscode.workspace, 'getConfiguration');
    let browserEnabled = true;
    cfg.mockImplementation(((section?: string) => ({
      get: (key: string, def?: unknown) => (section === 'damocles.browser' && key === 'enabled' ? browserEnabled : def),
      update: () => Promise.resolve(),
    })) as unknown as typeof vscode.workspace.getConfiguration);

    const session = new PiSession(makeOptions([]));
    await session.initializeEarly();
    const live = H.getLastSession()!;
    session.activateDeferredTools([...BROWSER_PI_TOOL_NAMES]);
    expect(lastActive(live)).toContain(BROWSER_PI_TOOL_NAMES[0]);

    browserEnabled = false;
    session.refreshActiveTools();
    for (const n of BROWSER_PI_TOOL_NAMES) expect(lastActive(live), n).not.toContain(n);

    cfg.mockRestore();
    await session.dispose();
  });

  it('reset() drops back to the deferred baseline (a fresh conversation re-earns its tools)', async () => {
    // The activated set is conversation state, not user configuration: a context clear must not carry a
    // previous conversation's loaded tools into the fresh session's first request. `bindSession` clears
    // it on a session-ID change, which is what `reset()` produces.
    const cfg = subsystemsOn();
    const session = new PiSession(makeOptions([]));
    await session.initializeEarly();
    const first = H.getLastSession()!;
    session.activateDeferredTools([...BROWSER_PI_TOOL_NAMES]);
    expect(lastActive(first)).toContain(BROWSER_PI_TOOL_NAMES[0]);

    // `reset()` chains `runtime.newSession()` onto `resetPromise`; a bare macrotask tick does not drain
    // that chain, so the fresh session's first apply would not have happened yet. `whenReplaced()` is
    // the public seam for exactly this wait (credit: extension-host's harness finding).
    session.reset();
    await session.whenReplaced();
    const second = H.getLastSession()!;
    expect(second).not.toBe(first);

    const names = lastActive(second);
    expect(names).toContain(TOOL_TOOL_SEARCH);
    for (const n of BROWSER_PI_TOOL_NAMES) expect(names, n).not.toContain(n);

    cfg.mockRestore();
    await session.dispose();
  });

  it('exposes a deferrable snapshot whose names are exactly what ToolSearch may activate', async () => {
    // The port contract: `names` is the deferrable universe already intersected with eligibility, and
    // `loaded` reflects the live active set. A snapshot built from the raw catalogs instead of from
    // `eligible` would offer the model tools the session would then refuse to activate.
    const cfg = subsystemsOn();
    const session = new PiSession(makeOptions([]));
    await session.initializeEarly();
    const runtime = PiRuntime.get('/cwd', '/fake/agent');
    vi.spyOn(runtime, 'getMcpClientManager').mockReturnValue({
      allToolNames: () => ['mcp__ctx7__query_docs'],
      getServerStatuses: () => [],
      // The snapshot sources MCP blurbs from the CLIENT, never from pi's tool registry (reading that
      // from ToolSearch's description getter recurses), so the stub must answer this too.
      getAllToolDescriptors: () => [{ piName: 'mcp__ctx7__query_docs', description: 'Query library docs' }],
    } as unknown as ReturnType<typeof runtime.getMcpClientManager>);

    const snap = session.deferrableToolsSnapshot();
    for (const n of BROWSER_PI_TOOL_NAMES) expect(snap.names, n).toContain(n);
    expect(snap.names).toContain('mcp__ctx7__query_docs');
    expect(snap.mcpGroups.get('ctx7')).toEqual(['mcp__ctx7__query_docs']);
    // Nothing non-deferrable is ever offered.
    expect(snap.names).not.toContain('read');
    expect(snap.names).not.toContain(TOOL_TOOL_SEARCH);
    // Blurbs come from the MCP client, keyed by pi tool name, and cover only deferrable tools. This is
    // what lets ToolSearch's description name MCP tools WITHOUT reading pi's registry — the read that
    // recursed through its own description getter and took every session down at startup.
    expect(snap.mcpDescriptions?.get('mcp__ctx7__query_docs')).toBe('Query library docs');

    cfg.mockRestore();
    await session.dispose();
  });
});

/**
 * Slice 3 §3.5 — team agents. `buildTeamEngine()` is the seam a team spawn goes through, so these drive
 * the REAL `PiSession.buildTeamEngine()` and read what its `buildExtensionFactory` arrow actually
 * registers into a nested `pi`. That arrow is invoked PER AGENT SPAWN, which is the property that makes
 * `teamAgentToolNames()` observe live panel state — and which a hoisted local would silently break.
 */
describe('PiSession.buildTeamEngine — team agents get uniform deferral (Slice 3 §3.5)', () => {
  beforeEach(() => {
    H.seq.length = 0;
    H.captured.services.length = 0;
    H.resetServices();
  });
  afterEach(async () => {
    await PiRuntime.disposeInstance();
  });

  type ToolSearchLike = {
    name: string;
    execute: (id: string, p: { tools: string[] }, s: undefined, u: undefined, c: unknown) => Promise<{ details?: { matches: string[]; totalDeferredTools: number } }>;
  };
  const execCtx = { sessionManager: { getSessionId: () => 'team-agent-1' } };

  /** Config spy whose browser/team flags the test flips mid-run, mirroring a real settings toggle. */
  function configWith(flags: { browser: boolean; team: boolean }) {
    const cfg = vi.spyOn(vscode.workspace, 'getConfiguration');
    cfg.mockImplementation(((section?: string) => ({
      get: (key: string, def?: unknown) => {
        if (section === 'damocles.browser' && key === 'enabled') return flags.browser;
        if (section === 'damocles' && key === 'team.enabled') return flags.team;
        return def;
      },
      update: () => Promise.resolve(),
    })) as unknown as typeof vscode.workspace.getConfiguration);
    return cfg;
  }

  /** A minimal nested `pi` exposing the ExtensionAPI members the subagent factory + ToolSearch touch. */
  function nestedPi(initialActive: string[] = []) {
    const registered = new Map<string, ToolSearchLike>();
    let active = [...initialActive];
    return {
      registered,
      active: () => [...active],
      api: {
        on: () => {},
        registerTool: (tool: ToolSearchLike) => registered.set(tool.name, tool),
        getActiveTools: () => [...active],
        setActiveTools: (names: string[]) => { active = [...names]; },
        getAllTools: () => [],
      } as never,
    };
  }

  async function teamSession() {
    const opts = makeOptions([]);
    opts.teamService = { dispose: () => {}, cancelActiveTeam: () => {} } as never;
    opts.compassService = { isEnabled: true } as never;
    const session = new PiSession(opts);
    await session.initializeEarly();
    return session;
  }

  /** The per-spawn context `team-runner.ts` hands `buildAgentToolset` at both spawn sites. */
  const spawnCtx = (agentId: string) => ({
    agentId,
    browserScopeId: `${agentId}#1`,
    agentName: 'specialist',
    role: 'specialist' as const,
  }) as never;

  it('a team agent\'s tools: carries ToolSearch and the deferrable names it must keep eligible', async () => {
    const cfg = configWith({ browser: true, team: true });
    const session = await teamSession();

    // `tools:` is composed the way `team-runner.ts` composes it — `toolNames` plus the spawn's frozen
    // `mcp.names`. Reading only `toolNames` would assert against half of what the session receives.
    const { toolNames, mcp } = session.buildTeamEngine().buildAgentToolset(spawnCtx('agent-1'));
    const names = [...toolNames, ...mcp.names];
    expect(names).toContain(TOOL_TOOL_SEARCH);
    for (const n of [...BROWSER_PI_TOOL_NAMES, ...COMPASS_PI_TOOL_NAMES]) expect(names, n).toContain(n);
    // The 16 coordination tools are present and — per deferredToolNames — never deferrable, so a
    // specialist can post to the scratchpad from turn one.
    for (const n of TEAM_AGENT_PI_TOOL_NAMES) expect(names, n).toContain(n);
    const deferrable = deferredToolNames(names, mcp.names);
    for (const n of TEAM_AGENT_PI_TOOL_NAMES) expect(deferrable, n).not.toContain(n);
    for (const n of COMPASS_PI_TOOL_NAMES) expect(deferrable, n).toContain(n);

    cfg.mockRestore();
    await session.dispose();
  });

  it('the spawned factory registers a working ToolSearch that loads compass mid-run', async () => {
    // End-to-end for the team half of the slice: build the engine, spawn a factory, register it into a
    // nested pi, and drive the resulting tool. Anything short of this leaves "does the port register in
    // the nested registry?" as an assertion about source rather than about behaviour.
    const cfg = configWith({ browser: true, team: true });
    const session = await teamSession();
    // Start from the deferred baseline a real nested session would have: the team_* tools active,
    // browser/compass held back. That is what `createSubagentSession` writes for a team agent.
    const baseline = ['read', 'Edit', TOOL_TOOL_SEARCH, ...TEAM_AGENT_PI_TOOL_NAMES];
    const nested = nestedPi(baseline);

    // ONE `buildAgentToolset` per spawn, and the SAME snapshot handed to `buildExtensionFactory` — the
    // shape `team-runner.ts` uses. Passing a freshly-built snapshot here instead would reintroduce the
    // second read this slice exists to remove, and the test would stop modelling the production path.
    const engine = session.buildTeamEngine();
    const { mcp } = engine.buildAgentToolset(spawnCtx('agent-1'));
    engine.buildExtensionFactory('specialist', 'agent-1', mcp)(nested.api);

    const tool = nested.registered.get(TOOL_TOOL_SEARCH);
    expect(tool).toBeDefined();

    const result = await tool!.execute('tc-1', { tools: ['compass'] }, undefined, undefined, execCtx);
    expect([...(result.details?.matches ?? [])].sort()).toEqual([...COMPASS_PI_TOOL_NAMES].sort());

    const after = nested.active();
    for (const n of COMPASS_PI_TOOL_NAMES) expect(after, n).toContain(n);
    // Purely additive: the coordination tools the specialist needs from turn one are still there.
    for (const n of baseline) expect(after, n).toContain(n);
    // …and the browser group it did NOT ask for stays deferred.
    for (const n of BROWSER_PI_TOOL_NAMES) expect(after, n).not.toContain(n);

    cfg.mockRestore();
    await session.dispose();
  });

  it('reads live panel state at SPAWN — a subsystem toggled on mid-run reaches the next agent', async () => {
    // The contract's load-bearing detail: `teamAgentToolNames()` is called INSIDE the per-spawn arrow.
    // Hoisting it to a `buildTeamEngine` local would freeze the deferrable set at team-construction time
    // and silently miss exactly this case. Driven by building the engine ONCE and spawning twice across
    // a toggle, which is the only shape that can tell the two implementations apart.
    const flags = { browser: false, team: true };
    const cfg = vi.spyOn(vscode.workspace, 'getConfiguration');
    cfg.mockImplementation(((section?: string) => ({
      get: (key: string, def?: unknown) => {
        if (section === 'damocles.browser' && key === 'enabled') return flags.browser;
        if (section === 'damocles' && key === 'team.enabled') return flags.team;
        return def;
      },
      update: () => Promise.resolve(),
    })) as unknown as typeof vscode.workspace.getConfiguration);

    const opts = makeOptions([]);
    opts.teamService = { dispose: () => {}, cancelActiveTeam: () => {} } as never;
    const session = new PiSession(opts);
    await session.initializeEarly();
    const engine = session.buildTeamEngine(); // built ONCE, before the toggle

    const before = nestedPi([TOOL_TOOL_SEARCH]);
    engine.buildExtensionFactory('specialist', 'agent-1', engine.buildAgentToolset(spawnCtx('agent-1')).mcp)(before.api);
    // Browser off, compass unwired and no MCP manager ⇒ nothing deferrable ⇒ registration is skipped.
    expect(before.registered.get(TOOL_TOOL_SEARCH)).toBeUndefined();

    flags.browser = true; // the user enables the browser mid-run

    const after = nestedPi([TOOL_TOOL_SEARCH]);
    engine.buildExtensionFactory('specialist', 'agent-2', engine.buildAgentToolset(spawnCtx('agent-2')).mcp)(after.api);
    const afterTool = after.registered.get(TOOL_TOOL_SEARCH);
    expect(afterTool).toBeDefined();

    // The second agent's universe is the LIVE one — it can actually load the newly-enabled group.
    const result = await afterTool!.execute('tc-1', { tools: ['browser'] }, undefined, undefined, execCtx);
    expect(result.details?.totalDeferredTools).toBe(BROWSER_PI_TOOL_NAMES.length);
    for (const n of BROWSER_PI_TOOL_NAMES) expect(after.active(), n).toContain(n);

    cfg.mockRestore();
    await session.dispose();
  });
});

/**
 * Slice 1 (nested MCP) — the TEAM half, through the REAL `PiSession.buildTeamEngine()` (criterion 7).
 *
 * Every assertion below goes through the real engine's real `buildAgentToolset` arrow and the real
 * `buildExtensionFactory` arrow, with the runtime's MCP client manager stubbed at the seam `PiSession`
 * actually reads (`PiRuntime.getMcpClientManager`). Nothing about the snapshot is faked: the
 * definitions are built by the real `buildNestedMcpToolset` from the real descriptors, so what a team
 * specialist would receive is what is asserted.
 */
/** The shared `McpClientManager.callTool` spy every stubbed manager in this block routes to. */
const mcpCallTool = vi.fn(async (piName: string, _args: Record<string, unknown>, _opts?: { signal?: AbortSignal }) => ({
  content: [{ type: 'text' as const, text: `result of ${piName}` }],
  isError: false,
}));

describe('PiSession.buildTeamEngine — a team specialist gets MCP (Slice 1, criterion 7)', () => {
  beforeEach(() => {
    mcpCallTool.mockClear();
    H.seq.length = 0;
    H.captured.services.length = 0;
    H.resetServices();
  });
  afterEach(async () => {
    await PiRuntime.disposeInstance();
  });

  const MCP_DESCRIPTORS = [
    { piName: 'mcp__git__status', serverName: 'git', kind: 'tool' as const, originalName: 'status', description: 'Show the working tree status', inputSchema: { type: 'object', properties: {} }, readOnly: true },
    { piName: 'mcp__git__commit', serverName: 'git', kind: 'tool' as const, originalName: 'commit', description: 'Create a commit', inputSchema: { type: 'object', properties: {} }, readOnly: false },
  ];

  const teamExecCtx = { sessionManager: { getSessionId: () => 'team-agent-1' } };

  /** A minimal nested `pi` exposing the ExtensionAPI members the subagent factory + ToolSearch touch. */
  function nestedTeamPi(initialActive: string[] = []) {
    const registered = new Map<string, { name: string; description: string; execute: (...a: never[]) => Promise<unknown> }>();
    let active = [...initialActive];
    return {
      registered,
      active: () => [...active],
      api: {
        on: () => {},
        registerTool: (tool: { name: string }) => registered.set(tool.name, tool as never),
        getActiveTools: () => [...active],
        setActiveTools: (names: string[]) => { active = [...names]; },
        getAllTools: () => [...registered.values()].map((t) => ({ name: t.name, description: t.description })),
      } as never,
    };
  }

  /** A team session whose runtime reports the given MCP descriptors, plus the config spy. */
  async function teamSessionWithMcp(
    descriptors = MCP_DESCRIPTORS,
    flags = { browser: false, team: true },
    messages: ExtensionToWebviewMessage[] = [],
  ) {
    const cfg = vi.spyOn(vscode.workspace, 'getConfiguration');
    cfg.mockImplementation(((section?: string) => ({
      get: (key: string, def?: unknown) => {
        if (section === 'damocles.browser' && key === 'enabled') return flags.browser;
        if (section === 'damocles' && key === 'team.enabled') return flags.team;
        return def;
      },
      update: () => Promise.resolve(),
    })) as unknown as typeof vscode.workspace.getConfiguration);

    const opts = makeOptions(messages);
    opts.teamService = { dispose: () => {}, cancelActiveTeam: () => {} } as never;
    const session = new PiSession(opts);
    await session.initializeEarly();

    const runtime = PiRuntime.get('/cwd', '/fake/agent');
    let live = [...descriptors];
    vi.spyOn(runtime, 'getMcpClientManager').mockReturnValue({
      allToolNames: () => live.map((d) => d.piName),
      getServerStatuses: () => [],
      getAllToolDescriptors: () => [...live],
      getToolDescriptor: (piName: string) => live.find((d) => d.piName === piName),
      callTool: mcpCallTool,
    } as unknown as ReturnType<typeof runtime.getMcpClientManager>);

    return { session, cfg, setDescriptors: (next: typeof descriptors) => { live = [...next]; } };
  }

  const teamCtx = (agentId: string) => ({
    agentId,
    browserScopeId: `${agentId}#1`,
    agentName: 'specialist',
    teamId: 'team-1',
    role: 'specialist' as const,
  }) as never;

  const mcpNamesOf = (names: readonly string[]): string[] => names.filter((n) => n.startsWith('mcp__')).sort();

  it('criterion 1: the mcp__* names in `tools:` are SET-EQUAL to those in `customTools`', async () => {
    // §8's first bullet, at the team seam — the failure mode that shipped: team agents already passed
    // `mcp__*` names in `tools:` into a registry with no matching definitions, and pi dropped them
    // SILENTLY. Set equality in both directions is the only thing that catches it.
    const { session, cfg } = await teamSessionWithMcp();
    const engine = session.buildTeamEngine();

    const { toolNames, customTools, mcp } = engine.buildAgentToolset(teamCtx('agent-1'));
    const tools = [...toolNames, ...mcp.names]; // exactly what `team-runner.ts` composes

    expect(mcpNamesOf(tools)).toEqual(['mcp__git__commit', 'mcp__git__status']);
    expect(new Set(mcpNamesOf(tools))).toEqual(new Set(mcpNamesOf(customTools.map((t) => t.name))));
    expect(mcpNamesOf(tools)).toEqual(mcpNamesOf(customTools.map((t) => t.name)));
    // `teamAgentToolNames()` must NOT also carry them, or every MCP name lands in `tools:` twice and
    // pi's `setActiveToolsByName` (one definition per occurrence, no de-dup) makes the provider reject
    // the whole request.
    expect(mcpNamesOf(toolNames)).toEqual([]);
    expect(tools).toHaveLength(new Set(tools).size);

    cfg.mockRestore();
    await session.dispose();
  });

  it('criterion 3: the nested ToolSearch advertises the agent MCP tools with their blurbs', async () => {
    const { session, cfg } = await teamSessionWithMcp();
    const engine = session.buildTeamEngine();
    const { mcp } = engine.buildAgentToolset(teamCtx('agent-1'));
    const nested = nestedTeamPi([TOOL_TOOL_SEARCH, ...TEAM_AGENT_PI_TOOL_NAMES]);

    engine.buildExtensionFactory('specialist', 'agent-1', mcp)(nested.api);

    const tool = nested.registered.get(TOOL_TOOL_SEARCH);
    expect(tool, 'a team specialist with MCP tools must get a ToolSearch to load them').toBeDefined();
    expect(tool!.description).toContain('git (2): mcp__git__status — Show the working tree status; mcp__git__commit — Create a commit');

    cfg.mockRestore();
    await session.dispose();
  });

  it('criterion 4: `{tools:["git"]}` activates the specialist git tools, additively, and they EXECUTE', async () => {
    const { session, cfg } = await teamSessionWithMcp();
    const engine = session.buildTeamEngine();
    const { mcp } = engine.buildAgentToolset(teamCtx('agent-1'));
    // The deferred baseline a real team spawn writes: coordination tools active, MCP held back.
    const baseline = ['read', 'Edit', TOOL_TOOL_SEARCH, ...TEAM_AGENT_PI_TOOL_NAMES];
    const nested = nestedTeamPi(baseline);
    engine.buildExtensionFactory('specialist', 'agent-1', mcp)(nested.api);
    for (const tool of mcp.tools) nested.api.registerTool(tool as never); // pi merges customTools likewise

    const tool = nested.registered.get(TOOL_TOOL_SEARCH)!;
    const result = (await tool.execute('tc-1', { tools: ['git'] }, undefined, undefined, teamExecCtx) as never) as {
      details?: { matches: string[] };
    };

    expect([...(result.details?.matches ?? [])].sort()).toEqual(['mcp__git__commit', 'mcp__git__status']);
    const after = nested.active();
    for (const n of mcp.names) expect(after, n).toContain(n);
    for (const n of baseline) expect(after, n).toContain(n); // strict superset — §4.5
    expect(after.length).toBeGreaterThan(baseline.length);

    // …and the activated tool is genuinely callable: it reaches `McpClientManager.callTool`.
    mcpCallTool.mockClear();
    const definition = nested.registered.get('mcp__git__commit')!;
    const controller = new AbortController();
    const callResult = (await definition.execute('tc-2', { message: 'ship it' } as never, controller.signal as never, undefined as never, {} as never)) as {
      content: Array<{ type: string; text?: string }>;
    };
    expect(mcpCallTool).toHaveBeenCalledTimes(1);
    expect(mcpCallTool.mock.calls[0]![0]).toBe('mcp__git__commit');
    expect(mcpCallTool.mock.calls[0]![1]).toEqual({ message: 'ship it' });
    expect((mcpCallTool.mock.calls[0]![2] as { signal?: AbortSignal }).signal).toBe(controller.signal);
    expect(callResult.content).toEqual([{ type: 'text', text: 'result of mcp__git__commit' }]);

    cfg.mockRestore();
    await session.dispose();
  });

  it('criterion 14: every team_* tool is ACTIVE from turn one while the MCP tools are deferred', async () => {
    // A specialist must be able to post to the scratchpad on its first step. `deferredToolNames`
    // intersects with browser ∪ compass ∪ web ∪ mcp, so no `team_*` name can be deferrable — no special
    // case, which is exactly what this pins. The MCP half is asserted in the SAME test so the two
    // cannot drift: "team tools active" alone is satisfied by not deferring anything at all.
    const { session, cfg } = await teamSessionWithMcp();
    const engine = session.buildTeamEngine();
    const { toolNames, mcp } = engine.buildAgentToolset(teamCtx('agent-1'));
    const eligible = [...toolNames, ...mcp.names];

    const deferrable = deferredToolNames(eligible, mcp.names);
    for (const n of TEAM_AGENT_PI_TOOL_NAMES) expect(deferrable, n).not.toContain(n);
    for (const n of mcp.names) expect(deferrable, n).toContain(n);

    // The baseline the runtime writes = eligible minus deferrable. Asserted as the real derivation.
    const baseline = eligible.filter((n) => !deferrable.includes(n));
    for (const n of TEAM_AGENT_PI_TOOL_NAMES) expect(baseline, n).toContain(n);
    for (const n of mcp.names) expect(baseline, n).not.toContain(n);
    expect(baseline).toContain(TOOL_TOOL_SEARCH);

    cfg.mockRestore();
    await session.dispose();
  });

  it('criterion 14: a specialist cannot activate a team_* tool through ToolSearch (never deferrable)', async () => {
    const { session, cfg } = await teamSessionWithMcp();
    const engine = session.buildTeamEngine();
    const { mcp } = engine.buildAgentToolset(teamCtx('agent-1'));
    const nested = nestedTeamPi([TOOL_TOOL_SEARCH, ...TEAM_AGENT_PI_TOOL_NAMES]);
    engine.buildExtensionFactory('specialist', 'agent-1', mcp)(nested.api);

    const tool = nested.registered.get(TOOL_TOOL_SEARCH)!;
    const result = (await tool.execute('tc-1', { tools: [TEAM_AGENT_PI_TOOL_NAMES[0]!] }, undefined, undefined, teamExecCtx) as never) as {
      details?: { matches: string[] };
      content: Array<{ text: string }>;
    };

    expect(result.details?.matches).toEqual([]);
    expect(result.content[0].text).toMatch(/Unknown entries/);

    cfg.mockRestore();
    await session.dispose();
  });

  it('criterion 8: the specialist MCP set equals the panel eligible MCP set — uniform with subagents', async () => {
    // The team half of the uniformity claim. `buildNestedMcp` derives `eligible` from
    // `fullActiveToolNames()`, the SAME single read the `Agent`-tool subagent path uses, so "identical
    // set for the same panel state" is a property of that shared derivation rather than a coincidence
    // of two hand-maintained lists. (The Explore / general-purpose / read-only-user-agent three-way
    // comparison is in `subagents/__tests__/agent-manager.test.ts`.)
    const { session, cfg } = await teamSessionWithMcp();
    const engine = session.buildTeamEngine();

    const specialist = engine.buildAgentToolset(teamCtx('agent-1'));
    const lead = engine.buildAgentToolset(teamCtx('agent-2'));

    expect(mcpNamesOf(specialist.mcp.names)).toEqual(['mcp__git__commit', 'mcp__git__status']);
    expect(mcpNamesOf(lead.mcp.names)).toEqual(mcpNamesOf(specialist.mcp.names));
    // The gate classifier is the frozen one and agrees across agents built from the same panel state.
    expect(specialist.mcp.isReadOnly('mcp__git__status')).toBe(true);
    expect(specialist.mcp.isReadOnly('mcp__git__commit')).toBe(false);
    expect(lead.mcp.isReadOnly('mcp__git__status')).toBe(true);

    cfg.mockRestore();
    await session.dispose();
  });

  it('criterion 8, three ways: Explore, general-purpose and a team specialist get the IDENTICAL set', async () => {
    // The full uniformity claim, both spawn paths in ONE session so "the same panel state" is literal
    // rather than reconstructed. The subagent engine is private, so it is reached through the instance —
    // deliberately, because the alternative is re-deriving `buildNestedMcp` in the test, which would
    // compare the test's arithmetic against itself instead of the two production paths against each
    // other. `resolveAgentToolset` supplies each agent's REAL `mcpDisallowed` (none of these deny one).
    const { session, cfg } = await teamSessionWithMcp();
    const teamEngine = session.buildTeamEngine();
    const subagentEngine = (session as unknown as {
      buildSubagentEngine: (pi: unknown) => { buildAgentToolset: (i: { agentId: string; agentName: string; mcpDisallowed: ReadonlySet<string> }) => { mcp: { names: string[] } } };
    }).buildSubagentEngine(getPiCodingAgent() as never);

    const parent = (session as unknown as { fullActiveToolNames: () => string[] }).fullActiveToolNames();
    const explore = resolveAgentToolset(DEFAULT_AGENTS.get('Explore')!, parent);
    const general = resolveAgentToolset(DEFAULT_AGENTS.get('general-purpose')!, parent);
    // Precondition that makes this the uniformity case rather than two lookalikes: Explore uses an
    // EXPLICIT `tools:` list and holds no write tool; general-purpose is `tools: *` and holds one.
    expect(explore.names).not.toContain('Edit');
    expect(general.names).toContain('Edit');
    expect(explore.readOnly).toBe(true);

    const exploreMcp = subagentEngine.buildAgentToolset({ agentId: 'a1', agentName: 'Explore', mcpDisallowed: explore.mcpDisallowed }).mcp.names;
    const generalMcp = subagentEngine.buildAgentToolset({ agentId: 'a2', agentName: 'general-purpose', mcpDisallowed: general.mcpDisallowed }).mcp.names;
    const specialistMcp = teamEngine.buildAgentToolset(teamCtx('agent-3')).mcp.names;

    const expected = ['mcp__git__commit', 'mcp__git__status'];
    expect([...exploreMcp].sort()).toEqual(expected);
    expect([...generalMcp].sort()).toEqual(expected);
    expect([...specialistMcp].sort()).toEqual(expected);
    expect(new Set(exploreMcp)).toEqual(new Set(specialistMcp));
    expect(new Set(generalMcp)).toEqual(new Set(specialistMcp));

    cfg.mockRestore();
    await session.dispose();
  });

  it('criterion 1, SUBAGENT path: the engine puts the snapshot`s definitions into customTools', async () => {
    // The one link `agent-manager.test.ts` cannot cover: its fake REPLACES `buildAgentToolset` with its
    // own re-implementation, so the real `[...buildSubagentCustomTools(...), ...mcp.tools]` in
    // `buildSubagentEngine` is never executed there. Deleting `...mcp.tools` used to leave the entire
    // repo green while every `Agent`-tool subagent got `mcp__*` names in `tools:` with no definitions
    // behind them — which pi drops SILENTLY. Asserted on the ENGINE's own output, at the composition
    // site, because that is the expression that can regress. (The team path has the same assertion.)
    const { session, cfg } = await teamSessionWithMcp();
    const subagentEngine = (session as unknown as {
      buildSubagentEngine: (pi: unknown) => {
        buildAgentToolset: (i: { agentId: string; agentName: string; mcpDisallowed: ReadonlySet<string> }) => {
          customTools: { name: string }[];
          mcp: { names: readonly string[] };
        };
      };
    }).buildSubagentEngine(getPiCodingAgent() as never);

    const { customTools, mcp } = subagentEngine.buildAgentToolset({
      agentId: 'a1',
      agentName: 'general-purpose',
      mcpDisallowed: new Set<string>(),
    });
    const built = customTools.map((t) => t.name);

    expect([...mcp.names].sort()).toEqual(['mcp__git__commit', 'mcp__git__status']); // not vacuous
    expect(built).toEqual(expect.arrayContaining([...mcp.names]));
    // And the non-MCP half is still there: appending must not have replaced the agent's own tools.
    expect(built).toContain(TOOL_EDIT);

    cfg.mockRestore();
    await session.dispose();
  });

  it('criterion 15: `damocles.mcp.enabled = false` removes MCP from a team specialist too', async () => {
    // Through `fullActiveToolNames()` — the single gate (`tool-status.ts:65` already does
    // `...(mcpEnabled ? mcpToolNames : [])`). `buildNestedMcp` adds no second check, deliberately, so
    // this is the one place the switch has to work and the only place it is asserted.
    const cfg = vi.spyOn(vscode.workspace, 'getConfiguration');
    let mcpEnabled = true;
    cfg.mockImplementation(((section?: string) => ({
      get: (key: string, def?: unknown) => {
        if (section === 'damocles.mcp' && key === 'enabled') return mcpEnabled;
        if (section === 'damocles' && key === 'team.enabled') return true;
        if (section === 'damocles.browser' && key === 'enabled') return false;
        return def;
      },
      update: () => Promise.resolve(),
    })) as unknown as typeof vscode.workspace.getConfiguration);

    const opts = makeOptions([]);
    opts.teamService = { dispose: () => {}, cancelActiveTeam: () => {} } as never;
    const session = new PiSession(opts);
    await session.initializeEarly();
    const runtime = PiRuntime.get('/cwd', '/fake/agent');
    vi.spyOn(runtime, 'getMcpClientManager').mockReturnValue({
      allToolNames: () => MCP_DESCRIPTORS.map((d) => d.piName),
      getServerStatuses: () => [],
      getAllToolDescriptors: () => [...MCP_DESCRIPTORS],
      getToolDescriptor: (piName: string) => MCP_DESCRIPTORS.find((d) => d.piName === piName),
      callTool: mcpCallTool,
    } as unknown as ReturnType<typeof runtime.getMcpClientManager>);

    const engine = session.buildTeamEngine(); // ONE engine, built before the toggle
    const on = engine.buildAgentToolset(teamCtx('agent-1'));
    expect(mcpNamesOf(on.mcp.names)).toEqual(['mcp__git__commit', 'mcp__git__status']); // precondition

    mcpEnabled = false; // the user turns MCP off mid-run

    const off = engine.buildAgentToolset(teamCtx('agent-2'));
    expect(off.mcp.names).toEqual([]);
    expect(off.mcp.tools).toEqual([]);
    expect(mcpNamesOf(off.customTools.map((t) => t.name))).toEqual([]);
    // …and the earlier agent's frozen snapshot is untouched: the change reaches the NEXT spawn only.
    expect(mcpNamesOf(on.mcp.names)).toEqual(['mcp__git__commit', 'mcp__git__status']);

    cfg.mockRestore();
    await session.dispose();
  });

  it('criterion 15 / §4.6: ONE engine, TWO spawns across an MCP change — the second gets the NEWER set', async () => {
    // The derivation must live INSIDE the per-spawn arrow. An implementation that hoisted the snapshot
    // to `buildTeamEngine()` time would pass every single-spawn assertion above and fail only this one.
    const { session, cfg, setDescriptors } = await teamSessionWithMcp([MCP_DESCRIPTORS[0]!]);
    const engine = session.buildTeamEngine(); // built ONCE, before the change

    const first = engine.buildAgentToolset(teamCtx('agent-1'));
    expect(mcpNamesOf(first.mcp.names)).toEqual(['mcp__git__status']);

    setDescriptors(MCP_DESCRIPTORS); // a server advertises a second tool

    const second = engine.buildAgentToolset(teamCtx('agent-2'));
    expect(mcpNamesOf(second.mcp.names)).toEqual(['mcp__git__commit', 'mcp__git__status']);
    expect(mcpNamesOf(second.customTools.map((t) => t.name))).toEqual(['mcp__git__commit', 'mcp__git__status']);
    // Frozen at spawn: the first agent never sees the new tool.
    expect(mcpNamesOf(first.mcp.names)).toEqual(['mcp__git__status']);

    cfg.mockRestore();
    await session.dispose();
  });

  it('a workspace with NO MCP manager yields the empty snapshot and no MCP anywhere (no throw)', async () => {
    const cfg = vi.spyOn(vscode.workspace, 'getConfiguration');
    cfg.mockImplementation(((section?: string) => ({
      get: (key: string, def?: unknown) => (section === 'damocles' && key === 'team.enabled' ? true : def),
      update: () => Promise.resolve(),
    })) as unknown as typeof vscode.workspace.getConfiguration);
    const opts = makeOptions([]);
    opts.teamService = { dispose: () => {}, cancelActiveTeam: () => {} } as never;
    const session = new PiSession(opts);
    await session.initializeEarly();
    const runtime = PiRuntime.get('/cwd', '/fake/agent');
    vi.spyOn(runtime, 'getMcpClientManager').mockReturnValue(null as never);

    const engine = session.buildTeamEngine();
    let built!: ReturnType<typeof engine.buildAgentToolset>;
    expect(() => { built = engine.buildAgentToolset(teamCtx('agent-1')); }).not.toThrow();

    expect(built.mcp.names).toEqual([]);
    expect(built.mcp.tools).toEqual([]);
    expect(built.mcp.isReadOnly('mcp__git__status')).toBe(false);
    expect(mcpNamesOf(built.toolNames)).toEqual([]);
    // The team_* tools are still there — no MCP must never mean no team agent.
    for (const n of TEAM_AGENT_PI_TOOL_NAMES) expect(built.customTools.map((t) => t.name), n).toContain(n);

    cfg.mockRestore();
    await session.dispose();
  });

  /**
   * Slice 2 — the spawn seam. A team agent's MCP tools must be handed the PARENT panel's bridge,
   * attributed to that agent, and that bridge must be reachable again at teardown and at dispose.
   * Asserted through the real `PiSession`, because "who is this dialog for?" is decided here.
   */
  const uiRequests = (messages: ExtensionToWebviewMessage[]) =>
    messages.filter((m): m is Extract<ExtensionToWebviewMessage, { type: 'extensionUiRequest' }> => m.type === 'extensionUiRequest');
  const uiCancels = (messages: ExtensionToWebviewMessage[]) =>
    messages.filter((m): m is Extract<ExtensionToWebviewMessage, { type: 'extensionUiCancel' }> => m.type === 'extensionUiCancel');
  /** pi's own shape for an UNBOUND session: a TRUTHY ui whose select resolves undefined, hasUI false. */
  const unboundCtx = { ui: { select: async () => undefined, input: async () => undefined, notify: () => {} }, hasUI: false };

  async function openNestedDialog(agentId: string) {
    const messages: ExtensionToWebviewMessage[] = [];
    const { session, cfg } = await teamSessionWithMcp(MCP_DESCRIPTORS, { browser: false, team: true }, messages);
    const engine = session.buildTeamEngine();
    const { customTools } = engine.buildAgentToolset(teamCtx(agentId));
    const status = customTools.find((t) => t.name === 'mcp__git__status')!;

    await (status.execute as unknown as (
      id: string, p: unknown, s: undefined, u: undefined, c: unknown,
    ) => Promise<unknown>)('tc-1', {}, undefined, undefined, unboundCtx);

    const opts = mcpCallTool.mock.calls.at(-1)![2] as { elicitationUi?: { select: (t: string, o: string[]) => Promise<string | undefined> } };
    // The agent's tools got a bridge even though pi handed them a no-op UI — the whole point.
    expect('elicitationUi' in opts).toBe(true);
    const pending = opts.elicitationUi!.select('MCP Input Request', ['Continue', 'Decline']);
    return { session, cfg, engine, messages, pending };
  }

  it('Slice 2 criterion 1: a specialist MCP elicitation reaches the PARENT panel, attributed', async () => {
    const { session, cfg, messages, pending } = await openNestedDialog('agent-1');

    expect(uiRequests(messages)).toHaveLength(1);
    expect(uiRequests(messages)[0]).toMatchObject({ agentId: 'agent-1', agentName: 'specialist', teamId: 'team-1' });

    // …and the panel answers it through the SAME `resolve` the webview response path uses.
    session.resolveExtensionUiResponse(uiRequests(messages)[0]!.requestId, 'Continue');
    await expect(pending).resolves.toBe('Continue');

    cfg.mockRestore();
    await session.dispose();
  });

  it('Slice 2 criterion 5: the engine teardown hook withdraws that agent dialog', async () => {
    const { session, cfg, engine, messages, pending } = await openNestedDialog('agent-1');
    const requestId = uiRequests(messages)[0]!.requestId;

    engine.cancelAgentDialogs('agent-1');

    expect(uiCancels(messages).map((m) => m.requestId)).toEqual([requestId]);
    await expect(pending).resolves.toBeUndefined(); // the awaiting MCP call is released, not hung

    cfg.mockRestore();
    await session.dispose();
  });

  it('Slice 2 criterion 6 (G5): disposing the panel cancels an in-flight NESTED dialog', async () => {
    // The teardown path that gets forgotten. `dispose()` already cancelled the panel's own dialogs;
    // nested ones live in the same map and must go with them — and the webview must be told.
    const { session, cfg, messages, pending } = await openNestedDialog('agent-1');
    const requestId = uiRequests(messages)[0]!.requestId;

    await session.dispose();

    expect(uiCancels(messages).map((m) => m.requestId)).toEqual([requestId]);
    await expect(pending).resolves.toBeUndefined();

    cfg.mockRestore();
  });
});

describe('PiSession auto-title — no write through a session replaced mid-completion (US-012)', () => {
  beforeEach(() => {
    H.seq.length = 0;
    H.captured.services.length = 0;
    H.resetServices();
    TITLE.impl = async () => null;
  });
  afterEach(async () => {
    TITLE.impl = async () => null;
    await PiRuntime.disposeInstance();
  });

  /** A title sub-call the test settles by hand, so the replacement lands inside the async window. */
  function deferredTitle(): { resolve: (title: string) => void } {
    let release!: (title: string) => void;
    const pending = new Promise<string>((r) => { release = r; });
    TITLE.impl = () => pending;
    return { resolve: (title) => release(title) };
  }

  it('names the session when it is still the live one', async () => {
    const session = new PiSession(makeOptions([]));
    await session.initializeEarly();
    const gate = deferredTitle();

    await session.sendMessage('go', undefined, 'c1', { content: 'go' });
    const live = H.getLastSession()!;
    gate.resolve('Fix The Parser');
    await new Promise((r) => setTimeout(r, 0));

    expect(live.setSessionName).toHaveBeenCalledWith('Fix The Parser');
    await session.dispose();
  });

  it('drops the title when a reset replaced the session during the completion', async () => {
    // The resurrection bug: reset()/delete disposes the old AgentSession and its file is removed, but
    // its SessionManager still believes it flushed — so a late setSessionName() appends past the rm and
    // recreates the file holding only that `session_info` line, which no reader can parse afterwards.
    const session = new PiSession(makeOptions([]));
    await session.initializeEarly();
    const gate = deferredTitle();

    await session.sendMessage('go', undefined, 'c1', { content: 'go' });
    const first = H.getLastSession()!;

    session.reset();
    await session.whenReplaced();
    expect(H.getLastSession()).not.toBe(first);

    gate.resolve('Fix The Parser');
    await new Promise((r) => setTimeout(r, 0));

    expect(first.setSessionName).not.toHaveBeenCalled();
    await session.dispose();
  });

  it('detachFromDeletedSession replaces the session and clears its OWN webview', async () => {
    // The panel that owns a deleted session is often not the one the user clicked in, so the clear
    // has to go out through this panel's own message sink, not the deleting panel's host.
    const messages: ExtensionToWebviewMessage[] = [];
    const session = new PiSession(makeOptions(messages));
    await session.initializeEarly();
    const first = H.getLastSession();

    await session.detachFromDeletedSession();

    // Resolved only once the replacement is installed — the old manager can no longer append, which is
    // what makes the subsequent rm safe.
    expect(H.getLastSession()).not.toBe(first);
    expect(messages.filter((m) => m.type === 'sessionCleared')).toHaveLength(1);
    expect(messages.filter((m) => m.type === 'processing' && !m.isProcessing)).toHaveLength(1);
    await session.dispose();
  });

  it('drops the title when the panel was disposed during the completion', async () => {
    const session = new PiSession(makeOptions([]));
    await session.initializeEarly();
    const gate = deferredTitle();

    await session.sendMessage('go', undefined, 'c1', { content: 'go' });
    const live = H.getLastSession()!;

    await session.dispose();
    gate.resolve('Fix The Parser');
    await new Promise((r) => setTimeout(r, 0));

    expect(live.setSessionName).not.toHaveBeenCalled();
  });
});

describe('PiSession — the on-disk invariant, against a REAL pi SessionManager', () => {
  // The mocked harness can only prove the guard is reached. These drive the actual dependency on a
  // tmpdir, so what is asserted is the thing that matters: no file is recreated after the rm.
  let dir: string;

  beforeEach(() => {
    H.seq.length = 0;
    H.captured.services.length = 0;
    H.resetServices();
    TITLE.impl = async () => null;
    dir = fsSync.mkdtempSync(path.join(os.tmpdir(), 'damocles-session-'));
  });
  afterEach(async () => {
    H.setSessionManagerFactory(null);
    TITLE.impl = async () => null;
    await PiRuntime.disposeInstance();
    fsSync.rmSync(dir, { recursive: true, force: true });
  });

  async function seededManager(): Promise<{ sm: { getSessionFile(): string | undefined }; file: string }> {
    const pi = await import('@earendil-works/pi-coding-agent');
    const sm = pi.SessionManager.create('/cwd', dir);
    // pi buffers until an assistant message exists; this pair is what flips it to flushed = true and
    // puts the file on disk, which is the precondition for the resurrection.
    sm.appendMessage({ role: 'user', content: 'hello world' } as never);
    sm.appendMessage({ role: 'assistant', content: [{ type: 'text', text: 'doing it' }] } as never);
    return { sm, file: sm.getSessionFile()! };
  }

  it('characterises the hazard: pi appends to a path it no longer has, recreating it unreadable', async () => {
    // Not a test of our code — a pin on the dependency behaviour the guards exist for. If pi ever
    // makes `_persist` re-check the file, this fails and the guards can be reconsidered.
    const pi = await import('@earendil-works/pi-coding-agent');
    const { sm, file } = await seededManager();
    expect(fsSync.existsSync(file)).toBe(true);

    fsSync.rmSync(file);
    (sm as unknown as { appendSessionInfo(n: string): void }).appendSessionInfo('Late Title');

    expect(fsSync.existsSync(file)).toBe(true);
    const lines = fsSync.readFileSync(file, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!).type).toBe('session_info');
    // …and that one-liner is what poisons every later read of the store.
    expect(() => pi.SessionManager.open(file, dir)).toThrow(/not a valid pi session/);
  });

  it('a title landing after the file was deleted does NOT recreate it', async () => {
    const { file } = await seededManager();
    // The panel's live session opens that same real file, so its writes are real writes.
    const pi = await import('@earendil-works/pi-coding-agent');
    H.setSessionManagerFactory(() => pi.SessionManager.open(file, dir));

    let release!: (t: string) => void;
    TITLE.impl = () => new Promise<string>((r) => { release = r; });

    const session = new PiSession(makeOptions([]));
    await session.initializeEarly();
    const live = H.getLastSession()!;
    expect(live.sessionManager.getSessionFile()).toBe(file);

    await session.sendMessage('go', undefined, 'c1', { content: 'go' });

    // The delete path, in order: every holder detaches, THEN the file goes.
    await session.detachFromDeletedSession();
    fsSync.rmSync(file);

    release('Fix The Parser');
    await new Promise((r) => setTimeout(r, 0));

    expect(fsSync.existsSync(file)).toBe(false);
    await session.dispose();
  });
});

describe('PiSession session-replacement contract (what a destructive delete is sequenced off)', () => {
  beforeEach(() => {
    H.seq.length = 0;
    H.captured.services.length = 0;
    H.resetServices();
  });
  afterEach(async () => {
    await PiRuntime.disposeInstance();
  });

  const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

  /** Park the next runtime build so a panel can be observed while `start()` is still in flight. */
  function parkNextStart(): { release: () => void } {
    const base = H.fakePi.createAgentSessionRuntime.getMockImplementation()!;
    let release!: () => void;
    const parked = new Promise<void>((r) => { release = r; });
    H.fakePi.createAgentSessionRuntime.mockImplementationOnce(async (...args: unknown[]) => {
      await parked;
      return (base as (...a: unknown[]) => unknown)(...args);
    });
    return { release };
  }

  it('detach waits for an in-flight start(), so a resuming panel really lets go', async () => {
    // The gap this closes: mid-`start()` there is no runtime, so reset() bails and whenReplaced()
    // resolves at once — while start() goes on to open a manager on the path about to be removed.
    const gate = parkNextStart();
    const session = new PiSession(makeOptions([]));
    const starting = session.initializeEarly();
    await tick();

    const detaching = session.detachFromDeletedSession();
    gate.release();
    await detaching;
    await starting;

    // Two binds: the one start() made, and the replacement that detach forced. Without the wait there
    // is only start()'s, and the panel is left live on the deleted file.
    expect(H.seq.filter((s) => s === 'subscribe')).toHaveLength(2);
  });

  it('whenReplaced() rejects when the replacement threw — the old session is still installed', async () => {
    const session = new PiSession(makeOptions([]));
    await session.initializeEarly();
    const runtime = (session as unknown as { runtime: { newSession: () => Promise<unknown> } }).runtime;
    const good = runtime.newSession.bind(runtime);
    runtime.newSession = async () => { throw new Error('factory boom'); };

    await expect(session.detachFromDeletedSession()).rejects.toThrow('factory boom');

    // …and one failure must not poison every later replacement (the chain re-serialises, it doesn't
    // inherit the rejection).
    runtime.newSession = good;
    session.reset();
    await expect(session.whenReplaced()).resolves.toBeUndefined();
    await session.dispose();
  });

  it('whenReplaced() rejects when a before-switch handler cancelled the replacement', async () => {
    // pi returns `{ cancelled: true }` WITHOUT tearing the old session down. Reported as success, that
    // is a live writer plus a deleted file.
    const session = new PiSession(makeOptions([]));
    await session.initializeEarly();
    const runtime = (session as unknown as { runtime: { newSession: () => Promise<unknown> } }).runtime;
    runtime.newSession = async () => ({ cancelled: true });

    await expect(session.detachFromDeletedSession()).rejects.toThrow(/cancelled/);
    await session.dispose();
  });
});
