import * as fs from "fs";
import * as path from "path";
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";

/**
 * The writer targets `~/.damocles/mcp.json`, whose path is resolved from `homedir()` at module load.
 * Home is redirected into a temp directory and the tests then use the REAL filesystem, so the
 * round-trip, mkdir and create-on-first-write behaviour is exercised end to end rather than against a
 * fake `fs` that could not tell us whether the bytes on disk are right.
 */
const { tmpRoot, fakeHome } = vi.hoisted(() => {
  /* eslint-disable @typescript-eslint/no-require-imports */
  const nodeFs = require("fs") as typeof import("fs");
  const nodeOs = require("os") as typeof import("os");
  const nodePath = require("path") as typeof import("path");
  /* eslint-enable @typescript-eslint/no-require-imports */
  const root = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "dam-mcp-write-"));
  return { tmpRoot: root, fakeHome: nodePath.join(root, "home") };
});

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("os")>();
  return { ...actual, homedir: () => fakeHome };
});

/** Captured so the tests can assert that no config, `env` or `headers` value ever reaches the log. */
const logMock = vi.hoisted(() => vi.fn());
vi.mock("../../../../logger", () => ({ log: logMock }));

import type { McpServerConfig, McpServerSource, McpStdioServerConfig } from "../../../../../shared/types/mcp";
import {
  addDamoclesMcpServer,
  updateDamoclesMcpServer,
  deleteDamoclesMcpServer,
  McpWriteError,
} from "../mcp-config-write";
import { isFormEditableMcpServerConfig } from "../mcp-config-validate";

const MCP_PATH = path.join(fakeHome, ".damocles", "mcp.json");

/**
 * The shadowing set the manager hands the write path: server name → the higher-precedence source
 * that already owns it. A map rather than a set because the refusal has to name the offending file.
 */
const NO_SHADOWING_NAMES: ReadonlyMap<string, McpServerSource> = new Map();
const shadowedBy = (source: McpServerSource): ReadonlyMap<string, McpServerSource> =>
  new Map<string, McpServerSource>([["shared", source]]);

function writeConfigFile(content: string): void {
  fs.mkdirSync(path.dirname(MCP_PATH), { recursive: true });
  fs.writeFileSync(MCP_PATH, content, "utf-8");
}

function readConfigFile(): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(MCP_PATH, "utf-8"));
}

function readServers(): Record<string, McpServerConfig> {
  return (readConfigFile()["mcpServers"] ?? {}) as Record<string, McpServerConfig>;
}

const stdio: McpStdioServerConfig = { command: "docs-server", args: ["--stdio"] };

beforeEach(() => {
  fs.rmSync(fakeHome, { recursive: true, force: true });
  logMock.mockClear();
});

