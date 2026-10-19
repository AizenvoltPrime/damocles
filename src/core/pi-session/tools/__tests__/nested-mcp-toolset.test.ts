import { describe, it, expect, vi } from 'vitest';
import { readFileSync, rmSync } from 'node:fs';
import type { PiCodingAgentModule } from '../../pi-loader';
import type { McpResourceServer, McpToolCallOptions, McpToolSource } from '../../mcp/tool-source';
import type { McpResourceRuleFilter } from '../../../permission-handler/mcp-resource-rule';
import { MCP_RESOURCE_TOOL_NAMES } from '../../../../shared/tool-names';
import { FolderMcpView } from '../../mcp/folder-mcp-view';
import { managerWithFake, specOf } from '../../mcp/__tests__/fake-server-manager';
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
    serverId: `test/${overrides.serverName ?? 'git'}`,
    rawToolName: 'status',
    description: 'Show the working tree status',
    inputSchema: { type: 'object', properties: {} },
    readOnly: true,
    exposure: 'deferred',
    exposureSource: 'config',
    configExposure: 'deferred',
    ...overrides,
  };
}

const GIT_STATUS = descriptor();
const GIT_COMMIT = descriptor({ piName: 'mcp__git__commit', rawToolName: 'commit', description: 'Create a commit', readOnly: false });
const CTX_QUERY = descriptor({ piName: 'mcp__ctx7__query_docs', serverName: 'ctx7', rawToolName: 'query_docs', description: 'Query library docs', readOnly: false });

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
  let servers: McpResourceServer[] = [];
  const resourceServers = vi.fn(() => [...servers]);
  const readResource = vi.fn(async (_server: string, uri: string, _opts?: McpToolCallOptions) => ({ contents: [{ uri, text: 'body' }] }));
  const manager = { getAllToolDescriptors, getToolDescriptor, callTool, resourceServers, readResource } as unknown as McpToolSource;
  return {
    manager,
    getAllToolDescriptors,
    getToolDescriptor,
    callTool,
    resourceServers,
    readResource,
    replace: (next: McpToolDescriptor[]) => { descriptors = [...next]; },
    setResourceServers: (next: McpResourceServer[]) => { servers = [...next]; },
  };
}

const NO_RESOURCE_RULES = async (): Promise<McpResourceRuleFilter> => ({ serverCovered: () => false, resourceDenied: () => false, resourceDenyRule: () => undefined, contentCovered: () => false });

const eligibleOf = (...descriptors: McpToolDescriptor[]) => new Set(descriptors.map((d) => d.piName));

