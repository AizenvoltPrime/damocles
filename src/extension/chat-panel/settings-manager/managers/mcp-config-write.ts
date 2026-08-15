import { dirname } from "node:path";
import { promises as fs } from "node:fs";
import type { McpServerConfig, McpWriteErrorCode, McpWriteErrorInfo } from "../../../../shared/types/mcp";
import { DAMOCLES_MCP_CONFIG_PATH } from "./mcp-config-import";
import { queueSettingsWrite } from "../utils";
import { assertValidMcpServerConfig, assertValidMcpServerName } from "./mcp-config-validate";
import { log } from "../../../logger";

/**
 * The write side of `~/.damocles/mcp.json` — the ONLY MCP file Damocles ever writes. The workspace
 * `.mcp.json` belongs to the project and `~/.claude*` / `~/.codex/config.toml` belong to other tools;
 * all three are read-only imports (`mcp-config-import.ts`) and nothing here may touch them.
 *
 * Deliberately a sibling of `mcp-config-import.ts` rather than part of it: that module is scoped by
 * name and header comment to read-only import, and coupling it to the settings write queue would make
 * "import" a lie. It exports only the path constant, which is imported here.
 *
 * Every mutation is a read-modify-write performed INSIDE one `queueSettingsWrite` critical section.
 * Reading outside the queue would reintroduce the interleaving race the queue exists to prevent: two
 * rapid edits would both read the pre-edit map and the second would erase the first.
 */

/** A parsed `~/.damocles/mcp.json`, keeping every top-level key the user put there. */
interface DamoclesMcpDocument {
  /** The whole document, so unknown top-level keys (`$schema`, comments-as-keys, …) survive. */
  root: Record<string, unknown>;
  /** The `mcpServers` map, mutated in place and written back under that key. */
  servers: Record<string, McpServerConfig>;
}

/**
 * A refused write, carrying a code the webview translates instead of an English sentence. The message
 * stays human-readable for the output channel; `info` is what crosses to the panel.
 */
export class McpWriteError extends Error {
  readonly info: McpWriteErrorInfo;

  constructor(code: McpWriteErrorCode, message: string, params?: Record<string, string>) {
    super(message);
    this.name = "McpWriteError";
    this.info = params ? { code, params } : { code };
  }
}

