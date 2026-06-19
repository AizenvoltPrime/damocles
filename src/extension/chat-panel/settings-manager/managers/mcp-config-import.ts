import { homedir } from "node:os";
import { join } from "node:path";
import { promises as fs } from "node:fs";
import type { McpServerConfig } from "../../../../shared/types/mcp";
import type { McpServerEntry } from "../types";

/**
 * Read-only import of MCP servers from Claude Code / Claude Desktop (US-014.2, decision D15).
 * Sources: `~/.claude.json` (CC global `mcpServers`) and `~/.claude/claude_desktop_config.json`.
 * The CC global wins over Desktop on a name collision; the workspace `.mcp.json` wins over both.
 */
const CLAUDE_GLOBAL_CONFIG_PATH = join(homedir(), ".claude.json");
const CLAUDE_DESKTOP_CONFIG_PATH = join(homedir(), ".claude", "claude_desktop_config.json");

function coerceServerConfig(raw: unknown): McpServerConfig | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  if (typeof o["command"] === "string") return o as unknown as McpServerConfig;
  if (typeof o["url"] === "string") return o as unknown as McpServerConfig;
  return null;
}

/**
 * Validate a raw `mcpServers` map, dropping entries that are not a real stdio/remote server config.
 * Shared by the Claude-import and workspace `.mcp.json` paths so junk keys (`$schema`, typos) can never
 * become phantom servers fed to the spawn chokepoint.
 */
export function coerceServerMap(raw: unknown): Record<string, McpServerConfig> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: Record<string, McpServerConfig> = {};
  for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
    const config = coerceServerConfig(value);
    if (config) out[name] = config;
  }
  return out;
}

async function readMcpServersFromFile(path: string): Promise<Record<string, McpServerConfig>> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await fs.readFile(path, "utf-8"));
  } catch {
    return {};
  }
  if (!parsed || typeof parsed !== "object") return {};
  return coerceServerMap((parsed as Record<string, unknown>)["mcpServers"]);
}

export async function importClaudeMcpServers(): Promise<Record<string, McpServerConfig>> {
  const desktop = await readMcpServersFromFile(CLAUDE_DESKTOP_CONFIG_PATH);
  const global = await readMcpServersFromFile(CLAUDE_GLOBAL_CONFIG_PATH);
  return { ...desktop, ...global };
}

/**
 * Merge workspace `.mcp.json` servers over the read-only Claude import, tagging provenance and
 * applying the Damocles-owned disabled set. Workspace wins on name collision.
 */
export function mergeMcpEntries(
  workspaceServers: Record<string, McpServerConfig>,
  importServers: Record<string, McpServerConfig>,
  disabled: ReadonlySet<string>,
): McpServerEntry[] {
  const merged = new Map<string, McpServerEntry>();
  for (const [name, config] of Object.entries(importServers)) {
    merged.set(name, { name, config, enabled: !disabled.has(name), source: "claude", readonly: true });
  }
  for (const [name, config] of Object.entries(workspaceServers)) {
    merged.set(name, { name, config, enabled: !disabled.has(name), source: "workspace", readonly: false });
  }
  return [...merged.values()];
}
