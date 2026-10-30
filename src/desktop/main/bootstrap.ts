import { log } from '../../core/logger';
import { folderKey } from '../../core/workspace-folders/folder-key';
import { createMainEndpoint, type CoreInit } from '../core-protocol';
import { CoreClient } from './core-client';
import { forkCore, type CoreExit } from './core-process';
import { createHostServices, NO_USER_RELAYS, type HostServicesDeps } from './core-services/host-services';
import type { DesktopPlatform } from './platform';
import { bounded } from './shutdown';
import type { TrustStore } from './trust-store';
import { LOCAL_PROJECT_KEYS } from './remote/remote-project-keys';

/** One running Damocles Core process as main sees it: its client, and the shutdown that ends it. */
export interface DesktopCore {
  // 'local': the core this app forks
  readonly authority: string;
  readonly client: CoreClient;
  // the process's pid once it spawned
  readonly pid: () => number | undefined;
  // settles once core published its folder targets, before which no caller gets the core; rejects when core ended first
  readonly ready: Promise<void>;
  isReady(): boolean;
  // the process ended, ready or not
  hasEnded(): boolean;
  // the window's terminal pane was shown or hidden
  terminalToggleChanged(): void;
  // core.shutdown (ChatPanelProvider.dispose and core's config writes) within closeTimeoutMs, then the kill and the exit.
  dispose(): Promise<void>;
}

export interface CoreConnectionDeps
  extends Pick<HostServicesDeps, 'terminalToggle' | 'resolveProxy' | 'createView' | 'git' | 'e2eHooks' | 'paths' | 'logs' | 'language' | 'power' | 'ui' | 'divert' | 'render' | 'log'> {
  // main's platform: what core's proxies reach
  readonly platform: DesktopPlatform;
  readonly trust: TrustStore;
  // dist/core-host.js (coreHostEntryPath)
  readonly entry: string;
  // core's stdout follows main's (the unpackaged app, whose sinks echo there)
  readonly echo: boolean;
  // how long a quit or reload waits for core.shutdown's reply before it kills core
  readonly closeTimeoutMs: number;
  // how long core has to publish its folder targets before main kills it and takes the crash path
  readonly readyTimeoutMs: number;
}

export interface CoreStart {
  // the cores that ended earlier in this app run holding session leases no live process holds
  readonly endedCores: CoreInit['endedCores'];
  // the worktree records main last read from a core
  readonly worktreeRecords: CoreInit['worktreeRecords'];
  // core's process ended without main asking it to, or main killed it for a protocol violation or a missed ready deadline
  readonly crashed: (pid: number | undefined, how: string) => void;
  // core's process ended without core.shutdown answering, so the session leases it held were not released; before crashed
  readonly leftLeases: (pid: number) => void;
}

const describeExit = (exit: CoreExit): string => `code ${exit.code}, reason ${exit.reason ?? 'none'}`;

/**
 * Forks a Damocles Core and connects to it: a fresh init (every mirror read now), endpoint, host services and client, so no
 * state crosses from an earlier core. A message outside the contract in either direction kills core, which then takes the
 * crash path like any exit main did not ask for.
 */
