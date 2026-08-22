import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";
import { promises as fs } from "node:fs";
import { parse as parseToml, TomlError } from "smol-toml";
import { mcpSourceOrder } from "../../../../shared/types/mcp";
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

// Precedence is declared in the shared module so the webview form reads the same order. Re-exported
// here because this is where every host consumer already looks for MCP source metadata.
export { mcpSourceOrder };

/**
 * Read-only import of MCP servers from Claude Code / Claude Desktop (US-014.2, decision D15).
 * Sources: `~/.claude.json` (CC user scope `mcpServers`, and CC local scope
 * `projects[<workspaceRoot>].mcpServers`) and `~/.claude/claude_desktop_config.json`.
 * Relative rank against the Damocles-owned files is declared once, in `mcpSourceOrder`.
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
 * `source` and `readonly` can never disagree. The Claude and Codex files belong to other tools and are
 * imported read-only; `<ws>/.damocles/mcp.local.json` is Damocles-owned but has no write path, so it is
 * read-only too. Keyed by the full union, so adding a source without deciding its editability fails to
 * compile.
 */
const READONLY_BY_SOURCE: Record<McpServerSource, boolean> = {
  workspace: false,
  damocles: false,
  claude: true,
  codex: true,
  "claude-local": true,
  "damocles-local": true,
};

/**
 * Whether a source's file lives in the working tree, so a repository you clone could have authored it.
 * This, not scope, is what the workspace-trust gate tests: withholding `claude-local` would punish a
 * server the user configured in their own home directory because of a repo that had no hand in it.
 */
