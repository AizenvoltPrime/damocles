import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';
import { ExtensionRunner } from '@earendil-works/pi-coding-agent';
import { McpClientManager } from '../mcp/mcp-client-manager';
import type { McpServerManager, ServerConnection, McpServerManagerOptions } from '../mcp/server-manager';
import type { McpElicitationHandler, McpTool } from '../mcp/types';
import type { ElicitationUI } from '../mcp/elicitation-handler';
import { buildMcpPiTool, buildNestedMcpToolset } from '../tools/mcp-tools';
import { WebviewExtensionUIContext } from '../extension-ui-context';
import type { PiCodingAgentModule } from '../pi-loader';
import type { ExtensionToWebviewMessage } from '../../../shared/types/messages';
import { createExtensionUiHandlers } from '@/composables/message-handler/handlers/extension-ui-handlers';
import type { HandlerContext } from '@/composables/message-handler/types';
import { useExtensionUiStore } from '@/stores/useExtensionUiStore';

/**
 * Slice 2 — nested MCP elicitation, end to end, with NOTHING faked between the tool definition and the
 * webview store.
 *
 * What is real here: `McpClientManager` (its `routeElicitation`, its `activeCallUis` bookkeeping and
 * its `callTool`), `buildMcpPiTool` / `buildNestedMcpToolset`, `createElicitationHandler`'s form
 * renderer, `WebviewExtensionUIContext` + `forAgent`, the webview's `extensionUiRequest` /
 * `extensionUiCancel` handlers, and the `useExtensionUiStore` queue. What is faked: the MCP TRANSPORT
 * (`McpServerManager`) — i.e. the network — and pi's `defineTool` (identity), the same two seams
 * `mcp-client-manager.test.ts` and `nested-mcp-toolset.test.ts` already use.
 *
 * The execution context is pi's OWN `ExtensionRunner.createContext()`, not a hand-written stub. That
 * matters more than anything else in this file: the bug being fixed is that `ctx.ui` is TRUTHY when
 * there is no UI, because pi hands every unbound session `noOpUIContext`. A stubbed `ctx` would let a
 * test author decide that fact instead of pi deciding it, and the defect would be invisible again.
 */

const piStub = { defineTool: (tool: unknown) => tool } as unknown as PiCodingAgentModule;

type UiRequest = Extract<ExtensionToWebviewMessage, { type: 'extensionUiRequest' }>;
type ElicitationResult = { action: string; content?: Record<string, unknown> };
type ExecuteFn = (
  id: string,
  params: unknown,
  signal: AbortSignal | undefined,
  onUpdate: undefined,
  ctx: unknown,
) => Promise<{ content: Array<{ type: string; text?: string }>; details?: { isError?: boolean } }>;

const PATH_FORM = {
  message: 'Which path should I read?',
  requestedSchema: { type: 'object', properties: { path: { type: 'string', title: 'Path' } }, required: ['path'] },
};

/** A fake MCP TRANSPORT (the network), modelled on `mcp/__tests__/mcp-client-manager.test.ts`. */
function fakeTransport(servers: Record<string, { tools: McpTool[] }>) {
  const connections = new Map<string, ServerConnection>();
  let elicitationHandler: McpElicitationHandler | undefined;
  const connect = vi.fn(async (name: string) => {
    const conn = {
      tools: servers[name]?.tools ?? [],
      resources: [],
      status: 'connected',
      serverInfo: { name, version: '1.0.0' },
      inFlight: 0,
      lastUsedAt: 0,
    } as unknown as ServerConnection;
    connections.set(name, conn);
    return conn;
  });
  const callTool = vi.fn(async (_server: string, _tool: string, _args?: unknown, _opts?: unknown) => ({
    content: [{ type: 'text', text: 'ok' }],
    isError: false,
  }));
  const fake = {
    connect,
    callTool,
    readResource: vi.fn(),
    getConnection: (n: string) => connections.get(n),
    getAllConnections: () => new Map(connections),
    close: vi.fn(async (n: string) => { connections.delete(n); }),
    closeAll: vi.fn(async () => connections.clear()),
    isIdle: () => false,
    setElicitationHandler: vi.fn((h: McpElicitationHandler | undefined) => { elicitationHandler = h; }),
    touch: vi.fn(),
    incrementInFlight: vi.fn(),
    decrementInFlight: vi.fn(),
  };
  return {
    fake,
    factory: (opts: McpServerManagerOptions): McpServerManager => {
      void opts;
      return fake as unknown as McpServerManager;
    },
    /** The handler the REAL manager installed — this is `routeElicitation` itself. */
    elicit: (params: unknown, serverName: string): Promise<ElicitationResult> =>
      elicitationHandler!(params, serverName) as Promise<ElicitationResult>,
  };
}

