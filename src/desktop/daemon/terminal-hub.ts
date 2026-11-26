// The daemon's terminals over its terminal hosts: docs/invariants.md "Remote terminals outlive their clients and their daemon".
import * as path from 'node:path';
import type { Disposable } from '../../platform/disposable';
import { TERMINAL_HIGH_WATERMARK_CHARS, TERMINAL_LOW_WATERMARK_CHARS } from '../preload/terminal-channels';
import { parseHostMessage, parseTerminalView, type HostMessage, type TerminalView } from '../pty-host/protocol';
import { abandonStream, streamDuplex } from '../../remote/tunnel-pipe';
import { MAX_HOSTED_VIEW_CHARS, type HostedTerminal, type TerminalHostEndpoints } from '../terminal-host/host-messages';
import type { TerminalPost, TerminalResponding } from '../workspace/messages';
import type { LiveTerminal } from '../workspace/terminal/terminal-backend';
import type { TerminalCli } from './cli-server';
import type { RunRegistry } from './run-registry';
import type { ForwardedConnection, HostLink, KillOutcome, TerminalHosts } from './terminal-hosts';

export interface HubClient {
  readonly id: string;
  message(message: HostMessage): void;
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

// what a terminal with no link holds for its host at most, in requests and in input characters; past either, it drops every
// request, with one log line, until a link takes what it holds or a Kill replaces it
export const MAX_QUEUED_HOST_REQUESTS = 1024;
export const MAX_QUEUED_HOST_CHARS: number = 256 * 1024;

interface Terminal {
  // the pid of the host that holds it; undefined until the host new terminals start in is attached
  host: number | undefined;
  // undefined while that host is not attached (not yet, or its link was lost); what was asked meanwhile waits in queued
  link: HostLink | undefined;
  readonly queued: Array<(link: HostLink) => void>;
  // the input characters queued holds
  queuedChars: number;
  // past a bound (MAX_QUEUED_HOST_REQUESTS)
  dropping: boolean;
  pid: number;
  cols: number;
  rows: number;
  // the shared screen's: the largest an attached client asked for; a detach leaves it, so the client finds its history on return
  scrollback: number;
  readonly windows: Map<HubClient, Window>;
  // who each serialize in flight answers, in the order the host answers them; undefined for one that detached
  readonly screens: Array<HubClient | undefined>;
  // what its spawning client sent so another can show it
  readonly view: TerminalView | undefined;
  // what the host was last told: whether any connection views it
  viewed: boolean;
}

export interface TerminalHub {
  post(client: HubClient, request: TerminalPost, projectKey: string | undefined): void;
  list(): readonly LiveTerminal[];
  detach(client: HubClient): void;
  // ends every terminal: the frozen shutdown to each attached host, which then exits; for a removal, every other host of this
  // machine too (TerminalHosts.endForRemoval)
  endTerminals(hosts: 'attached' | 'removal'): Promise<void>;
  // closes the links only: every host and terminal runs on for the next daemon
  release(reason: string): void;
  // ends a terminal host that is not responding; false, and nothing touched, for any other pid
  endHost(hostPid: number): Promise<boolean>;
  // each viewer of each terminal of a host that stopped responding or answers again, and a new viewer its terminal's state
  onResponding(listener: (viewer: HubClient, change: TerminalResponding) => void): Disposable;
  // the state of each terminal viewer views whose host is known
  respondingOf(viewer: HubClient): readonly TerminalResponding[];
}

export interface TerminalHubDeps {
  readonly hosts: Pick<TerminalHosts, 'currentHost' | 'onLink' | 'onEnded' | 'onUnattached' | 'onResponding' | 'killGroup' | 'endHost' | 'emptied' | 'endAll' | 'endForRemoval' | 'release'>;
  readonly registry: RunRegistry;
  // every terminal's output, which the port detector's url finder reads, and its end
  readonly output?: { data(id: string, text: string): void; ended(id: string): void };
  // each terminal's damocles command, following which connections attach its view
  readonly cli?: TerminalCli;
  // the credential endpoints a spawn's environment names, which its terminal host replaces with its own; default none
  readonly credentialEndpoints?: (env: Readonly<Record<string, string>>) => Omit<TerminalHostEndpoints, 'cli'>;
  // a connection on a host's agent or relay endpoint
  readonly forward?: (connection: Exclude<ForwardedConnection, { readonly kind: 'cli' }>) => void;
  readonly log: (line: string) => void;
}

export function createTerminalHub(deps: TerminalHubDeps): TerminalHub {
  const terminals = new Map<string, Terminal>();
  // once released, nothing ends a terminal here: the next daemon adopts it, and no viewer may read it as ended
  let released = false;
  // the pids of the hosts that are not responding
  const notResponding = new Set<number>();
  // per host pid, the terminals a Kill ended while that host was not responding, which its next link must kill too
  const killedAway = new Map<number, Set<string>>();
  // terminals whose Kill was sent or waits for their host, which a host found not responding then kills directly
  const killAsked = new Set<string>();
  // terminals whose shell is being proved for a direct kill
  const proving = new Set<string>();
  const respondingListeners = new Set<(viewer: HubClient, change: TerminalResponding) => void>();

  const forget = (id: string): void => {
    if (!terminals.delete(id)) return;
    killAsked.delete(id);
    deps.output?.ended(id);
    deps.cli?.closed(id);
    deps.registry.removeTerminal(id);
  };

  // in order, once the terminal's host is attached; chars: the input characters it carries
  const send = (id: string, terminal: Terminal, act: (link: HostLink) => void, chars = 0): void => {
    if (terminal.link) {
      act(terminal.link);
      return;
    }
    if (terminal.dropping) return;
    if (terminal.queued.length < MAX_QUEUED_HOST_REQUESTS && terminal.queuedChars + chars <= MAX_QUEUED_HOST_CHARS) {
      terminal.queued.push(act);
      terminal.queuedChars += chars;
      return;
    }
    terminal.dropping = true;
    deps.log(`[terminal] ${id} holds ${terminal.queued.length} requests of ${terminal.queuedChars} characters for its terminal host, which is not attached; later ones are dropped`);
  };

  // what the terminal held for its host, in order
  const flush = (terminal: Terminal, link: HostLink): void => {
    const held = terminal.queued.splice(0);
    terminal.queuedChars = 0;
    terminal.dropping = false;
    for (const act of held) act(link);
  };

  // A view or a screen of a terminal whose host's link was lost is not held: the next link sends both afresh (onLink). A
  // spawn still waiting for its host holds them.
  const sendFresh = (id: string, terminal: Terminal, act: (link: HostLink) => void): void => {
    if (terminal.link || terminal.host === undefined) send(id, terminal, act);
  };

  // a kill ends the terminal, so it replaces whatever the terminal held
  const sendKill = (id: string, terminal: Terminal): void => {
    const kill = (link: HostLink): void => {
      link.endpoint.request('kill', { id }).catch((err: unknown) => deps.log(`[terminal] ${id} was not killed: ${err instanceof Error ? err.message : String(err)}`));
    };
    if (terminal.link) {
      kill(terminal.link);
      return;
    }
    terminal.queued.splice(0, terminal.queued.length, kill);
    terminal.queuedChars = 0;
    terminal.dropping = false;
  };

  // the host runs a terminal's idle clock while no connection views it
  const tellViewed = (id: string, terminal: Terminal): void => {
    const viewed = terminal.windows.size > 0;
    if (viewed === terminal.viewed) return;
    terminal.viewed = viewed;
    sendFresh(id, terminal, (link) => link.endpoint.emit('viewed', { id, viewed }));
  };

  // Every viewer hears the end of a terminal its host no longer holds or whose host is out of reach.
  const ended = (id: string, terminal: Terminal, message: HostMessage): void => {
    forget(id);
    for (const client of terminal.windows.keys()) client.message(message);
  };

  const requestScreen = (id: string, terminal: Terminal, client: HubClient, window: Window): void => {
    window.awaiting = true;
    terminal.screens.push(client);
    sendFresh(id, terminal, (link) => link.endpoint.emit('serialize', { id }));
  };

  const receive = (link: HostLink, sent: HostMessage): void => {
    // on receipt, whoever views it: the host paces the pty by these, and no client's window may hold it back
    if (sent.type === 'data') link.endpoint.emit('ack', { id: sent.id, chars: sent.data.length });
    const terminal = terminals.get(sent.id);
    if (!terminal || terminal.link !== link) return;
    // a host of another version answers by its own bounds; a client takes only what its contract holds
    const message = parseHostMessage(sent, (field, id) => deps.log(`[terminal] dropped the ${field} of ${id}'s screen, which is outside the contract`));
    if (!message) {
      deps.log(`[terminal] dropped a ${sent.type} of ${sent.id} from the terminal host ${link.pid}, which is outside the contract`);
      if (sent.type !== 'screen') return;
      // its client's live output waited behind that screen; another serialize would likely be dropped the same way
      const client = terminal.screens.shift();
      const window = client && terminal.windows.get(client);
      if (!client || !window) return;
      window.awaiting = false;
      window.unacked = 0;
      deps.log(`[terminal] ${client.id} gets the live output of ${sent.id} without the screen it asked for`);
      return;
    }
    switch (message.type) {
      case 'data':
        deps.output?.data(message.id, message.data);
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
        ended(message.id, terminal, message);
        if (![...terminals.values()].some((other) => other.host === link.pid)) deps.hosts.emptied(link);
        return;
      case 'error':
        // a spawn that failed leaves no terminal behind
        if (terminal.pid === 0) forget(message.id);
        break;
      case 'process':
        break;
    }
    for (const client of terminal.windows.keys()) client.message(message);
  };

  const window = (scrollback?: number): Window => ({ unacked: 0, behind: false, awaiting: false, scrollback });

  const viewOf = (hosted: HostedTerminal): TerminalView | undefined => {
    if (hosted.view === undefined) return undefined;
    let raw: unknown;
    try {
      raw = JSON.parse(hosted.view);
    } catch (err) {
      if (!(err instanceof SyntaxError)) throw err;
    }
    const view = parseTerminalView(raw);
    if (!view) deps.log(`[terminal] ${hosted.id} is listed without its view, which is outside the contract`);
    return view;
  };

  const listHosted = (hosted: HostedTerminal, host: number, link: HostLink | undefined): void => {
    terminals.set(hosted.id, { host, link, queued: [], queuedChars: 0, dropping: false, pid: hosted.pid, cols: hosted.cols, rows: hosted.rows, scrollback: hosted.scrollback, windows: new Map(), screens: [], view: viewOf(hosted), viewed: false });
    deps.registry.addTerminal({ id: hosted.id, projectKey: hosted.projectKey, title: hosted.title });
  };

  // A host this daemon could not attach to: its file's terminals are listed, and what is asked of them waits as for a lost host.
  // One with no shell pid yet is left out of the runs too, since no ready can give it one before the host attaches.
  deps.hosts.onUnattached((pid, listed) => {
    if (released) return;
    for (const hosted of listed) {
      const known = terminals.get(hosted.id);
      if (!known) {
        if (hosted.pid > 0) listHosted(hosted, pid, undefined);
      } else if (known.host !== pid) deps.log(`[terminal] the terminal host ${pid} lists ${hosted.id}, an id another host's terminal has; it is not listed`);
    }
  });

  deps.hosts.onLink((link) => {
    // a host attached again after its link was lost: what it no longer holds ended meanwhile
    const held = new Set(link.terminals.map((hosted) => hosted.id));
    for (const [id, terminal] of [...terminals]) if (terminal.host === link.pid && !held.has(id)) ended(id, terminal, { type: 'exit', id, exitCode: 1 });
    const killed = killedAway.get(link.pid);
    killedAway.delete(link.pid);
    const kills: Array<Promise<void>> = [];
    for (const hosted of link.terminals) {
      const { id } = hosted;
      if (killed?.has(id)) {
        kills.push(link.endpoint.request('kill', { id }).catch((err: unknown) => deps.log(`[terminal] ${id} was not killed in its terminal host ${link.pid}: ${err instanceof Error ? err.message : String(err)}`)));
        continue;
      }
      const known = terminals.get(id);
      if (known && known.host !== link.pid) {
        deps.log(`[terminal] the terminal host ${link.pid} holds ${id}, an id another host's terminal has; it is not listed`);
        continue;
      }
      if (!known) {
        listHosted(hosted, link.pid, link);
        continue;
      }
      known.link = link;
      known.pid = hosted.pid;
      known.cols = hosted.cols;
      known.rows = hosted.rows;
      // after an attach the host counts it unviewed and answers no screen the lost link asked for
      known.viewed = false;
      known.screens.length = 0;
      tellViewed(id, known);
      for (const [client, own] of known.windows) {
        own.unacked = 0;
        own.behind = false;
        requestScreen(id, known, client, own);
      }
      flush(known, link);
    }
    link.onMessage((message) => receive(link, message));
    link.onConnection((connection) => {
      if (connection.kind !== 'cli') {
        if (deps.forward) deps.forward(connection);
        else abandonStream(connection.stream);
        return;
      }
      // a host forwards only its own terminals' sockets
      if (!deps.cli || terminals.get(connection.terminalId)?.host !== link.pid) {
        deps.log(`[terminal] closed a damocles command connection of ${connection.terminalId}, which the terminal host ${link.pid} does not hold here`);
        abandonStream(connection.stream);
        return;
      }
      deps.cli.serve(connection.terminalId, streamDuplex(connection.stream));
    });
    // the host may live on: its terminals are kept, and what is asked of them waits for the next link
    let closed = false;
    link.onClose(() => {
      closed = true;
      for (const terminal of terminals.values()) if (terminal.link === link) terminal.link = undefined;
    });
    // a closed link's pid is retried, so only an open one may be let go
    if (kills.length > 0) {
      void Promise.all(kills).then(() => {
        if (!closed && ![...terminals.values()].some((terminal) => terminal.host === link.pid)) deps.hosts.emptied(link);
      });
    }
  });

  // only a host that ended takes its terminals with it
  deps.hosts.onEnded((pid) => {
    notResponding.delete(pid);
    killedAway.delete(pid);
    if (released) return;
    for (const [id, terminal] of [...terminals]) if (terminal.host === pid) ended(id, terminal, { type: 'exit', id, exitCode: 1 });
  });

  const tellResponding = (viewer: HubClient, change: TerminalResponding): void => {
    for (const listener of [...respondingListeners]) listener(viewer, change);
  };

  // undefined while the terminal waits for the host new terminals start in
  const respondingOf = (id: string, terminal: Terminal): TerminalResponding | undefined =>
    terminal.host === undefined ? undefined : { id, hostPid: terminal.host, responding: !notResponding.has(terminal.host) };

  // A shell killed or found ended ends its terminal; one that cannot be proved stays listed, and its host kills it once it answers.
  const killAway = (id: string, terminal: Terminal, host: number): void => {
    if (proving.has(id)) return;
    deps.log(`[terminal] killing ${id} directly: its terminal host ${host} is not responding`);
    proving.add(id);
    // the shell's pid comes from its host's terminals file, which may name a shell whose ready never reached this daemon
    void deps.hosts.killGroup(host, id).catch((err: unknown): KillOutcome => {
      deps.log(`[terminal] killing the shell of ${id} failed: ${err instanceof Error ? err.message : String(err)}`);
      return 'unproved';
    }).then((outcome) => {
      proving.delete(id);
      // its host ended it, or the daemon let go of its hosts, meanwhile
      if (terminals.get(id) !== terminal || released) return;
      if (outcome !== 'unproved') {
        killedAway.set(host, (killedAway.get(host) ?? new Set()).add(id));
        ended(id, terminal, { type: 'exit', id, exitCode: 1 });
        return;
      }
      deps.log(`[terminal] ${id} stays listed: its shell is not proved, so its terminal host kills it once it answers`);
      killAsked.add(id);
      sendKill(id, terminal);
    });
  };

  deps.hosts.onResponding((pid, responding) => {
    if (responding) notResponding.delete(pid);
    else notResponding.add(pid);
    for (const [id, terminal] of [...terminals]) {
      if (terminal.host !== pid) continue;
      for (const viewer of terminal.windows.keys()) tellResponding(viewer, { id, hostPid: pid, responding });
      if (!responding && !released && killAsked.has(id)) killAway(id, terminal, pid);
    }
  });

  const keepScrollback = (id: string, terminal: Terminal): void => {
    const largest = Math.max(...[...terminal.windows.values()].flatMap((own) => own.scrollback ?? []));
    if (largest === terminal.scrollback) return;
    terminal.scrollback = largest;
    send(id, terminal, (link) => link.endpoint.emit('scrollback', { id, scrollback: largest }));
  };

  const detachView = (id: string, terminal: Terminal, client: HubClient): void => {
    if (!terminal.windows.delete(client)) return;
    deps.cli?.detached(id, client.id);
    // its screens in flight still come back; they go to nobody
    terminal.screens.forEach((asked, index) => {
      if (asked === client) terminal.screens[index] = undefined;
    });
    tellViewed(id, terminal);
  };

  const spawn = (client: HubClient, request: Extract<TerminalPost, { readonly type: 'spawn' }>, projectKey: string): void => {
    const { id } = request;
    const refuse = (message: string): void => client.message({ type: 'error', id, message });
    const view = request.view === undefined ? undefined : JSON.stringify(request.view);
    if (view !== undefined && view.length > MAX_HOSTED_VIEW_CHARS) {
      refuse(`terminal ${id} names a profile and folder longer than a terminal host keeps`);
      return;
    }
    const env = deps.cli ? deps.cli.environment(request.env) : request.env;
    const endpoints: TerminalHostEndpoints = { cli: deps.cli !== undefined, ...(deps.credentialEndpoints?.(env) ?? { relay: false }) };
    const title = path.basename(request.file);
    const created: Terminal = { host: undefined, link: undefined, queued: [], queuedChars: 0, dropping: false, pid: 0, cols: request.cols, rows: request.rows, scrollback: request.scrollback, windows: new Map([[client, window(request.scrollback)]]), screens: [], view: request.view, viewed: true };
    terminals.set(id, created);
    deps.registry.addTerminal({ id, projectKey, title });
    deps.cli?.attached(id, client.id);
    const failed = (err: unknown): void => {
      if (terminals.get(id) !== created || created.pid !== 0) return;
      deps.log(`[terminal] ${id} did not start: ${err instanceof Error ? err.message : String(err)}`);
      ended(id, created, { type: 'error', id, message: `terminal ${id} could not start on this host` });
    };
    deps.hosts.currentHost().then((link) => {
      if (terminals.get(id) !== created) return;
      created.host = link.pid;
      created.link = link;
      const { type: _type, view: _view, ...pty } = request;
      link.endpoint.request('spawn', { ...pty, env, title, projectKey, ...(view !== undefined ? { view } : {}), endpoints }).catch((err: unknown) => {
        // the host may have started it before its link closed: the next link's list, or the host's end, settles it
        if (terminals.get(id) === created && created.link === undefined) {
          deps.log(`[terminal] ${id} waits for its terminal host ${link.pid}, whose link closed before it answered the spawn`);
          return;
        }
        failed(err);
      });
      if (created.link === link) flush(created, link);
    }, failed);
  };

  return {
    post: (client, request, projectKey) => {
      const terminal = terminals.get(request.id);
      if (request.type === 'spawn') {
        if (terminal || deps.registry.hasTerminal(request.id)) client.message({ type: 'error', id: request.id, message: `terminal ${request.id} already exists on this host` });
        else spawn(client, request, projectKey ?? '');
        return;
      }
      if (!terminal) {
        if (request.type === 'serialize') client.message({ type: 'error', id: request.id, message: `terminal ${request.id} is not running` });
        return;
      }
      const { id } = request;
      if (request.type === 'serialize') {
        // attaches this connection, which then gets the screen and the output after it
        let own = terminal.windows.get(client);
        if (!own) {
          own = window();
          terminal.windows.set(client, own);
          tellViewed(id, terminal);
          // the state may have changed since the client listed it
          const state = respondingOf(id, terminal);
          if (state) tellResponding(client, state);
        }
        deps.cli?.attached(id, client.id);
        requestScreen(id, terminal, client, own);
        return;
      }
      if (request.type === 'kill') {
        if (!released && terminal.host !== undefined && notResponding.has(terminal.host)) {
          killAway(id, terminal, terminal.host);
          return;
        }
        killAsked.add(id);
        // the host reports the exit, which every viewer then hears
        sendKill(id, terminal);
        return;
      }
      if (request.type === 'detach') {
        detachView(id, terminal, client);
        return;
      }
      const own = terminal.windows.get(client);
      if (!own) {
        deps.log(`[terminal] dropping a ${request.type} for ${id} from a connection not attached to it`);
        return;
      }
      switch (request.type) {
        case 'ack':
          own.unacked = Math.max(own.unacked - request.chars, 0);
          if (own.behind && own.unacked < TERMINAL_LOW_WATERMARK_CHARS) {
            own.behind = false;
            requestScreen(id, terminal, client, own);
          }
          return;
        case 'clearAck':
          own.unacked = 0;
          own.behind = false;
          return;
        case 'resize': {
          const { cols, rows } = request;
          terminal.cols = cols;
          terminal.rows = rows;
          send(id, terminal, (link) => link.endpoint.emit('resize', { id, cols, rows }));
          return;
        }
        case 'scrollback':
          own.scrollback = request.scrollback;
          keepScrollback(id, terminal);
          return;
        case 'input': {
          const { data } = request;
          send(id, terminal, (link) => link.endpoint.emit('input', { id, data }), data.length);
          return;
        }
        case 'clear':
          send(id, terminal, (link) => link.endpoint.emit('clear', { id }));
      }
    },
    list: () => [...terminals].filter(([, terminal]) => terminal.pid > 0).map(([id, terminal]) => ({
      id,
      pid: terminal.pid,
      cols: terminal.cols,
      rows: terminal.rows,
      ...(terminal.view ? { view: terminal.view } : {}),
      ...(terminal.host !== undefined && notResponding.has(terminal.host) ? { notRespondingHost: terminal.host } : {}),
    })),
    detach: (client) => {
      for (const [id, terminal] of terminals) detachView(id, terminal, client);
    },
    endTerminals: (hosts) => (hosts === 'removal' ? deps.hosts.endForRemoval() : deps.hosts.endAll()),
    release: (reason) => {
      released = true;
      deps.hosts.release(reason);
    },
    endHost: (hostPid) => deps.hosts.endHost(hostPid),
    respondingOf: (viewer) => [...terminals].flatMap(([id, terminal]) => {
      const state = terminal.windows.has(viewer) ? respondingOf(id, terminal) : undefined;
      return state ? [state] : [];
    }),
    onResponding: (listener) => {
      respondingListeners.add(listener);
      return { dispose: () => respondingListeners.delete(listener) };
    },
  };
}
