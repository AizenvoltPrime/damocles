import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// The readers hit `node:fs` and the Codex parse failure hits the output channel; both are faked so a
// test never depends on what happens to be in the developer's home directory.
const readFileMock = vi.hoisted(() => vi.fn());
const logMock = vi.hoisted(() => vi.fn());
vi.mock("node:fs", () => ({ promises: { readFile: readFileMock } }));
vi.mock("../../../../logger", () => ({ log: logMock }));

import { join, resolve, sep } from "node:path";
import {
  mergeMcpEntries,
  coerceServerMap,
  localMcpConfigPath,
  orderMcpSources,
  readClaudeMcpScopes,
  readCodexMcpServers,
  readDamoclesMcpServers,
  readGlobalMcpSources,
  readMcpConfigFile,
  DAMOCLES_MCP_CONFIG_PATH,
  mcpSourceOrder,
  REPO_AUTHORED_BY_SOURCE,
  MCP_SCOPE_BY_SOURCE,
  PI_MCP_CONFIG_PATH,
  VALUE_FORMAT_BY_SOURCE,
  piProjectMcpConfigPath,
  type GlobalMcpSources,
  type McpSourceServers,
} from "../mcp-config-import";
import { SHADOWING_SOURCES } from "../../../../../shared/types/mcp";
import type { AssetSourcePrecedence } from "../../../../asset-sources";
import type {
  McpServerConfig,
  McpServerSource,
  McpStdioServerConfig,
  McpHttpServerConfig,
} from "../../../../../shared/types/mcp";

/** Path suffix (forward-slashed) → file contents. Anything unset reads as ENOENT. */
const files = new Map<string, string>();

const CLAUDE_GLOBAL = ".claude.json";
const CLAUDE_DESKTOP = ".claude/claude_desktop_config.json";
const DAMOCLES_MCP = ".damocles/mcp.json";
const CODEX_TOML = ".codex/config.toml";
const PI_MCP = ".pi/agent/mcp.json";

/**
 * A resolved, platform-native workspace root. `resolve` rather than a literal, because
 * `readClaudeMcpScopes` matches `projects` keys after resolving them and a bare `/ws/project`
 * would never match on Windows.
 */
const WS_ROOT = resolve(join(sep, "ws", "project"));
const OTHER_WS_ROOT = resolve(join(sep, "ws", "other-project"));

/** The two workspace files, keyed by full forward-slashed path so no home suffix can shadow them. */
const forwardSlashed = (target: string): string => target.replace(/\\/g, "/");
const WS_MCP = forwardSlashed(join(WS_ROOT, ".mcp.json"));
const WS_LOCAL_MCP = forwardSlashed(localMcpConfigPath(WS_ROOT));
const WS_PI_MCP = forwardSlashed(piProjectMcpConfigPath(WS_ROOT));

beforeEach(() => {
  files.clear();
  logMock.mockClear();
  readFileMock.mockImplementation(async (target: unknown) => {
    const key = String(target).replace(/\\/g, "/");
    for (const [suffix, content] of files) {
      if (key.endsWith(suffix)) return content;
    }
    const err = new Error("ENOENT: no such file or directory") as NodeJS.ErrnoException;
    err.code = "ENOENT";
    throw err;
  });
});

const NONE_DISABLED = { user: new Set<string>(), folder: new Set<string>() };

/** A source batch as a fixture writes it; `invalid` defaults to none. */
type SourceFixture = Omit<McpSourceServers, "invalid"> & { invalid?: McpSourceServers["invalid"] };

/** `mergeMcpEntries` over fixtures, with no config-disabled server re-enabled unless `enabledOverride` says so. */
function merge(sources: readonly SourceFixture[], disabled = NONE_DISABLED, enabledOverride = NONE_DISABLED) {
  return mergeMcpEntries(sources.map((source) => ({ ...source, invalid: source.invalid ?? {} })), disabled, enabledOverride);
}

/** The user batches plus `root`'s Claude local scope, as `loadConfig` assembles them for one folder. */
function withClaudeLocal(global: GlobalMcpSources, root: string): McpSourceServers[] {
  return [...global.sources, { source: "claude-local", ...global.claudeLocal.get(root)! }];
}

/** The single Codex server the TOML fixture defines, or undefined if it was skipped. */
async function codexServer(toml: string, name = "docs"): Promise<McpServerConfig | undefined> {
  files.set(CODEX_TOML, toml);
  return (await readCodexMcpServers()).servers[name];
}

const ws: Record<string, McpServerConfig> = {
  shared: { command: "workspace-cmd" },
  wsOnly: { command: "ws-only" },
};
const imported: Record<string, McpServerConfig> = {
  shared: { command: "claude-cmd" },
  ccOnly: { command: "cc-only" },
};

/** The pre-existing two-source shape, expressed in the ordered-source form (imports low, workspace high). */
const twoSources: SourceFixture[] = [
  { source: "claude", servers: imported },
  { source: "workspace", servers: ws },
];

