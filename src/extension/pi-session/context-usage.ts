import type { AgentSession, ResourceLoader, ToolInfo } from '@earendil-works/pi-coding-agent';
import type { ContextUsageData } from '../../shared/types/session';
import { log } from '../logger';
import { piMessageText } from './branch-text';
import { isMcpToolName } from './mcp/naming';
import type { McpClientManager } from './mcp/mcp-client-manager';
import type { AgentRegistry } from './subagents/agent-types';
import { AGENT_SCOPE_BY_SOURCE } from './subagents/types';
import { BUILTIN_DEFERRED_GROUPS } from './tools/deferred-tools';

/**
 * The `/context` usage breakdown for the pi path (US-CMD). Pure computation over the live session plus
 * a snapshot of live state resolved at the single call site (`PiSession.requestContextUsage`). Headline
 * totals come from pi's `getContextUsage()` (fallback: the session stats snapshot); the per-message /
 * per-tool breakdown, the system-prompt section, and the discovered skills/commands/agents/MCP sections
 * are estimated with pi's chars/4 heuristic. All sub-sections degrade independently.
 */
export interface ContextUsageDeps {
  /** The current model's context window (`PiSession.contextWindowForCurrentModel()`). */
  maxTokens: number;
  /** The active panel model value (`PiSession.modelValue`). */
  modelValue: string;
  /** The pi resource loader, or null before the runtime initializes (`PiSession.resourceLoader()`). */
  resourceLoader: ResourceLoader | null;
  /** The live `damocles.mcp.enabled` flag (`PiSession.isMcpEnabled()`). */
  mcpEnabled: boolean;
  /** The process/workspace MCP client, or null (`PiSession.mcpClientManager()`). */
  mcpClientManager: McpClientManager | null;
  /** The shared subagent registry, or null (`PiSession.agentRegistry`). */
  agentRegistry: AgentRegistry | null;
  /** The eligible tool universe for this panel (`PiSession.fullActiveToolNames()`). */
  eligibleToolNames: string[];
}

/** chars/4 token estimate (pi's own heuristic), conservative — used for every estimated section. */
function estimateTextTokens(text: string): number {
  return text ? Math.ceil(text.length / 4) : 0;
}

/**
 * What a tool actually costs in the request: its description plus its serialized parameter schema. The
 * `?? {}` is load-bearing — `JSON.stringify(undefined)` returns `undefined`, not a string.
 */
export function estimateToolTokens(description: string | undefined, parameters: unknown): number {
  return estimateTextTokens(description ?? '') + estimateTextTokens(JSON.stringify(parameters ?? {}));
}

