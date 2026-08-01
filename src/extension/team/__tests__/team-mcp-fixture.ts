import { buildNestedMcpToolset, type NestedMcpToolset } from '../../pi-session/tools/mcp-tools';
import type { McpClientManager } from '../../pi-session/mcp/mcp-client-manager';
import type { PiCodingAgentModule } from '../../pi-session/pi-loader';

/**
 * The MCP snapshot every team-engine fake hands over, and the reason it must NOT be empty.
 *
 * These fakes used to call `buildNestedMcpToolset(pi, null, …)`, which short-circuits to the shared
 * `EMPTY_NESTED_MCP_TOOLSET` — `{ names: [], tools: [] }`. Reaching production's own value looks
 * faithful, but a DEGENERATE value collapses everything downstream of it: with empty arrays,
 * `tools: [...toolNames, ...mcp.names]` and `tools: toolNames` produce the same array, and
 * `customTools: [...mcp.tools]` and `customTools: []` produce the same list. Every mutation the
 * spawn-site invariant exists to catch was green. It also made the identity assertion
 * `factoryMcpSnapshots[0] === toolsetSnapshots[0]` unfalsifiable, because a module singleton is
 * identical to itself across independent reads — the check could not fail, so it proved nothing.
 *
 * Shared from one module rather than copied into each suite: a fixture whose entire purpose is to stop
 * two call sites drifting should not itself exist in three places.
 */

/** `defineTool` is the only `pi` member `buildNestedMcpToolset` touches; the definitions it makes are real. */
export const teamPiStub = { defineTool: (tool: unknown) => tool } as unknown as PiCodingAgentModule;

/** The names the fixture grants. Spawn sites are asserted against these by value. */
export const TEAM_MCP_NAMES = ['mcp__srv__read', 'mcp__srv__write'];

/** The non-MCP half of a fake agent's toolset, so `tools:` can be asserted as a UNION rather than a set. */
export const TEAM_BASE_TOOL_NAMES = ['read', 'bash'];

/** One read-only descriptor and one not, so the snapshot's `isReadOnly` classifier is observable too. */
const teamMcpManager = {
  getAllToolDescriptors: () => [
    {
      piName: 'mcp__srv__read',
      serverName: 'srv',
      kind: 'tool',
      originalName: 'read',
      description: 'read a thing',
      inputSchema: { type: 'object', properties: {} },
      readOnly: true,
    },
    {
      piName: 'mcp__srv__write',
      serverName: 'srv',
      kind: 'tool',
      originalName: 'write',
      description: 'write a thing',
      inputSchema: { type: 'object', properties: {} },
      readOnly: false,
    },
  ],
} as unknown as McpClientManager;

/**
 * A FRESH snapshot per call, through the real builder — `buildNestedMcpToolset` allocates, which is
 * what lets object identity distinguish "the spawn threaded one snapshot" from "it read twice".
 */
export function teamMcpSnapshot(): NestedMcpToolset {
  return buildNestedMcpToolset(teamPiStub, teamMcpManager, { eligible: new Set(TEAM_MCP_NAMES) });
}

/** What a `TeamEngine.buildAgentToolset` fake returns: the real shape, over a real snapshot. */
export function teamAgentToolset(): { toolNames: string[]; customTools: NestedMcpToolset['tools']; mcp: NestedMcpToolset } {
  const mcp = teamMcpSnapshot();
  return { toolNames: [...TEAM_BASE_TOOL_NAMES], customTools: [...mcp.tools], mcp };
}