/** The parent panel: extension-side UI bridge wired to the REAL webview handler + store. */
function panel() {
  const store = useExtensionUiStore();
  const handlers = createExtensionUiHandlers();
  const ctx = { stores: { extensionUiStore: store } } as unknown as HandlerContext;
  const emitted: ExtensionToWebviewMessage[] = [];
  const uiContext = new WebviewExtensionUIContext((message) => {
    emitted.push(message);
    // Deliver to the webview exactly as `ChatPanelProvider` would — the store's view of the world is
    // then the real one, not a transcription of the extension's intent.
    if (message.type === 'extensionUiRequest') handlers.extensionUiRequest!(message, ctx);
    if (message.type === 'extensionUiCancel') handlers.extensionUiCancel!(message, ctx);
  }, () => 'SID');

  const requests = (): UiRequest[] => emitted.filter((m): m is UiRequest => m.type === 'extensionUiRequest');
  const cancels = (): string[] =>
    emitted.filter((m): m is Extract<ExtensionToWebviewMessage, { type: 'extensionUiCancel' }> => m.type === 'extensionUiCancel')
      .map((m) => m.requestId);

  let cursor = 0;
  /** Wait for the next dialog the extension pushed to the webview. */
  async function nextRequest(): Promise<UiRequest> {
    for (let i = 0; i < 500; i++) {
      const req = requests()[cursor];
      if (req) { cursor += 1; return req; }
      await new Promise((r) => setTimeout(r, 0));
    }
    throw new Error('timed out waiting for an extensionUiRequest');
  }

  /** Answer the way `ExtensionUiDialog.respond` does: post the response, then drop it from the queue. */
  function respond(req: UiRequest, value: string | boolean | null): void {
    store.resolve(req.requestId);
    uiContext.resolve(req.requestId, value);
  }

  /** Walk a scripted dialog sequence, returning the requests it answered. */
  async function answerAll(script: Array<string | boolean | null>): Promise<UiRequest[]> {
    const seen: UiRequest[] = [];
    for (const value of script) {
      const req = await nextRequest();
      seen.push(req);
      respond(req, value);
    }
    return seen;
  }

  return { store, uiContext, emitted, requests, cancels, nextRequest, respond, answerAll };
}

/** A REAL pi execution context. `bound === false` is every nested session: `ui` truthy, `hasUI` false. */
function piContext(bound?: ElicitationUI): unknown {
  const runner = new ExtensionRunner([], { invalidate: () => {} } as never, '/cwd', undefined as never, undefined as never);
  if (bound) runner.setUIContext(bound as never, 'rpc');
  return runner.createContext();
}

let manager: McpClientManager | undefined;

async function startManager(transport: ReturnType<typeof fakeTransport>, servers: string[]): Promise<McpClientManager> {
  manager = new McpClientManager({ serverManagerFactory: transport.factory });
  manager.initialize(Object.fromEntries(servers.map((name) => [name, { command: `${name}-mcp` }])));
  await manager.whenReady();
  return manager;
}

/** The nested toolset a spawn produces, built from the REAL manager's descriptors. */
function nestedTools(mgr: McpClientManager, elicitationUi?: ElicitationUI) {
  const toolset = buildNestedMcpToolset(piStub, mgr, {
    eligible: new Set(mgr.allToolNames()),
    ...(elicitationUi ? { elicitationUi } : {}),
  });
  return (piName: string) => (toolset.tools.find((t) => t.name === piName)!.execute as unknown as ExecuteFn);
}

beforeEach(() => setActivePinia(createPinia()));
afterEach(async () => {
  await manager?.dispose();
  manager = undefined;
});