/** Assemble the `ContextUsageData` for `/context`; all sub-sections degrade independently. */
export function buildContextUsage(
  session: AgentSession,
  systemPromptText: string,
  deps: ContextUsageDeps,
): ContextUsageData {
  const maxTokens = deps.maxTokens;
  const usage = safeContextUsage(session);
  const stats = session.getSessionStats?.();
  const occupied =
    usage?.tokens ??
    (stats ? stats.tokens.input + stats.tokens.cacheRead + stats.tokens.cacheWrite : 0);
  const totalTokens = Math.max(0, occupied);
  const percentage = maxTokens > 0 ? Math.round((totalTokens / maxTokens) * 100) : 0;

  const breakdown = messageBreakdown(session);
  const systemPromptTokens = estimateTextTokens(systemPromptText);
  const skills = skillsSection(deps.resourceLoader);
  const commands = slashCommandsSection(deps.resourceLoader);
  const agents = agentsSection(deps.agentRegistry);
  // The two pi reads degrade independently on purpose: MCP deferral needs only the active set, so a
  // failed `getAllTools()` must not also silence it. Merging these into one guard still passes every
  // other assertion in context-usage.test.ts — only "still badges MCP rows and still defers their
  // tokens when only getAllTools() throws" catches it.
  const activeNames = activeToolNames(session);
  const toolsByName = registeredToolsByName(session);
  const deferrableBuiltinNames = eligibleDeferredBuiltinNames(deps.eligibleToolNames);
  // Computed together and consumed together: the `?? []` fallbacks below are only sound while these two
  // share one guard, so a maintainer weakening one of them in isolation would silently drop that
  // section's tokens from the `Tools` row rather than fail.
  const builtinToolSections =
    activeNames && toolsByName
      ? {
          system: systemToolsSection(activeNames, toolsByName, deferrableBuiltinNames),
          deferred: deferredBuiltinToolsSection(activeNames, toolsByName, deferrableBuiltinNames),
        }
      : null;
  const systemTools = builtinToolSections?.system;
  const deferredBuiltinTools = builtinToolSections?.deferred;
  const mcpTools = mcpToolsSection(deps.mcpEnabled, deps.mcpClientManager, activeNames, toolsByName);

  const messageTokens =
    breakdown.userMessageTokens +
    breakdown.assistantMessageTokens +
    breakdown.toolCallTokens +
    breakdown.toolResultTokens;

  // Every tool token lands in exactly one category: a built-in deferrable row counts as `Tools` when
  // loaded and `Tools (deferred)` when not, and an MCP row does the same across `MCP tools` /
  // `Tools (deferred)`. An MCP row with no `isLoaded` (the active-set read failed) counts as consumed —
  // an over-report is recoverable, "this costs nothing" is not.
  const loadedDeferredBuiltinTokens = sumTokens((deferredBuiltinTools ?? []).filter((t) => t.isLoaded));
  const unloadedDeferredBuiltinTokens = sumTokens((deferredBuiltinTools ?? []).filter((t) => !t.isLoaded));
  const loadedMcpTokens = sumTokens(mcpTools.filter((t) => t.isLoaded !== false));
  const deferredMcpTokens = sumTokens(mcpTools.filter((t) => t.isLoaded === false));

  const categories: ContextUsageData['categories'] = [
    { name: 'System prompt', tokens: systemPromptTokens, color: '#a78bfa' },
    { name: 'Messages & tools', tokens: messageTokens, color: '#38bdf8' },
    { name: 'Skills', tokens: skills.tokens, color: '#34d399' },
    { name: 'MCP tools', tokens: loadedMcpTokens, color: '#fbbf24' },
    { name: 'Tools', tokens: sumTokens(systemTools ?? []) + loadedDeferredBuiltinTokens, color: '#f472b6' },
    {
      name: 'Tools (deferred)',
      tokens: unloadedDeferredBuiltinTokens + deferredMcpTokens,
      color: '#94a3b8',
      isDeferred: true,
    },
  ];

  const apiUsage = stats
    ? {
        input_tokens: stats.tokens.input,
        output_tokens: stats.tokens.output,
        cache_creation_input_tokens: stats.tokens.cacheWrite,
        cache_read_input_tokens: stats.tokens.cacheRead,
      }
    : null;

  const data: ContextUsageData = {
    model: deps.modelValue,
    totalTokens,
    maxTokens,
    rawMaxTokens: maxTokens,
    percentage,
    categories,
    memoryFiles: [],
    mcpTools,
    agents,
    apiUsage,
  };
  if (systemTools) data.systemTools = systemTools;
  if (deferredBuiltinTools) data.deferredBuiltinTools = deferredBuiltinTools;
  if (systemPromptTokens > 0) data.systemPromptSections = [{ name: 'Damocles system prompt', tokens: systemPromptTokens }];
  if (skills.skillFrontmatter.length > 0) data.skills = skills;
  if (commands) data.slashCommands = commands;
  if (breakdown.hasMessages) data.messageBreakdown = breakdown.value;
  return data;
}

/** pi's per-model context usage, or undefined when unavailable (degrades to the stats snapshot). */
function safeContextUsage(session: AgentSession): { tokens: number | null } | undefined {
  try {
    return session.getContextUsage?.();
  } catch {
    return undefined;
  }
}

