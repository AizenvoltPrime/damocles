// The watch worker thread: runs the Windows recursive watches, so libuv's per-event GetLongPathNameW call blocks this thread's
// loop instead of main's. Plain Node; it never imports electron.
import { parentPort } from 'node:worker_threads';
import type { Disposable } from '../../platform/disposable';
import { createInProcessTreeHost, errorText } from './fs-watch-tree';
import type { WatchEvent, WatchReply, WatchRequest } from './protocol';

if (!parentPort) throw new Error('the watch worker must run as a worker thread');
const port = parentPort;

// Per watch, what it emitted since the last post; posted once per turn, and before any other reply so main keeps the order.
const outbox = new Map<number, WatchEvent[]>();
let postQueued = false;

const postEvents = (): void => {
  postQueued = false;
  for (const [id, events] of outbox) port.postMessage({ kind: 'events', id, events } satisfies WatchReply);
  outbox.clear();
};

const post = (reply: WatchReply): void => {
  postEvents();
  port.postMessage(reply);
};

const host = createInProcessTreeHost((line) => post({ kind: 'log', line }));
const watches = new Map<number, Disposable>();

const watch = (id: number, dir: string, report: boolean): void => {
  const emit = (type: WatchEvent[0], fsPath: string): void => {
    let events = outbox.get(id);
    if (!events) outbox.set(id, (events = []));
    events.push([type, fsPath]);
    if (postQueued) return;
    postQueued = true;
    queueMicrotask(postEvents);
  };
  const lost = (): void => {
    watches.delete(id);
    post({ kind: 'lost', id });
  };
  try {
    watches.set(id, host.start(dir, report, emit, lost));
  } catch (err) {
    post({ kind: 'failed', id, message: errorText(err) });
  }
};

// Main builds every request.
port.on('message', (request: WatchRequest) => {
  if (request.kind === 'watch') {
    watch(request.id, request.dir, request.report);
  } else if (request.kind === 'unwatch') {
    watches.get(request.id)?.dispose();
    watches.delete(request.id);
  } else {
    for (const each of watches.values()) each.dispose();
    watches.clear();
    void host.close().then(() => post({ kind: 'closed' }));
  }
});
