// The daemon's persistent terminals over one self-acknowledging pty host: each terminal keeps a window per connection, a
// connection past TERMINAL_HIGH_WATERMARK_CHARS stops getting live data until its acks bring it under
// TERMINAL_LOW_WATERMARK_CHARS and it gets a fresh screen, so a slow client never throttles the pty or another client.
// A terminal is the host's: any connection may attach a view (serialize) or kill it, and only its attached ones type into it.
import * as path from 'node:path';
import { TERMINAL_HIGH_WATERMARK_CHARS, TERMINAL_LOW_WATERMARK_CHARS } from '../preload/terminal-channels';
import { parseHostMessage, type HostMessage, type TerminalView } from '../pty-host/protocol';
import type { PtyHostEnd, TerminalPost } from '../workspace/messages';
import type { LiveTerminal } from '../workspace/terminal/terminal-backend';
import type { PtyHostProcess } from '../workspace/host-starters';
import type { RunRegistry } from './run-registry';

// main's HOST_SHUTDOWN_TIMEOUT_MS: a pty still connecting on Windows holds the pty host's shutdown, so it is killed after this
const HOST_SHUTDOWN_TIMEOUT_MS = 2000;

export interface HubClient {
  readonly id: string;
  message(message: HostMessage): void;
  hostExit(end: PtyHostEnd): void;
}

interface Window {
  unacked: number;
  // past the high watermark: no live data until the acks catch up
  behind: boolean;
  // a screen was asked for it; live data waits behind it
  awaiting: boolean;
  // the scrollback this client's view keeps, once it said
  scrollback: number | undefined;
}

interface Terminal {
  pid: number;
  cols: number;
  rows: number;
  // the shared screen's: the largest an attached client asked for; a detach leaves it, so the client finds its history on return
  scrollback: number;
  readonly windows: Map<HubClient, Window>;
  // who each serialize in flight answers, in the order the pty host answers them; undefined for one that detached
  readonly screens: Array<HubClient | undefined>;
  // what its spawning client sent so another can show it
  readonly view: TerminalView | undefined;
}

export interface TerminalHub {
  post(client: HubClient, request: TerminalPost, projectKey: string | undefined): void;
  list(): readonly LiveTerminal[];
  detach(client: HubClient): void;
  // ends a terminal the idle limit reached
  kill(id: string): void;
  // kills every terminal and ends the pty host
  shutdown(): Promise<void>;
  // kills the pty host without its shutdown and settles once it exited
  killHost(): Promise<void>;
}

export interface TerminalHubDeps {
  // the self-acknowledging pty host
  readonly start: () => PtyHostProcess;
  readonly registry: RunRegistry;
  readonly log: (line: string) => void;
}

