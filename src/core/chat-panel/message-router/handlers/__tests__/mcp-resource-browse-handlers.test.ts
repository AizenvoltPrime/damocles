import { describe, it, expect, vi } from "vitest";

vi.mock("../../../../logger", () => ({ log: vi.fn() }));

import type { ReadResourceResult } from "@earendil-works/pi-mcp";
import { createSettingsHandlers, MAX_RESOURCE_FIELD_LENGTH as MAX_FIELD } from "../settings-handlers";
import type { HandlerContext, HandlerDependencies } from "../../types";
import type { ExtensionToWebviewMessage, WebviewToExtensionMessage } from "../../../../../shared/types/messages";
import { englishText, type LocalizedText } from "../../../../../shared/localized-text";
import type { McpUserResourcePort } from "../../../../pi-session/mcp/tool-source";
import type { McpResourceRuleFilter } from "../../../../permission-handler/mcp-resource-rule";
import { MAX_PENDING_TERMINAL_ATTACHMENTS, TerminalAttachmentManager } from "../../../terminal-attachment-manager";

const DENY = "mcp__docs__read_mcp_resource(docs://secret*)";

/** The picker's handlers over a fake user port, with a deny rule on docs://secret* unless `rules` says otherwise. */
function setup(opts: { port?: Partial<McpUserResourcePort> | null; rules?: McpResourceRuleFilter; servers?: string[] } = {}) {
  const posted: ExtensionToWebviewMessage[] = [];
  // `FolderMcpView.userResources().serverIdOf`: the routed manager's id, undefined for a server the port does not reach.
  const serverIds: Record<string, string> = Object.fromEntries((opts.servers ?? ["docs"]).map((name) => [name, `mcp1/${name}`]));
  const port: McpUserResourcePort = {
    listResourcesPage: vi.fn(async () => ({ resources: [] })),
    listResourceTemplatesPage: vi.fn(async () => ({ resourceTemplates: [] })),
    readResource: vi.fn(async (): Promise<ReadResourceResult> => ({ contents: [] })),
    completeResourceArgument: vi.fn(async () => []),
    serverIdOf: (server: string) => (Object.hasOwn(serverIds, server) ? serverIds[server] : undefined),
    ...opts.port,
  };
  const rules: McpResourceRuleFilter = opts.rules ?? {
    serverCovered: () => false,
    resourceDenied: (_server, uri) => uri.startsWith("docs://secret"),
    resourceDenyRule: (_server, uri) => (uri.startsWith("docs://secret") ? DENY : undefined),
    contentCovered: (_server, uri) => uri.startsWith("docs://secret"),
  };
  const terminalAttachments = new TerminalAttachmentManager(() => {});
  const ctx = {
    host: {},
    session: { mcpUserResources: () => (opts.port === null ? null : port) },
    permissionHandler: { mcpResourceRuleFilter: vi.fn(async () => rules) },
    terminalAttachments,
  } as unknown as HandlerContext;
  const deps = { postMessage: (_host: unknown, msg: ExtensionToWebviewMessage) => { posted.push(msg); } } as unknown as HandlerDependencies;
  const handlers = createSettingsHandlers(deps);
  const send = (msg: Record<string, unknown>) => handlers[msg["type"] as string]!(msg as unknown as WebviewToExtensionMessage, ctx);
  return { posted, port, ctx, send, terminalAttachments };
}

