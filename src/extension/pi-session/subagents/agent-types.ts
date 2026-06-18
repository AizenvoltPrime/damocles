/**
 * agent-types.ts — Unified agent type registry (defaults + markdown agents).
 *
 * Adapted from @tintinweb/pi-subagents (MIT, © 2026 tintinweb; see THIRD-PARTY-NOTICES.md).
 * Two Damocles-specific changes from upstream:
 *  - `BUILTIN_TOOL_NAMES` is a hardcoded constant (the pi-native lowercase set) rather than derived
 *    from pi's `createCodingTools`/`createReadOnlyTools`: those are value imports from the ESM-only pi
 *    package, which statically-loaded CJS modules must not pull in (pi is dynamic-import-only, B2).
 *  - The registry is an instance (`AgentRegistry`), not a module-global Map, since one Node process
 *    hosts multiple panels.
 */

import { DEFAULT_AGENTS } from './default-agents';
import type { AgentConfig } from './types';

/**
 * All known pi built-in tool names (pi-native lowercase). Frontmatter `tools:` entries reference these;
 * `resolveAgentToolset` maps them to the Damocles active-set names (PascalCase Edit, etc.). Kept in sync
 * with pi's `createCodingTools` (read/bash/edit/write) ∪ `createReadOnlyTools` (read/grep/find/ls).
 */
export const BUILTIN_TOOL_NAMES: readonly string[] = ['read', 'bash', 'edit', 'write', 'grep', 'find', 'ls'];

/** A merged registry of agents (embedded defaults overlaid by user-defined markdown agents). */
export class AgentRegistry {
  private agents = new Map<string, AgentConfig>();

  constructor() {
    this.register(new Map());
  }

  /**
   * Rebuild the registry: embedded defaults first, then overlay user agents (latest-name-wins, so a
   * user `Explore.md` overrides the embedded one). Disabled agents (`enabled === false`) are kept but
   * excluded from spawning.
   */
  register(userAgents: Map<string, AgentConfig>): void {
    this.agents.clear();
    for (const [name, config] of DEFAULT_AGENTS) this.agents.set(name, config);
    for (const [name, config] of userAgents) this.agents.set(name, config);
  }

  /** Case-insensitive key resolution to the canonical registered name. */
  private resolveKey(name: string): string | undefined {
    if (this.agents.has(name)) return name;
    const lower = name.toLowerCase();
    for (const key of this.agents.keys()) {
      if (key.toLowerCase() === lower) return key;
    }
    return undefined;
  }

  /** Resolve a type name case-insensitively. Returns the canonical key or undefined. */
  resolveType(name: string): string | undefined {
    return this.resolveKey(name);
  }

  /** Get the agent config for a type (case-insensitive). */
  getAgentConfig(name: string): AgentConfig | undefined {
    const key = this.resolveKey(name);
    return key ? this.agents.get(key) : undefined;
  }

  /** All enabled type names (for spawning and tool descriptions). */
  getAvailableTypes(): string[] {
    return [...this.agents.entries()].filter(([, c]) => c.enabled !== false).map(([name]) => name);
  }

  /** All enabled agent configs. */
  getAvailableConfigs(): AgentConfig[] {
    return [...this.agents.values()].filter((c) => c.enabled !== false);
  }

  /** All type names including disabled (for UI listing). */
  getAllTypes(): string[] {
    return [...this.agents.keys()];
  }

  /** True if a type is valid and enabled (case-insensitive). */
  isValidType(type: string): boolean {
    const key = this.resolveKey(type);
    return key ? this.agents.get(key)?.enabled !== false : false;
  }
}
