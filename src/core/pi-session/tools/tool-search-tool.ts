import { Type } from 'typebox';
import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import type { AgentToolResult } from '@earendil-works/pi-agent-core';
import { TOOL_TOOL_SEARCH } from '../../../shared/tool-names';
import { log } from '../../logger';
import { mcpServerNamespaceKey } from '../../../shared/types/mcp';
import { stripControlChars } from '../untrusted-text';
import { BUILTIN_DEFERRED_GROUPS, resolveToolSearchEntries, userScopeToolNames } from './deferred-tools';
import { browserClosedReason, forgeUnreachableReason, relayedMcpUnreachableReason, themeOffReason, themeUnreachableReason, userScopeReach } from '../../user-scope';
import { DESIGN_CHAT_FORGE_REFUSAL, FORGE_PI_TOOL_NAMES } from './forge-tool-specs';
import { DESIGN_CHAT_THEME_REFUSAL, NESTED_THEME_REFUSAL, THEME_PI_TOOL_NAMES } from './theme-tool-specs';
import { relayedServerNames, relayedServerOfTool } from '../mcp/relayed-tool-names';
import { englishText } from '../../../shared/localized-text';
import { TOOLS_DISABLED_SETTING } from '../../../shared/types/tools';
import type { ToolExclusion, ToolGroupInertReason } from './inert-reason';

/** One MCP tool's ToolSearch menu facts, taken from its descriptor. */
export interface McpToolMenuEntry {
  description: string;
  /** The ToolSearch group that loads the tool: its server's group name (`mcpToolSearchGroup`). */
  group: string;
  /** The server's menu line (config `description`, else the first line of its instructions). */
  serverDescription?: string;
}

/** This panel's deferrable universe, resolved per session inside `execute`. */
export interface DeferrableSnapshot {
  /** Every tool this session may activate through ToolSearch (already intersected with eligibility). */
  names: string[];
  /** Every tool active in the session, deferrable or not. */
  loaded: Set<string>;
  /** MCP group name → its deferrable tool names. */
  mcpGroups: Map<string, string[]>;
  /** MCP groups holding an eligible Always-loaded tool. */
  directMcpGroups?: ReadonlySet<string>;
  pendingMcpServers?: string[];
  /** MCP tool name → its menu facts, for the grouped name + blurb inventory lines. */
  mcpDescriptions?: ReadonlyMap<string, McpToolMenuEntry>;
  /** A design chat or an agent it started, which never loads the GitHub and GitLab group or the theme group. */
  design?: boolean;
  /** A subagent or team member, which never loads the theme group. */
  nested?: boolean;
  /** Each built-in group ToolSearch cannot load for a reason of its own, with why (`deferredInertReasons`); a nested agent's is the panel's at spawn. */
  inert: ReadonlyMap<string, ToolGroupInertReason>;
  /** Each built-in deferred tool excluded by name, with why (`deferredToolExclusions`); a nested agent's is the panel's at spawn. */
  excluded?: ReadonlyMap<string, ToolExclusion>;
}

const UNAVAILABLE_TEXT: Readonly<Record<Extract<ToolGroupInertReason, { kind: 'unavailable' }>['reason'], string>> = {
  noModel: 'Image generation has no model; the user picks an OpenRouter image model in Settings.',
  unknownModel: 'The image model chosen in Settings is not one Damocles offers; the user picks another OpenRouter image model.',
  noOpenRouterKey: 'Image generation needs an OpenRouter key, which the user adds in Settings.',
  noResourceServer: 'No enabled MCP server offers resources.',
};

/** The reasons the user can change; a nested agent's toolset is frozen at spawn, so the change never reaches it. */
function userFixable(reason: ToolGroupInertReason): boolean {
  switch (reason.kind) {
    case 'off':
    case 'themeOffOnDevice':
    case 'toolsOff':
      return true;
    case 'design': return reason.disabled.length > 0;
    case 'unavailable': return reason.reason !== 'noResourceServer';
    case 'host':
    case 'notLoaded':
    case 'agent':
      return false;
  }
}

