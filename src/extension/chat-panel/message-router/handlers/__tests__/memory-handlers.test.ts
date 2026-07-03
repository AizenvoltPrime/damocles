import { describe, it, expect, beforeEach, vi } from "vitest";
import { createMemoryHandlers, MEMORY_MESSAGE_SOURCES, MEMORY_MESSAGE_TYPES } from "../memory-handlers";
import type { HandlerDependencies, HandlerContext } from "../../types";
import type { ExtensionToWebviewMessage } from "../../../../../shared/types/messages";
import type { UserProfile, MemoryEntry } from "../../../../../shared/types/memory";

const PROJECT_PROFILE: UserProfile = { static: "proj static", dynamic: "proj dynamic" };
const GLOBAL_PROFILE: UserProfile = { static: "glob static", dynamic: "glob dynamic" };

function makeHarness(setProfileResult: boolean) {
  const sent: ExtensionToWebviewMessage[] = [];
  const setProfileSection = vi.fn(async () => setProfileResult);
  const getProfile = vi.fn((scope: "project" | "global") =>
    scope === "project" ? PROJECT_PROFILE : GLOBAL_PROFILE,
  );
  const memoryService = {
    isEnabled: true,
    ensureInitialized: vi.fn(async () => {}),
    setProfileSection,
    getProfile,
  };
  const deps = {
    workspacePath: "/cwd",
    postMessage: (_host: unknown, message: ExtensionToWebviewMessage) => { sent.push(message); },
    memoryService,
  } as unknown as HandlerDependencies;
  const ctx = { host: { id: "panel-1" }, session: { memorySessionId: "sess-1" } } as unknown as HandlerContext;
  const handlers = createMemoryHandlers(deps);
  return { sent, setProfileSection, getProfile, handlers, ctx };
}

describe("createMemoryHandlers — setProfileSection (T10 boolean contract)", () => {
  let h: ReturnType<typeof makeHarness>;

  describe("successful save (setProfileSection resolves true)", () => {
    beforeEach(() => { h = makeHarness(true); });

    it("posts profileData with the re-read project + global profiles and NO memoryError", async () => {
      await h.handlers.setProfileSection!(
        { type: "setProfileSection", scope: "project", section: "static", content: "new static" },
        h.ctx,
      );

      expect(h.setProfileSection).toHaveBeenCalledWith("project", "/cwd", "static", "new static");
      const profileData = h.sent.find((m) => m.type === "profileData");
      // savedSection scopes the panel's confirm+re-seed to just this section.
      expect(profileData).toEqual({ type: "profileData", project: PROJECT_PROFILE, global: GLOBAL_PROFILE, savedSection: { scope: "project", section: "static" } });
      expect(h.sent.some((m) => m.type === "memoryError")).toBe(false);
    });

    it("passes empty workspace for a global-scope save", async () => {
      await h.handlers.setProfileSection!(
        { type: "setProfileSection", scope: "global", section: "dynamic", content: "g" },
        h.ctx,
      );

      expect(h.setProfileSection).toHaveBeenCalledWith("global", "", "dynamic", "g");
      expect(h.sent.some((m) => m.type === "profileData")).toBe(true);
    });
  });

  describe("failed save (setProfileSection resolves false)", () => {
    beforeEach(() => { h = makeHarness(false); });

    it("posts a targeted profileSectionError and does NOT post profileData (draft preserved)", async () => {
      await h.handlers.setProfileSection!(
        { type: "setProfileSection", scope: "project", section: "static", content: "new static" },
        h.ctx,
      );

      const error = h.sent.find((m) => m.type === "profileSectionError");
      expect(error).toEqual({
        type: "profileSectionError",
        scope: "project",
        section: "static",
        message: "Failed to save profile section.",
      });
      expect(h.sent.some((m) => m.type === "profileData")).toBe(false);
      // No re-read on failure — the panel keeps its dirty draft.
      expect(h.getProfile).not.toHaveBeenCalled();
    });
  });

  it("posts a memoryError (no source) when the memory system is disabled", async () => {
    const sent: ExtensionToWebviewMessage[] = [];
    const deps = {
      workspacePath: "/cwd",
      postMessage: (_host: unknown, message: ExtensionToWebviewMessage) => { sent.push(message); },
      memoryService: { isEnabled: false },
    } as unknown as HandlerDependencies;
    const ctx = { host: { id: "p" }, session: { memorySessionId: "s" } } as unknown as HandlerContext;
    const handlers = createMemoryHandlers(deps);

    await handlers.setProfileSection!(
      { type: "setProfileSection", scope: "project", section: "static", content: "x" },
      ctx,
    );

    expect(sent).toEqual([{ type: "memoryError", message: "Memory system is not available" }]);
  });
});

