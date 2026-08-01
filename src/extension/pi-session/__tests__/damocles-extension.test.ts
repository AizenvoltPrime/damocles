import { describe, it, expect, vi, afterEach } from 'vitest';
import { createDamoclesExtensionFactory, type PanelRegistryReader } from '../damocles-extension';
import { PiRuntime } from '../pi-runtime';
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

/** A `PanelRegistryReader` over a map (or empty). `values()` exists for the ToolSearch inventory
 *  scope, which has no session id to route by. */
function reader(panels?: Map<string, PanelGateContext>): PanelRegistryReader {
  return { get: (id) => panels?.get(id), values: () => panels?.values() ?? [] };
}

/** A reader that answers with one panel regardless of session id. */
function readerOf(panel: PanelGateContext): PanelRegistryReader {
  return { get: () => panel, values: () => [panel] };
}

describe('createDamoclesExtensionFactory (US-004 routing)', () => {
  it('routes a tool_call to the panel that owns the session id', async () => {
    const handlers: Handlers = {};
    const panelA = panel('allow');
    const panelB = panel('deny');
    const registry = new Map<string, PanelGateContext>([['A', panelA], ['B', panelB]]);
    createDamoclesExtensionFactory(reader(registry))(fakePi(handlers) as never);

    expect(await handlers.tool_call(readEvent, ctxFor('A'))).toBeUndefined();
    expect(panelA.permissionHandler.evaluatePermission).toHaveBeenCalledTimes(1);
    expect(panelB.permissionHandler.evaluatePermission).not.toHaveBeenCalled();

    const blocked = (await handlers.tool_call(readEvent, ctxFor('B'))) as { block?: boolean } | undefined;
    expect(blocked?.block).toBe(true);
  });

  it('no-ops when no panel is registered for the session', async () => {
    const handlers: Handlers = {};
    createDamoclesExtensionFactory(reader())(fakePi(handlers) as never);
    expect(await handlers.tool_call(readEvent, ctxFor('missing'))).toBeUndefined();
  });

  it('returns the Damocles system prompt (replacing pi boilerplate), with plan instruction only in plan mode', async () => {
    const handlers: Handlers = {};
    const planning = new Map<string, PanelGateContext>([['A', panel('allow', true)], ['B', panel('allow', false)]]);
    createDamoclesExtensionFactory(reader(planning))(fakePi(handlers) as never);

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
      readerOf(heldPanel),
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
      readerOf(idlePanel),
      { get: () => service },
    )(pi as never);

    await emit('agent_end', { type: 'agent_end', messages: [] }, { sessionManager: sm, signal: undefined });
    expect(ready).toEqual(['u1']);
  });
});

describe('context image pruning registration', () => {
  const imageHeavy = (count: number) =>
    Array.from({ length: count }, (_, i) => ({
      role: 'toolResult' as const,
      toolCallId: `t${i}`,
      toolName: 'BrowserScreenshot',
      content: [{ type: 'image' as const, data: `d${i}`, mimeType: 'image/png' }],
      isError: false,
      timestamp: 0,
    }));

  it('registers a context handler that returns pruned messages', async () => {
    const handlers: Handlers = {};
    createDamoclesExtensionFactory(reader())(fakePi(handlers) as never);

    expect(typeof handlers.context).toBe('function');
    const result = (await handlers.context({ type: 'context', messages: imageHeavy(7) }, ctxFor('S'))) as {
      messages: Array<{ content: Array<{ type: string; text?: string }> }>;
    };
    const images = result.messages.flatMap((m) => m.content).filter((b) => b.type === 'image');
    expect(images).toHaveLength(4); // 7 − boundary 3
  });

  it('fails soft: a thrown pruning error yields undefined, not a rejection', async () => {
    const handlers: Handlers = {};
    createDamoclesExtensionFactory(reader())(fakePi(handlers) as never);

    // content:null makes the image-counting loop throw; the handler must swallow it and return undefined.
    const bad = [{ role: 'toolResult', toolCallId: 'x', toolName: 'X', content: null, isError: false, timestamp: 0 }];
    expect(await handlers.context({ type: 'context', messages: bad }, ctxFor('S'))).toBeUndefined();
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

    createDamoclesExtensionFactory(reader(), { get: () => service })(pi as never);

    const sm = { getSessionId: () => 'S' };
    await handlers.session_compact(compactEvent, { sessionManager: sm, signal: undefined });

    expect(onSessionCompact).toHaveBeenCalledTimes(1);
    expect(onSessionCompact).toHaveBeenCalledWith('compaction-1', sm);
    expect(appended).toEqual([{ type: DAMOCLES_CHECKPOINT_ENTRY, entry }]);
  });

  it('no-ops when no checkpoint service is registered for the session', async () => {
    const handlers: Handlers = {};
    const { pi, appended } = fakePiRecording(handlers);

    createDamoclesExtensionFactory(reader(), { get: () => undefined })(pi as never);

    await handlers.session_compact(compactEvent, { sessionManager: { getSessionId: () => 'S' }, signal: undefined });
    expect(appended).toEqual([]);
  });

  it('swallows service errors — a throwing onSessionCompact does not escape the hook', async () => {
    const handlers: Handlers = {};
    const { pi, appended } = fakePiRecording(handlers);
    const service = { onSessionCompact: vi.fn(async () => { throw new Error('boom'); }) } as unknown as CheckpointService;

    createDamoclesExtensionFactory(reader(), { get: () => service })(pi as never);

    await expect(
      handlers.session_compact(compactEvent, { sessionManager: { getSessionId: () => 'S' }, signal: undefined }),
    ).resolves.toBeUndefined();
    expect(appended).toEqual([]);
  });
});

