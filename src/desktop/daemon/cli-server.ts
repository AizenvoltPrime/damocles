// The damocles command on a target: each user terminal's socket is its terminal host's, which forwards every connection to
// the attached daemon. Each request goes to the connected client that most recently attached that terminal's view
// (docs/invariants.md "The damocles command").
import * as path from 'node:path';
import type { Duplex } from 'node:stream';
import type { Disposable } from '../../platform/disposable';
import { serveCliConnection, type CliAnswer, type CliLanguage, type CliRelay, type CliRelayAnswer, type CliRequest } from '../cli/cli-protocol';
import { cliTerminalEnvironment } from '../workspace/terminal/terminal-env';

// A client connection as the CLI routing reaches it.
export interface CliClient {
  // the hello's client id, whose language the command's own messages use
  readonly clientId: string;
  // dropped and waiting inside its grace, where a request would wait for a resume that may never come
  lost(): boolean;
  relay(relay: CliRelay): Promise<CliRelayAnswer>;
}

// What the terminal hub tells the CLI routing; a connection is named by its id.
export interface TerminalCli {
  // the spawn's environment with bin/remote-cli first on PATH and BROWSER; the terminal host names the socket
  environment(env: Readonly<Record<string, string>>): Record<string, string>;
  attached(terminalId: string, connectionId: string): void;
  detached(terminalId: string, connectionId: string): void;
  closed(terminalId: string): void;
  // a connection on the terminal's damocles command socket, which its terminal host forwarded
  serve(terminalId: string, socket: Duplex): void;
}

export interface CliServer extends TerminalCli {
  // a connection that can take relayed requests, until the disposable
  connected(connectionId: string, client: CliClient): Disposable;
  // the endpoint listens: the requests waiting for a first client start their wait, which reattachUntil now bounds
  accepting(): void;
  close(): void;
}

export interface CliServerDeps {
  readonly platform: NodeJS.Platform;
  // the daemon's server version (readServerVersion), which status reports
  readonly version: string;
  // the folder holding remote-cli and helpers (terminalBinFolder) as a shell names it, through the active link
  readonly bin: string;
  // a client's UI language: its latest, kept after it detached
  readonly language: (clientId: string) => CliLanguage | undefined;
  readonly log: (line: string) => void;
  // how long a connection has to send its request; default CLI_REQUEST_DEADLINE_MS
  readonly requestDeadlineMs?: number;
  // epoch ms until which the clients of the server this daemon replaced may still reattach, undefined until its endpoint
  // listens; a request of a terminal no client attached yet waits for the first until then, and answers not connected at once
  // after it
  readonly reattachUntil: () => number | undefined;
  // a --wait request a client holds, titled by its files' names, until the disposable (RunRegistry.cliWait)
  readonly cliWait: (title: string) => Disposable;
}

// a request waiting for its terminal's first attach: check settles it once a client is attached, time starts its wait
interface Waiter {
  readonly check: () => void;
  readonly time: () => void;
}

interface Terminal {
  // the connections attached to its view, the most recent last
  readonly attached: string[];
  // the client that most recently attached it, kept after it detached, whose language the command's own messages use
  lastClientId: string | undefined;
  readonly waiting: Set<Waiter>;
  // its forwarded connections, and of those the ones whose request went to handle
  readonly sockets: Set<Duplex>;
  readonly requested: Set<Duplex>;
  // aborted once the terminal ended, which answers every relay still waiting for a client
  readonly stopped: AbortController;
}

