// Where a daemon finds a terminal host: its record <runDir>/terminal-hosts/<pid>.json, its endpoint (a socket in the host's
// own mkdtemp folder on POSIX, a pipe with a random name on Windows), its token (beside the socket, or beside the record
// on Windows, under the run folder's user-only ACL) and its terminals file <pid>.terminals beside the record.
import { promises as fs } from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { NODE_PTY_ARG_PREFIX } from '../pty-host/protocol';
import { startIdentity, type StartIdentity } from '../daemon/process-identity';
import { createSocketFolder, hostPipeName, hostRecordFile, hostSocketPath, hostTerminalsFile, hostTokenPath, removeHostFiles, removeHostSocketFolder, socketFolderBase, touch, writePidFile, writeToken, type PidRecord, type RunPaths } from '../daemon/token';
import type { HostedTerminal } from './host-messages';
import { writeHostTerminals, type HostTerminals, type PersistedTerminal } from './terminals-file';

// The host's argv entry naming the run folder of the daemon that started it.
export const RUN_DIR_ARG_PREFIX = '--run-dir=';
// pipe names tried before a start fails; each collision means another process holds a 128-bit random name
const PIPE_ATTEMPTS = 5;
// how soon, when no terminal changed meanwhile, a terminals file whose write failed is written again, and a start identity that
// could not be read is read again, then twice as long after each further failure, up to IDENTITY_RETRY_MAX_MS
export const TERMINALS_REWRITE_MS = 30_000;
export const IDENTITY_RETRY_MAX_MS: number = 10 * 60_000;

/** The arguments a daemon under `root` starts its terminal host with, after the Node binary. */
export function terminalHostArgs(root: string, runDir: string): string[] {
  return [path.join(root, 'dist', 'terminal-host.js'), `${RUN_DIR_ARG_PREFIX}${runDir}`, `${NODE_PTY_ARG_PREFIX}${path.join(root, 'node_modules', 'node-pty')}`];
}

export interface ServeOptions {
  // the run folder must exist: its maker gave it the user-only ACL the Windows token relies on
  readonly paths: RunPaths;
  // the host's server version, which the record carries
  readonly version: string;
  readonly accept: (socket: net.Socket, token: Uint8Array) => void;
  readonly touchIntervalMs: number;
  readonly log: (line: string) => void;
  // the pid the record is named by; the process's own outside tests
  readonly pid?: number;
  // the pipe names to try on Windows; hostPipeName outside tests
  readonly pipeNames?: () => string;
  // startIdentity outside tests
  readonly identity?: StartIdentity;
  // TERMINALS_REWRITE_MS outside tests
  readonly rewriteMs?: number;
}

export interface ServedTerminalHost {
  readonly record: PidRecord;
  // the terminals the host holds now, written to its terminals file with each shell's start identity
  list(terminals: readonly HostedTerminal[]): void;
  // stops listening and the terminals file's writes, and removes the record, the terminals file, the token and the socket folder
  close(): Promise<void>;
}

function listen(server: net.Server, endpoint: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const failed = (err: Error): void => {
      server.off('listening', listening);
      reject(err);
    };
    const listening = (): void => {
      server.off('error', failed);
      resolve();
    };
    server.once('error', failed);
    server.once('listening', listening);
    server.listen(endpoint);
  });
}

async function listenOnPipe(server: net.Server, names: () => string, log: (line: string) => void): Promise<string> {
  for (let attempt = 1; ; attempt++) {
    const endpoint = names();
    try {
      await listen(server, endpoint);
      return endpoint;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EADDRINUSE' || attempt >= PIPE_ATTEMPTS) throw err;
      log(`[terminal-host] the pipe name ${endpoint} is taken; picking another`);
    }
  }
}

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * Listens on a new endpoint with a new token, writes its terminals file and then the record once it listens, and touches the
 * record, token and endpoint every interval.
 */
