// Damocles Core's utility process as main runs it: the fork, the channel, how it ended, and the restart policy
// (docs/invariants.md "Desktop host", VS Code's extension host policy).
import { StringDecoder } from 'node:string_decoder';
import { app, utilityProcess, type Details } from 'electron';
import type { Disposable } from '../../platform/disposable';
import type { CoreTransport } from '../core-protocol';
import { hostEnvironment } from './formatting/formatter-process';

// The name app's child-process-gone reports core by (Details.name), and app.getAppMetrics() lists it under.
export const CORE_SERVICE_NAME = 'Damocles Core';
// Electron emits child-process-gone a few ms after the utility process's exit; the exit's reason waits this long for it.
export const CORE_GONE_WAIT_MS = 500;
// How long a forked core has to become ready before main kills it as hung (bootstrap.ts). VS Code waits 60 s for its
// extension host's ready message; core's ready comes later, after the CA store read and the engine's services are built.
export const CORE_READY_TIMEOUT_MS = 120_000;
// How long a POSIX core has to exit after kill's SIGTERM before it gets SIGKILL.
export const CORE_KILL_GRACE_MS = 1_000;
// The stderr tail kept for the log when core ends.
const STDERR_TAIL_CHARS = 16 * 1024;

export const RESTART_LIMIT = 3;
export const RESTART_WINDOW_MS: number = 5 * 60 * 1000;

/** How core's process ended: its exit code, Chromium's reason when it did not exit by itself, and the tail of its stderr. */
export interface CoreExit {
  readonly code: number;
  readonly reason: Details['reason'] | null;
  readonly stderr: string | null;
}

export interface CoreProcess {
  // undefined until the process spawned
  readonly pid: number | undefined;
  readonly spawned: Promise<void>;
  // the one ordered channel: child.postMessage and the child's message events
  readonly transport: CoreTransport;
  // as soon as the process ended, however it ended
  onExit(listener: (code: number) => void): Disposable;
  // settles as soon as the process exited, with its code
  readonly exited: Promise<number>;
  // settles with how the process ended once Chromium told why, or CORE_GONE_WAIT_MS after the exit
  readonly ended: Promise<CoreExit>;
  // ends the process even when its event loop is blocked
  kill(): void;
}

/** Forks dist/core-host.js (coreHostEntryPath) as the "Damocles Core" utility process; stdout follows main's when echo is set. */
export function forkCore(entry: string, echo: boolean): CoreProcess {
  const child = utilityProcess.fork(entry, [], {
    env: hostEnvironment(process.env),
    serviceName: CORE_SERVICE_NAME,
    stdio: ['ignore', echo ? 'inherit' : 'ignore', 'pipe'],
  });
  const decoder = new StringDecoder('utf8');
  let stderr = '';
  child.stderr?.on('data', (chunk: Buffer | string) => {
    stderr = (stderr + (typeof chunk === 'string' ? chunk : decoder.write(chunk))).slice(-STDERR_TAIL_CHARS);
  });
  let fatal: string | null = null;
  child.on('error', (type, location) => {
    fatal = `${type} at ${location}`;
  });
  const tail = (): string | null => {
    if (fatal !== null) return fatal;
    const text = stderr.trim();
    return text === '' ? null : text;
  };
  const spawned = new Promise<void>((resolve) => child.once('spawn', () => resolve()));
  const exited = new Promise<number>((resolve) => child.once('exit', resolve));
  const ended = exited.then((code) => new Promise<CoreExit>((resolve) => {
    const finish = (reason: Details['reason'] | null): void => {
      app.off('child-process-gone', onGone);
      clearTimeout(timer);
      resolve({ code, reason, stderr: tail() });
    };
    const onGone = (_event: unknown, details: Details): void => {
      if (details.type === 'Utility' && details.name === CORE_SERVICE_NAME) finish(details.reason);
    };
    const timer = setTimeout(() => finish(null), CORE_GONE_WAIT_MS);
    app.on('child-process-gone', onGone);
  }));
  return {
    get pid() {
      return child.pid;
    },
    spawned,
    transport: {
      post: (message) => child.postMessage(message),
      onMessage: (listener) => {
        const received = (message: unknown): void => listener(message);
        child.on('message', received);
        return { dispose: () => { child.off('message', received); } };
      },
    },
    onExit: (listener) => {
      let live = true;
      void exited.then((code) => {
        if (live) listener(code);
      });
      return { dispose: () => { live = false; } };
    },
    exited,
    ended,
    kill: () => {
      const pid = child.pid;
      child.kill();
      // On POSIX kill is SIGTERM, which signal-exit's listener (proper-lockfile) takes and runs only on a free event loop;
      // on Windows it is TerminateProcess.
      if (pid === undefined || process.platform === 'win32') return;
      const timer = setTimeout(() => {
        try {
          process.kill(pid, 'SIGKILL');
        } catch (err) {
          // it exited before Electron reported the exit
          if ((err as NodeJS.ErrnoException).code !== 'ESRCH') throw err;
        }
      }, CORE_KILL_GRACE_MS);
      void exited.then(() => clearTimeout(timer));
    },
  };
}

export type RestartDecision =
  | { readonly restart: true; readonly crashes: readonly number[]; readonly count: number }
  | { readonly restart: false; readonly crashes: readonly number[] };

/**
 * A crash at `now` given the earlier crashes' times: core restarts while fewer than RESTART_LIMIT restarts happened in the
 * rolling RESTART_WINDOW_MS, and stays down past that. `count` is this restart's place among them.
 */
export function restartDecision(crashes: readonly number[], now: number): RestartDecision {
  const recent = crashes.filter((at) => now - at < RESTART_WINDOW_MS);
  const next = [...recent, now];
  return recent.length < RESTART_LIMIT ? { restart: true, crashes: next, count: recent.length + 1 } : { restart: false, crashes: next };
}
