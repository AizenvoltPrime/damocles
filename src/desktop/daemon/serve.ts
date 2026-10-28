// `daemon.js serve`: the per-user daemon. buildDaemon wires the run registry, lifetime, workspace modules and connections;
// serve adds the process: the spawn lock, its launcher pool, the login environment, git, the lock, the endpoint and its files.
import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Worker } from 'node:worker_threads';
import { resolveRgPath } from '../../core/chat-panel/ripgrep';
import { installLogSink, log as coreLog } from '../../core/logger';
import { DAMOCLES_HOME_DIR } from '../../core/paths';
import { PI_AGENT_DIR } from '../../core/pi-session/agent-dir';
import { createLauncherPool, installProcessLauncher, lockThreadSpawns, processLauncher } from '../../core/process-launcher';
import { spawnCredentialVariables, type CredentialRelay, type RelayIdentity } from '../../core/scm/askpass/credential-relay';
import type { HostFacts } from '../../remote/handshake';
import { DesktopFileWatcherFactory } from '../local-services/file-watcher-factory';
import { createDesktopLogSinkFactory } from '../local-services/log-sink';
import { logUncaughtErrors } from '../local-services/process-errors';
import { mergeLoginShellEnv, probeGit, type GitProbe } from '../local-services/shell-env';
import { createWorkerTreeHost } from '../local-services/watch-worker-host';
import { NODE_PTY_ARG_PREFIX, SELF_ACKNOWLEDGE_ARG } from '../pty-host/protocol';
import { createFileSystem } from '../workspace/file-system';
import { createFormatter } from '../workspace/format/formatter';
import type { FormatterHostProcess, HostStarters, PtyHostProcess } from '../workspace/host-starters';
import { createQuickOpenListing } from '../workspace/quick-open-listing';
import { createSearchRunner } from '../workspace/search/search-runner';
import { createTerminalBackend } from '../workspace/terminal/terminal-backend';
import { createTreeListing } from '../workspace/tree-listing';
import { createAgentProxy, type AgentProxy } from './agent-proxy';
import { daemonAnswers } from './attach';
import { installAuthorizedKey, systemAuthorizedKeysDeps } from './authorized-keys';
import { daemonChildEnv } from './child-env';
import { createConnections, type Connections } from './connections';
import { createDaemonState } from './daemon-state';
import { endpointFiles, keepSocketFoldersFresh, openEndpoint, removeStaleSocket, type KeptFolder, type ListeningEndpoint } from './endpoint-server';
import { createLifetime } from './lifetime';
import { enableLinger } from './linger';
import { DAEMON_LOG, listLogs, readLog } from './logs';
import { syncMirror } from './mirror-server';
import { forkChild, type ForkedChild } from './process-starts';
import { createRemoteCoreHost } from './remote-core-host';
import { createRunRegistry } from './run-registry';
import { daemonE2eHooks, e2eConnectionLimits } from './server-package';
import { acquireDaemonLock } from './singleton';
import { createTerminalHub } from './terminal-hub';
import { createSocketFolder, localRunPaths, makeRunDir, otherHostsInHome, readPidFile, removeRecordedSocketFolders, socketFolderBase, TOUCH_INTERVAL_MS, tokenPath, writePidFile, writeSocketFolders, type RunPaths } from './token';
import { createWorkspaceHost } from './workspace-host';

// exit codes the bridge reads: another daemon holds the lock; the start failed
export const EXIT_LOCK_HELD = 3;
export const EXIT_START_FAILED = 4;
// a shutdown step failed; the daemon still ran every later step and exits
export const EXIT_SHUTDOWN_FAILED = 5;
// the daemon lock was compromised: the daemon stopped at once and left the run folder to the lock's new owner
export const EXIT_LOCK_LOST = 6;
// the git credential relay's socket in its private folder
const RELAY_SOCKET_NAME = 'askpass.sock';

