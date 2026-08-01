import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Agent } from '@earendil-works/pi-agent-core';
import { AgentSession, SessionManager, type ExtensionFactory, type ToolDefinition } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { BROWSER_PI_TOOL_NAMES } from '../tools/browser-tools';
import { COMPASS_PI_TOOL_NAMES } from '../tools/compass-tools';
import { WEB_PI_TOOL_NAMES } from '../web-access/web-tool-specs';
import { TEAM_AGENT_PI_TOOL_NAMES } from '../tools/team-tools';
import { deferredToolNames } from '../tools/deferred-tools';
import { resolveAgentToolset } from '../subagents/agent-toolset';
import { DEFAULT_AGENTS } from '../subagents/default-agents';
import { TOOL_TOOL_SEARCH } from '../../../shared/tool-names';

/**
 * Slice 3 §3.2 — the nested deferred baseline in `PiRuntime.createSubagentSession`.
 *
 * This is the slice's central acceptance criterion: an Explore subagent's FIRST request must omit every
 * browser name while still carrying ToolSearch, and `tools:` must keep the browser names so they stay in
 * pi's registry and remain reachable later.
 *
 * The suite has two halves, deliberately:
 *  1. Against a mocked pi, exercising the real `PiRuntime.createSubagentSession` — this is what proves
 *     the CALL happens, with the right argument, at the right point in the lifecycle.
 *  2. Against a REAL pi `AgentSession`, proving that what `setActiveToolsByName` writes is what a turn
 *     would actually carry. Asserting only on the mocked call would leave "does the baseline survive to
 *     the first request?" resting on prose rather than on execution.
 */