describe("mergeMcpEntries", () => {
  it("lets the last source in the list win on a name collision and tags provenance", () => {
    const entries = merge(twoSources, NONE_DISABLED);
    const shared = entries.find(e => e.name === "shared");
    expect((shared?.config as McpStdioServerConfig).command).toBe("workspace-cmd");
    expect(shared?.source).toBe("workspace");
    expect(shared?.readonly).toBe(false);
  });

  it("flags imported-only entries as readonly claude imports", () => {
    const entries = merge(twoSources, NONE_DISABLED);
    const ccOnly = entries.find(e => e.name === "ccOnly");
    expect(ccOnly?.source).toBe("claude");
    expect(ccOnly?.readonly).toBe(true);
  });

  it("applies each scope's disabled list to the entries of that scope", () => {
    const entries = merge(twoSources, { user: new Set(["ccOnly"]), folder: new Set(["wsOnly"]) });
    const byName = Object.fromEntries(entries.map(e => [e.name, e.enabled]));
    expect(byName["wsOnly"]).toBe(false);
    expect(byName["ccOnly"]).toBe(false);
    expect(byName["shared"]).toBe(true);
  });

  it("does not let one scope's list disable a same-named entry of the other scope", () => {
    // `shared` resolves to the workspace (folder-scope) entry, so only the folder list can switch it off.
    const userListed = merge(twoSources, { user: new Set(["shared"]), folder: new Set() });
    expect(userListed.find(e => e.name === "shared")?.enabled).toBe(true);

    const folderListed = merge(twoSources, { user: new Set(), folder: new Set(["ccOnly"]) });
    expect(folderListed.find(e => e.name === "ccOnly")?.enabled).toBe(true);
  });

  it("tags every entry with the scope of the source it came from", () => {
    const entries = merge(twoSources, NONE_DISABLED);
    expect(Object.fromEntries(entries.map(e => [e.name, e.scope]))).toEqual({ shared: "folder", wsOnly: "folder", ccOnly: "user" });
  });

  it("includes every distinct server exactly once", () => {
    const entries = merge(twoSources, NONE_DISABLED);
    const names = entries.map(e => e.name).sort();
    expect(names).toEqual(["ccOnly", "shared", "wsOnly"]);
  });

  it("yields ONE entry per name however many sources define it", () => {
    // Consumers look a name up with `find`, which returns the first match and cannot see a second.
    // The webview's collision check is one of them, and it reads `untrusted` off whatever it finds,
    // so a duplicate would let an untrusted workspace row answer for a same-named damocles row.
    const everySource = mcpSourceOrder("claude");
    const entries = merge(
      everySource.map(source => ({ source, servers: { contested: { command: source } } })),
      NONE_DISABLED,
    );

    expect(entries.filter(e => e.name === "contested")).toHaveLength(1);
    expect(entries.map(e => e.name)).toEqual(["contested"]);
    // The survivor is the last source folded, which is the highest ranked.
    expect(entries[0]!.source).toBe(everySource[everySource.length - 1]);
  });

  it("derives readonly from source alone, across every source in the union", () => {
    // `damocles-local` is readonly despite being a Damocles-owned file: there is no write path to
    // `<ws>/.damocles/mcp.local.json`, so offering Edit would produce a save with nowhere to land.
    const everySource = mcpSourceOrder("claude");
    const entries = merge(
      everySource.map(source => ({ source, servers: { [source]: { command: "x" } } })),
      NONE_DISABLED,
    );
    const readonlyBySource = Object.fromEntries(entries.map(e => [e.source, e.readonly]));
    expect(readonlyBySource).toEqual({
      codex: true,
      claude: true,
      pi: true,
      "pi-project": true,
      "claude-local": true,
      damocles: false,
      workspace: false,
      "damocles-local": true,
    });
  });
});

describe("the claude user scope (unchanged by the ordered-source fold)", () => {
  it("folds both Claude files into the single claude source, with the CC global winning", async () => {
    files.set(CLAUDE_DESKTOP, JSON.stringify({ mcpServers: { shared: { command: "desktop" }, dt: { command: "d" } } }));
    files.set(CLAUDE_GLOBAL, JSON.stringify({ mcpServers: { shared: { command: "global" } } }));

    const claude = (await readGlobalMcpSources([])).sources.find(s => s.source === "claude");
    expect((claude?.servers["shared"] as McpStdioServerConfig).command).toBe("global");
    expect(Object.keys(claude?.servers ?? {}).sort()).toEqual(["dt", "shared"]);
  });
});

describe("readDamoclesMcpServers (~/.damocles/mcp.json)", () => {
  it("reads the same `mcpServers` shape as a workspace .mcp.json", async () => {
    files.set(DAMOCLES_MCP, JSON.stringify({ mcpServers: { dm: { command: "dm-cmd" } }, $schema: "x" }));
    const { servers, error } = await readDamoclesMcpServers();
    expect((servers["dm"] as McpStdioServerConfig).command).toBe("dm-cmd");
    expect(Object.keys(servers)).toEqual(["dm"]);
    expect(error).toBeNull();
  });

  it("yields an empty map when the file is absent", async () => {
    expect(await readDamoclesMcpServers()).toEqual({ servers: {}, invalid: {}, error: null });
  });

  it("reports a file that exists but does not parse, instead of dropping its servers silently", async () => {
    // A trailing comma — the mistake a hand-edit actually makes. Every server in the file disappears,
    // so the panel has to be able to say why.
    files.set(DAMOCLES_MCP, '{\n  "mcpServers": { "dm": { "command": "dm-cmd" } },\n  "$schema": "test",\n}');

    const { servers, error } = await readDamoclesMcpServers();

    expect(servers).toEqual({});
    expect(error?.path).toBe(DAMOCLES_MCP_CONFIG_PATH);
    expect(error?.line).toBe(4);
    expect(error?.column).toBe(1);
  });

  it("never puts file content in the reported location or the log", async () => {
    // An unquoted value — forgetting the quotes round a secret is an ordinary hand-edit slip, and it is
    // the case where V8 embeds a window of the source in its message:
    //   Unexpected token 's', ..."":{"TOKEN":sk-SUPERSE"... is not valid JSON
    // That window reaches both the disk-backed output channel and the webview, so only the location may
    // ever be carried across. Verified against V8's real output, not assumed.
    files.set(DAMOCLES_MCP, '{"mcpServers":{"s":{"command":"x","env":{"TOKEN":sk-SUPERSECRET}}}}');

    const { servers, error } = await readDamoclesMcpServers();

    expect(servers).toEqual({});
    expect(error?.path).toBe(DAMOCLES_MCP_CONFIG_PATH);
    // V8 gives no line/column for this form, so there is no location to report and none is invented.
    expect(error?.line).toBeNull();
    expect(error?.column).toBeNull();
    expect(logMock.mock.calls.flat().join(" ")).not.toContain("SUPERSECRET");
  });

  it("surfaces the failure through readGlobalMcpSources while the other ecosystems still load", async () => {
    files.set(DAMOCLES_MCP, "{ not json");
    files.set(CLAUDE_GLOBAL, JSON.stringify({ mcpServers: { cl: { command: "cl-cmd" } } }));

    const { sources, errors } = await readGlobalMcpSources([WS_ROOT]);

    expect(errors).toHaveLength(1);
    expect(errors[0]!.path).toBe(DAMOCLES_MCP_CONFIG_PATH);
    expect(sources.find(s => s.source === "claude")?.servers["cl"]).toBeDefined();
  });

  it("reports nothing when every file is readable", async () => {
    files.set(DAMOCLES_MCP, JSON.stringify({ mcpServers: { dm: { command: "dm-cmd" } } }));
    expect((await readGlobalMcpSources([WS_ROOT])).errors).toEqual([]);
  });
});

