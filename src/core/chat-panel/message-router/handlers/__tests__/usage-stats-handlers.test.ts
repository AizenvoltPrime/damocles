import { describe, it, expect, beforeEach, vi } from "vitest";

const H = vi.hoisted(() => ({
  init: vi.fn(),
  getModels: vi.fn(),
}));

vi.mock("../../../../pi-session/pi-runtime", () => ({
  PiRuntime: {
    get: vi.fn(() => ({ init: H.init, modelRuntime: { getModels: H.getModels } })),
  },
}));

import { createUsageStatsHandlers, parseUsageStatsQuery, withOpenableSessions } from "../usage-stats-handlers";
import type { HandlerDependencies, HandlerContext } from "../../types";
import type { ExtensionToWebviewMessage } from "../../../../../shared/types/messages";
import type { UsageStatsQuery, UsageStatsReport, UsageStatsTopSession } from "../../../../../shared/types/usage-stats";
import type { UsageStatsUpdate } from "../../../../usage-stats";

const VALID: UsageStatsQuery = {
  startMs: 1_000,
  endMs: 2_000,
  previous: { startMs: 0, endMs: 1_000 },
  modelKeys: ["anthropic/claude-sonnet-4-5"],
  projectKeys: [""],
  bucket: "week",
  timeZone: "Asia/Kathmandu",
  scan: true,
};

const REPORT: UsageStatsReport = {
  range: { startMs: 1_000, endMs: 2_000 },
  totals: { cost: 1, input: 1, output: 1, cacheRead: 1, cacheWrite: 1, unpricedTokens: 0, netCacheSavings: 0, requests: 1, sessions: 1, activeDays: 1 },
  previousTotals: null,
  filterOptions: { models: [], projects: [] },
  indexedAtMs: 5,
};

type QueryFn = (q: UsageStatsQuery, models: unknown[], onUpdate: (u: UsageStatsUpdate) => void) => Promise<UsageStatsReport>;

function setup(query: QueryFn, folderOf: (sessionId: string) => Promise<unknown> = async () => undefined) {
  const posted: ExtensionToWebviewMessage[] = [];
  const service = { query: vi.fn(query) };
  const deps = {
    postMessage: vi.fn((_host: unknown, msg: ExtensionToWebviewMessage) => { posted.push(msg); }),
    usageStatsService: service,
    storageManager: { folderOf: vi.fn(folderOf) },
  } as unknown as HandlerDependencies;
  const ctx = { host: {} } as unknown as HandlerContext;
  const handler = createUsageStatsHandlers(deps).requestUsageStats!;
  const send = (msg: unknown) => handler({ type: "requestUsageStats", ...(msg as object) } as never, ctx);
  const finals = () => posted.filter((m) => m.type === "usageStats" && m.final);
  return { send, posted, service, finals, deps };
}

const topSession = (sessionId: string, missing: boolean): UsageStatsTopSession => ({
  sessionId, title: null, projectKey: "p", cwd: "/p", lastActiveMs: 1, missing, openable: false,
  cost: 1, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, unpricedTokens: 0, requests: 1,
});

