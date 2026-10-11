import { describe, it, expect, beforeEach } from "vitest";
import { setActivePinia, createPinia } from "pinia";
import { createMemoryHandlers } from "../memory-handlers";
import { createConsolidationHandlers } from "@/composables/message-handler/handlers/consolidation-handlers";
import { useConsolidationStore } from "@/stores/useConsolidationStore";
import type { HandlerContext as WebviewHandlerContext } from "@/composables/message-handler/types";
import type { HandlerContext, HandlerDependencies } from "../../types";
import type { ExtensionToWebviewMessage } from "../../../../../shared/types/messages";
import type { ConsolidationResult } from "../../../../../shared/types/consolidation";

const run = (contents: string[]): ConsolidationResult => ({
  ranAt: 1,
  trigger: "manual",
  status: contents.length ? "extracted" : "empty",
  extracted: contents.map((content) => ({ kind: "fact", scope: "project", content, outcome: "inserted" as const })),
  maintenance: { promoted: 0, decayed: 0, pruned: 0 },
  candidatesReviewed: contents.length,
});

beforeEach(() => {
  setActivePinia(createPinia());
});

describe("overlay-open replay of a run in flight", () => {
  it("leaves the webview store on the run's pass, its memories so far and the phases of the pass in flight", async () => {
    const sent: ExtensionToWebviewMessage[] = [];
    const memoryService = {
      isEnabled: true,
      ensureInitialized: async () => {},
      getPendingCandidates: () => [],
      getPendingCount: () => 1,
      getSetAsideCount: () => 0,
      getLastConsolidationResult: () => run(["Previous run memory."]),
      getConsolidationActivity: () => ({
        running: true,
        pass: 2,
        runSoFar: run(["First pass memory."]),
        phaseEvents: [
          { phase: "claim" as const, status: "active" as const },
          { phase: "claim" as const, status: "done" as const, meta: { count: 1 } },
          { phase: "extract" as const, status: "active" as const },
        ],
      }),
    };
    const deps = { postMessage: (_host: unknown, message: ExtensionToWebviewMessage) => void sent.push(message), memoryService } as unknown as HandlerDependencies;
    await createMemoryHandlers(deps).requestConsolidationPreview!({ type: "requestConsolidationPreview" }, { host: { id: "panel-1" } } as unknown as HandlerContext);

    const store = useConsolidationStore();
    const handlers = createConsolidationHandlers();
    const ctx = { stores: { consolidationStore: store } } as unknown as WebviewHandlerContext;
    for (const msg of sent) (handlers[msg.type] as ((m: ExtensionToWebviewMessage, c: WebviewHandlerContext) => void) | undefined)!(msg, ctx);

    expect(store.isRunning).toBe(true);
    expect(store.runPass).toBe(2);
    expect(store.runSoFar?.extracted.map((m) => m.content)).toEqual(["First pass memory."]);
    expect(store.lastResult?.extracted.map((m) => m.content)).toEqual(["Previous run memory."]);
    expect(store.phaseStatus).toEqual({ claim: "done", extract: "active", persist: "pending", maintain: "pending", profiles: "pending" });
  });
});
