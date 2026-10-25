// The daemon's Damocles Core: forked from the daemon's main thread on the first core attach, with a CoreInit the daemon
// builds itself, restarted after a crash by the restart policy with a new epoch each time, and served to every client's
// `core` channel through core-routes.ts. A client never supplies CoreInit or any part of `remote`. At most one core runs.
import { randomBytes } from 'node:crypto';
import * as path from 'node:path';
import type { EndedLeaseHolder } from '../../core/pi-session/session-store/session-lease';
import type { WorkerName } from '../../platform/app-paths';
import type { Disposable } from '../../platform/disposable';
import { isAttachedFrame } from '../core-protocol/attached-transport';
import { createMainEndpoint, type CoreTransport, type MainEndpoint } from '../core-protocol';
import type { CoreInit } from '../core-protocol/messages';
import { restartDecision } from '../local-services/restart-policy';
import type { GitProbe } from '../local-services/shell-env';
import type { CoreAttach, CoreState } from './control-messages';
import { createClientMirrors, createCoreRouter, type CoreRouter } from './core-routes';
import type { DaemonState } from './daemon-state';
import type { ForkedChild } from './process-starts';
import type { RunRegistry } from './run-registry';
import type { RunPaths } from './token';

// main's CLOSE_TIMEOUT_MS: how long core.shutdown may take before core is killed
const CLOSE_TIMEOUT_MS = 3_000;

// the esbuild outfiles under dist/, as main's app paths name them
const WORKER_BUNDLES: Readonly<Record<WorkerName, string>> = {
  compass: 'compass-worker.js',
  usageStats: 'usage-stats-worker.js',
  sentinel: 'sentinel.js',
  processLauncher: 'process-launcher-worker.js',
  memoryIntegrity: 'memory-integrity-worker.js',
  sessionMetaIndex: 'session-meta-index-worker.js',
  voiceExtract: 'voice-extract-worker.js',
};

export interface RemoteCoreHostDeps {
  // the daemon's package root, holding dist/core-host.js and its workers
  readonly root: string;
  readonly paths: RunPaths;
  readonly git: GitProbe;
  // the daemon runs with e2e hooks (loopback in e2e)
  readonly e2eHooks: boolean;
  readonly state: DaemonState;
  readonly registry: RunRegistry;
  readonly fork: (entry: string, args: readonly string[]) => ForkedChild;
  readonly log: (line: string) => void;
  readonly now?: () => number;
}

/** A connection's `core` channel; attach starts serving the attach generation it names. */
export interface CoreConnection extends Disposable {
  attach(payload: CoreAttach): CoreState;
}

export interface RemoteCoreHost {
  state(): CoreState;
  onState(listener: (state: CoreState) => void): Disposable;
  connect(connectionId: string, channel: CoreTransport, close: (reason: string) => void): CoreConnection;
  restart(): CoreState;
  // core.shutdown, then the process ends; nothing restarts it
  shutdown(): Promise<void>;
  // kills core without core.shutdown and settles once it exited; nothing restarts it
  kill(): Promise<void>;
}

interface Running {
  readonly child: ForkedChild;
  readonly endpoint: MainEndpoint;
  readonly router: CoreRouter;
  readonly exited: Promise<void>;
  // the daemon asked it to end, so its exit is no crash
  stopping: boolean;
  // core.shutdown answered, so it holds no session lease
  shutDown: boolean;
}

interface Connection {
  readonly id: string;
  readonly channel: CoreTransport;
  readonly close: (reason: string) => void;
  attach: number;
  payload: CoreAttach | undefined;
  readonly listeners: Set<(raw: unknown) => void>;
  served: Disposable | undefined;
}