describe("parseUsageStatsQuery", () => {
  it("accepts a valid query and rebuilds it without extra fields", () => {
    expect(parseUsageStatsQuery({ ...VALID, extra: "dropped" })).toEqual({ value: VALID });
    expect(parseUsageStatsQuery({ ...VALID, previous: null })).toEqual({ value: { ...VALID, previous: null } });
  });

  it.each<[string, unknown]>([
    ["a missing query", undefined],
    ["a non-finite start", { ...VALID, startMs: Number.NaN }],
    ["an infinite end", { ...VALID, endMs: Number.POSITIVE_INFINITY }],
    ["a string bound", { ...VALID, startMs: "0" }],
    ["a negative start", { ...VALID, startMs: -1 }],
    ["start equal to end", { ...VALID, endMs: VALID.startMs }],
    ["start after end", { ...VALID, startMs: 3_000 }],
    ["an inverted previous range", { ...VALID, previous: { startMs: 900, endMs: 100 } }],
    ["a non-finite previous bound", { ...VALID, previous: { startMs: 0, endMs: Number.NaN } }],
    ["a missing previous", { ...VALID, previous: undefined }],
    ["more than 200 model keys", { ...VALID, modelKeys: Array.from({ length: 201 }, (_, i) => `p/m${i}`) }],
    ["a project key over 1024 chars", { ...VALID, projectKeys: ["x".repeat(1025)] }],
    ["a non-string key", { ...VALID, modelKeys: [42] }],
    ["keys that are not a list", { ...VALID, projectKeys: "c:\\work" }],
    ["an unknown bucket", { ...VALID, bucket: "hour" }],
    ["a non-boolean scan", { ...VALID, scan: "yes" }],
    ["a missing time zone", { ...VALID, timeZone: undefined }],
    ["an empty time zone", { ...VALID, timeZone: "" }],
    ["a non-string time zone", { ...VALID, timeZone: 5 }],
    ["an unknown time zone", { ...VALID, timeZone: "Mars/Olympus_Mons" }],
    ["a time zone over 64 chars", { ...VALID, timeZone: `Etc/${"x".repeat(61)}` }],
    ["an offset time zone", { ...VALID, timeZone: "+05:37" }],
  ])("rejects %s", (_label, query) => {
    expect(parseUsageStatsQuery(query)).toHaveProperty("error");
  });

  it("accepts IANA zone names, including legacy and Etc ones", () => {
    for (const timeZone of ["UTC", "America/Port-au-Prince", "Etc/GMT+5", "EST5EDT", "America/Argentina/ComodRivadavia"]) {
      expect(parseUsageStatsQuery({ ...VALID, timeZone })).toEqual({ value: { ...VALID, timeZone } });
    }
  });

  it("accepts exactly 200 keys of exactly 1024 chars", () => {
    const keys = Array.from({ length: 200 }, (_, i) => `${i}`.padEnd(1024, "k"));
    expect(parseUsageStatsQuery({ ...VALID, modelKeys: keys, projectKeys: keys })).toHaveProperty("value");
  });
});

