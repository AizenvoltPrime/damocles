// Bundled by launcher.test.ts: a launcher worker whose start of a process carrying the block argument holds its thread for
// 3 s; both values match the test's BLOCK_ARG and BLOCK_MS.
import { spawn } from 'node:child_process';
import { parentPort } from 'node:worker_threads';
import { serveLauncher } from '../../worker';

const BLOCK_ARG = '--damocles-test-block-start';

serveLauncher(parentPort!, {
  spawn: (file, args, options) => {
    if (args.includes(BLOCK_ARG)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 3000);
    return spawn(file, args.filter((arg) => arg !== BLOCK_ARG), options);
  },
});