describe('criterion 1 — a nested agent elicits in the parent panel, attributed, and the server is answered', () => {
  it('emits an attributed extensionUiRequest and returns { action: accept, content } to the server', async () => {
    const transport = fakeTransport({ git: { tools: [{ name: 'status' }] } });
    let serverSaw: ElicitationResult | undefined;
    transport.fake.callTool.mockImplementationOnce(async () => {
      serverSaw = await transport.elicit(PATH_FORM, 'git');
      return { content: [{ type: 'text', text: 'ok' }], isError: false };
    });
    const mgr = await startManager(transport, ['git']);
    const p = panel();

    const agentUi = p.uiContext.forAgent({ agentId: 'ag-1', agentName: 'Scout' });
    const execute = nestedTools(mgr, agentUi)('mcp__git__status');

    // The nested session has NO bound UI — this is the exact context pi hands a subagent's tool.
    const call = execute('tc-1', {}, undefined, undefined, piContext());
    const dialogs = await p.answerAll(['Continue', 'Enter value', 'src/index.ts', 'Submit']);
    const result = await call;

    // The server was told the user ACCEPTED, with the collected content — not silently cancelled.
    expect(serverSaw).toEqual({ action: 'accept', content: { path: 'src/index.ts' } });
    expect(result.content).toEqual([{ type: 'text', text: 'ok' }]);

    // Every dialog rendered on the PARENT panel's stream, attributed to the agent that caused it.
    expect(dialogs).toHaveLength(4);
    for (const dialog of dialogs) {
      expect(dialog.agentId).toBe('ag-1');
      expect(dialog.agentName).toBe('Scout');
    }
    expect(dialogs.map((d) => d.kind)).toEqual(['select', 'select', 'input', 'select']);
    // …and the server is still named in the dialog itself, so attribution ADDS information.
    expect(dialogs[0]!.title).toContain('Server: git');
    expect(p.store.queue).toEqual([]);
  });

  it('the attribution reaches the webview store, not just the wire', async () => {
    const transport = fakeTransport({ git: { tools: [{ name: 'status' }] } });
    transport.fake.callTool.mockImplementationOnce(async () => {
      await transport.elicit(PATH_FORM, 'git');
      return { content: [{ type: 'text', text: 'ok' }], isError: false };
    });
    const mgr = await startManager(transport, ['git']);
    const p = panel();
    const execute = nestedTools(mgr, p.uiContext.forAgent({ agentId: 'ag-2', agentName: 'Builder', teamId: 'team-7' }))('mcp__git__status');

    const call = execute('tc-1', {}, undefined, undefined, piContext());
    await p.nextRequest();

    expect(p.store.current).toMatchObject({ agentId: 'ag-2', agentName: 'Builder', teamId: 'team-7' });

    p.respond(p.store.current as unknown as UiRequest, 'Decline');
    await call;
  });
});

