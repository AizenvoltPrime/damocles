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
 *  - disallowed_tools subtracts (mapped) from the resolved set
 *  - the three subagent tools are always removed (no recursion — FR-11)
 *  - the plan-mode tools (EnterPlanMode/ExitPlanMode) are always removed — plan mode is a top-level
 *    panel concern; a subagent must never enter or exit it
 *
 * `excludeTools: ['edit']` is applied separately at session creation (PI_EXCLUDED_TOOLS); the customTools
 * (Edit, PowerShell, Task tools, memory/compass/browser) are built and passed separately by the caller.
 */

import { TOOL_EDIT, SUBAGENT_TOOLS, PLAN_MODE_TOOLS } from '../../../shared/tool-names';
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

  return { names: [...new Set(names)] };
}
