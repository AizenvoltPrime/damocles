// The diff worker's entry (dist/diff-worker.js): one job per message, answered in order.
import { isMainThread, parentPort, workerData } from 'node:worker_threads';
import { runDiffJob } from './jobs';
import { DIFF_WORKER_MARKER, type DiffAnswer, type DiffRequest, type DiffWorkerData } from './protocol';

// The marker keeps a test runner's own worker thread from serving on import.
const data = workerData as Partial<DiffWorkerData> | null | undefined;
if (!isMainThread && parentPort && data?.marker === DIFF_WORKER_MARKER) {
  const port = parentPort;
  const post = (answer: DiffAnswer): void => port.postMessage(answer);
  port.on('message', (request: DiffRequest) => {
    let result: DiffAnswer;
    try {
      result = { type: 'done', id: request.id, result: runDiffJob(request.job) };
    } catch (err) {
      result = { type: 'failed', id: request.id, message: err instanceof Error ? err.message : String(err) };
    }
    post(result);
  });
  post({ type: 'ready' });
}