describe("readCodexMcpServers (~/.codex/config.toml)", () => {
  it("maps command and args, including a quoted Windows path", async () => {
    const config = (await codexServer(String.raw`
[mcp_servers.docs]
command = "C:\\Program Files\\nodejs\\node.exe"
args = ["server.js", "--stdio"]
`)) as McpStdioServerConfig;
    expect(config.command).toBe(String.raw`C:\Program Files\nodejs\node.exe`);
    expect(config.args).toEqual(["server.js", "--stdio"]);
  });

  it("maps a nested [mcp_servers.<name>.env] table onto env", async () => {
    const config = (await codexServer(String.raw`
[mcp_servers.docs]
command = "node"

[mcp_servers.docs.env]
DOCS_ROOT = "/srv/docs"
LOG_LEVEL = "debug"
`)) as McpStdioServerConfig;
    expect(config.env).toEqual({ DOCS_ROOT: "/srv/docs", LOG_LEVEL: "debug" });
  });

  it("maps an inline env table onto env", async () => {
    const config = (await codexServer(String.raw`
[mcp_servers.docs]
command = "node"
env = { DOCS_ROOT = "/srv/docs" }
`)) as McpStdioServerConfig;
    expect(config.env).toEqual({ DOCS_ROOT: "/srv/docs" });
  });

  it("forwards env_vars as a ${NAME} reference, never the resolved secret", async () => {
    process.env["DAMOCLES_TEST_FORWARDED"] = "forwarded-value";
    try {
      const config = (await codexServer(String.raw`
[mcp_servers.docs]
command = "node"
env_vars = ["DAMOCLES_TEST_FORWARDED", "DAMOCLES_TEST_DEFINITELY_UNSET"]
`)) as McpStdioServerConfig;
      // `env_vars` is where a Codex user puts OPENAI_API_KEY. Resolving it here would park a live
      // token in McpManager.entries for the window's lifetime; `interpolateEnvVars` resolves the
      // reference at spawn time instead.
      expect(config.env).toEqual({ DAMOCLES_TEST_FORWARDED: "${DAMOCLES_TEST_FORWARDED}" });
      expect(JSON.stringify(config)).not.toContain("forwarded-value");
      // A forwarded name the process does not define is still not added — no empty-string placeholder.
      expect(config.env).not.toHaveProperty("DAMOCLES_TEST_DEFINITELY_UNSET");
    } finally {
      delete process.env["DAMOCLES_TEST_FORWARDED"];
    }
  });

  it("keeps env_vars and env distinct, with the explicit env value winning", async () => {
    process.env["DAMOCLES_TEST_BOTH"] = "from-process";
    try {
      const config = (await codexServer(String.raw`
[mcp_servers.docs]
command = "node"
env_vars = ["DAMOCLES_TEST_BOTH"]

[mcp_servers.docs.env]
DAMOCLES_TEST_BOTH = "from-config"
`)) as McpStdioServerConfig;
      expect(config.env).toEqual({ DAMOCLES_TEST_BOTH: "from-config" });
    } finally {
      delete process.env["DAMOCLES_TEST_BOTH"];
    }
  });

  it("maps url onto a config carrying the explicit http discriminant", async () => {
    const config = (await codexServer(String.raw`
[mcp_servers.docs]
url = "https://docs.example.com/mcp"
`)) as McpHttpServerConfig;
    expect(config.url).toBe("https://docs.example.com/mcp");
    expect(config.type).toBe("http");
  });

  it("maps bearer_token_env_var to the variable NAME and never materialises the token", async () => {
    process.env["DAMOCLES_TEST_TOKEN"] = "sk-super-secret-value";
    try {
      files.set(
        CODEX_TOML,
        String.raw`
[mcp_servers.docs]
url = "https://docs.example.com/mcp"
bearer_token_env_var = "DAMOCLES_TEST_TOKEN"
`,
      );
      const { servers } = await readCodexMcpServers();
      const config = servers["docs"] as McpHttpServerConfig;
      expect(config.bearerTokenEnv).toBe("DAMOCLES_TEST_TOKEN");
      expect(config.bearerToken).toBeUndefined();
      expect(JSON.stringify(servers)).not.toContain("sk-super-secret-value");
    } finally {
      delete process.env["DAMOCLES_TEST_TOKEN"];
    }
  });

  it("skips a server the user disabled in Codex with the literal boolean false", async () => {
    files.set(
      CODEX_TOML,
      String.raw`
[mcp_servers.off]
command = "node"
enabled = false

[mcp_servers.on]
command = "node"
enabled = true

[mcp_servers.unspecified]
command = "node"
`,
    );
    // Absent means enabled; only `enabled = false` removes a server.
    expect(Object.keys((await readCodexMcpServers()).servers).sort()).toEqual(["on", "unspecified"]);
  });

  it("drops Codex-only keys rather than passing them through to the runtime", async () => {
    const config = (await codexServer(String.raw`
[mcp_servers.docs]
command = "node"
startup_timeout_sec = 30
tool_timeout_sec = 120
description = "not a Damocles field"
`)) as McpStdioServerConfig;
    expect(config).toEqual({ command: "node" });
    expect(config).not.toHaveProperty("startup_timeout_sec");
    expect(config).not.toHaveProperty("tool_timeout_sec");
  });

  it("drops an entry with neither command nor url", async () => {
    files.set(CODEX_TOML, String.raw`
[mcp_servers.junk]
description = "nothing spawnable here"
`);
    expect((await readCodexMcpServers()).servers).toEqual({});
  });

  it("yields an empty map when the file is absent, without logging", async () => {
    expect((await readCodexMcpServers()).servers).toEqual({});
    expect(logMock).not.toHaveBeenCalled();
  });

  it("logs an unparseable file exactly once, without echoing its contents", async () => {
    files.set(CODEX_TOML, String.raw`
[mcp_servers.docs
command = "node"
bearer_token_env_var = "sk-looks-like-a-secret"
`);
    expect((await readCodexMcpServers()).servers).toEqual({});
    expect(logMock).toHaveBeenCalledTimes(1);
    const logged = logMock.mock.calls[0]!.join(" ");
    expect(logged).toContain("not valid TOML");
    expect(logged).not.toContain("sk-looks-like-a-secret");
  });

  it("lets the other ecosystems load even when the Codex file is unparseable", async () => {
    files.set(CODEX_TOML, "[mcp_servers.docs\n");
    files.set(CLAUDE_GLOBAL, JSON.stringify({ mcpServers: { cl: { command: "cl-cmd" } } }));
    files.set(DAMOCLES_MCP, JSON.stringify({ mcpServers: { dm: { command: "dm-cmd" } } }));

    const entries = merge(orderMcpSources((await readGlobalMcpSources([WS_ROOT])).sources, "claude"), NONE_DISABLED);
    expect(entries.map(e => e.name).sort()).toEqual(["cl", "dm"]);
    expect(logMock).toHaveBeenCalledTimes(1);
  });
});

