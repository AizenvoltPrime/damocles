import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { SessionOptions } from '../../session-types';
import type { ExtensionToWebviewMessage } from '../../../shared/types/messages';
import type { CanUseToolContext } from '../../permission-handler/types';
import type { FinishTurn } from '@earendil-works/pi-agent-core';
import { readFileSync } from 'node:fs';
import { backendSourceFiles } from '../../../__mocks__/source-tree';

/**
 * Session state (`sessionStateChanged`), end to end through the real publisher.
 *
 * What is real here: `PiSession`, its `PiStreamAdapter`, a real `PermissionHandler` with its five
 * pending-prompt maps and every manager that mutates them, and the real `WebviewExtensionUIContext`
 * including the per-agent `forAgent` bridge. What is faked is pi itself (the loader, the session and
 * the runtime), the same seam `pi-session.test.ts` fakes.
 *
 * The sequences asserted here are exact arrays. A test that only checks that `requires_action` appears
 * somewhere passes when the state never returns to `running`, which is the ordering bug this covers.
 */

const H = vi.hoisted(() => {
  let sessionCounter = 0;
  let lastSession: ReturnType<typeof makeFakeSession> | null = null;

  function makeFakeSession() {
    const id = `sess-${++sessionCounter}`;
    const sessionManager = {
      getSessionName: vi.fn((): string | undefined => undefined),
      appendSessionInfo: vi.fn(() => 'info-1'),
      getLeafId: vi.fn(() => 'leaf-1'),
      getBranch: vi.fn(() => [{ type: 'message', id: 'u1', message: { role: 'user', content: 'hello' } }]),
      getEntry: vi.fn(() => undefined as unknown),
      getSessionFile: vi.fn(() => undefined as string | undefined),
      getEntries: vi.fn(() => [] as unknown[]),
      getHeader: vi.fn(() => null),
      appendCustomEntry: vi.fn(() => 'custom-1'),
    };
    // pi keeps every subscriber: the stream adapter and the unpersisted tool image cache both listen.
    const listeners = new Set<(event: unknown) => void>();
    const session = {
      listeners,
      sessionId: id,
      agent: {} as { finishTurn?: FinishTurn },
      isStreaming: false,
      isCompacting: false,
      get isIdle() { return !this.isStreaming; },
      modelRuntime: { getModel: () => undefined },
      subscribe: vi.fn((l: (event: unknown) => void) => { listeners.add(l); return () => { listeners.delete(l); }; }),
      setAutoCompactionEnabled: vi.fn(),
      abortCompaction: vi.fn(),
      setActiveToolsByName: vi.fn(),
      getActiveToolNames: vi.fn(() => ['read']),
      getAllTools: vi.fn(() => [{ name: 'read' }]),
      reload: vi.fn(async () => undefined),
      bindExtensions: vi.fn(async () => undefined),
      setThinkingLevel: vi.fn(),
      prompt: vi.fn(async () => undefined),
      clearQueue: vi.fn(() => ({ steering: [], followUp: [] })),
      abort: vi.fn(async () => undefined),
      setModel: vi.fn(async () => undefined),
      getSessionStats: vi.fn(() => ({ sessionId: id, cost: 0, tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, total: 2 } })),
      getLastAssistantText: vi.fn(() => 'done'),
      getContextUsage: vi.fn(() => ({ tokens: 10, contextWindow: 1_000_000, percent: 0 })),
      get systemPrompt() { return 'prompt'; },
      setSessionName: vi.fn(),
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
        setCompactionEnabled: vi.fn(),
        setCacheWarmingMode: vi.fn(),
        applyOverrides: vi.fn(),
        getCompactionSettings: vi.fn(() => ({ enabled: false, reserveTokens: 16384, keepRecentTokens: 20000 })),
        getGlobalSettings: vi.fn(() => ({})),
        getProjectSettings: vi.fn(() => ({})),
        getPackages: vi.fn(() => []),
        getShellCommandPrefix: vi.fn(() => undefined),
        getShellPath: vi.fn(() => undefined),
        isProjectTrusted: vi.fn(() => true),
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
        getPrompts: vi.fn(() => ({ prompts: [], diagnostics: [] })),
        getSkills: vi.fn(() => ({ skills: [], diagnostics: [] })),
        getAgentsFiles: vi.fn(() => ({ agentsFiles: [] })),
      },
      diagnostics: [],
    };
  }

  let services = makeServices();

  const fakePi = {
    createAgentSessionServices: vi.fn(async () => services),
    createAgentSessionFromServices: vi.fn(async () => ({ session: makeFakeSession() })),
    createAgentSessionRuntime: vi.fn(async (factory: (o: { sessionManager: unknown; cwd: string; agentDir: string }) => Promise<{ session: unknown }>, opts: { cwd: string; agentDir: string; sessionManager: unknown }) => {
      let current = (await factory({ ...opts })).session;
      let before: (() => void) | undefined;
      let rebind: ((s: unknown) => Promise<void>) | undefined;
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
        dispose: async () => undefined,
      };
    }),
    SessionManager: { create: vi.fn(() => ({ kind: 'persistent', getBranch: () => [] })), inMemory: vi.fn(() => ({ kind: 'memory' })) },
    SettingsManager: { inMemory: vi.fn(() => ({ kind: 'settings' })), create: vi.fn(() => ({ kind: 'settings' })) },
    ModelRuntime: { create: vi.fn(async () => services.modelRuntime) },
    DefaultPackageManager: class { getInstalledPath(): string | undefined { return undefined; } },
    defineTool: vi.fn((tool: unknown) => tool),
    createEditToolDefinition: vi.fn(() => ({ execute: vi.fn(async () => ({ content: [], details: undefined })) })),
    createBashToolDefinition: vi.fn(() => ({ name: 'bash', label: 'Bash', description: 'pi bash', parameters: {}, execute: vi.fn(async () => ({ content: [], details: undefined })) })),
    createPowerShellToolDefinition: vi.fn(() => ({ name: 'powershell', label: 'powershell', description: 'pi powershell', parameters: {}, execute: vi.fn(async () => ({ content: [], details: undefined })) })),
    createGrepToolDefinition: vi.fn(() => ({ name: 'grep', label: 'grep', description: 'pi grep', parameters: {}, execute: vi.fn() })),
    createFindToolDefinition: vi.fn(() => ({ name: 'find', label: 'find', description: 'pi find', parameters: {}, execute: vi.fn() })),
    createWriteToolDefinition: vi.fn(() => ({ name: 'write', label: 'write', description: 'pi write', parameters: {}, execute: vi.fn() })),
  };

  return {
    fakePi,
    resetServices: () => { services = makeServices(); },
    getLastSession: () => lastSession,
    fireEvent: (event: unknown) => { for (const l of [...(lastSession?.listeners ?? [])]) l(event); },
  };
});