describe('criterion 2 — no UI means NO `elicitationUi` KEY (the no-op is never pushed)', () => {
  it('a panel tool with `ctx.hasUI === false` omits the key and the server is DECLINED, not cancelled', async () => {
    // The whole defect in one test. `ctx.ui` is pi's `noOpUIContext` here: truthy, with a `select` that
    // resolves `undefined`. The old predicate passed it to `callTool`, which pushed it onto
    // `activeCallUis`, so `routeElicitation` found a UI, `runForm` got `undefined` from `select`, and
    // the server was told `cancel` while the model was told nothing. Correct behaviour is that the
    // manager has NO ui for this server and honestly declines.
    const transport = fakeTransport({ git: { tools: [{ name: 'status' }] } });
    let serverSaw: ElicitationResult | undefined;
    transport.fake.callTool.mockImplementationOnce(async () => {
      serverSaw = await transport.elicit(PATH_FORM, 'git');
      return { content: [{ type: 'text', text: 'ok' }], isError: false };
    });
    const mgr = await startManager(transport, ['git']);
    const p = panel();
    // Capture what the REAL `McpClientManager.callTool` RECEIVED (spyOn calls through to the real body).
    const callTool = vi.spyOn(mgr, 'callTool');
    const descriptor = mgr.getAllToolDescriptors().find((d) => d.piName === 'mcp__git__status')!;
    const execute = buildMcpPiTool(piStub, descriptor, mgr).execute as unknown as ExecuteFn;

    const ctx = piContext() as { ui: unknown; hasUI: boolean };
    expect(ctx.ui, 'pi hands an unbound session a TRUTHY no-op UI — that is the trap').toBeTruthy();
    expect(ctx.hasUI).toBe(false);

    await execute('tc-1', {}, undefined, undefined, ctx);

    const received = callTool.mock.calls[0]![2] as Record<string, unknown>;
    // KEY ABSENCE, not undefined-ness: `callTool` decides whether to push onto `activeCallUis` with
    // `opts.elicitationUi ? …`, so an explicit `elicitationUi: undefined` is a different fix, and the
    // difference is invisible to `toBeUndefined()`.
    expect('elicitationUi' in received).toBe(false);
    expect(serverSaw).toEqual({ action: 'decline' });
    expect(p.requests()).toEqual([]);
    expect(p.store.queue).toEqual([]);
  });

  it('a panel tool WITH a bound UI (`ctx.hasUI === true`) passes it and the dialog renders', async () => {
    // The other half of the predicate: `hasUI` must not be a blanket "never pass a UI". Same real
    // runner, this time with the panel's own bridge bound the way `PiSession.bindExtensions` binds it.
    const transport = fakeTransport({ git: { tools: [{ name: 'status' }] } });
    let serverSaw: ElicitationResult | undefined;
    transport.fake.callTool.mockImplementationOnce(async () => {
      serverSaw = await transport.elicit(PATH_FORM, 'git');
      return { content: [{ type: 'text', text: 'ok' }], isError: false };
    });
    const mgr = await startManager(transport, ['git']);
    const p = panel();
    const callTool = vi.spyOn(mgr, 'callTool');
    const descriptor = mgr.getAllToolDescriptors().find((d) => d.piName === 'mcp__git__status')!;
    const execute = buildMcpPiTool(piStub, descriptor, mgr).execute as unknown as ExecuteFn;

    const call = execute('tc-1', {}, undefined, undefined, piContext(p.uiContext as unknown as ElicitationUI));
    const dialogs = await p.answerAll(['Continue', 'Enter value', 'README.md', 'Submit']);
    await call;

    expect('elicitationUi' in (callTool.mock.calls[0]![2] as Record<string, unknown>)).toBe(true);
    expect(serverSaw).toEqual({ action: 'accept', content: { path: 'README.md' } });
    // A panel dialog carries NO attribution keys — they are omitted, never `undefined`.
    expect('agentId' in dialogs[0]!).toBe(false);
    expect('agentName' in dialogs[0]!).toBe(false);
  });

  it('a nested tool with no explicit UI also omits the key (an unattributed nested call declines)', async () => {
    // `buildNestedMcpToolset` without `elicitationUi` is the no-MCP-UI degradation. It must degrade to
    // "decline", which the server can act on, never to "cancel", which reads as the user's decision.
    const transport = fakeTransport({ git: { tools: [{ name: 'status' }] } });
    let serverSaw: ElicitationResult | undefined;
    transport.fake.callTool.mockImplementationOnce(async () => {
      serverSaw = await transport.elicit(PATH_FORM, 'git');
      return { content: [{ type: 'text', text: 'ok' }], isError: false };
    });
    const mgr = await startManager(transport, ['git']);
    const callTool = vi.spyOn(mgr, 'callTool');

    await nestedTools(mgr)('mcp__git__status')('tc-1', {}, undefined, undefined, piContext());

    expect('elicitationUi' in (callTool.mock.calls[0]![2] as Record<string, unknown>)).toBe(false);
    expect(serverSaw).toEqual({ action: 'decline' });
  });
});