describe("readClaudeMcpScopes (~/.claude.json: the user scope and projects[<ws>].mcpServers)", () => {
  const localScope = { localOnly: { command: "local-cmd" }, shared: { command: "local-shared" } };
  const userScope = { userOnly: { command: "user-cmd" }, shared: { command: "user-shared" } };

  /** `~/.claude.json` holding the user scope always, and the local scope under `projectsKey`. */
  function claudeJson(projectsKey: string | null): string {
    const doc: Record<string, unknown> = { mcpServers: userScope };
    if (projectsKey !== null) doc["projects"] = { [projectsKey]: { mcpServers: localScope } };
    return JSON.stringify(doc);
  }

  const localNames = async (workspaceRoot: string): Promise<string[]> =>
    Object.keys((await readClaudeMcpScopes([workspaceRoot])).local.get(workspaceRoot)!.servers).sort();

  it("separates the two scopes, so the local one is no longer invisible", async () => {
    files.set(CLAUDE_GLOBAL, claudeJson(WS_ROOT));

    // `claude mcp add` defaults to local scope, so before this reader those servers were never loaded.
    const scopes = await readClaudeMcpScopes([WS_ROOT]);

    expect(Object.keys(scopes.local.get(WS_ROOT)!.servers).sort()).toEqual(["localOnly", "shared"]);
    // The user scope must not start pulling project-keyed servers in.
    expect(Object.keys(scopes.user.servers).sort()).toEqual(["shared", "userOnly"]);
    expect((scopes.local.get(WS_ROOT)!.servers["shared"] as McpStdioServerConfig).command).toBe("local-shared");
    expect((scopes.user.servers["shared"] as McpStdioServerConfig).command).toBe("user-shared");
  });

  it("reads and parses ~/.claude.json exactly once for both scopes", async () => {
    // The file accretes per-project history and routinely runs to megabytes, and `loadConfig` re-runs
    // on every watcher event, so two readers over one document is the whole point of this function.
    files.set(CLAUDE_GLOBAL, claudeJson(WS_ROOT));
    readFileMock.mockClear();

    await readClaudeMcpScopes([WS_ROOT]);

    const claudeReads = readFileMock.mock.calls.filter(
      ([target]) => forwardSlashed(String(target)).endsWith(CLAUDE_GLOBAL),
    );
    expect(claudeReads).toHaveLength(1);
  });

  it("reads each open folder's local scope off one parse of ~/.claude.json, keyed by that folder", async () => {
    // A server Claude Code keyed to one project must never reach another folder's panels.
    files.set(CLAUDE_GLOBAL, JSON.stringify({
      mcpServers: userScope,
      projects: { [WS_ROOT]: { mcpServers: localScope }, [OTHER_WS_ROOT]: { mcpServers: { otherOnly: { command: "other" } } } },
    }));
    readFileMock.mockClear();

    const scopes = await readClaudeMcpScopes([WS_ROOT, OTHER_WS_ROOT]);

    expect(Object.keys(scopes.local.get(WS_ROOT)!.servers).sort()).toEqual(["localOnly", "shared"]);
    expect(Object.keys(scopes.local.get(OTHER_WS_ROOT)!.servers)).toEqual(["otherOnly"]);
    const claudeReads = readFileMock.mock.calls.filter(
      ([target]) => forwardSlashed(String(target)).endsWith(CLAUDE_GLOBAL),
    );
    expect(claudeReads).toHaveLength(1);
  });

  it("merges Claude Desktop into the user scope only, letting ~/.claude.json win", async () => {
    // The local scope is a `~/.claude.json` construct; Claude Desktop has no project keys at all, so
    // it must never leak into the project-scoped half.
    files.set(CLAUDE_DESKTOP, JSON.stringify({ mcpServers: { shared: { command: "desktop" }, dt: { command: "d" } } }));
    files.set(CLAUDE_GLOBAL, claudeJson(WS_ROOT));

    const scopes = await readClaudeMcpScopes([WS_ROOT]);

    expect((scopes.user.servers["shared"] as McpStdioServerConfig).command).toBe("user-shared");
    expect(Object.keys(scopes.user.servers).sort()).toEqual(["dt", "shared", "userOnly"]);
    expect(Object.keys(scopes.local.get(WS_ROOT)!.servers).sort()).toEqual(["localOnly", "shared"]);
  });

  it("lets the local scope outrank the user scope on a name collision, as Claude Code itself does", async () => {
    files.set(CLAUDE_GLOBAL, claudeJson(WS_ROOT));

    const entry = merge(orderMcpSources(withClaudeLocal(await readGlobalMcpSources([WS_ROOT]), WS_ROOT), "claude"), NONE_DISABLED)
      .find(e => e.name === "shared");

    expect((entry?.config as McpStdioServerConfig).command).toBe("local-shared");
    expect(entry?.source).toBe("claude-local");
  });

  it("contributes nothing when the only projects key names a different directory", async () => {
    files.set(CLAUDE_GLOBAL, claudeJson(OTHER_WS_ROOT));

    // Never a nearest-match guess: another project's servers arriving here would spawn processes the
    // user configured for a different repository.
    expect((await readClaudeMcpScopes([WS_ROOT])).local.get(WS_ROOT)?.servers).toEqual({});
    // The user scope is keyed by nothing, so it still arrives.
    expect(Object.keys((await readClaudeMcpScopes([WS_ROOT])).user.servers).sort()).toEqual(["shared", "userOnly"]);
    expect((await readGlobalMcpSources([WS_ROOT])).claudeLocal.get(WS_ROOT)?.servers).toEqual({});
  });

  it("matches across a trailing separator on either side", async () => {
    files.set(CLAUDE_GLOBAL, claudeJson(WS_ROOT + sep));
    expect(await localNames(WS_ROOT)).toContain("localOnly");

    files.set(CLAUDE_GLOBAL, claudeJson(WS_ROOT));
    expect(await localNames(WS_ROOT + sep)).toContain("localOnly");
  });

  it.runIf(process.platform === "win32")("matches a Windows drive letter written in the other case", async () => {
    // VS Code and the shell disagree about drive-letter case often enough that an exact string
    // compare loses the match. Only Windows paths are case-insensitive, so only Windows folds case.
    const otherCase = WS_ROOT.charAt(0).toLowerCase() + WS_ROOT.slice(1);
    expect(otherCase).not.toBe(WS_ROOT);
    files.set(CLAUDE_GLOBAL, claudeJson(otherCase));

    expect(await localNames(WS_ROOT)).toEqual(["localOnly", "shared"]);
  });

  it("treats a ~/.claude.json with no projects key as no local servers rather than a failure", async () => {
    files.set(CLAUDE_GLOBAL, JSON.stringify({ mcpServers: userScope }));

    expect((await readClaudeMcpScopes([WS_ROOT])).local.get(WS_ROOT)?.servers).toEqual({});
    expect((await readGlobalMcpSources([WS_ROOT])).errors).toEqual([]);
    expect(logMock).not.toHaveBeenCalled();
  });

  it("yields no local servers when there is no workspace at all", async () => {
    files.set(CLAUDE_GLOBAL, claudeJson(WS_ROOT));

    const scopes = await readClaudeMcpScopes([]);
    expect(scopes.local.size).toBe(0);
    // With no folder open there is no key to look up, but the user scope does not depend on one.
    expect(Object.keys(scopes.user.servers).sort()).toEqual(["shared", "userOnly"]);
    expect((await readGlobalMcpSources([])).claudeLocal.size).toBe(0);
  });

  it("loses both scopes, not just one, when ~/.claude.json does not parse", async () => {
    files.set(CLAUDE_GLOBAL, '{ "projects": { not json');

    const scopes = await readClaudeMcpScopes([WS_ROOT]);

    expect(scopes.user.servers).toEqual({});
    expect(scopes.local.get(WS_ROOT)?.servers).toEqual({});
  });

  it("keeps another tool's parse failure off the panel, exactly as the user-scope import does", async () => {
    files.set(CLAUDE_GLOBAL, '{ "projects": { not json');
    files.set(DAMOCLES_MCP, JSON.stringify({ mcpServers: { dm: { command: "dm-cmd" } } }));

    const { sources, errors } = await readGlobalMcpSources([WS_ROOT]);

    expect(errors).toEqual([]);
    expect(sources.find(s => s.source === "damocles")?.servers["dm"]).toBeDefined();
  });

  it("drops junk entries in the local scope the same way the top level does", async () => {
    files.set(CLAUDE_GLOBAL, JSON.stringify({
      projects: { [WS_ROOT]: { mcpServers: { good: { command: "x" }, junk: { notACommand: true }, $schema: "y" } } },
    }));

    expect(await localNames(WS_ROOT)).toEqual(["good"]);
  });

  it.runIf(process.platform === "win32")("resolves two keys differing only in case to the last one written", async () => {
    // Windows paths are case-insensitive, so both keys name the same directory. Scanning for the
    // first normalised match makes the answer depend on object insertion order, which is not a rule
    // anyone can reason about. Indexing by the normalised key states one: the last write wins.
    const upper = WS_ROOT.charAt(0).toUpperCase() + WS_ROOT.slice(1);
    const lower = WS_ROOT.charAt(0).toLowerCase() + WS_ROOT.slice(1);
    expect(upper).not.toBe(lower);

    files.set(CLAUDE_GLOBAL, JSON.stringify({
      projects: {
        [upper]: { mcpServers: { first: { command: "a" } } },
        [lower]: { mcpServers: { second: { command: "b" } } },
      },
    }));
    expect(await localNames(WS_ROOT)).toEqual(["second"]);

    files.set(CLAUDE_GLOBAL, JSON.stringify({
      projects: {
        [lower]: { mcpServers: { second: { command: "b" } } },
        [upper]: { mcpServers: { first: { command: "a" } } },
      },
    }));
    expect(await localNames(WS_ROOT)).toEqual(["first"]);
  });

  it("keeps each workspace's local scope to itself when two projects are keyed", async () => {
    // One `~/.claude.json` holds every project the user has ever opened, so picking the wrong key
    // silently starts another repository's servers.
    files.set(CLAUDE_GLOBAL, JSON.stringify({
      mcpServers: userScope,
      projects: {
        [WS_ROOT]: { mcpServers: { mine: { command: "mine" } } },
        [OTHER_WS_ROOT]: { mcpServers: { theirs: { command: "theirs" } } },
      },
    }));

    expect(await localNames(WS_ROOT)).toEqual(["mine"]);
    expect(await localNames(OTHER_WS_ROOT)).toEqual(["theirs"]);
  });
});