describe('buildNestedMcpToolset — the frozen per-spawn snapshot', () => {
  it('`names` and `tools` are SET-EQUAL and in the same order (§8: a mismatch is dropped silently)', () => {
    // Not containment. pi turns `options.tools` into its allowlist: a definition whose name is missing
    // from `tools:` is unregistered or never activatable, with no error, and a name with
    // no definition is ignored by `setActiveToolsByName` with no error. Either direction of divergence
    // is invisible at runtime, so the only guard is equality asserted in both directions here.
    const { manager } = fakeManager([GIT_STATUS, GIT_COMMIT, CTX_QUERY]);

    const toolset = buildNestedMcpToolset(piStub, manager, { resourceRuleFilter: NO_RESOURCE_RULES, disabledEntries: [], eligible: eligibleOf(GIT_STATUS, GIT_COMMIT, CTX_QUERY) });

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

    const toolset = buildNestedMcpToolset(piStub, manager, { resourceRuleFilter: NO_RESOURCE_RULES, disabledEntries: [], eligible: eligibleOf(GIT_STATUS, CTX_QUERY) });

    expect(toolset.names).toEqual(['mcp__git__status', 'mcp__ctx7__query_docs']);
    expect(toolset.tools.map((t) => t.name)).toEqual(['mcp__git__status', 'mcp__ctx7__query_docs']);
    expect(toolset.descriptions.has('mcp__git__commit')).toBe(false);
  });

  it('subtracts `disallowed` from BOTH names and tools (the agent-level opt-out)', () => {
    const { manager } = fakeManager([GIT_STATUS, GIT_COMMIT, CTX_QUERY]);

    const toolset = buildNestedMcpToolset(piStub, manager, {
      resourceRuleFilter: NO_RESOURCE_RULES, disabledEntries: [], eligible: eligibleOf(GIT_STATUS, GIT_COMMIT, CTX_QUERY),
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
    expect(() => { toolset = buildNestedMcpToolset(piStub, null, { resourceRuleFilter: NO_RESOURCE_RULES, disabledEntries: [], eligible: new Set(['mcp__git__status']) }); }).not.toThrow();

    expect(toolset).toBe(EMPTY_NESTED_MCP_TOOLSET);
    expect(toolset.names).toEqual([]);
    expect(toolset.tools).toEqual([]);
    expect(toolset.deferrable).toEqual([]);
    expect(toolset.direct).toEqual([]);
    expect(toolset.descriptions.size).toBe(0);
    expect(toolset.isReadOnly('mcp__git__status')).toBe(false);
  });

  it('splits `names` by exposure from the same read: `deferrable` and `direct` partition it, in order', () => {
    // `deferrable ⊆ names` is what keeps the nested menu equal to the loadable set: a deferrable name
    // with no grant would be advertised and then refused, and a direct one in it would be held back.
    const direct = descriptor({ piName: 'mcp__git__log', rawToolName: 'log', exposure: 'direct' });
    const { manager, getAllToolDescriptors } = fakeManager([GIT_STATUS, direct, GIT_COMMIT, CTX_QUERY]);

    const toolset = buildNestedMcpToolset(piStub, manager, { resourceRuleFilter: NO_RESOURCE_RULES, disabledEntries: [], eligible: eligibleOf(GIT_STATUS, direct, GIT_COMMIT) });

    expect(toolset.names).toEqual(['mcp__git__status', 'mcp__git__log', 'mcp__git__commit']);
    expect(toolset.deferrable).toEqual(['mcp__git__status', 'mcp__git__commit']);
    expect(toolset.direct).toEqual(['mcp__git__log']);
    const names = new Set(toolset.names);
    for (const name of [...toolset.deferrable, ...toolset.direct]) expect(names.has(name), name).toBe(true);
    expect(new Set([...toolset.deferrable, ...toolset.direct])).toEqual(names);
    // The direct tool is granted (a definition in `tools`) but never on the nested menu.
    expect(toolset.tools.map((t) => t.name)).toContain('mcp__git__log');
    expect([...toolset.descriptions.keys()]).toEqual(toolset.deferrable);
    expect(getAllToolDescriptors).toHaveBeenCalledTimes(1);
  });

  it("an Off tool reaches no nested agent: the panel's eligibility already dropped it", () => {
    const off = descriptor({ piName: 'mcp__git__push', rawToolName: 'push', exposure: 'off' });
    const { manager } = fakeManager([GIT_STATUS, off]);

    const toolset = buildNestedMcpToolset(piStub, manager, { resourceRuleFilter: NO_RESOURCE_RULES, disabledEntries: [], eligible: eligibleOf(GIT_STATUS) });

    expect(toolset.names).toEqual(['mcp__git__status']);
    expect(toolset.deferrable).toEqual(['mcp__git__status']);
    expect(toolset.direct).toEqual([]);
  });

  it('an Off tool is never granted, even when the eligible set it is handed names it', () => {
    const off = descriptor({ piName: 'mcp__git__push', rawToolName: 'push', exposure: 'off' });
    const { manager } = fakeManager([GIT_STATUS, off]);

    const toolset = buildNestedMcpToolset(piStub, manager, { resourceRuleFilter: NO_RESOURCE_RULES, disabledEntries: [], eligible: eligibleOf(GIT_STATUS, off) });

    expect(toolset.names).toEqual(['mcp__git__status']);
    expect(toolset.tools.map((t) => t.name)).toEqual(['mcp__git__status']);
    expect(toolset.direct).toEqual([]);
    expect(toolset.directGroups.size).toBe(0);
  });

  it('records the ToolSearch group of every Always-loaded tool', () => {
    const direct = descriptor({ piName: 'mcp__ctx7__resolve', serverName: 'ctx7', rawToolName: 'resolve', exposure: 'direct' });
    const { manager } = fakeManager([GIT_STATUS, direct]);

    const toolset = buildNestedMcpToolset(piStub, manager, { resourceRuleFilter: NO_RESOURCE_RULES, disabledEntries: [], eligible: eligibleOf(GIT_STATUS, direct) });

    expect([...toolset.directGroups]).toEqual(['ctx7']);
  });

  it('carries each surviving descriptor\'s description, for the nested ToolSearch inventory', () => {
    const { manager } = fakeManager([GIT_STATUS, GIT_COMMIT]);

    const toolset = buildNestedMcpToolset(piStub, manager, { resourceRuleFilter: NO_RESOURCE_RULES, disabledEntries: [], eligible: eligibleOf(GIT_STATUS, GIT_COMMIT) });

    expect(toolset.descriptions.get('mcp__git__status')).toEqual({ description: 'Show the working tree status', group: 'git' });
    expect(toolset.descriptions.get('mcp__git__commit')).toEqual({ description: 'Create a commit', group: 'git' });
    expect([...toolset.descriptions.keys()].sort()).toEqual([...toolset.names].sort());
  });

  it('takes the ToolSearch group and server line from the descriptor, not from the tool name', () => {
    const hashed = descriptor({ piName: 'mcp__my_server__a_b_4f33a9a2', serverName: 'my-server', rawToolName: 'a-b', serverDescription: 'Team tools' });
    const { manager } = fakeManager([hashed]);

    const toolset = buildNestedMcpToolset(piStub, manager, { resourceRuleFilter: NO_RESOURCE_RULES, disabledEntries: [], eligible: eligibleOf(hashed) });

    expect(toolset.descriptions.get(hashed.piName)).toEqual({
      description: 'Show the working tree status',
      group: 'my_server',
      serverDescription: 'Team tools',
    });
  });

  it('calls `getAllToolDescriptors()` EXACTLY ONCE — the structural guard for §3.2', () => {
    // The divergence window this whole slice exists to close. A second read anywhere in a spawn path
    // means `tools:` and `customTools` can be built from two different descriptor sets, which is
    // precisely the shape of the bug that silently dropped every team agent's MCP tools. Asserting the
    // call COUNT is the only way to catch a re-read that happens to return the same array in a test.
    const { manager, getAllToolDescriptors } = fakeManager([GIT_STATUS, GIT_COMMIT, CTX_QUERY]);

    const toolset = buildNestedMcpToolset(piStub, manager, { resourceRuleFilter: NO_RESOURCE_RULES, disabledEntries: [], eligible: eligibleOf(GIT_STATUS, GIT_COMMIT, CTX_QUERY) });
    // Touch every field: a lazily-derived field that re-reads the manager on first access would only
    // show up once the field is actually consumed.
    void toolset.names.length;
    void toolset.tools.length;
    void toolset.descriptions.size;
    void toolset.deferrable.length;
    void toolset.direct.length;
    void toolset.isReadOnly('mcp__git__status');

    expect(getAllToolDescriptors).toHaveBeenCalledTimes(1);
  });
});

describe('buildNestedMcpToolset — `isReadOnly` is a FROZEN gate classifier, not a grant filter', () => {
  it('classifies read-only ONLY for descriptors with `readOnly === true`', () => {
    // §3.5: this decides auto-allow vs. `canUseTool`, giving a nested session the parity the panel has.
    // It never filters the grant — the non-annotated tool is still in `names`/`tools`.
    const { manager } = fakeManager([GIT_STATUS, GIT_COMMIT]);

    const toolset = buildNestedMcpToolset(piStub, manager, { resourceRuleFilter: NO_RESOURCE_RULES, disabledEntries: [], eligible: eligibleOf(GIT_STATUS, GIT_COMMIT) });

    expect(toolset.isReadOnly('mcp__git__status')).toBe(true);
    expect(toolset.isReadOnly('mcp__git__commit')).toBe(false);
    // …and both were granted. If this classifier were doubling as a filter, `commit` would be absent.
    expect(toolset.names).toContain('mcp__git__commit');
  });

  it('an UNKNOWN name is not read-only — fail-closed to "ask the user"', () => {
    // The default has to be the SAFE one: an unknown name classified read-only would auto-allow a call
    // the snapshot never vetted. False here costs one approval prompt; true costs a silent execution.
    const { manager } = fakeManager([GIT_STATUS]);

    const toolset = buildNestedMcpToolset(piStub, manager, { resourceRuleFilter: NO_RESOURCE_RULES, disabledEntries: [], eligible: eligibleOf(GIT_STATUS) });

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
      resourceRuleFilter: NO_RESOURCE_RULES, disabledEntries: [], eligible: eligibleOf(GIT_STATUS, GIT_COMMIT),
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
    const toolset = buildNestedMcpToolset(piStub, manager, { resourceRuleFilter: NO_RESOURCE_RULES, disabledEntries: [], eligible: eligibleOf(GIT_STATUS, GIT_COMMIT, CTX_QUERY) });

    // The server re-advertises `commit` as read-only, drops `status`, and adds a whole new server.
    replace([descriptor({ piName: 'mcp__git__commit', rawToolName: 'commit', readOnly: true }), CTX_QUERY]);

    expect(toolset.isReadOnly('mcp__git__commit')).toBe(false); // still the snapshot's answer
    expect(toolset.isReadOnly('mcp__git__status')).toBe(true);  // still known, still read-only
    expect(toolset.isReadOnly('mcp__ctx7__query_docs')).toBe(false); // never in this agent's universe
    expect(toolset.names).toEqual(['mcp__git__status', 'mcp__git__commit']);
    expect(toolset.descriptions.has('mcp__ctx7__query_docs')).toBe(false);
    // And the freeze is structural — no field re-read the manager to answer any of the above.
    expect(getAllToolDescriptors).toHaveBeenCalledTimes(1);
  });

});

describe('buildNestedMcpToolset — the MCP resource tools, frozen to the resource servers at spawn', () => {
  const DOCS: McpResourceServer = { serverName: 'docs', serverId: 'm1/docs', exposure: 'deferred' };
  const LIVE: McpResourceServer = { serverName: 'live', serverId: 'm1/live', exposure: 'direct' };
  const eligibleWithResources = (...descriptors: McpToolDescriptor[]) => new Set([...eligibleOf(...descriptors), ...MCP_RESOURCE_TOOL_NAMES]);
  type Execute = (id: string, params: unknown, signal: undefined, onUpdate: undefined, ctx: unknown) => Promise<{ content: Array<{ type: string; text?: string }> }>;
  const read = (toolset: { tools: readonly { name: string; execute: unknown }[] }, params: unknown) =>
    (toolset.tools.find((t) => t.name === 'read_mcp_resource')!.execute as unknown as Execute)('tc-1', params, undefined, undefined, {});

  it('grants the three tools, set-equal with their definitions and deferred, when no frozen server is Always loaded', () => {
    const { manager, setResourceServers, resourceServers } = fakeManager([GIT_STATUS]);
    setResourceServers([DOCS]);

    const toolset = buildNestedMcpToolset(piStub, manager, { resourceRuleFilter: NO_RESOURCE_RULES, disabledEntries: [], eligible: eligibleWithResources(GIT_STATUS) });

    expect(toolset.names).toEqual(['mcp__git__status', ...MCP_RESOURCE_TOOL_NAMES]);
    expect(toolset.tools.map((t) => t.name)).toEqual(toolset.names);
    expect(toolset.deferrable).toEqual(['mcp__git__status', ...MCP_RESOURCE_TOOL_NAMES]);
    expect(toolset.direct).toEqual([]);
    expect(resourceServers).toHaveBeenCalledTimes(1);
  });

  it('files them direct when any frozen resource server is Always loaded', () => {
    const { manager, setResourceServers } = fakeManager([GIT_STATUS]);
    setResourceServers([DOCS, LIVE]);

    const toolset = buildNestedMcpToolset(piStub, manager, { resourceRuleFilter: NO_RESOURCE_RULES, disabledEntries: [], eligible: eligibleWithResources(GIT_STATUS) });

    expect(toolset.direct).toEqual([...MCP_RESOURCE_TOOL_NAMES]);
    expect(toolset.deferrable).toEqual(['mcp__git__status']);
  });

  it('a spawn before a resource server appeared has none; a spawn after has them', () => {
    const { manager, setResourceServers } = fakeManager([GIT_STATUS]);
    const before = buildNestedMcpToolset(piStub, manager, { resourceRuleFilter: NO_RESOURCE_RULES, disabledEntries: [], eligible: eligibleWithResources(GIT_STATUS) });
    setResourceServers([DOCS]);
    const after = buildNestedMcpToolset(piStub, manager, { resourceRuleFilter: NO_RESOURCE_RULES, disabledEntries: [], eligible: eligibleWithResources(GIT_STATUS) });

    expect(before.names).toEqual(['mcp__git__status']);
    expect(after.names).toEqual(['mcp__git__status', ...MCP_RESOURCE_TOOL_NAMES]);
  });

  it('`disallowed_tools: [read_mcp_resource]` removes that tool alone, and a name the panel does not grant is never added', () => {
    const { manager, setResourceServers } = fakeManager([]);
    setResourceServers([DOCS]);

    const disallowed = buildNestedMcpToolset(piStub, manager, {
      resourceRuleFilter: NO_RESOURCE_RULES, disabledEntries: [],
      eligible: eligibleWithResources(),
      disallowed: new Set(['read_mcp_resource']),
    });
    const panelOff = buildNestedMcpToolset(piStub, manager, { resourceRuleFilter: NO_RESOURCE_RULES, disabledEntries: [], eligible: new Set(['list_mcp_resources']) });

    expect(disallowed.names).toEqual(['list_mcp_resources', 'list_mcp_resource_templates']);
    expect(panelOff.names).toEqual(['list_mcp_resources']);
  });

  it('a read passes the frozen server id, and a server outside the snapshot fails permanently without a request', async () => {
    const { manager, setResourceServers, readResource } = fakeManager([]);
    setResourceServers([DOCS]);
    const toolset = buildNestedMcpToolset(piStub, manager, { resourceRuleFilter: NO_RESOURCE_RULES, disabledEntries: [], eligible: eligibleWithResources() });
    setResourceServers([DOCS, LIVE]);

    await read(toolset, { server: 'docs', uri: 'docs://a' });
    expect(readResource).toHaveBeenCalledWith('docs', 'docs://a', expect.objectContaining({ expectedServerId: 'm1/docs' }));

    await expect(read(toolset, { server: 'live', uri: 'live://x' })).rejects.toThrow(/no longer available to this agent.*permanent/s);
    expect(readResource).toHaveBeenCalledTimes(1);
  });

  it("turns off, for the agent's whole life, what the panel's tools.disabled and its own disallowed_tools name by URI", async () => {
    const { manager, setResourceServers, readResource } = fakeManager([]);
    setResourceServers([DOCS]);
    const panelEntries = ['mcp__docs__read_mcp_resource(docs://panel/*)'];
    const toolset = buildNestedMcpToolset(piStub, manager, {
      resourceRuleFilter: NO_RESOURCE_RULES,
      disabledEntries: panelEntries,
      eligible: eligibleWithResources(),
      disallowed: new Set(['mcp__docs__read_mcp_resource(docs://agent)']),
    });
    panelEntries.length = 0;

    await expect(read(toolset, { server: 'docs', uri: 'docs://panel/a' })).rejects.toThrow(/turned off for this agent/);
    await expect(read(toolset, { server: 'docs', uri: 'docs://agent' })).rejects.toThrow(/turned off for this agent/);
    expect(readResource).not.toHaveBeenCalled();
    await read(toolset, { server: 'docs', uri: 'docs://open' });
    expect(readResource).toHaveBeenCalledTimes(1);
    expect(toolset.names).toEqual([...MCP_RESOURCE_TOOL_NAMES]);
  });

  it("names read_mcp_resource in an MCP tool's resource link only where the agent can read it", async () => {
    const SEARCH = descriptor({ piName: 'mcp__docs__search', serverName: 'docs', rawToolName: 'search' });
    const { manager, setResourceServers, callTool } = fakeManager([SEARCH]);
    setResourceServers([DOCS]);
    callTool.mockResolvedValue({
      content: [{ type: 'resource_link', uri: 'docs://a', name: 'a' }, { type: 'resource_link', uri: 'docs://off', name: 'off' }, { type: 'resource_link', uri: 'docs://denied', name: 'denied' }],
      isError: false,
    } as never);
    // pi's `ctx.tools`: the tools the calling session can call, its active ones.
    const linksOf = async (toolset: { tools: readonly { name: string; execute: unknown }[] }, active: string[]) =>
      ((await (toolset.tools.find((t) => t.name === 'mcp__docs__search')!.execute as unknown as Execute)('tc', {}, undefined, undefined, { tools: active.map((name) => ({ name })) })).content).map((block) => block.text);
    const resourceRuleFilter = vi.fn(async (): Promise<McpResourceRuleFilter> => ({
      ...(await NO_RESOURCE_RULES()),
      resourceDenied: (_server, uri) => uri === 'docs://denied',
    }));

    const granted = buildNestedMcpToolset(piStub, manager, {
      resourceRuleFilter,
      disabledEntries: ['mcp__docs__read_mcp_resource(docs://off)'],
      eligible: eligibleWithResources(SEARCH),
    });
    const withoutRead = buildNestedMcpToolset(piStub, manager, {
      resourceRuleFilter,
      disabledEntries: [],
      eligible: eligibleWithResources(SEARCH),
      disallowed: new Set(['read_mcp_resource']),
    });

    const unlinked = ['[Resource docs://off "off"]', '[Resource docs://denied "denied"]'];
    expect(await linksOf(granted, ['ToolSearch', 'mcp__docs__search'])).toEqual([
      '[Resource docs://a "a". Read it with read_mcp_resource (server "docs"), after loading it with ToolSearch({tools:["mcp_resources"]})]',
      ...unlinked,
    ]);
    expect(resourceRuleFilter).toHaveBeenCalledWith('read_mcp_resource');
    // Loaded through ToolSearch, or active from the start for an agent without ToolSearch.
    expect(await linksOf(granted, ['ToolSearch', 'mcp__docs__search', 'read_mcp_resource'])).toEqual(['[Resource docs://a "a". Read it with read_mcp_resource (server "docs")]', ...unlinked]);
    expect(await linksOf(granted, ['mcp__docs__search', 'list_mcp_resources', 'read_mcp_resource'])).toEqual(['[Resource docs://a "a". Read it with read_mcp_resource (server "docs")]', ...unlinked]);
    // Neither active nor loadable: no hint names a tool the agent lacks.
    expect(await linksOf(granted, ['mcp__docs__search'])).toEqual(['[Resource docs://a "a"]', ...unlinked]);
    expect(await linksOf(withoutRead, ['ToolSearch', 'mcp__docs__search'])).toEqual(['[Resource docs://a "a"]', ...unlinked]);
  });

  it('reads the permission rules only for a result holding a resource link', async () => {
    const SEARCH = descriptor({ piName: 'mcp__docs__search', serverName: 'docs', rawToolName: 'search' });
    const { manager, setResourceServers, callTool } = fakeManager([SEARCH]);
    setResourceServers([DOCS]);
    callTool.mockResolvedValue({ content: [{ type: 'text', text: 'ran' }], isError: false } as never);
    const resourceRuleFilter = vi.fn(NO_RESOURCE_RULES);
    const toolset = buildNestedMcpToolset(piStub, manager, { resourceRuleFilter, disabledEntries: [], eligible: eligibleWithResources(SEARCH) });

    const result = await (toolset.tools.find((t) => t.name === 'mcp__docs__search')!.execute as unknown as Execute)('tc', {}, undefined, undefined, { tools: [{ name: 'read_mcp_resource' }] });
    expect(result.content).toEqual([{ type: 'text', text: 'ran' }]);
    expect(resourceRuleFilter).not.toHaveBeenCalled();
  });
});

describe('buildNestedMcpToolset — the definitions are the REAL callable tools', () => {
  it('executing a built definition reaches the MCP source `callTool` with that piName', async () => {
    // The point of the snapshot is a CALLABLE tool, not a name list. Driving the definition proves the
    // descriptor was closed over correctly — a builder that mixed up indices between `names` and
    // `tools` would still satisfy set-equality but call the wrong server tool here.
    const { manager, callTool } = fakeManager([GIT_STATUS, GIT_COMMIT]);
    const toolset = buildNestedMcpToolset(piStub, manager, { resourceRuleFilter: NO_RESOURCE_RULES, disabledEntries: [], eligible: eligibleOf(GIT_STATUS, GIT_COMMIT) });

    const commit = toolset.tools.find((t) => t.name === 'mcp__git__commit')!;
    const result = await (commit.execute as unknown as (
      id: string, params: unknown, signal: AbortSignal | undefined, onUpdate: undefined, ctx: unknown,
    ) => Promise<{ content: Array<{ type: string; text?: string }> }>)('tc-1', { message: 'x' }, undefined, undefined, {});

    expect(callTool).toHaveBeenCalledTimes(1);
    expect(callTool.mock.calls[0]![0]).toBe('mcp__git__commit');
    expect(callTool.mock.calls[0]![1]).toEqual({ message: 'x' });
    expect(result.content).toEqual([{ type: 'text', text: 'ok' }]);
  });

  it('cuts a long result in the middle and points to the full text, which Read can open', async () => {
    const { manager, callTool } = fakeManager([GIT_STATUS]);
    const full = `FIRST LINE\n${'log line\n'.repeat(5000)}LAST LINE`;
    callTool.mockResolvedValueOnce({ content: [{ type: 'text' as const, text: full }], isError: false });
    const toolset = buildNestedMcpToolset(piStub, manager, { resourceRuleFilter: NO_RESOURCE_RULES, disabledEntries: [], eligible: eligibleOf(GIT_STATUS) });

    const result = await (toolset.tools[0]!.execute as unknown as (
      id: string, params: unknown, signal: undefined, onUpdate: undefined, ctx: unknown,
    ) => Promise<{ content: Array<{ type: string; text?: string }>; details?: { isError: boolean; fullOutputPath?: string } }>)('tc-1', {}, undefined, undefined, {});

    const path = result.details?.fullOutputPath;
    expect(path).toBeDefined();
    try {
      const text = result.content[0]!.text!;
      expect(Buffer.byteLength(text)).toBeLessThan(21 * 1024);
      expect(text).toContain('FIRST LINE');
      expect(text).toContain('LAST LINE');
      expect(text).toContain(`[Full output: ${path} (read it with offset/limit)]`);
      expect(readFileSync(path!, 'utf-8')).toBe(full);
      expect(result.details?.isError).toBe(false);
    } finally {
      rmSync(path!, { force: true });
    }
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
      resourceRuleFilter: NO_RESOURCE_RULES, disabledEntries: [], eligible: eligibleOf(GIT_STATUS, GIT_COMMIT),
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
    const toolset = buildNestedMcpToolset(piStub, manager, { resourceRuleFilter: NO_RESOURCE_RULES, disabledEntries: [], eligible: eligibleOf(GIT_STATUS) });
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
    const toolset = buildNestedMcpToolset(piStub, manager, { resourceRuleFilter: NO_RESOURCE_RULES, disabledEntries: [], eligible: eligibleOf(GIT_STATUS), elicitationUi: uiStub });
    const panelUi = { select: async () => undefined, input: async () => undefined, notify: () => {} };

    await run(toolset.tools[0]!, { ui: panelUi, hasUI: true });

    expect((callTool.mock.calls[0]![2] as { elicitationUi?: unknown }).elicitationUi).toBe(uiStub);
  });
});

describe('buildNestedMcpToolset — a nested agent sees only its own folder', () => {
  it("an agent spawned in folder B gets B's tools and the shared user tools, never A's", async () => {
    const tools = { alpha: [{ name: 'a_run' }], beta: [{ name: 'b_run' }], shared: [{ name: 'ping' }] };
    const user = managerWithFake(tools);
    const folderA = managerWithFake(tools);
    const folderB = managerWithFake(tools);
    const viewA = new FolderMcpView(user.manager, folderA.manager);
    const viewB = new FolderMcpView(user.manager, folderB.manager);
    try {
      await user.manager.reconcile({ shared: specOf({ command: 'shared' }) });
      viewA.setUserVisible(['shared']);
      viewB.setUserVisible(['shared']);
      await folderA.manager.reconcile({ alpha: specOf({ command: 'alpha' }) });
      await folderB.manager.reconcile({ beta: specOf({ command: 'beta' }) });
      const everything = new Set([...viewA.allToolNames(), ...viewB.allToolNames()]);

      const toolset = buildNestedMcpToolset(piStub, viewB, { resourceRuleFilter: NO_RESOURCE_RULES, disabledEntries: [], eligible: everything });

      expect([...toolset.names].sort()).toEqual(['mcp__beta__b_run', 'mcp__shared__ping']);
      expect(toolset.tools.map((t) => t.name).sort()).toEqual(['mcp__beta__b_run', 'mcp__shared__ping']);
    } finally {
      viewA.dispose();
      viewB.dispose();
      await Promise.all([user.manager.dispose(), folderA.manager.dispose(), folderB.manager.dispose()]);
    }
  });

  it('a frozen tool whose name passed to a user server fails as gone instead of calling that server', async () => {
    // The user server takes its tool name back from the folder one, so the live `mcp__my_server__t` is the
    // user server's tool while the snapshot still classifies the name read-only for the folder server.
    const user = managerWithFake({ 'my-server': [{ name: 't' }] });
    const holder: { view?: FolderMcpView } = {};
    const folder = managerWithFake(
      { 'my.server': [{ name: 't', annotations: { readOnlyHint: true } }] },
      () => holder.view!.reservedToolNames(),
    );
    const view = new FolderMcpView(user.manager, folder.manager);
    holder.view = view;
    try {
      await user.manager.reconcile({});
      await folder.manager.reconcile({ 'my.server': specOf({ command: 'folder' }) });
      const toolset = buildNestedMcpToolset(piStub, view, { resourceRuleFilter: NO_RESOURCE_RULES, disabledEntries: [], eligible: new Set(view.allToolNames()) });
      expect(toolset.names).toEqual(['mcp__my_server__t']);
      expect(toolset.isReadOnly('mcp__my_server__t')).toBe(true);

      view.setUserVisible(['my-server']);
      await user.manager.reconcile({ 'my-server': specOf({ command: 'user' }) });
      expect(view.getToolDescriptor('mcp__my_server__t')?.serverName).toBe('my-server');

      const result = await (toolset.tools[0]!.execute as unknown as (
        id: string, params: unknown, signal: undefined, onUpdate: undefined, ctx: unknown,
      ) => Promise<{ content: Array<{ type: string; text?: string }>; details?: { isError: boolean } }>)('tc-1', {}, undefined, undefined, {});

      expect(user.fake.callTool).not.toHaveBeenCalled();
      expect(folder.fake.callTool).not.toHaveBeenCalled();
      expect(result.details).toEqual({ isError: true });
      expect(result.content[0]?.text).toContain('is no longer available');
      expect(result.content[0]?.text).toContain('permanent');
    } finally {
      view.dispose();
      await Promise.all([user.manager.dispose(), folder.manager.dispose()]);
    }
  });
});