describe("requestUsageStats handler", () => {
  beforeEach(() => {
    H.init.mockReset().mockResolvedValue(undefined);
    H.getModels.mockReset().mockReturnValue([
      { provider: "anthropic", id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5", cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 } },
    ]);
  });

  it("passes registry rates per token and relays progress, the early report and exactly one final", async () => {
    const { send, posted, service, finals } = setup(async (_q, _models, onUpdate) => {
      onUpdate({ type: "result", report: { ...REPORT, indexedAtMs: 1 } });
      onUpdate({ type: "progress", filesDone: 2, filesTotal: 4 });
      return REPORT;
    });
    await send({ requestId: "r1", query: VALID });
    expect(service.query).toHaveBeenCalledTimes(1);
    expect(service.query.mock.calls[0]![0]).toEqual(VALID);
    expect(service.query.mock.calls[0]![1]).toEqual([{ key: "anthropic/claude-sonnet-4-5", label: "Claude Sonnet 4.5", inputRatePerToken: 3 / 1e6 }]);
    // The early report is mapped asynchronously, so progress may pass it; it still precedes the final.
    expect(posted).toEqual([
      { type: "usageStatsProgress", requestId: "r1", filesDone: 2, filesTotal: 4 },
      { type: "usageStats", requestId: "r1", final: false, report: { ...REPORT, indexedAtMs: 1 } },
      { type: "usageStats", requestId: "r1", final: true, report: REPORT },
    ]);
    expect(finals()).toHaveLength(1);
  });

  it("posts the early report before the final one even when mapping the early one is slower", async () => {
    const early = { ...REPORT, indexedAtMs: 1, topSessions: [topSession("here", false)] };
    // Only the early report has top sessions, so only its mapping waits on the storage manager.
    const folderOf = () => new Promise((resolve) => setTimeout(() => resolve({ key: "f" }), 20));
    const { send, posted } = setup(async (_q, _models, onUpdate) => {
      onUpdate({ type: "result", report: early });
      return REPORT;
    }, folderOf);
    await send({ requestId: "r5", query: VALID });
    expect(posted.map((m) => m.type === "usageStats" && m.final)).toEqual([false, true]);
    expect(posted[0]).toMatchObject({ report: { topSessions: [{ sessionId: "here", openable: true }] } });
  });

  it("posts one final even when posting it throws", async () => {
    const { send, deps } = setup(async () => REPORT);
    const postMessage = vi.mocked(deps.postMessage);
    postMessage.mockImplementation(() => { throw new Error("webview disposed"); });
    await expect(send({ requestId: "r6", query: VALID })).rejects.toThrow("webview disposed");
    expect(postMessage).toHaveBeenCalledTimes(1);
    expect(postMessage.mock.calls[0]![1]).toMatchObject({ type: "usageStats", final: true, report: REPORT });
  });

  it("answers an invalid query with one final error and never reaches the service", async () => {
    const { send, posted, service } = setup(async () => REPORT);
    await send({ requestId: "r2", query: { ...VALID, startMs: 5_000 } });
    expect(service.query).not.toHaveBeenCalled();
    expect(posted).toHaveLength(1);
    expect(posted[0]).toMatchObject({ type: "usageStats", requestId: "r2", final: true, report: null, error: expect.stringContaining("start before it ends") });
  });

  it("answers an unknown time zone with one final error and never reaches the service", async () => {
    const { send, posted, service } = setup(async () => REPORT);
    await send({ requestId: "r7", query: { ...VALID, timeZone: "Mars/Olympus_Mons" } });
    expect(service.query).not.toHaveBeenCalled();
    expect(posted).toEqual([{ type: "usageStats", requestId: "r7", final: true, report: null, error: "Invalid usage stats query: timeZone is not a known time zone" }]);
  });

  it("answers a missing requestId with one final error", async () => {
    const { send, posted, service } = setup(async () => REPORT);
    await send({ query: VALID });
    expect(service.query).not.toHaveBeenCalled();
    expect(posted).toEqual([{ type: "usageStats", requestId: "", final: true, report: null, error: expect.stringContaining("requestId") }]);
  });

  it("answers a worker failure with one final error", async () => {
    const { send, posted, finals } = setup(async (_q, _m, onUpdate) => {
      onUpdate({ type: "progress", filesDone: 1, filesTotal: 9 });
      throw new Error("usage stats request timed out after 60000ms");
    });
    await send({ requestId: "r3", query: VALID });
    expect(finals()).toEqual([{ type: "usageStats", requestId: "r3", final: true, report: null, error: "usage stats request timed out after 60000ms" }]);
    expect(posted).toHaveLength(2);
  });

  it("answers a pi runtime failure with one final error", async () => {
    H.init.mockRejectedValue(new Error("pi failed to load"));
    const { send, posted, service } = setup(async () => REPORT);
    await send({ requestId: "r4", query: VALID });
    expect(service.query).not.toHaveBeenCalled();
    expect(posted).toEqual([{ type: "usageStats", requestId: "r4", final: true, report: null, error: "pi failed to load" }]);
  });
});

describe("withOpenableSessions", () => {
  const top = (sessionId: string, missing: boolean): UsageStatsTopSession => ({
    sessionId, title: null, projectKey: "p", cwd: "/p", lastActiveMs: 1, missing, openable: false,
    cost: 1, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, unpricedTokens: 0, requests: 1,
  });

  it("opens only a live conversation held by a folder open in this window", async () => {
    const folderOf = vi.fn(async (id: string) => (id === "here" || id === "gone" ? { key: "f" } : undefined));
    const mapped = await withOpenableSessions({ ...REPORT, topSessions: [top("here", false), top("elsewhere", false), top("gone", true)] }, folderOf);
    expect(mapped.topSessions!.map((s) => [s.sessionId, s.openable])).toEqual([["here", true], ["elsewhere", false], ["gone", false]]);
  });

  it("leaves a report without top sessions untouched", async () => {
    const folderOf = vi.fn();
    expect(await withOpenableSessions(REPORT, folderOf)).toBe(REPORT);
    expect(folderOf).not.toHaveBeenCalled();
  });

  it("maps the final report through the storage manager", async () => {
    H.init.mockReset().mockResolvedValue(undefined);
    H.getModels.mockReset().mockReturnValue([]);
    const posted: ExtensionToWebviewMessage[] = [];
    const deps = {
      postMessage: vi.fn((_host: unknown, msg: ExtensionToWebviewMessage) => { posted.push(msg); }),
      usageStatsService: { query: vi.fn(async () => ({ ...REPORT, topSessions: [top("here", false)] })) },
      storageManager: { folderOf: vi.fn(async () => ({ key: "f" })) },
    } as unknown as HandlerDependencies;
    await createUsageStatsHandlers(deps).requestUsageStats!({ type: "requestUsageStats", requestId: "r9", query: VALID } as never, { host: {} } as unknown as HandlerContext);
    expect(posted).toEqual([expect.objectContaining({ final: true, report: expect.objectContaining({ topSessions: [expect.objectContaining({ openable: true })] }) })]);
  });
});