describe("precedence fold order across all eight sources", () => {
  /** One distinguishable command per source, so only precedence decides which survives the fold. */
  const COMMAND_BY_SOURCE: Record<McpServerSource, string> = {
    claude: "claude-cmd",
    codex: "codex-cmd",
    pi: "pi-cmd",
    "pi-project": "pi-project-cmd",
    "claude-local": "claude-local-cmd",
    damocles: "damocles-cmd",
    workspace: "workspace-cmd",
    "damocles-local": "damocles-local-cmd",
  };

  /** Define `shared` in exactly `present`, leaving every other source's file absent. */
  function seedSources(present: readonly McpServerSource[]): void {
    files.clear();
    const server = (source: McpServerSource) => ({ shared: { command: COMMAND_BY_SOURCE[source] } });

    const claudeDoc: Record<string, unknown> = {};
    if (present.includes("claude")) claudeDoc["mcpServers"] = server("claude");
    if (present.includes("claude-local")) claudeDoc["projects"] = { [WS_ROOT]: { mcpServers: server("claude-local") } };
    if (Object.keys(claudeDoc).length > 0) files.set(CLAUDE_GLOBAL, JSON.stringify(claudeDoc));

    if (present.includes("codex")) files.set(CODEX_TOML, `[mcp_servers.shared]\ncommand = "${COMMAND_BY_SOURCE.codex}"\n`);
    if (present.includes("pi")) files.set(PI_MCP, JSON.stringify({ mcpServers: server("pi") }));
    if (present.includes("pi-project")) files.set(WS_PI_MCP, JSON.stringify({ mcpServers: server("pi-project") }));
    if (present.includes("damocles")) files.set(DAMOCLES_MCP, JSON.stringify({ mcpServers: server("damocles") }));
    if (present.includes("workspace")) files.set(WS_MCP, JSON.stringify({ mcpServers: server("workspace") }));
    if (present.includes("damocles-local")) files.set(WS_LOCAL_MCP, JSON.stringify({ mcpServers: server("damocles-local") }));
  }

  /**
   * The batches a trusted workspace folds, ranked the way `loadConfig` ranks them: the globals and the
   * two workspace-tree files go through one `orderMcpSources` call, so no caller depends on a reader
   * happening to emit its half in the right order.
   */
  async function foldedSources(precedence: AssetSourcePrecedence): Promise<SourceFixture[]> {
    return orderMcpSources([
      ...withClaudeLocal(await readGlobalMcpSources([WS_ROOT]), WS_ROOT),
      { source: "workspace", ...(await readMcpConfigFile(join(WS_ROOT, ".mcp.json"))) },
      { source: "pi-project", ...(await readMcpConfigFile(piProjectMcpConfigPath(WS_ROOT))) },
      { source: "damocles-local", ...(await readMcpConfigFile(localMcpConfigPath(WS_ROOT))) },
    ], precedence);
  }

  it("answers repo-authorship for every source in the union", () => {
    // The trust gate reads this map and nothing else. `claude-local` is the sharp case: it is
    // project-scoped, so the panel groups it with the project, yet it lives in `~/.claude.json`, which
    // a repository you cloned cannot write. Marking it repo-authored would withhold a server the user
    // configured themselves.
    const everySource = mcpSourceOrder("claude");
    expect(Object.keys(REPO_AUTHORED_BY_SOURCE).sort()).toEqual([...everySource].sort());

    expect(REPO_AUTHORED_BY_SOURCE["claude-local"]).toBe(false);
    expect(REPO_AUTHORED_BY_SOURCE["claude"]).toBe(false);
    expect(REPO_AUTHORED_BY_SOURCE["codex"]).toBe(false);
    expect(REPO_AUTHORED_BY_SOURCE["damocles"]).toBe(false);
    expect(REPO_AUTHORED_BY_SOURCE["pi"]).toBe(false);
    // The files that live in the working tree answer the other way.
    expect(REPO_AUTHORED_BY_SOURCE["workspace"]).toBe(true);
    expect(REPO_AUTHORED_BY_SOURCE["pi-project"]).toBe(true);
    expect(REPO_AUTHORED_BY_SOURCE["damocles-local"]).toBe(true);
  });

  it("ranks every repo-authored Damocles file above ~/.damocles/mcp.json, and pi's project file below it", () => {
    // The untrusted fold demotes every repo-authored source. `.pi/mcp.json` is another tool's file, so
    // it ranks below the Damocles files even when trusted and never shadows a Damocles write.
    const order = mcpSourceOrder("claude");
    const aboveDamocles = [...order.slice(order.indexOf("damocles") + 1)].sort();
    const repoAuthored = Object.entries(REPO_AUTHORED_BY_SOURCE)
      .filter(([, authored]) => authored)
      .map(([source]) => source)
      .sort();

    expect(repoAuthored).toEqual([...aboveDamocles, "pi-project"].sort());
    expect([...SHADOWING_SOURCES].sort()).toEqual(aboveDamocles);
    expect(order.indexOf("pi-project")).toBeLessThan(order.indexOf("damocles"));
  });

  it("keeps the write target itself out of the repo-authored set", () => {
    // Load-bearing across layers, and the reason is in neither layer. An untrusted workspace marks
    // every repo-authored entry `untrusted`, and the form skips its collision check for those. If
    // `~/.damocles/mcp.json` were ever repo-authored, its own servers would arrive marked untrusted
    // and the form would stop refusing a name that file already holds, so a save would silently
    // overwrite an existing server. It is user-global and outside the repository, so this is false by
    // construction, but nothing in the type forces it: the map demands a boolean for every source and
    // constrains none of them.
    expect(REPO_AUTHORED_BY_SOURCE["damocles"]).toBe(false);

    // The same reasoning as a property rather than a literal: no source may be both repo-authored and
    // the one the write path targets.
    const repoAuthored = Object.entries(REPO_AUTHORED_BY_SOURCE)
      .filter(([, authored]) => authored)
      .map(([source]) => source);
    expect(repoAuthored).not.toContain("damocles");
  });

  it("declares the order the brief fixes, lowest precedence first", () => {
    expect(mcpSourceOrder("claude")).toEqual([
      "codex", "claude", "pi", "pi-project", "claude-local", "damocles", "workspace", "damocles-local",
    ]);
    expect(mcpSourceOrder("codex")).toEqual([
      "claude", "codex", "pi", "pi-project", "claude-local", "damocles", "workspace", "damocles-local",
    ]);
  });

  it("holds exactly eight sources, the same eight under either tie-break", () => {
    // `McpServerSource` is derived from the claude-first tuple, so a member added to one tuple and
    // forgotten in the other cannot be caught by reading the union back. Both are compared here.
    const claudeFirst = mcpSourceOrder("claude");
    const codexFirst = mcpSourceOrder("codex");

    expect([...claudeFirst].sort()).toEqual([
      "claude", "claude-local", "codex", "damocles", "damocles-local", "pi", "pi-project", "workspace",
    ]);
    expect([...codexFirst].sort()).toEqual([...claudeFirst].sort());
    expect(new Set(claudeFirst).size).toBe(8);
    expect(new Set(codexFirst).size).toBe(8);

    // The tie-break permutes `claude` and `codex` and moves nothing else.
    expect(claudeFirst.slice(2)).toEqual(codexFirst.slice(2));
  });

  it("hands back the same array every call, since a sort comparator asks for it per comparison", () => {
    expect(mcpSourceOrder("claude")).toBe(mcpSourceOrder("claude"));
    expect(mcpSourceOrder("codex")).toBe(mcpSourceOrder("codex"));
    expect(mcpSourceOrder("claude")).not.toBe(mcpSourceOrder("codex"));
  });

  it("keeps every Damocles-owned source above every imported one, whichever way the tie breaks", () => {
    // The compat imports stay contiguous at the bottom. If one ever floated above `damocles`, another
    // tool's file would start overriding the file Damocles writes.
    for (const precedence of ["claude", "codex"] as const) {
      const order = mcpSourceOrder(precedence);
      const imported = ["claude", "codex", "pi", "pi-project", "claude-local"] as const;
      const owned = ["damocles", "workspace", "damocles-local"] as const;
      expect(Math.max(...imported.map(s => order.indexOf(s)))).toBeLessThan(
        Math.min(...owned.map(s => order.indexOf(s))),
      );
      expect(order.indexOf("claude-local")).toBeGreaterThan(order.indexOf("claude"));
      // A project file outranks a user file of the same tool.
      expect(order.indexOf("pi-project")).toBeGreaterThan(order.indexOf("pi"));
    }
  });

  it.each(["claude", "codex"] as const)(
    "resolves the winner to the highest-ranked source present, under assetSourcePrecedence=%s",
    async (precedence) => {
      const order = mcpSourceOrder(precedence);

      // Peel one source off the top at a time: the winner must walk down the order exactly.
      const winners: (string | undefined)[] = [];
      for (let top = order.length - 1; top >= 0; top--) {
        seedSources(order.slice(0, top + 1));
        const entry = merge(await foldedSources(precedence), NONE_DISABLED).find(e => e.name === "shared");
        winners.push((entry?.config as McpStdioServerConfig | undefined)?.command);
      }

      expect(winners).toEqual([...order].reverse().map(source => COMMAND_BY_SOURCE[source]));
    },
  );

  it.each(["claude", "codex"] as const)(
    "ranks every global batch into the declared order, under assetSourcePrecedence=%s",
    async (precedence) => {
      // `readGlobalMcpSources` emits its four batches in whatever order it builds them, so the caller
      // ranks them. This is the same call `loadConfig` makes.
      seedSources(mcpSourceOrder(precedence));
      const ranked = orderMcpSources(withClaudeLocal(await readGlobalMcpSources([WS_ROOT]), WS_ROOT), precedence).map(s => s.source);

      expect(ranked).toContain("claude-local");
      expect(ranked).toEqual(mcpSourceOrder(precedence).filter(source => ranked.includes(source)));
    },
  );

  it("tags each surviving entry with the source it actually came from", async () => {
    seedSources(["claude", "codex", "claude-local"]);
    files.set(CODEX_TOML, '[mcp_servers.shared]\ncommand = "codex-cmd"\n\n[mcp_servers.cxOnly]\ncommand = "cx"\n');

    const entries = merge(orderMcpSources(withClaudeLocal(await readGlobalMcpSources([WS_ROOT]), WS_ROOT), "claude"), NONE_DISABLED);
    const bySource = Object.fromEntries(entries.map(e => [e.name, e.source]));

    expect(bySource).toEqual({ shared: "claude-local", cxOnly: "codex" });
  });
});

