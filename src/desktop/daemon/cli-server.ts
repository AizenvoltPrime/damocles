// The damocles command's sockets on a target: one per user terminal, a random name in its own 0700 folder (POSIX) or a named
// pipe with a 128-bit random name (Windows), closed when the terminal ends. Each request goes to the connected client that most
// recently attached that terminal's view, naming the terminal's project (docs/invariants.md "The damocles command").
import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as net from 'node:net';
import * as path from 'node:path';
import type { Disposable } from '../../platform/disposable';
import { serveCliConnection, type CliAnswer, type CliLanguage, type CliRelay, type CliRelayAnswer, type CliRequest } from '../cli/cli-protocol';
import { cliTerminalEnvironment } from '../workspace/terminal/terminal-env';
import type { KeptFolder } from './endpoint-server';
import { createSocketFolder, socketFolderBase } from './token';

// A client connection as the CLI sockets reach it.
export interface CliClient {
  // the hello's client id, whose language the command's own messages use
  readonly clientId: string;
  // dropped and waiting inside its grace, where a request would wait for a resume that may never come
  lost(): boolean;
  relay(relay: CliRelay): Promise<CliRelayAnswer>;
}

// What the terminal hub tells the CLI sockets; a connection is named by its id.
export interface TerminalCli {
  // opens the terminal's socket and returns the spawn's environment with it, PATH and BROWSER
  open(terminalId: string, env: Readonly<Record<string, string>>): Record<string, string>;
  attached(terminalId: string, connectionId: string): void;
  detached(terminalId: string, connectionId: string): void;
  closed(terminalId: string): void;
}

export interface CliServer extends TerminalCli {
  // makes the socket folder (POSIX)
  start(): Promise<void>;
  // a connection that can take relayed requests, until the disposable
  connected(connectionId: string, client: CliClient): Disposable;
  // the folder and its sockets; a rebind moves new terminals' sockets to a new folder
  kept(): KeptFolder | undefined;
  close(): Promise<void>;
}

export interface CliServerDeps {
  readonly platform: NodeJS.Platform;
  // the daemon's server version (readServerVersion), which status reports
  readonly version: string;
  // the folder holding remote-cli and helpers (terminalBinFolder)
  readonly bin: string;
  // a client's UI language: its latest, kept after it detached
  readonly language: (clientId: string) => CliLanguage | undefined;
  readonly log: (line: string) => void;
  // where the socket folder is made; default socketFolderBase()
  readonly base?: () => Promise<string>;
  // how long a connection has to send its request; default CLI_REQUEST_DEADLINE_MS
  readonly requestDeadlineMs?: number;
}

interface Terminal {
  readonly server: net.Server;
  readonly hook: string;
  // the connections attached to its view, the most recent last
  readonly attached: string[];
  // the client that most recently attached it, kept after it detached, whose language the command's own messages use
  lastClientId: string | undefined;
  // its accepted connections, and of those the ones whose request went to handle
  readonly sockets: Set<net.Socket>;
  readonly requested: Set<net.Socket>;
  // aborted once its socket closed, which answers every relay still waiting for a client
  readonly stopped: AbortController;
}

