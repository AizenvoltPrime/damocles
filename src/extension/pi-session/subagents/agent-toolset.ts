/**
 * agent-toolset.ts — Map an agent definition's `tools:` to the Damocles active-set tool names.
 *
 * New for the Damocles port (no upstream equivalent). Frontmatter `tools:` uses pi-native lowercase
 * names (read/bash/edit/write/grep/find/ls). Damocles' active set is mixed-case and excludes pi's
 * native `edit` (replaced by the custom `Edit`; see PI_EXCLUDED_TOOLS). This maps frontmatter names →
 * Damocles names so a subagent gets the right tools:
 *  - read/bash/write/grep/find/ls → kept pi-native (those ARE the Damocles active-set names)
 *  - edit → Edit (custom)
 *  - `*` / `all` / omitted (builtinToolNames === undefined) → mirror the parent's full active set
 *  - an explicit list is intersected with the parent's available set: EVERY named tool only resolves
 *    when it is actually active in the panel. This matters most for opt-in tools (web search/fetch,
 *    memory/compass/browser), but applies to all — a tool the panel has disabled (e.g. `write`) is
 *    dropped even if the agent names it, matching the `*`-inherit case and the panel's own gating
 *  - ToolSearch is always added when the parent has it — it is a capability of the harness, not a tool
 *    an agent opts into, the exact converse of the strip-rules below. Added after the explicit-list
 *    intersection so an agent need not name it (Explore/Plan's EXPLORE_TOOL_NAMES spells out the 25
 *    browser names but not ToolSearch), and before the disallowed_tools subtraction so an agent can
 *    still opt out — one rule here covers every user agent with an explicit `tools:` list too
 *  - MCP (`mcp__*`) mirrors ToolSearch exactly: also a uniformly-granted harness capability, opt-out
 *    only. It is NOT resolved through `names` at all — the panel's full eligible MCP set is granted to
 *    every agent type and mode from the per-spawn `NestedMcpToolset` snapshot (tools/mcp-tools.ts), so
 *    `names` keeps stripping `mcp__*` (see the filter below) and this function's only MCP output is
 *    `mcpDisallowed`. Uniform because MCP names are deployment-specific: `mcp__git__status` exists only
 *    where that server is configured, so no agent author can name it in frontmatter without hardcoding
 *    a name that breaks when the config changes — an explicit-list agent (Explore/Plan) would otherwise
 *    get none
 *  - disallowed_tools subtracts (mapped) from the resolved set
 *  - the three subagent tools are always removed (no recursion — FR-11)
 *  - the plan-mode tools (EnterPlanMode/ExitPlanMode) are always removed — plan mode is a top-level
 *    panel concern; a subagent must never enter or exit it
 *
 * `excludeTools: ['edit']` is applied separately at session creation (PI_EXCLUDED_TOOLS); the customTools
 * (Edit, PowerShell, Task tools, memory/compass/browser) are built and passed separately by the caller.
 */

import { TOOL_EDIT, TOOL_TOOL_SEARCH, SUBAGENT_TOOLS, PLAN_MODE_TOOLS } from '../../../shared/tool-names';
import { mapPiToolName, toolCategory } from '../tool-normalization';
import type { AgentConfig } from './types';

/** pi-native frontmatter tool name → Damocles active-set name. */
const FRONTMATTER_TO_ACTIVE: Readonly<Record<string, string>> = {
  read: 'read',
  bash: 'bash',
  write: 'write',
  grep: 'grep',
  find: 'find',
  ls: 'ls',
  edit: TOOL_EDIT,
};

/**
 * Map a single frontmatter tool name to its Damocles active-set name (unknown names pass through).
 *
 * The lowercasing applies ONLY to the lookup key, so anything outside FRONTMATTER_TO_ACTIVE — every
 * mixed-case Damocles name and every `mcp__*` name — passes through byte-for-byte. That makes MCP
 * opt-out via `disallowed_tools` **case-sensitive and exact**: `mcp__git__status` denies that tool,
 * `MCP__Git__Status` denies nothing, and there is no prefix/wildcard form. Deliberate — a pi tool name
 * is an identifier the server's prefix map produced, and case-folding it here would silently break
 * every MCP denial the moment someone "helpfully" lowercases this function.
 */