/** Per-message + per-tool token breakdown from the active branch, estimated with chars/4. */
function messageBreakdown(session: AgentSession): {
  hasMessages: boolean;
  userMessageTokens: number;
  assistantMessageTokens: number;
  toolCallTokens: number;
  toolResultTokens: number;
  value: NonNullable<ContextUsageData['messageBreakdown']>;
} {
  const empty = {
    hasMessages: false,
    userMessageTokens: 0,
    assistantMessageTokens: 0,
    toolCallTokens: 0,
    toolResultTokens: 0,
    value: {
      toolCallTokens: 0,
      toolResultTokens: 0,
      attachmentTokens: 0,
      assistantMessageTokens: 0,
      userMessageTokens: 0,
      toolCallsByType: [] as { name: string; callTokens: number; resultTokens: number }[],
      attachmentsByType: [] as { name: string; tokens: number }[],
    },
  };
  const sm = session.sessionManager;
  if (!sm?.getBranch || !sm.getLeafId) return empty;

  let branch: readonly unknown[];
  try {
    branch = sm.getBranch(sm.getLeafId() ?? undefined);
  } catch {
    return empty;
  }

  let userMessageTokens = 0;
  let assistantMessageTokens = 0;
  let toolCallTokens = 0;
  let toolResultTokens = 0;
  const byType = new Map<string, { call: number; result: number }>();
  const bucket = (name: string): { call: number; result: number } => {
    let b = byType.get(name);
    if (!b) byType.set(name, (b = { call: 0, result: 0 }));
    return b;
  };

  for (const raw of branch) {
    const entry = raw as { type?: string; message?: { role?: string; content?: unknown; toolCallId?: string } };
    if (entry.type !== 'message') continue;
    const message = entry.message;
    const role = message?.role;
    const text = piMessageText(message?.content);
    if (role === 'user') {
      userMessageTokens += estimateTextTokens(text);
    } else if (role === 'assistant') {
      const blocks = Array.isArray(message?.content) ? message.content : [];
      for (const block of blocks) {
        const b = block as { type?: string; text?: string; name?: string; arguments?: unknown };
        if (b.type === 'text' && typeof b.text === 'string') {
          assistantMessageTokens += estimateTextTokens(b.text);
        } else if (b.type === 'toolCall') {
          const tokens = estimateTextTokens(JSON.stringify(b.arguments ?? {}));
          toolCallTokens += tokens;
          if (b.name) bucket(b.name).call += tokens;
        }
      }
    } else if (role === 'toolResult') {
      toolResultTokens += estimateTextTokens(text);
    }
  }

  const toolCallsByType = [...byType.entries()].map(([name, v]) => ({ name, callTokens: v.call, resultTokens: v.result }));
  const hasMessages = userMessageTokens + assistantMessageTokens + toolCallTokens + toolResultTokens > 0;
  return {
    hasMessages,
    userMessageTokens,
    assistantMessageTokens,
    toolCallTokens,
    toolResultTokens,
    value: {
      toolCallTokens,
      toolResultTokens,
      attachmentTokens: 0,
      assistantMessageTokens,
      userMessageTokens,
      toolCallsByType,
      attachmentsByType: [],
    },
  };
}

/** Discovered skills as a context section, each row carrying its source + clickable file path. */
function skillsSection(loader: ResourceLoader | null): NonNullable<ContextUsageData['skills']> {
  const empty = { totalSkills: 0, includedSkills: 0, tokens: 0, skillFrontmatter: [] };
  if (!loader) return empty;
  let skills: ReturnType<typeof loader.getSkills>['skills'];
  try {
    skills = loader.getSkills().skills;
  } catch {
    return empty;
  }
  const skillFrontmatter = skills.map((s) => ({
    name: s.name,
    source: s.sourceInfo.scope,
    tokens: estimateTextTokens(s.description),
    ...(s.filePath ? { filePath: s.filePath } : {}),
  }));
  const included = skills.filter((s) => !s.disableModelInvocation).length;
  return {
    totalSkills: skills.length,
    includedSkills: included,
    tokens: skillFrontmatter.reduce((sum, s) => sum + s.tokens, 0),
    skillFrontmatter,
  };
}

/** Discovered prompt templates as the slash-commands section, with file paths. */
function slashCommandsSection(loader: ResourceLoader | null): ContextUsageData['slashCommands'] | undefined {
  if (!loader) return undefined;
  const commands: { name: string; source: string; filePath: string; tokens: number }[] = [];
  const seen = new Set<string>();
  const add = (name: string, source: string, filePath: string, text: string): void => {
    if (seen.has(name)) return;
    seen.add(name);
    commands.push({ name, source, filePath, tokens: estimateTextTokens(text) });
  };
  try {
    for (const prompt of loader.getPrompts().prompts) {
      if (prompt.filePath) add(prompt.name, prompt.sourceInfo.scope, prompt.filePath, prompt.content ?? prompt.description ?? '');
    }
  } catch (err) {
    log('[PiSession] slashCommandsSection: prompts read failed: %O', err);
  }
  if (commands.length === 0) return undefined;
  const tokens = commands.reduce((sum, c) => sum + c.tokens, 0);
  return { totalCommands: commands.length, includedCommands: commands.length, tokens, commands };
}

/** Spawnable user/project agents as a context section, each row carrying its template file path. */
function agentsSection(agentRegistry: AgentRegistry | null): ContextUsageData['agents'] {
  if (!agentRegistry) return [];
  return agentRegistry
    .getAvailableConfigs()
    .filter((c) => c.isDefault !== true)
    .map((c) => ({
      agentType: c.name,
      source: AGENT_SCOPE_BY_SOURCE[c.source ?? 'default'],
      tokens: estimateTextTokens(c.systemPrompt),
      ...(c.filePath ? { filePath: c.filePath } : {}),
    }));
}

