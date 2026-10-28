// App updates: docs/invariants.md "Remote daemon and wire", an updated app never stops a busy daemon of another version.
import type { AttachedClient, Run } from '../../daemon/control-messages';
import type { HostUpdate } from '../../preload/shell-channels';
import type { OtherProtocolDaemon, RemoteConnection } from './connection';

// the daemon's own shutdown bound (singleton.ts SHUTDOWN_MAX_MS); it ends its connections first, so the end comes well within
export const DAEMON_END_WAIT_MS = 10_000;

/** control.shutdownNow, settling once the daemon ended the connection or it dropped, at most waitMs after the answer. */
export async function shutDownNow(connection: Pick<RemoteConnection, 'control' | 'onClose' | 'onLost'>, log: (line: string) => void, waitMs: number = DAEMON_END_WAIT_MS): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const subscriptions: Array<{ dispose(): void }> = [];
  const ended = new Promise<'ended' | 'timedOut'>((resolve) => {
    subscriptions.push(connection.onLost(() => resolve('ended')), connection.onClose(() => resolve('ended')));
  });
  try {
    await connection.control.request('shutdownNow', {});
    const outcome = await Promise.race([ended, new Promise<'timedOut'>((resolve) => { timer = setTimeout(() => resolve('timedOut'), waitMs); })]);
    if (outcome === 'timedOut') log(`[update] the daemon answered shutdownNow but did not end the connection within ${waitMs} ms`);
  } finally {
    clearTimeout(timer);
    for (const subscription of subscriptions) subscription.dispose();
  }
}

export type { HostUpdate };

/** current: the daemon is this app's version; replaceNow: it was idle and stopped; switchWhenIdle: it exits once idle. */
export type CompatibleOutcome = 'current' | 'replaceNow' | 'switchWhenIdle';

export interface CompatibleDaemon {
  readonly serverVersion: string;
  listRuns(): Promise<readonly Run[]>;
  // the other devices attached to it, this one excluded; undefined from a daemon that does not list its clients
  otherDevices(): number | undefined;
  shutdownWhenIdle(): Promise<void>;
  // answers, then the daemon ends every run through its Stop path, every terminal, and exits
  shutdownNow(): Promise<void>;
}

/**
 * The devices attached to a daemon besides this one; undefined until the daemon listed this device, which one without the
 * clients feature never does.
 */
export function otherDeviceCount(devices: readonly AttachedClient[]): number | undefined {
  return devices.some((device) => device.self) ? devices.filter((device) => !device.self).length : undefined;
}

/**
 * What a compatible daemon of another app version does once attached: idle and known to serve no other device, replaced now;
 * else it exits once idle.
 */
export async function adoptCompatibleDaemon(appVersion: string, daemon: CompatibleDaemon, log: (line: string) => void): Promise<CompatibleOutcome> {
  if (daemon.serverVersion === appVersion) return 'current';
  const runs = await daemon.listRuns();
  if (runs.length === 0 && daemon.otherDevices() === 0) {
    log(`[update] the daemon of ${daemon.serverVersion} is idle with no other device; stopping it for ${appVersion}`);
    await daemon.shutdownNow();
    return 'replaceNow';
  }
  log(`[update] the daemon of ${daemon.serverVersion} has ${runs.length} runs or other devices; it exits once idle, then ${appVersion} starts`);
  await daemon.shutdownWhenIdle();
  return 'switchWhenIdle';
}

/** What Switch now stops: each running agent's title and each terminal's name, which its confirmation lists. */
export interface SwitchListing {
  readonly agents: readonly string[];
  readonly terminals: readonly string[];
}

export interface OtherProtocolHostDeps {
  readonly daemon: OtherProtocolDaemon;
  // the host's session mirror catches up over the daemon's frozen mirror.sync
  readonly syncMirror: () => Promise<void>;
  // the banner changed (appeared, counted another agent, waits, went)
  readonly changed: () => void;
  // a connect of this app's own version, once the old daemon is gone
  readonly reconnect: () => void;
  // Switch now's confirmation; true: switch
  readonly confirm: (listing: SwitchListing) => Promise<boolean>;
  // how often the read-only chats and the banner follow the old daemon: the frozen commands carry no events
  readonly pollMs: number;
  readonly log: (line: string) => void;
}

export interface OtherProtocolHost {
  readonly daemon: OtherProtocolDaemon;
  // the banner of a busy daemon: "prod-1 is running 2 agents on Damocles 3.7.0"
  update(): HostUpdate | undefined;
  switchWhenIdle(): Promise<void>;
  // false: the user kept the old daemon running
  switchNow(): Promise<boolean>;
  dispose(): void;
}