const FACT: MemoryEntry = {
  id: "m1", tier: "project", kind: "fact", scope: "project", content: "hi",
  sessionId: null, workspace: "/cwd", createdAt: 1, updatedAt: 1, tags: [],
};

/** Minimal MemoryService double; each method is a vi.fn so tests assert routing + argument shape. */
function makeCrudHarness(overrides: Record<string, unknown> = {}) {
  const sent: ExtensionToWebviewMessage[] = [];
  const memoryService = {
    isEnabled: true,
    ensureInitialized: vi.fn(async () => {}),
    saveMemory: vi.fn(async () => FACT),
    addNote: vi.fn(async () => FACT),
    deleteMemory: vi.fn(async () => true),
    updateMemory: vi.fn(async () => FACT),
    pinMemory: vi.fn(async () => true),
    unpinMemory: vi.fn(async () => true),
    forgetMemory: vi.fn(async () => ({ forgotten: 1 })),
    unforgetMemory: vi.fn(async () => ({ restored: 1 })),
    getPanelMemories: vi.fn(() => []),
    getObservationPage: vi.fn(() => ({ entries: [], hasMore: false, nextCursor: null })),
    ...overrides,
  };
  const deps = {
    workspacePath: "/cwd",
    postMessage: (_host: unknown, message: ExtensionToWebviewMessage) => { sent.push(message); },
    memoryService,
  } as unknown as HandlerDependencies;
  const ctx = { host: { id: "p" }, session: { memorySessionId: "sess-1" } } as unknown as HandlerContext;
  const handlers = createMemoryHandlers(deps);
  return { sent, memoryService, handlers, ctx };
}

describe("createMemoryHandlers — createMemory (T5 + kind)", () => {
  it("routes a fact-kind panel create through saveMemory with kind + mapped scope", async () => {
    const h = makeCrudHarness();
    await h.handlers.createMemory!(
      { type: "createMemory", tier: "project", kind: "preference", content: "c", tags: ["t"] },
      h.ctx,
    );
    expect(h.memoryService.saveMemory).toHaveBeenCalledWith({
      content: "c", kind: "preference", scope: "project",
      sessionId: "sess-1", workspace: "/cwd", tags: ["t"],
    });
    expect(h.sent).toContainEqual({ type: "memoryCreated", memory: FACT });
  });

  it("defaults kind to 'fact' when the message omits it", async () => {
    const h = makeCrudHarness();
    await h.handlers.createMemory!({ type: "createMemory", tier: "session", content: "c" }, h.ctx);
    expect(h.memoryService.saveMemory).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "fact", scope: "session" }),
    );
  });

  it("routes tier='note' through addNote, not saveMemory", async () => {
    const h = makeCrudHarness();
    await h.handlers.createMemory!({ type: "createMemory", tier: "note", content: "c" }, h.ctx);
    expect(h.memoryService.addNote).toHaveBeenCalledWith("c", undefined);
    expect(h.memoryService.saveMemory).not.toHaveBeenCalled();
  });

  it("posts memoryError(source:'panel') and NO memoryCreated when saveMemory returns null", async () => {
    const h = makeCrudHarness({ saveMemory: vi.fn(async () => null) });
    await h.handlers.createMemory!({ type: "createMemory", tier: "project", content: "c" }, h.ctx);
    expect(h.sent).toContainEqual({ type: "memoryError", source: "panel", message: "Failed to create memory." });
    expect(h.sent.some((m) => m.type === "memoryCreated")).toBe(false);
  });

  it("posts memoryError(source:'panel') when memory is disabled so the panel resets its pending create", async () => {
    const sent: ExtensionToWebviewMessage[] = [];
    const deps = {
      workspacePath: "/cwd",
      postMessage: (_host: unknown, message: ExtensionToWebviewMessage) => { sent.push(message); },
      memoryService: { isEnabled: false },
    } as unknown as HandlerDependencies;
    const ctx = { host: { id: "p" }, session: { memorySessionId: "s" } } as unknown as HandlerContext;
    const handlers = createMemoryHandlers(deps);

    await handlers.createMemory!({ type: "createMemory", tier: "project", content: "c" }, ctx);

    expect(sent).toEqual([{ type: "memoryError", source: "panel", message: "Memory system is not available" }]);
    expect(sent.some((m) => m.type === "memoryCreated")).toBe(false);
  });
});

