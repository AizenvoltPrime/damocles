import MergeWorker from './merge.worker?worker';
import type { ConflictRegion, MergeLabels, MergeReply, MergeRequest } from './merge-model';

export interface MergeWorkerClient {
  /** The conflicting regions of base, current and incoming; null past MERGE_ALIGN_MAX_LINES. */
  align(base: string, current: string, incoming: string): Promise<ConflictRegion[] | null>;
  /** Reset Result's text; null past MERGE_ALIGN_MAX_LINES. */
  markers(base: string, current: string, incoming: string, labels: MergeLabels, eol: string): Promise<string | null>;
  /** Ends the worker and any merge it is still computing; what waits on it never settles. */
  dispose(): void;
}

type Ask = MergeRequest extends infer Request ? (Request extends MergeRequest ? Omit<Request, 'id'> : never) : never;

/** One merge editor's worker. A worker that fails to load or throws rejects every request waiting on it and each later one. */
export function createMergeWorker(): MergeWorkerClient {
  const worker = new MergeWorker();
  let nextId = 0;
  let failed = false;
  const waiting = new Map<number, { resolve: (reply: MergeReply) => void; reject: (error: Error) => void }>();
  const fail = (): void => {
    failed = true;
    for (const { reject } of waiting.values()) reject(new Error('The merge worker failed'));
    waiting.clear();
  };
  worker.addEventListener('message', (event: MessageEvent<MergeReply>) => {
    const waiter = waiting.get(event.data.id);
    waiting.delete(event.data.id);
    waiter?.resolve(event.data);
  });
  worker.addEventListener('error', fail);
  worker.addEventListener('messageerror', fail);

  const ask = (request: Ask): Promise<MergeReply> =>
    new Promise((resolve, reject) => {
      if (failed) {
        reject(new Error('The merge worker failed'));
        return;
      }
      const id = ++nextId;
      waiting.set(id, { resolve, reject });
      worker.postMessage({ ...request, id } as MergeRequest);
    });

  return {
    async align(base, current, incoming) {
      const reply = await ask({ kind: 'align', base, current, incoming });
      return reply.kind === 'align' ? reply.regions : null;
    },
    async markers(base, current, incoming, labels, eol) {
      const reply = await ask({ kind: 'markers', base, current, incoming, labels, eol });
      return reply.kind === 'markers' ? reply.text : null;
    },
    dispose() {
      worker.terminate();
      waiting.clear();
    },
  };
}
