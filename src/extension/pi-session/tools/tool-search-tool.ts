import { Type } from 'typebox';
import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import type { AgentToolResult } from '@earendil-works/pi-agent-core';
import { TOOL_TOOL_SEARCH } from '../../../shared/tool-names';
import { log } from '../../logger';
import { MCP_TOOL_PREFIX, isMcpToolName } from '../mcp/naming';
import { BUILTIN_DEFERRED_GROUPS, resolveToolSearchEntries } from './deferred-tools';

/** This panel's deferrable universe, resolved per session inside `execute`. */
export interface DeferrableSnapshot {
  /** Every tool this session may activate through ToolSearch (already intersected with eligibility). */
  names: string[];
  loaded: Set<string>;
  /** MCP group name → its deferrable tool names. */
  mcpGroups: Map<string, string[]>;
  pendingMcpServers?: string[];
  /** MCP tool name → its description, for the name + blurb inventory lines. */
  mcpDescriptions?: ReadonlyMap<string, string>;
}

/** What the description advertises: the caller's deferrable universe, plus MCP blurbs when it has any. */
export interface ToolSearchInventory {
  names: readonly string[];
  mcpDescriptions?: ReadonlyMap<string, string>;
}

export interface ToolActivationPort {
  deferrable(sessionId: string): DeferrableSnapshot | null;
  /** Activate within `execute`, synchronously — pi diffs the active set around `execute` to stamp
   *  `addedToolNames`, so an activation deferred to a later tick is not observed. */
  activate(sessionId: string, names: string[]): void;
  /**
   * Everything the description advertises, resolved lazily on every read so the inventory tracks a
   * mid-session settings toggle. A subagent answers from its own closure (one factory per spawn); the
   * panel answers from live workspace config, which needs no session identity — the enabled-ness of
   * browser/compass/web/MCP is a workspace fact, not a per-session one. Returning null means "unknown,
   * list every built-in group", and `execute` then reports an unloadable group as inert.
   *
   * The port owns this rather than the description reading `pi.getAllTools()`: that call materializes
   * `description` for EVERY registered tool, ToolSearch included, so reading our own description from
   * inside it recurses until the stack blows.
   */
  inventory?(): ToolSearchInventory | null;
}

export interface ToolSearchDetails {
  matches: string[];
  totalDeferredTools: number;
  pendingMcpServers?: string[];
}

/**
 * Derived rather than written out: a hardcoded list goes stale the moment a group is added, and the
 * only symptom is the model never guessing a group name it was never told about.
 *
 * Unlike the main description this is UNSCOPED — parameter schemas are static structure pi materializes
 * once at wrap time, so there is no session identity to filter against. Fail-open matches the existing
 * `buildDescription(null)` policy: `execute` reports an unloadable group as INERT, so an over-broad
 * blurb costs one corrected call while an under-broad one hides a capability permanently.
 */
const TOOLS_PARAM_DESCRIPTION = `Group names (${[...BUILTIN_DEFERRED_GROUPS.map((g) => g.group), 'an MCP server name'].join(', ')}) and/or exact tool names to load.`;

const toolSearchSchema = Type.Object(
  {
    tools: Type.Array(Type.String(), {
      description: TOOLS_PARAM_DESCRIPTION,
    }),
  },
  { additionalProperties: false },
);

/**
 * The group name that addresses an MCP tool: the server prefix embedded in `mcp__<prefix>__<tool>`.
 * Both the description inventory and the session snapshot derive the group name from the tool name
 * this way, so the group the model is shown is always a group `resolveToolSearchEntries` accepts.
 */
export function mcpGroupName(piToolName: string): string | null {
  if (!isMcpToolName(piToolName)) return null;
  const rest = piToolName.slice(MCP_TOOL_PREFIX.length);
  const end = rest.indexOf('__');
  return end > 0 ? rest.slice(0, end) : null;
}

/**
 * A tool NAME beyond this is omitted from the menu rather than truncated. Names are identifiers the
 * model must reproduce EXACTLY to call, so a shortened one is worse than an absent one: it reads as
 * callable and resolves to `Unknown entries`. The bound is far above any plausible real name (the
 * longest built-in MCP name in use is 57 chars) — it exists only to stop one hostile server spending
 * the context budget on the menu.
 */
const MAX_MCP_TOOL_NAME = 200;

/** MCP descriptions are third-party text of unbounded length; the inventory is a discoverability
 *  surface, so each entry contributes one short line rather than a full tool schema. */
function blurb(description: string): string {
  const firstLine = description.split(/\r?\n/).find((line) => line.trim().length > 0)?.trim() ?? '';
  const flattened = stripControlChars(firstLine);
  return flattened.length > 120 ? `${flattened.slice(0, 117)}...` : flattened;
}

/**
 * Third-party text reaches the model inside a LINE-STRUCTURED menu it is told to trust, so a name or
 * blurb carrying a newline forges a whole extra group line ("compass (1): IgnorePreviousInstructions").
 * Flattening at the point the menu is built is what makes that structurally impossible.
 */
