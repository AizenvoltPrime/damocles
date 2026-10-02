import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";
import { promises as fs } from "node:fs";
import { parse as parseToml, TomlError } from "smol-toml";
import { mcpServerNamespaceKey, mcpSourceOrder } from "../../../../shared/types/mcp";
import type {
  McpConfigError,
  McpHttpServerConfig,
  McpServerConfig,
  McpServerErrorInfo,
  McpServerSource,
  McpStdioServerConfig,
} from "../../../../shared/types/mcp";
import type { AssetSourcePrecedence } from "../../../asset-sources";
import type { McpServerEntry, McpServerEntryError, McpServerScope } from "../types";
import { validateMcpServerEntry } from "./mcp-config-validate";
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

/** The pi CLI's user MCP file, read-only. */
export const PI_MCP_CONFIG_PATH: string = join(homedir(), ".pi", "agent", "mcp.json");

/** The pi CLI's project MCP file, read-only and only in a trusted folder. */
export function piProjectMcpConfigPath(workspaceRoot: string): string {
  return join(workspaceRoot, ".pi", "mcp.json");
}

/** An entry that names a server but cannot be used; it still claims its name in the merge. */
export type McpInvalidServers = Record<string, McpServerEntryError>;

/** A provenance-tagged batch of servers, as handed to `mergeMcpEntries` in precedence order. */
export interface McpSourceServers {
  source: McpServerSource;
  servers: Record<string, McpServerConfig>;
  invalid: McpInvalidServers;
}

/** The user-scope sources, Claude Code's local scope per requested folder, and any Damocles file that failed to parse. */
export interface GlobalMcpSources {
  sources: McpSourceServers[];
  claudeLocal: ReadonlyMap<string, McpServerMap>;
  /** Not surfaced on the panel, but tells a caller the Claude local scope is unknown rather than empty. */
  claudeLocalUnreadable: boolean;
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
  pi: true,
  "pi-project": true,
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
  pi: false,
  "pi-project": true,
  "claude-local": false,
  "damocles-local": true,
};

/** `folder` sources are read once per open folder; `user` sources once per window. */
export const MCP_SCOPE_BY_SOURCE: Record<McpServerSource, McpServerScope> = {
  workspace: "folder",
  damocles: "user",
  claude: "user",
  codex: "user",
  pi: "user",
  "pi-project": "folder",
  "claude-local": "folder",
  "damocles-local": "folder",
};

/**
 * Which value rules a source's file follows. pi's files and Damocles' own follow pi's
 * `resolveConfigValue` (`!command`, `$VAR`, `${VAR}`); the other tools' formats keep `${VAR}` and
 * `$env:VAR` with a leading `!` literal.
 */
export const VALUE_FORMAT_BY_SOURCE: Record<McpServerSource, "pi" | "legacy"> = {
  workspace: "legacy",
  damocles: "pi",
  claude: "legacy",
  codex: "legacy",
  pi: "pi",
  "pi-project": "pi",
  "claude-local": "legacy",
  "damocles-local": "pi",
};

/** A raw `mcpServers` map split into usable configs and entries that name a server but cannot be used. */
export interface McpServerMap {
  servers: Record<string, McpServerConfig>;
  invalid: McpInvalidServers;
}

const UNEXPANDED_CWD_DETAIL = "cwd must not contain ${VAR} or $env:VAR, because this file's format does not expand variables in cwd";

/**
 * One source's servers, tagged. pi does not expand variables in `cwd`, so in a pi-format file an entry
 * whose `cwd` holds `${` or `$env:` fails, instead of spawning in a directory literally named that.
 */
export function sourceBatch(source: McpServerSource, map: McpServerMap): McpSourceServers {
  if (VALUE_FORMAT_BY_SOURCE[source] !== "pi") return { source, servers: map.servers, invalid: map.invalid };
  const servers: Record<string, McpServerConfig> = {};
  const invalid: McpInvalidServers = { ...map.invalid };
  for (const [name, config] of Object.entries(map.servers)) {
    if ("cwd" in config && typeof config.cwd === "string" && /\$\{|\$env:/.test(config.cwd)) {
      invalid[name] = { message: UNEXPANDED_CWD_DETAIL, errorInfo: { code: "invalidConfig", params: { detail: UNEXPANDED_CWD_DETAIL } } };
    } else {
      servers[name] = config;
    }
  }
  return { source, servers, invalid };
}

/**
 * Validate a raw `mcpServers` map. Non-object values (`$schema`, comments-as-keys) are not servers and
 * are skipped; every object is a server, kept when valid and reported when not, so a typo shows up as
 * a failed row instead of a server that silently vanished.
 *
 * Valid configs are returned **UNCHANGED, never normalised**: `editableConfig` (`mcp-manager.toStatusInfo`)
 * asks `isFormEditableMcpServerConfig` about this exact object, so stripping a key here would make a
 * config the edit form cannot represent, and would silently destroy on save, look editable. Pinned by
 * `__tests__/mcp-manager-editable-config.test.ts`.
 */
export function coerceServerMap(raw: unknown): McpServerMap {
  const map: McpServerMap = { servers: {}, invalid: {} };
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return map;
  for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const validation = validateMcpServerEntry(value as Record<string, unknown>);
    if (validation.ok) map.servers[name] = validation.config;
    else map.invalid[name] = { message: validation.error, errorInfo: validation.errorInfo };
  }
  return map;
}