describe("createMemoryHandlers — deleteMemory (T1)", () => {
  it("posts memoryError(source:'panel') when the delete returns false", async () => {
    const h = makeCrudHarness({ deleteMemory: vi.fn(async () => false) });
    await h.handlers.deleteMemory!({ type: "deleteMemory", id: "m1" }, h.ctx);
    expect(h.sent).toContainEqual({ type: "memoryError", source: "panel", message: "Failed to delete memory." });
    expect(h.sent.some((m) => m.type === "memoryDeleted")).toBe(false);
  });
});

describe("createMemoryHandlers — updateMemory (T3 memoryUpdated)", () => {
  it("sets replacedId when the edit forks a new version id", async () => {
    const forked: MemoryEntry = { ...FACT, id: "m2" };
    const h = makeCrudHarness({ updateMemory: vi.fn(async () => forked) });
    await h.handlers.updateMemory!({ type: "updateMemory", id: "m1", content: "c" }, h.ctx);
    expect(h.sent).toContainEqual({ type: "memoryUpdated", memory: forked, replacedId: "m1" });
    expect(h.sent.some((m) => m.type === "memoriesUpdate")).toBe(false);
  });

  it("omits replacedId for an in-place edit (same id)", async () => {
    const h = makeCrudHarness({ updateMemory: vi.fn(async () => FACT) });
    await h.handlers.updateMemory!({ type: "updateMemory", id: "m1", content: "c" }, h.ctx);
    expect(h.sent).toContainEqual({ type: "memoryUpdated", memory: FACT });
  });

  it("posts memoryError(source:'panel') and NO memoryUpdated when updateMemory returns null", async () => {
    const h = makeCrudHarness({ updateMemory: vi.fn(async () => null) });
    await h.handlers.updateMemory!({ type: "updateMemory", id: "m1", content: "c" }, h.ctx);
    expect(h.sent).toContainEqual({ type: "memoryError", source: "panel", message: "Failed to update memory." });
    expect(h.sent.some((m) => m.type === "memoryUpdated")).toBe(false);
  });
});

describe("createMemoryHandlers — correlation ids + guards", () => {
  it("echoes requestId on memoryCreated so only the matching panel create settles", async () => {
    const h = makeCrudHarness();
    await h.handlers.createMemory!({ type: "createMemory", tier: "project", content: "c", requestId: "req-9" }, h.ctx);
    expect(h.sent).toContainEqual({ type: "memoryCreated", memory: FACT, requestId: "req-9" });
  });

  it("echoes requestId on the failure memoryError too", async () => {
    const h = makeCrudHarness({ saveMemory: vi.fn(async () => null) });
    await h.handlers.createMemory!({ type: "createMemory", tier: "project", content: "c", requestId: "req-9" }, h.ctx);
    expect(h.sent).toContainEqual({ type: "memoryError", source: "panel", message: "Failed to create memory.", requestId: "req-9" });
  });

  it("rejects a project-scoped create with no workspace instead of orphaning a NULL-workspace row", async () => {
    const sent: ExtensionToWebviewMessage[] = [];
    const memoryService = { isEnabled: true, ensureInitialized: vi.fn(async () => {}), saveMemory: vi.fn() };
    const deps = {
      workspacePath: "",
      postMessage: (_h: unknown, m: ExtensionToWebviewMessage) => { sent.push(m); },
      memoryService,
    } as unknown as HandlerDependencies;
    const ctx = { host: { id: "p" }, session: { memorySessionId: "s" } } as unknown as HandlerContext;
    await createMemoryHandlers(deps).createMemory!({ type: "createMemory", tier: "project", content: "c", requestId: "r" }, ctx);
    expect(memoryService.saveMemory).not.toHaveBeenCalled();
    expect(sent).toContainEqual({ type: "memoryError", source: "panel", message: "Open a workspace folder to save a project-scoped memory.", requestId: "r" });
  });

  it("forgetMemory passes exactId=true so the panel never content-matches a stale id", async () => {
    const forgetMemory = vi.fn(async () => ({ forgotten: 1 }));
    const h = makeCrudHarness({ forgetMemory });
    await h.handlers.forgetMemory!({ type: "forgetMemory", id: "m1", scope: "chain" }, h.ctx);
    expect(forgetMemory).toHaveBeenCalledWith("m1", "chain", true);
  });

  it("clamps an over-limit panel search to 100 and echoes the query on results", async () => {
    const searchMemories = vi.fn(async () => []);
    const h = makeCrudHarness({ searchMemories });
    await h.handlers.searchMemories!({ type: "searchMemories", query: { query: "q", limit: 5000 } }, h.ctx);
    expect(searchMemories).toHaveBeenCalledWith(expect.objectContaining({ limit: 100 }));
    expect(h.sent).toContainEqual({ type: "searchResults", results: [], query: "q" });
  });
});

