import { describe, it, expect, vi } from 'vitest';
import { createDamoclesExtensionFactory, type CheckpointRegistryReader, type PanelRegistryReader, type HooksWiring } from '../damocles-extension';
import { createSubagentExtensionFactory, type SubagentGateContext } from '../subagents/subagent-extension-factory';
import type { HooksConfigService } from '../hooks/config';
import type { PanelGateContext } from '../permission-gate';
import type { CheckpointService } from '../checkpoint-service';

type Handler = (event: unknown, ctx: unknown) => unknown;

/**
 * A pi stub faithful to three properties of `ExtensionRunner` that this file is about: `on` returns the
 * unsubscribe (`extensions/loader.ts:202-219`), a dispatch runs against a `.slice()` snapshot taken
 * before the first handler (`extensions/runner.ts`, `snapshotEventHandlers`), and a `tool_call` is
 * skipped outright when the handler list is empty (`agent-session.ts`, `beforeToolCall` consults
 * `hasHandlers('tool_call')` and treats a miss as proceed). That last one is why an emptied handler map
 * is an ungated session rather than a blocked one, and `emitToolCall` is what the gate assertions ride.
 */
function fakePi(): {
  api: unknown;
  emit: (event: string, payload?: unknown, ctx?: unknown) => Promise<unknown[]>;
  emitToolCall: (payload: unknown, ctx: unknown) => Promise<unknown>;
  liveEvents: () => string[];
  liveCount: () => number;
} {
  const handlers = new Map<string, Handler[]>();
  const api = {
    on: (event: string, handler: Handler) => {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
      return () => {
        const current = handlers.get(event);
        if (!current) return;
        const index = current.indexOf(handler);
        if (index === -1) return;
        current.splice(index, 1);
        if (current.length === 0) handlers.delete(event);
      };
    },
    registerTool: () => undefined,
    appendEntry: () => undefined,
    getAllTools: () => [],
    getActiveTools: () => [],
    setActiveTools: () => undefined,
  };
  const emit = async (event: string, payload: unknown = { type: event }, ctx: unknown = ctxFor('s1')): Promise<unknown[]> => {
    const results: unknown[] = [];
    for (const handler of handlers.get(event)?.slice() ?? []) results.push(await handler(payload, ctx));
    return results;
  };
  // `beforeToolCall`: no handlers means pi never asks, and the tool proceeds.
  const emitToolCall = async (payload: unknown, ctx: unknown): Promise<unknown> => {
    const snapshot = handlers.get('tool_call')?.slice() ?? [];
    if (snapshot.length === 0) return undefined;
    let result: unknown;
    for (const handler of snapshot) {
      const handlerResult = await handler(payload, ctx);
      if (handlerResult) {
        result = handlerResult;
        if ((handlerResult as { block?: boolean }).block) return result;
      }
    }
    return result;
  };
  return {
    api,
    emit,
    emitToolCall,
    liveEvents: () => [...handlers.keys()].sort(),
    liveCount: () => [...handlers.values()].reduce((total, list) => total + list.length, 0),
  };
}

function ctxFor(sessionId: string): unknown {
  return {
    cwd: '/repo',
    signal: undefined,
    sessionManager: { getSessionId: () => sessionId, getSessionFile: () => '/t.jsonl' },
  };
}

/** Every event either factory registers a handler for, so a post-shutdown sweep can dispatch them all. */
const ALL_EVENTS = [
  'cache_warming_decision',
  'session_shutdown',
  'session_start',
  'tool_call',
  'tool_result',
  'input',
  'before_agent_start',
  'agent_end',
  'message_start',
  'message_end',
  'turn_start',
  'turn_end',
  'agent_start',
  'agent_before_settle',
  'agent_settled',
  'session_compact',
  'session_before_compact',
  'session_before_switch',
  'session_before_fork',
  'session_before_tree',
  'model_select',
  'thinking_level_select',
  'resources_discover',
];