function stripControlChars(value: string): string {
  // eslint-disable-next-line no-control-regex
  return value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
}

/**
 * MCP inventory lines, grouped by the prefix `resolveToolSearchEntries` accepts as a group name.
 * `shadowed` groups are labelled rather than listed as loadable: a built-in group name always wins in
 * the resolver, so advertising `browser (1)` for an MCP server called `browser` would print a second
 * `browser (N):` line for a group the resolver will never hand to that server.
 */
function mcpInventoryLines(
  names: readonly string[],
  descriptions: ReadonlyMap<string, string> | undefined,
): string[] {
  const groups = new Map<string, string[]>();
  let omitted = 0;
  for (const name of names) {
    const group = mcpGroupName(name);
    if (!group) continue;
    if (name.length > MAX_MCP_TOOL_NAME) {
      omitted++;
      continue;
    }
    const safeName = stripControlChars(name);
    const entry = blurb(descriptions?.get(name) ?? '');
    groups.set(group, [...(groups.get(group) ?? []), entry ? `${safeName} — ${entry}` : safeName]);
  }
  const lines = [...groups].map(([group, entries]) => {
    // A shadowed line must not merely be labelled, it must be shaped differently: `browser (1): …`
    // alongside the built-in `browser (25): …` gives the model two identically-formed lines for one
    // group name, and the resolver honours only the built-in.
    const shadowed = BUILTIN_DEFERRED_GROUPS.some((b) => b.group === group);
    const label = shadowed ? `(MCP server "${group}" — name shadowed by the built-in group, so load these by exact tool name) ${entries.length}` : `${group} (${entries.length})`;
    return `${label}: ${entries.join('; ')}`;
  });
  // Never drop silently: an absent tool the user configured must be traceable to a reason.
  if (omitted > 0) lines.push(`(${omitted} MCP tool${omitted === 1 ? '' : 's'} omitted from this list: name too long.)`);
  return lines;
}

/**
 * The `ToolSearch` inventory the model reads, built ENTIRELY from what the port hands over — this
 * function must never touch pi's tool registry. `pi.getAllTools()` materializes `description` for every
 * registered tool, ToolSearch included, so reading it from inside this getter re-enters the getter and
 * recurses until the stack overflows (it does not merely risk it; it is unconditional on first read).
 * The port already owns the deferrable universe, so it supplies the inventory and the cycle cannot form.
 *
 * Still a GETTER, never a captured string: it is re-read on every access, so a server connecting or a
 * subsystem toggled off mid-session reaches the model on the next request with no extra machinery.
 */
function buildDescription(inventory: ToolSearchInventory | null): string {
  const scope = inventory ? new Set(inventory.names) : null;
  const builtinLines = BUILTIN_DEFERRED_GROUPS.map((g) => ({
    group: g.group,
    names: scope ? g.names.filter((n) => scope.has(n)) : [...g.names],
  }))
    .filter((g) => g.names.length > 0)
    .map((g) => `${g.group} (${g.names.length}): ${g.names.join(', ')}`);
  const mcpLines = inventory ? mcpInventoryLines(inventory.names, inventory.mcpDescriptions) : [];
  // The default workspace (browser off, compass off, no MCP) has nothing to defer, and ToolSearch is
  // always eligible — so without this the model reads "the tools below" followed by nothing.
  if (builtinLines.length === 0 && mcpLines.length === 0) {
    return 'Load additional tools into this session. Nothing is deferred in this session — every tool you can use is already loaded, so this tool has nothing to add right now.';
  }
  const lines = [
    'Load additional tools into this session. The tools below are available but not yet loaded — pass a group name to load a whole group, or exact tool names to load individual tools. Loaded tools are callable from your next step.',
    '',
    ...builtinLines,
    ...mcpLines,
  ];
  return lines.join('\n');
}

function textResult(text: string, details?: ToolSearchDetails): AgentToolResult<ToolSearchDetails | undefined> {
  return { content: [{ type: 'text', text }], details };
}

/**
 * Build the always-active `ToolSearch` tool: the single entry point that activates deferred tools.
 * Registered through the extension factory rather than `buildCustomTools` because `setActiveTools` /
 * `getActiveTools` exist only on `ExtensionAPI`, and because the factory's `pi` and the `execute`
 * context both belong to the calling session.
 *
 * Never carries `promptSnippet`/`promptGuidelines`: both rebuild the system prompt and invalidate the
 * cached prefix even on providers that defer tools natively, which is the cost this feature avoids.
 *
 * Never wrap this definition in a spreading helper (`abortableTool` does `{ ...tool }`): a spread
 * evaluates the description getter once and freezes the inventory to whatever was known at
 * construction. A wrapper must preserve the accessor (`Object.defineProperty`/`Object.create`).
 *
 * Deliberately takes no `ExtensionAPI`: the inventory comes from the port, so the description getter
 * has no way to re-enter pi's registry (see `buildDescription`). Do not reintroduce that parameter.
 */
