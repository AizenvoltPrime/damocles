import { createHash } from 'node:crypto';

/** Prefix that marks a pi tool as MCP-backed; webview routing keys on it (App.vue). */
export const MCP_TOOL_PREFIX = 'mcp__';

/** Whether a pi tool name is an MCP tool. */
export function isMcpToolName(name: string): boolean {
  return name.startsWith(MCP_TOOL_PREFIX);
}

/** Provider tool names are limited to 64 characters of `[A-Za-z0-9_-]`. */
const MAX_TOOL_NAME_LENGTH = 64;
const HASH_LENGTH = 8;
/** How much of a hashed name `createMcpToolName` keeps before `_<hash>`. */
const HASHED_NAME_KEPT_LENGTH = MAX_TOOL_NAME_LENGTH - HASH_LENGTH - 1;

/** Every character outside `[A-Za-z0-9_]` replaced by `_`, as tool names are built. */
export function sanitizeMcpToolName(name: string): string {
  return name.replace(/[^A-Za-z0-9_]/g, '_');
}

/**
 * Ported from pi-coding-agent/src/extensions/mcp/tools.ts `createMcpToolName`. `mcp__<server>__<tool>`
 * with everything but `[A-Za-z0-9_]` replaced by `_`, and an 8-character hash suffix when the name is
 * over 64 characters or `isTaken` reports it used by a different tool.
 */
export function createMcpToolName(
  server: string,
  tool: string,
  isTaken: (name: string) => boolean = () => false,
): string {
  const name = sanitizeMcpToolName(`${MCP_TOOL_PREFIX}${server}__${tool}`);
  if (name.length <= MAX_TOOL_NAME_LENGTH && !isTaken(name)) return name;
  const hash = createHash('sha256').update(`${server}\0${tool}`).digest('hex').slice(0, HASH_LENGTH);
  return `${name.slice(0, HASHED_NAME_KEPT_LENGTH)}_${hash}`;
}

/**
 * Names for one server's tools, ported from pi-coding-agent/src/extensions/mcp/index.ts `registerTools`:
 * every tool whose plain name collides with another of the server's tools gets the hash suffix, so which
 * one keeps the plain name does not depend on list order. `taken` holds names other servers already hold.
 */
export function assignServerToolNames(
  server: string,
  rawToolNames: readonly string[],
  taken: ReadonlySet<string>,
): Map<string, string> {
  const unique = [...new Set(rawToolNames)];
  const plain = unique.map((tool) => createMcpToolName(server, tool));
  const current = new Set<string>();
  const assigned = new Map<string, string>();
  for (const tool of unique) {
    const name = createMcpToolName(
      server,
      tool,
      (candidate) => taken.has(candidate) || current.has(candidate) || plain.indexOf(candidate) !== plain.lastIndexOf(candidate),
    );
    current.add(name);
    assigned.set(tool, name);
  }
  return assigned;
}

/** Convert an MCP resource name into a tool-name-safe slug for `get_{slug}`. */
export function resourceNameToToolName(name: string): string {
  let result = name
    .replace(/[^a-zA-Z0-9]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+/, '')
    .replace(/_+$/, '')
    .toLowerCase();
  if (!result || /^\d/.test(result)) {
    result = 'resource' + (result ? '_' + result : '');
  }
  return result;
}

/** Longest server prefix the legacy names used. */
const MAX_LEGACY_SERVER_PREFIX_LENGTH = 48;

function legacySanitizeServerName(name: string): string {
  const cleaned = name
    .replace(/[^a-zA-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, MAX_LEGACY_SERVER_PREFIX_LENGTH)
    .replace(/_+$/, '');
  return cleaned || 'server';
}

/**
 * The server prefixes of the legacy `mcp__<prefix>__<tool>` names, for migrating stored names only.
 * Sorted, two passes (bases first, then numeric suffixes), and `reserved` prefixes taken by another manager.
 */
export function legacyServerPrefixMap(serverNames: readonly string[], reserved?: ReadonlySet<string>): Map<string, string> {
  const sorted = [...serverNames].sort();
  const bases = sorted.map((name) => ({ name, base: legacySanitizeServerName(name) }));
  const claimedBases = new Set(bases.map((entry) => entry.base));

  const assigned = new Map<string, string>();
  const used = new Set<string>(reserved);
  for (const { name, base } of bases) {
    if (used.has(base)) continue;
    used.add(base);
    assigned.set(name, base);
  }
  for (const { name, base } of bases) {
    if (assigned.has(name)) continue;
    let n = 2;
    let prefix = `${base}_${n}`;
    while (used.has(prefix) || claimedBases.has(prefix)) prefix = `${base}_${++n}`;
    used.add(prefix);
    assigned.set(name, prefix);
  }

  return new Map(sorted.map((name) => [name, assigned.get(name)!]));
}

/** A legacy tool name split at its first `__` (a legacy prefix never contains `__`), or null. */
export function parseLegacyMcpToolName(name: string): { prefix: string; tool: string } | null {
  const match = /^mcp__(.+?)__(.+)$/.exec(name);
  return match ? { prefix: match[1]!, tool: match[2]! } : null;
}

/** The legacy pi name of a tool, given its server's legacy prefix. */
export function legacyMcpToolName(prefix: string, rawToolName: string): string {
  return `${MCP_TOOL_PREFIX}${prefix}__${rawToolName}`;
}
