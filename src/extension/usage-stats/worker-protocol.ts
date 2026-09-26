import type { UsageStatsQuery, UsageStatsReport } from '../../shared/types/usage-stats';

/** Host to worker and back. The worker receives every path and the model registry from the host. */

export const USAGE_STATS_WORKER_MARKER = 'damocles-usage-stats-worker';

/** The `workerData` a stats worker is started with. */
export interface UsageStatsWorkerData {
  marker: typeof USAGE_STATS_WORKER_MARKER;
  /** Run `PRAGMA quick_check` on open; the host asks for it until one worker in this process has opened the index. */
  quickCheck: boolean;
}

export interface UsageStatsPaths {
  /** pi's `<agentDir>/sessions`. */
  sessionsDir: string;
  ledgerPath: string;
  dbPath: string;
}

/** One pi registry model. */
export interface UsageStatsModel {
  /** `provider/id`. */
  key: string;
  label: string;
  /** USD per uncached input token (pi's `model.cost.input` is per million). */
  inputRatePerToken: number;
}

export interface UsageStatsProgress {
  filesDone: number;
  filesTotal: number;
}

export interface WorkerQueryRequest {
  type: 'query';
  id: number;
  paths: UsageStatsPaths;
  models: UsageStatsModel[];
  query: UsageStatsQuery;
}

/** Closes the database and ends the worker. Sent only while no request is in flight. */
export interface WorkerCloseRequest {
  type: 'close';
}

export type WorkerRequest = WorkerQueryRequest | WorkerCloseRequest;

export type WorkerEvent =
  | ({ type: 'progress'; id: number } & UsageStatsProgress)
  /** A scan query gets one early `final: false` result from the index, then a `final: true` one after the scan. */
  | { type: 'result'; id: number; report: UsageStatsReport; final: boolean }
  | { type: 'error'; id: number; message: string }
  | { type: 'log'; message: string };