afterAll(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe("writeDamoclesMcpServers — file round-trip", () => {
  it("creates ~/.damocles/mcp.json and its parent directory on the first write", async () => {
    expect(fs.existsSync(MCP_PATH)).toBe(false);

    await addDamoclesMcpServer("docs", stdio, NO_SHADOWING_NAMES);

    expect(readServers()).toEqual({ docs: stdio });
    // Trailing newline, matching `syncPermissionRulesToSettings`' sibling files.
    expect(fs.readFileSync(MCP_PATH, "utf-8").endsWith("}\n")).toBe(true);
  });

  it("preserves every unknown top-level key and rewrites only mcpServers", async () => {
    writeConfigFile(JSON.stringify({
      $schema: "https://example.invalid/mcp.schema.json",
      comment: "hand-written; please keep",
      unrelated: { nested: [1, 2, 3] },
      mcpServers: { existing: { command: "old" } },
    }, null, 2));

    await addDamoclesMcpServer("docs", stdio, NO_SHADOWING_NAMES);

    const doc = readConfigFile();
    expect(doc["$schema"]).toBe("https://example.invalid/mcp.schema.json");
    expect(doc["comment"]).toBe("hand-written; please keep");
    expect(doc["unrelated"]).toEqual({ nested: [1, 2, 3] });
    expect(readServers()).toEqual({ existing: { command: "old" }, docs: stdio });
  });

  it("leaves an untouched server's exotic stored keys byte-identical when another server is edited", async () => {
    // `exotic` is not form-representable, so it can never be edited through the UI — but editing its
    // neighbour must not rewrite it either. Rebuilding the map from validated configs would drop these.
    const exotic = { command: "legacy", lifecycle: "lazy", idleTimeout: 7, debug: true, env: { TOKEN: "keep-me" } };
    writeConfigFile(JSON.stringify({ mcpServers: { exotic, docs: { command: "old" } } }, null, 2));

    await updateDamoclesMcpServer("docs", undefined, { command: "new" }, NO_SHADOWING_NAMES);

    expect(readServers()["exotic"]).toEqual(exotic);
    expect(isFormEditableMcpServerConfig(exotic)).toBe(false);
  });

  it("refuses to clobber an unparseable file, leaving its bytes untouched", async () => {
    const handEdited = '{ "mcpServers": { "docs": { "command": "x" },,, }';
    writeConfigFile(handEdited);

    await expect(addDamoclesMcpServer("docs", stdio, NO_SHADOWING_NAMES)).rejects.toThrow(/not valid JSON/);

    expect(fs.readFileSync(MCP_PATH, "utf-8")).toBe(handEdited);
  });

  it("refuses to clobber a file whose mcpServers key is not an object", async () => {
    const wrongShape = JSON.stringify({ mcpServers: ["docs"] });
    writeConfigFile(wrongShape);

    await expect(addDamoclesMcpServer("docs", stdio, NO_SHADOWING_NAMES)).rejects.toThrow(/not an object/);

    expect(fs.readFileSync(MCP_PATH, "utf-8")).toBe(wrongShape);
  });

  it("treats a missing file as zero servers rather than an error", async () => {
    expect(fs.existsSync(MCP_PATH)).toBe(false);

    await addDamoclesMcpServer("docs", stdio, NO_SHADOWING_NAMES);

    expect(readConfigFile()).toEqual({ mcpServers: { docs: stdio } });
  });

  it("writes atomically, leaving no temp file behind", async () => {
    await addDamoclesMcpServer("docs", stdio, NO_SHADOWING_NAMES);

    // `writeFile` truncates before it writes; a crash in that window would leave a zero-length
    // mcp.json that parses as nothing and drops every server. The write goes to a sibling and is
    // renamed over the target instead, so no reader ever observes a partial file.
    const strays = fs.readdirSync(path.dirname(MCP_PATH)).filter(name => name.includes(".tmp"));
    expect(strays).toEqual([]);
  });

  it("refuses to treat an inherited Object.prototype key as an existing server", async () => {
    writeConfigFile(JSON.stringify({ mcpServers: {} }));

    // `"toString" in servers` is true for a plain object, so an unguarded check reports that a server
    // nobody defined already exists — and assigning to `__proto__` would hit the setter, mutating the
    // prototype while JSON.stringify drops the key and the user is told the save worked.
    await addDamoclesMcpServer("toString", stdio, NO_SHADOWING_NAMES);
    await addDamoclesMcpServer("__proto__", stdio, NO_SHADOWING_NAMES);

    // Asserted key-by-key rather than against an object literal: `{ __proto__: … }` in a literal sets
    // the prototype instead of a key, which is the same trap the code under test had to avoid.
    const servers = readServers();
    expect(Object.keys(servers).sort()).toEqual(["__proto__", "toString"]);
    expect(servers["toString"]).toEqual(stdio);
    expect(Object.getOwnPropertyDescriptor(servers, "__proto__")?.value).toEqual(stdio);
  });

  it("deletes a hand-authored name the form's own rules would reject", async () => {
    // Nothing on the import path enforces the name pattern, so `my server` is a real entry the panel
    // shows and offers Delete for. Validating the EXISTING name here would leave the user with a
    // server they can see and cannot remove.
    writeConfigFile(JSON.stringify({ mcpServers: { "my server": { command: "node" } } }));

    await deleteDamoclesMcpServer("my server");

    expect(readServers()).toEqual({});
  });
});

describe("writeDamoclesMcpServers — concurrency", () => {
  it("serialises two rapid writes so neither interleaves nor loses the other's mutation", async () => {
    // Fired without awaiting the first: both read-modify-write cycles are in flight at once. If the
    // read happened outside the queued critical section, the second would read the pre-first map and
    // `a` would vanish.
    const first = addDamoclesMcpServer("alpha", { command: "a" }, NO_SHADOWING_NAMES);
    const second = addDamoclesMcpServer("beta", { command: "b" }, NO_SHADOWING_NAMES);
    await Promise.all([first, second]);

    expect(readServers()).toEqual({ alpha: { command: "a" }, beta: { command: "b" } });
  });

  it("keeps the queue alive after a rejected write so the next one still lands", async () => {
    const rejected = addDamoclesMcpServer("bad name", { command: "a" }, NO_SHADOWING_NAMES);
    const accepted = addDamoclesMcpServer("good", { command: "b" }, NO_SHADOWING_NAMES);

    await expect(rejected).rejects.toThrow();
    await accepted;

    expect(readServers()).toEqual({ good: { command: "b" } });
  });
});

describe("validation — nothing is written when a definition is rejected", () => {
  /** Every rejection must leave the file exactly as it was: absent stays absent, present stays byte-identical. */
  async function expectNoWrite(op: () => Promise<void>, message: RegExp): Promise<void> {
    const before = fs.existsSync(MCP_PATH) ? fs.readFileSync(MCP_PATH, "utf-8") : null;
    await expect(op()).rejects.toThrow(message);
    const after = fs.existsSync(MCP_PATH) ? fs.readFileSync(MCP_PATH, "utf-8") : null;
    expect(after).toBe(before);
  }

  it("rejects a missing command and writes no file at all", async () => {
    await expectNoWrite(
      () => addDamoclesMcpServer("docs", {} as McpServerConfig, NO_SHADOWING_NAMES),
      /a command is required/,
    );
    expect(fs.existsSync(MCP_PATH)).toBe(false);
  });

  it("rejects an unknown key rather than silently stripping or persisting it", async () => {
    await expectNoWrite(
      () => addDamoclesMcpServer("docs", { command: "x", lifecycle: "lazy" } as McpServerConfig, NO_SHADOWING_NAMES),
      /"lifecycle" is not a supported server option/,
    );
  });

  it.each([
    ["an empty name", "", /a server name is required/],
    ["a name with a path separator", "a/b", /may only contain letters/],
    ["a name with a space", "my server", /may only contain letters/],
    ["an untrimmed name", " docs ", /whitespace/],
    ["an over-long name", "x".repeat(65), /at most 64 characters/],
  ])("rejects %s", async (_label, name, message) => {
    await expectNoWrite(() => addDamoclesMcpServer(name, stdio, NO_SHADOWING_NAMES), message);
  });

  it.each([
    ["a non-http protocol", { type: "http", url: "file:///etc/passwd" }, /must use http or https/],
    ["an unparseable URL", { type: "sse", url: "not a url" }, /must be absolute and include a scheme/],
    ["a missing URL", { type: "http" }, /a URL is required/],
    ["a bad bearerTokenEnv", { type: "http", url: "https://x.invalid", bearerTokenEnv: "1BAD" }, /valid variable name/],
    ["an empty headers map", { type: "http", url: "https://x.invalid", headers: {} }, /headers must be omitted/],
    ["a non-string header value", { type: "http", url: "https://x.invalid", headers: { A: 1 } }, /must be a string/],
  ])("rejects a remote server with %s", async (_label, config, message) => {
    await expectNoWrite(() => addDamoclesMcpServer("docs", config as McpServerConfig, NO_SHADOWING_NAMES), message);
  });

  it.each([
    ["empty args", { command: "x", args: [] }, /arguments must be omitted/],
    ["a non-string arg", { command: "x", args: [1] }, /non-empty string/],
    ["an empty env map", { command: "x", env: {} }, /environment must be omitted/],
    ["an empty cwd", { command: "x", cwd: "" }, /a working directory is required/],
    ["a url without a remote type", { command: "x", url: "https://x.invalid" }, /must set its type/],
    ["an unknown type", { type: "grpc", url: "https://x.invalid" }, /not a supported server type/],
  ])("rejects a stdio server with %s", async (_label, config, message) => {
    await expectNoWrite(() => addDamoclesMcpServer("docs", config as McpServerConfig, NO_SHADOWING_NAMES), message);
  });
});

describe("secrets", () => {
  it("persists bearerTokenEnv as the variable NAME and never writes a bearerToken key", async () => {
    await addDamoclesMcpServer(
      "remote",
      { type: "http", url: "https://api.example.invalid/mcp", bearerTokenEnv: "EXAMPLE_API_TOKEN" },
      NO_SHADOWING_NAMES,
    );

    const raw = fs.readFileSync(MCP_PATH, "utf-8");
    expect(readServers()["remote"]).toEqual({
      type: "http",
      url: "https://api.example.invalid/mcp",
      bearerTokenEnv: "EXAMPLE_API_TOKEN",
    });
    expect(raw).toContain("EXAMPLE_API_TOKEN");
    expect(raw).not.toContain("bearerToken\"");
  });

  it("rejects a raw bearerToken without echoing the token value", async () => {
    const config = { type: "http", url: "https://api.example.invalid/mcp", bearerToken: "sk-live-SECRET" };

    await expect(addDamoclesMcpServer("remote", config as McpServerConfig, NO_SHADOWING_NAMES))
      .rejects.toThrow(/bearer token cannot be stored here/);

    expect(fs.existsSync(MCP_PATH)).toBe(false);
    const thrown = await addDamoclesMcpServer("remote", config as McpServerConfig, NO_SHADOWING_NAMES).catch(e => String(e));
    expect(thrown).not.toContain("sk-live-SECRET");
  });

  it("logs only a count, never the config, env or headers", async () => {
    await addDamoclesMcpServer(
      "docs",
      { command: "docs-server", env: { API_KEY: "sk-live-SECRET" } },
      NO_SHADOWING_NAMES,
    );

    expect(logMock).toHaveBeenCalled();
    const logged = JSON.stringify(logMock.mock.calls);
    expect(logged).not.toContain("sk-live-SECRET");
    expect(logged).not.toContain("API_KEY");
    expect(logged).not.toContain("docs-server");
    expect(logMock.mock.calls[0]).toEqual(["[McpConfigWrite] Wrote %d MCP server(s) to ~/.damocles/mcp.json", 1]);
  });
});

describe("name-collision policy", () => {
  /** The short file label the refusal must carry for each shadowing source. */
  const SHADOWING_FILE: readonly (readonly [McpServerSource, string])[] = [
    ["workspace", ".mcp.json"],
    ["damocles-local", ".damocles/mcp.local.json"],
  ];

  it.each(SHADOWING_FILE)("rejects adding a name %s already defines, naming that file", async (source, file) => {
    const err = await addDamoclesMcpServer("shared", stdio, shadowedBy(source)).catch(e => e as McpWriteError);

    expect(err).toBeInstanceOf(McpWriteError);
    // The code and params are what cross to the webview; the English message stays for the log only.
    // `.damocles/mcp.local.json` outranks `~/.damocles/mcp.json` too, so naming the wrong file would
    // send the user to edit a file that does not define the name.
    expect((err as McpWriteError).info).toEqual({ code: "nameShadowed", params: { name: "shared", file } });
    expect(fs.existsSync(MCP_PATH)).toBe(false);
  });

  it.each(SHADOWING_FILE)("rejects renaming onto a name %s defines", async (source, file) => {
    writeConfigFile(JSON.stringify({ mcpServers: { docs: { command: "old" } } }));

    const err = await updateDamoclesMcpServer("docs", "shared", stdio, shadowedBy(source))
      .catch(e => e as McpWriteError);

    expect((err as McpWriteError).info).toEqual({ code: "nameShadowed", params: { name: "shared", file } });
    expect(readServers()).toEqual({ docs: { command: "old" } });
  });

  it("puts nothing but the name and the file in the refusal, never a config value", async () => {
    // `params` is serialised to the webview and interpolated into a visible string. `env` is the usual
    // home for an MCP token, so a config value reaching it would put a credential on screen.
    const withSecret: McpServerConfig = { command: "node", env: { TOKEN: "sk-live-SUPERSECRET" } };

    const err = await addDamoclesMcpServer("shared", withSecret, shadowedBy("workspace"))
      .catch(e => e as McpWriteError);

    expect(Object.keys((err as McpWriteError).info.params ?? {}).sort()).toEqual(["file", "name"]);
    expect(JSON.stringify((err as McpWriteError).info)).not.toContain("SUPERSECRET");
  });

  it("ALLOWS adding a name only a claude/codex/claude-local import defines, with no warning", async () => {
    // Those sources rank below `~/.damocles/mcp.json`, so they never appear in the shadowing map at
    // all and the override is the intended path: the entry is simply re-tagged `damocles`.
    await addDamoclesMcpServer("imported-from-claude", stdio, NO_SHADOWING_NAMES);

    expect(readServers()).toEqual({ "imported-from-claude": stdio });
    expect(logMock.mock.calls.flat().join(" ")).not.toMatch(/warn/i);
  });

  it("rejects adding a name that already exists in ~/.damocles/mcp.json", async () => {
    writeConfigFile(JSON.stringify({ mcpServers: { docs: { command: "old" } } }));

    await expect(addDamoclesMcpServer("docs", stdio, NO_SHADOWING_NAMES))
      .rejects.toThrow(/already exists in ~\/\.damocles\/mcp\.json/);

    expect(readServers()).toEqual({ docs: { command: "old" } });
  });

  it("rejects updating a server Damocles does not own", async () => {
    writeConfigFile(JSON.stringify({ mcpServers: { docs: { command: "old" } } }));

    await expect(updateDamoclesMcpServer("from-claude", undefined, stdio, NO_SHADOWING_NAMES))
      .rejects.toThrow(/is not defined in ~\/\.damocles\/mcp\.json/);

    expect(readServers()).toEqual({ docs: { command: "old" } });
  });

  it("rejects deleting a server Damocles does not own", async () => {
    writeConfigFile(JSON.stringify({ mcpServers: { docs: { command: "old" } } }));

    await expect(deleteDamoclesMcpServer("from-codex")).rejects.toThrow(/cannot remove it/);

    expect(readServers()).toEqual({ docs: { command: "old" } });
  });
});

describe("update and delete", () => {
  it("renames in a single write, leaving exactly one entry under the new name and none under the old", async () => {
    writeConfigFile(JSON.stringify({ mcpServers: { docs: { command: "old" }, other: { command: "keep" } } }));

    await updateDamoclesMcpServer("docs", "handbook", { command: "new" }, NO_SHADOWING_NAMES);

    const servers = readServers();
    expect(Object.keys(servers).sort()).toEqual(["handbook", "other"]);
    expect(servers["handbook"]).toEqual({ command: "new" });
    expect(servers["docs"]).toBeUndefined();
  });

  it("edits in place when newServerName equals the current name", async () => {
    writeConfigFile(JSON.stringify({ mcpServers: { docs: { command: "old" } } }));

    await updateDamoclesMcpServer("docs", "docs", { command: "new", cwd: "/srv" }, NO_SHADOWING_NAMES);

    expect(readServers()).toEqual({ docs: { command: "new", cwd: "/srv" } });
  });

  it("keeps an in-place edit in its original position instead of moving it to the end of the file", async () => {
    // Cosmetic but real: churning the user's key order on every save makes their file diff noisily
    // against itself. Only a rename may move a key.
    writeConfigFile(JSON.stringify({ mcpServers: { alpha: { command: "a" }, beta: { command: "b" }, gamma: { command: "c" } } }));

    await updateDamoclesMcpServer("beta", undefined, { command: "b2" }, NO_SHADOWING_NAMES);

    expect(Object.keys(readServers())).toEqual(["alpha", "beta", "gamma"]);
  });

  it.each([
    // Genuinely unparseable (no scheme separator) — the branch that used to echo the value back.
    ["an unparseable URL", "https//user:sk-live-SECRET@example.invalid/mcp", /must be absolute and include a scheme/],
    // Parses, but the wrong protocol — a distinct branch that must also stay quiet.
    ["a non-http URL", "ftp://user:sk-live-SECRET@example.invalid/mcp", /must use http or https/],
  ])("rejects %s without echoing the value, which can carry a token", async (_label, url, message) => {
    const thrown = await addDamoclesMcpServer("remote", { type: "http", url } as McpServerConfig, NO_SHADOWING_NAMES)
      .then(() => "resolved", (e: unknown) => String(e));

    expect(thrown).toMatch(message);
    expect(thrown).not.toContain("sk-live-SECRET");
  });

  it("rejects a rename onto another Damocles-owned name rather than overwriting it", async () => {
    writeConfigFile(JSON.stringify({ mcpServers: { docs: { command: "a" }, handbook: { command: "b" } } }));

    await expect(updateDamoclesMcpServer("docs", "handbook", { command: "c" }, NO_SHADOWING_NAMES))
      .rejects.toThrow(/already exists in ~\/\.damocles\/mcp\.json/);

    expect(readServers()).toEqual({ docs: { command: "a" }, handbook: { command: "b" } });
  });

  it("removes only the named server and preserves unknown top-level keys", async () => {
    writeConfigFile(JSON.stringify({
      $schema: "keep",
      mcpServers: { docs: { command: "a" }, other: { command: "b" } },
    }));

    await deleteDamoclesMcpServer("docs");

    expect(readConfigFile()["$schema"]).toBe("keep");
    expect(readServers()).toEqual({ other: { command: "b" } });
  });
});
