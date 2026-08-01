import { describe, it, expect, vi } from 'vitest';
import type { PiCodingAgentModule } from '../../pi-loader';
import type { McpClientManager } from '../../mcp/mcp-client-manager';
import type { McpToolDescriptor } from '../../mcp/types';
import { buildNestedMcpToolset, EMPTY_NESTED_MCP_TOOLSET } from '../mcp-tools';

vi.mock('../../../logger', () => ({ log: vi.fn() }));

/**
 * Slice 1 §3.2 / step 1 — the frozen per-spawn MCP snapshot.
 *
 * The snapshot is the whole mechanism: a nested agent's `tools:` names, its `customTools`, its gate
 * read-only classifier and its ToolSearch blurbs are all derived from ONE `getAllToolDescriptors()`
 * read. Every property below exists because its absence produces a SILENT failure — a name in `tools:`
 * with no matching definition is dropped by pi with no error, and a definition with no name in `tools:`
 * is filtered out of the registry the same way.
 *
 * `pi` is stubbed at exactly the seam `buildMcpPiTool` uses (`defineTool`), so the definitions built
 * here are the real ones the nested session receives — the descriptor is NOT faked away.
 */

const piStub = { defineTool: (tool: unknown) => tool } as unknown as PiCodingAgentModule;

function descriptor(overrides: Partial<McpToolDescriptor> = {}): McpToolDescriptor {
  return {
    piName: 'mcp__git__status',
    serverName: 'git',
    kind: 'tool',
    originalName: 'status',
    description: 'Show the working tree status',
    inputSchema: { type: 'object', properties: {} },
    readOnly: true,
    ...overrides,
  };
}

const GIT_STATUS = descriptor();
const GIT_COMMIT = descriptor({ piName: 'mcp__git__commit', originalName: 'commit', description: 'Create a commit', readOnly: false });
const CTX_QUERY = descriptor({ piName: 'mcp__ctx7__query_docs', serverName: 'ctx7', originalName: 'query_docs', description: 'Query library docs', readOnly: false });

/** A manager stub whose descriptor list is MUTABLE, so "frozen at spawn" can be tested by changing it. */
function fakeManager(initial: McpToolDescriptor[]) {
  let descriptors = [...initial];
  const getAllToolDescriptors = vi.fn(() => [...descriptors]);
  const callTool = vi.fn(async (_piName: string, _args: Record<string, unknown>, _opts?: { signal?: AbortSignal }) => ({
    content: [{ type: 'text' as const, text: 'ok' }],
    isError: false,
  }));
  // `buildMcpPiTool`'s failure path asks the manager whether the descriptor still exists, so the fake
  // answers from the SAME mutable list — a stub that always returned a descriptor would hide the
  // vanished-tool branch entirely.
  const getToolDescriptor = vi.fn((piName: string) => descriptors.find((d) => d.piName === piName));
  const manager = { getAllToolDescriptors, getToolDescriptor, callTool } as unknown as McpClientManager;
  return {
    manager,
    getAllToolDescriptors,
    getToolDescriptor,
    callTool,
    replace: (next: McpToolDescriptor[]) => { descriptors = [...next]; },
  };
}

const eligibleOf = (...descriptors: McpToolDescriptor[]) => new Set(descriptors.map((d) => d.piName));

