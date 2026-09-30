import type { HandlerDependencies, HandlerRegistry } from "../types";
import {
  USAGE_STATS_BUCKETS,
  USAGE_STATS_MAX_FILTER_KEYS,
  USAGE_STATS_MAX_FILTER_KEY_LENGTH,
  USAGE_STATS_MAX_TIME_ZONE_LENGTH,
  type UsageStatsQuery,
  type UsageStatsRange,
  type UsageStatsReport,
} from "../../../../shared/types/usage-stats";
import { PiRuntime } from "../../../pi-session/pi-runtime";
import { log } from "../../../logger";
import type { UsageStatsModel } from "../../../usage-stats";

type Parsed<T> = { value: T } | { error: string };

function parseRange(label: string, value: unknown): Parsed<UsageStatsRange> {
  if (typeof value !== "object" || value === null) return { error: `${label} is not a range` };
  const { startMs, endMs } = value as Partial<Record<keyof UsageStatsRange, unknown>>;
  if (typeof startMs !== "number" || !Number.isFinite(startMs) || typeof endMs !== "number" || !Number.isFinite(endMs)) {
    return { error: `${label} bounds must be finite numbers` };
  }
  if (startMs < 0) return { error: `${label} starts before the epoch` };
  if (startMs >= endMs) return { error: `${label} must start before it ends` };
  return { value: { startMs, endMs } };
}

function parseKeys(label: string, value: unknown): Parsed<string[]> {
  if (!Array.isArray(value)) return { error: `${label} is not a list` };
  if (value.length > USAGE_STATS_MAX_FILTER_KEYS) return { error: `${label} has more than ${USAGE_STATS_MAX_FILTER_KEYS} keys` };
  if (!value.every((key): key is string => typeof key === "string" && key.length <= USAGE_STATS_MAX_FILTER_KEY_LENGTH)) {
    return { error: `${label} keys must be strings of at most ${USAGE_STATS_MAX_FILTER_KEY_LENGTH} characters` };
  }
  return { value: [...value] };
}

// Names only: Intl also takes offsets such as "+05:37", which would split the 15-minute slots the worker buckets by.
const TIME_ZONE_NAME = /^[A-Za-z][\w+/-]*$/;

function parseTimeZone(value: unknown): Parsed<string> {
  if (typeof value !== "string" || value.length > USAGE_STATS_MAX_TIME_ZONE_LENGTH || !TIME_ZONE_NAME.test(value)) {
    return { error: `timeZone must be a zone name of at most ${USAGE_STATS_MAX_TIME_ZONE_LENGTH} characters` };
  }
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
  } catch {
    return { error: "timeZone is not a known time zone" };
  }
  return { value };
}

/** A webview query rebuilt from its validated fields, or why it is unusable. */
export function parseUsageStatsQuery(value: unknown): Parsed<UsageStatsQuery> {
  if (typeof value !== "object" || value === null) return { error: "query is missing" };
  const q = value as Partial<Record<keyof UsageStatsQuery, unknown>>;
  const range = parseRange("range", q);
  if ("error" in range) return range;
  const previous = q.previous === null ? { value: null } : parseRange("previous range", q.previous);
  if ("error" in previous) return previous;
  const modelKeys = parseKeys("modelKeys", q.modelKeys);
  if ("error" in modelKeys) return modelKeys;
  const projectKeys = parseKeys("projectKeys", q.projectKeys);
  if ("error" in projectKeys) return projectKeys;
  const bucket = USAGE_STATS_BUCKETS.find((b) => b === q.bucket);
  if (!bucket) return { error: "bucket is not day, week or month" };
  const timeZone = parseTimeZone(q.timeZone);
  if ("error" in timeZone) return timeZone;
  if (typeof q.scan !== "boolean") return { error: "scan is not a boolean" };
  return {
    value: {
      ...range.value,
      previous: previous.value,
      modelKeys: modelKeys.value,
      projectKeys: projectKeys.value,
      bucket,
      timeZone: timeZone.value,
      scan: q.scan,
    },
  };
}

/** Registry rates and labels keyed `provider/id`; pi's `model.cost.input` is USD per million tokens. */
async function registryModels(): Promise<UsageStatsModel[]> {
  const runtime = PiRuntime.get();
  await runtime.init();
  const modelRuntime = runtime.modelRuntime;
  if (!modelRuntime) throw new Error("pi model registry is unavailable");
  return modelRuntime.getModels().map((model) => ({
    key: `${model.provider}/${model.id}`,
    label: model.name,
    inputRatePerToken: model.cost.input / 1e6,
  }));
}

/** A top session opens only while its file exists and a folder open in this window holds it, the resume path's own guard. */
export async function withOpenableSessions(
  report: UsageStatsReport,
  folderOf: (sessionId: string) => Promise<unknown>,
): Promise<UsageStatsReport> {
  if (!report.topSessions) return report;
  const topSessions = await Promise.all(
    report.topSessions.map(async (session) => ({
      ...session,
      openable: !session.missing && (await folderOf(session.sessionId)) !== undefined,
    })),
  );
  return { ...report, topSessions };
}

/**
 * `/stats` reports. Bypasses ctx.session, since stats belong to no session, and always posts exactly one
 * final `usageStats` per request, including for an invalid query and a failed worker.
 */
export function createUsageStatsHandlers(deps: HandlerDependencies): Partial<HandlerRegistry> {
  return {
    requestUsageStats: async (msg, ctx) => {
      if (msg.type !== "requestUsageStats") return;
      const requestId = typeof msg.requestId === "string" ? msg.requestId : "";
      const fail = (error: string) => deps.postMessage(ctx.host, { type: "usageStats", requestId, final: true, report: null, error });
      const parsed = requestId === "" ? { error: "requestId is missing" } : parseUsageStatsQuery(msg.query);
      if ("error" in parsed) {
        fail(`Invalid usage stats query: ${parsed.error}`);
        return;
      }
      const folderOf = (sessionId: string) => deps.storageManager.folderOf(sessionId);
      let report: UsageStatsReport;
      try {
        const models = await registryModels();
        let early: Promise<void> = Promise.resolve();
        const final = await deps.usageStatsService.query(parsed.value, models, (update) => {
          if (update.type === "progress") {
            deps.postMessage(ctx.host, { type: "usageStatsProgress", requestId, filesDone: update.filesDone, filesTotal: update.filesTotal });
          } else {
            early = withOpenableSessions(update.report, folderOf).then((mapped) =>
              deps.postMessage(ctx.host, { type: "usageStats", requestId, final: false, report: mapped }),
            );
          }
        });
        // The early reply must land before the final one, or the webview would show it last.
        await early.catch((err: unknown) => log("[UsageStats] early report dropped: %O", err));
        report = await withOpenableSessions(final, folderOf);
      } catch (err) {
        fail(err instanceof Error ? err.message : String(err));
        return;
      }
      // Outside the try: a failed post must not be answered with a second final.
      deps.postMessage(ctx.host, { type: "usageStats", requestId, final: true, report });
    },
  };
}
