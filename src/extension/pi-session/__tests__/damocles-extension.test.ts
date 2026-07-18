import { describe, it, expect, vi } from 'vitest';
import { createDamoclesExtensionFactory } from '../damocles-extension';
import { CheckpointService, type CheckpointTreeReader } from '../checkpoint-service';
import { DAMOCLES_CHECKPOINT_ENTRY } from '../session-store/constants';
import type { PanelGateContext } from '../permission-gate';

type Handlers = Record<string, (event: unknown, ctx: unknown) => unknown>;

function fakePi(handlers: Handlers): unknown {
  return { on: (event: string, handler: (e: unknown, c: unknown) => unknown) => { handlers[event] = handler; } };
}

/**
 * A pi stub that records EVERY handler per event in registration order and emits them sequentially —
 * mirroring the real `ExtensionRunner.emit` (await each handler in order). Needed for the agent_end
 * ordering test, where two handlers (keep-alive then checkpoint) are registered for the same event and
 * the order is load-bearing. `appendEntry` is a no-op sink for the checkpoint hook's persistence call.
 */
function fakePiMulti(): { pi: unknown; emit: (event: string, e: unknown, ctx: unknown) => Promise<void> } {
  const ordered: Record<string, Array<(e: unknown, c: unknown) => unknown>> = {};
  const pi = {
    on: (event: string, handler: (e: unknown, c: unknown) => unknown) => {
      (ordered[event] ??= []).push(handler);
    },
    appendEntry: () => undefined,
  };
  const emit = async (event: string, e: unknown, ctx: unknown): Promise<void> => {
    for (const handler of ordered[event] ?? []) await handler(e, ctx);
  };
  return { pi, emit };
}

function ctxFor(sessionId: string): unknown {
  return { sessionManager: { getSessionId: () => sessionId }, signal: undefined };
}

function panel(evaluate: 'allow' | 'deny', plan = false): PanelGateContext {
  return {
    permissionHandler: {
      evaluatePermission: vi.fn(async () => evaluate),
      canUseTool: vi.fn(async () => ({ behavior: 'allow', updatedInput: {} })),
    } as unknown as PanelGateContext['permissionHandler'],
    isPlanMode: () => plan,
    getSessionModel: () => 'claude-opus-4-8',
    getSystemPromptEnv: () => ({
      cwd: '/repo',
      model: 'claude-opus-4-8',
      isGitRepo: true,
      platform: 'linux',
      shell: 'bash',
      osVersion: 'Linux test',
      compassEnabled: false,
    }),
    getPlanFilePath: () => '/home/.damocles/plans/plan-test.md',
    postMessage: () => undefined,
    currentPromptIndex: () => 0,
  };
}

const readEvent = { type: 'tool_call', toolName: 'read', toolCallId: 't', input: {} };

describe('createDamoclesExtensionFactory (US-004 routing)', () => {
  it('routes a tool_call to the panel that owns the session id', async () => {
    const handlers: Handlers = {};
    const panelA = panel('allow');
    const panelB = panel('deny');
    const registry = new Map<string, PanelGateContext>([['A', panelA], ['B', panelB]]);
    createDamoclesExtensionFactory({ get: (id) => registry.get(id) })(fakePi(handlers) as never);

    expect(await handlers.tool_call(readEvent, ctxFor('A'))).toBeUndefined();
    expect(panelA.permissionHandler.evaluatePermission).toHaveBeenCalledTimes(1);
    expect(panelB.permissionHandler.evaluatePermission).not.toHaveBeenCalled();

    const blocked = (await handlers.tool_call(readEvent, ctxFor('B'))) as { block?: boolean } | undefined;
    expect(blocked?.block).toBe(true);
  });

  it('no-ops when no panel is registered for the session', async () => {
    const handlers: Handlers = {};
    createDamoclesExtensionFactory({ get: () => undefined })(fakePi(handlers) as never);
    expect(await handlers.tool_call(readEvent, ctxFor('missing'))).toBeUndefined();
  });

  it('returns the Damocles system prompt (replacing pi boilerplate), with plan instruction only in plan mode', async () => {
    const handlers: Handlers = {};
    const planning = new Map<string, PanelGateContext>([['A', panel('allow', true)], ['B', panel('allow', false)]]);
    createDamoclesExtensionFactory({ get: (id) => planning.get(id) })(fakePi(handlers) as never);

    const baseEvent = { type: 'before_agent_start', prompt: 'hi', systemPrompt: 'PI BASE', systemPromptOptions: { cwd: '/repo' } };

    const inPlan = (await handlers.before_agent_start({ ...baseEvent }, ctxFor('A'))) as { systemPrompt: string };
    expect(inPlan.systemPrompt).not.toContain('operating inside pi');
    expect(inPlan.systemPrompt).not.toContain('PI BASE');
    expect(inPlan.systemPrompt).toContain('AI coding agent');
    expect(inPlan.systemPrompt).toContain('Plan mode is active');

    const notPlan = (await handlers.before_agent_start({ ...baseEvent }, ctxFor('B'))) as { systemPrompt: string };
    expect(notPlan.systemPrompt).toContain('AI coding agent');
    expect(notPlan.systemPrompt).not.toContain('Plan mode is active');

    expect(await handlers.before_agent_start({ ...baseEvent }, ctxFor('missing'))).toBeUndefined();
  });
});

