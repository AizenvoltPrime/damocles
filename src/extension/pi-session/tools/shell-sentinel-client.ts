import { spawn } from 'child_process';
import { existsSync } from 'node:fs';
import * as path from 'node:path';
import { log } from '../../logger';

/** The host end of one panel's sentinel: the write end of the helper's stdin, and nothing else. */
export interface ShellSentinel {
  /** Hand the sentinel one process group id to kill once the pipe closes. */
  register(pgid: number): void;
  /** Report that the shell leading this group has exited. Not an unregistration: the group stays tracked. */
  shellExited(pgid: number): void;
  /** Close the write end. The EOF that reaches the sentinel is the only thing that makes it act. */
  dispose(): void;
}

/**
 * Locate the sentinel bundle, which is the sibling of the bundle this file is compiled into once packaged
 * and lives under the repository's own `dist` when this file is loaded from source.
 */
function sentinelBundlePath(): string {
  const packaged = path.join(__dirname, 'sentinel.js');
  if (existsSync(packaged)) return packaged;
  return path.join(__dirname, '..', '..', '..', '..', 'dist', 'sentinel.js');
}

/**
 * Start one panel's sentinel and keep the write end of its stdin.
 *
 * The guarantee comes from the pipe rather than from any code here: the OS closes this end whether the host
 * exits cleanly, is force-quit or is OOM-killed, and the EOF that follows is what the sentinel waits for.
 * Panel close and host death are therefore the same path, so nothing here may kill a registered group
 * itself; a second killer would need its own copy of the sentinel's pid-reuse check.
 *
 * `process.execPath` is the VS Code binary in a desktop extension host, so `ELECTRON_RUN_AS_NODE` is what
 * makes it run a plain script; in a remote or WSL host it is already node and the variable is inert.
 */
export function startShellSentinel(): ShellSentinel {
  const child = spawn(process.execPath, [sentinelBundlePath()], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    // Detached and unref'd, because the whole point is that it outlives this process.
    detached: true,
    stdio: ['pipe', 'ignore', 'pipe'],
    windowsHide: true,
  });
  // An unhandled 'error' event on a ChildProcess takes the extension host down with it.
  child.on('error', (error) =>
    log('[ShellSentinel] ERROR: the sentinel failed to start; processes this panel leaves running will not be cleaned up: %O', error),
  );
  child.on('exit', (code, signal) => {
    if (code === 0) return;
    log(
      '[ShellSentinel] ERROR: the sentinel exited with code %o signal %o; processes this panel leaves running will not be cleaned up',
      code,
      signal,
    );
  });
  child.unref();
  // A write to a pipe whose reader has died raises EPIPE, and an unlistened stream error is fatal.
  child.stdin?.on('error', (error) => log('[ShellSentinel] ERROR: writing to the sentinel failed: %O', error));
  // The sentinel has no other way to report a failed probe, so discarding this stream loses the only signal.
  child.stderr?.setEncoding('utf8');
  child.stderr?.on('data', (chunk: string) => log('[ShellSentinel] %s', chunk.trimEnd()));
  child.stderr?.on('error', (error) => log('[ShellSentinel] ERROR: reading the sentinel log failed: %O', error));

  let open = true;
  return {
    // The exit record is what lets the sentinel anchor a group's survivors, so it must reach the pipe
    // while the group still exists. Both records are one line, because the reader splits on newlines.
    register: (pgid: number): void => {
      if (open) child.stdin?.write(`r${pgid}\n`);
    },
    shellExited: (pgid: number): void => {
      if (open) child.stdin?.write(`x${pgid}\n`);
    },
    dispose: (): void => {
      if (!open) return;
      open = false;
      // `end()` shuts the write direction down, which is the EOF; dropping the reference would not.
      child.stdin?.end();
    },
  };
}