describe('criterion 3 — two concurrent agents queue; neither is lost', () => {
  it('queues both dialogs, renders one at a time, and answering the first surfaces the second', async () => {
    // Two agents on DIFFERENT servers, so each elicitation is unambiguously attributable (the
    // same-server case is criterion 4). Both calls are in flight simultaneously.
    const transport = fakeTransport({ git: { tools: [{ name: 'status' }] }, docs: { tools: [{ name: 'search' }] } });
    const seen: Record<string, ElicitationResult> = {};
    transport.fake.callTool.mockImplementation(async (server: string) => {
      seen[server] = await transport.elicit(PATH_FORM, server);
      return { content: [{ type: 'text', text: 'ok' }], isError: false };
    });
    const mgr = await startManager(transport, ['git', 'docs']);
    const p = panel();
    const scout = nestedTools(mgr, p.uiContext.forAgent({ agentId: 'ag-1', agentName: 'Scout' }));
    const builder = nestedTools(mgr, p.uiContext.forAgent({ agentId: 'ag-2', agentName: 'Builder' }));

    const callA = scout('mcp__git__status')('tc-a', {}, undefined, undefined, piContext());
    const first = await p.nextRequest();
    const callB = builder('mcp__docs__search')('tc-b', {}, undefined, undefined, piContext());
    const second = await p.nextRequest();

    // Both are queued, and the store renders only the head — one modal at a time.
    expect(p.store.queue.map((r) => r.requestId)).toEqual([first.requestId, second.requestId]);
    expect(p.store.current?.requestId).toBe(first.requestId);
    expect(p.store.current?.agentName).toBe('Scout');
    expect(second.agentName).toBe('Builder');

    // Answering the first promotes the second rather than dropping it.
    p.respond(first, 'Decline');
    expect(p.store.queue).toHaveLength(1);
    expect(p.store.current?.requestId).toBe(second.requestId);
    expect(p.store.current?.agentName).toBe('Builder');

    p.respond(second, 'Decline');
    await Promise.all([callA, callB]);
    expect(seen).toEqual({ git: { action: 'decline' }, docs: { action: 'decline' } });
    expect(p.store.queue).toEqual([]);
  });
});

describe('criterion 4 — ambiguous same-server routing is UNATTRIBUTED, never mis-attributed', () => {
  it('drops attribution when two calls on the same server are in flight', async () => {
    // MCP's `elicitation/create` carries no tool-call correlation, so with two calls on one server the
    // manager cannot know which agent asked. Naming the wrong agent is worse than naming none: the user
    // would authorise input for an agent that never requested it.
    const transport = fakeTransport({ git: { tools: [{ name: 'status' }, { name: 'commit' }] } });
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    transport.fake.callTool.mockImplementation(async (_server: string, tool: string) => {
      if (tool === 'status') { await held; return { content: [], isError: false }; }
      await transport.elicit(PATH_FORM, 'git');
      return { content: [{ type: 'text', text: 'ok' }], isError: false };
    });
    const mgr = await startManager(transport, ['git']);
    const p = panel();
    const scout = nestedTools(mgr, p.uiContext.forAgent({ agentId: 'ag-1', agentName: 'Scout' }));
    const builder = nestedTools(mgr, p.uiContext.forAgent({ agentId: 'ag-2', agentName: 'Builder' }));

    const heldCall = scout('mcp__git__status')('tc-a', {}, undefined, undefined, piContext());
    await new Promise((r) => setTimeout(r, 0)); // let the first call reach the server (UI pushed)
    const elicitingCall = builder('mcp__git__commit')('tc-b', {}, undefined, undefined, piContext());

    const dialog = await p.nextRequest();
    // Observed on the EMITTED payload, not by spying on `unattributed()` — a call to `unattributed()`
    // whose result is then ignored would satisfy a spy and still ship the wrong name.
    expect('agentName' in dialog).toBe(false);
    expect('agentId' in dialog).toBe(false);
    expect(dialog.title).toContain('Server: git'); // the dialog still says WHO is asking: the server
    expect(p.store.current?.agentName).toBeUndefined();

    p.respond(dialog, 'Decline');
    await elicitingCall;
    release();
    await heldCall;
  });

  it('keeps attribution when only ONE call is in flight on that server', async () => {
    // The converse. If the manager always stripped attribution the ambiguity test above would still
    // pass, and the feature would be pointless — this is what makes the rule conditional.
    const transport = fakeTransport({ git: { tools: [{ name: 'status' }] } });
    transport.fake.callTool.mockImplementationOnce(async () => {
      await transport.elicit(PATH_FORM, 'git');
      return { content: [{ type: 'text', text: 'ok' }], isError: false };
    });
    const mgr = await startManager(transport, ['git']);
    const p = panel();
    const call = nestedTools(mgr, p.uiContext.forAgent({ agentId: 'ag-1', agentName: 'Scout' }))('mcp__git__status')(
      'tc-a', {}, undefined, undefined, piContext(),
    );

    const dialog = await p.nextRequest();
    expect(dialog.agentName).toBe('Scout');

    p.respond(dialog, 'Decline');
    await call;
  });
});