const PAYLOADS: Record<string, unknown> = {
  tool_call: { type: 'tool_call', toolName: 'read', toolCallId: 't1', input: {} },
  tool_result: { type: 'tool_result', toolCallId: 't1', toolName: 'read', input: {}, content: [], isError: false, details: undefined },
  input: { type: 'input', source: 'interactive', text: 'hi' },
  // pi normalizes the options before emitting, so `selectedTools` and `sections` are always present.
  before_agent_start: {
    type: 'before_agent_start',
    prompt: 'hi',
    systemPrompt: '',
    systemPromptOptions: { selectedTools: ['read', 'bash', 'edit', 'write'], sections: {} },
  },
  agent_end: { type: 'agent_end', messages: [] },
  agent_before_settle: { type: 'agent_before_settle', entries: [], continue: false },
  message_start: { type: 'message_start', message: { role: 'assistant', content: [] } },
  session_start: { type: 'session_start', reason: 'new' },
  session_shutdown: { type: 'session_shutdown', reason: 'quit' },
  session_compact: { type: 'session_compact', compactionEntry: { id: 'c1' }, reason: 'manual', willRetry: false, fromExtension: false },
  session_before_compact: { type: 'session_before_compact', reason: 'manual', willRetry: false },
  cache_warming_decision: { type: 'cache_warming_decision', warmCost: 0.07, missCost: 1.5, continuationProbability: 1, action: 'warm' },
};

function payloadFor(event: string): unknown {
  return PAYLOADS[event] ?? { type: event };
}

/** Dispatch every event once for one session and return how many handlers ran in total. */
async function sweep(
  emit: (event: string, payload?: unknown, ctx?: unknown) => Promise<unknown[]>,
  sessionId: string,
): Promise<number> {
  let ran = 0;
  for (const event of ALL_EVENTS) ran += (await emit(event, payloadFor(event), ctxFor(sessionId))).length;
  return ran;
}

function fakePanel(): PanelGateContext & { onBeforeSettle: ReturnType<typeof vi.fn> } {
  return {
    permissionHandler: {
      evaluatePermission: vi.fn(async () => 'allow'),
      canUseTool: vi.fn(async () => ({ behavior: 'allow', updatedInput: {} })),
    } as unknown as PanelGateContext['permissionHandler'],
    isPlanMode: () => false,
    getSessionModel: () => 'claude-opus-4-8',
    getSystemPromptEnv: () => ({
      cwd: '/repo',
      model: 'claude-opus-4-8',
      isGitRepo: true,
      platform: 'linux',
      shell: 'bash',
      osVersion: 'Linux test',
      compassEnabled: false,
      thinkingDisabled: false,
    }),
    getPlanFilePath: () => '/plans/plan.md',
    postMessage: vi.fn(),
    currentPromptIndex: () => 0,
    budgetStopRequested: () => false,
    onBeforeSettle: vi.fn(async () => undefined),
  };
}

/** Hooks wiring with no configured entries: the handlers still register, which is what is under test. */
function hooksWiring(): HooksWiring {
  return {
    config: { getEntries: () => [], hasEntries: () => false } as unknown as HooksConfigService,
    workspaceRoot: '/repo',
    userHome: '/home/u',
    renameSession: async () => undefined,
  };
}

/**
 * One extension instance over live, session-keyed registries, so a test can register and unregister
 * sessions on it the way `PiSession.bindSession` and `PiSession.dispose` do to `PiRuntime`.
 */
function buildPanelExtension(): ReturnType<typeof fakePi> & {
  panels: Map<string, PanelGateContext>;
  checkpointServices: Map<string, CheckpointService>;
  disposeCalls: () => number;
} {
  const pi = fakePi();
  const panels = new Map<string, PanelGateContext>();
  const checkpointServices = new Map<string, CheckpointService>();
  const registry: PanelRegistryReader = { get: (id) => panels.get(id), values: () => panels.values() };
  const checkpoints: CheckpointRegistryReader = { get: (id) => checkpointServices.get(id) };
  let disposeCalls = 0;
  createDamoclesExtensionFactory(
    registry,
    checkpoints,
    undefined,
    hooksWiring(),
    () => () => { disposeCalls++; },
  )(pi.api as never);
  return { ...pi, panels, checkpointServices, disposeCalls: () => disposeCalls };
}

function buildSubagentExtension(): ReturnType<typeof fakePi> & { gate: ReturnType<typeof vi.fn> } {
  const pi = fakePi();
  const gate = vi.fn(async () => 'allow');
  const ctx: SubagentGateContext = {
    permissionHandler: {
      evaluatePermission: gate,
      canUseTool: vi.fn(async () => ({ behavior: 'allow', updatedInput: {} })),
    } as unknown as SubagentGateContext['permissionHandler'],
    isPlanMode: () => false,
    parentToolUseId: 'call-1',
    deferrableToolNames: [],
    hooks: { config: { getEntries: () => [], hasEntries: () => false } as unknown as HooksConfigService, workspaceRoot: '/repo', userHome: '/home/u' },
  };
  createSubagentExtensionFactory(ctx)(pi.api as never);
  return { ...pi, gate };
}