describe("namespace collisions (names equal after [^A-Za-z0-9_] becomes _)", () => {
  it("keeps the higher-ranked server and reports the other as a failed nameCollision row", () => {
    const entries = merge([
      { source: "claude", servers: { "my-server": { command: "a" } } },
      { source: "damocles", servers: { "my.server": { command: "b" } } },
    ]);
    const kept = entries.find((e) => e.name === "my.server")!;
    const dropped = entries.find((e) => e.name === "my-server")!;

    expect(kept.error).toBeUndefined();
    expect(dropped.error?.errorInfo).toEqual({ code: "nameCollision", params: { kept: "my.server", keptSource: "damocles" } });
    expect(dropped.error?.message).not.toContain('"a"');
  });

  it("follows the precedence flip: the tie-break decides which of two imported spellings loads", async () => {
    files.set(CLAUDE_GLOBAL, JSON.stringify({ mcpServers: { "my-server": { command: "a" }, alpha: { command: "b" } } }));
    files.set(CODEX_TOML, ['[mcp_servers."my.server"]', 'command = "c"', "", "[mcp_servers.zeta]", 'command = "d"', ""].join("\n"));

    const keptUnder = async (precedence: "claude" | "codex") => {
      const { sources } = await readGlobalMcpSources([]);
      return merge(orderMcpSources(sources, precedence))
        .filter((e) => e.error === undefined)
        .map((e) => e.name)
        .sort();
    };

    expect(await keptUnder("claude")).toEqual(["alpha", "my-server", "zeta"]);
    expect(await keptUnder("codex")).toEqual(["alpha", "my.server", "zeta"]);
  });

  it("keeps the first spelling in one file on a tie", () => {
    const entries = merge([{ source: "damocles", servers: { "a.b": { command: "x" }, "a-b": { command: "y" } } }]);
    expect(entries.find((e) => e.name === "a.b")?.error).toBeUndefined();
    expect(entries.find((e) => e.name === "a-b")?.error?.errorInfo?.code).toBe("nameCollision");
  });

  it("keeps the first spelling in its file on a tie even when a lower source named the later one first", () => {
    const entries = merge([
      { source: "claude", servers: { "a.b": { command: "below" } } },
      { source: "damocles", servers: { "a-b": { command: "x" }, "a.b": { command: "y" } } },
    ]);
    expect(entries.find((e) => e.name === "a-b")?.error).toBeUndefined();
    expect(entries.find((e) => e.name === "a.b")?.error?.errorInfo).toEqual({ code: "nameCollision", params: { kept: "a-b", keptSource: "damocles" } });
  });

  it("lets an invalid entry claim its name like a valid one", () => {
    const entries = merge([
      { source: "claude", servers: { docs: { command: "x" } } },
      { source: "damocles", servers: {}, invalid: { docs: { message: "bad", errorInfo: { code: "invalidConfig", params: { detail: "bad" } } } } },
    ]);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ name: "docs", source: "damocles", config: null });
  });
});