describe('agent_end hook ordering (held-continuation dedup invariant)', () => {
  /** Build a CheckpointService with a producer bound to a stub repo and an in-flight turn for `u1`, so
   *  the next `onAgentEnd` would finalize a checkpoint unless a hold deferred it. */
  async function serviceWithPendingTurn(ready: string[]): Promise<{ service: CheckpointService; sm: CheckpointTreeReader }> {
    const service = new CheckpointService({ cwd: '/cwd', onCheckpointReady: (id) => ready.push(id) });
    let seq = 0;
    const repo = {
      async withLock<T>(fn: () => Promise<T>): Promise<T> { return fn(); },
      async ensureReady(): Promise<void> {},
      async checkpoint(): Promise<string> { return `commit-${++seq}`; },
      async stageAll(): Promise<void> {},
      async diffAgainst(): Promise<string> { return ''; },
    };
    const { AutoCheckpointProducer } = await import('../checkpoints/auto-checkpoint');
    const producer = new AutoCheckpointProducer({
      repo: repo as unknown as import('../checkpoints/repo-manager').RepoManager,
      exclude: [],
      createTurnId: () => `turn-${seq}`,
      now: () => new Date('2026-01-01T00:00:00.000Z'),
    });
    (service as unknown as { producer: unknown; gitAvailable: boolean }).producer = producer;
    (service as unknown as { gitAvailable: boolean }).gitAvailable = true;
    // The hooks call `ctx.sessionManager` both as a session-id source (getSessionId) and as the
    // checkpoint tree reader, so this object satisfies both roles.
    const sm: CheckpointTreeReader & { getSessionId: () => string } = {
      getSessionId: () => 'S',
      getBranch: () => [{ type: 'message', id: 'u1', parentId: null, timestamp: '', message: { role: 'user', content: [] } } as never],
      getLeafId: () => 'u1',
      getSessionFile: () => '/sessions/x.jsonl',
      getEntries: () => [],
    };
    await service.onMessageStart({ role: 'assistant', content: [] }, sm);
    return { service, sm };
  }

  /**
   * The load-bearing invariant: the keep-alive `agent_end` hook is registered BEFORE the checkpoint
   * `agent_end` hook, so a `deferNextFinalize()` set during the hold is consumed by the checkpoint hook
   * in the SAME emit. A real emit through the factory (both hooks present) must finalize ZERO checkpoints
   * when the keep-alive hold defers. Swapping the two `pi.on('agent_end')` blocks would finalize before
   * the defer lands and break dedup — this test fails loudly if that ordering ever regresses.
   */
  it('keep-alive hook runs before the checkpoint hook, so a held turn defers finalize in the same emit', async () => {
    const ready: string[] = [];
    const { service, sm } = await serviceWithPendingTurn(ready);

    // A panel whose onAgentEnd holds the turn ONCE (as tryBackgroundKeepAlive / tryPlanModeHold do for a
    // single continuation round) by deferring the checkpoint finalize for that agent_end, then lets the
    // next agent_end settle normally.
    let holds = 1;
    const heldPanel = {
      ...panel('allow'),
      onAgentEnd: vi.fn(async () => { if (holds-- > 0) service.deferNextFinalize(); }),
    } as unknown as PanelGateContext;

    const { pi, emit } = fakePiMulti();
    createDamoclesExtensionFactory(
      { get: () => heldPanel },
      { get: () => service },
    )(pi as never);

    const ctx = { sessionManager: sm, signal: undefined };
    await emit('agent_end', { type: 'agent_end', messages: [] }, ctx);

    // The held continuation deferred finalize → no checkpoint minted this emit.
    expect(ready).toEqual([]);
    expect(heldPanel.onAgentEnd).toHaveBeenCalledTimes(1);

    // The real end of the turn (no hold) finalizes exactly one checkpoint for u1.
    await emit('agent_end', { type: 'agent_end', messages: [] }, ctx);
    expect(ready).toEqual(['u1']);
  });

  it('without a hold, the checkpoint hook finalizes normally on agent_end', async () => {
    const ready: string[] = [];
    const { service, sm } = await serviceWithPendingTurn(ready);

    // A panel that does not hold the turn (onAgentEnd is a no-op).
    const idlePanel = { ...panel('allow'), onAgentEnd: vi.fn(async () => undefined) } as unknown as PanelGateContext;

    const { pi, emit } = fakePiMulti();
    createDamoclesExtensionFactory(
      { get: () => idlePanel },
      { get: () => service },
    )(pi as never);

    await emit('agent_end', { type: 'agent_end', messages: [] }, { sessionManager: sm, signal: undefined });
    expect(ready).toEqual(['u1']);
  });
});

