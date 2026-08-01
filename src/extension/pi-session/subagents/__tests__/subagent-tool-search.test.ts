import { describe, it, expect, vi } from 'vitest';
import type { ExtensionAPI, ToolDefinition } from '@earendil-works/pi-coding-agent';
import { createSubagentExtensionFactory, type SubagentGateContext } from '../subagent-extension-factory';
import type { GatePermissionContext } from '../../permission-gate';
import { resolveAgentToolset } from '../agent-toolset';
import { DEFAULT_AGENTS } from '../default-agents';
import { deferredToolNames } from '../../tools/deferred-tools';
import type { ToolSearchDetails } from '../../tools/tool-search-tool';
import { BROWSER_PI_TOOL_NAMES } from '../../tools/browser-tools';
import { COMPASS_PI_TOOL_NAMES } from '../../tools/compass-tools';
import { WEB_PI_TOOL_NAMES } from '../../web-access/web-tool-specs';
import { TEAM_AGENT_PI_TOOL_NAMES } from '../../tools/team-tools';
import { TOOL_TOOL_SEARCH } from '../../../../shared/tool-names';

/**
 * Slice 3 §3.3 — the nested session's ToolSearch registration and activation port.
 *
 * These drive the REAL `createSubagentExtensionFactory` against a fake that implements the two pi
 * `ExtensionAPI` methods the port actually uses (`getActiveTools`/`setActiveTools`, both `string[]`-based
 * per `dist/core/extensions/types.d.ts:933,937`) plus `registerTool`. The fake's active-set array IS the
 * thing under test: the port's whole contract is what it does to that array.
 */

/** A stand-in for a bound nested session's `ExtensionAPI`, holding a live mutable active set. */
function fakePi(activeToolNames: string[] = []) {
  let active = [...activeToolNames];
  const registered = new Map<string, ToolDefinition>();
  const handlers = new Map<string, unknown>();
  const setActiveTools = vi.fn((names: string[]) => { active = [...names]; });
  const pi = {
    on: (event: string, handler: unknown) => handlers.set(event, handler),
    registerTool: vi.fn((tool: ToolDefinition) => registered.set(tool.name, tool)),
    getActiveTools: () => [...active],
    // Behaves like the real `getAllTools()`: MATERIALIZES `description` for every registered tool. A
    // stub returning plain objects hides the recursion that took every session down at startup.
    getAllTools: () => [...registered.values()].map((d) => ({ name: d.name, description: d.description })),
    setActiveTools,
  } as unknown as ExtensionAPI;
  return { pi, registered, handlers, setActiveTools, current: () => [...active] };
}

function ctxWith(deferrableToolNames: readonly string[]): SubagentGateContext {
  return {
    permissionHandler: {} as unknown as GatePermissionContext['permissionHandler'],
    isPlanMode: () => false,
    parentToolUseId: 'agent-7',
    deferrableToolNames,
  };
}

const execCtx = (sessionId = 'nested-1') => ({ sessionManager: { getSessionId: () => sessionId } }) as never;

type Result = { content: Array<{ text: string }>; details?: ToolSearchDetails };

/** Register the factory against a fake pi and hand back the ToolSearch definition it registered. */
function register(deferrable: readonly string[], initialActive: string[]) {
  const h = fakePi(initialActive);
  createSubagentExtensionFactory(ctxWith(deferrable))(h.pi);
  return { ...h, tool: h.registered.get(TOOL_TOOL_SEARCH) };
}

async function call(tool: ToolDefinition, entries: string[]): Promise<Result> {
  return (await tool.execute('tc-1', { tools: entries }, undefined, undefined, execCtx())) as unknown as Result;
}