describe('buildNestedMcpToolset — the frozen per-spawn snapshot', () => {
  it('`names` and `tools` are SET-EQUAL and in the same order (§8: a mismatch is dropped silently)', () => {
    // Not containment. pi freezes `options.tools` into `_allowedToolNames` and filters the REGISTRY by
    // it: a definition whose name is missing from `tools:` is discarded with no error, and a name with
    // no definition is ignored by `setActiveToolsByName` with no error. Either direction of divergence
    // is invisible at runtime, so the only guard is equality asserted in both directions here.
    const { manager } = fakeManager([GIT_STATUS, GIT_COMMIT, CTX_QUERY]);

    const toolset = buildNestedMcpToolset(piStub, manager, { eligible: eligibleOf(GIT_STATUS, GIT_COMMIT, CTX_QUERY) });

    const toolNames = toolset.tools.map((t) => t.name);
    expect(new Set(toolset.names)).toEqual(new Set(toolNames));
    expect(toolset.names).toEqual(toolNames); // same ORDER, so `tools[i]` really is `names[i]`
    expect(toolset.names).toHaveLength(toolset.tools.length);
    expect(toolset.names).toHaveLength(3);
  });

  it('excludes a descriptor absent from `eligible` — panel eligibility is authoritative', () => {
    // `eligible` is `new Set(fullActiveToolNames())`, which already carries the MCP master switch and
    // `damocles.tools.disabled` (tool-status.ts:65). A descriptor the panel cannot use must never reach
    // a nested agent, or the subagent becomes a bypass around the user's own switches.
    const { manager } = fakeManager([GIT_STATUS, GIT_COMMIT, CTX_QUERY]);

    const toolset = buildNestedMcpToolset(piStub, manager, { eligible: eligibleOf(GIT_STATUS, CTX_QUERY) });

    expect(toolset.names).toEqual(['mcp__git__status', 'mcp__ctx7__query_docs']);
    expect(toolset.tools.map((t) => t.name)).toEqual(['mcp__git__status', 'mcp__ctx7__query_docs']);
    expect(toolset.descriptions.has('mcp__git__commit')).toBe(false);
  });

  it('subtracts `disallowed` from BOTH names and tools (the agent-level opt-out)', () => {
    const { manager } = fakeManager([GIT_STATUS, GIT_COMMIT, CTX_QUERY]);

    const toolset = buildNestedMcpToolset(piStub, manager, {
      eligible: eligibleOf(GIT_STATUS, GIT_COMMIT, CTX_QUERY),
      disallowed: new Set(['mcp__git__commit']),
    });

    expect(toolset.names).toEqual(['mcp__git__status', 'mcp__ctx7__query_docs']);
    // The subtraction must apply to the DEFINITIONS too: dropping only the name would leave a
    // definition pi filters out of the registry, which reads as success and is not.
    expect(toolset.tools.map((t) => t.name)).toEqual(['mcp__git__status', 'mcp__ctx7__query_docs']);
    expect(new Set(toolset.names)).toEqual(new Set(toolset.tools.map((t) => t.name)));
  });

  it('`manager === null` yields EMPTY_NESTED_MCP_TOOLSET without throwing (no-MCP workspaces)', () => {
    let toolset!: ReturnType<typeof buildNestedMcpToolset>;
    expect(() => { toolset = buildNestedMcpToolset(piStub, null, { eligible: new Set(['mcp__git__status']) }); }).not.toThrow();

    expect(toolset).toBe(EMPTY_NESTED_MCP_TOOLSET);
    expect(toolset.names).toEqual([]);
    expect(toolset.tools).toEqual([]);
    expect(toolset.descriptions.size).toBe(0);
    expect(toolset.isReadOnly('mcp__git__status')).toBe(false);
  });

  it('carries each surviving descriptor\'s description, for the nested ToolSearch inventory', () => {
    const { manager } = fakeManager([GIT_STATUS, GIT_COMMIT]);

    const toolset = buildNestedMcpToolset(piStub, manager, { eligible: eligibleOf(GIT_STATUS, GIT_COMMIT) });

    expect(toolset.descriptions.get('mcp__git__status')).toBe('Show the working tree status');
    expect(toolset.descriptions.get('mcp__git__commit')).toBe('Create a commit');
    expect([...toolset.descriptions.keys()].sort()).toEqual([...toolset.names].sort());
  });

  it('calls `getAllToolDescriptors()` EXACTLY ONCE — the structural guard for §3.2', () => {
    // The divergence window this whole slice exists to close. A second read anywhere in a spawn path
    // means `tools:` and `customTools` can be built from two different descriptor sets, which is
    // precisely the shape of the bug that silently dropped every team agent's MCP tools. Asserting the
    // call COUNT is the only way to catch a re-read that happens to return the same array in a test.
    const { manager, getAllToolDescriptors } = fakeManager([GIT_STATUS, GIT_COMMIT, CTX_QUERY]);

    const toolset = buildNestedMcpToolset(piStub, manager, { eligible: eligibleOf(GIT_STATUS, GIT_COMMIT, CTX_QUERY) });
    // Touch every field: a lazily-derived field that re-reads the manager on first access would only
    // show up once the field is actually consumed.
    void toolset.names.length;
    void toolset.tools.length;
    void toolset.descriptions.size;
    void toolset.isReadOnly('mcp__git__status');

    expect(getAllToolDescriptors).toHaveBeenCalledTimes(1);
  });
});