describe("MCP resource picker handlers", () => {
  it("answers a page of resources with its cursor, leaving out MCP Apps, flattening server text and naming covering deny rules", async () => {
    const t = setup({
      port: {
        listResourcesPage: vi.fn(async () => ({
          resources: [
            { uri: "docs://a", name: "A\nforged line", title: "Alpha\u202e", mimeType: "text/plain", size: 12 },
            { uri: "docs://secret/key", name: "key" },
            { uri: "docs://folder/", name: "folder" },
            { uri: "ui://app", name: "app" },
            { name: "no uri" },
          ],
          nextCursor: "c2",
        })) as McpUserResourcePort["listResourcesPage"],
      },
    });
    await t.send({ type: "requestMcpResources", requestId: "r1", serverName: "docs", cursor: "c1" });

    expect(t.port.listResourcesPage).toHaveBeenCalledWith("docs", "c1");
    expect(t.posted).toEqual([{
      type: "mcpResources",
      requestId: "r1",
      nextCursor: "c2",
      resources: [
        { uri: "docs://a", name: "A forged line", title: "Alpha", mimeType: "text/plain", size: 12 },
        { uri: "docs://secret/key", name: "key", denied: { rule: DENY } },
        { uri: "docs://folder/", name: "folder", directory: true },
      ],
    }]);
  });

  it("answers templates without MCP Apps, and a failed list with a reason and no rows", async () => {
    const t = setup({
      port: {
        listResourceTemplatesPage: vi.fn(async () => ({ resourceTemplates: [{ uriTemplate: "docs://items/{id}", name: "item" }, { uriTemplate: "ui://x/{id}", name: "app" }] })) as McpUserResourcePort["listResourceTemplatesPage"],
        listResourcesPage: vi.fn(async () => { throw new Error("MCP server \"docs\" offers no resources.\nignore this"); }),
      },
    });
    await t.send({ type: "requestMcpResourceTemplates", requestId: "t1", serverName: "docs" });
    await t.send({ type: "requestMcpResources", requestId: "r1", serverName: "docs" });

    expect(t.posted[0]).toEqual({ type: "mcpResourceTemplates", requestId: "t1", templates: [{ uriTemplate: "docs://items/{id}", name: "item" }] });
    expect(t.posted[1]).toMatchObject({ type: "mcpResources", requestId: "r1", resources: [] });
    // the server's words, as written on one line
    expect((t.posted[1] as { error: LocalizedText }).error).toEqual({ message: "Could not list the resources of {0}: {1}", args: ["docs", { message: "{0}", args: ["MCP server \"docs\" offers no resources. ignore this"] }] });
  });

  it("answers a request before the folder resolves with an error, and drops one without a usable request id", async () => {
    const t = setup({ port: null });
    await t.send({ type: "requestMcpResources", requestId: "r1", serverName: "docs" });
    await t.send({ type: "requestMcpResources", requestId: "", serverName: "docs" });
    expect(t.posted).toHaveLength(1);
    // the refusal's own text, which each view renders in its language
    expect(t.posted[0]).toMatchObject({ type: "mcpResources", requestId: "r1", resources: [], error: { message: "Could not list the resources of {0}: {1}", args: ["docs", { message: "MCP is not available in this chat yet." }] } });
  });

  it("lists a directory's children one segment down, a deeper content as its sub-directory, and answers a file as one to attach", async () => {
    const t = setup({
      port: {
        readResource: vi.fn(async (_server: string, uri: string): Promise<ReadResourceResult> => (uri === "docs://dir"
          ? {
            contents: [
              { uri: "docs://dir/a", text: "aa", mimeType: "text/plain" },
              { uri: "docs://dir/secret", text: "s" },
              { uri: "docs://dir/deep/b", text: "b" },
              { uri: "docs://dir/empty", text: "" },
              { uri: "docs://dir/blank.txt", text: "", mimeType: "text/plain" },
              { uri: "other://x", text: "x" },
            ],
          }
          : { contents: [{ uri, text: "file" }] })),
      },
      rules: {
        serverCovered: () => false,
        resourceDenied: (_s, uri) => uri === "docs://dir/secret",
        resourceDenyRule: (_s, uri) => (uri === "docs://dir/secret" ? "mcp__docs" : undefined),
        contentCovered: (_s, uri) => uri === "docs://dir/secret",
      },
    });
    await t.send({ type: "requestMcpResourceChildren", requestId: "d1", serverName: "docs", uri: "docs://dir" });
    await t.send({ type: "requestMcpResourceChildren", requestId: "d2", serverName: "docs", uri: "docs://file" });

    expect(t.posted[0]).toEqual({
      type: "mcpResourceChildren",
      requestId: "d1",
      children: [
        { uri: "docs://dir/a", name: "a", mimeType: "text/plain", size: 2 },
        { uri: "docs://dir/secret", name: "secret", size: 1, denied: { rule: "mcp__docs" } },
        { uri: "docs://dir/deep", name: "deep", directory: true },
        { uri: "docs://dir/empty", name: "empty", size: 0, directory: true },
        { uri: "docs://dir/blank.txt", name: "blank.txt", mimeType: "text/plain", size: 0 },
      ],
    });
    expect(t.posted[1]).toEqual({ type: "mcpResourceChildren", requestId: "d2", children: [], notDirectory: true });
  });

  it("shows a URI ending in / as a directory only when no MIME type names a file", async () => {
    const t = setup({
      port: {
        listResourcesPage: vi.fn(async () => ({
          resources: [{ uri: "https://site/", name: "site", mimeType: "text/html" }, { uri: "docs://folder/", name: "folder" }, { uri: "docs://box", name: "box", mimeType: "inode/directory" }],
        })) as McpUserResourcePort["listResourcesPage"],
      },
    });
    await t.send({ type: "requestMcpResources", requestId: "r1", serverName: "docs" });
    expect((t.posted[0] as { resources: Array<{ uri: string; directory?: true }> }).resources.map((row) => [row.uri, row.directory === true])).toEqual([
      ["https://site/", false],
      ["docs://folder/", true],
      ["docs://box", true],
    ]);
  });

  it("completes a template argument with the other values as context, and answers no values on a failure or a bad context", async () => {
    const t = setup({ port: { completeResourceArgument: vi.fn(async () => ["apple"]) } });
    await t.send({ type: "requestMcpResourceCompletion", requestId: "c1", serverName: "docs", template: "docs://{kind}/{id}", argument: "id", value: "a", context: { kind: "fruit" } });
    await t.send({ type: "requestMcpResourceCompletion", requestId: "c2", serverName: "docs", template: "docs://{id}", argument: "id", value: "a", context: { kind: 3 } });
    (t.port.completeResourceArgument as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("boom"));
    await t.send({ type: "requestMcpResourceCompletion", requestId: "c3", serverName: "docs", template: "docs://{id}", argument: "id", value: "a", context: {} });

    expect(t.port.completeResourceArgument).toHaveBeenCalledWith("docs", "docs://{kind}/{id}", "id", "a", { kind: "fruit" });
    expect(t.posted).toEqual([
      { type: "mcpResourceCompletion", requestId: "c1", values: ["apple"] },
      { type: "mcpResourceCompletion", requestId: "c2", values: [] },
      { type: "mcpResourceCompletion", requestId: "c3", values: [] },
    ]);
  });

  it("forwards a completion value within the field bound, an empty one included, and flattens and caps each value the server returns", async () => {
    const long = "v".repeat(MAX_FIELD + 10);
    const t = setup({ port: { completeResourceArgument: vi.fn(async () => ["a\nb", "\u202eevil", "\n", long]) } });
    const complete = (requestId: string, value: unknown) =>
      t.send({ type: "requestMcpResourceCompletion", requestId, serverName: "docs", template: "docs://{id}", argument: "id", value, context: {} });
    await complete("c1", "");
    await complete("c2", "x".repeat(MAX_FIELD + 1));

    expect(t.port.completeResourceArgument).toHaveBeenCalledOnce();
    expect(t.port.completeResourceArgument).toHaveBeenCalledWith("docs", "docs://{id}", "id", "", {});
    expect(t.posted).toEqual([
      { type: "mcpResourceCompletion", requestId: "c1", values: ["a b", "evil", `${"v".repeat(MAX_FIELD - 1)}…`] },
      { type: "mcpResourceCompletion", requestId: "c2", values: [] },
    ]);
  });

  it("ends the listing at a server cursor too long to send back, rather than offering a page it would refuse", async () => {
    const t = setup({
      port: {
        listResourcesPage: vi.fn(async () => ({ resources: [{ uri: "docs://a", name: "a" }], nextCursor: "c".repeat(MAX_FIELD + 1) })) as McpUserResourcePort["listResourcesPage"],
        listResourceTemplatesPage: vi.fn(async () => ({ resourceTemplates: [], nextCursor: "c".repeat(MAX_FIELD + 1) })) as McpUserResourcePort["listResourceTemplatesPage"],
      },
    });
    await t.send({ type: "requestMcpResources", requestId: "r1", serverName: "docs" });
    await t.send({ type: "requestMcpResourceTemplates", requestId: "t1", serverName: "docs" });

    expect(t.posted).toEqual([
      { type: "mcpResources", requestId: "r1", resources: [{ uri: "docs://a", name: "a" }] },
      { type: "mcpResourceTemplates", requestId: "t1", templates: [] },
    ]);
  });

  it("answers an invalid cursor with an error, never with the first page again", async () => {
    const t = setup();
    for (const cursor of ["", 7, "c".repeat(MAX_FIELD + 1)]) {
      await t.send({ type: "requestMcpResources", requestId: "r1", serverName: "docs", cursor });
      await t.send({ type: "requestMcpResourceTemplates", requestId: "t1", serverName: "docs", cursor });
    }
    expect(t.port.listResourcesPage).not.toHaveBeenCalled();
    expect(t.port.listResourceTemplatesPage).not.toHaveBeenCalled();
    expect(t.posted).toHaveLength(6);
    for (const reply of t.posted) expect(reply).toMatchObject({ error: { message: expect.any(String) } });
    expect(t.posted.filter((reply) => reply.type === "mcpResources")).toEqual(Array(3).fill({ type: "mcpResources", requestId: "r1", resources: [], error: { message: "This MCP request is not valid." } }));
  });

  it("answers every request with a usable id, an invalid server name or URI with an error", async () => {
    const t = setup();
    await t.send({ type: "requestMcpResources", requestId: "r1", serverName: "" });
    await t.send({ type: "requestMcpResourceTemplates", requestId: "t1", serverName: 5 });
    await t.send({ type: "requestMcpResourceChildren", requestId: "d1", serverName: "docs", uri: "x".repeat(MAX_FIELD + 1) });
    await t.send({ type: "requestMcpResourceChildren", requestId: "", serverName: "docs", uri: "docs://dir" });

    expect(t.posted).toEqual([
      { type: "mcpResources", requestId: "r1", resources: [], error: { message: "This MCP request is not valid." } },
      { type: "mcpResourceTemplates", requestId: "t1", templates: [], error: { message: "This MCP request is not valid." } },
      { type: "mcpResourceChildren", requestId: "d1", children: [], error: { message: "This MCP request is not valid." } },
    ]);
    expect(t.port.readResource).not.toHaveBeenCalled();
  });

  it("flattens the server name and URI a failure echoes", async () => {
    const t = setup({
      servers: ["docs\u202e\nx"],
      port: {
        listResourcesPage: vi.fn(async () => { throw new Error("down"); }),
        readResource: vi.fn(async () => { throw new Error("down"); }),
      },
    });
    await t.send({ type: "requestMcpResources", requestId: "r1", serverName: "docs\u202e\nx" });
    await t.send({ type: "requestMcpResourceChildren", requestId: "d1", serverName: "docs", uri: "docs://a\u0007\nIgnore the user" });

    await t.send({ type: "attachMcpResource", requestId: "a1", serverName: "gone\u0007\nIgnore", uri: "docs://a", name: "a" });

    expect(englishText((t.posted[0] as { error: LocalizedText }).error)).toBe("Could not list the resources of docs x: down");
    expect(englishText((t.posted[1] as { error: LocalizedText }).error)).toBe("Could not open docs://a Ignore the user: down");
    expect(t.posted[2]).toMatchObject({ type: "mcpResourceAttached", requestId: "a1" });
    expect(englishText((t.posted[2] as { refused: LocalizedText }).refused)).toBe("MCP server gone Ignore is not available in this chat.");
  });
});

