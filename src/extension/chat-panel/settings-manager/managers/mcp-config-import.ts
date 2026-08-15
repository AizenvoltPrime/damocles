import { homedir } from "node:os";
import { join } from "node:path";
import { promises as fs } from "node:fs";
import { parse as parseToml, TomlError } from "smol-toml";
import type {
  McpConfigError,
  McpHttpServerConfig,
  McpServerConfig,
  McpServerSource,
  McpStdioServerConfig,
} from "../../../../shared/types/mcp";
import type { AssetSourcePrecedence } from "../../../asset-sources";
import type { McpServerEntry } from "../types";
import { log } from "../../../logger";

/**
 * Read-only import of MCP servers from Claude Code / Claude Desktop (US-014.2, decision D15).
 * Sources: `~/.claude.json` (CC global `mcpServers`) and `~/.claude/claude_desktop_config.json`.
 * The CC global wins over Desktop on a name collision; the workspace `.mcp.json` wins over both.
 */
const CLAUDE_GLOBAL_CONFIG_PATH = join(homedir(), ".claude.json");
const CLAUDE_DESKTOP_CONFIG_PATH = join(homedir(), ".claude", "claude_desktop_config.json");

/** The user-global Damocles MCP file — same `{ "mcpServers": { ... } }` shape as a workspace `.mcp.json`. */
export const DAMOCLES_MCP_CONFIG_PATH: string = join(homedir(), ".damocles", "mcp.json");

/** Codex's global config; only its `mcp_servers` table is read, and mapped onto `McpServerConfig`. */
export const CODEX_CONFIG_PATH: string = join(homedir(), ".codex", "config.toml");

/** A provenance-tagged batch of servers, as handed to `mergeMcpEntries` in precedence order. */
export interface McpSourceServers {
  source: McpServerSource;
  servers: Record<string, McpServerConfig>;
}

/** The user-global sources in precedence order, plus any config file that failed to parse. */
export interface GlobalMcpSources {
  sources: McpSourceServers[];
  errors: McpConfigError[];
}

/**
 * Whether a source's servers are read-only in Damocles, derived from provenance in this one place so
 * `source` and `readonly` can never disagree. Damocles owns the workspace `.mcp.json` and
 * `~/.damocles/mcp.json`; the Claude and Codex files belong to other tools and are imported read-only.
 * Keyed by the full union, so adding a source without deciding its editability fails to compile.
 */
const READONLY_BY_SOURCE: Record<McpServerSource, boolean> = {
  workspace: false,
  damocles: false,
  claude: true,
  codex: true,
};

/**
 * Recognised configs are returned **UNCHANGED, never normalised**: this filters entries, it does not
 * strip keys. `editableConfig` (`mcp-manager.toStatusInfo`) asks `isFormEditableMcpServerConfig` about
 * this exact object, so stripping a key here would make a config the edit form cannot represent — and
 * would silently destroy on save — look editable. Pinned by `__tests__/mcp-manager-editable-config.test.ts`
 * ("omits it entirely for a Damocles server storing a non-form key").
 */
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

/** The outcome of reading one `{ "mcpServers": {...} }` file. */
export interface McpFileRead {
  servers: Record<string, McpServerConfig>;
  error: McpConfigError | null;
}

/** `/home/me/.damocles/mcp.json` → `~/.damocles/mcp.json`, so a screenshot carries no username. */
function collapseHome(target: string): string {
  const home = homedir();
  if (!target.startsWith(home)) return target;
  return `~${target.slice(home.length).split("\\").join("/")}`;
}

/** The 1-based line and column of `offset` in `text`, for parsers that report only a flat position. */
function offsetToLineColumn(text: string, offset: number): Pick<McpConfigError, "line" | "column"> {
  const upTo = text.slice(0, Math.max(0, Math.min(offset, text.length)));
  const lastBreak = upTo.lastIndexOf("\n");
  return { line: upTo.split("\n").length, column: upTo.length - lastBreak };
}

/**
 * A parse failure's location, with the parser's own message discarded — V8 embeds a window of the
 * source in some `JSON.parse` messages (an unquoted value yields
 * `Unexpected token 's', ..."":{"TOKEN":sk-SUPERSE"...`), an ordinary hand-edit slip that would put
 * part of a credential in the log and the webview. Only numbers are extracted.
 *
 * Three shapes exist across V8 versions: line+column, a flat `position N` (converted here), and the
 * snippet form above, which carries no position and so reports none rather than a guess.
 */