/**
 * Enabled MCP tools as a context section, each row costed as description + schema. `activeNames` is
 * null when the live active-set read failed; the row then carries no `isLoaded`, because badging a tool
 * Deferred on a failed read would invent a saving that may not exist.
 */
function mcpToolsSection(
  mcpEnabled: boolean,
  manager: McpClientManager | null,
  activeNames: ReadonlySet<string> | null,
  toolsByName: ReadonlyMap<string, ToolInfo> | null,
): ContextUsageData['mcpTools'] {
  if (!mcpEnabled) return [];
  if (!manager) return [];
  return manager
    .getAllToolDescriptors()
    // A descriptor with no entry in pi's registry was never registered (the orphaned-runtime case
    // `missingMcpRegistryNames` reports). Those tokens are ABSENT, not deferred: counting them as a
    // realizable saving promises the user a reduction that loading the tool could never deliver. The
    // `toolsByName === null` path is the registry read failing, where every row is still reported.
    .filter((d) => !toolsByName || toolsByName.has(d.piName))
    .map((d) => ({
      name: d.piName,
      serverName: d.serverName,
      tokens: estimateToolTokens(d.description, d.inputSchema),
      ...(activeNames ? { isLoaded: activeNames.has(d.piName) } : {}),
    }));
}

function sumTokens(rows: readonly { tokens: number }[]): number {
  return rows.reduce((sum, row) => sum + row.tokens, 0);
}

/** The live active tool set, or null when the read throws. */
function activeToolNames(session: AgentSession): Set<string> | null {
  try {
    return new Set(session.getActiveToolNames());
  } catch (err) {
    log('[PiSession] context usage: active tool read failed: %O', err);
    return null;
  }
}

/**
 * Every REGISTERED tool by name, or null when the read throws. pi builds `_toolDefinitions` from the
 * whole registry, independently of the active set (`agent-session.ts:906`), so a deferred tool has a
 * real `ToolInfo` and a real cost — these sections never have to fabricate one.
 */
function registeredToolsByName(session: AgentSession): Map<string, ToolInfo> | null {
  try {
    return new Map(session.getAllTools().map((tool) => [tool.name, tool]));
  } catch (err) {
    log('[PiSession] context usage: registered tool read failed: %O', err);
    return null;
  }
}

/** The browser + compass + web deferrable names this panel is actually eligible to load. */
function eligibleDeferredBuiltinNames(eligibleToolNames: string[]): Set<string> {
  const eligible = new Set(eligibleToolNames);
  return new Set(BUILTIN_DEFERRED_GROUPS.flatMap((g) => g.names).filter((name) => eligible.has(name)));
}

/** Active tools costing context right now, minus the ones the MCP and deferred sections already own. */
function systemToolsSection(
  activeNames: ReadonlySet<string>,
  toolsByName: ReadonlyMap<string, ToolInfo>,
  deferrableBuiltinNames: ReadonlySet<string>,
): NonNullable<ContextUsageData['systemTools']> {
  return [...activeNames]
    .filter((name) => !isMcpToolName(name) && !deferrableBuiltinNames.has(name))
    .flatMap((name) => toolRow(toolsByName.get(name), name));
}

/** The eligible browser + compass + web tools, each badged with whether `ToolSearch` has loaded it. */
function deferredBuiltinToolsSection(
  activeNames: ReadonlySet<string>,
  toolsByName: ReadonlyMap<string, ToolInfo>,
  deferrableBuiltinNames: ReadonlySet<string>,
): NonNullable<ContextUsageData['deferredBuiltinTools']> {
  return [...deferrableBuiltinNames].flatMap((name) => {
    const [row] = toolRow(toolsByName.get(name), name);
    return row ? [{ ...row, isLoaded: activeNames.has(name) }] : [];
  });
}

/**
 * A costed row, or no row at all when pi holds no definition for the name. A tool with no `ToolInfo`
 * has no knowable cost, and a fabricated 0 would read as "this is free" — the one lie a cost column
 * must never tell. Dropping the row keeps the section honest and the omission logged.
 */
function toolRow(tool: ToolInfo | undefined, name: string): { name: string; tokens: number }[] {
  if (!tool) {
    log('[PiSession] context usage: no tool definition for %s; omitting its row', name);
    return [];
  }
  return [{ name, tokens: estimateToolTokens(tool.description, tool.parameters) }];
}