export function createCliServer(deps: CliServerDeps): CliServer {
  const terminals = new Map<string, Terminal>();
  const clients = new Map<string, CliClient>();
  let folder: string | undefined;
  let closed = false;
  const windows = deps.platform === 'win32';

  const languageOf = (terminal: Terminal): CliLanguage => (terminal.lastClientId !== undefined ? deps.language(terminal.lastClientId) : undefined) ?? 'en';

  const handle = async (terminal: Terminal, request: CliRequest): Promise<CliAnswer> => {
    const client = [...terminal.attached].reverse().map((connectionId) => clients.get(connectionId)).find((candidate): candidate is CliClient => candidate !== undefined && !candidate.lost());
    if (request.kind === 'status') return { ok: true, version: deps.version, connected: client !== undefined, language: languageOf(terminal) };
    if (!client) return { ok: false, code: 'notConnected', language: languageOf(terminal) };
    let answer: CliRelayAnswer | undefined;
    try {
      answer = await untilAborted(client.relay({ request }), terminal.stopped.signal);
    } catch (err) {
      // the connection ended before its client answered
      deps.log(`[cli] a ${request.kind} request lost its client: ${err instanceof Error ? err.message : String(err)}`);
      return { ok: false, code: 'notConnected', language: languageOf(terminal) };
    }
    if (answer === undefined) {
      deps.log(`[cli] a ${request.kind} request ended with its terminal's socket before its client answered`);
      return { ok: false, code: 'notConnected', language: languageOf(terminal) };
    }
    return answer.ok ? { ok: true } : { ok: false, code: 'refused', message: answer.message };
  };

  const hookName = (): string => {
    if (windows) return `\\\\.\\pipe\\damocles-cli-${randomBytes(16).toString('hex')}`;
    if (folder === undefined) throw new Error('The CLI socket folder is not made yet');
    return path.join(folder, `cli-${randomBytes(12).toString('hex')}.sock`);
  };

  // Never waits on server.close's callback, which any open connection holds: a waiting relay is answered not connected and each
  // connection destroyed once its answer is written. A pipe leaves no file.
  const stop = async (terminalId: string): Promise<void> => {
    const terminal = terminals.get(terminalId);
    if (!terminal) return;
    terminals.delete(terminalId);
    terminal.server.close();
    terminal.stopped.abort();
    for (const socket of terminal.sockets) {
      if (terminal.requested.has(socket) && !socket.writableFinished) socket.once('finish', () => socket.destroy());
      else socket.destroy();
    }
    if (!windows) await fs.rm(terminal.hook, { force: true });
  };
  const report = (what: string) => (err: unknown): void => deps.log(`[cli] ${what} failed: ${err instanceof Error ? err.message : String(err)}`);

  return {
    start: async () => {
      if (windows || folder !== undefined || closed) return;
      folder = await createSocketFolder(await (deps.base ?? socketFolderBase)());
      deps.log(`[cli] made the CLI socket folder ${folder}`);
    },
    open: (terminalId, env) => {
      if (closed) throw new Error('The CLI sockets are closed');
      const hook = hookName();
      const server = net.createServer({ allowHalfOpen: true }, (socket) => {
        if (terminals.get(terminalId) !== terminal) {
          socket.destroy();
          return;
        }
        terminal.sockets.add(socket);
        socket.on('close', () => {
          terminal.sockets.delete(socket);
          terminal.requested.delete(socket);
        });
        serveCliConnection(socket, (request) => {
          terminal.requested.add(socket);
          return handle(terminal, request);
        }, deps.log, deps.requestDeadlineMs);
      });
      server.on('error', (err) => deps.log(`[cli] the socket of terminal ${terminalId} failed: ${err.message}`));
      // the bind is synchronous, so the socket exists before the shell that names it starts
      server.listen(hook, () => {
        if (!windows) void fs.chmod(hook, 0o600).catch((err: unknown) => deps.log(`[cli] chmod ${hook} failed: ${err instanceof Error ? err.message : String(err)}`));
      });
      const terminal: Terminal = { server, hook, attached: [], lastClientId: undefined, sockets: new Set(), requested: new Set(), stopped: new AbortController() };
      terminals.set(terminalId, terminal);
      return cliTerminalEnvironment(env, {
        hook,
        remoteCliDir: path.join(deps.bin, 'remote-cli'),
        browser: path.join(deps.bin, 'helpers', windows ? 'browser.exe' : 'browser.sh'),
        platform: deps.platform,
      });
    },
    attached: (terminalId, connectionId) => {
      const terminal = terminals.get(terminalId);
      if (!terminal) return;
      const at = terminal.attached.indexOf(connectionId);
      if (at !== -1) terminal.attached.splice(at, 1);
      terminal.attached.push(connectionId);
      const client = clients.get(connectionId);
      if (client) terminal.lastClientId = client.clientId;
    },
    detached: (terminalId, connectionId) => {
      const terminal = terminals.get(terminalId);
      if (!terminal) return;
      const at = terminal.attached.indexOf(connectionId);
      if (at !== -1) terminal.attached.splice(at, 1);
    },
    closed: (terminalId) => void stop(terminalId).catch(report(`closing the socket of terminal ${terminalId}`)),
    connected: (connectionId, client) => {
      clients.set(connectionId, client);
      return {
        dispose: () => {
          if (clients.get(connectionId) === client) clients.delete(connectionId);
          for (const terminal of terminals.values()) {
            const at = terminal.attached.indexOf(connectionId);
            if (at !== -1) terminal.attached.splice(at, 1);
          }
        },
      };
    },
    kept: () => {
      const current = folder;
      if (current === undefined || closed) return undefined;
      const files = [current, ...[...terminals.values()].map((terminal) => terminal.hook)];
      return {
        folder: current,
        files,
        rebind: async () => {
          if (closed || folder !== current) return;
          // read again: the touch's missing file may be the socket of a terminal that ended since files was read
          const removed: string[] = [];
          for (const [terminalId, terminal] of [...terminals]) if (!(await exists(terminal.hook))) removed.push(terminalId);
          const folderGone = !(await exists(current));
          if (removed.length === 0 && !folderGone) return;
          // a terminal keeps the socket its environment names; one removed by a cleaner stays gone for that terminal
          deps.log(`[cli] the CLI socket folder ${current} or one of its sockets was removed; new terminals get a new folder`);
          for (const terminalId of removed) await stop(terminalId);
          if (!folderGone || closed || folder !== current) return;
          folder = await createSocketFolder(await (deps.base ?? socketFolderBase)());
          deps.log(`[cli] made the CLI socket folder ${folder}`);
        },
      };
    },
    close: async () => {
      closed = true;
      await Promise.all([...terminals.keys()].map((terminalId) => stop(terminalId)));
      clients.clear();
      if (folder === undefined) return;
      const gone = folder;
      folder = undefined;
      await removeEmptyFolder(gone, deps.log);
    },
  };
}

// work's result, or undefined once signal aborted first
function untilAborted<T>(work: Promise<T>, signal: AbortSignal): Promise<T | undefined> {
  if (signal.aborted) return Promise.resolve(undefined);
  return new Promise((resolve, reject) => {
    const aborted = (): void => resolve(undefined);
    signal.addEventListener('abort', aborted, { once: true });
    void work.then(resolve, reject).finally(() => signal.removeEventListener('abort', aborted));
  });
}

async function exists(file: string): Promise<boolean> {
  try {
    await fs.lstat(file);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw err;
  }
}

async function removeEmptyFolder(folder: string, log: (line: string) => void): Promise<void> {
  try {
    await fs.rmdir(folder);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return;
    if (code === 'ENOTEMPTY') {
      log(`[cli] left ${folder}: it holds files the daemon did not make`);
      return;
    }
    throw err;
  }
}
