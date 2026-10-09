// The pty host's terminals: spawn, input, resize and kill, output batching and flow control (AD6). No electron import.

import { TERMINAL_HIGH_WATERMARK_CHARS, TERMINAL_LOW_WATERMARK_CHARS } from '../preload/terminal-channels';
import { MAX_HOST_MESSAGE_CHARS, MAX_HOST_PROCESS_NAME_CHARS, TERMINAL_BATCH_CHARS, TERMINAL_BATCH_MS, type HostMessage, type HostRequest } from './protocol';

// Output a pty prints after its exit event still reaches the terminal within this window (VS Code's DataFlushTimeout).
export const EXIT_FLUSH_MS = 250;
// node-pty's resize of a pty whose process ended before its exit event: Unix, then Windows (VS Code ignores the same two).
const RESIZE_AFTER_EXIT_ERRORS: ReadonlySet<string> = new Set(['ioctl(2) failed, EBADF', 'Cannot resize a pty that has already exited']);
// conpty can fail when a pty starts or is killed right after another one (VS Code's KillSpawnThrottleInterval and spacing).
export const CONPTY_THROTTLE_MS = 250;
export const CONPTY_SPACING_MS = 50;
// The foreground process name is read this long after output, at most once per interval (VS Code polls at the same 200 ms).
export const PROCESS_NAME_THROTTLE_MS = 200;

// The part of node-pty's IPty the host uses.
export interface Pty {
  readonly pid: number;
  // the foreground process's name: tcgetpgrp and that one process's name on macOS and Linux, never a process-table walk;
  // node-pty can answer undefined (microsoft/vscode#222323)
  readonly process: string | undefined;
  onData(listener: (data: string) => void): void;
  onExit(listener: (event: { exitCode: number }) => void): void;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  pause(): void;
  resume(): void;
  kill(): void;
}

export interface PtySpawnOptions {
  readonly name: string;
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly cols: number;
  readonly rows: number;
}

export interface PtySessionsDeps {
  readonly spawn: (file: string, args: readonly string[], options: PtySpawnOptions) => Pty;
  readonly post: (message: HostMessage) => void;
  // spaces conpty starts and kills apart
  readonly throttleConpty: boolean;
  // reports the foreground process name (macOS and Linux; Windows' never changes)
  readonly readProcessName: boolean;
}

interface Session {
  readonly pty: Pty;
  // characters posted to main that the shell has not acknowledged
  unacked: number;
  paused: boolean;
  buffer: string;
  timer: NodeJS.Timeout | undefined;
  exited: boolean;
  // ready was posted
  announced: boolean;
  // the pending foreground process read, and the last name posted
  processTimer: NodeJS.Timeout | undefined;
  processName: string | undefined;
}

function errorText(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).slice(0, MAX_HOST_MESSAGE_CHARS);
}

// The longest prefix of at most TERMINAL_BATCH_CHARS that does not end inside a surrogate pair.
function batchEnd(text: string): number {
  if (text.length <= TERMINAL_BATCH_CHARS) return text.length;
  const code = text.charCodeAt(TERMINAL_BATCH_CHARS - 1);
  return code >= 0xd800 && code <= 0xdbff ? TERMINAL_BATCH_CHARS - 1 : TERMINAL_BATCH_CHARS;
}

export interface PtySessions {
  handle(request: HostRequest): Promise<void>;
}

