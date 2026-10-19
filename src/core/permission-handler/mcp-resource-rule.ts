import type { McpResourceToolName } from '../../shared/tool-names';
import { MCP_TOOL_PREFIX, createMcpToolName } from '../pi-session/mcp/naming';
import { matchesToolPattern } from '../pi-session/mcp/exposure';

/** The one MCP resource tool a URI-scoped rule can name. */
export const READ_MCP_RESOURCE: McpResourceToolName = 'read_mcp_resource';

/** What the settings rules hide from an MCP resource list call. Nothing is covered under YOLO. */
export interface McpResourceRuleFilter {
  /** A deny or ask rule covers a call of the filter's tool naming this server (identity `mcp__<server>__<tool>`). */
  serverCovered(serverName: string): boolean;
  /** A deny rule covers a `read_mcp_resource` call naming this server and URI (bare or URI-scoped). Deny only; reusable without a tool call. */
  resourceDenied(serverName: string, uri: string): boolean;
  /** The first deny rule `resourceDenied` matches, as written in its settings file; undefined when none does. */
  resourceDenyRule(serverName: string, uri: string): string | undefined;
  /**
   * A content at `uri` that the read of `readUri` returned must be left out: a deny rule covers a read of it, or an
   * ask rule does that the read of `readUri` did not already ask under, since a read cannot ask per content.
   */
  contentCovered(serverName: string, uri: string, readUri: string): boolean;
}

/**
 * Splits `mcp__<server>__read_mcp_resource(<uri pattern>)` at the first `(` and the final `)`, so a URI
 * holding parentheses round-trips. The tool name is not checked here: a server name over the provider
 * length limit gives a hashed name that no longer ends in the tool's name, so the evaluator compares it
 * with the names the call's server can have. Null for anything else, an empty pattern included.
 */
export function parseMcpResourceUriRule(rule: string): { toolName: string; uriPattern: string } | null {
  if (!rule.startsWith(MCP_TOOL_PREFIX) || !rule.endsWith(')')) return null;
  const open = rule.indexOf('(');
  if (open <= MCP_TOOL_PREFIX.length || open === rule.length - 2) return null;
  return { toolName: rule.slice(0, open), uriPattern: rule.slice(open + 1, -1) };
}

/**
 * Whether `mcp__<server>__read_mcp_resource(<uri pattern>)` names a read of `uri` on `server`: its tool part
 * is the server's pi name (hashed when long), the name as written or as Claude Code spells it, compared
 * whole since a server name may hold `__`, and its pattern matches with `*` as the only wildcard.
 */
export function uriRuleCovers(rule: string, server: string, uri: string): boolean {
  const parsed = parseMcpResourceUriRule(rule);
  if (parsed === null) return false;
  const names = [
    createMcpToolName(server, READ_MCP_RESOURCE),
    `${MCP_TOOL_PREFIX}${server}__${READ_MCP_RESOURCE}`,
    `${MCP_TOOL_PREFIX}${server.replace(/[^A-Za-z0-9_-]/g, '_')}__${READ_MCP_RESOURCE}`,
  ];
  return names.includes(parsed.toolName) && matchesToolPattern(parsed.uriPattern, uri);
}

/** `createMcpToolName` hashes a name over this length, so its tool part no longer shows. */
const HASHED_TOOL_NAME = /^mcp__.{50}_[0-9a-f]{8}$/;

/**
 * Why an `mcp__` rule or tool list entry holding a parenthesis can never match, or null when it can or holds
 * none: only `mcp__<server>__read_mcp_resource(<uri pattern>)` takes a specifier, with a literal tool part.
 */
export function inertMcpSpecifierRule(rule: string): string | null {
  if (!rule.startsWith(MCP_TOOL_PREFIX) || (!rule.includes('(') && !rule.includes(')'))) return null;
  const parsed = parseMcpResourceUriRule(rule);
  if (parsed === null) return `is not an ${MCP_TOOL_PREFIX}<server>__${READ_MCP_RESOURCE}(<uri pattern>) rule, the one MCP rule form with parentheses`;
  if (parsed.toolName.includes('*')) return 'has a wildcard in its tool name, where a URI-scoped rule needs the literal server name';
  if (!parsed.toolName.endsWith(`__${READ_MCP_RESOURCE}`) && !HASHED_TOOL_NAME.test(parsed.toolName)) {
    return `names a tool other than ${READ_MCP_RESOURCE}, the only one that takes a URI pattern`;
  }
  return null;
}

/** Why a `damocles.tools.disabled` or `disallowed_tools` entry can never turn anything off, or null when it can. */
export function inertToolListEntry(entry: string): string | null {
  if (entry.startsWith(MCP_TOOL_PREFIX) && entry.endsWith(`__${READ_MCP_RESOURCE}`)) {
    return `names ${READ_MCP_RESOURCE} without a URI pattern; ${READ_MCP_RESOURCE} turns it off for every server, ${MCP_TOOL_PREFIX}<server>__${READ_MCP_RESOURCE}(*) for one`;
  }
  return inertMcpSpecifierRule(entry);
}

/**
 * The resources an exact-name tool list (`damocles.tools.disabled`, an agent's `disallowed_tools`) turns off
 * with URI-scoped entries; every other entry names a tool. Configuration, not a permission rule: it holds in
 * every mode, YOLO included, and shapes only the agent's tools, never the user's own attach.
 */
export function disabledResourceMatcher(entries: Iterable<string>): (server: string, uri: string) => boolean {
  const uriEntries = [...entries].filter((entry) => parseMcpResourceUriRule(entry) !== null);
  if (uriEntries.length === 0) return () => false;
  return (server, uri) => uriEntries.some((entry) => uriRuleCovers(entry, server, uri));
}