/**
 * The panel's ToolSearch inventory scope. This is the wiring layer, and it is the layer where the
 * assumption "the panel cannot know what is enabled" was wrong: enabled-ness (browser/compass/MCP/
 * `tools.disabled`) is a WORKSPACE fact, so any registered panel answers it correctly and the
 * description getter needs no session id at all.
 */
describe('ToolSearch inventory scope (panel wiring)', () => {
  /**
   * A pi stub whose `getAllTools()` behaves like the real one: it MATERIALIZES `description` for every
   * registered tool. That is what turned a description built from `pi.getAllTools()` into unbounded
   * recursion at session start, and a stub returning plain objects hides it completely.
   */
  function piCapturingToolSearch(): {
    pi: unknown;
    tool: () => { description: string } | undefined;
    getAllTools: () => Array<{ name: string; description: string }>;
    /** Every ToolSearch WRAP, in order — the strings pi actually froze. */
    wraps: () => string[];
    registrySize: () => number;
    /** Emit every handler registered for an event, in registration order (as `ExtensionRunner` does). */
    emit: (event: string, e: unknown, ctx?: unknown) => Promise<void>;
    handlerCount: (event: string) => number;
  } {
    const registered = new Map<string, { name: string; description: string }>();
    const ordered: Record<string, Array<(e: unknown, c: unknown) => unknown>> = {};
    const wraps: string[] = [];
    let captured: { name: string; description: string } | undefined;
    const getAllTools = () => [...registered.values()].map((t) => ({ name: t.name, description: t.description }));
    const pi = {
      // Records handlers so the lifecycle tests can drive `session_shutdown` through the SAME stub that
      // owns `registerTool` — publish and retirement are two halves of one flow.
      on: (event: string, handler: (e: unknown, c: unknown) => unknown) => {
        (ordered[event] ??= []).push(handler);
      },
      getAllTools,
      // Faithful to `wrapToolDefinition`: `description` is READ ONCE here and stored as a plain string.
      // A fake that kept the live definition would make a frozen description indistinguishable from a
      // fresh one, and every staleness assertion built on it would be vacuous.
      registerTool: (t: { name: string; description: string }) => {
        registered.set(t.name, { name: t.name, description: t.description });
        if (t.name === 'ToolSearch') {
          wraps.push(t.description);
          captured = t;
        }
      },
    };
    const emit = async (event: string, e: unknown, ctx: unknown = ctxFor('S')): Promise<void> => {
      for (const handler of ordered[event] ?? []) await handler(e, ctx);
    };
    return {
      pi,
      tool: () => captured,
      getAllTools,
      wraps: () => [...wraps],
      registrySize: () => registered.size,
      emit,
      handlerCount: (event: string) => (ordered[event] ?? []).length,
    };
  }

  const panelWith = (names: string[]): PanelGateContext =>
    ({ deferrableTools: () => ({ names, loaded: new Set<string>(), mcpGroups: new Map() }) }) as unknown as PanelGateContext;

  it('advertises only the tools the workspace actually has enabled', () => {
    const { pi, tool } = piCapturingToolSearch();
    createDamoclesExtensionFactory(readerOf(panelWith(['BrowserOpen', 'BrowserClick'])))(pi as never);

    const description = tool()!.description;
    expect(description).toContain('BrowserOpen');
    expect(description).not.toContain('compass');
    expect(description).not.toContain('CompassSearch');
  });

  it('tracks a mid-session toggle, because the scope is read per description access', () => {
    const { pi, tool } = piCapturingToolSearch();
    let names = ['BrowserOpen', 'CompassSearch'];
    const panel = { deferrableTools: () => ({ names, loaded: new Set<string>(), mcpGroups: new Map() }) } as unknown as PanelGateContext;
    createDamoclesExtensionFactory(readerOf(panel))(pi as never);

    expect(tool()!.description).toContain('CompassSearch');
    names = ['BrowserOpen'];
    expect(tool()!.description).not.toContain('CompassSearch');
  });

  it('lists everything when no panel has registered yet (nothing to scope to)', () => {
    const { pi, tool } = piCapturingToolSearch();
    createDamoclesExtensionFactory(reader())(pi as never);

    expect(tool()!.description).toContain('BrowserOpen');
    expect(tool()!.description).toContain('CompassSearch');
    // "Everything" means every built-in group, `web` included — the fail-open policy. With no panel there
    // is no inventory to scope to, and hiding a group would make a loadable tool undiscoverable.
    expect(tool()!.description).toContain('WebSearch');
  });

  /**
   * pi WRAPS a registered definition by copying `description` as a plain string
   * (`wrapToolDefinition`), so the model reads the inventory captured at the LAST WRAP, not a live
   * getter. Live F5 caught this: with the browser disabled mid-session, ToolSearch still advertised
   * `browser (25)`. Re-registering the same definition is the only public way to ask pi to re-wrap, so
   * these pin BOTH halves — that a republish callback is published, and that calling it re-materializes
   * the description against the CURRENT inventory.
   */
  it('publishes a republish callback that re-materializes the description', () => {
    const { pi, wraps } = piCapturingToolSearch();
    let names = ['BrowserOpen', 'CompassSearch'];
    const panel = { deferrableTools: () => ({ names, loaded: new Set<string>(), mcpGroups: new Map() }) } as unknown as PanelGateContext;
    let republish: (() => void) | undefined;
    createDamoclesExtensionFactory(readerOf(panel), reader(), undefined, undefined, (fn) => { republish = fn; })(pi as never);

    expect(wraps()).toHaveLength(1);
    expect(wraps()[0]).toContain('CompassSearch');

    // A toggle changes the inventory but CANNOT change what pi already froze.
    names = ['BrowserOpen'];
    expect(wraps()).toHaveLength(1);
    expect(wraps()[0]).toContain('CompassSearch');

    republish!();

    // A second wrap exists, and it reflects the inventory as of now — this is the whole fix.
    expect(wraps()).toHaveLength(2);
    expect(wraps()[1]).not.toContain('CompassSearch');
    expect(wraps()[1]).toContain('BrowserOpen');
  });

  it('republishing re-registers the SAME definition under one registry entry', () => {
    // Two distinct hazards: pi must not end up with a second ToolSearch entry, and the definition
    // handed over must stay the object the active set and any in-flight call are bound to.
    const { pi, tool, registrySize, wraps } = piCapturingToolSearch();
    let republish: (() => void) | undefined;
    createDamoclesExtensionFactory(readerOf(panelWith(['BrowserOpen'])), reader(), undefined, undefined, (fn) => { republish = fn; })(pi as never);

    const first = tool();
    const sizeAfterFirst = registrySize();
    republish!();

    expect(wraps()).toHaveLength(2);
    expect(registrySize()).toBe(sizeAfterFirst);
    expect(tool()).toBe(first);
  });

  /**
   * The shipped crash: reading the registered ToolSearch's description through a registry that
   * materializes every tool's description recursed until the stack overflowed, so `pi failed to start:
   * Maximum call stack size exceeded` on every session. This drives the REAL panel wiring, which is
   * where it happened — the unit-level guard alone would not have covered the wiring.
   */
  it('does not recurse when pi materializes every registered tool description', () => {
    const { pi, getAllTools } = piCapturingToolSearch();
    createDamoclesExtensionFactory(readerOf(panelWith(['BrowserOpen'])))(pi as never);

    expect(() => getAllTools()).not.toThrow();
    expect(getAllTools().find((t) => t.name === 'ToolSearch')!.description).toContain('BrowserOpen');
  });

  /**
   * Republisher LIFETIME. Both ends matter: registering too late makes every session's first republish a
   * silent no-op, and never disposing leaves an orphan that keeps "succeeding" against nothing.
   */
  describe('republisher registration and retirement', () => {
    /** Stands in for `PiRuntime.registerToolSearchRepublisher`: records the closure, returns a disposer. */
    function republisherSeam(): {
      onToolSearchRepublish: (republish: () => void) => () => void;
      registered: () => Array<() => void>;
      disposeCalls: () => number;
    } {
      const registered: Array<() => void> = [];
      let disposeCalls = 0;
      return {
        onToolSearchRepublish: (republish) => {
          registered.push(republish);
          return () => { disposeCalls++; };
        },
        registered: () => [...registered],
        disposeCalls: () => disposeCalls,
      };
    }

    const build = (seam: ReturnType<typeof republisherSeam>) => {
      const capture = piCapturingToolSearch();
      createDamoclesExtensionFactory(
        readerOf(panelWith(['BrowserOpen'])),
        reader(),
        undefined,
        undefined,
        seam.onToolSearchRepublish,
      )(capture.pi as never);
      return capture;
    };

    it('registers at FACTORY TIME — synchronously, before any session event is emitted', () => {
      // Registration MUST NOT move to `session_start`: `bindExtensions` is fire-and-forget, so it lands a
      // microtask AFTER `bindSession` already ran `refreshActiveTools` → `republishToolSearch`. Every
      // session's first republish would fire against an empty registry — silent, worse than the bug.
      const seam = republisherSeam();
      const { wraps } = build(seam);

      // No event has been emitted yet: the factory call alone is the whole precondition.
      expect(seam.registered()).toHaveLength(1);
      // ...and the initial publish already happened, so a republish is a RE-wrap, not the first one.
      expect(wraps()).toHaveLength(1);
      expect(seam.disposeCalls()).toBe(0);
    });

    it('the registered closure is the real republisher: calling it re-wraps ToolSearch', () => {
      // Guards against handing the seam an unrelated function: one that never re-materializes the
      // description would satisfy every count assertion and fix nothing.
      const seam = republisherSeam();
      const { wraps } = build(seam);

      seam.registered()[0]();

      expect(wraps()).toHaveLength(2);
      expect(wraps()[1]).toContain('BrowserOpen');
    });

    it('disposes its republisher on session_shutdown', async () => {
      const seam = republisherSeam();
      const { emit } = build(seam);

      expect(seam.disposeCalls()).toBe(0);
      await emit('session_shutdown', { type: 'session_shutdown', reason: 'quit' });

      expect(seam.disposeCalls()).toBe(1);
    });

    it("disposes on reason 'reload' too — the silent orphan exception-pruning can never see", async () => {
      // THE case this slice exists for. `AgentSession.reload()` emits `session_shutdown` with
      // `reason: 'reload'`, re-runs this factory against a fresh runtime and rebinds — but does NOT
      // invalidate the outgoing runtime. The orphaned instance's `registerTool` therefore keeps
      // SUCCEEDING into an extension object no live session references: it never throws, so the old
      // delete-on-throw scheme could never prune it, and it silently did nothing forever.
      // `hooks/index.ts` skips `'reload'` for user-facing hooks; copying that skip here would
      // reintroduce exactly this orphan. If someone "unifies" the two, this test goes red.
      const seam = republisherSeam();
      const { emit } = build(seam);

      await emit('session_shutdown', { type: 'session_shutdown', reason: 'reload' });

      expect(seam.disposeCalls()).toBe(1);
    });

    it('disposes for every other shutdown reason as well', async () => {
      for (const reason of ['quit', 'reload', 'new', 'resume', 'fork'] as const) {
        const seam = republisherSeam();
        const { emit } = build(seam);
        await emit('session_shutdown', { type: 'session_shutdown', reason });
        expect(seam.disposeCalls(), `reason: ${reason}`).toBe(1);
      }
    });

    it('a repeated shutdown does not dispose twice', async () => {
      // pi can emit shutdown for a replacement and again on teardown. The disposer removes by closure
      // identity, so a second call could evict a re-registered peer's entry if ownership were sloppy.
      const seam = republisherSeam();
      const { emit } = build(seam);

      await emit('session_shutdown', { type: 'session_shutdown', reason: 'new' });
      await emit('session_shutdown', { type: 'session_shutdown', reason: 'quit' });

      expect(seam.disposeCalls()).toBe(1);
    });

    it('shutdown is inert when no republisher seam was supplied', async () => {
      // `onToolSearchRepublish` is optional (subagent/test wiring omits it). No disposer exists, so the
      // handler must be a no-op rather than throwing through pi's emit loop.
      const { pi, emit } = piCapturingToolSearch();
      createDamoclesExtensionFactory(readerOf(panelWith(['BrowserOpen'])))(pi as never);

      await expect(emit('session_shutdown', { type: 'session_shutdown', reason: 'quit' })).resolves.toBeUndefined();
    });

    it('registers exactly ONE session_shutdown handler when no hooks are wired', () => {
      // The republisher teardown must be the only listener on this event when `registerConfiguredHooks`
      // is absent. A second one would mean the factory ran twice against one runtime — which would also
      // register a second republisher, putting two entries in the runtime's set for one live instance
      // and leaving one of them behind when the instance retires itself.
      const seam = republisherSeam();
      const { handlerCount } = build(seam);

      expect(handlerCount('session_shutdown')).toBe(1);
    });

    it('does not register a republisher when the initial publish throws', () => {
      // Registration is deliberately conditional on the first `registerTool` succeeding. Registering
      // regardless would seat a closure in the runtime's set that re-throws on every settings toggle for
      // the life of the window, and the per-call catch in `republishToolSearch` would log it every time.
      const seam = republisherSeam();
      const pi = {
        on: () => undefined,
        getAllTools: () => [],
        registerTool: () => { throw new Error('extension ctx is stale'); },
      };

      expect(() =>
        createDamoclesExtensionFactory(
          readerOf(panelWith(['BrowserOpen'])),
          reader(),
          undefined,
          undefined,
          seam.onToolSearchRepublish,
        )(pi as never),
      ).not.toThrow();

      expect(seam.registered()).toEqual([]);
    });
  });

  /**
   * The two halves joined. Everything above tests the extension against a fake seam and
   * `pi-runtime.test.ts` tests `PiRuntime` against fake closures, so a mismatch at the join — the
   * extension registering one closure and retiring a different one, or the runtime never seeing the
   * retirement — would pass both suites while reproducing the original bug exactly.
   */
  describe('republisher wiring end to end (real PiRuntime)', () => {
    afterEach(async () => {
      await PiRuntime.disposeInstance();
    });

    it('a retired instance produces NO further wrap when the runtime republishes', async () => {
      const runtime = PiRuntime.get('/tmp/ws');
      const { pi, wraps, emit } = piCapturingToolSearch();
      let names = ['BrowserOpen', 'CompassSearch'];
      const panel = { deferrableTools: () => ({ names, loaded: new Set<string>(), mcpGroups: new Map() }) } as unknown as PanelGateContext;

      createDamoclesExtensionFactory(
        readerOf(panel),
        reader(),
        undefined,
        undefined,
        (republish) => runtime.registerToolSearchRepublisher(republish),
      )(pi as never);

      // Ordering, not just identity: each wrap must carry the inventory as of the moment it happened.
      // The factory-time publish froze the compass entry; the runtime-driven republish must not.
      expect(wraps()).toHaveLength(1);
      expect(wraps()[0]).toContain('CompassSearch');

      names = ['BrowserOpen'];
      runtime.republishToolSearch();
      expect(wraps()).toHaveLength(2);
      expect(wraps()[1]).not.toContain('CompassSearch');
      expect(wraps()[1]).toContain('BrowserOpen');

      await emit('session_shutdown', { type: 'session_shutdown', reason: 'reload' });

      // The whole point: once the instance has retired itself, the runtime holds nothing that can wrap
      // ToolSearch again. Before v2.18.0 this produced a third wrap into an unreferenced runtime, for
      // the rest of the window, on every single toggle.
      runtime.republishToolSearch();
      expect(wraps()).toHaveLength(2);
    });
  });
});
