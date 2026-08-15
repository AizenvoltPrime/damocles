import { describe, it, expect, beforeEach, vi } from "vitest";

/** Captured so a rejection can be proved never to log the config it rejected. */
const logMock = vi.hoisted(() => vi.fn());
vi.mock("../../../../logger", () => ({ log: logMock }));

import { createSettingsHandlers } from "../settings-handlers";
import { McpWriteError } from "../../../settings-manager/managers/mcp-config-write";
import type { HandlerDependencies, HandlerContext } from "../../types";
import type { ExtensionToWebviewMessage, WebviewToExtensionMessage } from "../../../../../shared/types/messages";

/**
 * The three `~/.damocles/mcp.json` handlers. What matters here is the *wiring* the brief specifies —
 * that a successful write reloads the merged config and re-feeds the live session (so the change lands
 * with no window reload), that every attempt is acknowledged (the form holds the user's typed
 * definition until it is), and that a rejected write touches none of that while still re-pushing status
 * so the panel can never be left showing a state that never happened. The write itself and the rules it
 * enforces are covered in `settings-manager/managers/__tests__/mcp-config-write.test.ts`.
 */
function setup(failure?: Error) {
  const calls: string[] = [];
  const posted: ExtensionToWebviewMessage[] = [];
  const fedServers: Record<string, unknown>[] = [];

  const mutation = vi.fn(async () => {
    calls.push("write");
    if (failure) throw failure;
  });

  const settingsManager = {
    addMcpServer: mutation,
    updateMcpServer: mutation,
    deleteMcpServer: mutation,
    loadMcpConfig: vi.fn(async () => { calls.push("loadMcpConfig"); }),
    getEnabledMcpServers: vi.fn(() => ({ docs: { command: "docs-server" } })),
    buildMcpConfigUpdate: vi.fn(() => {
      calls.push("buildMcpConfigUpdate");
      return { type: "mcpConfigUpdate", servers: [], configErrors: [] } as const;
    }),
    sendMcpStatus: vi.fn(async () => { calls.push("sendMcpStatus"); }),
  };

  const host = {};
  const deps = {
    postMessage: (_host: unknown, msg: ExtensionToWebviewMessage) => { posted.push(msg); },
    settingsManager,
    // One open panel, so the config refresh can be observed as a broadcast rather than a targeted post.
    getPanels: () => new Map([["panel-1", { host }]]),
  } as unknown as HandlerDependencies;

  const ctx = {
    host,
    session: {
      setMcpServers: (servers: Record<string, unknown>) => { calls.push("setMcpServers"); fedServers.push(servers); },
    },
  } as unknown as HandlerContext;

  const handlers = createSettingsHandlers(deps);
  const run = (msg: WebviewToExtensionMessage) => handlers[msg.type]!(msg, ctx);
  return { run, calls, posted, fedServers, settingsManager, mutation };
}

const STDIO = { command: "docs-server" } as const;
const REQ = "req-1";

const acks = (posted: ExtensionToWebviewMessage[]) =>
  posted.filter((m): m is Extract<ExtensionToWebviewMessage, { type: "mcpWriteResult" }> => m.type === "mcpWriteResult");

beforeEach(() => logMock.mockClear());