vi.mock('../pi-loader', () => ({
  initPiLoader: vi.fn(async () => H.fakePi),
  getPiCodingAgent: vi.fn(() => H.fakePi),
  PI_MIN_NODE_MAJOR: 22,
  nodeSupportsPi: () => true,
}));

vi.mock('../session-title', () => ({ generateSessionTitle: async () => null }));

vi.mock('../tools/process-tree', () => ({
  createShellSessionJob: () => ({ dispose: () => undefined }),
  createShellJob: () => undefined,
  killProcessTree: () => undefined,
}));

// Only the fs-touching seed is stubbed; `cacheWarmingSetting` stays real so the mode a test configures
// travels the production path.
vi.mock('../agent-dir', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../agent-dir')>()),
  ensurePiAgentDir: (dir: string) => dir,
  PI_AGENT_DIR: '/fake/agent',
}));

vi.mock('../session-store/session-dir', () => ({
  piSessionDir: (cwd: string) => `/fake/agent/sessions/${cwd}`,
  ensurePiSessionDir: (cwd: string) => `/fake/agent/sessions/${cwd}`,
}));

import { PiSession } from '../pi-session';
import { PiRuntime } from '../pi-runtime';
import { PermissionHandler } from '../../permission-handler';
import { createFakePlatform } from '../../../__mocks__/fake-platform';
import type { WebviewExtensionUIContext } from '../extension-ui-context';
import { deriveSessionState, turnOutcomeOfError, type ChatActivity, type TurnOutcome } from '../session-state';
import { TeamService } from '../../team';
import { TOOL_ASK_USER_QUESTION, TOOL_BROWSER_REQUEST_INPUT, TOOL_EXIT_PLAN_MODE, TOOL_SKILL } from '../../../shared/tool-names';
import { runPermissionGate, type GatePermissionContext } from '../permission-gate';
import { ShellCancelStore } from '../tools/shell-cancel-registry';
import type { ToolCallEvent } from '@earendil-works/pi-coding-agent';

type StateMessage = Extract<ExtensionToWebviewMessage, { type: 'sessionStateChanged' }>;
type UiRequest = Extract<ExtensionToWebviewMessage, { type: 'extensionUiRequest' }>;

/** Reach the private uiContext, the same instance `buildNestedMcp` hands to a team agent. */
const uiOf = (session: PiSession): WebviewExtensionUIContext =>
  (session as unknown as { uiContext: WebviewExtensionUIContext }).uiContext;

const tick = () => new Promise((r) => setTimeout(r, 0));

/** Poll until a condition holds. `canUseTool` reaches its pending map through two awaits, not one. */
async function waitFor(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !predicate(); i++) await tick();
  if (!predicate()) throw new Error('condition never held');
}

function states(messages: ExtensionToWebviewMessage[]): string[] {
  return messages.filter((m): m is StateMessage => m.type === 'sessionStateChanged').map((m) => m.state);
}

function lastUiRequest(messages: ExtensionToWebviewMessage[]): UiRequest {
  const req = [...messages].reverse().find((m): m is UiRequest => m.type === 'extensionUiRequest');
  if (!req) throw new Error('no extensionUiRequest emitted');
  return req;
}

function ctx(toolUseID: string): CanUseToolContext {
  return { signal: new AbortController().signal, toolUseID, parentToolUseId: null };
}

/** A live panel: a real PermissionHandler and a real PiSession posting into one message list. */
async function startPanel(extra: Partial<SessionOptions> = {}): Promise<{
  session: PiSession;
  permissionHandler: PermissionHandler;
  messages: ExtensionToWebviewMessage[];
}> {
  const messages: ExtensionToWebviewMessage[] = [];
  const platform = createFakePlatform();
  const permissionHandler = new PermissionHandler(platform);
  permissionHandler.setPostMessage((m) => messages.push(m));
  const options: SessionOptions = {
    cwd: '/cwd',
    settingsFolder: undefined,
    projectScope: true,
    platform,
    permissionHandler,
    onMessage: (m) => messages.push(m),
    model: 'claude-opus-4-8',
    resolveThinking: () => ({ thinkingDisabled: false, effort: null, maxThinkingTokens: null }),
    ...extra,
  };
  const session = new PiSession(options);
  await session.initializeEarly();
  return { session, permissionHandler, messages };
}

/** Start a turn and hold it open until the returned `finish` runs, so prompts can open mid-turn. */
async function openTurn(session: PiSession): Promise<() => Promise<void>> {
  const live = H.getLastSession()!;
  let releasePrompt: () => void = () => {};
  (live.prompt as ReturnType<typeof vi.fn>).mockImplementation(
    () => new Promise<void>((r) => { releasePrompt = () => r(); }),
  );
  const turn = session.sendMessage('go', undefined, 'c1', { content: 'go' });
  while (!session.processing) await tick();
  return async () => {
    // The real settle path: pi's agent_settled reaches the adapter, which reports the idle turn state.
    H.fireEvent({ type: 'agent_settled' });
    releasePrompt();
    await turn;
  };
}

describe('deriveSessionState', () => {
  it('reports the turn lifecycle when nothing is pending', () => {
    expect(deriveSessionState('running', false)).toBe('running');
    expect(deriveSessionState('idle', false)).toBe('idle');
  });

  it('outranks the turn lifecycle whenever a prompt is pending, including with no turn in flight', () => {
    expect(deriveSessionState('running', true)).toBe('requires_action');
    expect(deriveSessionState('idle', true)).toBe('requires_action');
  });
});