describe('subagent ToolSearch registration (Slice 3 §3.3)', () => {
  it('registers ToolSearch into the nested registry when the agent has a deferrable set', () => {
    // The claim under test is not "the code path exists" but "the tool reaches the registry the model
    // reads". A nested session's ONLY extension is this factory, so if it does not register here the
    // agent has no way to ever load its browser tools and the whole slice is inert for subagents.
    const { registered, tool } = register(BROWSER_PI_TOOL_NAMES, ['read', TOOL_TOOL_SEARCH]);
    expect([...registered.keys()]).toEqual([TOOL_TOOL_SEARCH]);
    expect(tool?.name).toBe(TOOL_TOOL_SEARCH);
  });

  it('skips registration entirely when the deferrable set is empty (nothing to search)', () => {
    const { registered, pi } = register([], ['read', TOOL_TOOL_SEARCH]);
    expect(registered.size).toBe(0);
    expect(pi.registerTool).not.toHaveBeenCalled();
  });

  it('registration is fail-soft: a throwing registerTool does not break the gate hook', () => {
    // Mirrors `damocles-extension.ts`'s established shape. A nested agent losing ToolSearch is a
    // degraded agent; a nested agent losing its PERMISSION GATE is a security hole, so the gate
    // registration that follows must still happen.
    const h = fakePi(['read']);
    (h.pi.registerTool as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => { throw new Error('boom'); });
    expect(() => createSubagentExtensionFactory(ctxWith(BROWSER_PI_TOOL_NAMES))(h.pi)).not.toThrow();
    expect(h.handlers.has('tool_call')).toBe(true);
    expect(h.handlers.has('context')).toBe(true);
  });

  it('reports the agent\'s deferrable universe as its inventory total', async () => {
    // Renamed from "advertises …": this asserts the reported COUNT. What the agent is advertised —
    // the description string it actually reads — is a different guarantee, asserted below.
    const deferrable = [...BROWSER_PI_TOOL_NAMES, ...COMPASS_PI_TOOL_NAMES];
    const { tool } = register(deferrable, ['read', TOOL_TOOL_SEARCH]);
    const result = await call(tool!, ['compass']);
    expect(result.details?.totalDeferredTools).toBe(deferrable.length);
  });

  // The description IS the menu the model orders from. A subagent's universe is narrower than the
  // built-in catalog by design (Explore gets browser but not compass), and one factory is built per
  // spawn — so the scope is knowable here and the menu must be cut to it. Advertising a group the
  // agent's own allowlist cannot reach spends a whole turn on a call that can only ever fail.
  it('advertises ONLY the groups this agent can actually load', () => {
    const { tool } = register(BROWSER_PI_TOOL_NAMES, ['read', TOOL_TOOL_SEARCH]);
    const description = tool!.description;

    expect(description).toContain('browser');
    expect(description).toContain('BrowserOpen');
    expect(description).not.toContain('compass');
    for (const name of COMPASS_PI_TOOL_NAMES) expect(description, name).not.toContain(name);
  });

  it('advertises a partial group at its real size, not the catalog size', () => {
    // A user-disabled browser tool is absent from the agent's universe, so the header count must
    // follow the universe — a count copied from the static catalog would overstate what is loadable.
    const partial = BROWSER_PI_TOOL_NAMES.slice(0, 3);
    const { tool } = register(partial, ['read', TOOL_TOOL_SEARCH]);

    expect(tool!.description).toContain(`browser (${partial.length}):`);
    expect(tool!.description).not.toContain(BROWSER_PI_TOOL_NAMES[BROWSER_PI_TOOL_NAMES.length - 1]!);
  });

  // The shipped crash, at the nested-session wiring: reading the registered ToolSearch's description
  // through a registry that materializes every description recursed until the stack overflowed.
  it('does not recurse when pi materializes every registered tool description', () => {
    const { pi, registered } = register(BROWSER_PI_TOOL_NAMES, ['read', TOOL_TOOL_SEARCH]);
    const readAll = () => [...registered.values()].map((d) => ({ name: d.name, description: d.description }));

    expect(() => (pi as unknown as { getAllTools: () => unknown }).getAllTools()).not.toThrow();
    expect(readAll().find((t) => t.name === TOOL_TOOL_SEARCH)!.description).toContain('BrowserOpen');
  });

  it('advertises both groups when the agent can reach both', () => {
    const { tool } = register([...BROWSER_PI_TOOL_NAMES, ...COMPASS_PI_TOOL_NAMES], ['read', TOOL_TOOL_SEARCH]);
    expect(tool!.description).toContain(`browser (${BROWSER_PI_TOOL_NAMES.length}):`);
    expect(tool!.description).toContain(`compass (${COMPASS_PI_TOOL_NAMES.length}):`);
  });

  it('advertises `web (5)` and its five names to a web-only agent, and nothing else', () => {
    // A web-ONLY universe is the sharp shape here, not a web-plus-browser one: it is the configuration an
    // Explore agent actually gets in the default workspace (web on, browser off), and it is the only one
    // that can distinguish "the menu is scoped to this agent's universe" from "the menu lists every
    // built-in group". A subagent advertised a group its own allowlist cannot reach spends a whole turn
    // on a call that can only ever fail.
    const { tool } = register(WEB_PI_TOOL_NAMES, ['read', TOOL_TOOL_SEARCH]);
    const description = tool!.description;

    expect(description).toContain(`web (${WEB_PI_TOOL_NAMES.length}):`);
    expect(description).toContain('web (5):');
    for (const name of WEB_PI_TOOL_NAMES) expect(description, name).toContain(name);
    expect(description).not.toContain('browser (');
    expect(description).not.toContain('compass');
  });
});