export function createTerminalHub(deps: TerminalHubDeps): TerminalHub {
  const terminals = new Map<string, Terminal>();
  // every client that used terminals since the host started hears its exit
  const clients = new Set<HubClient>();
  let host: { readonly process: PtyHostProcess; readonly exited: Promise<void> } | undefined;

  const attachedCount = (id: string, terminal: Terminal): void => deps.registry.setAttached(id, terminal.windows.size);

  const forget = (id: string): void => {
    if (!terminals.delete(id)) return;
    deps.registry.removeTerminal(id);
  };

  const ensureHost = (): PtyHostProcess => {
    if (host) return host.process;
    const process = deps.start();
    let ended!: () => void;
    const exited = new Promise<void>((resolve) => { ended = resolve; });
    const current = { process, exited };
    host = current;
    process.onMessage((raw) => {
      if (host === current) receive(raw);
    });
    process.onExit((exit) => {
      ended();
      if (host !== current) return;
      host = undefined;
      deps.log(`[terminal] the pty host exited with code ${exit.code}${exit.error === null ? '' : `; last error: ${JSON.stringify(exit.error)}`}`);
      for (const id of [...terminals.keys()]) forget(id);
      for (const client of clients) client.hostExit({ code: exit.code, reason: exit.reason, error: exit.error });
      clients.clear();
    });
    deps.log('[terminal] started the pty host');
    return process;
  };

  const requestScreen = (id: string, terminal: Terminal, client: HubClient, window: Window): void => {
    window.awaiting = true;
    terminal.screens.push(client);
    ensureHost().postMessage({ type: 'serialize', id });
  };

  function receive(raw: unknown): void {
    const message = parseHostMessage(raw);
    if (!message) {
      deps.log('[terminal] stopping the pty host: it sent a message outside the contract');
      host?.process.kill();
      return;
    }
    const terminal = terminals.get(message.id);
    if (!terminal) return;
    switch (message.type) {
      case 'data':
        for (const [client, window] of terminal.windows) {
          if (window.behind || window.awaiting) continue;
          window.unacked += message.data.length;
          if (window.unacked > TERMINAL_HIGH_WATERMARK_CHARS) window.behind = true;
          client.message(message);
        }
        return;
      case 'screen': {
        const client = terminal.screens.shift();
        const window = client && terminal.windows.get(client);
        if (!client || !window) return;
        terminal.cols = message.cols;
        terminal.rows = message.rows;
        window.awaiting = false;
        window.unacked = 0;
        client.message(message);
        return;
      }
      case 'ready':
        terminal.pid = message.pid;
        break;
      case 'exit':
        forget(message.id);
        break;
      case 'error':
        // a spawn that failed leaves no terminal behind
        if (terminal.pid === 0) forget(message.id);
        break;
      case 'process':
        break;
    }
    for (const client of terminal.windows.keys()) client.message(message);
  }

  const window = (scrollback?: number): Window => ({ unacked: 0, behind: false, awaiting: false, scrollback });

  const keepScrollback = (id: string, terminal: Terminal): void => {
    const largest = Math.max(...[...terminal.windows.values()].flatMap((own) => own.scrollback ?? []));
    if (largest === terminal.scrollback) return;
    terminal.scrollback = largest;
    ensureHost().postMessage({ type: 'scrollback', id, scrollback: largest });
  };

  // The pty host reports no exit for a pty it killed, so every viewer hears it here, the killer's other views included; a
  // killed terminal has no exit code of its own and reports 1.
  const end = (id: string, terminal: Terminal): void => {
    ensureHost().postMessage({ type: 'kill', id });
    forget(id);
    for (const client of terminal.windows.keys()) client.message({ type: 'exit', id, exitCode: 1 });
  };

  const detachView = (id: string, terminal: Terminal, client: HubClient): void => {
    if (!terminal.windows.delete(client)) return;
    // its screens in flight still come back; they go to nobody
    terminal.screens.forEach((asked, index) => {
      if (asked === client) terminal.screens[index] = undefined;
    });
    attachedCount(id, terminal);
  };

  return {
    post: (client, request, projectKey) => {
      const terminal = terminals.get(request.id);
      if (request.type === 'spawn') {
        if (terminal || deps.registry.hasTerminal(request.id)) {
          client.message({ type: 'error', id: request.id, message: `terminal ${request.id} already exists on this host` });
          return;
        }
        const created: Terminal = { pid: 0, cols: request.cols, rows: request.rows, scrollback: request.scrollback, windows: new Map([[client, window(request.scrollback)]]), screens: [], view: request.view };
        terminals.set(request.id, created);
        clients.add(client);
        deps.registry.addTerminal({ id: request.id, projectKey: projectKey ?? '', title: path.basename(request.file) });
        attachedCount(request.id, created);
        ensureHost().postMessage(request);
        return;
      }
      if (!terminal) {
        if (request.type === 'serialize') client.message({ type: 'error', id: request.id, message: `terminal ${request.id} is not running` });
        return;
      }
      if (request.type === 'serialize') {
        // attaches this connection, which then gets the screen and the output after it
        let own = terminal.windows.get(client);
        if (!own) {
          own = window();
          terminal.windows.set(client, own);
          clients.add(client);
          attachedCount(request.id, terminal);
        }
        requestScreen(request.id, terminal, client, own);
        return;
      }
      if (request.type === 'kill') {
        end(request.id, terminal);
        return;
      }
      if (request.type === 'detach') {
        detachView(request.id, terminal, client);
        return;
      }
      const own = terminal.windows.get(client);
      if (!own) {
        deps.log(`[terminal] dropping a ${request.type} for ${request.id} from a connection not attached to it`);
        return;
      }
      switch (request.type) {
        case 'ack':
          own.unacked = Math.max(own.unacked - request.chars, 0);
          if (own.behind && own.unacked < TERMINAL_LOW_WATERMARK_CHARS) {
            own.behind = false;
            requestScreen(request.id, terminal, client, own);
          }
          return;
        case 'clearAck':
          own.unacked = 0;
          own.behind = false;
          return;
        case 'resize':
          terminal.cols = request.cols;
          terminal.rows = request.rows;
          ensureHost().postMessage(request);
          return;
        case 'scrollback':
          own.scrollback = request.scrollback;
          keepScrollback(request.id, terminal);
          return;
        default:
          ensureHost().postMessage(request);
      }
    },
    list: () => [...terminals].filter(([, terminal]) => terminal.pid > 0).map(([id, terminal]) => ({ id, pid: terminal.pid, cols: terminal.cols, rows: terminal.rows, ...(terminal.view ? { view: terminal.view } : {}) })),
    detach: (client) => {
      clients.delete(client);
      for (const [id, terminal] of terminals) detachView(id, terminal, client);
    },
    kill: (id) => {
      const terminal = terminals.get(id);
      if (terminal) end(id, terminal);
    },
    shutdown: async () => {
      const running = host;
      if (!running) return;
      running.process.postMessage({ type: 'shutdown' });
      let timer: NodeJS.Timeout | undefined;
      const timedOut = new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(true), HOST_SHUTDOWN_TIMEOUT_MS);
      });
      if (await Promise.race([running.exited.then(() => false), timedOut])) {
        deps.log(`[terminal] the pty host did not end within ${HOST_SHUTDOWN_TIMEOUT_MS} ms; killing it`);
        running.process.kill();
        await running.exited;
      }
      clearTimeout(timer);
    },
    killHost: async () => {
      const running = host;
      if (!running) return;
      running.process.kill();
      await running.exited;
    },
  };
}
