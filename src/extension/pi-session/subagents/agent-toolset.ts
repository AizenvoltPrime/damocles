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

/** Map a single frontmatter tool name to its Damocles active-set name (unknown names pass through). */
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
   */
  readOnly: boolean;
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

  if (config.disallowedTools?.length) {
    const denied = new Set(config.disallowedTools.map(mapName));
    names = names.filter((n) => !denied.has(n));
  }

  // No recursion: a subagent can never spawn subagents.
  names = names.filter((n) => !SUBAGENT_TOOLS.has(n));

  // Plan mode is a top-level panel concern owned by the primary session; a subagent must never enter
  // or exit plan mode, so strip these even when the parent inherits them (e.g. while the panel is in
  // plan mode) or an agent names them explicitly.
  names = names.filter((n) => !PLAN_MODE_TOOLS.has(n));

  // MCP tools live on the main runtime's shared extension; subagent sessions have no MCP registrar,
  // so a `tools: *` agent must not inherit `mcp__…` names (Phase 6 documented boundary, US-014.9).
  names = names.filter((n) => !n.startsWith('mcp__'));

  const unique = [...new Set(names)];
  return { names: unique, readOnly: !unique.some((n) => toolCategory(mapPiToolName(n)) === 'write') };
}