describe('session state publisher', () => {
  beforeEach(() => {
    H.resetServices();
  });
  afterEach(async () => {
    await PiRuntime.disposeInstance();
    vi.restoreAllMocks();
  });

  it('a permission dialog then a team agent elicitation gives running, requires_action, running, requires_action, running, idle', async () => {
    const { session, permissionHandler, messages } = await startPanel();
    const finish = await openTurn(session);

    // A shell approval, through the real canUseTool path that fills pendingApprovals.
    const approval = permissionHandler.canUseTool('Bash', { command: 'echo hi' }, ctx('t1'));
    await waitFor(() => permissionHandler.pendingPrompts().length > 0);
    await permissionHandler.resolveApproval('t1', true);
    await approval;

    // A team agent's ctx.ui elicitation, minted through forAgent exactly as buildNestedMcp does, so it
    // lands in the shared pending map the panel bridge and every per-agent bridge write to.
    const agentUi = uiOf(session).forAgent({ agentId: 'a1', agentName: 'Backend', teamId: 'team-1' });
    const elicitation = agentUi.input('Which path?');
    await tick();
    const request = lastUiRequest(messages);
    expect(request).toMatchObject({ agentId: 'a1', teamId: 'team-1' });
    session.resolveExtensionUiResponse(request.requestId, '/a.ts');
    await elicitation;

    await finish();

    expect(states(messages)).toEqual(['running', 'requires_action', 'running', 'requires_action', 'running', 'idle']);
    await session.dispose();
  });

  it('a turn with no prompts emits exactly running then idle', async () => {
    const { session, messages } = await startPanel();
    const finish = await openTurn(session);
    await finish();

    expect(states(messages)).toEqual(['running', 'idle']);
    await session.dispose();
  });

  it('carries the live pi session id on every state', async () => {
    const { session, permissionHandler, messages } = await startPanel();
    const sessionId = session.currentSessionId;
    const finish = await openTurn(session);
    const approval = permissionHandler.canUseTool('Bash', { command: 'echo hi' }, ctx('t1'));
    await waitFor(() => permissionHandler.pendingPrompts().length > 0);
    await permissionHandler.resolveApproval('t1', true);
    await approval;
    await finish();

    const sent = messages.filter((m): m is StateMessage => m.type === 'sessionStateChanged');
    expect(sent.every((m) => m.sessionId === sessionId)).toBe(true);
    await session.dispose();
  });

  it('AskUserQuestion moves the session to requires_action and back to running', async () => {
    const { session, permissionHandler, messages } = await startPanel();
    const finish = await openTurn(session);

    const question = permissionHandler.canUseTool(
      TOOL_ASK_USER_QUESTION,
      {
        questions: [{
          question: 'Which?',
          header: 'Pick',
          multiSelect: false,
          options: [{ label: 'a', description: 'first' }, { label: 'b', description: 'second' }],
        }],
      },
      ctx('q1'),
    );
    await waitFor(() => permissionHandler.pendingPrompts().length > 0);
    permissionHandler.resolveQuestion('q1', { Pick: 'a' });
    await question;
    await finish();

    expect(states(messages)).toEqual(['running', 'requires_action', 'running', 'idle']);
    await session.dispose();
  });

  it('BrowserRequestInput moves the session to requires_action and back to running', async () => {
    const { session, permissionHandler, messages } = await startPanel();
    const finish = await openTurn(session);

    const form = permissionHandler.canUseTool(
      TOOL_BROWSER_REQUEST_INPUT,
      { title: 'Log in', fields: [{ id: 'user', label: 'User', selector: '#user', type: 'text' }] },
      ctx('f1'),
    );
    await waitFor(() => permissionHandler.pendingPrompts().length > 0);
    permissionHandler.resolveForm('f1', { user: 'me' });
    await form;
    await finish();

    expect(states(messages)).toEqual(['running', 'requires_action', 'running', 'idle']);
    await session.dispose();
  });

  it('plan approval moves the session to requires_action and back to running', async () => {
    const { session, permissionHandler, messages } = await startPanel();
    permissionHandler.setPermissionMode('plan');
    permissionHandler.setPlanContentResolver(async () => 'the plan');
    const finish = await openTurn(session);

    const plan = permissionHandler.canUseTool(TOOL_EXIT_PLAN_MODE, {}, ctx('p1'));
    await waitFor(() => permissionHandler.pendingPrompts().length > 0);
    permissionHandler.resolvePlanApproval('p1', true);
    await plan;
    await finish();

    expect(states(messages)).toEqual(['running', 'requires_action', 'running', 'idle']);
    await session.dispose();
  });

  it('skill approval moves the session to requires_action and back to running', async () => {
    const { session, permissionHandler, messages } = await startPanel();
    const finish = await openTurn(session);

    const skill = permissionHandler.canUseTool(TOOL_SKILL, { skill: 'simplify' }, ctx('s1'));
    await waitFor(() => permissionHandler.pendingPrompts().length > 0);
    permissionHandler.resolveSkillApproval('s1', true);
    await skill;
    await finish();

    expect(states(messages)).toEqual(['running', 'requires_action', 'running', 'idle']);
    await session.dispose();
  });

  it('a prompt that turning YOLO on approves leaves the pending set and returns the session to running', async () => {
    const { session, permissionHandler, messages } = await startPanel();
    const finish = await openTurn(session);
    const gate: GatePermissionContext = { permissionHandler, isPlanMode: () => false, shellCancel: new ShellCancelStore().forContext(() => undefined) };
    const event = { type: 'tool_call', toolName: 'bash', toolCallId: 't1', input: { command: 'npm install' } } as unknown as ToolCallEvent;

    const shell = runPermissionGate(event, gate, undefined);
    await waitFor(() => permissionHandler.pendingPrompts().length > 0);
    permissionHandler.setDangerouslySkipPermissions(true);
    expect(await shell).toBeUndefined();
    expect(permissionHandler.pendingPrompts()).toEqual([]);
    await finish();

    const pendingIds = messages.filter((m): m is StateMessage => m.type === 'sessionStateChanged').map((m) => m.pendingPrompts.map((p) => p.id));
    expect(states(messages)).toEqual(['running', 'requires_action', 'running', 'idle']);
    expect(pendingIds).toEqual([[], ['t1'], [], []]);
    await session.dispose();
  });

  it('a panel ctx.ui elicitation moves the session to requires_action and back to running', async () => {
    const { session, messages } = await startPanel();
    const finish = await openTurn(session);

    const dialog = uiOf(session).confirm('Sure?', 'really?');
    await tick();
    session.resolveExtensionUiResponse(lastUiRequest(messages).requestId, true);
    await dialog;
    await finish();

    expect(states(messages)).toEqual(['running', 'requires_action', 'running', 'idle']);
    await session.dispose();
  });

  it('two prompts open at once hold requires_action, restate the pending set as it changes, and run only after both are answered', async () => {
    const { session, permissionHandler, messages } = await startPanel();
    const finish = await openTurn(session);
    const pendingIds = () => messages.filter((m): m is StateMessage => m.type === 'sessionStateChanged').map((m) => m.pendingPrompts.map((p) => p.id));

    // One from each owner, so requires_action spans both maps rather than one of them.
    const approval = permissionHandler.canUseTool('Bash', { command: 'echo hi' }, ctx('t1'));
    await waitFor(() => permissionHandler.pendingPrompts().length > 0);
    const dialog = uiOf(session).confirm('Sure?', 'really?');
    await tick();
    const dialogId = lastUiRequest(messages).requestId;
    expect(states(messages)).toEqual(['running', 'requires_action', 'requires_action']);

    session.resolveExtensionUiResponse(dialogId, true);
    await dialog;
    // Still parked: the approval is unanswered, so the second prompt's resolve must not release it.
    expect(states(messages)).toEqual(['running', 'requires_action', 'requires_action', 'requires_action']);

    await permissionHandler.resolveApproval('t1', true);
    await approval;
    await finish();

    expect(states(messages)).toEqual(['running', 'requires_action', 'requires_action', 'requires_action', 'running', 'idle']);
    expect(pendingIds()).toEqual([[], ['t1'], ['t1', dialogId], ['t1'], [], []]);
    await session.dispose();
  });

  it('the duplicate guard drops only an identical message, never a genuine transition', async () => {
    const { session, permissionHandler, messages } = await startPanel();
    const finish = await openTurn(session);

    for (const id of ['t1', 't2'] as const) {
      const approval = permissionHandler.canUseTool('Bash', { command: 'echo hi' }, ctx(id));
      await waitFor(() => permissionHandler.pendingPrompts().length > 0);
      await permissionHandler.resolveApproval(id, true);
      await approval;
    }
    await finish();

    // Re-entering requires_action after returning to running emits it again; only the repeat of a state
    // already sent is dropped.
    expect(states(messages)).toEqual(['running', 'requires_action', 'running', 'requires_action', 'running', 'idle']);
    await session.dispose();
  });

  it('a ctx.ui dialog withdrawn by its abort signal returns the state to running', async () => {
    const { session, messages } = await startPanel();
    const finish = await openTurn(session);

    const controller = new AbortController();
    const dialog = uiOf(session).select('Pick one', ['a'], { signal: controller.signal });
    await waitFor(() => uiOf(session).pendingDialogs().length > 0);
    controller.abort();
    await dialog;
    await finish();

    expect(states(messages)).toEqual(['running', 'requires_action', 'running', 'idle']);
    await session.dispose();
  });

  it('a dialog opened with no turn in flight emits requires_action with no preceding running', async () => {
    const { session, messages } = await startPanel();

    const dialog = uiOf(session).confirm('Sure?', 'really?');
    await waitFor(() => uiOf(session).pendingDialogs().length > 0);
    session.resolveExtensionUiResponse(lastUiRequest(messages).requestId, true);
    await dialog;

    expect(states(messages)).toEqual(['requires_action', 'idle']);
    await session.dispose();
  });

  it('republishes to a reloaded webview, whose fresh store starts at idle', async () => {
    const { session, permissionHandler, messages } = await startPanel();
    const finish = await openTurn(session);

    const approval = permissionHandler.canUseTool('Bash', { command: 'echo hi' }, ctx('t1'));
    await waitFor(() => permissionHandler.pendingPrompts().length > 0);
    expect(states(messages)).toEqual(['running', 'requires_action']);

    // The reload leaves the five permission maps holding their live awaiters, so the session is still
    // parked. Without the republish the reloaded store would read `idle` for as long as the prompt lasts.
    session.onWebviewReady();
    expect(states(messages)).toEqual(['running', 'requires_action', 'requires_action']);

    await permissionHandler.resolveApproval('t1', true);
    await approval;
    expect(states(messages)).toEqual(['running', 'requires_action', 'requires_action', 'running']);

    await finish();
    await session.dispose();
  });

  /**
   * The window this covers: pi's `agent_settled` reaches the adapter, which reports `idle`, while
   * `sendMessage`'s own `finally` has not run yet. A prompt settling inside that window republishes,
   * and a lifecycle derived from `processingFlag` would answer `running` there and never correct
   * itself, leaving the status bar working for the rest of the session.
   */
  it('a prompt settling between the adapter idle and the send returning does not resurrect running', async () => {
    const { session, permissionHandler, messages } = await startPanel();
    const live = H.getLastSession()!;

    let releasePrompt: () => void = () => {};
    (live.prompt as ReturnType<typeof vi.fn>).mockImplementation(
      () => new Promise<void>((r) => { releasePrompt = () => r(); }),
    );
    const turn = session.sendMessage('go', undefined, 'c1', { content: 'go' });
    while (!session.processing) await tick();

    const approval = permissionHandler.canUseTool('Bash', { command: 'echo hi' }, ctx('t1'));
    await waitFor(() => permissionHandler.pendingPrompts().length > 0);
    expect(states(messages)).toEqual(['running', 'requires_action']);

    // The adapter settles the turn, and `prompt()` has NOT resolved yet, so `processingFlag` is still
    // true. Answering the approval here is what used to publish `running` after `idle`.
    H.fireEvent({ type: 'agent_settled' });
    expect(session.processing).toBe(true);
    await permissionHandler.resolveApproval('t1', true);
    await approval;

    expect(states(messages)).toEqual(['running', 'requires_action', 'idle']);

    releasePrompt();
    await turn;
    expect(states(messages)).toEqual(['running', 'requires_action', 'idle']);
    await session.dispose();
  });

  /**
   * Stop pressed while a long tool runs and no model stream is open. pi emits no aborted assistant
   * event, so nothing else in the system ever says the turn ended.
   */
  it('an abort with no pi event behind it still returns the session to idle', async () => {
    const { session, messages } = await startPanel();
    const live = H.getLastSession()!;
    (live.prompt as ReturnType<typeof vi.fn>).mockImplementation(() => new Promise<void>(() => {}));
    void session.sendMessage('go', undefined, 'c1', { content: 'go' });
    while (!session.processing) await tick();
    expect(states(messages)).toEqual(['running']);

    session.cancel();

    expect(states(messages)).toEqual(['running', 'idle']);
    await session.dispose();
  });

  it('republishes after a session replacement, whose sessionCleared reset the store', async () => {
    const { session, messages } = await startPanel();
    const finish = await openTurn(session);
    await finish();
    expect(states(messages)).toEqual(['running', 'idle']);
    const firstSessionId = session.currentSessionId;

    session.reset();
    await session.whenReplaced();

    // Not a duplicate: the replacement carries a new pi session id, and the reloaded store has to be
    // told which session the state belongs to.
    const sent = messages.filter((m): m is StateMessage => m.type === 'sessionStateChanged');
    const last = sent[sent.length - 1]!;
    expect(last.state).toBe('idle');
    expect(last.sessionId).toBe(session.currentSessionId);
    expect(last.sessionId).not.toBe(firstSessionId);
    await session.dispose();
  });

  it('republishes after detachFromDeletedSession emits sessionCleared', async () => {
    const { session, messages } = await startPanel();
    await session.detachFromDeletedSession();

    const types = messages.map((m) => m.type);
    const clearedAt = types.lastIndexOf('sessionCleared');
    expect(clearedAt).toBeGreaterThanOrEqual(0);
    // After the reset, not before it: the webview drops its stored state on `sessionCleared`, so a
    // state published earlier is the one it just threw away.
    expect(types.indexOf('sessionStateChanged', clearedAt)).toBeGreaterThan(clearedAt);
    await session.dispose();
  });

  /**
   * Both listeners are functions the session hands to objects it does not own: the `PermissionHandler`
   * is constructed by the caller, and the panel disposes it separately. Asserted on the slots rather
   * than on emitted messages because `emit` already drops everything once `_disposed` is set, so a
   * retained listener publishes nothing. What it does retain is the whole disposed session, and the
   * handler's slot holds exactly one function, so a session that never releases it is also the one
   * thing standing between the slot and its next owner.
   */
  it('releases both pending-prompt listeners on dispose', async () => {
    const { session, permissionHandler } = await startPanel();
    const slotOf = (o: object): unknown => (o as { onPendingChanged?: unknown }).onPendingChanged;
    const handlerSlot = (): unknown =>
      slotOf((permissionHandler as unknown as { state: object }).state);

    expect(handlerSlot()).toBeTypeOf('function');
    expect(slotOf(uiOf(session))).toBeTypeOf('function');

    await session.dispose();

    expect(handlerSlot()).toBeNull();
    expect(slotOf(uiOf(session))).toBeNull();
  });

  it('a turn cancelled with a permission dialog open goes straight from requires_action to idle', async () => {
    const { session, permissionHandler, messages } = await startPanel();
    const finish = await openTurn(session);

    // The tool's own signal, which pi aborts once the host tears the turn down.
    const controller = new AbortController();
    const approval = permissionHandler.canUseTool(
      'Bash',
      { command: 'echo hi' },
      { signal: controller.signal, toolUseID: 't1', parentToolUseId: null },
    );
    await waitFor(() => permissionHandler.pendingPrompts().length > 0);
    expect(states(messages)).toEqual(['running', 'requires_action']);

    session.cancel();
    controller.abort();
    await approval;
    await waitFor(() => permissionHandler.pendingPrompts().length === 0);

    // No `running` in between: the turn was already down when the last prompt cleared.
    expect(states(messages)).toEqual(['running', 'requires_action', 'idle']);
    await finish();
    await session.dispose();
  });
});

