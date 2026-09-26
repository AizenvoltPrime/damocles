import { describe, it, expect, beforeEach, vi } from "vitest";

const H = vi.hoisted(() => ({ load: vi.fn(), log: vi.fn() }));

vi.mock("../../../../pi-session/session-store/tool-result-images", () => ({ loadToolResultImages: H.load }));
vi.mock("../../../../logger", () => ({ log: H.log }));

import { createHistoryHandlers } from "../history-handlers";
import type { HandlerDependencies, HandlerContext } from "../../types";
import type { ExtensionToWebviewMessage } from "../../../../../shared/types/messages";
import type { ImageBlock } from "../../../../../shared/types/content";

const PNG: ImageBlock = { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } };

function setup(opts: { cached?: ImageBlock[]; sessionId?: string | null } = {}) {
  const posted: ExtensionToWebviewMessage[] = [];
  const deps = {
    postMessage: vi.fn((_host: unknown, msg: ExtensionToWebviewMessage) => { posted.push(msg); }),
  } as unknown as HandlerDependencies;
  const session = {
    persistenceSessionId: opts.sessionId === undefined ? "sess-1" : opts.sessionId,
    unpersistedToolResultImages: vi.fn(() => opts.cached),
  };
  const ctx = { host: {}, session, folder: { fsPath: "/ws" } } as unknown as HandlerContext;
  const handler = createHistoryHandlers(deps).requestToolResultImages!;
  const send = (msg: Record<string, unknown>) =>
    handler({ type: "requestToolResultImages", requestId: "r1", toolUseId: "call|1", owner: { kind: "session" }, ...msg } as never, ctx);
  return { send, posted, session };
}

describe("requestToolResultImages", () => {
  beforeEach(() => {
    H.load.mockReset();
    H.log.mockReset();
  });

  it("serves the unpersisted cache without touching the session file", async () => {
    const { send, posted } = setup({ cached: [PNG] });
    await send({});
    expect(H.load).not.toHaveBeenCalled();
    expect(posted).toEqual([{ type: "toolResultImages", requestId: "r1", images: [PNG] }]);
  });

  it("reads the session file for a main-session owner and echoes the requestId", async () => {
    H.load.mockResolvedValue([PNG]);
    const { send, posted } = setup();
    await send({ requestId: "r7" });
    expect(H.load).toHaveBeenCalledWith("/ws", "sess-1", "call|1", { kind: "session" });
    expect(posted).toEqual([{ type: "toolResultImages", requestId: "r7", images: [PNG] }]);
  });

  it.each<[string, Record<string, unknown>]>([
    ["an empty toolUseId", { toolUseId: "" }],
    ["a non-string toolUseId", { toolUseId: 42 }],
    ["a toolUseId over 512 characters", { toolUseId: "x".repeat(513) }],
    ["a toolUseId with a control character", { toolUseId: "call\n1" }],
    ["a missing owner", { owner: undefined }],
    ["an unknown owner kind", { owner: { kind: "disk" } }],
  ])("replies [] without reading for %s", async (_label, msg) => {
    const { send, posted, session } = setup({ cached: [PNG] });
    await send(msg);
    expect(H.load).not.toHaveBeenCalled();
    expect(session.unpersistedToolResultImages).not.toHaveBeenCalled();
    expect(posted).toEqual([{ type: "toolResultImages", requestId: "r1", images: [] }]);
  });

  it.each<[string, unknown]>([
    ["a missing requestId", undefined],
    ["an empty requestId", ""],
    ["a requestId over 128 characters", "r".repeat(129)],
  ])("drops and logs a request with %s", async (_label, requestId) => {
    const { send, posted } = setup();
    await send({ requestId });
    expect(posted).toEqual([]);
    expect(H.log).toHaveBeenCalled();
  });

  it.each<[string, Record<string, string>]>([
    ["a subagent", { kind: "subagent", agentId: "agent-1" }],
    ["a team member", { kind: "team", teamId: "team-1", agentId: "member-1" }],
  ])("passes %s owner to the finder", async (_label, owner) => {
    H.load.mockResolvedValue([PNG]);
    const { send, posted } = setup();
    await send({ owner });
    expect(H.load).toHaveBeenCalledWith("/ws", "sess-1", "call|1", owner);
    expect(posted).toEqual([{ type: "toolResultImages", requestId: "r1", images: [PNG] }]);
  });

  it.each<[string, Record<string, unknown>]>([
    ["an unsafe subagent id", { kind: "subagent", agentId: "../../etc" }],
    ["a missing subagent id", { kind: "subagent" }],
    ["an unsafe team id", { kind: "team", teamId: "team/../x", agentId: "member-1" }],
    ["an unsafe team member id", { kind: "team", teamId: "team-1", agentId: "a b" }],
    ["a subagent id over 128 characters", { kind: "subagent", agentId: "a".repeat(129) }],
    ["a team id over 128 characters", { kind: "team", teamId: "t".repeat(129), agentId: "member-1" }],
  ])("replies [] without reading for %s", async (_label, owner) => {
    const { send, posted } = setup();
    await send({ owner });
    expect(H.load).not.toHaveBeenCalled();
    expect(posted).toEqual([{ type: "toolResultImages", requestId: "r1", images: [] }]);
  });

  it("replies [] when the panel has no persisted session", async () => {
    const { send, posted } = setup({ sessionId: null });
    await send({});
    expect(H.load).not.toHaveBeenCalled();
    expect(posted).toEqual([{ type: "toolResultImages", requestId: "r1", images: [] }]);
  });

  it("replies [] and logs when the unpersisted cache lookup throws", async () => {
    const { send, posted, session } = setup();
    session.unpersistedToolResultImages.mockImplementation(() => { throw new Error("disposed"); });
    await send({});
    expect(H.load).not.toHaveBeenCalled();
    expect(posted).toEqual([{ type: "toolResultImages", requestId: "r1", images: [] }]);
    expect(H.log).toHaveBeenCalledWith(expect.stringContaining("[HistoryHandlers]"), "call|1", expect.any(Error));
  });

  it("replies [] and logs when reading fails", async () => {
    H.load.mockRejectedValue(new Error("EACCES"));
    const { send, posted } = setup();
    await send({});
    expect(posted).toEqual([{ type: "toolResultImages", requestId: "r1", images: [] }]);
    expect(H.log).toHaveBeenCalledWith(expect.stringContaining("[HistoryHandlers]"), "call|1", expect.any(Error));
  });
});
