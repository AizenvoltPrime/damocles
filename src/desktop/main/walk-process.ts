// Main's walk processes: utility processes, which Chromium's launcher thread starts with only the handles it names, so a start of
// main's own launcher never leaves a handle in one (docs/perf.md "Concurrent starts on Windows").
import { StringDecoder } from 'node:string_decoder';
import { utilityProcess } from 'electron';
import type { ProcessExit } from '../../core/process-launcher';
import { createWalkHost, type WalkChild, type WalkHost } from '../../core/search-walk/walk-host';
import { hostEnvironment } from '../local-services/host-environment';

// The name app.getAppMetrics() and child-process-gone report a walk process by.
export const WALK_SERVICE_NAME = 'Damocles Walk';

/** Forks the walk process (dist/walk-child.js) as a utility process; requests and replies travel over its parent port. */
export function forkWalkChild(entry: string): WalkChild {
  const child = utilityProcess.fork(entry, [], { env: hostEnvironment(process.env), serviceName: WALK_SERVICE_NAME, stdio: ['ignore', 'ignore', 'pipe'] });
  const stderr: Array<(text: string) => void> = [];
  const decoder = new StringDecoder('utf8');
  child.stderr?.on('data', (chunk: Buffer | string) => {
    const text = typeof chunk === 'string' ? chunk : decoder.write(chunk);
    for (const listener of stderr) listener(text);
  });
  child.on('error', (type, location) => {
    for (const listener of stderr) listener(`${type} at ${location}`);
  });
  let gone = false;
  const exit = new Promise<ProcessExit>((resolve) => child.once('exit', (code) => {
    gone = true;
    resolve({ code, signal: null });
  }));
  // stderr closes after the exit event, so a crash's last lines reach the log before the exit is reported
  const stderrClosed = new Promise<void>((resolve) => (child.stderr ? child.stderr.once('close', () => resolve()) : resolve()));
  const exited = Promise.all([exit, stderrClosed]).then(([code]) => code);
  return {
    onReply: (listener) => void child.on('message', listener),
    onStderr: (listener) => void stderr.push(listener),
    send: async (request) => {
      if (gone) throw new Error('The process has closed');
      child.postMessage(request);
    },
    exited,
    kill: () => {
      const pid = child.pid;
      child.kill();
      // On POSIX kill is SIGTERM; the walk process has nothing to clean up, and the launcher's walk processes get SIGKILL too.
      if (pid === undefined || gone || process.platform === 'win32') return;
      try {
        process.kill(pid, 'SIGKILL');
      } catch (err) {
        // it exited before Electron reported the exit
        if ((err as NodeJS.ErrnoException).code !== 'ESRCH') throw err;
      }
    },
  };
}

/** Main's walk host, over utility-process walk children. */
export function mainWalkHost(entry: string, log: (line: string) => void): WalkHost {
  return createWalkHost(() => forkWalkChild(entry), log);
}
