// Where clients reach the daemon: a Unix socket in a fresh mkdtemp folder (POSIX) or a named pipe with a random name
// (Windows), each with its token. Every function here runs while the daemon lock is held.
import { promises as fs } from 'node:fs';
import * as net from 'node:net';
import { checkSocketFolder, createSocketFolder, isOwnEndpoint, pipeName, readPidFile, removeSocketFolder, socketFolderBase, socketPath, tokenPath, touch, writeToken, type RunPaths } from './token';

// pipe names tried before a start fails; each collision means another process holds a 128-bit random name
const PIPE_ATTEMPTS = 5;

export interface ListeningEndpoint {
  readonly endpoint: string;
  readonly socketFolder: string | null;
  readonly token: Uint8Array;
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

/** Removes the socket folder an earlier daemon left, when it is still this user's own. Only under the lock. */
export async function removeStaleSocket(paths: RunPaths, log: (line: string) => void): Promise<void> {
  const previous = await readPidFile(paths.pidFile);
  if (!previous?.socketFolder) return;
  if (!isOwnEndpoint(previous)) {
    log(`[daemon] leaving ${previous.socketFolder} alone: the pid file does not name a socket folder of this daemon`);
    return;
  }
  try {
    await checkSocketFolder(previous.socketFolder);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') log(`[daemon] leaving the earlier socket folder ${previous.socketFolder} alone: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }
  // a folder that cannot be emptied is left behind; the new endpoint lives in a new folder either way
  try {
    await removeSocketFolder(previous.socketFolder);
    log(`[daemon] removed the earlier socket folder ${previous.socketFolder}`);
  } catch (err) {
    log(`[daemon] could not remove the earlier socket folder ${previous.socketFolder}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Listens on a new endpoint with a new token, which each connection gets with its socket. names: the pipe names to try on Windows. */
export async function openEndpoint(paths: RunPaths, onConnection: (socket: net.Socket, token: Uint8Array) => void, log: (line: string) => void, names: () => string = pipeName): Promise<ListeningEndpoint> {
  // stops accepting; connections already open keep running until they end on their own
  const closer = (server: net.Server) => async (): Promise<void> => {
    server.close();
  };
  if (process.platform === 'win32') {
    const file = tokenPath(paths, { socketFolder: null });
    await fs.rm(file, { force: true });
    const token = await writeToken(file);
    for (let attempt = 1; ; attempt++) {
      const endpoint = names();
      const server = net.createServer((socket) => onConnection(socket, token));
      try {
        await listen(server, endpoint);
        return { endpoint, socketFolder: null, token, close: closer(server) };
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EADDRINUSE' || attempt >= PIPE_ATTEMPTS) throw err;
        log(`[daemon] the pipe name ${endpoint} is taken; picking another`);
      }
    }
  }
  const socketFolder = await createSocketFolder(await socketFolderBase());
  const token = await writeToken(tokenPath(paths, { socketFolder }));
  const endpoint = socketPath(socketFolder);
  const server = net.createServer((socket) => onConnection(socket, token));
  await listen(server, endpoint);
  const close = closer(server);
  return {
    endpoint,
    socketFolder,
    token,
    close: async () => {
      await close();
      await removeSocketFolder(socketFolder);
    },
  };
}

/** A folder the daemon keeps, or the files beside it: touched every interval, bound again once one of its files is gone. */
export interface KeptFolder {
  // the socket folder these files are in (POSIX), which the run folder records (writeSocketFolders)
  readonly folder?: string;
  // each must exist; one missing means a cleaner or the user removed it
  readonly files: readonly string[];
  // touched while present: a socket another process (core) listens at, absent while none does
  readonly whilePresent?: readonly string[];
  readonly rebind: () => Promise<void>;
}

/** The endpoint's files: the pid file, the token and (POSIX) the socket folder and socket. */
export function endpointFiles(paths: RunPaths, endpoint: ListeningEndpoint): string[] {
  return [paths.pidFile, tokenPath(paths, endpoint), ...(endpoint.socketFolder ? [endpoint.socketFolder, endpoint.endpoint] : [])];
}

export interface FreshnessOptions {
  readonly intervalMs: number;
  // read at every touch, since a rebind changes them
  readonly folders: () => readonly KeptFolder[];
  readonly failed: (error: unknown) => void;
}

/** Touches every kept folder's files each interval, one folder at a time, binding a folder again once one of its files is gone. */
export function keepSocketFoldersFresh(options: FreshnessOptions): NodeJS.Timeout {
  // one touch at a time: a rebind can outlast a short interval
  let busy = false;
  return setInterval(() => {
    if (busy) return;
    busy = true;
    void (async () => {
      for (const kept of options.folders()) {
        if (!(await touch(kept.files))) await kept.rebind();
        else for (const file of kept.whilePresent ?? []) await touch([file]);
      }
    })().catch(options.failed).finally(() => {
      busy = false;
    });
  }, options.intervalMs);
}