export interface DaemonDeps {
  readonly root: string;
  readonly version: string;
  readonly facts: HostFacts;
  readonly paths: RunPaths;
  readonly starters: HostStarters;
  // the daemon's own probe, which its core's source control runs
  readonly git: GitProbe;
  readonly e2eHooks: boolean;
  // a dropped connection's grace and the held-frame bound; shorter only through the e2e hooks (e2eConnectionLimits)
  readonly graceMs?: number;
  readonly maxHeldBytes?: number;
  // forks Damocles Core; default: dist/core-host.js as a Node child of this thread
  readonly forkCore?: (entry: string, args: readonly string[]) => ForkedChild;
  // the git credential relay every core of this daemon listens at; absent in tests
  readonly credentialRelay?: DaemonRelay;
  // where the agent folder is made; default socketFolderBase()
  readonly socketBase?: () => Promise<string>;
  // the watch worker's bundle; default: dist/watch-worker.js
  readonly watchWorker?: string;
  // stops accepting and removes the endpoint's files; runs first on shutdown
  readonly closeEndpoint: () => Promise<void>;
  // stops accepting and removes only the files no other daemon can own; runs first once the lock was lost
  readonly abandonEndpoint: () => Promise<void>;
  // the last step before exit: a start waiting for the lock must never run beside this daemon's shutdown
  readonly releaseLock: () => Promise<void>;
  // code: 0, EXIT_SHUTDOWN_FAILED after a step of the shutdown failed, or EXIT_LOCK_LOST
  readonly exit: (reason: string, code: number) => void;
  readonly log: (line: string) => void;
}

export interface Daemon {
  readonly connections: Connections;
  // its folder is made before the endpoint listens (POSIX)
  readonly agentProxy: AgentProxy;
  // the agent folder and the relay's, kept fresh with the endpoint's; a rebind publishes the new paths to core
  socketFolders(): KeptFolder[];
  shutdown(reason: string): Promise<void>;
  // another daemon may hold the lock: kills the children and exits, writing nothing in the run folder
  lockLost(reason: string): Promise<void>;
}

/** The daemon's forked hosts: the pty host in self-acknowledging mode and a formatter host per root. */
export function daemonStarters(root: string): HostStarters {
  return {
    startPtyHost: (): PtyHostProcess => {
      const child = forkChild(path.join(root, 'dist', 'pty-host.js'), [`${NODE_PTY_ARG_PREFIX}${path.join(root, 'node_modules', 'node-pty')}`, SELF_ACKNOWLEDGE_ARG], daemonChildEnv('node'));
      return {
        postMessage: (message) => child.postMessage(message),
        onMessage: (listener) => child.onMessage(listener),
        // a forked child has no utility-process reason
        onExit: (listener) => child.onExit(({ code, error }) => listener({ code, reason: null, error })),
        kill: () => child.kill(),
      };
    },
    startFormatterHost: (formatRoot): FormatterHostProcess => {
      const child = forkChild(path.join(root, 'dist', 'formatter-host.js'), [], daemonChildEnv('node'), formatRoot);
      return {
        postMessage: (message) => child.postMessage(message),
        onMessage: (listener) => child.onMessage(listener),
        onExit: (listener) => child.onExit(({ code }) => listener(code)),
        kill: () => child.kill(),
      };
    },
  };
}

// Linux's per-user inotify watch limit, which the watcher's ENOSPC names.
const INOTIFY_WATCHES_FILE = '/proc/sys/fs/inotify/max_user_watches';