function inertReasonText(reason: ToolGroupInertReason, group: string): string {
  switch (reason.kind) {
    case 'host': return 'This host has no such tools.';
    case 'off': return `The setting ${reason.setting} is off; the user turns it on in Settings.`;
    case 'themeOffOnDevice': return englishText(themeOffReason());
    case 'toolsOff': return `Every ${group} tool is listed in ${TOOLS_DISABLED_SETTING} (${reason.tools.join(', ')}); the user turns them on in the Tools panel.`;
    case 'design': {
      if (reason.disabled.length === 0) return `A design chat's tool rules leave out every ${group} tool.`;
      const one = reason.disabled.length === 1;
      return `A design chat's tool rules leave out the other ${group} tools, and ${reason.disabled.join(', ')} ${one ? 'is' : 'are'} listed in ${TOOLS_DISABLED_SETTING}; the user turns ${one ? 'it' : 'them'} on in the Tools panel.`;
    }
    case 'unavailable': return UNAVAILABLE_TEXT[reason.reason];
    case 'notLoaded': return `The ${group} tools are neither deferred nor active in this session, so ToolSearch has nothing to load.`;
    case 'agent': return "This agent's tool list does not include it.";
  }
}

/** What tells the model that `tools` of a group that loads are out by name; only the user's own list is the user's to change. */
function excludedLine(why: ToolExclusion, tools: readonly string[], group: string, nested: boolean): string {
  const one = tools.length === 1;
  const rest = `The other ${group} tools load as usual.`;
  if (why === 'design') return `A design chat's tool rules leave out ${tools.join(', ')}. ${rest}`;
  const text = `${tools.join(', ')} ${one ? 'is' : 'are'} listed in ${TOOLS_DISABLED_SETTING}; the user turns ${one ? 'it' : 'them'} on in the Tools panel. ${rest}`;
  return nested ? `${text} The change reaches only agents started after it.` : text;
}

/** What a reason tells the model; a nested agent learns that a fix by the user reaches only agents started after it. */
function inertLine(reason: ToolGroupInertReason, group: string, nested: boolean): string {
  const text = inertReasonText(reason, group);
  return nested && userFixable(reason) ? `${text} The change reaches only agents started after it.` : text;
}