describe('session_compact checkpoint hook', () => {
  /** Records handlers by event AND captures appendEntry persistence so the compaction hook is observable. */
  function fakePiRecording(handlers: Handlers): { pi: unknown; appended: Array<{ type: string; entry: unknown }> } {
    const appended: Array<{ type: string; entry: unknown }> = [];
    const pi = {
      on: (event: string, handler: (e: unknown, c: unknown) => unknown) => { handlers[event] = handler; },
      appendEntry: (type: string, entry: unknown) => { appended.push({ type, entry }); },
    };
    return { pi, appended };
  }

  const compactEvent = { type: 'session_compact', compactionEntry: { id: 'compaction-1' }, fromExtension: false, reason: 'manual', willRetry: false };

  it('routes by session id, calls onSessionCompact(compactionEntry.id, sm), and persists returned entries', async () => {
    const handlers: Handlers = {};
    const { pi, appended } = fakePiRecording(handlers);
    const entry = { v: 2, kind: 'checkpoint', turnId: 'compact-1', userEntryId: 'compaction-1', beforeCommit: 'c', afterCommit: 'c', prompt: '', fileCount: 0, fileChanges: [], createdAt: '' };
    const onSessionCompact = vi.fn(async () => [entry]);
    const service = { onSessionCompact } as unknown as CheckpointService;

    createDamoclesExtensionFactory({ get: () => undefined }, { get: () => service })(pi as never);

    const sm = { getSessionId: () => 'S' };
    await handlers.session_compact(compactEvent, { sessionManager: sm, signal: undefined });

    expect(onSessionCompact).toHaveBeenCalledTimes(1);
    expect(onSessionCompact).toHaveBeenCalledWith('compaction-1', sm);
    expect(appended).toEqual([{ type: DAMOCLES_CHECKPOINT_ENTRY, entry }]);
  });

  it('no-ops when no checkpoint service is registered for the session', async () => {
    const handlers: Handlers = {};
    const { pi, appended } = fakePiRecording(handlers);

    createDamoclesExtensionFactory({ get: () => undefined }, { get: () => undefined })(pi as never);

    await handlers.session_compact(compactEvent, { sessionManager: { getSessionId: () => 'S' }, signal: undefined });
    expect(appended).toEqual([]);
  });

  it('swallows service errors — a throwing onSessionCompact does not escape the hook', async () => {
    const handlers: Handlers = {};
    const { pi, appended } = fakePiRecording(handlers);
    const service = { onSessionCompact: vi.fn(async () => { throw new Error('boom'); }) } as unknown as CheckpointService;

    createDamoclesExtensionFactory({ get: () => undefined }, { get: () => service })(pi as never);

    await expect(
      handlers.session_compact(compactEvent, { sessionManager: { getSessionId: () => 'S' }, signal: undefined }),
    ).resolves.toBeUndefined();
    expect(appended).toEqual([]);
  });
});