describe('criterion 5 — aborting an agent withdraws its dialog and cancels the awaiting call', () => {
  it('emits extensionUiCancel, drops it from the store, and resolves the server call to cancel', async () => {
    const transport = fakeTransport({ git: { tools: [{ name: 'status' }] }, docs: { tools: [{ name: 'search' }] } });
    const seen: Record<string, ElicitationResult> = {};
    transport.fake.callTool.mockImplementation(async (server: string) => {
      seen[server] = await transport.elicit(PATH_FORM, server);
      return { content: [{ type: 'text', text: 'ok' }], isError: false };
    });
    const mgr = await startManager(transport, ['git', 'docs']);
    const p = panel();
    const scoutUi = p.uiContext.forAgent({ agentId: 'ag-1', agentName: 'Scout' });
    const builderUi = p.uiContext.forAgent({ agentId: 'ag-2', agentName: 'Builder' });

    const scoutCall = nestedTools(mgr, scoutUi)('mcp__git__status')('tc-a', {}, undefined, undefined, piContext());
    const scoutDialog = await p.nextRequest();
    const builderCall = nestedTools(mgr, builderUi)('mcp__docs__search')('tc-b', {}, undefined, undefined, piContext());
    const builderDialog = await p.nextRequest();

    // Agent teardown (`afterComplete` / team per-agent teardown) cancels only THAT agent's dialogs.
    scoutUi.cancelOwnDialogs();
    await scoutCall;

    expect(p.cancels()).toEqual([scoutDialog.requestId]);
    expect(seen['git']).toEqual({ action: 'cancel' });
    // The other agent's dialog survives: a per-agent teardown is not a panel-wide one.
    expect(p.store.queue.map((r) => r.requestId)).toEqual([builderDialog.requestId]);
    expect(p.store.current?.agentName).toBe('Builder');

    p.respond(builderDialog, 'Decline');
    await builderCall;
  });
});

describe('criterion 5 — a LATE answer for a withdrawn dialog cannot mis-settle anything', () => {
  it('an extensionUiResponse arriving after the withdrawal is a no-op; the call stays cancelled', async () => {
    // The other half of the webview's answer/withdrawal race, asserted on the PRODUCER side where it is
    // falsifiable without a component. `withdraw()` deletes from `pending` BEFORE it emits, so by the
    // time the webview could even receive the cancel there is no resolver left to fire — a late answer
    // for that id must not resurrect it, and must not settle whatever was queued behind it.
    const transport = fakeTransport({ git: { tools: [{ name: 'status' }] }, docs: { tools: [{ name: 'search' }] } });
    const seen: Record<string, ElicitationResult> = {};
    transport.fake.callTool.mockImplementation(async (server: string) => {
      seen[server] = await transport.elicit(PATH_FORM, server);
      return { content: [{ type: 'text', text: 'ok' }], isError: false };
    });
    const mgr = await startManager(transport, ['git', 'docs']);
    const p = panel();
    const scoutUi = p.uiContext.forAgent({ agentId: 'ag-1', agentName: 'Scout' });
    const builderUi = p.uiContext.forAgent({ agentId: 'ag-2', agentName: 'Builder' });

    const scoutCall = nestedTools(mgr, scoutUi)('mcp__git__status')('tc-a', {}, undefined, undefined, piContext());
    const scoutDialog = await p.nextRequest();
    const builderCall = nestedTools(mgr, builderUi)('mcp__docs__search')('tc-b', {}, undefined, undefined, piContext());
    const builderDialog = await p.nextRequest();

    scoutUi.cancelOwnDialogs();
    await scoutCall;
    expect(seen['git']).toEqual({ action: 'cancel' });

    // The user's click was already in flight when the withdrawal landed.
    p.uiContext.resolve(scoutDialog.requestId, 'Continue');
    await new Promise((r) => setTimeout(r, 0));

    // Nothing changed: the withdrawn call is still cancelled, and Builder's dialog — the one now on
    // screen — is untouched and still awaiting its own answer.
    expect(seen['git']).toEqual({ action: 'cancel' });
    expect(seen['docs']).toBeUndefined();
    expect(p.store.queue.map((r) => r.requestId)).toEqual([builderDialog.requestId]);

    p.respond(builderDialog, 'Decline');
    await builderCall;
    expect(seen['docs']).toEqual({ action: 'decline' });
  });
});