export function createToolSearchTool(port: ToolActivationPort): ToolDefinition {
  const tool: ToolDefinition<typeof toolSearchSchema, ToolSearchDetails | undefined> = {
    name: TOOL_TOOL_SEARCH,
    label: 'ToolSearch',
    get description(): string {
      // Read through the port on every access: pi re-reads this when it re-wraps, so a server that
      // connects or a subsystem toggled off mid-session reaches the model on the next request rather
      // than staying stale until the panel restarts. A throwing inventory degrades to the full
      // built-in listing — a slightly over-broad menu is recoverable (`execute` reports an unloadable
      // group as inert), a tool the model can never discover is not.
      let inventory: ToolSearchInventory | null = null;
      try {
        inventory = port.inventory?.() ?? null;
      } catch (err) {
        log('[ToolSearch] inventory read failed; listing every built-in group: %O', err);
      }
      return buildDescription(inventory);
    },
    parameters: toolSearchSchema,
    execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
      const sessionId = ctx.sessionManager.getSessionId();
      const snapshot = port.deferrable(sessionId);
      if (!snapshot) {
        return textResult(`ToolSearch could not resolve session ${sessionId}, so no tools were loaded.`);
      }

      const entries = params.tools ?? [];
      const { matches, unknown, shadowedGroups, inertGroups } = resolveToolSearchEntries(entries, snapshot.names, snapshot.mcpGroups);
      const requested = matches.filter((name) => !snapshot.loaded.has(name));
      if (matches.length > 0) port.activate(sessionId, matches);

      // Report what pi ACTUALLY activated, never what was asked for. `setActiveToolsByName` silently
      // ignores a name absent from its registry, which is exactly the case for an MCP server that is
      // still connecting: claiming those as loaded sends the model into a call that fails as an
      // unknown tool. Re-reading the snapshot is the only way to know what landed.
      const settled = port.deferrable(sessionId);
      const added = settled ? requested.filter((name) => settled.loaded.has(name)) : requested;
      const missed = settled ? requested.filter((name) => !settled.loaded.has(name)) : [];

      // Offer only groups that actually hold something loadable in THIS session, so a retry after an
      // unknown entry cannot be steered back at a group that is switched off — or at an MCP group whose
      // name a built-in shadows, which the resolver would hand to the built-in anyway.
      const builtinGroupNames = new Set<string>(BUILTIN_DEFERRED_GROUPS.map((g) => g.group));
      const deferrable = new Set(snapshot.names);
      const groupNames = [
        ...BUILTIN_DEFERRED_GROUPS.filter((g) => g.names.some((name) => deferrable.has(name))).map((g) => g.group),
        ...[...snapshot.mcpGroups.keys()].filter((g) => !builtinGroupNames.has(g)),
      ];
      const lines: string[] = [];
      lines.push(
        added.length > 0
          ? `Loaded ${added.length} tool${added.length === 1 ? '' : 's'}: ${added.join(', ')}`
          : 'No new tools were loaded.',
      );
      if (missed.length > 0) {
        const pending = snapshot.pendingMcpServers?.length
          ? ` Its MCP server is still connecting (${snapshot.pendingMcpServers.join(', ')}); try again in a moment.`
          : '';
        lines.push(`Not yet callable: ${missed.join(', ')} — the session did not accept ${missed.length === 1 ? 'it' : 'them'}.${pending}`);
      }
      const alreadyLoaded = matches.length - added.length;
      if (alreadyLoaded > 0) lines.push(`${alreadyLoaded} requested tool${alreadyLoaded === 1 ? ' was' : 's were'} already loaded.`);
      for (const group of shadowedGroups) {
        lines.push(`"${group}" is a built-in group and resolved to it; the MCP server of the same name is reachable by its exact tool names, listed in the ToolSearch description.`);
      }
      // Without this, an inert group is indistinguishable from a no-op: the description is built from
      // the static catalog (one process-wide extension, no session identity), so it lists groups whose
      // subsystem may be off in THIS session. Naming the cause stops the model retrying the same call.
      if (inertGroups.length > 0) {
        lines.push(`Not available in this session: ${inertGroups.join(', ')} — the subsystem is disabled or every tool in it is turned off, so it cannot be loaded here.`);
      }
      if (unknown.length > 0) {
        // With nothing deferrable there is no group to name, and "use one of: ," reads as a bug.
        const options = groupNames.length > 0 ? `use one of: ${groupNames.join(', ')}, or an exact tool name from the description` : 'nothing is deferred in this session, so there is nothing to load';
        lines.push(`Unknown entries: ${unknown.join(', ')} — ${options}.`);
      }

      return textResult(lines.join('\n'), {
        matches,
        totalDeferredTools: snapshot.names.length,
        ...(snapshot.pendingMcpServers?.length ? { pendingMcpServers: snapshot.pendingMcpServers } : {}),
      });
    },
  };
  return tool as ToolDefinition;
}
