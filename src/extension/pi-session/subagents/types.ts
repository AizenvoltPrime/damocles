/**
 * types.ts — Type definitions for the native subagent engine.
 *
 * Adapted from @tintinweb/pi-subagents (MIT, © 2026 tintinweb; see THIRD-PARTY-NOTICES.md).
 * Schedule/worktree/group shapes dropped (those features are excluded — see the Phase 5 plan).
 * The deferred fields `isolation`, `inheritContext`, and `memory` are parsed from frontmatter but
 * carry NO behavior in v1 (worktree isolation, context inheritance, and agent-memory are deferred).
 */

import type { ThinkingLevel } from '@earendil-works/pi-agent-core';
import type { AgentSession } from '@earendil-works/pi-coding-agent';
import type { LifetimeUsage } from './usage';

export type { ThinkingLevel };

/** Agent type: any string name (built-in defaults or user-defined). */
export type SubagentType = string;

/** Names of the three embedded default agents. */
export const DEFAULT_AGENT_NAMES = ['general-purpose', 'Explore', 'Plan'] as const;

/** Memory scope for persistent agent memory (deferred — parsed, no behavior). */
export type MemoryScope = 'user' | 'project' | 'local';

/** Isolation mode for agent execution (deferred — parsed, no behavior). */
export type IsolationMode = 'worktree';

/** Where an agent definition was loaded from. */
export type AgentSource = 'default' | 'project-pi' | 'project-claude' | 'project-damocles' | 'global';

/**
 * The scope badge shown for an agent in the `@` menu and in `/context`, derived from provenance in
 * this one place. Keyed by the full union, so adding a source without deciding its scope fails to
 * compile.
 */
export const AGENT_SCOPE_BY_SOURCE: Record<AgentSource, 'project' | 'user'> = {
  default: 'user',
  global: 'user',
  'project-claude': 'project',
  'project-pi': 'project',
  'project-damocles': 'project',
};

/** Unified agent configuration — used for both default and user-defined agents. */
export interface AgentConfig {
  name: string;
  displayName?: string | undefined;
  description: string;
  /** Built-in tool names from the `tools:` CSV (pi-native lowercase: read/bash/edit/write/grep/find/ls).
   * `undefined` → all built-ins; `[]` → none. Mapped to Damocles active-set names by `resolveAgentToolset`. */
  builtinToolNames?: string[] | undefined;
  /** Raw `ext:` selector entries from the `tools:` CSV (parsed but not wired on the Damocles path in v1). */
  extSelectors?: string[] | undefined;
  /** Tool denylist — subtracted from the resolved set even if otherwise included. */
  disallowedTools?: string[] | undefined;
  /** true = inherit all, string[] = only listed, false = none (extension-tool inheritance; v1 ignores). */
  extensions: true | string[] | false;
  /** Extension-name denylist applied after the include set (v1 ignores). */
  excludeExtensions?: string[] | undefined;
  /** true = inherit all, string[] = only listed, false = none (skill preloading). */
  skills: true | string[] | false;
  model?: string | undefined;
  thinking?: ThinkingLevel | undefined;
  maxTurns?: number | undefined;
  systemPrompt: string;
  promptMode: 'replace' | 'append';
  /** Deferred: fork parent conversation. Parsed, no behavior in v1. */
  inheritContext?: boolean | undefined;
  /** Default for spawn: run in background. undefined = caller decides. */
  runInBackground?: boolean | undefined;
  /** Deferred: no extension tools. Parsed, no behavior in v1. */
  isolated?: boolean | undefined;
  /** Deferred: persistent memory scope. Parsed, no behavior in v1. */
  memory?: MemoryScope | undefined;
  /** Deferred: "worktree" isolation. Parsed, no behavior in v1. */
  isolation?: IsolationMode | undefined;
  /** true = embedded default agent (informational). */
  isDefault?: boolean | undefined;
  /** false = agent is hidden from the registry (excluded from spawning). */
  enabled?: boolean | undefined;
  /** Where this agent was loaded from. */
  source?: AgentSource | undefined;
  /** Absolute path to the markdown template file (undefined for embedded defaults). */
  filePath?: string | undefined;
}

export interface AgentRecord {
  id: string;
  type: SubagentType;
  description: string;
  status: 'queued' | 'running' | 'completed' | 'steered' | 'aborted' | 'stopped' | 'error';
  result?: string | undefined;
  error?: string | undefined;
  toolUses: number;
  startedAt: number;
  completedAt?: number | undefined;
  session?: AgentSession | undefined;
  abortController?: AbortController | undefined;
  promise?: Promise<string> | undefined;
  /** Set when the result was already consumed via GetSubagentResult — suppresses re-notification. */
  resultConsumed?: boolean | undefined;
  /** Steering messages queued before the session was ready. */
  pendingSteers?: string[] | undefined;
  /** Steering messages issued by the USER via `/steer` (not the model's SteerSubagent tool). Surfaced to
   *  the parent when it consumes this subagent's result, so it knows the user redirected the subagent. */
  userSteers?: string[] | undefined;
  /** The tool_use_id from the original Agent tool call (the webview `parentToolUseId`). */
  toolCallId?: string | undefined;
  /** Path to the streaming output transcript file. */
  outputFile?: string | undefined;
  /** Cleanup function for the output file stream subscription. */
  outputCleanup?: (() => void) | undefined;
  /** Unsubscribe for the stream-bridge's session subscription (torn down on completion). */
  bridgeUnsub?: (() => void) | undefined;
  /** Whether this agent was spawned with run_in_background (drives the keep-alive hold + bg-task UI). */
  background?: boolean | undefined;
  /**
   * Lifetime usage breakdown, accumulated via `message_end` events. Survives compaction.
   * Total = input + output + cacheWrite (cacheRead excluded). Initialized to zeros at spawn.
   */
  lifetimeUsage: LifetimeUsage;
  /** Cumulative dollar cost reported by the subagent session, last seen (for budget rollup). */
  costUsd: number;
  /** Number of times this agent's session has compacted. */
  compactionCount: number;
  /** Resolved spawn params, captured for UI display. Fixed at spawn time. */
  invocation?: AgentInvocation;
}

export interface AgentInvocation {
  /** Short display name, e.g. "haiku" — only set when different from parent. */
  modelName?: string | undefined;
  thinking?: ThinkingLevel | undefined;
  maxTurns?: number | undefined;
  runInBackground?: boolean | undefined;
}

export interface EnvInfo {
  isGitRepo: boolean;
  branch: string;
  platform: string;
}
