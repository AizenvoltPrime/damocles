import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// The readers hit `node:fs` and the Codex parse failure hits the output channel; both are faked so a
// test never depends on what happens to be in the developer's home directory.
const readFileMock = vi.hoisted(() => vi.fn());
const logMock = vi.hoisted(() => vi.fn());
vi.mock("node:fs", () => ({ promises: { readFile: readFileMock } }));
vi.mock("../../../../logger", () => ({ log: logMock }));

import {
  mergeMcpEntries,
  coerceServerMap,
  readCodexMcpServers,
  readDamoclesMcpServers,
  readGlobalMcpSources,
  DAMOCLES_MCP_CONFIG_PATH,
  type McpSourceServers,
} from "../mcp-config-import";
import { buildServerPrefixMap } from "../../../../pi-session/mcp/naming";
import type { McpServerConfig, McpStdioServerConfig, McpHttpServerConfig } from "../../../../../shared/types/mcp";

/** Home-relative path suffix (forward-slashed) → file contents. Anything unset reads as ENOENT. */
const files = new Map<string, string>();

const CLAUDE_GLOBAL = ".claude.json";
const CLAUDE_DESKTOP = ".claude/claude_desktop_config.json";
const DAMOCLES_MCP = ".damocles/mcp.json";
const CODEX_TOML = ".codex/config.toml";

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

