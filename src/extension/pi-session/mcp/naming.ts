import { log } from '../../logger';

/** Prefix that marks a pi tool as MCP-backed; webview routing keys on it (App.vue). */
export const MCP_TOOL_PREFIX = 'mcp__';

/** Whether a pi tool name is an MCP tool. */
export function isMcpToolName(name: string): boolean {
  return name.startsWith(MCP_TOOL_PREFIX);
}

/**
 * Longest sanitized server prefix. The finished tool name is `mcp__<prefix>__<tool>`, and providers cap
 * the whole thing — OpenAI at 64 characters, Anthropic at 128 — by rejecting the entire request, so one
 * over-long name does not degrade that server, it fails every turn with an opaque 400. Only
 * user-authored names go through `assertValidMcpServerName`'s 64-char rule; names imported from
 * `~/.claude*`, `.mcp.json` and `~/.codex/config.toml` arrive unchecked, and a TOML table key can be
 * any length. Truncation can create a new collision, which `buildServerPrefixMap` already resolves.
 */
const MAX_SERVER_PREFIX_LENGTH = 48;

/** Sanitize a server key for use in a tool name: non-alphanumerics collapse to `_`. */
export function sanitizeServerName(name: string): string {
  const cleaned = name
    .replace(/[^a-zA-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, MAX_SERVER_PREFIX_LENGTH)
    .replace(/_+$/, '');
  return cleaned || 'server';
}

/** Build the final pi tool name from a (already unique) server prefix and an MCP tool name. */
export function formatMcpToolName(serverPrefix: string, toolName: string): string {
  return `${MCP_TOOL_PREFIX}${serverPrefix}__${toolName}`;
}

/**
 * Map each server key to a unique sanitized prefix; collisions ("my-server" vs "my.server") get a
 * numeric suffix and a log.
 *
 * Sorted first (on a copy) because the suffix depends on iteration order, and the caller's order comes
 * from config merge order, which `damocles.assetSourcePrecedence` can flip — which would silently
 * repoint the `mcp__<prefix>__<tool>` names in `damocles.tools.disabled` at a different server.
 * `Array#sort`'s default code-unit order, never `localeCompare`, so it is locale-independent too.
 *
 * Two passes, because one pass lets a derived prefix steal a real server's name: given
 * `["my.server", "my-server", "my_server_2"]`, `my.server` would take `my_server_2` and push aside the
 * server actually called that. Claiming every base first confines suffixes to unclaimed prefixes.
 */
export function buildServerPrefixMap(serverNames: string[]): Map<string, string> {
  const sorted = [...serverNames].sort();
  const bases = sorted.map(name => ({ name, base: sanitizeServerName(name) }));
  const claimedBases = new Set(bases.map(entry => entry.base));

  const assigned = new Map<string, string>();
  const used = new Set<string>();
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
    log('[McpNaming] server prefix collision: "%s" -> "%s"', name, prefix);
  }

  return new Map(sorted.map(name => [name, assigned.get(name)!]));
}

/**
 * Rewrite `mcp__<prefix>__<tool>` names to follow a server rename, so `damocles.tools.disabled` does
 * not silently re-enable every tool the user switched off individually.
 *
 * Mapped per server identity across both name sets, not by string-replacing the renamed prefix:
 * renaming one server can move ANOTHER's suffix, since they are handed out over the whole sorted set.
 * A prefix never contains `__` (runs of non-alphanumerics collapse to one `_`), so the first `__` is
 * always the separator.
 */
export function remapMcpToolNamesForRename(
  toolNames: readonly string[],
  oldServerNames: readonly string[],
  renamedFrom: string,
  renamedTo: string,
): string[] {
  if (renamedFrom === renamedTo) return [...toolNames];

  const oldMap = buildServerPrefixMap([...oldServerNames]);
  const newMap = buildServerPrefixMap(oldServerNames.map(name => (name === renamedFrom ? renamedTo : name)));

  const moves = new Map<string, string>();
  for (const oldName of oldServerNames) {
    const from = oldMap.get(oldName);
    const to = newMap.get(oldName === renamedFrom ? renamedTo : oldName);
    if (from && to && from !== to) moves.set(from, to);
  }
  if (moves.size === 0) return [...toolNames];

  return toolNames.map(toolName => {
    const match = /^mcp__(.+?)__(.+)$/.exec(toolName);
    if (!match) return toolName;
    const moved = moves.get(match[1]!);
    return moved ? formatMcpToolName(moved, match[2]!) : toolName;
  });
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
