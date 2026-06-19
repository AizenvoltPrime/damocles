import { log } from '../../logger';

/** Prefix that marks a pi tool as MCP-backed; webview routing keys on it (App.vue). */
export const MCP_TOOL_PREFIX = 'mcp__';

/** Whether a pi tool name is an MCP tool. */
export function isMcpToolName(name: string): boolean {
  return name.startsWith(MCP_TOOL_PREFIX);
}

/** Sanitize a server key for use in a tool name: non-alphanumerics collapse to `_`. */
export function sanitizeServerName(name: string): string {
  const cleaned = name.replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  return cleaned || 'server';
}

/** Build the final pi tool name from a (already unique) server prefix and an MCP tool name. */
export function formatMcpToolName(serverPrefix: string, toolName: string): string {
  return `${MCP_TOOL_PREFIX}${serverPrefix}__${toolName}`;
}

/**
 * Map each server key to a unique sanitized prefix. Distinct servers can sanitize to the
 * same prefix (e.g. "my-server" and "my.server"); collisions get a numeric suffix and a log.
 */
export function buildServerPrefixMap(serverNames: string[]): Map<string, string> {
  const used = new Set<string>();
  const map = new Map<string, string>();
  for (const name of serverNames) {
    const base = sanitizeServerName(name);
    let prefix = base;
    let n = 2;
    while (used.has(prefix)) {
      prefix = `${base}_${n++}`;
    }
    if (prefix !== base) {
      log('[McpNaming] server prefix collision: "%s" -> "%s"', name, prefix);
    }
    used.add(prefix);
    map.set(name, prefix);
  }
  return map;
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
