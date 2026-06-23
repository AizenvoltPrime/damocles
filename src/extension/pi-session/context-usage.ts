import type { AgentSession, ResourceLoader } from '@earendil-works/pi-coding-agent';
import type { ContextUsageData } from '../../shared/types/session';
import { log } from '../logger';
import { piMessageText } from './branch-text';
import type { McpClientManager } from './mcp/mcp-client-manager';
import type { AgentRegistry } from './subagents/agent-types';

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
}

/** chars/4 token estimate (pi's own heuristic), conservative — used for every estimated section. */
function estimateTextTokens(text: string): number {
  return text ? Math.ceil(text.length / 4) : 0;
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
  const mcpTools = mcpToolsSection(deps.mcpEnabled, deps.mcpClientManager);

  const messageTokens =
    breakdown.userMessageTokens +
    breakdown.assistantMessageTokens +
    breakdown.toolCallTokens +
    breakdown.toolResultTokens;

  const categories: ContextUsageData['categories'] = [
    { name: 'System prompt', tokens: systemPromptTokens, color: '#a78bfa' },
    { name: 'Messages & tools', tokens: messageTokens, color: '#38bdf8' },
    { name: 'Skills', tokens: skills.tokens, color: '#34d399' },
    { name: 'MCP tools', tokens: mcpTools.reduce((sum, t) => sum + t.tokens, 0), color: '#fbbf24' },
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
      source: c.source === 'project-pi' || c.source === 'project-claude' ? 'project' : 'user',
      tokens: estimateTextTokens(c.systemPrompt),
      ...(c.filePath ? { filePath: c.filePath } : {}),
    }));
}

/** Enabled MCP tools as a context section, each row estimated from its description. */
function mcpToolsSection(mcpEnabled: boolean, manager: McpClientManager | null): ContextUsageData['mcpTools'] {
  if (!mcpEnabled) return [];
  if (!manager) return [];
  return manager.getAllToolDescriptors().map((d) => ({
    name: d.piName,
    serverName: d.serverName,
    tokens: estimateTextTokens(d.description),
    isLoaded: true,
  }));
}