describe('the shared extension instance outlives the sessions bound to it', () => {
  it('gates a new session bound to the instance a previous session shut down', async () => {
    // The H1 sequence. `prepareSessionExtensions()` reloads the resource loader before each session
    // binds, but its catch binds whatever the loader still holds, and `ResourceLoader.getExtensions()`
    // hands back the cached result unchanged when the reload threw. So the session that follows a
    // shutdown can be the same instance the shutdown just visited.
    const pi = buildPanelExtension();
    const first = fakePanel();
    pi.panels.set('session-A', first);

    await pi.emitToolCall(payloadFor('tool_call'), ctxFor('session-A'));
    expect(first.permissionHandler.evaluatePermission).toHaveBeenCalledTimes(1);

    await pi.emit('session_shutdown', { type: 'session_shutdown', reason: 'new' }, ctxFor('session-A'));
    pi.panels.delete('session-A');

    const second = fakePanel();
    const secondCheckpoints = { onMessageStart: vi.fn(async () => []) } as unknown as CheckpointService;
    pi.panels.set('session-B', second);
    pi.checkpointServices.set('session-B', secondCheckpoints);

    // All four of the things the instance owes a bound session, not just the gate.
    await pi.emitToolCall(payloadFor('tool_call'), ctxFor('session-B'));
    // The options must carry what pi's normalization guarantees: `sections`, which
    // `buildAgentStartResult` rewrites in place, and `selectedTools`, which it reads. Omitting either
    // would leave this asserting the handler's caught-exception path rather than its success path.
    const startEvent = {
      type: 'before_agent_start',
      prompt: 'hi',
      systemPrompt: '',
      systemPromptOptions: { selectedTools: ['read'], sections: {} } as Record<string, unknown>,
    };
    await pi.emit('before_agent_start', startEvent, ctxFor('session-B'));
    await pi.emit('message_start', payloadFor('message_start'), ctxFor('session-B'));
    const hookResults = await pi.emit('input', payloadFor('input'), ctxFor('session-B'));

    expect(second.permissionHandler.evaluatePermission).toHaveBeenCalledTimes(1);
    expect(startEvent.systemPromptOptions.customPrompt).toEqual(expect.any(String));
    expect(secondCheckpoints.onMessageStart).toHaveBeenCalledTimes(1);
    expect(hookResults).toHaveLength(1);
    // The old session's panel is not consulted for the new session's call.
    expect(first.permissionHandler.evaluatePermission).toHaveBeenCalledTimes(1);
  });

  it('keeps serving a second live session after the first one shuts down', async () => {
    // Two panels share one instance whenever the per-session reload did not mint a fresh one. Closing
    // the first must not touch the second: `session_shutdown` carries no session id, so an instance-wide
    // response to it cannot tell the two apart.
    const pi = buildPanelExtension();
    const a = fakePanel();
    const b = fakePanel();
    pi.panels.set('session-A', a);
    pi.panels.set('session-B', b);

    await pi.emit('session_shutdown', { type: 'session_shutdown', reason: 'quit' }, ctxFor('session-A'));
    pi.panels.delete('session-A');

    await pi.emitToolCall(payloadFor('tool_call'), ctxFor('session-B'));
    await pi.emit('agent_before_settle', payloadFor('agent_before_settle'), ctxFor('session-B'));

    expect(b.permissionHandler.evaluatePermission).toHaveBeenCalledTimes(1);
    expect(b.onBeforeSettle).toHaveBeenCalledTimes(1);
    expect(a.onBeforeSettle).not.toHaveBeenCalled();
  });

  it('leaves every handler registered through a shutdown, whatever the reason', async () => {
    for (const reason of ['quit', 'reload', 'new', 'resume', 'fork'] as const) {
      const pi = buildPanelExtension();
      const panel = fakePanel();
      pi.panels.set('session-A', panel);
      const before = pi.liveCount();
      expect(before).toBeGreaterThan(20);

      await pi.emit('session_shutdown', { type: 'session_shutdown', reason }, ctxFor('session-A'));

      expect(pi.liveCount(), `reason: ${reason}`).toBe(before);
      expect(await sweep(pi.emit, 'session-A'), `reason: ${reason}`).toBe(before);
    }
  });

  it('retires the ToolSearch republisher on shutdown, which the handlers do not share', async () => {
    // The republisher is registered in a `PiRuntime`-owned set that outlives the extension object, so
    // it is the one thing a shutdown must retire. The handlers live and die with the instance itself.
    const pi = buildPanelExtension();

    await pi.emit('session_shutdown', { type: 'session_shutdown', reason: 'quit' }, ctxFor('session-A'));

    expect(pi.disposeCalls()).toBe(1);
    expect(pi.liveEvents()).toContain('tool_call');
  });
});