describe("mcpAddServer / mcpUpdateServer / mcpDeleteServer — success", () => {
  it("writes, reloads the merged config, re-feeds the live session, refreshes panels, then acknowledges", async () => {
    const { run, calls, posted, fedServers } = setup();

    await run({ type: "mcpAddServer", requestId: REQ, serverName: "docs", config: STDIO });

    expect(calls).toEqual([
      "write", "loadMcpConfig", "setMcpServers", "buildMcpConfigUpdate", "sendMcpStatus",
    ]);
    expect(fedServers[0]).toEqual({ docs: { command: "docs-server" } });
    expect(acks(posted)).toEqual([{ type: "mcpWriteResult", requestId: REQ, ok: true }]);
  });

  it("broadcasts the refreshed config rather than posting it only to the acting panel", async () => {
    const { run, posted } = setup();

    // The watcher cannot be relied on to reach the other panels: it watches the *directory* of the
    // user-global files, and a non-recursive watcher over a directory that did not exist when it was
    // created never fires. A second panel would then act on a list missing this write.
    await run({ type: "mcpAddServer", requestId: REQ, serverName: "docs", config: STDIO });

    expect(posted.filter(m => m.type === "mcpConfigUpdate")).toHaveLength(1);
  });

  it("passes the pre-rename name and the new name through to the update", async () => {
    const { run, settingsManager } = setup();

    await run({ type: "mcpUpdateServer", requestId: REQ, serverName: "docs", newServerName: "handbook", config: STDIO });

    expect(settingsManager.updateMcpServer).toHaveBeenCalledWith("docs", "handbook", STDIO);
  });

  it("passes undefined as the new name for an in-place edit", async () => {
    const { run, settingsManager } = setup();

    await run({ type: "mcpUpdateServer", requestId: REQ, serverName: "docs", config: STDIO });

    expect(settingsManager.updateMcpServer).toHaveBeenCalledWith("docs", undefined, STDIO);
  });

  it("applies the same reload-and-refeed sequence on delete", async () => {
    const { run, calls, settingsManager } = setup();

    await run({ type: "mcpDeleteServer", requestId: REQ, serverName: "docs" });

    expect(settingsManager.deleteMcpServer).toHaveBeenCalledWith("docs");
    expect(calls).toEqual([
      "write", "loadMcpConfig", "setMcpServers", "buildMcpConfigUpdate", "sendMcpStatus",
    ]);
  });
});

describe("mcpAddServer / mcpUpdateServer / mcpDeleteServer — rejection", () => {
  it("acknowledges the failure with a translatable code and does not reload or re-feed anything", async () => {
    const { run, calls, posted } = setup(
      new McpWriteError("nameExists", '"docs" already exists in ~/.damocles/mcp.json', { name: "docs" }),
    );

    await run({ type: "mcpAddServer", requestId: REQ, serverName: "docs", config: STDIO });

    expect(calls).toEqual(["write", "sendMcpStatus"]);
    expect(acks(posted)).toEqual([
      { type: "mcpWriteResult", requestId: REQ, ok: false, error: { code: "nameExists", params: { name: "docs" } } },
    ]);
    // No notification: the panel renders the reason inline against the still-open form, and a toast
    // as well would say the same thing twice.
    expect(posted.filter(m => m.type === "notification")).toHaveLength(0);
  });

  it("reports an unexpected failure as writeFailed rather than dropping the acknowledgement", async () => {
    // A missing ack strands the dialog open forever, so every path must produce exactly one.
    const { run, posted } = setup(new Error("EACCES: permission denied"));

    await run({ type: "mcpAddServer", requestId: REQ, serverName: "docs", config: STDIO });

    expect(acks(posted)).toHaveLength(1);
    expect(acks(posted)[0]).toMatchObject({ ok: false, error: { code: "writeFailed" } });
  });

  it.each([
    ["mcpAddServer", { type: "mcpAddServer", requestId: REQ, serverName: "docs", config: STDIO }],
    ["mcpUpdateServer", { type: "mcpUpdateServer", requestId: REQ, serverName: "docs", config: STDIO }],
    ["mcpDeleteServer", { type: "mcpDeleteServer", requestId: REQ, serverName: "docs" }],
  ] as const)("re-pushes status after a failed %s so the panel cannot show an optimistic state", async (_l, msg) => {
    const { run, calls, posted } = setup(new Error("boom"));

    await run(msg as WebviewToExtensionMessage);

    expect(calls.at(-1)).toBe("sendMcpStatus");
    expect(acks(posted)).toHaveLength(1);
    expect(acks(posted)[0]?.ok).toBe(false);
  });

  it("logs the server name and the reason, never the config it rejected", async () => {
    const { run } = setup(new Error("rejected"));

    await run({
      type: "mcpAddServer",
      requestId: REQ,
      serverName: "docs",
      config: { command: "docs-server", env: { API_KEY: "sk-live-SECRET" } },
    });

    const logged = JSON.stringify(logMock.mock.calls);
    expect(logged).toContain("docs");
    expect(logged).not.toContain("sk-live-SECRET");
    expect(logged).not.toContain("API_KEY");
  });

  it("never puts the rejected config in the acknowledgement either", async () => {
    const { run, posted } = setup(new Error("rejected"));

    await run({
      type: "mcpAddServer",
      requestId: REQ,
      serverName: "docs",
      config: { command: "docs-server", env: { API_KEY: "sk-live-SECRET" } },
    });

    expect(JSON.stringify(acks(posted))).not.toContain("sk-live-SECRET");
  });
});
