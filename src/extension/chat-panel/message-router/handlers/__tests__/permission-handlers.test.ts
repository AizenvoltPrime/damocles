import { describe, it, expect, beforeEach, vi } from "vitest";

// Shared ordered event log + recorded writes, populated by the fs mock and the session mock so the test
// can assert the continuation plan file is written right after the swap and BEFORE the turn runs.
const H = vi.hoisted(() => ({ events: [] as string[], writes: [] as { path: string; content: string }[] }));

vi.mock("fs/promises", () => ({
  mkdir: vi.fn(async () => undefined),
  writeFile: vi.fn(async (p: unknown, content: unknown) => {
    H.events.push(`write:${String(p)}`);
    H.writes.push({ path: String(p), content: String(content) });
  }),
}));

vi.mock("../../../session-file-path", () => ({ resolveSessionFilePath: vi.fn(async () => null) }));

import { createPermissionHandlers } from "../permission-handlers";
import { buildPlanImplementationMessage } from "../../utils";
import { computePlanFilePath } from "../../../../paths";
import type { HandlerContext, HandlerDependencies } from "../../types";

function setup() {
  H.events.length = 0;
  H.writes.length = 0;
  let sessionId = "old-1aaaaaaa";
  const session = {
    getPlanFilePath: vi.fn(() => "/old-plan.md"),
    persistenceSessionId: "old-1aaaaaaa",
    get currentSessionId() {
      return sessionId;
    },
    clear: vi.fn(() => {
      H.events.push("clear");
    }),
    whenReplaced: vi.fn(async () => {
      H.events.push("swap");
      sessionId = "new-2bbbbbbb";
    }),
    sendMessage: vi.fn(async () => {
      H.events.push("send-start");
      await new Promise((r) => setTimeout(r, 5));
      H.events.push("send-resolve");
    }),
  };
  const permissionHandler = { resolvePlanApproval: vi.fn() };
  const settingsManager = {
    handleSetPermissionMode: vi.fn(async () => undefined),
    sendCurrentSettings: vi.fn(async () => undefined),
    sendModelForPanel: vi.fn(),
  };
  const deps = {
    workspacePath: "/ws",
    postMessage: vi.fn(),
    settingsManager,
  } as unknown as HandlerDependencies;
  const ctx = { host: {}, session, permissionHandler, panelId: "p1" } as unknown as HandlerContext;
  return { session, permissionHandler, settingsManager, deps, ctx };
}

describe("approvePlan — clear context", () => {
  beforeEach(() => {
    H.events.length = 0;
    H.writes.length = 0;
  });

  it("writes the continuation plan file right after the swap, before the implementation turn runs", async () => {
    const { deps, ctx } = setup();
    const handlers = createPermissionHandlers(deps);
    await handlers.approvePlan!(
      { type: "approvePlan", toolUseId: "t1", approved: true, clearContext: true, planContent: "# Plan: do X" } as never,
      ctx,
    );

    const newMessage = buildPlanImplementationMessage("# Plan: do X", null);
    const continuationPath = computePlanFilePath("new-2bbbbbbb", newMessage);

    // The continuation plan was written, to the SAME path resolvePlanFilePath would compute (id + first
    // message = the implementation prompt), with the approved content.
    const written = H.writes.find((w) => w.path === continuationPath);
    expect(written?.content).toBe("# Plan: do X");

    // Crux: the continuation write happens after the swap and BEFORE the turn even starts — so "view
    // session plan" works the moment the new session is created, not only after streaming ends.
    const writeIdx = H.events.indexOf(`write:${continuationPath}`);
    const swapIdx = H.events.indexOf("swap");
    const sendStartIdx = H.events.indexOf("send-start");
    expect(swapIdx).toBeGreaterThanOrEqual(0);
    expect(writeIdx).toBeGreaterThan(swapIdx);
    expect(writeIdx).toBeLessThan(sendStartIdx);
  });

  it("also writes the planning session's own plan file before the swap (independent copy)", async () => {
    const { deps, ctx } = setup();
    const handlers = createPermissionHandlers(deps);
    await handlers.approvePlan!(
      { type: "approvePlan", toolUseId: "t1", approved: true, clearContext: true, planContent: "# Plan: do X" } as never,
      ctx,
    );
    expect(H.events.indexOf("write:/old-plan.md")).toBeLessThan(H.events.indexOf("clear"));
  });
});