const H = vi.hoisted(() => {
  const created: Array<{ tools?: string[]; customTools?: unknown; excludeTools?: string[] }> = [];
  const sessions: Array<{ setActiveToolsByName: ReturnType<typeof vi.fn>; setAutoCompactionEnabled: ReturnType<typeof vi.fn>; calls: string[] }> = [];

  /**
   * `getAllTools()` reports the REGISTRY, so the fake builds it the way pi does: pi's own built-ins,
   * plus whatever the extension factory registered, intersected with the allowed `tools:` list.
   * Modelling it as "whatever was requested" would make the registration-failure path — the one that
   * silently strips an agent's browser tools forever — indistinguishable from success.
   */
  const makeSession = (tools: string[], registered: string[]) => {
    const calls: string[] = [];
    const allowed = new Set(tools);
    const registry = [...new Set([...tools.filter((n) => n !== 'ToolSearch'), ...registered])].filter((n) => allowed.has(n));
    const session = {
      calls,
      getAllTools: vi.fn(() => registry.map((name) => ({ name }))),
      setActiveToolsByName: vi.fn(() => calls.push('setActiveToolsByName')),
      setAutoCompactionEnabled: vi.fn(() => calls.push('setAutoCompactionEnabled')),
      dispose: vi.fn(),
      sessionId: `nested-${sessions.length}`,
    };
    sessions.push(session as never);
    return session;
  };

  const fakePi = {
    createAgentSessionServices: vi.fn(async (opts?: { resourceLoaderOptions?: { extensionFactories?: unknown[] } }) => ({
      __extensionFactories: opts?.resourceLoaderOptions?.extensionFactories ?? [],
      cwd: '/cwd',
      agentDir: '/agent',
      settingsManager: { getPackages: () => [], getGlobalSettings: () => ({}), getProjectSettings: () => ({}) },
      modelRuntime: { getAvailableSnapshot: () => [], refresh: vi.fn(async () => undefined) },
      resourceLoader: { extendResources: vi.fn(), reload: vi.fn(async () => undefined) },
      diagnostics: [],
    })),
    createAgentSessionFromServices: vi.fn(async (opts: { tools?: string[]; services?: { __extensionFactories?: unknown[] } }) => {
      created.push(opts);
      // Run the real extension factory against a pi stub, so what it registers is what the registry has.
      const registered: string[] = [];
      const piStub = {
        on: () => undefined,
        registerTool: (t: { name: string }) => registered.push(t.name),
        getActiveTools: () => [],
        setActiveTools: () => undefined,
        getAllTools: () => [],
      };
      for (const factory of opts.services?.__extensionFactories ?? []) {
        try {
          (factory as (pi: unknown) => void)(piStub);
        } catch {
          // A factory that throws registers nothing — exactly the case the baseline gate must survive.
        }
      }
      return { session: makeSession(opts.tools ?? [], registered) };
    }),
    SessionManager: { create: vi.fn(() => ({ kind: 'persistent' })), inMemory: vi.fn(() => ({ kind: 'memory' })) },
    SettingsManager: { inMemory: vi.fn(() => ({ kind: 'settings' })) },
    DefaultPackageManager: class { getInstalledPath(): string | undefined { return undefined; } },
  };
  return { created, sessions, fakePi };
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

const logLines = vi.hoisted(() => [] as string[]);
vi.mock('../../logger', () => ({ log: (fmt: string, ...args: unknown[]) => logLines.push(`${fmt} ${JSON.stringify(args)}`) }));

import { PiRuntime } from '../pi-runtime';

/** Stands in for the real subagent factory: registers ToolSearch, which is what makes deferral safe. */
const toolSearchFactory: ExtensionFactory = ((pi: { registerTool: (t: { name: string }) => void }) => {
  pi.registerTool({ name: TOOL_TOOL_SEARCH });
}) as unknown as ExtensionFactory;

/** A factory whose registration fails — the fail-soft path in `createSubagentExtensionFactory`. */
const failingFactory: ExtensionFactory = (() => {
  throw new Error('registerTool failed during extension load');
}) as unknown as ExtensionFactory;

async function createNested(tools: string[], extensionFactory: ExtensionFactory = toolSearchFactory) {
  const runtime = PiRuntime.get('/cwd', '/fake/agent');
  await runtime.createSubagentSession({
    cwd: '/cwd',
    systemPrompt: 'sp',
    tools,
    customTools: [],
    extensionFactory,
  });
  const session = H.sessions.at(-1)!;
  const createOpts = H.created.at(-1)!;
  return {
    session,
    createOpts,
    /** The names handed to `setActiveToolsByName`, or null when the baseline was never applied. */
    baseline: (session.setActiveToolsByName.mock.calls.at(-1)?.[0] ?? null) as string[] | null,
  };
}

/**
 * An Explore agent's real resolved toolset, against a panel with browser + compass + web + ToolSearch.
 *
 * The web names have to be in the PARENT set for Explore to end up with them: `resolveAgentToolset`
 * intersects an explicit `builtinToolNames` list with what the panel actually has active, and Explore's
 * list names all five web tools. A parent set without them would silently resolve to an Explore with no
 * web tools — which would make every web assertion below vacuously true rather than false-when-broken.
 */
function exploreToolset(): string[] {
  const parent = [
    'read', 'bash', 'grep', 'find', 'ls', 'Edit', 'write', TOOL_TOOL_SEARCH,
    ...BROWSER_PI_TOOL_NAMES, ...COMPASS_PI_TOOL_NAMES, ...WEB_PI_TOOL_NAMES,
  ];
  return resolveAgentToolset(DEFAULT_AGENTS.get('Explore')!, parent).names;
}

describe('createSubagentSession — the deferred baseline (Slice 3 §3.2)', () => {
  beforeEach(() => {
    H.created.length = 0;
    H.sessions.length = 0;
    H.fakePi.createAgentSessionFromServices.mockClear();
  });
  afterEach(async () => {
    await PiRuntime.disposeInstance();
  });

  it('an Explore subagent\'s first request omits EVERY browser name and includes ToolSearch', async () => {
    // THE acceptance criterion. Driven from the agent's REAL resolved toolset (not a hand-written array)
    // so that a change to Explore's tools, to the browser catalog, or to the §3.1 injection all reach it.
    const tools = exploreToolset();
    expect(tools).toContain(TOOL_TOOL_SEARCH); // precondition: §3.1 injected it into the explicit list

    const { baseline } = await createNested(tools);

    expect(baseline).not.toBeNull();
    for (const n of BROWSER_PI_TOOL_NAMES) expect(baseline!, n).not.toContain(n);
    expect(baseline).toContain(TOOL_TOOL_SEARCH);
    // Targeted deferral, not a smaller agent: everything non-deferrable is untouched.
    for (const n of ['read', 'bash', 'grep', 'find', 'ls']) expect(baseline!, n).toContain(n);
    // And it is exactly the eligible set minus the deferrable one — no ad-hoc extra subtraction.
    const deferred = new Set(deferredToolNames(tools, []));
    expect(baseline).toEqual(tools.filter((n) => !deferred.has(n)));
  });

  it('`tools:` still carries every browser name — the eligible set is NOT narrowed (constraint 1)', async () => {
    // The failure mode this guards: pi freezes `options.tools` into `_allowedToolNames` and filters the
    // REGISTRY by it, and `setActiveToolsByName` silently ignores unknown names. Narrowing `tools:` here
    // would evict the browser tools from the registry permanently — ToolSearch would "succeed" forever
    // while loading nothing. Only the ACTIVE set may narrow.
    const tools = exploreToolset();
    const { createOpts, baseline } = await createNested(tools);

    for (const n of BROWSER_PI_TOOL_NAMES) expect(createOpts.tools!, n).toContain(n);
    expect(createOpts.tools).toEqual(tools);
    // The two sets differ by exactly the deferrable tools — stated as a set difference, not a spot check.
    const missing = createOpts.tools!.filter((n) => !baseline!.includes(n));
    expect([...missing].sort()).toEqual([...deferredToolNames(tools, [])].sort());
  });

  it('defers the web group while `tools:` still carries all 5 — the invariant-1 proof for `web`', async () => {
    // Both halves in ONE case: absence alone is equally satisfied by narrowing `tools:` and evicting the
    // web tools from pi's registry forever (pi freezes `options.tools` and `setActiveToolsByName` ignores
    // unknown names, so that bug looks like success at every later step); `tools:` alone is satisfied by
    // not deferring at all. Only the conjunction says "deferred, and still recoverable".
    const tools = exploreToolset();
    for (const n of WEB_PI_TOOL_NAMES) expect(tools, n).toContain(n); // precondition: Explore really has them

    const { baseline, createOpts, session } = await createNested(tools);

    for (const n of WEB_PI_TOOL_NAMES) expect(baseline!, n).not.toContain(n);
    for (const n of WEB_PI_TOOL_NAMES) expect(createOpts.tools!, n).toContain(n);
    expect(baseline).toContain(TOOL_TOOL_SEARCH);
    // …and the web names reached the session's REGISTRY, so a later activation has something to
    // activate. The fake builds its registry the way pi does — intersected with the allowed `tools:` —
    // so this is the assertion a narrowed `tools:` would actually fail.
    const registry = session.getAllTools().map((t) => t.name);
    for (const n of WEB_PI_TOOL_NAMES) expect(registry, n).toContain(n);
  });

  it('defers compass too, and a `tools: *` subagent behaves identically to Explore', async () => {
    const parent = [
      'read', 'bash', 'grep', 'find', 'ls', 'Edit', 'write', 'PowerShell', TOOL_TOOL_SEARCH,
      ...BROWSER_PI_TOOL_NAMES, ...COMPASS_PI_TOOL_NAMES,
    ];
    const tools = resolveAgentToolset(DEFAULT_AGENTS.get('general-purpose')!, parent).names;
    const { baseline } = await createNested(tools);

    for (const n of [...BROWSER_PI_TOOL_NAMES, ...COMPASS_PI_TOOL_NAMES]) expect(baseline!, n).not.toContain(n);
    expect(baseline).toContain(TOOL_TOOL_SEARCH);
    // A `tools: *` agent keeps its write tools — deferral is orthogonal to what an agent may do.
    expect(baseline).toContain('Edit');
    expect(baseline).toContain('write');
  });

  it('an agent that disallowed ToolSearch gets EVERY tool active immediately — never stranded', async () => {
    // The §3.2 guard's whole purpose. Without ToolSearch there is no way to load anything back, so the
    // only correct behaviour is to skip the baseline entirely and leave pi's own construction-time
    // default (everything eligible is active) in place. Asserted as "no call was made", because pi
    // already activated the full set — writing a narrowed set here would be the stranding bug.
    const parent = ['read', 'bash', 'grep', 'find', 'ls', TOOL_TOOL_SEARCH, ...BROWSER_PI_TOOL_NAMES];
    const { names } = resolveAgentToolset(
      { name: 'a', description: 'd', extensions: true, skills: true, systemPrompt: '', promptMode: 'replace', disallowedTools: [TOOL_TOOL_SEARCH] },
      parent,
    );
    expect(names).not.toContain(TOOL_TOOL_SEARCH);
    for (const n of BROWSER_PI_TOOL_NAMES) expect(names, n).toContain(n);

    const { session, createOpts } = await createNested(names);

    expect(session.setActiveToolsByName).not.toHaveBeenCalled();
    // …and its browser tools are still eligible, so pi's default leaves them active.
    for (const n of BROWSER_PI_TOOL_NAMES) expect(createOpts.tools!, n).toContain(n);
  });

  it('applies the baseline BEFORE auto-compaction is disabled and before the session escapes', async () => {
    // Ordering matters for a reason that is easy to lose in a refactor: the baseline must land while the
    // session is still local to `createSubagentSession`, i.e. before any caller can prompt it. Pinning
    // it against the neighbouring `setAutoCompactionEnabled(false)` states that as an observable fact.
    const { session } = await createNested(exploreToolset());
    expect(session.calls).toEqual(['setActiveToolsByName', 'setAutoCompactionEnabled']);
  });

  it('is a no-op write when nothing is deferrable (browser, compass and web all off)', async () => {
    // ToolSearch present but no deferrable tools: the baseline reduces to the full eligible set. Nothing
    // is lost, and the model simply sees a ToolSearch with an empty inventory.
    const tools = ['read', 'bash', 'grep', 'Edit', TOOL_TOOL_SEARCH];
    const { baseline } = await createNested(tools);
    expect(baseline).toEqual(tools);
  });

  it('does NOT defer when ToolSearch failed to register — no loader, no deferral', async () => {
    // The subagent factory registers ToolSearch fail-soft. Gating the baseline on the tool being merely
    // ALLOWED rather than actually REGISTERED meant a swallowed registration error stripped all 38
    // browser+compass+web tools from the active set while deleting the only mechanism that could restore
    // them: a permanent, silent capability loss for the agent's whole lifetime, over one log line.
    const tools = [...exploreToolset(), ...BROWSER_PI_TOOL_NAMES];
    const { baseline, session } = await createNested(tools, failingFactory);

    expect(baseline).toBeNull();
    expect(session.setActiveToolsByName).not.toHaveBeenCalled();
    // Everything stays active — degraded to the pre-feature behaviour, never to a crippled agent.
    expect(session.getAllTools().map((t) => t.name)).toEqual(expect.arrayContaining([...BROWSER_PI_TOOL_NAMES]));
  });

  it('the /btw caller (tools: []) is untouched by this slice — not a regression', async () => {
    // `createSubagentSession` has THREE production callers, not the two the brief names: subagents, team,
    // and `/btw` (pi-session.ts:2167), which passes `tools: []` and its own inline pruning factory,
    // bypassing `createSubagentExtensionFactory` entirely. The §3.2 guard is false on an empty array, so
    // the baseline never runs and `/btw` is byte-for-byte unchanged. Pinned so an empty-toolset btw
    // session is never mistaken for a regression, and so a future widening of the guard is caught here.
    const { session, createOpts } = await createNested([]);
    expect(createOpts.tools).toEqual([]);
    expect(session.setActiveToolsByName).not.toHaveBeenCalled();
  });

  it('a team agent\'s team_* tools are active in the first request and were never deferred (§3.5)', async () => {
    // A team specialist must be able to post to the scratchpad from turn one. `deferredToolNames`
    // intersects with browser ∪ compass ∪ web only, so this needs no special case — and none exists.
    const tools = ['read', 'bash', 'Edit', TOOL_TOOL_SEARCH, ...TEAM_AGENT_PI_TOOL_NAMES, ...COMPASS_PI_TOOL_NAMES, ...BROWSER_PI_TOOL_NAMES];
    const { baseline } = await createNested(tools);

    for (const n of TEAM_AGENT_PI_TOOL_NAMES) expect(baseline!, n).toContain(n);
    for (const n of [...COMPASS_PI_TOOL_NAMES, ...BROWSER_PI_TOOL_NAMES]) expect(baseline!, n).not.toContain(n);
    expect(baseline).toContain(TOOL_TOOL_SEARCH);
    expect(deferredToolNames(tools, []).some((n) => TEAM_AGENT_PI_TOOL_NAMES.includes(n))).toBe(false);
  });
});

/**
 * The same baseline against a REAL `AgentSession`, so the claim "the deferred baseline survives to the
 * first request" is established by execution rather than by reading pi's source. pi's
 * `_installAgentNextTurnRefresh` hands each turn `this.agent.state.tools.slice()` — the array
 * `setActiveToolsByName` wrote — so this drives that exact path.
 */
describe('the baseline survives to the first request (real pi AgentSession)', () => {
  /** The minimum `AgentSession` deps: no network, no extensions, in-memory session. */
  function realSession(tools: string[], initialActive: string[]) {
    const agent = new Agent({ streamFn: (async () => { throw new Error('no network in tests'); }) as never });
    const settingsManager = {
      getImageAutoResize: () => false,
      getShellCommandPrefix: () => undefined,
      getShellPath: () => undefined,
      getCompactionSettings: () => ({ enabled: false, reserveTokens: 1, keepRecentTokens: 1 }),
      getSteeringMode: () => 'immediate',
      getFollowUpMode: () => 'immediate',
      setCompactionEnabled: () => {},
    } as never;
    const resourceLoader = {
      getExtensions: () => ({
        extensions: [],
        errors: [],
        runtime: {
          flagValues: new Map(),
          pendingProviderRegistrations: [],
          pendingNativeProviderRegistrations: [],
          assertActive: () => {},
          invalidate: () => {},
        },
      }),
      getSystemPrompt: () => 'sys',
      getAppendSystemPrompt: () => [],
      getSkills: () => ({ skills: [], diagnostics: [] }),
      getAgentsFiles: () => ({ agentsFiles: [] }),
      getPrompts: () => ({ prompts: [], diagnostics: [] }),
    } as never;
    const session = new AgentSession({
      agent,
      sessionManager: SessionManager.inMemory(),
      settingsManager,
      cwd: process.cwd(),
      resourceLoader,
      modelRuntime: { getAvailableSnapshot: () => [] } as never,
      // Mirrors what `createAgentSessionFromServices` derives from `opts.tools` (sdk.js:134-136):
      // `tools:` becomes BOTH the allowlist and the construction-time active set.
      allowedToolNames: tools,
      initialActiveToolNames: tools,
    });
    session.setActiveToolsByName(initialActive);
    return { agent, session };
  }

  /** The tool names pi would put in the NEXT turn's request. */
  async function nextTurnToolNames(agent: Agent): Promise<string[]> {
    const prepare = (agent as unknown as {
      prepareNextTurnWithContext: (ctx: unknown, signal?: AbortSignal) => Promise<{ context: { tools: Array<{ name: string }> } }>;
    }).prepareNextTurnWithContext;
    const update = await prepare({ context: { messages: [], systemPrompt: '', tools: [] } });
    return update.context.tools.map((t) => t.name);
  }

  // pi's built-in registry is read/bash/edit/write/grep/find/ls; a nested session's browser/compass/web tools
  // are extension tools this bare harness has no way to register. `bash` therefore stands in for a
  // deferred tool: the property under test is that a name in `tools:` but NOT in the baseline is absent
  // from the turn while remaining registered and re-activatable — which is exactly the browser case.
  const ELIGIBLE = ['read', 'bash', 'grep', 'find', 'ls'];
  const DEFERRED = ['bash'];
  const BASELINE = ELIGIBLE.filter((n) => !DEFERRED.includes(n));

  it('the request carries the BASELINE, not the full eligible set', async () => {
    const { agent } = realSession(ELIGIBLE, BASELINE);
    const turnTools = await nextTurnToolNames(agent);
    expect([...turnTools].sort()).toEqual([...BASELINE].sort());
    expect(turnTools).not.toContain('bash');
  });

  it('a deferred name stays REGISTERED, so a later activation actually brings it back', async () => {
    // The other half of constraint 1, proven rather than reasoned: because the name stayed in `tools:`
    // it is still in the registry, so `setActiveToolsByName` can re-add it. Had `tools:` been narrowed,
    // pi would silently ignore the name here and the tool would be unreachable forever.
    const { agent, session } = realSession(ELIGIBLE, BASELINE);
    expect(await nextTurnToolNames(agent)).not.toContain('bash');

    session.setActiveToolsByName([...session.getActiveToolNames(), 'bash']);

    const after = await nextTurnToolNames(agent);
    expect(after).toContain('bash');
    for (const n of BASELINE) expect(after, n).toContain(n);
  });

  it('a name NOT in `tools:` can never be activated — pi ignores unknown names silently', async () => {
    // The precise reason the deferred names must stay in `tools:`. This is the bug a narrowing
    // implementation would ship: activation appears to succeed and nothing happens.
    const { agent, session } = realSession(BASELINE, BASELINE);
    session.setActiveToolsByName([...BASELINE, 'bash']);
    expect(session.getActiveToolNames()).not.toContain('bash');
    expect(await nextTurnToolNames(agent)).not.toContain('bash');
  });

  it('activation is additive: re-writing the union never drops a baseline tool', async () => {
    // The subagent port writes `[...new Set([...getActiveTools(), ...matches])]`. Applied to a real
    // session, that must leave every baseline tool in place — pi's before/after diff stamps
    // `addedToolNames` only for a purely additive change; a removal forces a full active-set resend.
    const { agent, session } = realSession(ELIGIBLE, BASELINE);
    const before = session.getActiveToolNames();
    session.setActiveToolsByName([...new Set([...session.getActiveToolNames(), ...DEFERRED])]);
    const after = session.getActiveToolNames();
    for (const n of before) expect(after, n).toContain(n);
    expect(after).toHaveLength(before.length + DEFERRED.length);
    expect(await nextTurnToolNames(agent)).toHaveLength(ELIGIBLE.length);
  });

  it('a tool registered into a LIVE nested session force-activates everything (the documented fragility)', async () => {
    // Pins the §3.2 residual-fragility comment as behaviour, so the WHY comment cannot silently become
    // false: with `allowedToolNames` set, `_refreshToolRegistry` unions in EVERY allowed registry name
    // and wipes the baseline. Nothing triggers this today (nested registration happens during extension
    // LOAD, where pi's `refreshTools` is a no-op stub), but if a future change registers into a live
    // nested session, the baseline must be re-applied after it.
    const { session } = realSession(ELIGIBLE, BASELINE);
    expect(session.getActiveToolNames()).not.toContain('bash');

    (session as unknown as { _refreshToolRegistry: () => void })._refreshToolRegistry();

    expect([...session.getActiveToolNames()].sort()).toEqual([...ELIGIBLE].sort());
  });
});

/**
 * Slice 1 (nested MCP) — MCP joins the nested deferred baseline in the same slice that delivers it.
 *
 * The shape mirrors the `web` case above deliberately: the CONJUNCTION is the whole guard. "The
 * baseline omits every `mcp__*`" alone is satisfied by a bug that narrowed `tools:` and evicted the MCP
 * definitions from pi's registry forever (pi freezes `options.tools` into `_allowedToolNames`, and
 * `setActiveToolsByName` silently ignores unknown names — so that bug looks like success at every later
 * step). "`tools:` keeps every `mcp__*`" alone is satisfied by not deferring at all. Only both together
 * say "deferred, and still recoverable".
 */
describe('createSubagentSession — the deferred baseline covers MCP (Slice 1, criterion 1)', () => {
  const MCP_NAMES = ['mcp__git__status', 'mcp__git__commit', 'mcp__ctx7__query_docs'];

  beforeEach(() => {
    H.created.length = 0;
    H.sessions.length = 0;
    H.fakePi.createAgentSessionFromServices.mockClear();
  });
  afterEach(async () => {
    await PiRuntime.disposeInstance();
  });

  /** Spawn the way `agent-manager.ts` composes a spawn: `tools: [...toolset.names, ...mcp.names]`. */
  async function createWithMcp(baseTools: string[], mcpToolNames: string[] = MCP_NAMES, extensionFactory = toolSearchFactory) {
    const runtime = PiRuntime.get('/cwd', '/fake/agent');
    await runtime.createSubagentSession({
      cwd: '/cwd',
      systemPrompt: 'sp',
      // The ONLY place MCP names are stated. `createSubagentSession` derives its own deferral input
      // from this array, so there is no second list for a caller to get wrong or leave out.
      tools: [...baseTools, ...mcpToolNames],
      customTools: [],
      extensionFactory,
    });
    const session = H.sessions.at(-1)!;
    const createOpts = H.created.at(-1)!;
    return {
      session,
      createOpts,
      baseline: (session.setActiveToolsByName.mock.calls.at(-1)?.[0] ?? null) as string[] | null,
    };
  }

  it('defers EVERY mcp__* name while `tools:` keeps EVERY one — the conjunction, in one test', async () => {
    const tools = exploreToolset();
    const { baseline, createOpts, session } = await createWithMcp(tools);

    // Half one: not one MCP name is active on the first request.
    expect(baseline).not.toBeNull();
    for (const n of MCP_NAMES) expect(baseline!, n).not.toContain(n);
    expect(baseline!.some((n) => n.startsWith('mcp__'))).toBe(false);

    // Half two: every one of them is still in `tools:`, so it stays in pi's registry and ToolSearch can
    // actually bring it back. Narrowing here is the silent, permanent capability loss.
    for (const n of MCP_NAMES) expect(createOpts.tools!, n).toContain(n);
    const registry = session.getAllTools().map((t) => t.name);
    for (const n of MCP_NAMES) expect(registry, n).toContain(n);

    // …and the non-deferrable baseline is untouched: deferral is targeted, not a smaller agent.
    expect(baseline).toContain(TOOL_TOOL_SEARCH);
    for (const n of ['read', 'bash', 'grep', 'find', 'ls']) expect(baseline!, n).toContain(n);
  });

  it('the baseline is exactly `tools:` minus `deferredToolNames(tools, mcpNames)` — no ad-hoc subtraction', async () => {
    // Stated as a set identity rather than a spot check, so an implementation that removed MCP by a
    // `startsWith('mcp__')` filter somewhere else (rather than through the deferrable set) fails here.
    const tools = exploreToolset();
    const { baseline, createOpts } = await createWithMcp(tools);
    const all = createOpts.tools!;
    const deferred = new Set(deferredToolNames(all, MCP_NAMES));

    expect(baseline).toEqual(all.filter((n) => !deferred.has(n)));
    const missing = all.filter((n) => !baseline!.includes(n));
    expect([...missing].sort()).toEqual([...deferred].sort());
    // The deferred set really does span BOTH kinds — browser/web AND MCP — so this is not vacuous.
    expect([...deferred].some((n) => n.startsWith('mcp__'))).toBe(true);
    expect([...deferred].some((n) => BROWSER_PI_TOOL_NAMES.includes(n))).toBe(true);
  });

  it('an `mcp__*` name with no customTool definition is REPORTED, since pi drops it in silence', async () => {
    // The single silent failure mode of the whole delivery mechanism: pi filters its registry by the
    // frozen `_allowedToolNames`, so a name in `tools:` with nothing behind it vanishes with no error,
    // no warning and no log. Every nested spawn funnels through `createSubagentSession`, which makes it
    // the one place the class is observable at runtime. A diagnostic, not a guard — the spawn still
    // proceeds, because a missing tool must not kill an agent.
    logLines.length = 0;
    const runtime = PiRuntime.get('/cwd', '/fake/agent');
    await runtime.createSubagentSession({
      cwd: '/cwd',
      systemPrompt: 'sp',
      tools: ['read', ...MCP_NAMES],
      customTools: [{ name: MCP_NAMES[0]! } as never], // only the FIRST has a definition
      extensionFactory: toolSearchFactory,
    });

    const orphanLog = logLines.find((l) => l.includes('no customTool definition'));
    expect(orphanLog).toBeDefined();
    expect(orphanLog).toContain(MCP_NAMES[1]!);
    expect(orphanLog).not.toContain(MCP_NAMES[0]!); // the defined one is not reported
  });

  it('says nothing when every `mcp__*` name has its definition', async () => {
    // The other half: a diagnostic that fires on healthy spawns is noise nobody reads, which is how a
    // real one gets missed.
    logLines.length = 0;
    const runtime = PiRuntime.get('/cwd', '/fake/agent');
    await runtime.createSubagentSession({
      cwd: '/cwd',
      systemPrompt: 'sp',
      tools: ['read', ...MCP_NAMES],
      customTools: MCP_NAMES.map((name) => ({ name }) as never),
      extensionFactory: toolSearchFactory,
    });

    expect(logLines.find((l) => l.includes('no customTool definition'))).toBeUndefined();
  });

  it('MCP deferral has no separate opt-in to forget — it is DERIVED from `tools:`', async () => {
    // `deferredToolNames` intersects with browser ∪ compass ∪ web ∪ `mcpNames`, so something has to
    // supply the MCP half or every MCP tool is ACTIVE from turn one (the whole schema in the first
    // request — a cost regression, never a correctness one). That used to be a parallel
    // `mcpToolNames:` option, i.e. a second statement of a fact `tools:` already carried, and a caller
    // omitting it got the regression silently. `createSubagentSession` now filters `tools:` itself.
    //
    // Asserted through the REAL spawn with no MCP argument available to pass: the option is gone, so
    // this cannot regress by someone forgetting it — only by the derivation itself breaking.
    const { baseline, createOpts } = await createWithMcp(exploreToolset());

    for (const n of MCP_NAMES) expect(createOpts.tools!, n).toContain(n);
    for (const n of MCP_NAMES) expect(baseline!, n).not.toContain(n);
    // Not vacuous: a non-MCP, non-deferred tool IS in the baseline.
    expect(baseline).toContain('read');
  });

  it('a `tools: *` agent defers MCP identically to Explore (uniform across agent types)', async () => {
    const parent = [
      'read', 'bash', 'grep', 'find', 'ls', 'Edit', 'write', 'PowerShell', TOOL_TOOL_SEARCH,
      ...BROWSER_PI_TOOL_NAMES, ...COMPASS_PI_TOOL_NAMES,
    ];
    const tools = resolveAgentToolset(DEFAULT_AGENTS.get('general-purpose')!, parent).names;
    const { baseline, createOpts } = await createWithMcp(tools);

    for (const n of MCP_NAMES) expect(baseline!, n).not.toContain(n);
    for (const n of MCP_NAMES) expect(createOpts.tools!, n).toContain(n);
    // A `tools: *` agent keeps its write tools — deferral is orthogonal to what an agent may do.
    expect(baseline).toContain('Edit');
    expect(baseline).toContain('write');
  });

  it('criterion 13: a FAILED ToolSearch registration still writes no baseline, with MCP present', async () => {
    // The §4.2 guard, re-proven in the configuration this slice creates. Without ToolSearch there is no
    // way to load anything back, so deferring would strip every browser/web/MCP tool from the active set
    // while deleting the only mechanism that could restore them. The MCP names make the stakes larger
    // (a whole server's capability), not different — the guard must hold unchanged.
    const tools = exploreToolset();
    const { baseline, session, createOpts } = await createWithMcp(tools, MCP_NAMES, failingFactory);

    expect(baseline).toBeNull();
    expect(session.setActiveToolsByName).not.toHaveBeenCalled();
    // Everything stays active and eligible — degraded to the pre-feature behaviour, never to a crippled
    // agent that can see an MCP tool advertised nowhere and load it never.
    for (const n of MCP_NAMES) expect(createOpts.tools!, n).toContain(n);
    expect(session.getAllTools().map((t) => t.name)).toEqual(expect.arrayContaining(MCP_NAMES));
  });

  it('an MCP-only agent (no browser/compass/web) still defers, and still keeps `tools:` whole', async () => {
    // The default workspace with one MCP server configured: MCP is the ONLY deferrable group. An
    // implementation that keyed deferral off the built-in catalogs would silently do nothing here.
    const tools = ['read', 'bash', 'grep', 'Edit', TOOL_TOOL_SEARCH];
    const { baseline, createOpts } = await createWithMcp(tools);

    expect(baseline).toEqual(tools);
    for (const n of MCP_NAMES) expect(createOpts.tools!, n).toContain(n);
    for (const n of MCP_NAMES) expect(baseline!, n).not.toContain(n);
  });
});

/**
 * G2 / criterion 2 — the residual-fragility note at `pi-runtime.ts:706-733`, verified rather than assumed.
 *
 * The note reasons that pi's force-activation branch (`_refreshToolRegistry` unions in every allowed
 * name when `allowedToolNames` is set) cannot fire in a nested session, and ends: "if a future change
 * registers a tool into a LIVE nested session, re-apply this baseline after it." Delivering MCP as
 * `customTools` is adjacent to exactly that. The EXPECTED finding is that it does not apply, because
 * `customTools` are read inside `_refreshToolRegistry` during CONSTRUCTION
 * (`dist/core/agent-session.js:1949`), not through a post-bind `registerTool`.
 *
 * This is asserted on a REAL `AgentSession` because the claim is about pi's construction order, and a
 * fake session is precisely the thing that cannot testify to it. If this suite goes red, the finding is
 * architectural: the baseline must be re-applied after registration.
 */
describe('G2 — MCP customTools do not defeat the baseline (real pi AgentSession)', () => {
  const MCP_NAMES = ['mcp__git__status', 'mcp__git__commit'];

  /** Real `AgentSession` deps: no network, no extensions, in-memory session — plus real customTools. */
  function realSessionWithCustomTools(tools: string[], customTools: ToolDefinition[], initialActive: string[]) {
    const agent = new Agent({ streamFn: (async () => { throw new Error('no network in tests'); }) as never });
    const settingsManager = {
      getImageAutoResize: () => false,
      getShellCommandPrefix: () => undefined,
      getShellPath: () => undefined,
      getCompactionSettings: () => ({ enabled: false, reserveTokens: 1, keepRecentTokens: 1 }),
      getSteeringMode: () => 'immediate',
      getFollowUpMode: () => 'immediate',
      setCompactionEnabled: () => {},
    } as never;
    const resourceLoader = {
      getExtensions: () => ({
        extensions: [],
        errors: [],
        runtime: {
          flagValues: new Map(),
          pendingProviderRegistrations: [],
          pendingNativeProviderRegistrations: [],
          assertActive: () => {},
          invalidate: () => {},
        },
      }),
      getSystemPrompt: () => 'sys',
      getAppendSystemPrompt: () => [],
      getSkills: () => ({ skills: [], diagnostics: [] }),
      getAgentsFiles: () => ({ agentsFiles: [] }),
      getPrompts: () => ({ prompts: [], diagnostics: [] }),
    } as never;
    const session = new AgentSession({
      agent,
      sessionManager: SessionManager.inMemory(),
      settingsManager,
      cwd: process.cwd(),
      resourceLoader,
      modelRuntime: { getAvailableSnapshot: () => [] } as never,
      // Exactly what `createAgentSessionFromServices` derives from `opts.tools` (sdk.js:134-136).
      allowedToolNames: tools,
      initialActiveToolNames: tools,
      customTools,
    } as never);
    // What `createSubagentSession` does next: seed the deferred baseline.
    session.setActiveToolsByName(initialActive);
    return session;
  }

  /** Definitions shaped like the ones `buildNestedMcpToolset` produces (name + schema + execute). */
  function mcpLikeCustomTools(names: string[]): ToolDefinition[] {
    return names.map((name) => ({
      name,
      label: name,
      description: `MCP tool ${name}`,
      parameters: Type.Object({}, { additionalProperties: true }),
      execute: async () => ({ content: [{ type: 'text' as const, text: 'ok' }] }),
    })) as unknown as ToolDefinition[];
  }

  it('after construction: getActiveToolNames() has NO mcp__*, getAllTools() has ALL of them', () => {
    // THE G2 assertion. `customTools` are merged into the registry during construction, so the baseline
    // written afterwards is the last word — the force-activation branch never runs. If this ever fails,
    // the fix is to re-apply the baseline AFTER registration, and that is a finding, not a test bug.
    const eligible = ['read', 'grep', 'find', 'ls', ...MCP_NAMES];
    const baseline = eligible.filter((n) => !MCP_NAMES.includes(n));

    const session = realSessionWithCustomTools(eligible, mcpLikeCustomTools(MCP_NAMES), baseline);

    const registry = session.getAllTools().map((t) => t.name);
    for (const n of MCP_NAMES) expect(registry, `${n} must be REGISTERED`).toContain(n);
    const active = session.getActiveToolNames();
    for (const n of MCP_NAMES) expect(active, `${n} must be INACTIVE`).not.toContain(n);
    for (const n of baseline) expect(active, n).toContain(n);
  });

  it('a deferred MCP tool is re-activatable afterwards, because it stayed in `tools:`', () => {
    // The other half of constraint §4.1, on the real session: registered-but-inactive is recoverable,
    // and `setActiveToolsByName` accepts the name because it is both allowed and in the registry.
    const eligible = ['read', 'grep', ...MCP_NAMES];
    const baseline = ['read', 'grep'];
    const session = realSessionWithCustomTools(eligible, mcpLikeCustomTools(MCP_NAMES), baseline);
    expect(session.getActiveToolNames()).not.toContain('mcp__git__status');

    session.setActiveToolsByName([...session.getActiveToolNames(), 'mcp__git__status']);

    const after = session.getActiveToolNames();
    expect(after).toContain('mcp__git__status');
    expect(after).not.toContain('mcp__git__commit'); // only what was asked for
    for (const n of baseline) expect(after, n).toContain(n);
  });

  it('an MCP name absent from `tools:` can never be activated — pi ignores it silently', () => {
    // Why `mcp.names` MUST reach `tools:` (brief §8, first bullet). Registered as a customTool but not
    // allowed, the tool is filtered out of the registry and every later activation is a silent no-op —
    // no error, no log, and ToolSearch reporting success the whole time.
    const session = realSessionWithCustomTools(['read', 'grep'], mcpLikeCustomTools(MCP_NAMES), ['read', 'grep']);

    expect(session.getAllTools().map((t) => t.name)).not.toContain('mcp__git__status');
    session.setActiveToolsByName(['read', 'grep', 'mcp__git__status']);
    expect(session.getActiveToolNames()).not.toContain('mcp__git__status');
  });
});