/** Every activity the session reports from here on; the first is the report the bind itself owes. */
function watchActivity(session: PiSession): ChatActivity[] {
  const seen: ChatActivity[] = [];
  session.setActivityListener((activity) => seen.push(activity));
  return seen;
}

const privOf = (o: object): Record<string, unknown> => o as unknown as Record<string, unknown>;

describe('panel activity, from the same publisher', () => {
  beforeEach(() => {
    H.resetServices();
  });
  afterEach(async () => {
    await PiRuntime.disposeInstance();
    vi.restoreAllMocks();
  });

  it('reports every state sessionStateChanged carries, with the kinds of what is pending', async () => {
    const { session, permissionHandler, messages } = await startPanel();
    const activity = watchActivity(session);
    const finish = await openTurn(session);

    const approval = permissionHandler.canUseTool('Bash', { command: 'echo hi' }, ctx('t1'));
    await waitFor(() => permissionHandler.pendingPrompts().length > 0);
    await permissionHandler.resolveApproval('t1', true);
    await approval;
    const dialog = uiOf(session).input('Which path?');
    await tick();
    session.resolveExtensionUiResponse(lastUiRequest(messages).requestId, '/a.ts');
    await dialog;
    await finish();

    // The bind publishes too, so the webview hears the same idle the activity starts from.
    expect(states(messages)).toEqual(['idle', 'running', 'requires_action', 'running', 'requires_action', 'running', 'idle']);
    expect(activity.map((a) => a.state)).toEqual(states(messages));
    expect(activity.map((a) => a.pendingKinds)).toEqual([[], [], ['approval'], [], ['input'], [], []]);
    expect(activity.every((a) => !a.background)).toBe(true);
    await session.dispose();
  });

  it('reports the first write of the session file, which changes the stored session id and not the state', async () => {
    const { session } = await startPanel();
    const finish = await openTurn(session);
    const activity = watchActivity(session);
    expect(session.storedSessionId).toBeNull();

    H.getLastSession()!.sessionManager.getSessionFile.mockReturnValue(__filename);
    await finish();

    expect(session.storedSessionId).toBe(session.currentSessionId);
    expect(activity.map((a) => a.state)).toEqual(['running', 'idle', 'idle']);
    await session.dispose();
  });

  it('background is true while a subagent run or a team has not settled, reported as each starts and settles', async () => {
    const teamService = new TeamService({} as ConstructorParameters<typeof TeamService>[0]);
    const { session } = await startPanel({ teamService });
    const activity = watchActivity(session);
    const subagents = privOf(session)['subagentManager'] as { hasUnsettledRuns(): boolean };
    const runsChanged = (privOf(subagents)['engine'] as { onRunsChanged(): void }).onRunsChanged;
    const unsettled = vi.spyOn(subagents, 'hasUnsettledRuns');
    const setActiveTeam = (id: string | null): void => (privOf(teamService)['setActiveTeam'] as (id: string | null, runner: null) => void).call(teamService, id, null);

    unsettled.mockReturnValue(true);
    runsChanged();
    unsettled.mockReturnValue(false);
    runsChanged();
    setActiveTeam('team-1');
    setActiveTeam(null);

    expect(activity.map((a) => a.background)).toEqual([false, true, false, true, false]);
    expect(activity.every((a) => a.state === 'idle')).toBe(true);
    await session.dispose();
  });

  it('a running turn that goes idle reports how it settled, once, a completed one with its duration', async () => {
    const { session } = await startPanel();
    const outcomes: TurnOutcome[] = [];
    session.setTurnSettledListener((outcome) => outcomes.push(outcome));
    let now = 10_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);

    const finish = await openTurn(session);
    now += 1_250;
    await finish();
    const stopped = await openTurn(session);
    session.cancel();
    await stopped();
    session.reset();

    expect(outcomes).toEqual([{ kind: 'completed', durationMs: 1_250 }, { kind: 'cancelled' }]);
    await session.dispose();
  });

  it('refreshes subscription usage after a settled turn, only on a subscription account', async () => {
    const { session } = await startPanel();
    const runtime = PiRuntime.get();
    const refresh = vi.spyOn(runtime.usage, 'refreshAfterTurn').mockImplementation(() => undefined);
    const auth = vi.spyOn(runtime, 'getClaudeAuthStatus').mockReturnValue({ mode: 'apikey' } as never);

    await (await openTurn(session))();
    expect(refresh).not.toHaveBeenCalled();
    auth.mockReturnValue({ mode: 'allowance' } as never);
    await (await openTurn(session))();
    expect(refresh).toHaveBeenCalledTimes(1);
    await session.dispose();
  });

  it('a turn that settles after the session was disposed refreshes nothing', async () => {
    const { session } = await startPanel();
    const runtime = PiRuntime.get();
    const refresh = vi.spyOn(runtime.usage, 'refreshAfterTurn').mockImplementation(() => undefined);
    vi.spyOn(runtime, 'getClaudeAuthStatus').mockReturnValue({ mode: 'allowance' } as never);

    const finish = await openTurn(session);
    await session.dispose();
    await finish();
    expect(refresh).not.toHaveBeenCalled();
  });

  describe('a rate-limited turn (D55)', () => {
    /** A turn whose last assistant message is a provider rate-limit error. */
    async function rateLimitedTurn(session: PiSession): Promise<() => Promise<void>> {
      const finish = await openTurn(session);
      return async () => {
        H.fireEvent({ type: 'message_end', message: { role: 'assistant', content: [], stopReason: 'error', errorMessage: '429 rate_limit_error', usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: {} } } });
        await finish();
      };
    }

    function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
      let resolve: (value: T) => void = () => {};
      const promise = new Promise<T>((r) => { resolve = r; });
      return { promise, resolve };
    }

    const SESSION_WINDOW = { windowId: 'five_hour', windowLabel: 'Session (5hr)', resetsAt: Date.parse('2026-03-01T15:00:00Z') };

    it('goes idle at once, and its outcome waits for the refresh to name the full window', async () => {
      const { session, messages } = await startPanel();
      const runtime = PiRuntime.get();
      vi.spyOn(runtime, 'getClaudeAuthStatus').mockReturnValue({ mode: 'allowance' } as never);
      const refreshed = deferred<typeof SESSION_WINDOW | undefined>();
      const fullWindow = vi.spyOn(runtime.usage, 'fullWindow').mockReturnValue(refreshed.promise);
      const afterTurn = vi.spyOn(runtime.usage, 'refreshAfterTurn').mockImplementation(() => undefined);
      const outcomes: TurnOutcome[] = [];
      session.setTurnSettledListener((outcome) => outcomes.push(outcome));

      await (await rateLimitedTurn(session))();
      expect(states(messages).at(-1)).toBe('idle');
      expect(outcomes).toEqual([]);
      expect(fullWindow).toHaveBeenCalledWith('anthropic', 'claude-opus-4-8');

      refreshed.resolve(SESSION_WINDOW);
      await tick();
      expect(outcomes).toEqual([{ kind: 'rateLimit', ...SESSION_WINDOW }]);
      expect(afterTurn).not.toHaveBeenCalled();
      await session.dispose();
    });

    it('names no window and refreshes nothing on an API key', async () => {
      const { session } = await startPanel();
      const runtime = PiRuntime.get();
      vi.spyOn(runtime, 'getClaudeAuthStatus').mockReturnValue({ mode: 'apikey' } as never);
      const fullWindow = vi.spyOn(runtime.usage, 'fullWindow');
      const outcomes: TurnOutcome[] = [];
      session.setTurnSettledListener((outcome) => outcomes.push(outcome));

      await (await rateLimitedTurn(session))();
      await tick();
      expect(outcomes).toEqual([{ kind: 'rateLimit' }]);
      expect(fullWindow).not.toHaveBeenCalled();
      await session.dispose();
    });

    it('raises nothing once the session is disposed while the refresh runs', async () => {
      const { session } = await startPanel();
      const runtime = PiRuntime.get();
      vi.spyOn(runtime, 'getClaudeAuthStatus').mockReturnValue({ mode: 'allowance' } as never);
      const refreshed = deferred<typeof SESSION_WINDOW | undefined>();
      vi.spyOn(runtime.usage, 'fullWindow').mockReturnValue(refreshed.promise);
      const outcomes: TurnOutcome[] = [];
      session.setTurnSettledListener((outcome) => outcomes.push(outcome));

      await (await rateLimitedTurn(session))();
      const disposed = session.dispose();
      refreshed.resolve(SESSION_WINDOW);
      await disposed;
      await tick();
      expect(outcomes).toEqual([]);
    });
  });

  it('reports each pending prompt with its id, kind, owner and summary, and a second prompt of a kind already pending', async () => {
    const { session, permissionHandler, messages } = await startPanel();
    const activity = watchActivity(session);
    const finish = await openTurn(session);

    const first = permissionHandler.canUseTool('Bash', { command: 'npm test\nnpm run lint' }, ctx('t1'));
    await waitFor(() => permissionHandler.pendingPrompts().length > 0);
    const second = permissionHandler.canUseTool(TOOL_ASK_USER_QUESTION, {
      questions: [{ question: 'Which store?', header: 'Store', multiSelect: false, options: [{ label: 'a', description: '' }, { label: 'b', description: '' }] }],
    }, ctx('q1'));
    await waitFor(() => permissionHandler.pendingPrompts().length > 1);
    const third = permissionHandler.canUseTool('Bash', { command: 'echo hi' }, ctx('t2'));
    await waitFor(() => permissionHandler.pendingPrompts().length > 2);
    const dialog = uiOf(session).input('Which path?');
    await tick();

    const last = activity[activity.length - 1]!;
    expect(last.pendingPrompts).toEqual([
      { id: 't1', kind: 'approval', owner: { kind: 'main' }, summary: 'run `npm test`' },
      { id: 'q1', kind: 'question', owner: { kind: 'main' }, summary: 'Which store?' },
      { id: 't2', kind: 'approval', owner: { kind: 'main' }, summary: 'run `echo hi`' },
      { id: lastUiRequest(messages).requestId, kind: 'input', owner: { kind: 'main' }, summary: 'Which path?' },
    ]);
    expect(activity.map((a) => a.pendingPrompts.length)).toEqual([0, 0, 1, 2, 3, 4]);
    for (const a of activity) expect(a.pendingKinds).toEqual([...new Set(a.pendingPrompts.map((p) => p.kind))].sort());

    session.resolveExtensionUiResponse(lastUiRequest(messages).requestId, '/a.ts');
    permissionHandler.resolveQuestion('q1', { Store: 'a' });
    await permissionHandler.resolveApproval('t1', true);
    await permissionHandler.resolveApproval('t2', true);
    await Promise.all([first, second, third, dialog]);
    await finish();
    await session.dispose();
  });

  it('names the team or subagent that raised a prompt, by the parent tool use id it carries', async () => {
    const teamService = new TeamService({} as ConstructorParameters<typeof TeamService>[0]);
    const { session, permissionHandler, messages } = await startPanel({ teamService });
    const activity = watchActivity(session);
    const runner = { getMember: (id: string) => (id === 'agent-7' ? { name: 'Backend\u202e lead' } : undefined), getTitle: () => 'Lockout' };
    (privOf(teamService)['setActiveTeam'] as (id: string, r: unknown) => void).call(teamService, 'team-1', runner);
    const subagents = privOf(session)['subagentManager'] as object;
    (privOf(subagents)['agents'] as Map<string, unknown>).set('sub-1', { id: 'sub-1', toolCallId: 'call-agent' });

    const fromTeam = permissionHandler.canUseTool('Bash', { command: 'ls' }, { ...ctx('t1'), parentToolUseId: 'agent-7' });
    await waitFor(() => permissionHandler.pendingPrompts().length === 1);
    const fromSubagent = permissionHandler.canUseTool('Bash', { command: 'pwd' }, { ...ctx('t2'), parentToolUseId: 'call-agent' });
    await waitFor(() => permissionHandler.pendingPrompts().length === 2);
    const fromGone = permissionHandler.canUseTool('Bash', { command: 'id' }, { ...ctx('t3'), parentToolUseId: 'call-finished' });
    await waitFor(() => permissionHandler.pendingPrompts().length === 3);
    const teamDialog = uiOf(session).forAgent({ agentId: 'agent-8', agentName: 'Reviewer', teamId: 'team-1' }).input('Token?');
    const subagentDialog = uiOf(session).forAgent({ agentId: 'sub-2', agentName: 'Explore' }).input('Path?');
    await tick();

    const team = { kind: 'team', teamId: 'team-1', agentId: 'agent-7', teamTitle: 'Lockout', agentName: 'Backend lead' };
    const stated = [
      team,
      { kind: 'subagent', agentId: 'sub-1' },
      { kind: 'main' },
      { kind: 'team', teamId: 'team-1', agentId: 'agent-8', agentName: 'Reviewer' },
      { kind: 'subagent', agentId: 'sub-2' },
    ];
    expect(activity[activity.length - 1]!.pendingPrompts.map((p) => p.owner)).toEqual(stated);
    // The webview reads the same owners from the session state, so a team card names exactly these members.
    const lastState = (): StateMessage => messages.filter((m): m is StateMessage => m.type === 'sessionStateChanged').at(-1)!;
    expect(lastState().pendingPrompts.map((p) => p.owner)).toEqual(stated);
    expect(lastState().pendingPrompts.map((p) => p.id)).toEqual(activity[activity.length - 1]!.pendingPrompts.map((p) => p.id));

    // The webview places each call's card by the owner on the prompt, on first post and on the re-post a reload gets.
    type PermissionRequest = Extract<ExtensionToWebviewMessage, { type: 'requestPermission' }>;
    const posted = () => messages.filter((m): m is PermissionRequest => m.type === 'requestPermission').map((m) => [m.toolUseId, m.owner]);
    const owners = [['t1', team], ['t2', { kind: 'subagent', agentId: 'sub-1' }], ['t3', { kind: 'main' }]];
    expect(posted()).toEqual(owners);
    (privOf(teamService)['setActiveTeam'] as (id: null, r: null) => void).call(teamService, null, null);
    session.onWebviewReady();
    expect(posted()).toEqual([...owners, ...owners]);
    // A reload gets the still-pending owners again, though the team has since stopped running.
    expect(lastState().pendingPrompts.map((p) => p.owner)).toEqual(stated);

    for (const request of messages.filter((m): m is UiRequest => m.type === 'extensionUiRequest')) session.resolveExtensionUiResponse(request.requestId, 'x');
    for (const id of ['t1', 't2', 't3']) await permissionHandler.resolveApproval(id, true);
    await Promise.all([fromTeam, fromSubagent, fromGone, teamDialog, subagentDialog]);
    expect(lastState().pendingPrompts).toEqual([]);
    await session.dispose();
  });

  it("drops a team agent's prompts from the stated owners when its run aborts them, a question included", async () => {
    const teamService = new TeamService({} as ConstructorParameters<typeof TeamService>[0]);
    const { session, permissionHandler, messages } = await startPanel({ teamService });
    const runner = { getMember: (id: string) => (id === 'agent-7' ? { name: 'Mira' } : undefined), getTitle: () => 'Lockout' };
    (privOf(teamService)['setActiveTeam'] as (id: string, r: unknown) => void).call(teamService, 'team-1', runner);
    const lastState = (): StateMessage => messages.filter((m): m is StateMessage => m.type === 'sessionStateChanged').at(-1)!;
    const run = new AbortController();
    const agentCtx = (toolUseID: string): CanUseToolContext => ({ signal: run.signal, toolUseID, parentToolUseId: 'agent-7' });

    const approval = permissionHandler.canUseTool('Bash', { command: 'ls' }, agentCtx('t1'));
    const question = permissionHandler.canUseTool(TOOL_ASK_USER_QUESTION, {
      questions: [{ question: 'Which?', header: 'Pick', multiSelect: false, options: [{ label: 'a', description: 'first' }, { label: 'b', description: 'second' }] }],
    }, agentCtx('q1'));
    await waitFor(() => permissionHandler.pendingPrompts().length === 2);
    const mira = { kind: 'team', teamId: 'team-1', agentId: 'agent-7', teamTitle: 'Lockout', agentName: 'Mira' };
    expect(lastState()).toMatchObject({ state: 'requires_action', pendingPrompts: [{ id: 'q1', owner: mira }, { id: 't1', owner: mira }] });

    run.abort();
    await Promise.all([approval, question]);
    expect(lastState()).toMatchObject({ state: 'idle', pendingPrompts: [] });
    (privOf(teamService)['setActiveTeam'] as (id: null, r: null) => void).call(teamService, null, null);
    await session.dispose();
  });

  it('classifies a provider rate or usage limit apart from any other error', () => {
    expect(turnOutcomeOfError('429 {"type":"rate_limit_error"}')).toEqual({ kind: 'rateLimit' });
    expect(turnOutcomeOfError('Too Many Requests')).toEqual({ kind: 'rateLimit' });
    expect(turnOutcomeOfError('subscription_sharing_usage_limit_exceeded')).toEqual({ kind: 'rateLimit' });
    expect(turnOutcomeOfError('invalid x-api-key')).toEqual({ kind: 'error', message: 'invalid x-api-key' });
  });
});