describe('the subagent activation port — additive, and bounded by the agent\'s allowlist', () => {
  it('activation is a strict UNION with the current active set — nothing is ever removed', async () => {
    // Load-bearing for pi's mechanics, not just for tidiness: pi diffs `getActiveTools()` immediately
    // before and after `execute` and stamps `addedToolNames` only when the change is purely additive.
    // ANY removal forces its safe fallback of resending the whole active set, which spends the exact
    // saving this feature exists to make. It is also correctness: dropping the baseline's `read`/`Edit`
    // mid-conversation would silently take tools away from the agent.
    const baseline = ['read', 'bash', 'Edit', TOOL_TOOL_SEARCH];
    const { tool, current, setActiveTools } = register(BROWSER_PI_TOOL_NAMES, baseline);

    await call(tool!, ['browser']);

    const after = current();
    for (const n of baseline) expect(after, n).toContain(n);
    for (const n of BROWSER_PI_TOOL_NAMES) expect(after, n).toContain(n);
    expect(after).toHaveLength(baseline.length + BROWSER_PI_TOOL_NAMES.length);
    // The written array is a superset of what was there before — asserted on the ARGUMENT pi observes.
    const written = setActiveTools.mock.calls.at(-1)![0];
    for (const n of baseline) expect(written, n).toContain(n);
  });

  it('`{tools:["web"]}` activates all five web tools in one call', async () => {
    // The slice's acceptance criterion at the subagent seam: the uniform group means one call yields the
    // whole capability, so a research agent pays ONE ToolSearch round-trip for web rather than five. The
    // baseline is asserted first — without it, an implementation that never deferred web would pass the
    // "all five are active afterwards" half trivially.
    const baseline = ['read', 'grep', TOOL_TOOL_SEARCH];
    const { tool, current } = register(WEB_PI_TOOL_NAMES, baseline);
    for (const n of WEB_PI_TOOL_NAMES) expect(current(), n).not.toContain(n);

    const result = await call(tool!, ['web']);

    expect([...(result.details?.matches ?? [])].sort()).toEqual([...WEB_PI_TOOL_NAMES].sort());
    expect(result.details?.matches).toHaveLength(5);
    for (const n of WEB_PI_TOOL_NAMES) expect(current(), n).toContain(n);
    // Additive, like every other group: the baseline the agent needs from turn one is untouched.
    for (const n of baseline) expect(current(), n).toContain(n);
  });

  it('a second activation keeps the first one loaded (additive across calls, no churn)', async () => {
    const deferrable = [...BROWSER_PI_TOOL_NAMES, ...COMPASS_PI_TOOL_NAMES];
    const { tool, current } = register(deferrable, ['read', TOOL_TOOL_SEARCH]);

    await call(tool!, ['browser']);
    await call(tool!, ['compass']);

    const after = current();
    for (const n of [...BROWSER_PI_TOOL_NAMES, ...COMPASS_PI_TOOL_NAMES]) expect(after, n).toContain(n);
    expect(after).toContain('read');
    // No duplicates: pi pushes one definition per name occurrence and the provider rejects repeats.
    expect(after).toHaveLength(new Set(after).size);
  });

  it('re-activating an already-loaded group writes no new names (idempotent)', async () => {
    const { tool, current } = register(BROWSER_PI_TOOL_NAMES, ['read', TOOL_TOOL_SEARCH, ...BROWSER_PI_TOOL_NAMES]);
    const before = current();
    const result = await call(tool!, ['browser']);
    expect([...current()].sort()).toEqual([...before].sort());
    expect(result.content[0].text).toContain('already loaded');
  });

  it('an agent can NEVER activate outside its own allowlist — Explore cannot reach compass or Edit', async () => {
    // The §3.4 safety property, driven end-to-end rather than asserted on `resolveToolSearchEntries`
    // alone: the port's universe is the agent's OWN deferrable set, and `resolveToolSearchEntries`
    // intersects every match with it. An Explore agent's allowlist has the browser tools but no compass
    // and no write tool, so neither can be reached — which is why §3.4 needs no extra guard.
    const explore = resolveAgentToolset(DEFAULT_AGENTS.get('Explore')!, [
      'read', 'bash', 'grep', 'find', 'ls', 'Edit', 'write', TOOL_TOOL_SEARCH,
      ...BROWSER_PI_TOOL_NAMES, ...COMPASS_PI_TOOL_NAMES,
    ]);
    expect(explore.readOnly).toBe(true);
    const deferrable = deferredToolNames(explore.names, []);
    // The session's REAL baseline: the agent's eligible set minus its deferrable set. Using the true
    // baseline (rather than a two-name stub) is what makes the next assertion sharp — see below.
    const { tool, current, setActiveTools } = register(deferrable, explore.names.filter((n) => !deferrable.includes(n)));

    const result = await call(tool!, ['compass', 'Edit', 'CompassSearch', 'BrowserOpen']);

    expect(result.details?.matches).toEqual(['BrowserOpen']);
    for (const n of [...COMPASS_PI_TOOL_NAMES, 'Edit']) expect(current(), n).not.toContain(n);
    expect(setActiveTools.mock.calls.at(-1)![0]).not.toContain('Edit');
    expect(current()).toContain('BrowserOpen');
  });

  it('the universe is the DEFERRABLE set, not the ACTIVE set — an active non-deferrable name is unknown', async () => {
    // A precise boundary that a plausible-looking implementation gets wrong: building the port's `names`
    // from `getActiveTools()` (or unioning it in) would make every already-active tool "resolvable".
    // That is not merely redundant — it is the hole §3.4 relies on being closed, because a `tools: *`
    // agent's active set contains `Edit`, and the read-only guarantee rests on `resolveToolSearchEntries`
    // intersecting with the DEFERRABLE universe alone.
    const parent = [
      'read', 'bash', 'grep', 'find', 'ls', 'Edit', 'write', TOOL_TOOL_SEARCH,
      ...BROWSER_PI_TOOL_NAMES, ...COMPASS_PI_TOOL_NAMES,
    ];
    const all = resolveAgentToolset(DEFAULT_AGENTS.get('general-purpose')!, parent);
    const deferrable = deferredToolNames(all.names, []);
    const baseline = all.names.filter((n) => !deferrable.includes(n));
    expect(baseline).toContain('Edit'); // the write tool IS active — this is the case that matters

    const { tool, setActiveTools } = register(deferrable, baseline);
    const result = await call(tool!, ['Edit', 'read', TOOL_TOOL_SEARCH]);

    expect(result.details?.matches).toEqual([]);
    expect(setActiveTools).not.toHaveBeenCalled();
    expect(result.content[0].text).toMatch(/Unknown entries/);
    for (const n of ['Edit', 'read', TOOL_TOOL_SEARCH]) expect(result.content[0].text, n).toContain(n);
  });

  it('reports names outside the universe as unknown instead of silently dropping them', async () => {
    const { tool } = register(BROWSER_PI_TOOL_NAMES, ['read', TOOL_TOOL_SEARCH]);
    const result = await call(tool!, ['CompassSearch', 'BrowserOpen']);
    expect(result.content[0].text).toContain('CompassSearch');
    expect(result.content[0].text).toMatch(/Unknown entries/);
    expect(result.details?.matches).toEqual(['BrowserOpen']);
  });

  it('`loaded` is read LIVE from pi, so the baseline\'s state is never stale', async () => {
    // The port reads `pi.getActiveTools()` on every `deferrable()` rather than caching at construction.
    // A cached snapshot would report a tool "already loaded" (or not) based on the state at extension
    // LOAD — before the runtime's baseline was even applied — and the model would be told the wrong
    // thing about its own session.
    const h = fakePi(['read']);
    createSubagentExtensionFactory(ctxWith(BROWSER_PI_TOOL_NAMES))(h.pi);
    const tool = h.registered.get(TOOL_TOOL_SEARCH)!;

    // The runtime's baseline lands AFTER extension load (pi-runtime.ts createSubagentSession) — simulate
    // that ordering by activating a browser tool through pi directly, then asking ToolSearch for it.
    h.setActiveTools(['read', TOOL_TOOL_SEARCH, BROWSER_PI_TOOL_NAMES[0]!]);
    const result = await call(tool, [BROWSER_PI_TOOL_NAMES[0]!]);
    expect(result.content[0].text).toContain('already loaded');
  });

  it('a team agent\'s deferrable set carries compass but never a team_* tool (§3.5)', async () => {
    // A team specialist must be able to post to the scratchpad from turn one, so no `team_*` name may be
    // deferrable. That falls out of `deferredToolNames` intersecting with browser ∪ compass ∪ web — no special
    // case, which is exactly what this pins: adding one would be the bandaid.
    const teamEligible = ['read', 'Edit', TOOL_TOOL_SEARCH, ...TEAM_AGENT_PI_TOOL_NAMES, ...COMPASS_PI_TOOL_NAMES, ...BROWSER_PI_TOOL_NAMES];
    const deferrable = deferredToolNames(teamEligible, []);
    for (const n of TEAM_AGENT_PI_TOOL_NAMES) expect(deferrable, n).not.toContain(n);
    for (const n of COMPASS_PI_TOOL_NAMES) expect(deferrable, n).toContain(n);

    const { tool, current } = register(deferrable, teamEligible.filter((n) => !deferrable.includes(n)));
    // The team tools are active from the first request…
    for (const n of TEAM_AGENT_PI_TOOL_NAMES) expect(current(), n).toContain(n);
    // …and loading compass mid-run neither adds nor removes any of them.
    await call(tool!, ['compass']);
    for (const n of COMPASS_PI_TOOL_NAMES) expect(current(), n).toContain(n);
    for (const n of TEAM_AGENT_PI_TOOL_NAMES) expect(current(), n).toContain(n);
  });

  it('a team agent cannot activate a team_* tool through ToolSearch (they were never deferrable)', async () => {
    const teamEligible = ['read', TOOL_TOOL_SEARCH, ...TEAM_AGENT_PI_TOOL_NAMES, ...COMPASS_PI_TOOL_NAMES];
    const { tool } = register(deferredToolNames(teamEligible, []), ['read', TOOL_TOOL_SEARCH, ...TEAM_AGENT_PI_TOOL_NAMES]);
    const result = await call(tool!, [TEAM_AGENT_PI_TOOL_NAMES[0]!]);
    expect(result.details?.matches).toEqual([]);
    expect(result.content[0].text).toContain(TEAM_AGENT_PI_TOOL_NAMES[0]!);
  });
});
