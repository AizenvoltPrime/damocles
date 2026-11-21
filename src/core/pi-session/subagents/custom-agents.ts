/**
 * custom-agents.ts — Load user-defined agents from markdown.
 *
 * Adapted from @tintinweb/pi-subagents (MIT, © 2026 tintinweb; see THIRD-PARTY-NOTICES.md).
 * Damocles changes:
 *  - pi's `parseFrontmatter` is a value export from the ESM-only pi package, so it is INJECTED
 *    (the caller passes `pi.parseFrontmatter`) rather than statically imported.
 *  - Discovery spans both pi-set and Claude-set locations (`agentDiscoveryDirs`), matching pi's
 *    reference subagent extension (`getAgentDir()/agents` + project `.pi/agents`) AND Claude Code
 *    (`~/.claude/agents` + project `.claude/agents`). Reading the user's real global dirs is
 *    read-only template discovery — it does not touch pi's CLI runtime state, so the FR-9/FR-12
 *    isolation boundary (sessions/auth/settings) is intact.
 *  - The scan recurses into subdirectories: Claude's `~/.claude/agents` organizes profiles in
 *    nested folders (engineering/, design/, …), so a flat scan finds nothing.
 *  - Agents key on frontmatter `name:` (e.g. "AI Engineer"), falling back to the filename stem.
 *  - Project-scope dirs load only when `includeProjectScope` is true (VS Code workspace trust gate).
 *
 * Discovery precedence (later wins, overlaid latest-name-wins onto the registry's defaults):
 *   1. global-claude:    ~/.claude/agents/**\/*.md
 *   2. global-pi:        ~/.pi/agent/agents/**\/*.md
 *   3. global-damocles:  ~/.damocles/agents/**\/*.md
 *   4. project-claude:   <cwd>/.claude/agents/**\/*.md    (trust-gated)
 *   5. project-pi:       <cwd>/.pi/agents/**\/*.md        (trust-gated)
 *   6. project-damocles: <cwd>/.damocles/agents/**\/*.md  (trust-gated, highest)
 */

import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { boundedLog, compareInNameOrder, walkAssetTree, type WatchTarget } from '../../assets';
import { userConfigBase } from '../../config/local-config-path';
import { log } from '../../logger';
import { BUILTIN_TOOL_NAMES } from './agent-types';
import type { AgentConfig, AgentSource, MemoryScope, ThinkingLevel } from './types';

const AGENT_MAX_DEPTH = 16;

/** The frontmatter parser shape (satisfied by pi's `parseFrontmatter`), injected to avoid a static
 * value import of the ESM-only pi package. */
export type ParseFrontmatter = <T extends Record<string, unknown> = Record<string, unknown>>(
  content: string,
) => { frontmatter: T; body: string };

export interface LoadCustomAgentsOptions {
  /** Whether to scan project-scope dirs (.claude/agents, .pi/agents, .damocles/agents). Gate on VS Code workspace trust. */
  includeProjectScope: boolean;
  /** User home directory used for global discovery. Defaults to `os.homedir()`; overridable in tests. */
  homeDir?: string;
}

/** One scanned agent directory and the source tag applied to agents found under it. */
export interface AgentDirSpec {
  dir: string;
  source: AgentSource;
}

/**
 * The ordered agent-discovery directories (lowest → highest precedence). Single source of truth
 * shared by `loadCustomAgents` and the workspace watcher so the two never drift.
 */
export function agentDiscoveryDirs(opts: {
  cwd: string;
  homeDir: string;
  includeProjectScope: boolean;
}): AgentDirSpec[] {
  const dirs: AgentDirSpec[] = [
    { dir: join(opts.homeDir, '.claude', 'agents'), source: 'global' },
    { dir: join(opts.homeDir, '.pi', 'agent', 'agents'), source: 'global' },
    { dir: join(opts.homeDir, '.damocles', 'agents'), source: 'global' },
  ];
  if (opts.includeProjectScope) {
    dirs.push({ dir: join(opts.cwd, '.claude', 'agents'), source: 'project-claude' });
    dirs.push({ dir: join(opts.cwd, '.pi', 'agents'), source: 'project-pi' });
    dirs.push({ dir: join(opts.cwd, '.damocles', 'agents'), source: 'project-damocles' });
  }
  return dirs;
}

export interface LoadedCustomAgents {
  agents: Map<string, AgentConfig>;
  /** The user-scope agents alone, as they stood before any project agent overrode a name. */
  userAgents: Map<string, AgentConfig>;
  /** What to watch so a change behind a followed or broken link reloads. */
  followed: WatchTarget[];
}

/**
 * Scan for custom agent .md files, following links under docs/invariants.md "Asset discovery and links" (the caller
 * reads project dirs only when trusted, so every scanned dir follows). An agent is its name: later dirs override earlier
 * ones with the same agent name, and a link under another name is an agent of its own.
 */