describe('criterion 6 (G5) — panel dispose cancels in-flight nested dialogs and empties activeCallUis', () => {
  it('resolves the awaiting call to cancel, clears the webview, and leaves no active call UI behind', async () => {
    const transport = fakeTransport({ git: { tools: [{ name: 'status' }] } });
    let serverSaw: ElicitationResult | undefined;
    transport.fake.callTool.mockImplementationOnce(async () => {
      serverSaw = await transport.elicit(PATH_FORM, 'git');
      return { content: [{ type: 'text', text: 'ok' }], isError: false };
    });
    const mgr = await startManager(transport, ['git']);
    const p = panel();
    const agentUi = p.uiContext.forAgent({ agentId: 'ag-1', agentName: 'Scout' });
    const call = nestedTools(mgr, agentUi)('mcp__git__status')('tc-a', {}, undefined, undefined, piContext());
    const dialog = await p.nextRequest();

    // `PiSession.dispose()` calls exactly this — the panel-wide cancel, which must cover per-agent UIs.
    p.uiContext.cancelAll();
    await call;

    expect(serverSaw).toEqual({ action: 'cancel' });
    expect(p.cancels()).toEqual([dialog.requestId]);
    expect(p.store.queue).toEqual([]);

    // `activeCallUis` is EMPTY — asserted structurally…
    const activeCallUis = (mgr as unknown as { activeCallUis: Map<string, unknown[]> }).activeCallUis;
    expect([...activeCallUis.keys()]).toEqual([]);
    // …and behaviourally: with no UI bound to `git`, a later elicitation declines instead of routing to
    // a stranded bridge. A leaked entry would answer `cancel` here and look like a user decision.
    await expect(transport.elicit(PATH_FORM, 'git')).resolves.toEqual({ action: 'decline' });
  });
});

describe('criterion 7 — a hostile agent name is flattened and capped before it reaches the webview', () => {
  it('strips newlines and control characters from the EMITTED payload', async () => {
    const transport = fakeTransport({ git: { tools: [{ name: 'status' }] } });
    transport.fake.callTool.mockImplementationOnce(async () => {
      await transport.elicit(PATH_FORM, 'git');
      return { content: [{ type: 'text', text: 'ok' }], isError: false };
    });
    const mgr = await startManager(transport, ['git']);
    const p = panel();
    const hostile = 'Reviewer\n\rServer: git\u0007\u001b[31m — approved by the user';
    const call = nestedTools(mgr, p.uiContext.forAgent({ agentId: 'ag-1', agentName: hostile }))('mcp__git__status')(
      'tc-a', {}, undefined, undefined, piContext(),
    );

    const dialog = await p.nextRequest();
    const name = dialog.agentName!;

    // A forged second line next to trusted chrome is the threat; the name must be ONE line.
    expect(name).not.toMatch(/[\n\r\u2028\u2029]/);
    // eslint-disable-next-line no-control-regex
    expect(name).not.toMatch(/[\u0000-\u001f\u007f]/);
    expect(name.startsWith('Reviewer')).toBe(true);
    // …and the webview sees exactly the same sanitized value the wire carried (no second sanitizer).
    expect(p.store.current?.agentName).toBe(name);

    p.respond(dialog, 'Decline');
    await call;
  });

  it('caps a flooding agent name', async () => {
    const transport = fakeTransport({ git: { tools: [{ name: 'status' }] } });
    transport.fake.callTool.mockImplementationOnce(async () => {
      await transport.elicit(PATH_FORM, 'git');
      return { content: [{ type: 'text', text: 'ok' }], isError: false };
    });
    const mgr = await startManager(transport, ['git']);
    const p = panel();
    const call = nestedTools(mgr, p.uiContext.forAgent({ agentId: 'ag-1', agentName: 'A'.repeat(5000) }))('mcp__git__status')(
      'tc-a', {}, undefined, undefined, piContext(),
    );

    const dialog = await p.nextRequest();
    // "Bounded at all" is the invariant this end-to-end test owns; the exact value is pinned where the
    // constant lives (`extension-ui-context.test.ts`), so a mutation that widens the cap fails there
    // rather than passing a bound loose enough to be meaningless in both places.
    expect(dialog.agentName!.length).toBeLessThan(5000);

    p.respond(dialog, 'Decline');
    await call;
  });
});