describe("config enabled:false and the panel's enable override", () => {
  it("lists a server whose config says enabled:false as disabled, until its scope's override names it", () => {
    const sources: SourceFixture[] = [{ source: "damocles", servers: { off: { command: "x", enabled: false }, on: { command: "y" } } }];
    expect(Object.fromEntries(merge(sources).map((e) => [e.name, e.enabled]))).toEqual({ off: false, on: true });

    const overridden = merge(sources, NONE_DISABLED, { user: new Set(["off"]), folder: new Set() });
    expect(overridden.find((e) => e.name === "off")?.enabled).toBe(true);

    const wrongScope = merge(sources, NONE_DISABLED, { user: new Set(), folder: new Set(["off"]) });
    expect(wrongScope.find((e) => e.name === "off")?.enabled).toBe(false);
  });

  it("keeps the disabled list stronger than the override", () => {
    const sources: SourceFixture[] = [{ source: "damocles", servers: { off: { command: "x", enabled: false } } }];
    const both = { user: new Set(["off"]), folder: new Set<string>() };
    expect(merge(sources, both, both)[0]?.enabled).toBe(false);
  });
});

describe("pi sources", () => {
  it("reads ~/.pi/agent/mcp.json as the pi source", async () => {
    files.set(PI_MCP, JSON.stringify({ mcpServers: { fromPi: { command: "pi-cmd" } } }));
    const { sources } = await readGlobalMcpSources([]);
    expect(sources.find((s) => s.source === "pi")?.servers["fromPi"]).toEqual({ command: "pi-cmd" });
    expect(forwardSlashed(PI_MCP_CONFIG_PATH).endsWith(PI_MCP)).toBe(true);
  });

  it("files pi as user scope and .pi/mcp.json as folder scope, both in pi's value format", () => {
    expect(MCP_SCOPE_BY_SOURCE.pi).toBe("user");
    expect(MCP_SCOPE_BY_SOURCE["pi-project"]).toBe("folder");
    expect(VALUE_FORMAT_BY_SOURCE).toEqual({
      pi: "pi",
      "pi-project": "pi",
      damocles: "pi",
      "damocles-local": "pi",
      claude: "legacy",
      "claude-local": "legacy",
      codex: "legacy",
      workspace: "legacy",
    });
  });

  it("reports a pi file's unusable entries as rows without failing the file", async () => {
    files.set(PI_MCP, JSON.stringify({
      mcpServers: {
        legacy: { type: "sse", url: "https://x.example.com/sse" },
        provider: { url: "https://x.example.com/mcp", auth: { provider: "anthropic" } },
        good: { command: "ok" },
      },
      autoEnableCodemode: true,
    }));
    const pi = (await readGlobalMcpSources([])).sources.find((s) => s.source === "pi")!;

    expect(Object.keys(pi.servers)).toEqual(["good"]);
    expect(pi.invalid["legacy"]?.errorInfo?.code).toBe("sseUnsupported");
    expect(pi.invalid["legacy"]?.message).toBe("legacy SSE transport is not supported; use the server's streamable HTTP URL");
    expect(pi.invalid["provider"]?.errorInfo?.code).toBe("authProviderUnsupported");
  });
});

describe("coerceServerMap (M8/M9)", () => {
  it("keeps only entries that are real stdio/remote server configs", () => {
    const out = coerceServerMap({
      good: { command: "x", args: ["--y"] },
      remote: { url: "https://srv" },
      $schema: "https://example.com/mcp.schema.json",
      junk: { notACommand: true },
      nullish: null,
    });
    expect(Object.keys(out.servers).sort()).toEqual(["good", "remote"]);
    // An object that is not a server config is still a server the user named: it becomes a failed row.
    expect(Object.keys(out.invalid)).toEqual(["junk"]);
    expect(out.invalid["junk"]?.errorInfo?.code).toBe("invalidConfig");
  });

  it("returns an empty map for a non-object or missing server map (no whole-object fallback)", () => {
    const empty = { servers: {}, invalid: {} };
    expect(coerceServerMap(undefined)).toEqual(empty);
    expect(coerceServerMap(null)).toEqual(empty);
    expect(coerceServerMap("nope")).toEqual(empty);
    expect(coerceServerMap([{ command: "x" }])).toEqual(empty);
  });
});

afterEach(() => {
  vi.clearAllMocks();
});
