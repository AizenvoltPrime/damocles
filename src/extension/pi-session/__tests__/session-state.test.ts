import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { SessionOptions } from '../../session-types';
import type { ExtensionToWebviewMessage } from '../../../shared/types/messages';
import type { CanUseToolContext } from '../../permission-handler/types';
import type { FinishTurn } from '@earendil-works/pi-agent-core';
import { readFileSync, readdirSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';

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
  let listener: ((event: unknown) => void) | null = null;

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
    const session = {
      sessionId: id,
      agent: {} as { finishTurn?: FinishTurn },
      isStreaming: false,
      isCompacting: false,
      get isIdle() { return !this.isStreaming; },
      modelRuntime: { getModel: () => undefined },
      subscribe: vi.fn((l: (event: unknown) => void) => { listener = l; return () => { listener = null; }; }),
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
    SessionManager: { create: vi.fn(() => ({ kind: 'persistent' })), inMemory: vi.fn(() => ({ kind: 'memory' })) },
    SettingsManager: { inMemory: vi.fn(() => ({ kind: 'settings' })), create: vi.fn(() => ({ kind: 'settings' })) },
    ModelRuntime: { create: vi.fn(async () => services.modelRuntime) },
    DefaultPackageManager: class { getInstalledPath(): string | undefined { return undefined; } },
    defineTool: vi.fn((tool: unknown) => tool),
    createEditToolDefinition: vi.fn(() => ({ execute: vi.fn(async () => ({ content: [], details: undefined })) })),
    createBashToolDefinition: vi.fn(() => ({ name: 'bash', label: 'Bash', description: 'pi bash', parameters: {}, execute: vi.fn(async () => ({ content: [], details: undefined })) })),
    createPowerShellToolDefinition: vi.fn(() => ({ name: 'powershell', label: 'powershell', description: 'pi powershell', parameters: {}, execute: vi.fn(async () => ({ content: [], details: undefined })) })),
  };

  return {
    fakePi,
    resetServices: () => { services = makeServices(); },
    getLastSession: () => lastSession,
    fireEvent: (event: unknown) => { listener?.(event); },
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

import * as vscode from 'vscode';
import { PiSession } from '../pi-session';
import { PiRuntime } from '../pi-runtime';
import { PermissionHandler } from '../../permission-handler';
import type { WebviewExtensionUIContext } from '../extension-ui-context';
import { deriveSessionState } from '../session-state';
import { TOOL_ASK_USER_QUESTION, TOOL_BROWSER_REQUEST_INPUT, TOOL_EXIT_PLAN_MODE, TOOL_SKILL } from '../../../shared/tool-names';

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

/** The vscode mock has no content-provider registry, and `DiffManager` registers one at construction. */
function stubContentProviderRegistry(): void {
  (vscode.workspace as unknown as Record<string, unknown>)['registerTextDocumentContentProvider'] =
    () => ({ dispose: () => undefined });
}

/** A live panel: a real PermissionHandler and a real PiSession posting into one message list. */
async function startPanel(): Promise<{
  session: PiSession;
  permissionHandler: PermissionHandler;
  messages: ExtensionToWebviewMessage[];
}> {
  const messages: ExtensionToWebviewMessage[] = [];
  stubContentProviderRegistry();
  const permissionHandler = new PermissionHandler(vscode.Uri.file('/ext'));
  permissionHandler.setPostMessage((m) => messages.push(m));
  const options: SessionOptions = {
    cwd: '/cwd',
    permissionHandler,
    onMessage: (m) => messages.push(m),
    model: 'claude-opus-4-8',
    resolveThinking: () => ({ thinkingDisabled: false, effort: null, maxThinkingTokens: null }),
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
    await waitFor(() => permissionHandler.hasPendingPrompts());
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
    await waitFor(() => permissionHandler.hasPendingPrompts());
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
    await waitFor(() => permissionHandler.hasPendingPrompts());
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
    await waitFor(() => permissionHandler.hasPendingPrompts());
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
    await waitFor(() => permissionHandler.hasPendingPrompts());
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
    await waitFor(() => permissionHandler.hasPendingPrompts());
    permissionHandler.resolveSkillApproval('s1', true);
    await skill;
    await finish();

    expect(states(messages)).toEqual(['running', 'requires_action', 'running', 'idle']);
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

  it('two prompts open at once give ONE requires_action, and running only after both are answered', async () => {
    const { session, permissionHandler, messages } = await startPanel();
    const finish = await openTurn(session);

    // One from each owner, so the single requires_action spans both maps rather than one of them.
    const approval = permissionHandler.canUseTool('Bash', { command: 'echo hi' }, ctx('t1'));
    await waitFor(() => permissionHandler.hasPendingPrompts());
    const dialog = uiOf(session).confirm('Sure?', 'really?');
    await tick();
    expect(states(messages)).toEqual(['running', 'requires_action']);

    session.resolveExtensionUiResponse(lastUiRequest(messages).requestId, true);
    await dialog;
    // Still parked: the approval is unanswered, so the second prompt's resolve must not release it.
    expect(states(messages)).toEqual(['running', 'requires_action']);

    await permissionHandler.resolveApproval('t1', true);
    await approval;
    await finish();

    expect(states(messages)).toEqual(['running', 'requires_action', 'running', 'idle']);
    await session.dispose();
  });

  it('the duplicate guard drops only an identical message, never a genuine transition', async () => {
    const { session, permissionHandler, messages } = await startPanel();
    const finish = await openTurn(session);

    for (const id of ['t1', 't2'] as const) {
      const approval = permissionHandler.canUseTool('Bash', { command: 'echo hi' }, ctx(id));
      await waitFor(() => permissionHandler.hasPendingPrompts());
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
    await waitFor(() => uiOf(session).hasPendingDialogs());
    controller.abort();
    await dialog;
    await finish();

    expect(states(messages)).toEqual(['running', 'requires_action', 'running', 'idle']);
    await session.dispose();
  });

  it('a dialog opened with no turn in flight emits requires_action with no preceding running', async () => {
    const { session, messages } = await startPanel();

    const dialog = uiOf(session).confirm('Sure?', 'really?');
    await waitFor(() => uiOf(session).hasPendingDialogs());
    session.resolveExtensionUiResponse(lastUiRequest(messages).requestId, true);
    await dialog;

    expect(states(messages)).toEqual(['requires_action', 'idle']);
    await session.dispose();
  });

  it('republishes to a reloaded webview, whose fresh store starts at idle', async () => {
    const { session, permissionHandler, messages } = await startPanel();
    const finish = await openTurn(session);

    const approval = permissionHandler.canUseTool('Bash', { command: 'echo hi' }, ctx('t1'));
    await waitFor(() => permissionHandler.hasPendingPrompts());
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
    await waitFor(() => permissionHandler.hasPendingPrompts());
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
    await waitFor(() => permissionHandler.hasPendingPrompts());
    expect(states(messages)).toEqual(['running', 'requires_action']);

    session.cancel();
    controller.abort();
    await approval;
    await waitFor(() => !permissionHandler.hasPendingPrompts());

    // No `running` in between: the turn was already down when the last prompt cleared.
    expect(states(messages)).toEqual(['running', 'requires_action', 'idle']);
    await finish();
    await session.dispose();
  });
});

describe('single-writer discipline', () => {
  /**
   * Both halves of the invariant in `docs/invariants.md` are source-level, so nothing in the type
   * system or the behavioural tests above can hold them. Any file under `src/extension` that deletes
   * from a prompt map directly, or a second site that constructs the message, leaves every test green
   * and the session parked for good.
   */
  it('leaves the permission prompt maps mutable only from state.ts', () => {
    const root = resolve(__dirname, '../..');
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name !== '__tests__') walk(full);
        } else if (entry.name.endsWith('.ts')) files.push(full);
      }
    };
    walk(root);
    expect(files.length).toBeGreaterThan(50);
    expect(files.some((f) => basename(f) === 'approval-manager.ts')).toBe(true);
    expect(files.some((f) => basename(f) === 'diff-manager.ts')).toBe(true);

    const mutation =
      /pending(?:Approvals|Questions|Forms|PlanApprovals|SkillApprovals|Elicitations|PromptRequests)\s*\.\s*(?:set|delete|clear)\b/;
    const allowed = resolve(root, 'permission-handler/state.ts');
    const offenders = files
      .filter((f) => f !== allowed && mutation.test(readFileSync(f, 'utf8')))
      .map((f) => f.slice(root.length + 1).replace(/\\/g, '/'));

    expect(offenders).toEqual([]);
  });

  it('constructs sessionStateChanged in exactly one extension file', () => {
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name !== '__tests__') walk(full);
        } else if (entry.name.endsWith('.ts')) files.push(full);
      }
    };
    walk(resolve(__dirname, '../..'));
    expect(files.length).toBeGreaterThan(50);

    // The trailing comma is what separates a message literal, which must also carry `state` and
    // `sessionId`, from the `Extract<…, { type: 'sessionStateChanged' }>` the state type is read through.
    const emitters = files.filter((f) =>
      /type:\s*['"]sessionStateChanged['"]\s*,/.test(readFileSync(f, 'utf8')),
    );

    expect(emitters.map((f) => basename(f))).toEqual(['pi-session.ts']);
  });
});