function locateJsonParseFailure(err: unknown, text: string): Pick<McpConfigError, "line" | "column"> {
  const message = err instanceof Error ? err.message : "";
  const lineColumn = /line (\d+) column (\d+)/.exec(message);
  if (lineColumn) return { line: Number(lineColumn[1]), column: Number(lineColumn[2]) };
  const position = /position (\d+)/.exec(message);
  if (position) return offsetToLineColumn(text, Number(position[1]));
  return { line: null, column: null };
}

/**
 * Read one MCP config file. A missing file is not an error — every source is optional. Anything else
 * is reported rather than swallowed: a stray comma or a permission denial would otherwise make every
 * server in it disappear from the panel with no explanation anywhere.
 *
 * The OS message is not carried; only its `code` reaches the log and the webview gets `kind` alone.
 * Same ENOENT-only distinction `readDocument` makes on the write side.
 */
export async function readMcpConfigFile(path: string): Promise<McpFileRead> {
  let raw: string;
  try {
    raw = await fs.readFile(path, "utf-8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { servers: {}, error: null };
    log("[McpConfig] %s could not be read (%s); its servers were skipped", path, code ?? "unknown error");
    return { servers: {}, error: { path, displayPath: collapseHome(path), kind: "unreadable", line: null, column: null } };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    const { line, column } = locateJsonParseFailure(err, raw);
    const at = line === null ? "location unknown" : `line ${line}, column ${column}`;
    log("[McpConfig] %s could not be parsed (%s); its servers were skipped", path, at);
    return { servers: {}, error: { path, displayPath: collapseHome(path), kind: "parse", line, column } };
  }

  if (!parsed || typeof parsed !== "object") return { servers: {}, error: null };
  return { servers: coerceServerMap((parsed as Record<string, unknown>)["mcpServers"]), error: null };
}

async function readMcpServersFromFile(path: string): Promise<Record<string, McpServerConfig>> {
  return (await readMcpConfigFile(path)).servers;
}

export async function importClaudeMcpServers(): Promise<Record<string, McpServerConfig>> {
  const desktop = await readMcpServersFromFile(CLAUDE_DESKTOP_CONFIG_PATH);
  const global = await readMcpServersFromFile(CLAUDE_GLOBAL_CONFIG_PATH);
  return { ...desktop, ...global };
}

/** The user-global Damocles MCP servers. Same file shape as `.mcp.json`, so the same reader serves it. */
export async function readDamoclesMcpServers(): Promise<McpFileRead> {
  return readMcpConfigFile(DAMOCLES_MCP_CONFIG_PATH);
}

function isTable(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/** A TOML array of strings, or null if the value is absent or holds anything else. */
function readStringArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  return value.every(item => typeof item === "string") ? (value as string[]) : null;
}

/**
 * Codex's two environment keys are not interchangeable: `env_vars` lists variable NAMES to forward,
 * `env` sets explicit pairs. Forwarded names are laid down first so an explicit `env` entry wins.
 *
 * A forwarded name becomes the REFERENCE `${NAME}`, never the resolved value: `env_vars` is where a
 * Codex user puts `OPENAI_API_KEY`, and materialising it would park a live token in
 * `McpManager.entries` for the window's lifetime. `interpolateEnvVars` resolves it at spawn instead,
 * so a value that changes mid-session is picked up rather than frozen at import.
 */
function buildCodexEnv(raw: Record<string, unknown>): Record<string, string> | null {
  const env: Record<string, string> = {};
  for (const name of readStringArray(raw["env_vars"]) ?? []) {
    // Presence is still checked, so an unset variable stays absent rather than arriving as "".
    if (typeof process.env[name] === "string") env[name] = `\${${name}}`;
  }
  const table = raw["env"];
  if (isTable(table)) {
    for (const [key, value] of Object.entries(table)) {
      if (typeof value === "string") env[key] = value;
    }
  }
  return Object.keys(env).length > 0 ? env : null;
}

/**
 * Map one `[mcp_servers.<name>]` table onto an `McpServerConfig`. Only the keys below are carried over;
 * everything else Codex supports (`startup_timeout_sec`, `tool_timeout_sec`, …) is dropped rather than
 * passed through to a runtime that would not understand it.
 */
function mapCodexServer(raw: unknown): McpServerConfig | null {
  if (!isTable(raw)) return null;
  // Only the literal boolean `false` disables. Absent means enabled — and honouring it matters, or
  // Damocles would spawn servers the user deliberately switched off in Codex.
  if (raw["enabled"] === false) return null;

  const url = raw["url"];
  if (typeof url === "string") {
    // `type` is set explicitly: `McpHttpServerConfig` needs the discriminant, and `coerceServerConfig`
    // would otherwise wave a bare `url` through with no transport at all.
    const remote: McpHttpServerConfig = { type: "http", url };
    const bearerTokenEnv = raw["bearer_token_env_var"];
    // The variable NAME, never a resolved token: no secret is materialised at import time.
    if (typeof bearerTokenEnv === "string") remote.bearerTokenEnv = bearerTokenEnv;
    return remote;
  }

  const command = raw["command"];
  if (typeof command === "string") {
    const stdio: McpStdioServerConfig = { command };
    const args = readStringArray(raw["args"]);
    if (args) stdio.args = args;
    const env = buildCodexEnv(raw);
    if (env) stdio.env = env;
    return stdio;
  }

  return null;
}

/**
 * Read the `mcp_servers` table out of `~/.codex/config.toml`. A missing file yields `{}` silently, as
 * the JSON readers do; an unparseable file yields `{}` and logs exactly once — failing to read one
 * ecosystem must never stop the others loading.
 *
 * The final `coerceServerMap()` cannot filter anything today — every value came from `mapCodexServer`,
 * which returns only shapes `coerceServerConfig` accepts. It is kept so the spawn chokepoint has one
 * validation path regardless of which reader fed it, and so a future mapping change cannot bypass it.
 */
export async function readCodexMcpServers(): Promise<Record<string, McpServerConfig>> {
  let text: string;
  try {
    text = await fs.readFile(CODEX_CONFIG_PATH, "utf-8");
  } catch {
    return {};
  }

  let parsed: unknown;
  try {
    parsed = parseToml(text);
  } catch (err) {
    // Position only, never the parser's message: a TOML error quotes the offending source line, which
    // can be the very line holding a credential, and this channel is written to disk.
    const where = err instanceof TomlError ? `line ${err.line}, column ${err.column}` : "an unknown position";
    log("[McpImport] ~/.codex/config.toml is not valid TOML (%s); no Codex MCP servers loaded", where);
    return {};
  }

  if (!isTable(parsed)) return {};
  const table = parsed["mcp_servers"];
  if (!isTable(table)) return {};

  const mapped: Record<string, McpServerConfig> = {};
  for (const [name, entry] of Object.entries(table)) {
    const config = mapCodexServer(entry);
    if (config) mapped[name] = config;
  }
  return coerceServerMap(mapped);
}

/**
 * The user-global MCP sources, lowest precedence first, ready to fold. The claude/codex pair is ordered
 * by `damocles.assetSourcePrecedence` — the loser is folded first so the configured winner overwrites
 * it — and `~/.damocles/mcp.json` outranks both because Damocles owns it. The caller appends the
 * workspace `.mcp.json`, which outranks everything. Each reader degrades to `{}` on its own, so one
 * unreadable ecosystem never costs you the others.
 */
export async function readGlobalMcpSources(
  precedence: AssetSourcePrecedence,
): Promise<GlobalMcpSources> {
  const [claude, codex, damocles] = await Promise.all([
    importClaudeMcpServers(),
    readCodexMcpServers(),
    readDamoclesMcpServers(),
  ]);
  const claudeSource: McpSourceServers = { source: "claude", servers: claude };
  const codexSource: McpSourceServers = { source: "codex", servers: codex };
  const damoclesSource: McpSourceServers = { source: "damocles", servers: damocles.servers };
  return {
    sources: precedence === "codex"
      ? [claudeSource, codexSource, damoclesSource]
      : [codexSource, claudeSource, damoclesSource],
    // Only the file Damocles owns is surfaced. The Claude and Codex imports are other tools' files:
    // a parse failure there is logged, but is theirs to fix and not worth a notice in this panel.
    errors: damocles.error ? [damocles.error] : [],
  };
}

/**
 * Fold provenance-tagged server maps into the entry list, lowest precedence FIRST: a later source
 * overwrites an earlier one on a name collision, so precedence reads off the caller's array order.
 * `readonly` comes from `READONLY_BY_SOURCE`, and the Damocles-owned disabled set applies to every
 * source alike.
 */
export function mergeMcpEntries(
  sources: readonly McpSourceServers[],
  disabled: ReadonlySet<string>,
): McpServerEntry[] {
  const merged = new Map<string, McpServerEntry>();
  for (const { source, servers } of sources) {
    for (const [name, config] of Object.entries(servers)) {
      merged.set(name, {
        name,
        config,
        enabled: !disabled.has(name),
        source,
        readonly: READONLY_BY_SOURCE[source],
      });
    }
  }
  return [...merged.values()];
}