describe("createMemoryHandlers — pin/unpin/forget/unforget (T3 no rebroadcast, T14)", () => {
  it("pin posts only memoryPinned, no following memoriesUpdate", async () => {
    const h = makeCrudHarness();
    await h.handlers.pinMemory!({ type: "pinMemory", id: "m1" }, h.ctx);
    expect(h.sent).toEqual([{ type: "memoryPinned", id: "m1" }]);
  });

  it("unpin posts only memoryUnpinned, no following memoriesUpdate", async () => {
    const h = makeCrudHarness();
    await h.handlers.unpinMemory!({ type: "unpinMemory", id: "m1" }, h.ctx);
    expect(h.sent).toEqual([{ type: "memoryUnpinned", id: "m1" }]);
  });

  it("forget posts only memoryForgotten, no following memoriesUpdate", async () => {
    const h = makeCrudHarness();
    await h.handlers.forgetMemory!({ type: "forgetMemory", id: "m1" }, h.ctx);
    expect(h.sent).toEqual([{ type: "memoryForgotten", id: "m1", count: 1 }]);
  });

  it("forget with count=0 posts memoryError(source:'panel'), not memoryForgotten", async () => {
    const h = makeCrudHarness({ forgetMemory: vi.fn(async () => ({ forgotten: 0 })) });
    await h.handlers.forgetMemory!({ type: "forgetMemory", id: "m1" }, h.ctx);
    expect(h.sent).toEqual([{ type: "memoryError", source: "panel", message: "No matching memory found to forget." }]);
  });

  it("unforget with count=0 posts memoryError(source:'panel'), not memoryUnforgotten", async () => {
    const h = makeCrudHarness({ unforgetMemory: vi.fn(async () => ({ restored: 0 })) });
    await h.handlers.unforgetMemory!({ type: "unforgetMemory", id: "m1" }, h.ctx);
    expect(h.sent).toEqual([{ type: "memoryError", source: "panel", message: "No matching memory found to unforget." }]);
  });
});

describe("createMemoryHandlers — keyset pagination (T18)", () => {
  it("passes the request cursor through to getObservationPage", async () => {
    const cursor = { createdAt: 100, id: "m9" };
    const getObservationPage = vi.fn(() => ({ entries: [FACT], hasMore: true, nextCursor: cursor }));
    const h = makeCrudHarness({ getObservationPage });
    await h.handlers.requestMoreObservations!({ type: "requestMoreObservations", cursor }, h.ctx);
    expect(getObservationPage).toHaveBeenCalledWith("/cwd", cursor);
    expect(h.sent).toContainEqual({
      type: "moreObservationsLoaded", observations: [FACT], hasMore: true, nextCursor: cursor,
    });
  });

  it("first-load memoriesUpdate carries the initial observationCursor", async () => {
    const cursor = { createdAt: 100, id: "m9" };
    const h = makeCrudHarness({
      getObservationPage: vi.fn(() => ({ entries: [FACT], hasMore: true, nextCursor: cursor })),
    });
    await h.handlers.requestMemories!({ type: "requestMemories" }, h.ctx);
    const update = h.sent.find((m) => m.type === "memoriesUpdate");
    expect(update).toMatchObject({ type: "memoriesUpdate", observationCursor: cursor });
  });
});

describe("MEMORY_MESSAGE_SOURCES (H2 router-fallback routing)", () => {
  it("covers exactly the registered handler message types", () => {
    const handlerKeys = new Set(Object.keys(createMemoryHandlers({} as unknown as HandlerDependencies)));
    expect(new Set(MEMORY_MESSAGE_SOURCES.keys())).toEqual(handlerKeys);
    expect(MEMORY_MESSAGE_TYPES).toEqual(new Set(MEMORY_MESSAGE_SOURCES.keys()));
  });

  it("tags panel-create mutations so a thrown handler settles the pending create", () => {
    for (const t of ["createMemory", "updateMemory", "deleteMemory", "setProfileSection"]) {
      expect(MEMORY_MESSAGE_SOURCES.get(t)).toBe("panel");
    }
  });

  it("tags consolidation triggers so a thrown handler settles the run stepper", () => {
    for (const t of ["requestConsolidationPreview", "triggerConsolidation"]) {
      expect(MEMORY_MESSAGE_SOURCES.get(t)).toBe("consolidation");
    }
  });

  it("leaves reads untagged so a thrown read never resets a pending create", () => {
    for (const t of ["requestMemories", "searchMemories", "getMemoryHistory", "getProfile"]) {
      expect(MEMORY_MESSAGE_SOURCES.get(t)).toBeUndefined();
    }
  });
});