/** Run a validator, re-labelling its English message as `invalidDefinition` detail. */
function asInvalidDefinition(assert: () => void): void {
  try {
    assert();
  } catch (err) {
    throw new McpWriteError("invalidDefinition", err instanceof Error ? err.message : "invalid definition", {
      detail: err instanceof Error ? err.message : "invalid definition",
    });
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/**
 * A missing file is zero servers, exactly as every reader treats it — the file is created on first
 * write. Anything else (unreadable, unparseable, wrong shape) THROWS: overwriting a file we could not
 * understand would destroy hand-authored JSON, so the write is abandoned and the handler surfaces the
 * failure instead. The parser's message is never included — it quotes the offending source line, which
 * may be the very line holding a credential, and this text reaches the panel and the output channel.
 */
async function readDocument(): Promise<DamoclesMcpDocument> {
  let text: string;
  try {
    text = await fs.readFile(DAMOCLES_MCP_CONFIG_PATH, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { root: {}, servers: {} };
    throw new McpWriteError("fileUnreadable", `~/.damocles/mcp.json could not be read (${(err as NodeJS.ErrnoException).code ?? "unknown error"})`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new McpWriteError("fileUnparseable", "~/.damocles/mcp.json is not valid JSON; fix the file by hand and try again");
  }
  if (!isPlainObject(parsed)) {
    throw new McpWriteError("fileNotObject", "~/.damocles/mcp.json must contain a JSON object; fix the file by hand and try again");
  }

  const existing = parsed["mcpServers"];
  if (existing !== undefined && !isPlainObject(existing)) {
    throw new McpWriteError("fileServersNotObject", '~/.damocles/mcp.json has an "mcpServers" key that is not an object; fix the file by hand and try again');
  }
  // Carried through as-is rather than via `coerceServerMap()`, which DROPS entries it does not
  // recognise — right for the spawn chokepoint, wrong here: it would delete a server mid-hand-edit.
  //
  // Re-homed onto a null prototype so `servers[name] = …` means what it says: against a normal object
  // "__proto__" hits the setter, mutating the prototype while `JSON.stringify` drops the key — the
  // save reports success having written nothing. Server names are JSON keys, so that is reachable.
  const servers: Record<string, McpServerConfig> = Object.assign(Object.create(null), existing ?? {});
  return { root: parsed, servers };
}

/**
 * Apply `mutate` to the `mcpServers` map of `~/.damocles/mcp.json` and write the result back,
 * preserving every other top-level key. `mutate` throwing abandons the write with the file untouched,
 * which is how the collision rules reject inside the critical section.
 */
async function writeDamoclesMcpServers(
  mutate: (servers: Record<string, McpServerConfig>) => void,
): Promise<void> {
  await queueSettingsWrite(DAMOCLES_MCP_CONFIG_PATH, async () => {
    const { root, servers } = await readDocument();
    mutate(servers);
    root["mcpServers"] = servers;

    await fs.mkdir(dirname(DAMOCLES_MCP_CONFIG_PATH), { recursive: true, mode: 0o700 });
    // Sibling + rename, because `writeFile` truncates first: a crash in that window leaves a
    // zero-length mcp.json that parses as nothing and takes every Damocles-owned server with it —
    // and `McpManager` watches this file, so that state would reach the live client. `rename` within
    // one directory is atomic. 0600 because `env`/`headers` values are the usual home for a token.
    const tempPath = `${DAMOCLES_MCP_CONFIG_PATH}.${process.pid}.tmp`;
    try {
      await fs.writeFile(tempPath, `${JSON.stringify(root, null, 2)}\n`, { encoding: "utf-8", mode: 0o600 });
      await fs.rename(tempPath, DAMOCLES_MCP_CONFIG_PATH);
    } catch (err) {
      await fs.rm(tempPath, { force: true }).catch(() => {});
      throw new McpWriteError("writeFailed", `~/.damocles/mcp.json could not be written (${(err as NodeJS.ErrnoException).code ?? "unknown error"})`);
    }
    // Names and counts only. A config object, an `env` map or a `headers` map must never reach this
    // channel — it is written to disk, and Damocles has a prior incident of a credential landing there
    // through `%O` inspection.
    log("[McpConfigWrite] Wrote %d MCP server(s) to ~/.damocles/mcp.json", Object.keys(servers).length);
  });
}

/**
 * Names defined by the workspace `.mcp.json`. That source outranks `~/.damocles/mcp.json` at merge
 * time, so writing one of these names would succeed on disk and then be invisible in the panel.
 * Rejecting is the honest outcome; silently writing a server the user cannot see is not.
 *
 * Names owned by `claude`/`codex` are deliberately NOT in scope here: `damocles` outranks both, so
 * overriding an imported server is the intended path and the entry is visibly re-tagged `damocles`.
 */
function assertNotShadowedByWorkspace(name: string, workspaceServerNames: ReadonlySet<string>): void {
  if (workspaceServerNames.has(name)) {
    throw new McpWriteError("nameShadowed", `"${name}" is already defined by this project's .mcp.json, which takes precedence, so the server would never be used`, { name });
  }
}

export async function addDamoclesMcpServer(
  name: string,
  config: McpServerConfig,
  workspaceServerNames: ReadonlySet<string>,
): Promise<void> {
  asInvalidDefinition(() => { assertValidMcpServerName(name); assertValidMcpServerConfig(config); });
  assertNotShadowedByWorkspace(name, workspaceServerNames);

  await writeDamoclesMcpServers(servers => {
    if (Object.hasOwn(servers, name)) throw new McpWriteError("nameExists", `"${name}" already exists in ~/.damocles/mcp.json`, { name });
    servers[name] = config;
  });
}

/**
 * Edit a server, optionally renaming it. A rename is ONE write: the old key is removed and the new key
 * inserted inside the same critical section, so the file is never observably left with both entries or
 * with neither.
 */
export async function updateDamoclesMcpServer(
  name: string,
  newName: string | undefined,
  config: McpServerConfig,
  workspaceServerNames: ReadonlySet<string>,
): Promise<void> {
  asInvalidDefinition(() => assertValidMcpServerConfig(config));

  // Only the name being WRITTEN is checked against the naming rules. `name` identifies a key that is
  // already in the file, and nothing on the import path imposes these rules — a hand-authored
  // `"my server"` is a perfectly real entry the panel offers Edit and Delete for. Validating it here
  // would reject both, leaving the user with a server they can see and cannot remove. Ownership is
  // what actually needs enforcing, and the `hasOwn` check inside the critical section does that.
  const targetName = newName ?? name;
  asInvalidDefinition(() => assertValidMcpServerName(targetName));
  if (targetName !== name) {
    assertNotShadowedByWorkspace(targetName, workspaceServerNames);
  }

  await writeDamoclesMcpServers(servers => {
    // The backstop behind the panel's `readonly` gate: Damocles can only mutate what it owns, so an
    // imported or workspace server can never be edited through this path even if the UI let it try.
    if (!Object.hasOwn(servers, name)) throw new McpWriteError("nameMissing", `"${name}" is not defined in ~/.damocles/mcp.json, so Damocles cannot edit it`, { name });
    if (targetName !== name && Object.hasOwn(servers, targetName)) {
      throw new McpWriteError("nameExists", `"${targetName}" already exists in ~/.damocles/mcp.json`, { name: targetName });
    }
    // Only a rename removes a key. An in-place edit assigns over the existing one, which keeps the
    // server where the user put it in the file instead of migrating it to the bottom on every save.
    if (targetName !== name) delete servers[name];
    servers[targetName] = config;
  });
}

/**
 * Remove a server. The name is deliberately NOT run through `assertValidMcpServerName` — see
 * `updateDamoclesMcpServer`: it names an existing key, and a hand-authored one need not satisfy rules
 * that only govern what the form writes. Being unable to delete such a server is the worse outcome.
 */
export async function deleteDamoclesMcpServer(name: string): Promise<void> {
  await writeDamoclesMcpServers(servers => {
    if (!Object.hasOwn(servers, name)) throw new McpWriteError("nameMissing", `"${name}" is not defined in ~/.damocles/mcp.json, so Damocles cannot remove it`, { name });
    delete servers[name];
  });
}