export function createRemoteCoreHost(deps: RemoteCoreHostDeps): RemoteCoreHost {
  const { log } = deps;
  const now = deps.now ?? Date.now;
  // the core's own id for remote/: drawn once per daemon, never a client's
  const hostId = randomBytes(16).toString('hex');
  const mirrors = createClientMirrors();
  const secrets = new Map<string, string | undefined>();
  const connections = new Map<string, Connection>();
  const listeners = new Set<(state: CoreState) => void>();
  const endedCores: EndedLeaseHolder[] = [];
  let worktreeRecords: readonly unknown[] = [];
  let first: CoreAttach | undefined;
  let crashes: readonly number[] = [];
  let reloads: readonly number[] = [];
  let running: Running | undefined;
  let state: CoreState = { epoch: null, phase: 'halted', restarts: 0, pid: null, ppid: null };
  let closed = false;

  const setState = (next: Partial<CoreState>): void => {
    state = { ...state, ...next };
    for (const listener of [...listeners]) listener(state);
  };

  const generation = (connection: Connection): CoreTransport => {
    const attach = connection.attach;
    return {
      post: (envelope) => connection.channel.post({ attach, envelope }),
      onMessage: (listener) => {
        connection.listeners.add(listener);
        return { dispose: () => { connection.listeners.delete(listener); } };
      },
    };
  };

  const serve = (connection: Connection): void => {
    connection.served?.dispose();
    connection.listeners.clear();
    connection.served = undefined;
    const payload = connection.payload;
    // a core being replaced serves no new attach: the client attaches again on the new epoch
    if (!running || running.stopping || !payload) return;
    connection.served = running.router.attach({
      id: connection.id,
      hostId: payload.hostId,
      transport: generation(connection),
      mirrors: payload.mirrors,
      close: connection.close,
    });
  };

  const init = (attach: CoreAttach): CoreInit => {
    const dist = (...parts: string[]): string => path.join(deps.root, 'dist', ...parts);
    const git = deps.git.available ? { available: true, path: deps.git.path, version: deps.git.version } : { available: false, reason: deps.git.reason };
    return {
      appInfo: attach.appInfo,
      secretsPersistent: attach.secretsPersistent,
      chatBrowserPane: attach.chatBrowserPane,
      e2eHooks: deps.e2eHooks,
      git,
      paths: {
        resourceRoot: deps.root,
        unpackedRoot: deps.root,
        workers: Object.fromEntries(Object.entries(WORKER_BUNDLES).map(([name, file]) => [name, dist(file)])) as Record<WorkerName, string>,
        watchWorker: dist('watch-worker.js'),
        askpass: { askpass: dist('askpass', 'askpass.sh'), sshAskpass: dist('askpass', 'ssh-askpass.sh'), node: process.execPath, main: dist('askpass-main.js') },
      },
      logs: { dir: deps.paths.logsDir, echo: false },
      endedCores: [...endedCores],
      worktreeRecords,
      remote: { hostId },
      mirrors: {
        state: { global: deps.state.snapshot('global'), workspace: deps.state.snapshot('workspace') },
        trust: { keys: [...mirrors.trust] },
        folders: { folders: mirrors.folders },
        editor: mirrors.editor,
        terminal: mirrors.terminal,
        language: mirrors.language,
        clientAuth: Object.fromEntries(mirrors.clientAuth),
        clientUser: Object.fromEntries(mirrors.clientUser),
        clientPolicy: Object.fromEntries(mirrors.clientPolicy),
        actingClient: mirrors.actingClient,
      },
    };
  };

  // overlapping restarts and reloads each start one once the old core exited; only the first finds no core running
  const start = (): void => {
    if (!first || closed || (running && !running.stopping)) return;
    const epoch = randomBytes(16).toString('hex');
    const child = deps.fork(path.join(deps.root, 'dist', 'core-host.js'), []);
    const coreListeners = new Set<(raw: unknown) => void>();
    child.onMessage((message) => {
      for (const listener of [...coreListeners]) listener(message);
    });
    const transport: CoreTransport = {
      post: (message) => child.postMessage(message),
      onMessage: (listener) => {
        coreListeners.add(listener);
        return { dispose: () => { coreListeners.delete(listener); } };
      },
    };
    // core's own violation ends core, which restarts by the policy; it never ends the daemon
    const endpoint = createMainEndpoint(transport, log, (error) => {
      log(`[core-host] protocol violation by core (${error.message}); killing it`);
      child.kill();
    });
    child.postMessage(init(first));
    let exit!: () => void;
    const current: Running = {
      child,
      endpoint,
      router: createCoreRouter({ core: endpoint, state: deps.state, registry: deps.registry, mirrors, secrets, e2eHooks: deps.e2eHooks, reload: () => reload(), log }),
      exited: new Promise<void>((resolve) => { exit = resolve; }),
      stopping: false,
      shutDown: false,
    };
    running = current;
    endpoint.onMirror('worktrees', ({ records }) => {
      worktreeRecords = records;
    });
    const ready = endpoint.onMirror('folderTargets', () => {
      ready.dispose();
      if (running === current) setState({ phase: 'running' });
    });
    child.onExit(({ code, error }) => {
      exit();
      ended(current, code, error);
    });
    log(`[core-host] started Damocles Core (pid ${child.pid ?? 'unknown'}, epoch ${epoch})`);
    // a client's endpoint lives one epoch: each client attaches again when it sees this one (control coreState)
    setState({ epoch, phase: 'starting', pid: child.pid ?? null, ppid: process.pid });
  };

  const teardown = (current: Running): void => {
    current.router.dispose();
    current.endpoint.close('Damocles Core stopped');
    if (running === current) running = undefined;
    for (const connection of connections.values()) {
      connection.served = undefined;
      connection.listeners.clear();
    }
  };

  function ended(current: Running, code: number, error: string | null): void {
    teardown(current);
    if (current.stopping) return;
    const pid = current.child.pid;
    if (!current.shutDown && pid !== undefined) endedCores.push({ pid, endedAt: now() });
    const decision = restartDecision(crashes, now());
    crashes = decision.crashes;
    if (decision.restart) {
      log(`[core-host] Damocles Core ended (code ${code}${error ? `: ${error}` : ''}); restarting (${decision.count} in the restart window)`);
      setState({ phase: 'restarting', pid: null, restarts: decision.count });
      start();
      return;
    }
    log(`[core-host] Damocles Core ended (code ${code}${error ? `: ${error}` : ''}); halted until a client restarts it`);
    setState({ phase: 'halted', pid: null, restarts: decision.crashes.length - 1 });
  }

  const stop = async (current: Running): Promise<void> => {
    current.stopping = true;
    const timer = new Promise<void>((resolve) => setTimeout(resolve, CLOSE_TIMEOUT_MS));
    await Promise.race([
      current.endpoint.request('core.shutdown', {}).then(() => { current.shutDown = true; }, (err: unknown) => log(`[core-host] core.shutdown failed: ${err instanceof Error ? err.message : String(err)}`)),
      timer,
    ]);
    current.child.kill();
    await current.exited;
  };

  const replace = (): void => {
    const current = running;
    setState({ phase: 'restarting', pid: null });
    if (!current) {
      start();
      return;
    }
    void stop(current).then(() => start(), (err: unknown) => log(`[core-host] stopping core for a restart failed: ${err instanceof Error ? err.message : String(err)}`));
  };

  // lifecycle.reload, bounded like a crash so a core cannot fork cores without end
  function reload(): void {
    const decision = restartDecision(reloads, now());
    reloads = decision.crashes;
    if (!decision.restart) {
      log('[core-host] refused a reload core asked for: the restart limit was reached');
      return;
    }
    replace();
  }

  return {
    state: () => state,
    onState: (listener) => {
      listeners.add(listener);
      return { dispose: () => { listeners.delete(listener); } };
    },
    connect: (id, channel, close) => {
      const connection: Connection = { id, channel, close, attach: 0, payload: undefined, listeners: new Set(), served: undefined };
      connections.set(id, connection);
      const subscription = channel.onMessage((raw) => {
        if (!isAttachedFrame(raw)) {
          close('a core channel message without its attach generation');
          return;
        }
        // an earlier generation's message was in flight when the client attached again
        if (raw.attach < connection.attach) return;
        if (raw.attach > connection.attach) {
          close(`core channel generation ${raw.attach} before control.attachCore named it`);
          return;
        }
        for (const listener of [...connection.listeners]) listener(raw.envelope);
      });
      return {
        attach: (payload) => {
          if (payload.attach <= connection.attach) throw new Error(`attach generation ${payload.attach} is not after ${connection.attach}`);
          connection.attach = payload.attach;
          connection.payload = payload;
          // a core started for this attach reads the client's values in its init, so its settings never start without them
          mirrors.clientAuth.set(id, payload.mirrors.clientAuth);
          mirrors.clientUser.set(id, payload.mirrors.clientUser);
          mirrors.clientPolicy.set(id, payload.mirrors.clientPolicy);
          if (!first) {
            mirrors.actingClient = { clientId: id };
            first = payload;
            start();
          }
          serve(connection);
          return state;
        },
        dispose: () => {
          subscription.dispose();
          connection.served?.dispose();
          connections.delete(id);
          mirrors.clientAuth.delete(id);
          mirrors.clientUser.delete(id);
          mirrors.clientPolicy.delete(id);
          if (mirrors.actingClient.clientId === id) mirrors.actingClient = {};
        },
      };
    },
    restart: () => {
      if (!first) throw new Error('No client has attached to Damocles Core yet');
      crashes = [];
      setState({ restarts: 0 });
      replace();
      return state;
    },
    shutdown: async () => {
      closed = true;
      const current = running;
      if (current) await stop(current);
    },
    kill: async () => {
      closed = true;
      const current = running;
      if (!current) return;
      current.stopping = true;
      current.child.kill();
      await current.exited;
    },
  };
}