export function buildDaemon(deps: DaemonDeps): Daemon {
  const { log, root, paths } = deps;
  const registry = createRunRegistry();
  const relay = deps.credentialRelay;
  const agentProxy = createAgentProxy({
    forwarding: (clientId) => core.clientPolicy(clientId)?.agentForwarding === true,
    uid: process.getuid?.(),
    log,
    ...(deps.socketBase ? { base: deps.socketBase } : {}),
  });
  const watchers = new DesktopFileWatcherFactory({ folders: () => [], onDidChange: () => ({ dispose: () => undefined }) }, log, createWorkerTreeHost(() => new Worker(deps.watchWorker ?? path.join(root, 'dist', 'watch-worker.js')), log));
  const rgPath = (): Promise<string> => resolveRgPath({ resourceRoot: root, unpackedRoot: root });
  const hub = createTerminalHub({ start: deps.starters.startPtyHost, registry, log });
  const format = createFormatter({ starters: deps.starters, watchers, log });
  const terminals = createTerminalBackend({
    starters: deps.starters,
    platform: process.platform,
    scriptsDir: path.join(root, 'resources', 'shell-integration'),
    zshDotDir: paths.zshDotDir,
    homedir: os.homedir(),
    env: process.env,
    log,
  });
  const workspace = createWorkspaceHost({
    files: createFileSystem({
      watchers,
      // a target has no trash: Files deletes permanently after its confirmation
      trash: () => Promise.reject(new Error('this host has no trash')),
      // the folder its core's settings store reads the machine layer from
      damoclesHome: DAMOCLES_HOME_DIR,
      log,
    }),
    tree: createTreeListing(log),
    search: createSearchRunner({ rgPath, log }),
    quickOpen: createQuickOpenListing({ rgPath, log }),
    format,
    terminals,
    hub,
    // read per terminal: the daemon's relay, and the asking client's agent socket while that client forwards its agent
    terminalCredentials: (base, clientId) => spawnCredentialVariables(base, relay && daemonCredentialRelay(relay.identity(), root), { socket: agentProxy.socketFor(clientId) }),
    watchLimits: {
      roots: () => watchers.watchLimitedRoots(),
      onReached: (listener) => watchers.onDidReachWatchLimit(listener),
      limit: async () => {
        try {
          const limit = Number.parseInt(await fs.readFile(INOTIFY_WATCHES_FILE, 'utf8'), 10);
          return Number.isSafeInteger(limit) ? limit : null;
        } catch (err) {
          log(`[watcher] cannot read ${INOTIFY_WATCHES_FILE}: ${err instanceof Error ? err.message : String(err)}`);
          return null;
        }
      },
    },
  }, log);
  watchers.onDidReachWatchLimit((root) => log(`[watcher] ${root} ran out of inotify watches; some of its folders are not watched`));
  registry.onIdle((id) => {
    log(`[terminal] ending ${id}: no client attached it within the idle limit`);
    hub.kill(id);
  });
  const state = createDaemonState(paths.runDir, log);
  const core = createRemoteCoreHost({
    root,
    paths,
    git: deps.git,
    e2eHooks: deps.e2eHooks,
    state,
    registry,
    fork: deps.forkCore ?? ((entry, args) => forkChild(entry, args, daemonChildEnv('node'))),
    agentFolder: () => agentProxy.folder(),
    ...(relay ? { credentialRelay: () => relay.identity() } : {}),
    log,
  });
  const publishing = (kept: KeptFolder | undefined): KeptFolder[] => (kept ? [{
    ...kept,
    rebind: async () => {
      await kept.rebind();
      core.socketsMoved();
    },
  }] : []);

  const attempt = async (name: string, run: () => Promise<void> | void): Promise<boolean> => {
    try {
      await run();
      return true;
    } catch (err) {
      log(`[daemon] shutdown: ${name} failed: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  };
  // Each step runs whatever an earlier one did, and exit is always reached: a worker a skipped step left running would keep
  // the process alive with no endpoint and no idle timer.
  let stopping: Promise<void> | undefined;
  let lost: Promise<void> | undefined;
  // the connections that asked for a removal, ended only once the lock is released, so each close means the daemon is done;
  // one may join a shutdown already running, up to the step that ends the connections
  const removalConnections = new Set<string>();
  const shutdown = (reason: string): Promise<void> => {
    stopping ??= (async () => {
      log(`[daemon] shutting down: ${reason}`);
      lifetime.dispose();
      registry.dispose();
      let failed = false;
      const step = async (name: string, run: () => Promise<void> | void): Promise<void> => {
        // once the lock was lost, lockLost ends the daemon and no later step may write what the lock's new owner owns
        if (lost) return;
        if (!(await attempt(name, run))) failed = true;
      };
      // first, in the same turn: no rebind starts once the shutdown began, and a start probing the endpoint waits for the lock
      await step('closing the endpoint', () => deps.closeEndpoint());
      await step('closing the agent proxy', () => agentProxy.close());
      if (relay) await step('removing the git credential relay', () => relay.close());
      // clients leave before core stops, so a request in flight ends with its connection, never with a stopping core's error
      await step('ending the connections', () => connections.endAll(removalConnections));
      await step('stopping Damocles Core', () => core.shutdown());
      await step('writing core\'s state', () => state.flush());
      await step('ending the terminals', () => hub.shutdown());
      await step('stopping the formatter hosts', () => format.dispose());
      await step('closing the file watchers', () => watchers.close());
      await step('releasing the daemon lock', () => deps.releaseLock());
      if (removalConnections.size > 0) await step('ending the removal connections', () => connections.endAll());
      if (!lost) deps.exit(reason, failed ? EXIT_SHUTDOWN_FAILED : 0);
    })();
    return stopping;
  };
  const lockLost = (reason: string): Promise<void> => {
    lost ??= (async () => {
      log(`[daemon] stopping at once: ${reason}`);
      lifetime.dispose();
      registry.dispose();
      await attempt('closing the endpoint', () => deps.abandonEndpoint());
      // its folders under the socket base are this daemon's alone, unlike the run folder
      await attempt('closing the agent proxy', () => agentProxy.close());
      if (relay) await attempt('removing the git credential relay', () => relay.close());
      await Promise.all([
        attempt('killing Damocles Core', () => core.kill()),
        attempt('killing the pty host', () => hub.killHost()),
        attempt('killing the formatter hosts', () => format.dispose()),
      ]);
      await attempt('closing the file watchers', () => watchers.close());
      connections.destroyAll();
      deps.exit(reason, EXIT_LOCK_LOST);
    })();
    return lost;
  };
  const lifetime = createLifetime(registry, (reason) => void shutdown(reason));

  const connections: Connections = createConnections({
    serverVersion: deps.version,
    facts: deps.facts,
    workspace,
    core: { epoch: () => core.state().epoch, onState: (listener) => core.onState(listener), connect: (id, clientId, channel, close, link) => core.connect(id, clientId, channel, close, link) },
    connectionsChanged: (presence) => lifetime.connectionsChanged(presence),
    agentSock: (clientId, agentSock) => agentProxy.setClient(clientId, agentSock),
    ...(deps.graceMs !== undefined ? { graceMs: deps.graceMs } : {}),
    ...(deps.maxHeldBytes !== undefined ? { maxHeldBytes: deps.maxHeldBytes } : {}),
    log,
    control: {
      attach: ({ terminalIdleDays }) => registry.setIdleDays(terminalIdleDays),
      listRuns: () => ({ runs: registry.runs() }),
      listOwnRuns: (_params, { clientId }) => ({ runs: registry.ownRuns(clientId) }),
      shutdownWhenIdle: () => lifetime.shutdownWhenIdle(),
      // after the answer is on its way
      shutdownNow: (_params, { mux }) => {
        setImmediate(() => void mux.drained().then(() => shutdown('control.shutdownNow')));
      },
      'mirror.sync': (params, { mux }) => syncMirror({ agentDir: PI_AGENT_DIR, reserveStream: () => mux.reserveStream(), openStream: (id) => mux.openStream(id), drained: () => mux.drained(), log }, params),
      'logs.list': async () => ({ logs: await listLogs(paths.logsDir) }),
      'logs.read': ({ name, offset, length }) => readLog(paths.logsDir, name, offset, length),
      attachCore: (params, connection) => {
        if (!connection.core) throw new Error('This connection has no core channel');
        return connection.core.attach(params);
      },
      coreState: () => core.state(),
      restartCore: () => core.restart(),
      ping: () => ({}),
      linger: () => enableLinger({ log }),
      'ssh.installAuthorizedKey': ({ publicKey }) => installAuthorizedKey(publicKey, systemAuthorizedKeysDeps(log)),
      // after the answer is on its way; this connection closes only once the daemon released its lock
      shutdownForRemoval: (_params, { id, mux }) => {
        // kept at once, so a shutdown already running does not end it before the answer goes out
        removalConnections.add(id);
        setImmediate(() => void mux.drained().then(() => shutdown('control.shutdownForRemoval')));
        return { runKey: runFolderKey(paths) };
      },
      sharedHome: async () => ({ hosts: await otherHostsInHome(paths) }),
      // after the answer is on its way, ended so the socket still writes it; a closed connection, unlike a dropped one, is held
      // for no resume
      disconnect: (_params, { mux, end }) => {
        setImmediate(() => void mux.drained().then(() => end('the client disconnected')));
      },
    },
  });
  return { connections, agentProxy, socketFolders: () => [...publishing(agentProxy.kept()), ...publishing(relay?.kept())], shutdown, lockLost };
}

// this machine's run folder key, the part of run-<key> the removal stage deletes
function runFolderKey(paths: RunPaths): string {
  const name = path.basename(paths.runDir);
  if (!name.startsWith('run-')) throw new Error(`${paths.runDir} is not a run folder`);
  return name.slice('run-'.length);
}

function hostFacts(gitAvailable: boolean): HostFacts {
  const platform = process.platform === 'darwin' || process.platform === 'win32' ? process.platform : 'linux';
  const report = platform === 'linux' ? (process.report.getReport() as { header?: { glibcVersionRuntime?: string } }) : undefined;
  return {
    os: platform,
    arch: process.arch,
    libc: platform === 'linux' ? (report?.header?.glibcVersionRuntime ? 'glibc' : 'musl') : null,
    homedir: os.homedir(),
    shell: platform === 'win32' ? (process.env['ComSpec'] ?? 'cmd.exe') : (process.env['SHELL'] || os.userInfo().shell || '/bin/sh'),
    gitAvailable,
    pathFlavor: platform === 'win32' ? 'win32' : 'posix',
  };
}

// probeGit's reasons are localized sentences for main; the daemon only logs them
function plain(message: string, ...args: string[]): string {
  return message.replace(/\{(\d+)\}/g, (_match, index: string) => args[Number(index)] ?? '');
}

async function readVersion(root: string): Promise<string> {
  const manifest = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8')) as { version?: unknown };
  if (typeof manifest.version !== 'string') throw new Error(`${root}/package.json names no version`);
  return manifest.version;
}

export interface ListenOptions {
  readonly paths: RunPaths;
  readonly version: string;
  readonly touchIntervalMs: number;
  readonly log: (line: string) => void;
  // the daemon, around the endpoint this function owns
  readonly build: (endpoint: Pick<DaemonDeps, 'closeEndpoint' | 'abandonEndpoint'>) => Daemon;
}

/**
 * Under the daemon lock: removes an earlier daemon's socket folders, builds the daemon, listens and writes the pid file and the
 * socket folder record, and binds again whenever a touch finds the socket folder, the socket or the token removed.
 */
export async function listen(options: ListenOptions): Promise<Daemon> {
  const { paths, version, log } = options;
  await removeStaleSocket(paths, log);
  await removeRecordedSocketFolders(paths, log);
  let endpoint: ListeningEndpoint | undefined;
  // undefined until the endpoint is bound; a shutdown before that has no touch to stop
  let toucher: NodeJS.Timeout | undefined = undefined;
  let closing = false;
  // a rebind and the close run one at a time, so the close waits for a rebind in flight
  let lifecycle: Promise<unknown> = Promise.resolve();
  const serially = <T>(run: () => Promise<T>): Promise<T> => {
    const next = lifecycle.then(run);
    lifecycle = next.then(() => undefined, () => undefined);
    return next;
  };
  const close = (): Promise<ListeningEndpoint | undefined> => {
    closing = true;
    clearInterval(toucher);
    return serially(async () => {
      const closed = endpoint;
      endpoint = undefined;
      await closed?.close();
      return closed;
    });
  };
  const daemon = options.build({
    closeEndpoint: async () => {
      const closed = await close();
      // a pid file another daemon wrote stays
      if ((await readPidFile(paths.pidFile))?.pid === process.pid) await fs.rm(paths.pidFile, { force: true });
      if (closed?.socketFolder === null) await fs.rm(tokenPath(paths, closed), { force: true });
    },
    // the pid file and the Windows token sit in the run folder, which the lock's new owner may already have written
    abandonEndpoint: async () => {
      await close();
    },
  });
  const bind = async (): Promise<ListeningEndpoint> => {
    const opened = await openEndpoint(paths, (socket, token) => daemon.connections.accept(socket, token), log);
    await writePidFile(paths.pidFile, { version, pid: process.pid, hostname: os.hostname(), endpoint: opened.endpoint, socketFolder: opened.socketFolder, updatedAt: Date.now() });
    log(`[daemon] listening on ${opened.endpoint}`);
    return opened;
  };
  const rebind = (stale: ListeningEndpoint): Promise<void> => serially(async () => {
    if (closing || endpoint !== stale) return;
    log('[daemon] the socket folder, socket or token was removed; binding again');
    await stale.close();
    // no bind starts once closing began
    endpoint = closing ? undefined : await bind();
  });
  const kept = (): KeptFolder[] => {
    const current = endpoint;
    return [...(current ? [{ ...(current.socketFolder ? { folder: current.socketFolder } : {}), files: endpointFiles(paths, current), rebind: () => rebind(current) }] : []), ...daemon.socketFolders()];
  };
  // the record only lets a later start or a removal find these folders, so a failed write is logged and the daemon runs on
  const recordSocketFolders = async (): Promise<void> => {
    if (closing) return;
    await writeSocketFolders(paths, kept().flatMap((folder) => (folder.folder === undefined ? [] : [folder.folder])))
      .catch((err: unknown) => log(`[daemon] recording the socket folders failed: ${err instanceof Error ? err.message : String(err)}`));
  };
  // before the first connection, so a core forked for it is given the agent folder
  await daemon.agentProxy.start();
  try {
    endpoint = await bind();
  } catch (err) {
    await daemon.agentProxy.close().catch((closeErr: unknown) => log(`[agent] closing the agent proxy failed: ${closeErr instanceof Error ? closeErr.message : String(closeErr)}`));
    throw err;
  }
  await recordSocketFolders();
  toucher = keepSocketFoldersFresh({
    intervalMs: options.touchIntervalMs,
    folders: () => kept().map((folder) => ({ ...folder, rebind: () => folder.rebind().then(recordSocketFolders) })),
    failed: (err) => void daemon.shutdown(`the touch of the daemon's socket folders failed: ${err instanceof Error ? err.message : String(err)}`),
  });
  return daemon;
}

/** What the daemon's terminals get of its relay from its start, before any core listens: the helper runs the package's own Node. */
export function daemonCredentialRelay(identity: RelayIdentity, root: string): CredentialRelay {
  return { ...identity, node: process.execPath, main: path.join(root, 'dist', 'askpass-main.js') };
}

export interface DaemonRelay {
  // the handle moves to a new folder when a rebind replaced a removed one
  identity(): RelayIdentity;
  // POSIX: its folder, and its socket while a core listens there
  kept(): KeptFolder | undefined;
  close(): Promise<void>;
}

/**
 * The daemon's git credential relay, made before any terminal or core exists: a fresh nonce and a handle every core listens
 * at, a socket in a private folder (POSIX) or a pipe with a 128-bit random name (Windows).
 */
export async function createCredentialRelay(root: string, platform: NodeJS.Platform = process.platform, base: () => Promise<string> = socketFolderBase): Promise<DaemonRelay> {
  const helper = path.join(root, 'dist', 'git-credential', platform === 'win32' ? 'git-credential-relay.cmd' : 'git-credential-relay.sh');
  const nonce = randomBytes(32).toString('hex');
  if (platform === 'win32') {
    const identity: RelayIdentity = { helper, nonce, handle: `\\\\.\\pipe\\damocles-relay-${randomBytes(16).toString('hex')}` };
    return { identity: () => identity, kept: () => undefined, close: async () => undefined };
  }
  const handleIn = (folder: string): string => path.join(folder, RELAY_SOCKET_NAME);
  // only the relay's socket, then the folder; one already gone is done
  const remove = async (folder: string): Promise<void> => {
    await fs.rm(handleIn(folder), { force: true });
    await fs.rmdir(folder).catch((err: unknown) => {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    });
  };
  let folder = await createSocketFolder(await base());
  let closed = false;
  // a rebind and the close run one at a time, so a close never leaves a folder a rebind made
  let queue: Promise<void> = Promise.resolve();
  const serially = (run: () => Promise<void>): Promise<void> => {
    const next = queue.then(run);
    queue = next.then(() => undefined, () => undefined);
    return next;
  };
  return {
    identity: () => ({ helper, nonce, handle: handleIn(folder) }),
    kept: () => {
      if (closed) return undefined;
      const current = folder;
      return {
        folder: current,
        files: [current],
        whilePresent: [handleIn(current)],
        rebind: () => serially(async () => {
          if (closed || folder !== current) return;
          await remove(current);
          folder = await createSocketFolder(await base());
        }),
      };
    },
    close: () => serially(async () => {
      if (closed) return;
      closed = true;
      await remove(folder);
    }),
  };
}

/**
 * Drops what the daemon's own environment must not pass on: Electron's variables (daemonChildEnv adds them for forks) and
 * SSH_AUTH_SOCK, the agent of the ssh session that started the daemon or one a login profile set, which only a client's
 * agent proxy socket may replace.
 */
export function dropInheritedVariables(env: NodeJS.ProcessEnv): void {
  for (const key of Object.keys(env)) if (/^ELECTRON_/i.test(key) || key.toUpperCase() === 'SSH_AUTH_SOCK') delete env[key];
}

/** The serve mode: the spawn lock, the launcher pool, the daemon lock, the login environment, git, then the endpoint. */
export async function serve(root: string): Promise<void> {
  // The daemon's own environment is the one its user-facing children get.
  dropInheritedVariables(process.env);
  lockThreadSpawns();
  installProcessLauncher(createLauncherPool({ workerPath: path.join(root, 'dist', 'process-launcher-worker.js'), sentinelPath: path.join(root, 'dist', 'sentinel.js') }));
  const paths = await localRunPaths();
  // icacls runs on the launcher; a failure ends the start before any token is written
  await makeRunDir(paths);
  // until the daemon is built, a compromised lock only ends the start
  let compromised = (): void => void exit(EXIT_START_FAILED, 'the daemon lock was compromised');
  let log = (line: string): void => {
    process.stderr.write(`${line}\n`);
  };
  let flushLogs = async (): Promise<void> => undefined;
  const exit = async (code: number, reason: string): Promise<never> => {
    log(`[daemon] exiting (${code}): ${reason}`);
    await flushLogs();
    process.exit(code);
  };
  // the lock comes before the log: a start that loses the race never writes the running daemon's log
  const lock = await acquireDaemonLock(paths, (error) => {
    log(`[daemon] the daemon lock was compromised: ${error.message}`);
    compromised();
  }, () => daemonAnswers(paths));
  if (!lock.held) return exit(EXIT_LOCK_HELD, 'another daemon holds the lock');
  const logSinks = createDesktopLogSinkFactory(paths.logsDir, false, () => undefined);
  installLogSink(logSinks.create(DAEMON_LOG));
  log = (line) => coreLog(line);
  flushLogs = () => logSinks.endAsyncWrites();
  logUncaughtErrors(process, 'daemon', log);
  const start = async (): Promise<void> => {
    const version = await readVersion(root);
    log(`Damocles daemon ${version} starting (pid ${process.pid})`);
    await mergeLoginShellEnv(processLauncher(), log);
    // the login shell's environment may set them again
    dropInheritedVariables(process.env);
    const git = await probeGit(log, plain);
    const credentialRelay = await createCredentialRelay(root);
    log(`[daemon] the git credential relay's handle is ${credentialRelay.identity().handle}`);
    const daemon = await listen({
      paths,
      version,
      touchIntervalMs: TOUCH_INTERVAL_MS,
      log,
      build: (endpoint) => buildDaemon({
        root,
        version,
        facts: hostFacts(git.available),
        paths,
        starters: daemonStarters(root),
        git,
        e2eHooks: daemonE2eHooks(process.env),
        ...(daemonE2eHooks(process.env) ? e2eConnectionLimits(process.env) : {}),
        ...endpoint,
        credentialRelay,
        releaseLock: lock.release,
        exit: (reason, code) => void exit(code, reason),
        log,
      }),
    }).catch(async (err: unknown) => {
      // a failed start leaves no relay folder behind
      await credentialRelay.close().catch((closeErr: unknown) => log(`[daemon] removing the git credential relay failed: ${closeErr instanceof Error ? closeErr.message : String(closeErr)}`));
      throw err;
    });
    compromised = () => void daemon.lockLost('the daemon lock was compromised');
  };
  // the daemon log records why a start failed: a detached start's stderr goes nowhere
  await start().catch((err: unknown) => exit(EXIT_START_FAILED, `could not start: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`));
}