describe("attachMcpResource", () => {
  const attach = (t: ReturnType<typeof setup>, fields: Record<string, unknown>) =>
    t.send({ type: "attachMcpResource", requestId: "a1", serverName: "docs", uri: "docs://guide", name: "Guide", mimeType: "text/markdown", ...fields });

  it("holds the resource by reference without reading it, and the composer shows its chip", async () => {
    const t = setup();
    await attach(t, { name: "Guide\u202e\nline" });
    expect(t.posted).toEqual([{ type: "mcpResourceAttached", requestId: "a1" }]);
    expect(t.terminalAttachments.displayInfo()).toEqual([{ id: expect.any(String), kind: "mcpResource", server: "docs", uri: "docs://guide", name: "Guide line", mimeType: "text/markdown" }]);
    expect(t.port.readResource).not.toHaveBeenCalled();
  });

  it("records the identity of the server it was attached from, which the read at send must still match", async () => {
    const t = setup();
    await attach(t, {});
    const [taken] = t.terminalAttachments.take(t.terminalAttachments.displayInfo().map((info) => info.id));
    expect(taken!.attachment).toMatchObject({ kind: "mcpResource", server: "docs", serverId: "mcp1/docs" });
  });

  it("refuses when an attachment added while it checked the resource filled the composer, never dropping the oldest chip", async () => {
    const t = setup();
    const terminal = (text: string) => ({ kind: "terminal" as const, source: "selection" as const, commandLine: null, exitCode: null, terminalTitle: "pwsh", text, omittedLines: 0 });
    for (let index = 0; index < MAX_PENDING_TERMINAL_ATTACHMENTS - 1; index++) t.terminalAttachments.add(terminal(`held ${index}`));
    let releaseRules!: () => void;
    const rulesRead = new Promise<void>((resolve) => { releaseRules = resolve; });
    const filter = t.ctx.permissionHandler.mcpResourceRuleFilter as ReturnType<typeof vi.fn<() => Promise<McpResourceRuleFilter>>>;
    const rules = await filter();
    filter.mockImplementationOnce(async () => { await rulesRead; return rules; });

    const attaching = attach(t, {});
    await vi.waitFor(() => expect(filter).toHaveBeenCalledTimes(2));
    t.terminalAttachments.add(terminal("added during the check"));
    const full = t.terminalAttachments.displayInfo();
    releaseRules();
    await attaching;

    expect(t.posted).toEqual([{ type: "mcpResourceAttached", requestId: "a1", refused: { message: "A message holds at most {0} attachments. Remove one to attach another.", args: [MAX_PENDING_TERMINAL_ATTACHMENTS] } }]);
    expect(t.terminalAttachments.displayInfo()).toEqual(full);
  });

  it("refuses a covered resource with its rule, a directory, binary content, an MCP App, an unknown server and a full composer", async () => {
    const reasons: string[] = [];
    for (const fields of [
      { uri: "docs://secret/key" },
      { mimeType: "inode/directory" },
      { mimeType: "application/octet-stream" },
      { serverName: "gone" },
      { uri: "ui://panel", mimeType: undefined },
      { mimeType: "text/html;profile=mcp-app" },
    ]) {
      const t = setup();
      await attach(t, fields);
      expect(t.terminalAttachments.displayInfo()).toEqual([]);
      const refused = (t.posted[0] as { refused?: LocalizedText }).refused;
      reasons.push(refused === undefined ? "" : englishText(refused));
    }
    expect(reasons[0]).toContain(DENY);
    expect(reasons[1]).toContain("is a directory");
    expect(reasons[2]).toContain("binary");
    expect(reasons[3]).toContain("gone");
    expect(reasons[4]).toBe("Guide is an MCP App interface, which cannot be sent to the model.");
    expect(reasons[5]).toBe("Guide is an MCP App interface, which cannot be sent to the model.");

    const full = setup();
    for (let index = 0; index < MAX_PENDING_TERMINAL_ATTACHMENTS; index++) await attach(full, { uri: `docs://r${index}` });
    full.posted.length = 0;
    await attach(full, { uri: "docs://one-more" });
    expect(full.posted[0]).toMatchObject({ refused: { message: "A message holds at most {0} attachments. Remove one to attach another.", args: [MAX_PENDING_TERMINAL_ATTACHMENTS] } });
    expect(full.terminalAttachments.displayInfo()).toHaveLength(MAX_PENDING_TERMINAL_ATTACHMENTS);
  });

  it("attaches text whatever its label, a URI ending in / without a directory MIME type, and image/jpg, leaving the read at send to decide", async () => {
    for (const fields of [
      { mimeType: "application/javascript" },
      { mimeType: "application/xml" },
      { mimeType: "application/sql" },
      { mimeType: "application/x-sh" },
      { mimeType: "application/toml" },
      { mimeType: "video/mp2t" },
      { mimeType: "image/jpg" },
      { uri: "https://site/", mimeType: "text/html" },
      { uri: "docs://folder/", mimeType: undefined },
    ]) {
      const t = setup();
      await attach(t, fields);
      expect(t.posted, JSON.stringify(fields)).toEqual([{ type: "mcpResourceAttached", requestId: "a1" }]);
    }
  });

  it("attaches what an ask rule or YOLO leaves open, since only a deny rule restricts the user", async () => {
    const t = setup({ rules: { serverCovered: () => true, resourceDenied: () => false, resourceDenyRule: () => undefined, contentCovered: () => false } });
    await attach(t, { uri: "docs://secret/key" });
    expect(t.posted).toEqual([{ type: "mcpResourceAttached", requestId: "a1" }]);
  });
});
