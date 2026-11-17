/*
 * The pipe pi-mcp's `PipeTransport` (pi-mcp 1.5.2 `src/transports/pipe.ts:38-129`) runs a stdio MCP server over: the server is
 * started on the process launcher, so a slow process start blocks no host thread, and the pipe owns ending its whole tree.
 * docs/invariants.md "MCP client and config sources" holds the guarantees.
 */
import type { McpPipe, McpPipeHandlers, PipeTransportOptions } from '@earendil-works/pi-mcp';
import { processLauncher } from '../../process-launcher';
import { log } from '../../logger';
import { failureForLog } from './connect-failure';

/** After `close()` told the tree to stop, how long before POSIX's SIGKILL. */
const KILL_AFTER_MS = 2_000;
const USE_PROCESS_GROUPS = process.platform !== 'win32';

/** Process groups of running servers, signalled if the host exits without closing them. */
const liveProcessGroups = new Set<number>();
let exitHookInstalled = false;

function installExitHook(): void {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.once('exit', () => {
    for (const pid of liveProcessGroups) {
      try {
        process.kill(-pid, 'SIGTERM');
      } catch {
        // the group is gone
      }
    }
  });
}

export interface LauncherPipeOptions {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd?: string;
  // the server's whole environment; nothing of the host's is inherited
  readonly env: Readonly<Record<string, string>>;
  readonly stderr: 'pipe' | 'inherit';
}

/** `PipeTransportOptions.open` for a local stdio server; a start error rejects the transport's `start()`. */
export function launcherPipe(options: LauncherPipeOptions): PipeTransportOptions['open'] {
  return async (handlers: McpPipeHandlers): Promise<McpPipe> => {
    const { command, args, cwd, env, stderr } = options;
    const child = processLauncher().launch({
      file: command,
      args,
      ...(cwd !== undefined ? { cwd } : {}),
      env,
      crossSpawn: true,
      stdio: ['pipe', 'pipe', stderr === 'inherit' ? 'inherit' : 'pipe'],
      windowsHide: true,
      // Its own process group, so stopping the server ends its children too.
      detached: USE_PROCESS_GROUPS,
    });
    child.onData('stdout', (chunk) => handlers.onStdout(chunk));
    child.onData('stderr', (chunk) => handlers.onStderr(chunk));
    const pid = await child.pid;
    if (USE_PROCESS_GROUPS) {
      installExitHook();
      liveProcessGroups.add(pid);
      // Not at the exit: children of the server can outlive it while still holding its output.
      const forget = (): void => void liveProcessGroups.delete(pid);
      void child.closed.then(forget, forget);
    }

    let closing = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    // POSIX: SIGTERM to the group, which reaches it until the output closes. Windows: the call job is terminated, reaching every
    // descendant; the launcher holds its handle until the output closes, so no reused pid is ever named.
    const stopTree = (): void => child.kill({ tree: true, signal: 'SIGTERM' });
    // What a server that exits during a close left running would outlive it.
    void child.exited.then(() => {
      if (closing) stopTree();
    }, () => undefined);
    // Once closed settled the launcher's kill does nothing, so a write failing then needs no stop and no kill timer.
    let settled = false;
    const clearKill = (): void => {
      settled = true;
      clearTimeout(killTimer);
    };
    void child.closed.then(clearKill, clearKill);

    const pipe: McpPipe = {
      write: (data) => {
        // PipeTransport's send resolves once handed here, so a write that fails ends the connection and its pending requests.
        child.write(data).catch((error: unknown) => {
          if (settled) return;
          log('[McpStdio] writing to a server failed, stopping it: %s', failureForLog(error));
          pipe.close();
        });
      },
      closeStdin: () => {
        closing = true;
        child.end();
      },
      close: () => {
        stopTree();
        if (USE_PROCESS_GROUPS && !settled && killTimer === undefined) killTimer = setTimeout(() => child.kill({ tree: true, signal: 'SIGKILL' }), KILL_AFTER_MS);
      },
      // after every output stream closed, so stdout is read to its end; the launcher settles it once a close() ends the tree
      exited: child.closed,
    };
    return pipe;
  };
}
