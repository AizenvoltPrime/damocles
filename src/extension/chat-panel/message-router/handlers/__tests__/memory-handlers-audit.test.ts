import { describe, it, expect, vi } from "vitest";
import { createMemoryHandlers, MEMORY_MESSAGE_SOURCES } from "../memory-handlers";
import type { HandlerDependencies, HandlerContext } from "../../types";
import type { HostInstance } from "../../../types";
import type { ExtensionToWebviewMessage } from "../../../../../shared/types/messages";
import type { MemoryAuditStatePayload, MemoryAuditSummary } from "../../../../../shared/types/memory-audit";

const STATE: MemoryAuditStatePayload = {
  run: null,
  proposals: [],
  estimate: { memoryCount: 0, profileCount: 0, batchCount: 0, inputTokens: 0, outputTokens: 0, model: null, unpriced: false, costUsd: null },
  hasAnyRun: false,
  eligibleCount: 0,
  startEndsLatestRun: false,
};

const SUMMARY: MemoryAuditSummary = { hasAnyRun: false, eligibleCount: 0, running: false, runningHere: false, pendingCount: 0 };

function makeHarness(overrides: Record<string, unknown> = {}) {
  const sent: Array<{ host: string; message: ExtensionToWebviewMessage }> = [];
  const memoryService = {
    isEnabled: true,
    ensureInitialized: vi.fn(async () => {}),
    getAuditState: vi.fn((): MemoryAuditStatePayload | null => STATE),
    getAuditSummary: vi.fn((): MemoryAuditSummary | null => SUMMARY),
    startAudit: vi.fn(async () => ({ started: true as const })),
    cancelAudit: vi.fn(async () => "cancelled" as const),
    applyAudit: vi.fn(async () => ({ applied: 1, stale: 2, rejected: 3 })),
    revertAudit: vi.fn(async () => ({ reverted: 1, skipped: 4 })),
    getPanelMemories: vi.fn(() => []),
    getObservationPage: vi.fn(() => ({ entries: [], hasMore: false, nextCursor: null })),
    getProfile: vi.fn(() => ({ static: "", dynamic: "" })),
    ...overrides,
  };
  const panel = (id: string, folder: string, memorySessionId: string) =>
    ({ host: { id }, folder: { key: folder, fsPath: folder, name: "ws", label: "ws", projectScope: true }, session: { memorySessionId } }) as unknown as HostInstance;
  const panels = new Map([
    ["panel-1", panel("panel-1", "/cwd", "sess-1")],
    ["panel-2", panel("panel-2", "/other", "sess-2")],
  ]);
  const deps = {
    postMessage: (host: { id: string }, message: ExtensionToWebviewMessage) => { sent.push({ host: host.id, message }); },
    getPanels: () => panels,
    memoryService,
  } as unknown as HandlerDependencies;
  const ctx = { folder: panels.get("panel-1")!.folder, host: { id: "panel-1" }, session: { memorySessionId: "sess-1" } } as unknown as HandlerContext;
  const to = (host: string) => sent.filter((s) => s.host === host).map((s) => s.message);
  return { sent, to, memoryService, handlers: createMemoryHandlers(deps), ctx };
}

const STATE_BROADCAST: ExtensionToWebviewMessage[] = [
  { type: "memoryAuditState", state: STATE },
  { type: "memoryAuditSummary", summary: SUMMARY },
];