export async function loadCustomAgents(
  cwd: string,
  parseFrontmatter: ParseFrontmatter,
  options: LoadCustomAgentsOptions,
): Promise<LoadedCustomAgents> {
  const agents = new Map<string, AgentConfig>();
  const followed: WatchTarget[] = [];
  const homeDir = options.homeDir ?? homedir();
  const dirs = agentDiscoveryDirs({ cwd, homeDir, includeProjectScope: options.includeProjectScope });
  const logLine = boundedLog((line) => log('%s', line));
  let userAgents: Map<string, AgentConfig> | undefined;
  for (const { dir, source } of dirs) {
    // every user dir precedes every project dir (agentDiscoveryDirs)
    if (source !== 'global') userAgents ??= new Map(agents);
    const walk = await walkAssetTree({
      scopeRoot: source === 'global' ? userConfigBase(dir, homeDir) : cwd,
      root: dir,
      policy: { kind: 'follow' },
      maxDepth: AGENT_MAX_DEPTH,
      dirGlob: '*.md',
      repeatFolders: 'walk',
      skipHidden: true,
      log: logLine,
    });
    followed.push(...walk.followed);
    // in name order, so of two files in one dir declaring the same `name` the last wins on every file system, links included
    for (const entry of [...walk.entries].sort((a, b) => compareInNameOrder(a.segments, b.segments))) {
      if (entry.kind !== 'file') continue;
      try {
        loadAgentFile(entry.path, entry.text, agents, source, parseFrontmatter);
      } catch (err) {
        logLine(`[assets] ${entry.path}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }
  return { agents, userAgents: userAgents ?? new Map(agents), followed };
}

/** Parse one agent markdown file and register it (keyed by frontmatter `name`, else filename stem). */
function loadAgentFile(
  filePath: string,
  content: string,
  agents: Map<string, AgentConfig>,
  source: AgentSource,
  parseFrontmatter: ParseFrontmatter,
): void {
  const { frontmatter: fm, body } = parseFrontmatter<Record<string, unknown>>(content);
  const fmName = str(fm['name'])?.trim();
  const name = fmName || basename(filePath, '.md');
  const { builtinToolNames, extSelectors } = parseToolsField(fm['tools']);
  const builtinToolNamesField = builtinToolNames === undefined ? {} : { builtinToolNames };

  agents.set(name, {
    name,
    displayName: str(fm['display_name']),
    description: str(fm['description']) ?? name,
    ...builtinToolNamesField,
    extSelectors,
    disallowedTools: csvListOptional(fm['disallowed_tools']),
    extensions: inheritField(fm['extensions'] ?? fm['inherit_extensions']),
    excludeExtensions: csvListOptional(fm['exclude_extensions']),
    skills: inheritField(fm['skills'] ?? fm['inherit_skills']),
    model: str(fm['model']),
    thinking: str(fm['thinking']) as ThinkingLevel | undefined,
    maxTurns: nonNegativeInt(fm['max_turns']),
    systemPrompt: body.trim(),
    promptMode: fm['prompt_mode'] === 'append' ? 'append' : 'replace',
    inheritContext: fm['inherit_context'] != null ? fm['inherit_context'] === true : undefined,
    runInBackground: fm['run_in_background'] != null ? fm['run_in_background'] === true : undefined,
    isolated: fm['isolated'] != null ? fm['isolated'] === true : undefined,
    memory: parseMemory(fm['memory']),
    enabled: fm['enabled'] !== false,
    source,
    filePath,
  });
}

// ---- Field parsers — omitted → default, "none"/empty → nothing, value → exact ----

function str(val: unknown): string | undefined {
  return typeof val === 'string' ? val : undefined;
}

/** Non-negative integer or undefined. 0 means unlimited for max_turns. */
function nonNegativeInt(val: unknown): number | undefined {
  return typeof val === 'number' && val >= 0 ? val : undefined;
}

/** Parse a raw CSV field value into items, or undefined if absent/empty/"none". */
function parseCsvField(val: unknown): string[] | undefined {
  if (val === undefined || val === null) return undefined;
  const s = String(val).trim();
  if (!s || s === 'none') return undefined;
  const items = s.split(',').map((t) => t.trim()).filter(Boolean);
  return items.length > 0 ? items : undefined;
}

/** omitted → defaults; "none"/empty → []; csv → listed items. */
function csvList(val: unknown, defaults: readonly string[]): string[] {
  if (val === undefined || val === null) return [...defaults];
  return parseCsvField(val) ?? [];
}

/**
 * Partition the `tools:` CSV into the built-in tool allowlist and raw `ext:` selectors.
 * `*` / `all` → `builtinToolNames: undefined` ("all available tools" — `resolveAgentToolset` then
 * mirrors the parent's full active set, the same marker an omitted `tools:` uses). Plain entries are
 * pi-native built-in names; `ext:` entries are extension-tool selectors. omitted → undefined (all);
 * `tools:` with only `ext:` entries → `[]` (zero built-ins).
 */
function parseToolsField(val: unknown): { builtinToolNames: string[] | undefined; extSelectors: string[] | undefined } {
  if (val === undefined || val === null) return { builtinToolNames: undefined, extSelectors: undefined };
  const entries = csvList(val, BUILTIN_TOOL_NAMES);
  const isWildcard = (e: string) => e === '*' || e.toLowerCase() === 'all';
  const hasWildcard = entries.some(isWildcard);
  const plain = entries.filter((e) => !isWildcard(e) && !e.startsWith('ext:'));
  const extEntries = entries.filter((e) => e.startsWith('ext:'));
  return {
    builtinToolNames: hasWildcard ? undefined : plain,
    extSelectors: extEntries.length > 0 ? extEntries : undefined,
  };
}

function csvListOptional(val: unknown): string[] | undefined {
  return parseCsvField(val);
}

function parseMemory(val: unknown): MemoryScope | undefined {
  if (val === 'user' || val === 'project' || val === 'local') return val;
  return undefined;
}

/** omitted/true → true (inherit all); false/"none"/empty → false; csv → listed names. */
function inheritField(val: unknown): true | string[] | false {
  if (val === undefined || val === null || val === true) return true;
  if (val === false || val === 'none') return false;
  const items = csvList(val, []);
  return items.length > 0 ? items : false;
}
