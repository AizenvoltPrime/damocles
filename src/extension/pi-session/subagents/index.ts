/**
 * subagents/ — Native subagent engine (Phase 5, US-018/019/022).
 *
 * Ported from @tintinweb/pi-subagents (MIT, © 2026 tintinweb; see THIRD-PARTY-NOTICES.md) and rewired
 * onto Damocles' runtime, permission gate, and webview. Facade for the rest of pi-session.
 */

export { AgentManager, DEFAULT_MAX_CONCURRENT } from './agent-manager';
export type { SubagentEngine, SpawnSpec, ResolvedSubagentModel } from './agent-manager';
export { AgentRegistry, BUILTIN_TOOL_NAMES } from './agent-types';
export { WorkspaceAgentRegistry } from './workspace-agent-registry';
export { loadCustomAgents } from './custom-agents';
export type { ParseFrontmatter, LoadCustomAgentsOptions } from './custom-agents';
export { DEFAULT_AGENTS } from './default-agents';
export { resolveAgentToolset } from './agent-toolset';
export { resolveEnabledModels, readEnabledModels, isModelInScope } from './enabled-models';
export { piMessagesToHistoryAgentMessages } from './message-mapper';
export { DEFAULT_AGENT_NAMES } from './types';
export type { AgentConfig, AgentRecord, AgentSource, SubagentType } from './types';