/** The single Codex server the TOML fixture defines, or undefined if it was skipped. */
async function codexServer(toml: string, name = "docs"): Promise<McpServerConfig | undefined> {
  files.set(CODEX_TOML, toml);
  return (await readCodexMcpServers())[name];
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
const twoSources: McpSourceServers[] = [
  { source: "claude", servers: imported },
  { source: "workspace", servers: ws },
];

describe("mergeMcpEntries", () => {
  it("lets the last source in the list win on a name collision and tags provenance", () => {
    const entries = mergeMcpEntries(twoSources, new Set());
    const shared = entries.find(e => e.name === "shared");
    expect((shared?.config as McpStdioServerConfig).command).toBe("workspace-cmd");
    expect(shared?.source).toBe("workspace");
    expect(shared?.readonly).toBe(false);
  });

  it("flags imported-only entries as readonly claude imports", () => {
    const entries = mergeMcpEntries(twoSources, new Set());
    const ccOnly = entries.find(e => e.name === "ccOnly");
    expect(ccOnly?.source).toBe("claude");
    expect(ccOnly?.readonly).toBe(true);
  });

  it("applies the Damocles disabled set to workspace and imported names alike", () => {
    const entries = mergeMcpEntries(twoSources, new Set(["wsOnly", "ccOnly"]));
    const byName = Object.fromEntries(entries.map(e => [e.name, e.enabled]));
    expect(byName["wsOnly"]).toBe(false);
    expect(byName["ccOnly"]).toBe(false);
    expect(byName["shared"]).toBe(true);
  });

  it("includes every distinct server exactly once", () => {
    const entries = mergeMcpEntries(twoSources, new Set());
    const names = entries.map(e => e.name).sort();
    expect(names).toEqual(["ccOnly", "shared", "wsOnly"]);
  });

  it("derives readonly from source alone: the two Damocles-owned files are editable, imports are not", () => {
    const entries = mergeMcpEntries(
      [
        { source: "codex", servers: { cx: { command: "x" } } },
        { source: "claude", servers: { cl: { command: "x" } } },
        { source: "damocles", servers: { dm: { command: "x" } } },
        { source: "workspace", servers: { wsp: { command: "x" } } },
      ],
      new Set(),
    );
    const readonlyBySource = Object.fromEntries(entries.map(e => [e.source, e.readonly]));
    expect(readonlyBySource).toEqual({ codex: true, claude: true, damocles: false, workspace: false });
  });
});

describe("importClaudeMcpServers (unchanged by the ordered-source fold)", () => {
  it("folds both Claude files into the single claude source, with the CC global winning", async () => {
    files.set(CLAUDE_DESKTOP, JSON.stringify({ mcpServers: { shared: { command: "desktop" }, dt: { command: "d" } } }));
    files.set(CLAUDE_GLOBAL, JSON.stringify({ mcpServers: { shared: { command: "global" } } }));

    const claude = (await readGlobalMcpSources("claude")).sources.find(s => s.source === "claude");
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
    expect(await readDamoclesMcpServers()).toEqual({ servers: {}, error: null });
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

    const { sources, errors } = await readGlobalMcpSources("claude");

    expect(errors).toHaveLength(1);
    expect(errors[0].path).toBe(DAMOCLES_MCP_CONFIG_PATH);
    expect(sources.find(s => s.source === "claude")?.servers["cl"]).toBeDefined();
  });

  it("reports nothing when every file is readable", async () => {
    files.set(DAMOCLES_MCP, JSON.stringify({ mcpServers: { dm: { command: "dm-cmd" } } }));
    expect((await readGlobalMcpSources("claude")).errors).toEqual([]);
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
      const servers = await readCodexMcpServers();
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
    expect(Object.keys(await readCodexMcpServers()).sort()).toEqual(["on", "unspecified"]);
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
    expect(await readCodexMcpServers()).toEqual({});
  });

  it("yields an empty map when the file is absent, without logging", async () => {
    expect(await readCodexMcpServers()).toEqual({});
    expect(logMock).not.toHaveBeenCalled();
  });

  it("logs an unparseable file exactly once, without echoing its contents", async () => {
    files.set(CODEX_TOML, String.raw`
[mcp_servers.docs
command = "node"
bearer_token_env_var = "sk-looks-like-a-secret"
`);
    expect(await readCodexMcpServers()).toEqual({});
    expect(logMock).toHaveBeenCalledTimes(1);
    const logged = logMock.mock.calls[0]!.join(" ");
    expect(logged).toContain("not valid TOML");
    expect(logged).not.toContain("sk-looks-like-a-secret");
  });

  it("lets the other ecosystems load even when the Codex file is unparseable", async () => {
    files.set(CODEX_TOML, "[mcp_servers.docs\n");
    files.set(CLAUDE_GLOBAL, JSON.stringify({ mcpServers: { cl: { command: "cl-cmd" } } }));
    files.set(DAMOCLES_MCP, JSON.stringify({ mcpServers: { dm: { command: "dm-cmd" } } }));

    const entries = mergeMcpEntries((await readGlobalMcpSources("claude")).sources, new Set());
    expect(entries.map(e => e.name).sort()).toEqual(["cl", "dm"]);
    expect(logMock).toHaveBeenCalledTimes(1);
  });
});

describe("precedence fold order across all four sources", () => {
  /** The same server name defined in every source, so only precedence decides which command survives. */
  function seedAllSources(opts: { workspace: boolean; damocles: boolean }): Record<string, McpServerConfig> {
    files.set(CLAUDE_GLOBAL, JSON.stringify({ mcpServers: { shared: { command: "claude-cmd" } } }));
    files.set(CODEX_TOML, '[mcp_servers.shared]\ncommand = "codex-cmd"\n');
    if (opts.damocles) files.set(DAMOCLES_MCP, JSON.stringify({ mcpServers: { shared: { command: "damocles-cmd" } } }));
    return opts.workspace ? { shared: { command: "workspace-cmd" } } : {};
  }

  async function winningCommand(
    precedence: "claude" | "codex",
    opts: { workspace: boolean; damocles: boolean },
  ): Promise<string | undefined> {
    const workspaceServers = seedAllSources(opts);
    const { sources } = await readGlobalMcpSources(precedence);
    sources.push({ source: "workspace", servers: workspaceServers });
    const entry = mergeMcpEntries(sources, new Set()).find(e => e.name === "shared");
    return (entry?.config as McpStdioServerConfig | undefined)?.command;
  }

  it("lets the workspace .mcp.json outrank every global source", async () => {
    expect(await winningCommand("claude", { workspace: true, damocles: true })).toBe("workspace-cmd");
    expect(await winningCommand("codex", { workspace: true, damocles: true })).toBe("workspace-cmd");
  });

  it("lets ~/.damocles/mcp.json outrank both imports once the workspace entry is gone", async () => {
    expect(await winningCommand("claude", { workspace: false, damocles: true })).toBe("damocles-cmd");
    expect(await winningCommand("codex", { workspace: false, damocles: true })).toBe("damocles-cmd");
  });

  it("breaks the remaining claude/codex tie with assetSourcePrecedence, and flipping it flips the winner", async () => {
    expect(await winningCommand("claude", { workspace: false, damocles: false })).toBe("claude-cmd");
    expect(await winningCommand("codex", { workspace: false, damocles: false })).toBe("codex-cmd");
  });

  it("tags each surviving entry with the source it actually came from", async () => {
    seedAllSources({ workspace: false, damocles: false });
    files.set(CODEX_TOML, '[mcp_servers.shared]\ncommand = "codex-cmd"\n\n[mcp_servers.cxOnly]\ncommand = "cx"\n');
    const entries = mergeMcpEntries((await readGlobalMcpSources("claude")).sources, new Set());
    const bySource = Object.fromEntries(entries.map(e => [e.name, e.source]));
    expect(bySource).toEqual({ shared: "claude", cxOnly: "codex" });
  });
});

describe("prefix-map stability under a precedence flip", () => {
  it("leaves every surviving server's mcp__ prefix unchanged when the merge order flips", async () => {
    // Colliding names ("my-server"/"my.server" both sanitize to `my_server`) split across the two
    // ecosystems: the de-collision suffix used to fall out of merge order, so flipping the setting would
    // have repointed a user's `damocles.tools.disabled` entries at the other server.
    files.set(CLAUDE_GLOBAL, JSON.stringify({ mcpServers: { "my-server": { command: "a" }, alpha: { command: "b" } } }));
    files.set(CODEX_TOML, '[mcp_servers."my.server"]\ncommand = "c"\n\n[mcp_servers.zeta]\ncommand = "d"\n');

    const prefixesFor = async (precedence: "claude" | "codex") => {
      const entries = mergeMcpEntries((await readGlobalMcpSources(precedence)).sources, new Set());
      return Object.fromEntries(buildServerPrefixMap(entries.map(e => e.name)));
    };

    const withClaude = await prefixesFor("claude");
    const withCodex = await prefixesFor("codex");
    expect(withClaude).toEqual(withCodex);
    expect(withClaude).toEqual({
      alpha: "alpha",
      "my-server": "my_server",
      "my.server": "my_server_2",
      zeta: "zeta",
    });
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
    expect(Object.keys(out).sort()).toEqual(["good", "remote"]);
  });

  it("returns an empty map for a non-object or missing server map (no whole-object fallback)", () => {
    expect(coerceServerMap(undefined)).toEqual({});
    expect(coerceServerMap(null)).toEqual({});
    expect(coerceServerMap("nope")).toEqual({});
    expect(coerceServerMap([{ command: "x" }])).toEqual({});
  });
});

afterEach(() => {
  vi.clearAllMocks();
});