describe('buildNestedMcpToolset — `isReadOnly` is a FROZEN gate classifier, not a grant filter', () => {
  it('classifies read-only ONLY for descriptors with `readOnly === true`', () => {
    // §3.5: this decides auto-allow vs. `canUseTool`, giving a nested session the parity the panel has.
    // It never filters the grant — the non-annotated tool is still in `names`/`tools`.
    const { manager } = fakeManager([GIT_STATUS, GIT_COMMIT]);

    const toolset = buildNestedMcpToolset(piStub, manager, { eligible: eligibleOf(GIT_STATUS, GIT_COMMIT) });

    expect(toolset.isReadOnly('mcp__git__status')).toBe(true);
    expect(toolset.isReadOnly('mcp__git__commit')).toBe(false);
    // …and both were granted. If this classifier were doubling as a filter, `commit` would be absent.
    expect(toolset.names).toContain('mcp__git__commit');
  });

  it('an UNKNOWN name is not read-only — fail-closed to "ask the user"', () => {
    // The default has to be the SAFE one: an unknown name classified read-only would auto-allow a call
    // the snapshot never vetted. False here costs one approval prompt; true costs a silent execution.
    const { manager } = fakeManager([GIT_STATUS]);

    const toolset = buildNestedMcpToolset(piStub, manager, { eligible: eligibleOf(GIT_STATUS) });

    expect(toolset.isReadOnly('mcp__git__push')).toBe(false);
    expect(toolset.isReadOnly('mcp__unknown__thing')).toBe(false);
    expect(toolset.isReadOnly('read')).toBe(false);
    expect(toolset.isReadOnly('')).toBe(false);
  });

  it('a descriptor EXCLUDED by `disallowed` is not classified read-only either', () => {
    // The classifier closes over the SURVIVING descriptors, so a tool the agent was denied is unknown
    // to it — consistent with the unknown-name rule above rather than a second, divergent answer.
    const { manager } = fakeManager([GIT_STATUS, GIT_COMMIT]);

    const toolset = buildNestedMcpToolset(piStub, manager, {
      eligible: eligibleOf(GIT_STATUS, GIT_COMMIT),
      disallowed: new Set(['mcp__git__status']),
    });

    expect(toolset.names).not.toContain('mcp__git__status');
    expect(toolset.isReadOnly('mcp__git__status')).toBe(false);
  });

  it('is FROZEN: mutating the manager after the spawn changes no answer it already gave', () => {
    // "Frozen at spawn" (§3.3) stated as behaviour rather than as prose. A running agent must see one
    // stable universe for its whole life — a classifier that re-read the manager would let a server
    // reconnect mid-run and flip a tool the agent already reasoned about from prompt to auto-allow.
    const { manager, replace, getAllToolDescriptors } = fakeManager([GIT_STATUS, GIT_COMMIT]);
    const toolset = buildNestedMcpToolset(piStub, manager, { eligible: eligibleOf(GIT_STATUS, GIT_COMMIT, CTX_QUERY) });

    // The server re-advertises `commit` as read-only, drops `status`, and adds a whole new server.
    replace([descriptor({ piName: 'mcp__git__commit', originalName: 'commit', readOnly: true }), CTX_QUERY]);

    expect(toolset.isReadOnly('mcp__git__commit')).toBe(false); // still the snapshot's answer
    expect(toolset.isReadOnly('mcp__git__status')).toBe(true);  // still known, still read-only
    expect(toolset.isReadOnly('mcp__ctx7__query_docs')).toBe(false); // never in this agent's universe
    expect(toolset.names).toEqual(['mcp__git__status', 'mcp__git__commit']);
    expect(toolset.descriptions.has('mcp__ctx7__query_docs')).toBe(false);
    // And the freeze is structural — no field re-read the manager to answer any of the above.
    expect(getAllToolDescriptors).toHaveBeenCalledTimes(1);
  });

  it('a resource descriptor (hardcoded readOnly) classifies read-only like the panel does', () => {
    // `mcp-client-manager.ts:494` hardcodes `readOnly: true` for `kind: 'resource'`. A nested agent
    // inherits that trust decision rather than re-deriving one, which is why this reads the field.
    const resource = descriptor({ piName: 'mcp__git__get_readme', kind: 'resource', originalName: 'get_readme', resourceUri: 'file:///README.md', readOnly: true });
    const { manager } = fakeManager([resource]);

    const toolset = buildNestedMcpToolset(piStub, manager, { eligible: eligibleOf(resource) });

    expect(toolset.isReadOnly('mcp__git__get_readme')).toBe(true);
  });
});