export function startDesktopCore(deps: CoreConnectionDeps, start: CoreStart): DesktopCore {
  const child = forkCore(deps.entry, deps.echo);
  let stopping = false;
  let ended = false;
  let isReady = false;
  let violation: string | undefined;
  // Electron forgets the pid once the process exited; the logs and the lease check still name it.
  let pid: number | undefined;
  const pidText = (): string => String(pid ?? 'unknown');
  const endpoint = createMainEndpoint(child.transport, (line) => log(line), (error) => {
    if (violation !== undefined) return;
    violation = error.message;
    log(`[core] protocol violation (${error.message}); killing Damocles Core (pid ${pidText()})`);
    // nothing core sent after the violation is read or served
    isReady = false;
    endpoint.close(`Damocles Core broke the protocol (${error.message})`);
    child.kill();
  }, undefined, deps.render);
  const trust = { trustedKeys: () => deps.trust.trustedFolders().map((folder) => folderKey(folder)), onDidGrant: deps.trust.onDidGrant.bind(deps.trust), requestTrust: deps.trust.requestTrust.bind(deps.trust) };
  const hostServices = createHostServices({ ...deps, trust, endpoint, state: deps.platform.state, endedCores: start.endedCores, worktreeRecords: start.worktreeRecords, user: NO_USER_RELAYS, refusedPosts: new Set() });
  // The init is the channel's first message; core parses everything after it with the protocol's tables.
  child.transport.post(hostServices.init);
  const client = new CoreClient(endpoint, (view, attach) => hostServices.adopt(view, attach), LOCAL_PROJECT_KEYS);
  void child.spawned.then(() => {
    pid = child.pid;
    log(`[core] started (pid ${pidText()})`);
  });

  // A core hung before ready (a stalled startup await, a constructor that never returns) would hold every request forever.
  let readyMissed = false;
  const readyDeadline = setTimeout(() => {
    readyMissed = true;
    log(`[core] not ready within ${deps.readyTimeoutMs} ms; killing Damocles Core (pid ${pidText()})`);
    endpoint.close('Damocles Core did not become ready');
    child.kill();
  }, deps.readyTimeoutMs);
  let rejectReady!: (err: Error) => void;
  const ready = new Promise<void>((resolve, reject) => {
    rejectReady = reject;
    const published = client.onFoldersChanged(() => {
      published.dispose();
      clearTimeout(readyDeadline);
      isReady = !ended;
      log(`[core] ready (pid ${pidText()})`);
      resolve();
    });
  });
  // A core that never became ready is not waited on by anyone but the callers of ready.
  ready.catch(() => undefined);
  child.onExit((code) => {
    ended = true;
    isReady = false;
    clearTimeout(readyDeadline);
    log(`[core] exited (pid ${pidText()}, code ${code})`);
    endpoint.close('Damocles Core stopped');
    rejectReady(new Error('Damocles Core stopped before it was ready'));
    if (stopping) return;
    if (pid !== undefined) start.leftLeases(pid);
    start.crashed(pid, violation !== undefined ? 'protocol violation' : readyMissed ? `not ready within ${deps.readyTimeoutMs} ms` : `exit code ${code}`);
  });
  // Chromium's reason and core's stderr only for an exit main did not ask for; stderr can carry library output
  void child.ended.then((exit) => {
    if (!stopping) log(`[core] ended (pid ${pidText()}, ${describeExit(exit)})${exit.stderr !== null ? `; stderr: ${exit.stderr}` : ''}`);
  });

  return {
    authority: 'local',
    client,
    pid: () => pid,
    ready,
    isReady: () => isReady,
    hasEnded: () => ended,
    terminalToggleChanged: () => hostServices.terminalToggleChanged(),
    dispose: async () => {
      stopping = true;
      clearTimeout(readyDeadline);
      let leftLeases = false;
      if (!ended) {
        const began = Date.now();
        let answered = false;
        const shutdown = client.shutdown().then(
          () => {
            answered = true;
            log(`[core] shut down in ${Date.now() - began} ms (pid ${pidText()})`);
          },
          (err: unknown) => log(`[core] shutdown failed (pid ${pidText()}): ${err instanceof Error ? err.message : String(err)}`),
        );
        await bounded(shutdown, deps.closeTimeoutMs, () => {
          if (!answered) log(`[core] shutdown did not finish within ${deps.closeTimeoutMs} ms; killing Damocles Core (pid ${pidText()})`);
        });
        leftLeases = !answered;
        child.kill();
      }
      await child.exited;
      if (leftLeases && pid !== undefined) start.leftLeases(pid);
      client.dispose();
      hostServices.dispose();
      endpoint.close('Desktop main closed the core channel');
    },
  };
}
