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
 *   1. global-claude:  ~/.claude/agents/**\/*.md
 *   2. global-pi:      ~/.pi/agent/agents/**\/*.md
 *   3. project-claude: <cwd>/.claude/agents/**\/*.md   (trust-gated)
 *   4. project-pi:     <cwd>/.pi/agents/**\/*.md         (trust-gated, highest)
 */

import { existsSync, readdirSync, type Dirent } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { BUILTIN_TOOL_NAMES } from './agent-types';
import { isSymlink, safeReadFile } from './fs-safety';
import type { AgentConfig, AgentSource, MemoryScope, ThinkingLevel } from './types';

/** The frontmatter parser shape (satisfied by pi's `parseFrontmatter`), injected to avoid a static
 * value import of the ESM-only pi package. */
export type ParseFrontmatter = <T extends Record<string, unknown> = Record<string, unknown>>(
  content: string,
) => { frontmatter: T; body: string };

export interface LoadCustomAgentsOptions {
  /** Whether to scan project-scope dirs (.pi/agents, .claude/agents). Gate on VS Code workspace trust. */
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
  ];
  if (opts.includeProjectScope) {
    dirs.push({ dir: join(opts.cwd, '.claude', 'agents'), source: 'project-claude' });
    dirs.push({ dir: join(opts.cwd, '.pi', 'agents'), source: 'project-pi' });
  }
  return dirs;
}

/** Scan for custom agent .md files. Later dirs override earlier ones with the same agent name. */
export function loadCustomAgents(
  cwd: string,
  parseFrontmatter: ParseFrontmatter,
  options: LoadCustomAgentsOptions,
): Map<string, AgentConfig> {
  const agents = new Map<string, AgentConfig>();
  const dirs = agentDiscoveryDirs({
    cwd,
    homeDir: options.homeDir ?? homedir(),
    includeProjectScope: options.includeProjectScope,
  });
  for (const { dir, source } of dirs) {
    for (const file of collectMarkdownFiles(dir)) {
      loadAgentFile(file, agents, source, parseFrontmatter);
    }
  }
  return agents;
}

/**
 * Recursively collect `.md` file paths under `dir`, skipping hidden dirs, node_modules, and symlinks.
 * Symlinks are never followed — matching the skill-loader / fs-safety posture — so a `agents/x -> /`
 * link in a (trusted-but-hostile) workspace can't make the scanner walk the whole linked subtree or
 * load definitions from outside the intended tree.
 */
function collectMarkdownFiles(dir: string): string[] {
  if (!existsSync(dir) || isSymlink(dir)) return [];

  let entries: Dirent<string>[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  const files: string[] = [];
  for (const entry of entries) {
    if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
    if (entry.isSymbolicLink()) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...collectMarkdownFiles(full));
    else if (entry.isFile() && entry.name.endsWith('.md')) files.push(full);
  }
  return files;
}

/** Parse one agent markdown file and register it (keyed by frontmatter `name`, else filename stem). */
function loadAgentFile(
  filePath: string,
  agents: Map<string, AgentConfig>,
  source: AgentSource,
  parseFrontmatter: ParseFrontmatter,
): void {
  const content = safeReadFile(filePath);
  if (content === undefined) return; // missing, unreadable, or a symlink (rejected)

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
    isolation: fm['isolation'] === 'worktree' ? 'worktree' : undefined,
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