export const REPO_AUTHORED_BY_SOURCE: Record<McpServerSource, boolean> = {
  workspace: true,
  damocles: false,
  claude: false,
  codex: false,
  "claude-local": false,
  "damocles-local": true,
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

/** A parsed JSON config document, or null when there is nothing usable to read keys out of. */
interface JsonFileRead {
  document: Record<string, unknown> | null;
  error: McpConfigError | null;
}

/**
 * Read and parse one JSON config file. A missing file is not an error, because every source is
 * optional.
 * Anything else is reported rather than swallowed: a stray comma or a permission denial would
 * otherwise make every server in it disappear from the panel with no explanation anywhere.
 *
 * The OS message is not carried; only its `code` reaches the log and the webview gets `kind` alone.
 * Same ENOENT-only distinction `readDocument` makes on the write side.
 */
async function readJsonConfigFile(path: string): Promise<JsonFileRead> {
  let raw: string;
  try {
    raw = await fs.readFile(path, "utf-8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { document: null, error: null };
    log("[McpConfig] %s could not be read (%s); its servers were skipped", path, code ?? "unknown error");
    return { document: null, error: { path, displayPath: collapseHome(path), kind: "unreadable", line: null, column: null } };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    const { line, column } = locateJsonParseFailure(err, raw);
    const at = line === null ? "location unknown" : `line ${line}, column ${column}`;
    log("[McpConfig] %s could not be parsed (%s); its servers were skipped", path, at);
    return { document: null, error: { path, displayPath: collapseHome(path), kind: "parse", line, column } };
  }

  if (!parsed || typeof parsed !== "object") return { document: null, error: null };
  return { document: parsed as Record<string, unknown>, error: null };
}

/** Read the top-level `mcpServers` map of one `{ "mcpServers": {...} }` file. */
export async function readMcpConfigFile(path: string): Promise<McpFileRead> {
  const { document, error } = await readJsonConfigFile(path);
  return { servers: document ? coerceServerMap(document["mcpServers"]) : {}, error };
}

/** The personal per-project Damocles MCP file: gitignored, read-only, highest precedence. */
export function localMcpConfigPath(workspaceRoot: string): string {
  return join(workspaceRoot, ".damocles", "mcp.local.json");
}

/**
 * A path in the form `projects` is keyed by: resolved absolute, with one trailing separator removed,
 * and case-folded only on Windows, where the filesystem is case-insensitive and a drive letter may
 * legitimately differ in case between the two sides.
 */
function normalizeProjectKey(target: string): string {
  const resolved = resolve(target);
  return process.platform === "win32"
    ? stripTrailingSeparator(resolved).toLowerCase()
    : stripTrailingSeparator(resolved);
}

function stripTrailingSeparator(target: string): string {
  return target.length > 1 && target.endsWith(sep) ? target.slice(0, -1) : target;
}

/**
 * Claude Code's *local* scope inside an already-parsed `~/.claude.json`: the servers a plain
 * `claude mcp add` writes, which land under `projects[<workspaceRoot>].mcpServers` rather than at the
 * top level. Local is that command's default, so this is the most common way a Claude Code user has
 * servers configured.
 *
 * No `projects` key, or no key matching this workspace, is an ordinary absence rather than a reason to
 * guess a nearest match.
 *
 * Keys are indexed by their normalised form rather than scanned, so two Windows keys naming the same
 * directory in different case resolve to the last one written rather than to whichever the object
 * happened to list first.
 */
function claudeLocalScope(
  document: Record<string, unknown>,
  workspaceRoot: string,
): Record<string, McpServerConfig> {
  const projects = document["projects"];
  if (!isTable(projects)) return {};

  const byNormalizedKey = new Map<string, unknown>();
  for (const [key, project] of Object.entries(projects)) {
    byNormalizedKey.set(normalizeProjectKey(key), project);
  }

  const project = byNormalizedKey.get(normalizeProjectKey(workspaceRoot));
  return isTable(project) ? coerceServerMap(project["mcpServers"]) : {};
}

/** Both Claude Code MCP scopes, as read from one parse of `~/.claude.json`. */
export interface ClaudeMcpScopes {
  /** Claude Desktop, then the top level of `~/.claude.json`, which wins a name collision. */
  user: Record<string, McpServerConfig>;
  /** `projects[<workspaceRoot>]`, or empty with no workspace and on no matching key. */
  local: Record<string, McpServerConfig>;
}

/**
 * Read both Claude Code scopes together. `~/.claude.json` is where Claude Code accretes per-project
 * history and is routinely several megabytes, and `loadConfig` re-runs on every watcher event, so the
 * file is read and parsed exactly once per call and both scopes come off that one document.
 *
 * A `~/.claude.json` that fails to parse is logged by the reader and contributes nothing to either
 * scope; it is not surfaced on the panel, because it is another tool's file and theirs to fix.
 */
export async function readClaudeMcpScopes(workspaceRoot: string | undefined): Promise<ClaudeMcpScopes> {
  const [desktop, global] = await Promise.all([
    readMcpServersFromFile(CLAUDE_DESKTOP_CONFIG_PATH),
    readJsonConfigFile(CLAUDE_GLOBAL_CONFIG_PATH),
  ]);
  const document = global.document;
  return {
    user: { ...desktop, ...(document ? coerceServerMap(document["mcpServers"]) : {}) },
    local: document && workspaceRoot !== undefined ? claudeLocalScope(document, workspaceRoot) : {},
  };
}

async function readMcpServersFromFile(path: string): Promise<Record<string, McpServerConfig>> {
  return (await readMcpConfigFile(path)).servers;
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

/** Sort provenance-tagged batches into `mcpSourceOrder`, lowest precedence first, ready to fold. */
export function orderMcpSources(
  sources: readonly McpSourceServers[],
  precedence: AssetSourcePrecedence,
): McpSourceServers[] {
  const order = mcpSourceOrder(precedence);
  return [...sources].sort((a, b) => order.indexOf(a.source) - order.indexOf(b.source));
}

/**
 * The MCP sources that do not depend on workspace trust. `workspaceRoot` is needed for Claude Code's
 * local scope, which is keyed by project path inside the user-global `~/.claude.json`; with no folder
 * open there is no key to look up and that source contributes nothing. Each reader degrades to `{}` on
 * its own, so one unreadable ecosystem never costs you the others.
 *
 * The batches come back in no particular order. Ranking happens once, in the caller, which has to
 * place the two working-tree files among these anyway.
 */
export async function readGlobalMcpSources(
  workspaceRoot: string | undefined,
): Promise<GlobalMcpSources> {
  const [claude, codex, damocles] = await Promise.all([
    readClaudeMcpScopes(workspaceRoot),
    readCodexMcpServers(),
    readDamoclesMcpServers(),
  ]);
  return {
    sources: [
      { source: "claude", servers: claude.user },
      { source: "claude-local", servers: claude.local },
      { source: "codex", servers: codex },
      { source: "damocles", servers: damocles.servers },
    ],
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