export function createPtySessions(deps: PtySessionsDeps): PtySessions {
  const sessions = new Map<string, Session>();
  let lastKillOrStart = 0;
  // Windows ptys with no output and no exit yet. node-pty runs their kill only on the first output, in the same data event
  // after the host's listener, so shutdown waits for these; a host that exits sooner leaves their shells running.
  const connecting = new Map<Pty, Promise<void>>();

  const throttle = async (): Promise<void> => {
    if (!deps.throttleConpty) return;
    while (Date.now() - lastKillOrStart < CONPTY_THROTTLE_MS) {
      await new Promise((resolve) => setTimeout(resolve, CONPTY_THROTTLE_MS - (Date.now() - lastKillOrStart) + CONPTY_SPACING_MS));
    }
    lastKillOrStart = Date.now();
  };

  const flush = (id: string, session: Session): void => {
    clearTimeout(session.timer);
    session.timer = undefined;
    while (session.buffer.length > 0) {
      const end = batchEnd(session.buffer);
      deps.post({ type: 'data', id, data: session.buffer.slice(0, end) });
      session.buffer = session.buffer.slice(end);
    }
  };

  const readProcessName = (id: string, session: Session): void => {
    session.processTimer = undefined;
    const name = (session.pty.process ?? '').slice(0, MAX_HOST_PROCESS_NAME_CHARS);
    if (name === session.processName) return;
    session.processName = name;
    deps.post({ type: 'process', id, name });
  };

  const scheduleProcessName = (id: string, session: Session): void => {
    if (deps.readProcessName && !session.exited && session.processTimer === undefined) session.processTimer = setTimeout(() => readProcessName(id, session), PROCESS_NAME_THROTTLE_MS);
  };

  const output = (id: string, session: Session, data: string): void => {
    announce(id, session);
    scheduleProcessName(id, session);
    session.unacked += data.length;
    if (!session.paused && session.unacked > TERMINAL_HIGH_WATERMARK_CHARS) {
      session.paused = true;
      session.pty.pause();
    }
    session.buffer += data;
    if (session.buffer.length >= TERMINAL_BATCH_CHARS) flush(id, session);
    else session.timer ??= setTimeout(() => flush(id, session), TERMINAL_BATCH_MS);
  };

  const announce = (id: string, session: Session): void => {
    if (session.announced) return;
    session.announced = true;
    deps.post({ type: 'ready', id, pid: session.pty.pid });
  };

  const acknowledge = (session: Session, chars: number): void => {
    session.unacked = Math.max(session.unacked - chars, 0);
    if (session.paused && session.unacked < TERMINAL_LOW_WATERMARK_CHARS) {
      session.paused = false;
      session.pty.resume();
    }
  };

  const spawn = async (request: Extract<HostRequest, { type: 'spawn' }>, cancelled: () => boolean): Promise<void> => {
    // Main issues each id once and restarts a terminal only after its exit was reported.
    if (sessions.has(request.id)) throw new Error(`terminal ${request.id} is already running`);
    if (cancelled()) return;
    await throttle();
    if (cancelled()) return;
    let pty: Pty;
    try {
      pty = deps.spawn(request.file, request.args, { name: 'xterm-256color', cwd: request.cwd, env: request.env, cols: request.cols, rows: request.rows });
    } catch (err) {
      deps.post({ type: 'error', id: request.id, message: errorText(err) });
      return;
    }
    const session: Session = { pty, unacked: 0, paused: false, buffer: '', timer: undefined, exited: false, announced: false, processTimer: undefined, processName: undefined };
    sessions.set(request.id, session);
    let connected = (): void => undefined;
    if (pty.pid === 0) {
      connecting.set(pty, new Promise((resolve) => {
        connected = () => {
          connecting.delete(pty);
          resolve();
        };
      }));
    }
    pty.onData((data) => {
      connected();
      if (sessions.get(request.id) === session) output(request.id, session, data);
    });
    pty.onExit(({ exitCode }) => {
      connected();
      if (sessions.get(request.id) !== session) return;
      session.exited = true;
      clearTimeout(session.processTimer);
      session.processTimer = undefined;
      setTimeout(() => {
        if (sessions.get(request.id) !== session) return;
        flush(request.id, session);
        sessions.delete(request.id);
        clearTimeout(session.processTimer);
        deps.post({ type: 'exit', id: request.id, exitCode });
      }, EXIT_FLUSH_MS);
    });
    // node-pty connects a Windows pty after spawn returns, with pid 0 until its first output (microsoft/node-pty#885).
    if (pty.pid > 0) announce(request.id, session);
  };

  const resize = (pty: Pty, cols: number, rows: number): void => {
    try {
      pty.resize(cols, rows);
    } catch (err) {
      if (!(err instanceof Error && RESIZE_AFTER_EXIT_ERRORS.has(err.message))) throw err;
    }
  };

  // ptys whose kill waits for the conpty throttle
  const dying = new Set<Pty>();

  const kill = async (id: string): Promise<void> => {
    const session = sessions.get(id);
    if (!session) return;
    sessions.delete(id);
    clearTimeout(session.timer);
    clearTimeout(session.processTimer);
    if (session.exited) return;
    dying.add(session.pty);
    await throttle();
    if (dying.delete(session.pty)) session.pty.kill();
  };

  // Every pty at once, unthrottled, as a quit always did; a spawn still waiting is cancelled by the caller's epoch.
  const killAll = (): void => {
    for (const [id, session] of [...sessions]) {
      sessions.delete(id);
      clearTimeout(session.timer);
      clearTimeout(session.processTimer);
      if (!session.exited) session.pty.kill();
    }
    for (const pty of dying) pty.kill();
    dying.clear();
  };

  // Input, a resize or an ack for a pty that already exited or was killed is dropped.
  const forward = (request: Extract<HostRequest, { type: 'input' | 'resize' | 'ack' | 'clearAck' }>): void => {
    const session = sessions.get(request.id);
    if (!session || session.exited) return;
    if (request.type === 'input') session.pty.write(request.data);
    else if (request.type === 'resize') resize(session.pty, request.cols, request.rows);
    else if (request.type === 'ack') acknowledge(session, request.chars);
    else acknowledge(session, session.unacked);
  };

  // Spawns and kills run one at a time, in order, so a kill sent while its spawn waits for the conpty throttle finds the
  // started pty. A terminal's other requests wait only for its own pending spawn, in order, and otherwise run at once.
  // killAll and shutdown start a new epoch, which cancels every spawn still waiting. A rejected request rejects only its
  // own promise, whose caller ends the host.
  const settled = (promise: Promise<void>): Promise<void> => promise.then(() => undefined, () => undefined);
  let lifecycle: Promise<void> = Promise.resolve();
  const waiting = new Map<string, Promise<void>>();
  let epoch = 0;
  const queueBehind = (id: string, handled: Promise<void>): Promise<void> => {
    const tail = settled(handled);
    waiting.set(id, tail);
    void tail.then(() => {
      if (waiting.get(id) === tail) waiting.delete(id);
    });
    return handled;
  };
  return {
    async handle(request) {
      switch (request.type) {
        case 'spawn': {
          const started = epoch;
          const handled = lifecycle.then(() => spawn(request, () => started !== epoch));
          lifecycle = settled(handled);
          return queueBehind(request.id, handled);
        }
        case 'kill': {
          const handled = lifecycle.then(() => kill(request.id));
          lifecycle = settled(handled);
          return handled;
        }
        case 'killAll':
          epoch++;
          killAll();
          return;
        case 'shutdown':
          epoch++;
          killAll();
          await Promise.all(connecting.values());
          return;
        default: {
          const prior = waiting.get(request.id);
          if (prior) return queueBehind(request.id, prior.then(() => forward(request)));
          forward(request);
        }
      }
    },
  };
}
