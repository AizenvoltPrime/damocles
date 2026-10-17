// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest';
import { handleMergeRequest, type MergeReply, type MergeRequest } from '../editor/merge/merge-model';

const workers = vi.hoisted(() => {
  // The merge worker double: it answers with the real handler, out of order on demand, or fails as a worker that cannot load.
  class FakeWorker extends EventTarget {
    static started: FakeWorker[] = [];
    readonly held: MergeRequest[] = [];
    holding = false;
    terminated = false;
    answer: (request: MergeRequest) => MergeReply = () => {
      throw new Error('no handler');
    };
    constructor() {
      super();
      FakeWorker.started.push(this);
    }
    postMessage(request: MergeRequest): void {
      if (this.holding) this.held.push(request);
      else this.reply(request);
    }
    reply(request: MergeRequest): void {
      queueMicrotask(() => this.dispatchEvent(new MessageEvent('message', { data: this.answer(request) })));
    }
    terminate(): void {
      this.terminated = true;
    }
    fail(): void {
      this.dispatchEvent(new Event('error'));
    }
  }
  return FakeWorker;
});
vi.mock('../editor/merge/merge.worker?worker', () => ({ default: workers }));

const { createMergeWorker } = await import('../editor/merge/merge-worker');

const BASE = 'top\nshared\nend\n';

describe('the merge editor\'s worker', () => {
  it('answers each request with its own reply, in whatever order they come back', async () => {
    const client = createMergeWorker();
    const worker = workers.started.at(-1)!;
    worker.answer = handleMergeRequest;
    worker.holding = true;
    const aligned = client.align(BASE, 'top\nours\nend\n', 'top\ntheirs\nend\n');
    const merged = client.markers(BASE, 'top\nours\nend\n', BASE, { current: 'c', incoming: 'i', base: 'b' }, '\n');
    for (const request of [...worker.held].reverse()) worker.reply(request);
    expect(await merged).toBe('top\nours\nend\n');
    expect(await aligned).toHaveLength(1);
    client.dispose();
    expect(worker.terminated).toBe(true);
  });

  it('rejects what waits, and every later request, once its worker fails', async () => {
    const client = createMergeWorker();
    const worker = workers.started.at(-1)!;
    worker.holding = true;
    const waiting = client.align(BASE, BASE, BASE);
    worker.fail();
    await expect(waiting).rejects.toThrow('The merge worker failed');
    await expect(client.markers(BASE, BASE, BASE, { current: 'c', incoming: 'i', base: 'b' }, '\n')).rejects.toThrow('The merge worker failed');
    client.dispose();
  });
});
