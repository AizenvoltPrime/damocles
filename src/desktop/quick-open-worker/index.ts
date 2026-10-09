// Quick Open's worker thread: lists each project's files and scores every query off the main process. Plain Node; it never
// imports electron.
import { parentPort } from 'node:worker_threads';
import { createQuickOpenFileSearch } from './file-search';
import type { WorkerRequest } from './protocol';

if (!parentPort) throw new Error('the Quick Open worker must run as a worker thread');
const port = parentPort;
const receive = createQuickOpenFileSearch((reply) => port.postMessage(reply));
// Main builds every request.
port.on('message', (request: WorkerRequest) => receive(request));