describe("createMemoryHandlers — quality audit", () => {
  it("requestMemoryAudit replies with the audit state to the asking panel only", async () => {
    const h = makeHarness();
    await h.handlers.requestMemoryAudit!({ type: "requestMemoryAudit" }, h.ctx);
    expect(h.sent).toEqual([{ host: "panel-1", message: { type: "memoryAuditState", state: STATE } }]);
  });

  it("requestMemoryAudit reports an unavailable store as a coded audit error, never silence", async () => {
    const h = makeHarness({ getAuditState: vi.fn(() => null) });
    await h.handlers.requestMemoryAudit!({ type: "requestMemoryAudit" }, h.ctx);
    expect(h.to("panel-1")).toEqual([{ type: "memoryError", source: "audit", code: "unavailable", message: "Memory system is not available" }]);
  });

  it("requestMemoryAuditSummary answers with counts, and with null when memory is off", async () => {
    const h = makeHarness();
    await h.handlers.requestMemoryAuditSummary!({ type: "requestMemoryAuditSummary" }, h.ctx);
    expect(h.to("panel-1")).toEqual([{ type: "memoryAuditSummary", summary: SUMMARY }]);
    expect(h.memoryService.getAuditState).not.toHaveBeenCalled();

    const off = makeHarness({ isEnabled: false });
    await off.handlers.requestMemoryAuditSummary!({ type: "requestMemoryAuditSummary" }, off.ctx);
    expect(off.to("panel-1")).toEqual([{ type: "memoryAuditSummary", summary: null }]);
  });

  it("startMemoryAudit broadcasts the running state to every panel once the lease is taken", async () => {
    const h = makeHarness();
    await h.handlers.startMemoryAudit!({ type: "startMemoryAudit" }, h.ctx);
    expect(h.memoryService.startAudit).toHaveBeenCalledOnce();
    expect(h.to("panel-1")).toEqual(STATE_BROADCAST);
    expect(h.to("panel-2")).toEqual(STATE_BROADCAST);
  });

  it("startMemoryAudit turns a held lease or a missing model into a coded audit error", async () => {
    for (const reason of ["busy", "no-model"] as const) {
      const h = makeHarness({ startAudit: vi.fn(async () => ({ started: false, reason })) });
      await h.handlers.startMemoryAudit!({ type: "startMemoryAudit" }, h.ctx);
      expect(h.sent).toEqual([{ host: "panel-1", message: expect.objectContaining({ type: "memoryError", source: "audit", code: reason }) }]);
    }
  });

  it("cancelMemoryAudit broadcasts the settled state, then tells the asking panel how the cancel ended", async () => {
    const h = makeHarness({ cancelAudit: vi.fn(async () => "held-elsewhere" as const) });
    await h.handlers.cancelMemoryAudit!({ type: "cancelMemoryAudit" }, h.ctx);
    expect(h.memoryService.cancelAudit).toHaveBeenCalledOnce();
    expect(h.to("panel-1")).toEqual([...STATE_BROADCAST, { type: "memoryAuditCancelResult", result: "held-elsewhere" }]);
    expect(h.to("panel-2")).toEqual(STATE_BROADCAST);
  });

  it("applyMemoryAudit refreshes every panel's state, memory list and profile, and reports the counts to the asker", async () => {
    const h = makeHarness();
    await h.handlers.applyMemoryAudit!({ type: "applyMemoryAudit", runId: "run-1", accept: ["a"], reject: ["b"] }, h.ctx);
    expect(h.memoryService.applyAudit).toHaveBeenCalledWith("run-1", ["a"], ["b"]);
    expect(h.to("panel-1").map((m) => m.type)).toEqual(["memoryAuditState", "memoryAuditSummary", "memoriesUpdate", "profileData", "memoryAuditResult"]);
    expect(h.to("panel-2").map((m) => m.type)).toEqual(["memoryAuditState", "memoryAuditSummary", "memoriesUpdate", "profileData"]);
    expect(h.to("panel-1").at(-1)).toEqual({ type: "memoryAuditResult", result: { action: "apply", applied: 1, stale: 2, rejected: 3 } });
    expect(h.memoryService.getPanelMemories).toHaveBeenCalledWith("sess-1", "/cwd");
    expect(h.memoryService.getPanelMemories).toHaveBeenCalledWith("sess-2", "/other");
    expect(h.memoryService.getProfile).toHaveBeenCalledWith("project", "/other");
  });

  it("revertMemoryAudit reverts the run, refreshes every panel and reports the skipped count", async () => {
    const h = makeHarness();
    await h.handlers.revertMemoryAudit!({ type: "revertMemoryAudit", runId: "run-1" }, h.ctx);
    expect(h.memoryService.revertAudit).toHaveBeenCalledWith("run-1");
    expect(h.to("panel-2").map((m) => m.type)).toEqual(["memoryAuditState", "memoryAuditSummary", "memoriesUpdate", "profileData"]);
    expect(h.to("panel-1").at(-1)).toEqual({ type: "memoryAuditResult", result: { action: "revert", reverted: 1, skipped: 4 } });
  });

  it("lets an apply failure throw so the router reports it as an audit error", async () => {
    const h = makeHarness({ applyAudit: vi.fn(async () => { throw new Error("boom"); }) });
    await expect(
      h.handlers.applyMemoryAudit!({ type: "applyMemoryAudit", runId: "run-1", accept: [], reject: [] }, h.ctx),
    ).rejects.toThrow("boom");
    for (const t of ["requestMemoryAudit", "requestMemoryAuditSummary", "startMemoryAudit", "cancelMemoryAudit", "applyMemoryAudit", "revertMemoryAudit"]) {
      expect(MEMORY_MESSAGE_SOURCES.get(t)).toBe("audit");
    }
  });
});