describe('buildNestedMcpToolset — the definitions are the REAL callable tools', () => {
  it('executing a built definition reaches `McpClientManager.callTool` with that piName', async () => {
    // The point of the snapshot is a CALLABLE tool, not a name list. Driving the definition proves the
    // descriptor was closed over correctly — a builder that mixed up indices between `names` and
    // `tools` would still satisfy set-equality but call the wrong server tool here.
    const { manager, callTool } = fakeManager([GIT_STATUS, GIT_COMMIT]);
    const toolset = buildNestedMcpToolset(piStub, manager, { eligible: eligibleOf(GIT_STATUS, GIT_COMMIT) });

    const commit = toolset.tools.find((t) => t.name === 'mcp__git__commit')!;
    const result = await (commit.execute as unknown as (
      id: string, params: unknown, signal: AbortSignal | undefined, onUpdate: undefined, ctx: unknown,
    ) => Promise<{ content: Array<{ type: string; text?: string }> }>)('tc-1', { message: 'x' }, undefined, undefined, {});

    expect(callTool).toHaveBeenCalledTimes(1);
    expect(callTool.mock.calls[0]![0]).toBe('mcp__git__commit');
    expect(callTool.mock.calls[0]![1]).toEqual({ message: 'x' });
    expect(result.content).toEqual([{ type: 'text', text: 'ok' }]);
  });
});

/**
 * Slice 2 §3.1 — the nested elicitation bridge. A nested session never binds pi's UI, so the only way
 * its MCP tools can prompt is the bridge handed in at spawn. These assert on what `callTool` RECEIVED,
 * because `activeCallUis` bookkeeping keys off the option being PRESENT, not on its value.
 */
describe('buildNestedMcpToolset — `elicitationUi` reaches every tool in the snapshot', () => {
  const uiStub = { select: vi.fn(), input: vi.fn(), notify: vi.fn() };
  const run = async (tool: { execute: unknown }, ctx: unknown = {}): Promise<void> => {
    await (tool.execute as unknown as (
      id: string, params: unknown, signal: undefined, onUpdate: undefined, ctx: unknown,
    ) => Promise<unknown>)('tc-1', {}, undefined, undefined, ctx);
  };

  it('threads the bridge into EVERY definition, not just the first', async () => {
    // The loop builds one definition per descriptor; threading the option outside the loop (or into a
    // single shared `opts` that a later tool overwrites) would leave the second agent tool silent.
    const { manager, callTool } = fakeManager([GIT_STATUS, GIT_COMMIT]);
    const toolset = buildNestedMcpToolset(piStub, manager, {
      eligible: eligibleOf(GIT_STATUS, GIT_COMMIT),
      elicitationUi: uiStub,
    });

    for (const tool of toolset.tools) await run(tool);

    expect(callTool).toHaveBeenCalledTimes(2);
    for (const call of callTool.mock.calls) {
      expect((call[2] as { elicitationUi?: unknown }).elicitationUi).toBe(uiStub);
    }
  });

  it('omits the KEY when no bridge is supplied, even though `ctx.ui` is truthy', async () => {
    // pi hands every unbound session a truthy `noOpUIContext` whose `select` resolves `undefined`,
    // which `runForm` reads as a user cancel. Passing it would answer the server "cancelled" and tell
    // the model nothing. Key absence — `elicitationUi: undefined` would still be pushed onto the stack.
    const { manager, callTool } = fakeManager([GIT_STATUS]);
    const toolset = buildNestedMcpToolset(piStub, manager, { eligible: eligibleOf(GIT_STATUS) });
    const noOpUi = { select: async () => undefined, input: async () => undefined, notify: () => {} };

    await run(toolset.tools[0]!, { ui: noOpUi, hasUI: false });

    const received = callTool.mock.calls[0]![2] as Record<string, unknown>;
    expect('elicitationUi' in received).toBe(false);
  });

  it('the explicit bridge WINS over a bound `ctx.ui`', async () => {
    // Precedence is `opts.elicitationUi ?? (ctx.hasUI ? ctx.ui : undefined)`. If it were the other way
    // round, a nested tool that happened to run under a bound context would attribute its prompt to the
    // panel instead of the agent — a wrong name, which is worse than none.
    const { manager, callTool } = fakeManager([GIT_STATUS]);
    const toolset = buildNestedMcpToolset(piStub, manager, { eligible: eligibleOf(GIT_STATUS), elicitationUi: uiStub });
    const panelUi = { select: async () => undefined, input: async () => undefined, notify: () => {} };

    await run(toolset.tools[0]!, { ui: panelUi, hasUI: true });

    expect((callTool.mock.calls[0]![2] as { elicitationUi?: unknown }).elicitationUi).toBe(uiStub);
  });
});
