import { parentPort, workerData } from 'node:worker_threads';
import { isCorruption, openUsageDatabase, type UsageDatabase } from './database';
import { indexUsage } from './indexer';
import { buildReport } from './queries';
import {
  USAGE_STATS_WORKER_MARKER,
  type UsageStatsProgress,
  type UsageStatsWorkerData,
  type WorkerEvent,
  type WorkerQueryRequest,
  type WorkerRequest,
} from './worker-protocol';

/** The stats worker owns the only index connection. It imports neither `vscode`, pi nor host path modules. */

interface Scan {
  promise: Promise<void>;
  listeners: Set<number>;
  last: UsageStatsProgress | null;
}

export interface UsageStatsWorkerRuntime {
  handle(msg: WorkerRequest): void;
}

export interface UsageStatsWorkerRuntimeOptions {
  /** Run `PRAGMA quick_check` when opening the index. Defaults to true. */
  quickCheck?: boolean;
}

export function createUsageStatsWorkerRuntime(
  send: (event: WorkerEvent) => void,
  options: UsageStatsWorkerRuntimeOptions = {},
): UsageStatsWorkerRuntime {
  let db: UsageDatabase | null = null;
  let dbPath: string | null = null;
  let quickCheck = options.quickCheck ?? true;
  let scan: Scan | null = null;
  const log = (message: string) => send({ type: 'log', message });

  function open(path: string): UsageDatabase {
    if (db) {
      if (dbPath !== path) throw new Error(`usage index is open at ${dbPath}, not ${path}`);
      return db;
    }
    db = openUsageDatabase(path, log, { quickCheck });
    dbPath = path;
    return db;
  }

  /** A scan request that arrives mid-scan joins the running scan instead of queueing another. */
  function joinScan(req: WorkerQueryRequest, database: UsageDatabase): Promise<void> {
    if (!scan) {
      const current: Scan = { promise: Promise.resolve(), listeners: new Set(), last: null };
      current.promise = indexUsage({
        db: database,
        sessionsDir: req.paths.sessionsDir,
        ledgerPath: req.paths.ledgerPath,
        models: req.models,
        log,
        onProgress: (progress) => {
          current.last = progress;
          for (const id of current.listeners) send({ type: 'progress', id, ...progress });
        },
      }).then(
        (summary) => {
          if (summary.filesFailed > 0) log(`[UsageStats] Scan finished with ${summary.filesFailed} of ${summary.filesTotal} files failing`);
        },
      ).finally(() => {
        scan = null;
      });
      scan = current;
    }
    scan.listeners.add(req.id);
    if (scan.last) send({ type: 'progress', id: req.id, ...scan.last });
    return scan.promise;
  }

  async function query(req: WorkerQueryRequest): Promise<void> {
    try {
      const database = open(req.paths.dbPath);
      if (!req.query.scan) {
        send({ type: 'result', id: req.id, report: buildReport(database, req.query, req.models), final: true });
        return;
      }
      const early = buildReport(database, req.query, req.models);
      // Before the first completed scan the index is empty, not zero; the caller shows indexing instead.
      if (early.indexedAtMs !== null) send({ type: 'result', id: req.id, report: early, final: false });
      await joinScan(req, database);
      send({ type: 'result', id: req.id, report: buildReport(database, req.query, req.models), final: true });
    } catch (err) {
      // The open may have skipped quick_check; closing lets the next request's open check and move the file aside.
      if (isCorruption(err) && db) {
        db.close();
        db = null;
        quickCheck = true;
      }
      send({ type: 'error', id: req.id, message: err instanceof Error ? err.message : String(err) });
    }
  }

  return {
    handle(msg) {
      if (msg.type === 'close') {
        db?.close();
        db = null;
        return;
      }
      void query(msg);
    },
  };
}

// The marker keeps a test runner's own worker thread from wiring its port here on import.
const data = workerData as Partial<UsageStatsWorkerData> | null | undefined;
if (parentPort && typeof data === 'object' && data?.marker === USAGE_STATS_WORKER_MARKER) {
  const port = parentPort;
  const runtime = createUsageStatsWorkerRuntime((event) => port.postMessage(event), { quickCheck: data.quickCheck !== false });
  port.on('message', (msg: WorkerRequest) => {
    runtime.handle(msg);
    if (msg.type === 'close') port.close();
  });
}