describe('a tool call with no registered panel', () => {
  it('blocks a write, because no panel means no approval authority', async () => {
    // Only main panel sessions dispatch into this instance: btw, team and subagent sessions each get
    // their own services and their own factory from `PiRuntime.createSubagentSession`. So a missing
    // registry entry is a session whose owner is gone, not a session kind that runs ungated.
    const pi = buildPanelExtension();

    const decision = await pi.emitToolCall(
      { type: 'tool_call', toolName: 'write', toolCallId: 't1', input: { path: '/repo/x.txt', content: 'x' } },
      ctxFor('unregistered'),
    );

    expect(decision).toMatchObject({ block: true });
  });

  it('lets a read through, matching the gate-error fallback it shares', async () => {
    const pi = buildPanelExtension();

    const decision = await pi.emitToolCall(payloadFor('tool_call'), ctxFor('unregistered'));

    expect(decision).toBeUndefined();
  });
});

describe('mid-dispatch shutdown', () => {
  it('does not cut the rest of that dispatch short, nor the dispatches after it', async () => {
    const pi = buildPanelExtension();
    const panel = fakePanel();
    pi.panels.set('session-A', panel);

    const during = await pi.emit('session_shutdown', { type: 'session_shutdown', reason: 'quit' }, ctxFor('session-A'));
    expect(during).toHaveLength(2);

    const after = await pi.emit('session_shutdown', { type: 'session_shutdown', reason: 'quit' }, ctxFor('session-A'));
    expect(after).toHaveLength(2);
  });

  it('still mints the turn checkpoint for a session the shutdown did not belong to', async () => {
    // A shutdown raised from inside the continuation hold belongs to whichever session is being
    // replaced, and must not stop the checkpoint handler from finishing the turn it was dispatched for.
    const pi = buildPanelExtension();
    const panel = fakePanel();
    const checkpoint = { onSettled: vi.fn(async () => []) } as unknown as CheckpointService;
    pi.panels.set('session-A', panel);
    pi.checkpointServices.set('session-A', checkpoint);
    panel.onBeforeSettle.mockImplementation(async () => {
      await pi.emit('session_shutdown', { type: 'session_shutdown', reason: 'new' }, ctxFor('session-A'));
      return undefined;
    });

    await pi.emit('agent_before_settle', payloadFor('agent_before_settle'), ctxFor('session-A'));
    await pi.emit('agent_settled', payloadFor('agent_settled'), ctxFor('session-A'));

    expect(panel.onBeforeSettle).toHaveBeenCalledTimes(1);
    expect(checkpoint.onSettled).toHaveBeenCalledTimes(1);
  });
});

describe('the per-subagent extension instance', () => {
  it('registers no shutdown handler, having one session for its whole life', async () => {
    // `createSubagentSession` builds each spawn its own services and resource loader, and disposes the
    // session directly rather than through an `AgentSessionRuntime`, so pi never emits a shutdown here.
    const pi = buildSubagentExtension();

    expect(pi.liveEvents()).not.toContain('session_shutdown');
  });

  it('keeps gating after an unrelated shutdown reaches the instance', async () => {
    const pi = buildSubagentExtension();

    expect(await pi.emitToolCall(payloadFor('tool_call'), ctxFor('sub-1'))).toBeUndefined();
    expect(pi.gate).toHaveBeenCalledTimes(1);

    await pi.emit('session_shutdown', { type: 'session_shutdown', reason: 'quit' }, ctxFor('sub-1'));

    await pi.emitToolCall(payloadFor('tool_call'), ctxFor('sub-1'));
    expect(pi.gate).toHaveBeenCalledTimes(2);
  });
});