export function createCliServer(deps: CliServerDeps): CliServer {
  const terminals = new Map<string, Terminal>();
  const clients = new Map<string, CliClient>();
  let closed = false;
  const windows = deps.platform === 'win32';
  const paths = windows ? path.win32 : path.posix;

  // a --wait request's title, the names of the files it waits for; undefined for one that does not wait
  const waitTitle = (request: CliRequest): string | undefined => {
    if (request.kind === 'open' && request.wait) return request.items.map((item) => paths.basename(item.path)).join(', ');
    if (request.kind === 'diff' && request.wait) return [request.left, request.right].map((file) => paths.basename(file)).join(', ');
    return undefined;
  };

  // a terminal adopted from another daemon's time is routed from its first view or connection on
  const terminalOf = (terminalId: string): Terminal => {
    let terminal = terminals.get(terminalId);
    if (!terminal) {
      terminal = { attached: [], lastClientId: undefined, waiting: new Set(), sockets: new Set(), requested: new Set(), stopped: new AbortController() };
      terminals.set(terminalId, terminal);
    }
    return terminal;
  };

  const languageOf = (terminal: Terminal): CliLanguage => (terminal.lastClientId !== undefined ? deps.language(terminal.lastClientId) : undefined) ?? 'en';

  const clientOf = (terminal: Terminal): CliClient | undefined => [...terminal.attached].reverse().map((connectionId) => clients.get(connectionId)).find((candidate): candidate is CliClient => candidate !== undefined && !candidate.lost());

  // A terminal no client attached on this daemon yet, as one adopted in a switch before its clients reattached, waits for the
  // first until reattachUntil; one whose clients left answers at once. A request whose connection closed meanwhile gets no client.
  const firstClient = (terminal: Terminal, gone: AbortSignal): Promise<CliClient | undefined> => new Promise((resolve) => {
    const ended = AbortSignal.any([terminal.stopped.signal, gone]);
    let timer: NodeJS.Timeout | undefined;
    const done = (): void => {
      clearTimeout(timer);
      terminal.waiting.delete(waiter);
      ended.removeEventListener('abort', done);
      resolve(ended.aborted ? undefined : clientOf(terminal));
    };
    const waiter: Waiter = {
      check: () => {
        if (clientOf(terminal)) done();
      },
      time: () => {
        const until = deps.reattachUntil();
        if (until !== undefined && timer === undefined) timer = setTimeout(done, Math.max(0, until - Date.now()));
      },
    };
    terminal.waiting.add(waiter);
    ended.addEventListener('abort', done, { once: true });
    waiter.time();
  });

  const handle = async (terminal: Terminal, request: CliRequest, gone: AbortSignal): Promise<CliAnswer> => {
    let client = clientOf(terminal);
    if (request.kind === 'status') return { ok: true, version: deps.version, connected: client !== undefined, language: languageOf(terminal) };
    if (!client && terminal.lastClientId === undefined && !terminal.stopped.signal.aborted && !gone.aborted) client = await firstClient(terminal, gone);
    if (!client) return { ok: false, code: 'notConnected', language: languageOf(terminal) };
    let answer: CliRelayAnswer | undefined;
    const wait = waitTitle(request);
    const pending = wait === undefined ? undefined : deps.cliWait(wait);
    try {
      answer = await untilAborted(client.relay({ request }), terminal.stopped.signal);
    } catch (err) {
      // the connection ended before its client answered
      deps.log(`[cli] a ${request.kind} request lost its client: ${err instanceof Error ? err.message : String(err)}`);
      return { ok: false, code: 'notConnected', language: languageOf(terminal) };
    } finally {
      pending?.dispose();
    }
    if (answer === undefined) {
      deps.log(`[cli] a ${request.kind} request ended with its terminal before its client answered`);
      return { ok: false, code: 'notConnected', language: languageOf(terminal) };
    }
    return answer.ok ? { ok: true } : { ok: false, code: 'refused', message: answer.message };
  };

  // A waiting relay is answered not connected and each connection destroyed once its answer is written, so no connection
  // holds a shutdown.
  const stop = (terminalId: string): void => {
    const terminal = terminals.get(terminalId);
    if (!terminal) return;
    terminals.delete(terminalId);
    terminal.stopped.abort();
    for (const socket of terminal.sockets) {
      if (terminal.requested.has(socket) && !socket.writableFinished) socket.once('finish', () => socket.destroy());
      else socket.destroy();
    }
  };

  return {
    environment: (env) => cliTerminalEnvironment(env, {
      remoteCliDir: path.join(deps.bin, 'remote-cli'),
      browser: path.join(deps.bin, 'helpers', windows ? 'browser.exe' : 'browser.sh'),
      platform: deps.platform,
    }),
    serve: (terminalId, socket) => {
      if (closed) {
        socket.destroy();
        return;
      }
      const terminal = terminalOf(terminalId);
      const gone = new AbortController();
      // the command keeps its side open until it has the answer, so its end is the process going away
      socket.once('end', () => gone.abort());
      terminal.sockets.add(socket);
      socket.on('close', () => {
        gone.abort();
        terminal.sockets.delete(socket);
        terminal.requested.delete(socket);
      });
      serveCliConnection(socket, (request) => {
        terminal.requested.add(socket);
        return handle(terminal, request, gone.signal);
      }, deps.log, deps.requestDeadlineMs);
    },
    attached: (terminalId, connectionId) => {
      if (closed) return;
      const terminal = terminalOf(terminalId);
      const at = terminal.attached.indexOf(connectionId);
      if (at !== -1) terminal.attached.splice(at, 1);
      terminal.attached.push(connectionId);
      const client = clients.get(connectionId);
      if (client) terminal.lastClientId = client.clientId;
      for (const waiter of [...terminal.waiting]) waiter.check();
    },
    detached: (terminalId, connectionId) => {
      const terminal = terminals.get(terminalId);
      if (!terminal) return;
      const at = terminal.attached.indexOf(connectionId);
      if (at !== -1) terminal.attached.splice(at, 1);
    },
    closed: (terminalId) => stop(terminalId),
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
    accepting: () => {
      for (const terminal of terminals.values()) for (const waiter of terminal.waiting) waiter.time();
    },
    close: () => {
      closed = true;
      for (const terminalId of [...terminals.keys()]) stop(terminalId);
      clients.clear();
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