function mapName(name: string): string {
  return FRONTMATTER_TO_ACTIVE[name.toLowerCase()] ?? name;
}

export interface ResolvedToolset {
  /** The active-set tool names the subagent may use (subagent tools removed; deduped). */
  names: string[];
  /**
   * True when the resolved set contains no write-category tool — i.e. the agent is declared read-only
   * (Explore/Plan, or any user agent with a read-only `tools:` list). The permission gate then holds its
   * shell to the same fail-closed read-only classifier plan mode uses, so a denied `Edit`/`Write` cannot
   * be worked around with `echo > file`, a heredoc, `tee`, or `cp`.
   *
   * Unaffected by MCP: `toolCategory` classifies every `mcp__*` name as `'other'`, never `'write'`, so
   * granting MCP cannot flip an agent out of read-only.
   */
  readOnly: boolean;
  /**
   * The agent's `disallowed_tools` after `mapName`, passed through verbatim as the MCP opt-out set —
   * the ONE way an agent declines part of the uniformly-granted MCP set. Not pre-filtered to `mcp__*`:
   * the snapshot builder only ever tests it against MCP names, and pre-filtering here would just be a
   * second place to keep the prefix in sync. Exact-case, exact-name (see `mapName`).
   */
  mcpDisallowed: Set<string>;
}

/**
 * Resolve an agent's active tool-name allowlist.
 *
 * @param config             The agent definition.
 * @param parentFullToolNames The parent panel's `fullActiveToolNames()` — used for the "all" case.
 */
export function resolveAgentToolset(config: AgentConfig, parentFullToolNames: readonly string[]): ResolvedToolset {
  // `undefined` builtinToolNames means "all available tools" (omitted `tools:` or `tools: *`).
  // An explicit list is intersected with what the panel actually has active, so an opt-in tool it
  // names (e.g. WebSearch) only resolves when that capability is enabled — always-on native/custom
  // tools pass through unchanged since they are always in the parent set.
  const available = new Set(parentFullToolNames);
  let names: string[] =
    config.builtinToolNames === undefined
      ? [...parentFullToolNames]
      : config.builtinToolNames.map(mapName).filter((n) => available.has(n));

  if (available.has(TOOL_TOOL_SEARCH)) names = [...names, TOOL_TOOL_SEARCH];

  const denied = new Set((config.disallowedTools ?? []).map(mapName));
  if (denied.size) names = names.filter((n) => !denied.has(n));

  // No recursion: a subagent can never spawn subagents.
  names = names.filter((n) => !SUBAGENT_TOOLS.has(n));

  // Plan mode is a top-level panel concern owned by the primary session; a subagent must never enter
  // or exit plan mode, so strip these even when the parent inherits them (e.g. while the panel is in
  // plan mode) or an agent names them explicitly.
  names = names.filter((n) => !PLAN_MODE_TOOLS.has(n));

  // MCP names never travel through `names`. A nested session gets its MCP tools from the per-spawn
  // `NestedMcpToolset` snapshot (tools/mcp-tools.ts), which is the SINGLE source for the agent's MCP
  // `tools:` entries, its customTool definitions, its deferred baseline, its gate classifier and its
  // ToolSearch blurbs. Letting a `tools: *` agent inherit `mcp__…` here would put a second, unrelated
  // list of MCP names into the same spawn — exactly the divergence that used to make team agents pass
  // names the nested registry had no definitions for, which pi drops silently. The caller concatenates
  // `[...names, ...mcp.names]`; this filter keeps that concatenation the only source.
  names = names.filter((n) => !n.startsWith('mcp__'));

  const unique = [...new Set(names)];
  return {
    names: unique,
    readOnly: !unique.some((n) => toolCategory(mapPiToolName(n)) === 'write'),
    mcpDisallowed: denied,
  };
}