export async function serveTerminalHost(options: ServeOptions): Promise<ServedTerminalHost> {
  const { paths, log } = options;
  const pid = options.pid ?? process.pid;
  const identity = options.identity ?? startIdentity;
  await fs.mkdir(paths.terminalHostsDir, { mode: 0o700 }).catch((err: unknown) => {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
  });
  const retryMs = options.rewriteMs ?? TERMINALS_REWRITE_MS;
  // what failed to be read is logged once, and read again, one read at a time, once its backoff passed
  const toldUnread = new Set<string>();
  const backoff = new Map<string, { readonly failures: number; readonly at: number }>();
  const due = (key: string): boolean => (backoff.get(key)?.at ?? 0) <= Date.now();
  const unread = (key: string, line: string): undefined => {
    if (!toldUnread.has(key)) log(line);
    toldUnread.add(key);
    const failures = (backoff.get(key)?.failures ?? 0) + 1;
    backoff.set(key, { failures, at: Date.now() + Math.min(retryMs * 2 ** (failures - 1), IDENTITY_RETRY_MAX_MS) });
    return undefined;
  };
  const ownStart = (): Promise<string | undefined> => identity(pid).then(
    (start) => {
      if (start === undefined) return unread('host', `[terminal-host] its own pid ${pid} names no process, so no daemon can end it directly until a later read succeeds`);
      backoff.delete('host');
      return start;
    },
    (err: unknown) => unread('host', `[terminal-host] its own start identity cannot be read, so no daemon can end it directly until a later read succeeds: ${errorText(err)}`),
  );
  let hostStart = await ownStart();
  const own = (): Pick<HostTerminals, 'hostStart'> => (hostStart === undefined ? {} : { hostStart });
  const terminalsFile = hostTerminalsFile(paths, pid);
  const socketFolder = process.platform === 'win32' ? null : await createSocketFolder(await socketFolderBase());
  const tokenFile = hostTokenPath(paths, { pid, socketFolder });
  let server: net.Server | undefined;
  let record: PidRecord;
  try {
    // a token an earlier process of this pid left is not this host's
    if (socketFolder === null) await fs.rm(tokenFile, { force: true });
    const token = await writeToken(tokenFile);
    server = net.createServer((socket) => options.accept(socket, token));
    const endpoint = socketFolder === null ? await listenOnPipe(server, options.pipeNames ?? hostPipeName, log) : hostSocketPath(socketFolder);
    if (socketFolder !== null) await listen(server, endpoint);
    server.on('error', (err) => log(`[terminal-host] its endpoint ${endpoint} failed: ${err.message}`));
    // before the record, so a daemon that finds the record finds the list
    await writeHostTerminals(terminalsFile, { ...own(), terminals: [] });
    record = { version: options.version, pid, hostname: os.hostname(), endpoint, socketFolder, updatedAt: Date.now() };
    await writePidFile(hostRecordFile(paths, pid), record);
  } catch (err) {
    server?.close();
    await fs.rm(terminalsFile, { force: true });
    if (socketFolder === null) await fs.rm(tokenFile, { force: true });
    else await removeHostSocketFolder(socketFolder);
    throw err;
  }
  log(`[terminal-host] listening on ${record.endpoint}`);
  const files = [hostRecordFile(paths, pid), tokenFile, ...(socketFolder === null ? [] : [socketFolder, record.endpoint])];
  const listening = server;
  const toucher = setInterval(() => {
    touch(files).then((present) => {
      if (!present) log('[terminal-host] the record, the token, the socket folder or the socket was removed; no daemon can adopt this host until it is back');
    }, (err: unknown) => log(`[terminal-host] the touch of the host's files failed: ${err instanceof Error ? err.message : String(err)}`));
  }, options.touchIntervalMs);
  toucher.unref();

  // each shell's start identity by terminal id once read, undefined for a shell that had ended; one that failed is read again
  const starts = new Map<string, { readonly pid: number; readonly start: string | undefined }>();
  let latest: readonly HostedTerminal[] = [];
  // one write at a time, each of the latest list; a list given meanwhile is written next
  let writing: Promise<void> | undefined;
  let stale = false;
  let closed = false;
  // the file's text as last written
  let written = JSON.stringify({ ...own(), terminals: [] });
  // the next try after a failed write (at writeAgainAt) or read, unless a newer list comes first
  let rewrite: NodeJS.Timeout | undefined;
  const retryLater = (writeAgainAt = Infinity): void => {
    const at = Math.min(writeAgainAt, ...[...backoff.values()].map((entry) => entry.at));
    if (!Number.isFinite(at)) return;
    clearTimeout(rewrite);
    rewrite = setTimeout(() => {
      stale = true;
      flush();
    }, Math.max(0, at - Date.now()));
    rewrite.unref();
  };
  const shellKey = (terminal: HostedTerminal): string => `${terminal.id} ${terminal.pid}`;
  // read: the identity, or undefined for a shell that has ended; false when it cannot be read
  const shellStart = (terminal: HostedTerminal): Promise<{ readonly start: string | undefined } | false> => identity(terminal.pid).then((start) => {
    if (start === undefined) log(`[terminal-host] the shell ${terminal.pid} of ${terminal.id} ended before its start identity was read`);
    backoff.delete(shellKey(terminal));
    return { start };
  }, (err: unknown) => {
    unread(shellKey(terminal), `[terminal-host] the start identity of the shell ${terminal.pid} of ${terminal.id} cannot be read, so no daemon can kill it directly until a later read succeeds: ${errorText(err)}`);
    return false;
  });
  const write = async (): Promise<void> => {
    stale = false;
    const terminals = latest;
    if (hostStart === undefined && due('host')) hostStart = await ownStart();
    for (const terminal of terminals) {
      if (terminal.pid <= 0 || starts.get(terminal.id)?.pid === terminal.pid || !due(shellKey(terminal))) continue;
      const read = await shellStart(terminal);
      if (read) starts.set(terminal.id, { pid: terminal.pid, start: read.start });
    }
    const listed = new Set(['host', ...terminals.map(shellKey)]);
    for (const key of [...backoff.keys()]) if (!listed.has(key)) backoff.delete(key);
    for (const id of [...starts.keys()]) if (!terminals.some((terminal) => terminal.id === id)) starts.delete(id);
    if (closed) return;
    const persisted = terminals.map((terminal): PersistedTerminal => {
      const known = starts.get(terminal.id);
      return known?.pid === terminal.pid && known.start !== undefined ? { ...terminal, start: known.start } : terminal;
    });
    const content: HostTerminals = { ...own(), terminals: persisted };
    const text = JSON.stringify(content);
    if (text !== written) {
      try {
        await writeHostTerminals(terminalsFile, content);
        written = text;
      } catch (err) {
        // the one it had still proves this host, and a daemon judges each shell it names by its identity
        log(`[terminal-host] writing its terminals file failed, so the one it had stays until a later write: ${errorText(err)}`);
        retryLater(err instanceof RangeError ? Infinity : Date.now() + retryMs);
        return;
      }
    }
    retryLater();
  };
  const flush = (): void => {
    if (closed || writing || !stale) return;
    clearTimeout(rewrite);
    writing = write().finally(() => {
      writing = undefined;
      flush();
    });
  };
  retryLater();
  return {
    record,
    list: (terminals) => {
      latest = terminals;
      stale = true;
      flush();
    },
    close: async () => {
      closed = true;
      clearTimeout(rewrite);
      await writing;
      clearInterval(toucher);
      listening.close();
      await removeHostFiles(paths, { pid, record });
    },
  };
}