describe('single-writer discipline', () => {
  /**
   * Both halves of the invariant in `docs/invariants.md` are source-level, so nothing in the type
   * system or the behavioural tests above can hold them. Any backend file (src/core, src/vscode) that deletes
   * from a prompt map directly, or a second site that constructs the message, leaves every test green
   * and the session parked for good.
   */
  it('leaves the permission prompt maps mutable only from state.ts', () => {
    const files = backendSourceFiles();
    expect(files.some((f) => f.rel === 'src/core/permission-handler/managers/approval-manager.ts')).toBe(true);
    expect(files.some((f) => f.rel === 'src/core/permission-handler/diff-manager.ts')).toBe(true);

    const mutation =
      /pending(?:Approvals|Questions|Forms|PlanApprovals|SkillApprovals|Elicitations|PromptRequests)\s*\.\s*(?:set|delete|clear)\b/;
    const offenders = files
      .filter((f) => f.rel !== 'src/core/permission-handler/state.ts' && mutation.test(readFileSync(f.path, 'utf8')))
      .map((f) => f.rel);

    expect(offenders).toEqual([]);
  });

  it('constructs sessionStateChanged in exactly one backend file', () => {
    const files = backendSourceFiles();

    // The trailing comma is what separates a message literal, which must also carry `state` and
    // `sessionId`, from the `Extract<…, { type: 'sessionStateChanged' }>` the state type is read through.
    const emitters = files.filter((f) =>
      /type:\s*['"]sessionStateChanged['"]\s*,/.test(readFileSync(f.path, 'utf8')),
    );

    expect(emitters.map((f) => f.rel)).toEqual(['src/core/pi-session/pi-session.ts']);
  });

  // A second reporter could tell main a chat is idle while its webview shows a prompt, or the reverse.
  it('builds the panel activity only inside publishSessionState, from the state it publishes', () => {
    const activity = /\{\s*state,\s*pendingKinds,\s*pendingPrompts,\s*background\s*\}/;
    const reporters = backendSourceFiles().filter((f) => activity.test(readFileSync(f.path, 'utf8')));
    expect(reporters.map((f) => f.rel)).toEqual(['src/core/pi-session/pi-session.ts']);

    const source = readFileSync(reporters[0]!.path, 'utf8');
    const start = source.indexOf('private publishSessionState(): void {');
    const body = source.slice(start, source.indexOf('\n  }\n', start));
    expect(body).toContain('listener({ state, pendingKinds, pendingPrompts, background })');
    expect(body).toContain('this.emit({ type: "sessionStateChanged", state, sessionId, pendingPrompts: pendingPromptOwners(raised) })');
    expect(source.match(new RegExp(activity.source, 'g'))).toHaveLength(1);
  });
});