/** The outcome of reading one `{ "mcpServers": {...} }` file. */
export interface McpFileRead extends McpServerMap {
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
  return { ...coerceServerMap(document ? document["mcpServers"] : undefined), error };
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
function claudeLocalScopes(
  document: Record<string, unknown>,
  workspaceRoots: readonly string[],
): Map<string, McpServerMap> {
  const projects = document["projects"];
  const byNormalizedKey = new Map<string, unknown>();
  if (isTable(projects)) {
    for (const [key, project] of Object.entries(projects)) {
      byNormalizedKey.set(normalizeProjectKey(key), project);
    }
  }

  return new Map(workspaceRoots.map(root => {
    const project = byNormalizedKey.get(normalizeProjectKey(root));
    return [root, coerceServerMap(isTable(project) ? project["mcpServers"] : undefined)];
  }));
}

/** Both Claude Code MCP scopes, as read from one parse of `~/.claude.json`. */
export interface ClaudeMcpScopes {
  /** Claude Desktop, then the top level of `~/.claude.json`, which wins a name collision. */
  user: McpServerMap;
  /** `projects[<root>]` for every requested root, keyed by the root as passed; empty on no matching key. */
  local: ReadonlyMap<string, McpServerMap>;
  /** `~/.claude.json` exists but could not be read or parsed, so `local` is empty for lack of data. */
  localUnreadable: boolean;
}

/**
 * Read both Claude Code scopes together. `~/.claude.json` is where Claude Code accretes per-project
 * history and is routinely several megabytes, and `loadConfig` re-runs on every watcher event, so the
 * file is read and parsed exactly once per call and every folder's local scope comes off that one
 * document.
 *
 * A `~/.claude.json` that fails to parse is logged by the reader and contributes nothing to either
 * scope; it is not surfaced on the panel, because it is another tool's file and theirs to fix.
 */
export async function readClaudeMcpScopes(workspaceRoots: readonly string[]): Promise<ClaudeMcpScopes> {
  const [desktop, global] = await Promise.all([
    readMcpConfigFile(CLAUDE_DESKTOP_CONFIG_PATH),
    readJsonConfigFile(CLAUDE_GLOBAL_CONFIG_PATH),
  ]);
  const document = global.document;
  const top = coerceServerMap(document ? document["mcpServers"] : undefined);
  return {
    user: overlayServerMaps(desktop, top),
    local: document ? claudeLocalScopes(document, workspaceRoots) : new Map(workspaceRoots.map(root => [root, coerceServerMap(undefined)])),
    localUnreadable: global.error !== null,
  };
}

/** `above` wins every name it claims, valid or not. */
function overlayServerMaps(below: McpServerMap, above: McpServerMap): McpServerMap {
  const claimed = new Set([...Object.keys(above.servers), ...Object.keys(above.invalid)]);
  const keep = <T>(record: Record<string, T>): Record<string, T> =>
    Object.fromEntries(Object.entries(record).filter(([name]) => !claimed.has(name)));
  return {
    servers: { ...keep(below.servers), ...above.servers },
    invalid: { ...keep(below.invalid), ...above.invalid },
  };
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
 * The final `coerceServerMap()` runs the same validator as every other source, so the spawn chokepoint
 * has one validation path regardless of which reader fed it.
 */
export async function readCodexMcpServers(): Promise<McpServerMap> {
  const none = coerceServerMap(undefined);
  let text: string;
  try {
    text = await fs.readFile(CODEX_CONFIG_PATH, "utf-8");
  } catch {
    return none;
  }

  let parsed: unknown;
  try {
    parsed = parseToml(text);
  } catch (err) {
    // Position only, never the parser's message: a TOML error quotes the offending source line, which
    // can be the very line holding a credential, and this channel is written to disk.
    const where = err instanceof TomlError ? `line ${err.line}, column ${err.column}` : "an unknown position";
    log("[McpImport] ~/.codex/config.toml is not valid TOML (%s); no Codex MCP servers loaded", where);
    return none;
  }

  if (!isTable(parsed)) return none;
  const table = parsed["mcp_servers"];
  if (!isTable(table)) return none;

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
 * The MCP sources that live in the user's home directory. Claude Code's local scope is keyed by
 * project path inside `~/.claude.json`, so it is returned per requested root rather than as a batch;
 * with no folder open there is no key to look up. Each reader degrades to `{}` on its own, so one
 * unreadable ecosystem never costs you the others.
 *
 * The batches come back in no particular order. Ranking happens once, in the caller, which has to
 * place each folder's files among these anyway.
 */
export async function readGlobalMcpSources(
  workspaceRoots: readonly string[],
): Promise<GlobalMcpSources> {
  const [claude, codex, pi, damocles] = await Promise.all([
    readClaudeMcpScopes(workspaceRoots),
    readCodexMcpServers(),
    readMcpConfigFile(PI_MCP_CONFIG_PATH),
    readDamoclesMcpServers(),
  ]);
  return {
    sources: [
      { source: "claude", ...claude.user },
      { source: "codex", ...codex },
      sourceBatch("pi", pi),
      sourceBatch("damocles", damocles),
    ],
    claudeLocal: claude.local,
    claudeLocalUnreadable: claude.localUnreadable,
    // Only the file Damocles owns is surfaced. The Claude, Codex and pi imports are other tools' files:
    // a parse failure there is logged, but is theirs to fix and not worth a notice in this panel.
    errors: damocles.error ? [damocles.error] : [],
  };
}

/** Names disabled per scope: user-scope entries read `user`, folder-scope entries read `folder`. */
export interface McpDisabledNames {
  user: ReadonlySet<string>;
  folder: ReadonlySet<string>;
}

interface FoldedEntry {
  entry: McpServerEntry;
  /** Index of the batch the entry came from; a higher rank outranks a lower one. */
  rank: number;
  /** Position in its batch: valid entries in file order, then invalid ones in file order. */
  index: number;
}

/**
 * Fold provenance-tagged server maps into the entry list, lowest precedence FIRST: a later source
 * overwrites an earlier one on a name collision, so precedence reads off the caller's array order.
 * An invalid entry claims its name like a valid one. Names that differ but share a namespace key
 * (`mcpServerNamespaceKey`) are one server: the highest-ranked keeps it (on a tie within one file, a
 * valid entry before an invalid one, then the first in the file) and the rest become failed
 * `nameCollision` rows.
 *
 * `readonly` and `scope` come from the source. An entry is enabled unless its scope's disabled list
 * names it; a config `enabled: false` also disables it unless its scope's `enabledOverride` names it.
 */
export function mergeMcpEntries(
  sources: readonly McpSourceServers[],
  disabled: McpDisabledNames,
  enabledOverride: McpDisabledNames,
): McpServerEntry[] {
  const merged = new Map<string, FoldedEntry>();
  sources.forEach(({ source, servers, invalid }, rank) => {
    const scope = MCP_SCOPE_BY_SOURCE[source];
    const base = { source, scope, readonly: READONLY_BY_SOURCE[source] };
    let index = 0;
    for (const [name, config] of Object.entries(servers)) {
      const enabled = !disabled[scope].has(name) && (config.enabled !== false || enabledOverride[scope].has(name));
      merged.set(name, { entry: { name, config, enabled, ...base }, rank, index: index++ });
    }
    for (const [name, error] of Object.entries(invalid)) {
      merged.set(name, { entry: { name, config: null, error, enabled: !disabled[scope].has(name), ...base }, rank, index: index++ });
    }
  });

  const owners = new Map<string, FoldedEntry>();
  for (const folded of merged.values()) {
    const key = mcpServerNamespaceKey(folded.entry.name);
    const owner = owners.get(key);
    if (!owner || folded.rank > owner.rank || (folded.rank === owner.rank && folded.index < owner.index)) owners.set(key, folded);
  }
  return [...merged.values()].map(({ entry }) => {
    const owner = owners.get(mcpServerNamespaceKey(entry.name))!.entry;
    if (owner === entry) return entry;
    const errorInfo: McpServerErrorInfo = { code: "nameCollision", params: { kept: owner.name, keptSource: owner.source } };
    const message = `"${entry.name}" and "${owner.name}" name the same tools; only "${owner.name}" from ${owner.source} is loaded`;
    return { ...entry, error: { message, errorInfo } };
  });
}