const listingOf = (runs: readonly Run[]): SwitchListing => ({
  agents: runs.filter((run) => run.kind === 'chat').map((run) => run.title),
  terminals: runs.filter((run) => run.kind === 'terminal').map((run) => run.title),
});

/**
 * Starts following a daemon of another protocol: with no run and no terminal it is stopped now and this app's version
 * connects; else its chats stay readable from the mirror, which a poll keeps live, and the banner offers the switch. Its
 * connection closing (it exited, or the network dropped) ends the banner and connects again.
 */
export function followOtherProtocolDaemon(deps: OtherProtocolHostDeps): OtherProtocolHost {
  const { daemon, log } = deps;
  let banner: HostUpdate | undefined;
  let timer: NodeJS.Timeout | undefined;
  let ended = false;

  const setBanner = (next: HostUpdate | undefined): void => {
    if (banner?.runningAgents === next?.runningAgents && banner?.phase === next?.phase && banner?.serverVersion === next?.serverVersion) return;
    banner = next;
    deps.changed();
  };
  const follow = async (): Promise<void> => {
    const runs = (await daemon.control.request('listRuns', {})).runs;
    if (ended) return;
    log(`[update] the daemon of ${daemon.serverVersion} runs ${runs.filter((run) => run.kind === 'chat').length} chats and ${runs.filter((run) => run.kind === 'terminal').length} terminals`);
    if (runs.length === 0 && banner === undefined) {
      log(`[update] the daemon of ${daemon.serverVersion} (protocol ${daemon.protocolVersion}) runs nothing; stopping it`);
      await daemon.control.request('shutdownNow', {});
      return;
    }
    setBanner({ serverVersion: daemon.serverVersion, runningAgents: runs.filter((run) => run.kind === 'chat').length, phase: banner?.phase ?? 'offer' });
    await deps.syncMirror();
  };
  const poll = (): void => {
    follow().catch((err: unknown) => log(`[update] following the daemon of ${daemon.serverVersion} failed: ${err instanceof Error ? err.message : String(err)}`)).finally(() => {
      if (!ended) timer = setTimeout(poll, deps.pollMs);
    });
  };
  const closed = daemon.onClose((reason) => {
    if (ended) return;
    ended = true;
    clearTimeout(timer);
    log(`[update] the daemon of ${daemon.serverVersion} closed its connection (${reason}); connecting ${banner?.phase === 'waiting' ? 'after its exit' : 'again'}`);
    setBanner(undefined);
    deps.reconnect();
  });
  poll();

  return {
    daemon,
    update: () => banner,
    switchWhenIdle: async () => {
      await daemon.control.request('shutdownWhenIdle', {});
      if (banner) setBanner({ ...banner, phase: 'waiting' });
    },
    switchNow: async () => {
      const runs = (await daemon.control.request('listRuns', {})).runs;
      if (!(await deps.confirm(listingOf(runs)))) return false;
      log(`[update] switching from the daemon of ${daemon.serverVersion} now: ${runs.length} runs stop`);
      await daemon.control.request('shutdownNow', {});
      return true;
    },
    dispose: () => {
      ended = true;
      clearTimeout(timer);
      closed.dispose();
      daemon.close('the app let go of the old daemon');
    },
  };
}

/**
 * Each authority's update flow. A new one replaces the one before; Forget host and the quit let go of theirs before the
 * connections close, or a closing old daemon would start a connect.
 */
export class FollowedDaemons {
  private readonly flows = new Map<string, OtherProtocolHost>();

  get(authorityKey: string): OtherProtocolHost | undefined {
    return this.flows.get(authorityKey);
  }

  has(authorityKey: string): boolean {
    return this.flows.has(authorityKey);
  }

  /** start's flow becomes the authority's; it calls ended once its daemon's connection closed, which lets go of it. */
  follow(authorityKey: string, start: (ended: () => void) => OtherProtocolHost): void {
    this.forget(authorityKey);
    // a daemon closed before start returned ends its flow at once
    const slot: { flow?: OtherProtocolHost; over: boolean } = { over: false };
    slot.flow = start(() => {
      slot.over = true;
      if (slot.flow !== undefined && this.flows.get(authorityKey) === slot.flow) this.flows.delete(authorityKey);
    });
    if (!slot.over) this.flows.set(authorityKey, slot.flow);
  }

  forget(authorityKey: string): void {
    this.flows.get(authorityKey)?.dispose();
    this.flows.delete(authorityKey);
  }

  dispose(): void {
    for (const flow of this.flows.values()) flow.dispose();
    this.flows.clear();
  }
}