/** What the description advertises: the caller's deferrable universe, plus MCP menu facts when it has any. */
export interface ToolSearchInventory {
  names: readonly string[];
  mcpDescriptions?: ReadonlyMap<string, McpToolMenuEntry>;
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
const TOOLS_PARAM_DESCRIPTION = `Group names (${[...BUILTIN_DEFERRED_GROUPS.map((g) => g.group), 'an MCP server name listed in the description'].join(', ')}) and/or exact tool names to load.`;

const toolSearchSchema = Type.Object(
  {
    tools: Type.Array(Type.String(), {
      description: TOOLS_PARAM_DESCRIPTION,
    }),
  },
  { additionalProperties: false },
);

/**
 * The group name that loads every tool of a server: the server's name with characters outside
 * `[A-Za-z0-9_]` replaced, so it prints as itself. Derived from the descriptor's `serverName`, never
 * parsed out of a tool name, and the config fold keeps one server per such key.
 */
export function mcpToolSearchGroup(serverName: string): string {
  return mcpServerNamespaceKey(serverName);
}

/** Tool names per group, from the menu facts, for the names in `names` only. */
export function mcpGroupsOf(
  names: readonly string[],
  entries: ReadonlyMap<string, McpToolMenuEntry> | undefined,
): Map<string, string[]> {
  const groups = new Map<string, string[]>();
  for (const name of names) {
    const entry = entries?.get(name);
    if (!entry) continue;
    const existing = groups.get(entry.group);
    if (existing) existing.push(name);
    else groups.set(entry.group, [name]);
  }
  return groups;
}

/**
 * A tool NAME beyond this is omitted from the menu rather than truncated. Names are identifiers the
 * model must reproduce EXACTLY to call, so a shortened one is worse than an absent one: it reads as
 * callable and resolves to `Unknown entries`. The bound is far above any plausible real name (the
 * longest built-in MCP name in use is 57 chars) — it exists only to stop one hostile server spending
 * the context budget on the menu.
 */
const MAX_MCP_TOOL_NAME = 200;

/**
 * Whether a name can be printed in the menu AS ITSELF. The menu is a list of identifiers, and
 * `resolveToolSearchEntries` matches an exact-name request against the RAW name, so any name the menu
 * would have to alter to print safely must be omitted instead — flattening a control character is a
 * shortening, and the reasoning above applies unchanged: an altered name reads as callable and
 * resolves to `Unknown entries`, costing a turn every time the model believes the menu.
 *
 * Omission is a display decision, never a capability one: the tool stays in `tools:` and stays
 * loadable by its GROUP, so nothing is actually lost — the same graceful degradation the over-long
 * case already had.
 */
function isPrintableToolName(name: string): boolean {
  return name.length <= MAX_MCP_TOOL_NAME && stripControlChars(name) === name;
}

/** MCP descriptions are third-party text of unbounded length; the inventory is a discoverability
 *  surface, so each entry contributes one short line rather than a full tool schema. */
function blurb(description: string): string {
  const firstLine = description.split(/\r?\n/).find((line) => line.trim().length > 0)?.trim() ?? '';
  const flattened = stripControlChars(firstLine);
  return flattened.length > 120 ? `${flattened.slice(0, 117)}...` : flattened;
}

/**
 * MCP inventory lines, grouped by the group name `resolveToolSearchEntries` accepts, each led by the
 * server's description when it has one.
 * `shadowed` groups are labelled rather than listed as loadable: a built-in group name always wins in
 * the resolver, so advertising `browser (1)` for an MCP server called `browser` would print a second
 * `browser (N):` line for a group the resolver will never hand to that server.
 */
function mcpInventoryLines(
  names: readonly string[],
  descriptions: ReadonlyMap<string, McpToolMenuEntry> | undefined,
): string[] {
  const groups = new Map<string, string[]>();
  const serverLines = new Map<string, string>();
  let omitted = 0;
  for (const name of names) {
    const menu = descriptions?.get(name);
    if (!menu) continue;
    const group = menu.group;
    if (!isPrintableToolName(name)) {
      omitted++;
      continue;
    }
    if (menu.serverDescription && !serverLines.has(group)) serverLines.set(group, blurb(menu.serverDescription));
    const entry = blurb(menu.description);
    // Push into the existing array rather than rebuilding it: this runs per description read, on input
    // the module treats as hostile, and copy-on-append is quadratic in tools-per-server.
    const line = entry ? `${name} — ${entry}` : name;
    const existing = groups.get(group);
    if (existing) existing.push(line);
    else groups.set(group, [line]);
  }
  const lines = [...groups].map(([group, entries]) => {
    // A shadowed line must not merely be labelled, it must be shaped differently: `browser (1): …`
    // alongside the built-in `browser (25): …` gives the model two identically-formed lines for one
    // group name, and the resolver honours only the built-in.
    const shadowed = BUILTIN_DEFERRED_GROUPS.some((b) => b.group === group);
    const label = shadowed ? `(MCP server "${group}" — name shadowed by the built-in group, so load these by exact tool name) ${entries.length}` : `${group} (${entries.length})`;
    const server = serverLines.get(group);
    return `${label}${server ? ` — ${server}` : ''}: ${entries.join('; ')}`;
  });
  // Never drop silently: an absent tool the user configured must be traceable to a reason.
  if (omitted > 0) {
    lines.push(
      `(${omitted} MCP tool${omitted === 1 ? '' : 's'} omitted from this list: the name is too long or is not printable as written. ` +
        `${omitted === 1 ? 'It is' : 'They are'} still loadable by server group.)`,
    );
  }
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
    guidance: g.guidance,
    names: scope ? g.names.filter((n) => scope.has(n)) : [...g.names],
  }))
    .filter((g) => g.names.length > 0)
    .map((g) => `${g.group} (${g.names.length})${g.guidance !== undefined ? ` — ${g.guidance}` : ''}: ${g.names.join(', ')}`);
  const mcpLines = inventory ? mcpInventoryLines(inventory.names, inventory.mcpDescriptions) : [];
  // A session with every deferred group off and no MCP has nothing to defer, and ToolSearch is
  // always eligible, so without this the model reads "the tools below" followed by nothing.
  if (builtinLines.length === 0 && mcpLines.length === 0) {
    return 'Load additional tools into this session. Nothing is deferred in this session — every tool you can use is already loaded, so this tool has nothing to add right now.';
  }
  const lines = [
    'Load additional tools into this session. The tools below are available but not yet loaded — pass a group name to load a whole group, or exact tool names to load individual tools. Loaded tools are callable from your next step. A tool not listed here is either already loaded or not available.',
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
      const resolution = resolveToolSearchEntries(
        entries,
        snapshot.names,
        snapshot.mcpGroups,
        snapshot.loaded,
        snapshot.directMcpGroups,
      );
      const { matches, alreadyActive, alreadyActiveGroups, shadowedGroups } = resolution;
      // an entry naming a tool or group whose user-scope service this core cannot reach gets that reason, not "unknown"
      const userScope = userScopeToolNames(userScopeReach());
      // a relayed server's own group, the form a model recalls from an earlier turn, maps to that server
      const relayedGroup = (entry: string): string | undefined => {
        if (BUILTIN_DEFERRED_GROUPS.some((g) => g.group === entry) || (!resolution.unknown.includes(entry) && !resolution.inertGroups.includes(entry))) return undefined;
        return relayedServerNames().find((server) => mcpToolSearchGroup(server) === entry && [...userScope].some((name) => relayedServerOfTool(name) === server));
      };
      const unavailableServer = (entry: string): string | undefined => relayedServerOfTool(entry) ?? relayedGroup(entry);
      const forgeEntry = (entry: string): boolean => entry === 'forge' || FORGE_PI_TOOL_NAMES.includes(entry);
      const themeEntry = (entry: string): boolean => entry === 'theme' || THEME_PI_TOOL_NAMES.includes(entry);
      // the design rule decides there, account or not
      const designForge = snapshot.design === true ? [...new Set(entries.filter(forgeEntry))] : [];
      // a design chat's and a nested agent's own rules decide the theme tools, wherever this core runs
      const blockedTheme = snapshot.design === true || snapshot.nested === true ? [...new Set(entries.filter(themeEntry))] : [];
      const ruled = (entry: string): boolean => designForge.includes(entry) || blockedTheme.includes(entry);
      const deferrable = new Set(snapshot.names);
      // a requested group or tool name that loads nothing, with its built-in group's reason; a nested agent's tool list can
      // leave out a group the panel has
      const inertOf = (entry: string): { group: string; reason: ToolGroupInertReason } | undefined => {
        if (!resolution.unknown.includes(entry) && !resolution.inertGroups.includes(entry)) return undefined;
        const group = BUILTIN_DEFERRED_GROUPS.find((g) => g.group === entry) ?? BUILTIN_DEFERRED_GROUPS.find((g) => g.names.includes(entry));
        if (!group) return undefined;
        const reason = snapshot.inert.get(group.group) ?? (snapshot.nested === true && !group.names.some((name) => deferrable.has(name)) ? { kind: 'agent' as const } : undefined);
        return reason && { group: group.group, reason };
      };
      // a group this session has switched off says so before any reach of its service
      const unavailable = entries.filter((entry) => !ruled(entry) && inertOf(entry) === undefined && (
        userScope.has(entry) || relayedGroup(entry) !== undefined || BUILTIN_DEFERRED_GROUPS.some((g) => g.group === entry && g.names.some((name) => userScope.has(name)))));
      const answered = (entry: string): boolean => unavailable.includes(entry) || ruled(entry);
      const inertEntries = new Map<string, { reason: ToolGroupInertReason; entries: string[] }>();
      for (const entry of new Set(entries)) {
        const inert = answered(entry) ? undefined : inertOf(entry);
        if (!inert) continue;
        const known = inertEntries.get(inert.group);
        if (known) known.entries.push(entry);
        else inertEntries.set(inert.group, { reason: inert.reason, entries: [entry] });
      }
      // an exact name left out of a group that loads, by the user's list or a design chat's rules
      const excludedEntries = new Map<string, { group: string; why: ToolExclusion; entries: string[] }>();
      for (const entry of new Set(resolution.unknown)) {
        const why = answered(entry) || inertOf(entry) !== undefined ? undefined : snapshot.excluded?.get(entry);
        const group = why && BUILTIN_DEFERRED_GROUPS.find((g) => g.names.includes(entry))?.group;
        if (!why || !group) continue;
        const known = excludedEntries.get(`${group}:${why}`);
        if (known) known.entries.push(entry);
        else excludedEntries.set(`${group}:${why}`, { group, why, entries: [entry] });
      }
      const excludedNames = new Set([...excludedEntries.values()].flatMap((found) => found.entries));
      const unknown = resolution.unknown.filter((entry) => !answered(entry) && inertOf(entry) === undefined && !excludedNames.has(entry));
      const inertGroups = resolution.inertGroups.filter((entry) => !answered(entry) && inertOf(entry) === undefined);
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
      const groupNames = [
        ...BUILTIN_DEFERRED_GROUPS.filter((g) => g.names.some((name) => deferrable.has(name))).map((g) => g.group),
        ...[...snapshot.mcpGroups.keys()].filter((g) => !builtinGroupNames.has(g)),
      ];
      // This RESULT is line-structured text that can echo a name the model typed, and the model is not
      // the only author of its context. The menu was hardened against forged lines; its sibling must be
      // too, or the defence is only half-present.
      const names = (list: readonly string[]): string => list.map(stripControlChars).join(', ');
      const lines: string[] = [];
      lines.push(
        added.length > 0
          ? `Loaded ${added.length} tool${added.length === 1 ? '' : 's'}: ${names(added)}`
          : 'No new tools were loaded.',
      );
      if (missed.length > 0) {
        const pending = snapshot.pendingMcpServers?.length
          ? ` Its MCP server is still connecting (${names(snapshot.pendingMcpServers)}); try again in a moment.`
          : '';
        lines.push(`Not yet callable: ${names(missed)} — the session did not accept ${missed.length === 1 ? 'it' : 'them'}.${pending}`);
      }
      const alreadyLoaded = matches.length - requested.length;
      if (alreadyLoaded > 0) lines.push(`${alreadyLoaded} requested tool${alreadyLoaded === 1 ? ' was' : 's were'} already loaded.`);
      if (alreadyActive.length > 0) {
        lines.push(`Already active, no loading needed: ${names(alreadyActive)} — call ${alreadyActive.length === 1 ? 'it' : 'them'} directly.`);
      }
      if (alreadyActiveGroups.length > 0) {
        lines.push(`Always loaded, no loading needed: ${names(alreadyActiveGroups)} — ${alreadyActiveGroups.length === 1 ? 'its' : 'their'} tools are already active; call them directly.`);
      }
      for (const group of shadowedGroups) {
        lines.push(`"${group}" is a built-in group and resolved to it; the MCP server of the same name is reachable by its exact tool names, listed in the ToolSearch description.`);
      }
      // Without this, an inert group is indistinguishable from a no-op: the description is built from
      // the static catalog (one process-wide extension, no session identity), so it lists groups whose
      // subsystem may be off in THIS session. Naming the cause stops the model retrying the same call.
      if (designForge.length > 0) lines.push(`Not available: ${names(designForge)}. ${DESIGN_CHAT_FORGE_REFUSAL}`);
      if (blockedTheme.length > 0) lines.push(`Not available: ${names(blockedTheme)}. ${snapshot.design === true ? DESIGN_CHAT_THEME_REFUSAL : NESTED_THEME_REFUSAL}`);
      const unavailableForge = [...new Set(unavailable)].filter((entry) => unavailableServer(entry) === undefined && forgeEntry(entry));
      const unavailableTheme = [...new Set(unavailable)].filter((entry) => unavailableServer(entry) === undefined && themeEntry(entry));
      const unavailableBrowser = [...new Set(unavailable)].filter((entry) => unavailableServer(entry) === undefined && !forgeEntry(entry) && !themeEntry(entry));
      if (unavailableForge.length > 0) lines.push(`Not available: ${names(unavailableForge)}. ${englishText(forgeUnreachableReason())}`);
      if (unavailableTheme.length > 0) lines.push(`Not available: ${names(unavailableTheme)}. ${englishText(themeUnreachableReason())}`);
      const unavailableMcp = [...new Set(unavailable)].filter((entry) => unavailableServer(entry) !== undefined);
      if (unavailableBrowser.length > 0) lines.push(`Not available: ${names(unavailableBrowser)}. ${englishText(browserClosedReason())}`);
      for (const server of new Set(unavailableMcp.map((entry) => unavailableServer(entry)!))) {
        lines.push(`Not available: ${names(unavailableMcp.filter((entry) => unavailableServer(entry) === server))}. ${englishText(relayedMcpUnreachableReason(stripControlChars(server)))}`);
      }
      for (const [group, { reason, entries: groupEntries }] of inertEntries) {
        lines.push(`Not available in this session: ${names(groupEntries)}. ${inertLine(reason, group, snapshot.nested === true)}`);
      }
      for (const { group, why, entries: tools } of excludedEntries.values()) {
        lines.push(`Not available in this session: ${names(tools)}. ${excludedLine(why, tools.map(stripControlChars), group, snapshot.nested === true)}`);
      }
      // an MCP server group that resolved to nothing this session can load
      if (inertGroups.length > 0) lines.push(`Not available in this session: ${names(inertGroups)}.`);
      if (unknown.length > 0) {
        // With nothing deferrable there is no group to name, and "use one of: ," reads as a bug.
        const options = groupNames.length > 0 ? `use one of: ${groupNames.join(', ')}, or an exact tool name from the description` : 'nothing is deferred in this session, so there is nothing to load';
        // `unknown` echoes the model's own entries back. Flattened for the same reason as the rest: the
        // model is not the only author of its context, so a name it was talked into typing must not be
        // able to forge a line in a result the next turn reads as trusted.
        lines.push(`Unknown entries: ${names(unknown)} — ${options}.`);
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
