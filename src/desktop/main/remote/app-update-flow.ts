// App updates: docs/invariants.md "Remote daemon and wire", an updated app never stops a busy daemon of another build.
import type { Disposable } from '../../../platform/disposable';
import type { AttachedClient, Run } from '../../daemon/control-messages';
import type { HostUpdate } from '../../../shared/host-update';
import type { HostNotice } from '../../preload/overlay-channels';
import type { ProjectConnection } from '../../preload/shell-channels';
import { HAND_OVER_FEATURE, HAND_OVER_IF_IDLE_FEATURE, RUNS_FEATURE, type OtherProtocolDaemon, type RemoteConnection } from './connection';
import type { RequiredSince } from './remote-state';
import { appVersionOf, requiredOf, serverVersionsOf, type ServerManifest } from './server-manifest-format';
import { compareVersions, isVersion } from '../semver';

// The daemon's shutdownWhenIdle waits for every connected client that did not ask; one without it exits once idle whoever is connected.
export const SHUTDOWN_WHEN_IDLE_CLIENTS_FEATURE = 'control.shutdownWhenIdle.clients';

// how long other connected computers delay a switch once no agent runs
export const DRAIN_MS: number = 15 * 60_000;
// how long before its deadline a required switch counts down, and how long a connect after a missed deadline waits
export const COUNTDOWN_MS: number = 15 * 60_000;
// setTimeout fires at once for a longer wait
const MAX_TIMER_MS = 2 ** 31 - 1;

interface WallTimer {
  cancel(): void;
  // reads the wall clock again: a timer's own clock stops during sleep on macOS and Linux
  rearm(): void;
}

// Runs `run` once at epoch ms `time`, however far away.
function at(time: number, run: () => void): WallTimer {
  let timer: NodeJS.Timeout | undefined;
  let done = false;
  const arm = (): void => {
    clearTimeout(timer);
    if (done) return;
    const wait = time - Date.now();
    timer = wait > MAX_TIMER_MS ? setTimeout(arm, MAX_TIMER_MS) : setTimeout(() => {
      done = true;
      run();
    }, Math.max(0, wait));
  };
  arm();
  return {
    cancel: () => {
      done = true;
      clearTimeout(timer);
    },
    rearm: arm,
  };
}

/**
 * A required update's deadline for the daemon of `serverVersion` (A11): `record` is what the authority keeps, the stored first
 * detection with its deadline, which a shorter grace only brings closer, or a new one for another server version; `deadline`
 * is when this run switches, COUNTDOWN_MS from now when the stored one has passed, which is never stored.
 */
export function requiredDeadline(stored: RequiredSince | undefined, serverVersion: string, graceHours: number, now: number): { readonly record: RequiredSince; readonly deadline: number } {
  const fresh = now + graceHours * 3_600_000;
  const record = stored?.serverVersion === serverVersion ? { ...stored, deadline: Math.min(stored.deadline, fresh) } : { serverVersion, detectedAt: now, deadline: fresh };
  return { record, deadline: record.deadline <= now ? now + COUNTDOWN_MS : record.deadline };
}

/** What a switch this app sent stopped; forcedAt: the epoch ms a required update's deadline sent it with no confirmation. */
export interface SwitchResult {
  readonly agentsStopped: number;
  readonly terminalsClosed: number;
  // the pending damocles --wait requests it answered not connected; absent when none
  readonly cliWaitsEnded?: number;
  readonly forcedAt?: number;
  // the user confirmed this switch, so its result is always told
  readonly chosen?: true;
}

// the daemon's own shutdown bound (lock-timing.ts SHUTDOWN_MAX_MS); it ends its connections first, so the end comes well within
export const DAEMON_END_WAIT_MS = 10_000;

type EndingConnection = Pick<RemoteConnection, 'control' | 'onClose' | 'onLost'>;

/** control.shutdownNow, settling once the daemon ended the connection or it dropped, at most waitMs after the answer. */
export function shutDownNow(connection: EndingConnection, log: (line: string) => void, waitMs: number = DAEMON_END_WAIT_MS): Promise<void> {
  return endDaemon(connection, 'shutdownNow', () => connection.control.request('shutdownNow', {}), log, waitMs);
}

/** control.handOver now, settling as shutDownNow does; the daemon's terminals stay with their terminal hosts. */
export function handOverNow(connection: EndingConnection, log: (line: string) => void, waitMs: number = DAEMON_END_WAIT_MS): Promise<void> {
  return endDaemon(connection, 'handOver', () => connection.control.request('handOver', { when: 'now' }), log, waitMs);
}

/**
 * control.handOverIfIdle, the daemon's answer: at now, `now` runs and it settles as handOverNow does; at idle, the daemon
 * exits once idle as after handOver idle.
 */
export function handOverIfIdle(connection: EndingConnection, log: (line: string) => void, now: () => void = () => undefined, waitMs: number = DAEMON_END_WAIT_MS): Promise<'idle' | 'now'> {
  return endDaemon(connection, 'handOverIfIdle', async () => (await connection.control.request('handOverIfIdle', {})).when, log, waitMs, (when) => {
    if (when === 'idle') return false;
    now();
    return true;
  });
}

// answered: runs at the answer, true when the daemon ends the connection
async function endDaemon<T>(connection: EndingConnection, name: string, ask: () => Promise<T>, log: (line: string) => void, waitMs: number, answered: (answer: T) => boolean = () => true): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const subscriptions: Array<{ dispose(): void }> = [];
  const ended = new Promise<'ended' | 'timedOut'>((resolve) => {
    subscriptions.push(connection.onLost(() => resolve('ended')), connection.onClose(() => resolve('ended')));
  });
  try {
    const answer = await ask();
    if (!answered(answer)) return answer;
    const outcome = await Promise.race([ended, new Promise<'timedOut'>((resolve) => { timer = setTimeout(() => resolve('timedOut'), waitMs); })]);
    if (outcome === 'timedOut') log(`[update] the daemon answered ${name} but did not end the connection within ${waitMs} ms`);
    return answer;
  } finally {
    clearTimeout(timer);
    for (const subscription of subscriptions) subscription.dispose();
  }
}

export type { HostUpdate };

/**
 * current: the daemon is this build's; replaceNow: it was idle and stopped; switchWhenIdle: it exits once idle; useAsIs: it is
 * newer than this app, or other devices use it and this app may not switch it, so it stays.
 */
export type CompatibleOutcome = 'current' | 'replaceNow' | 'switchWhenIdle' | 'useAsIs';

export interface CompatibleDaemon {
  readonly serverVersion: string;
  // it lists SHUTDOWN_WHEN_IDLE_CLIENTS_FEATURE
  readonly waitsForOtherClients: boolean;
  listRuns(): Promise<readonly Run[]>;
  // its pending damocles --wait requests (RemoteConnection.cliWaits)
  cliWaits(): readonly string[];
  // the other devices attached to it, this one excluded; undefined from a daemon that does not list its clients
  otherDevices(): number | undefined;
  shutdownWhenIdle(): Promise<void>;
  // answers, then the daemon's core disposes every chat, which aborts its run, ends every terminal, and exits
  shutdownNow(): Promise<void>;
  // it lists HAND_OVER_FEATURE: its terminals outlive it, so only its chat runs and pending damocles --wait requests hold a
  // switch back
  readonly handsOver: boolean;
  // called only when handsOver. idle: it exits once no chat runs and no damocles --wait is pending; now: answers, stops its
  // chat runs, answers its pending waits not connected and exits
  handOver(when: 'idle' | 'now'): Promise<void>;
  // only from a daemon that lists HAND_OVER_IF_IDLE_FEATURE: handOver now or idle as the daemon finds its own chat runs and
  // pending damocles --wait requests as the request arrives, whoever is connected; answers which
  handOverIfIdle?(): Promise<'idle' | 'now'>;
}

/**
 * The devices attached to a daemon besides this one; undefined until the daemon listed this device, which one without the
 * clients feature never does.
 */
export function otherDeviceCount(devices: readonly AttachedClient[]): number | undefined {
  return devices.some((device) => device.self) ? devices.filter((device) => !device.self).length : undefined;
}

/**
 * Whether `appVersion` follows the app version of `serverVersion` (its build ignored). A daemon version that does not parse is
 * followed; an app version that does not parse follows nothing, so it never takes a host in use from another device.
 */
export function supersedes(appVersion: string, serverVersion: string): boolean {
  const running = appVersionOf(serverVersion);
  if (!isVersion(running)) return true;
  return isVersion(appVersion) && compareVersions(appVersion, running) > 0;
}

/** Whether the app version of `serverVersion` follows `appVersion`; false when either does not parse. */
export function newerThanApp(appVersion: string, serverVersion: string): boolean {
  const running = appVersionOf(serverVersion);
  return isVersion(running) && isVersion(appVersion) && compareVersions(running, appVersion) > 0;
}

/** switchWhenIdle carries the runs the daemon listed, which its flow starts from (followCompatibleDaemon's runs). */
export type Adopted = { readonly outcome: Exclude<CompatibleOutcome, 'switchWhenIdle'> } | { readonly outcome: 'switchWhenIdle'; readonly runs: readonly Run[] };

// docs/invariants.md "An updated app never stops a busy daemon of another build" and, for one `manifest` requires to switch,
// "A pending switch waits only on running agents ...".
export async function adoptCompatibleDaemon(manifest: ServerManifest, daemon: CompatibleDaemon, log: (line: string) => void): Promise<Adopted> {
  if (serverVersionsOf(manifest).has(daemon.serverVersion)) return { outcome: 'current' };
  if (newerThanApp(manifest.version, daemon.serverVersion)) {
    log(`[update] the daemon of ${daemon.serverVersion} is newer than this build of ${manifest.version}; using it as it is`);
    return { outcome: 'useAsIs' };
  }
  const listed = await daemon.listRuns();
  // a daemon that hands over keeps no terminal from the switch
  const runs = daemon.handsOver ? listed.filter((run) => run.kind === 'chat') : listed;
  const waits = daemon.cliWaits().length;
  const others = daemon.otherDevices();
  const uses = `${runs.length} ${daemon.handsOver ? `agent runs, ${waits} damocles --wait requests` : 'runs'} and ${others ?? 'an unknown number of'} other devices`;
  const required = requiredOf(manifest, daemon.serverVersion) !== undefined;
  const decides = daemon.handsOver && daemon.handOverIfIdle !== undefined;
  if (runs.length === 0 && waits === 0 && (others === 0 || required)) {
    log(`[update] the daemon of ${daemon.serverVersion} is idle ${others === 0 ? 'with no other device' : `and must switch, with ${others ?? 'an unknown number of'} other devices`}; stopping it for this build of ${manifest.version}${decides ? ' if it is still idle' : ''}`);
    if (!decides) {
      await (daemon.handsOver ? daemon.handOver('now') : daemon.shutdownNow());
      return { outcome: 'replaceNow' };
    }
    if ((await daemon.handOverIfIdle?.()) === 'now') return { outcome: 'replaceNow' };
    log(`[update] the daemon of ${daemon.serverVersion} has an agent run or a damocles --wait after all; ${required ? 'it exits once idle, or at its deadline' : `it exits once idle, then this build of ${manifest.version} starts`}`);
    return { outcome: 'switchWhenIdle', runs: listed };
  }
  if (required) {
    log(`[update] the daemon of ${daemon.serverVersion} has ${uses} and must switch to this build of ${manifest.version}; it exits once idle, or at its deadline`);
    await (daemon.handsOver ? daemon.handOver('idle') : daemon.shutdownWhenIdle());
    return { outcome: 'switchWhenIdle', runs: listed };
  }
  const newer = supersedes(manifest.version, daemon.serverVersion);
  if (others !== 0 && !(newer && daemon.waitsForOtherClients)) {
    const why = newer ? 'would end their connections once idle' : `is not older than this build of ${manifest.version}`;
    log(`[update] the daemon of ${daemon.serverVersion} has ${uses} and ${why}; using it as it is`);
    return { outcome: 'useAsIs' };
  }
  log(`[update] the daemon of ${daemon.serverVersion} has ${uses}; it exits once idle, then this build of ${manifest.version} starts`);
  await (daemon.handsOver ? daemon.handOver('idle') : daemon.shutdownWhenIdle());
  return { outcome: 'switchWhenIdle', runs: listed };
}

/** The host card's notice while an older daemon this app uses as it is serves other computers; none while it serves none. */
export function serverInUseNotice(connection: Pick<RemoteConnection, 'serverVersion' | 'devices'>): HostNotice | undefined {
  const devices = otherDeviceCount(connection.devices());
  return devices ? { code: 'serverInUse', params: { version: appVersionOf(connection.serverVersion), devices } } : undefined;
}

/**
 * What Switch now stops, which its confirmation lists: each running agent's title, each terminal's name, each pending damocles
 * --wait's files, the other computers connected (0 when unknown), and whether the terminals outlive the switch.
 */
export interface SwitchListing {
  readonly agents: readonly string[];
  readonly terminals: readonly string[];
  readonly cliWaits: readonly string[];
  readonly otherDevices: number;
  readonly terminalsSurvive: boolean;
}

/** A host's pending switch, of a compatible daemon or one of another protocol (A10). */
export interface PendingSwitch {
  update(): HostUpdate | undefined;
  switchWhenIdle(): Promise<void>;
  // false: the user kept the old daemon running; confirmed: the caller asked already
  switchNow(options?: { readonly confirmed?: boolean }): Promise<boolean>;
  // the refused connection of a daemon of another protocol while this flow holds it
  following(): OtherProtocolDaemon | undefined;
  // the authority's connection state, which ends the switch once its old connection is gone and the next connect failed
  stateChanged(state: ProjectConnection): void;
  // the computer resumed from sleep: every deadline reads the wall clock again
  resumed(): void;
  dispose(): void;
}

const listingOf = (runs: readonly Run[], cliWaits: readonly string[], otherDevices: number, terminalsSurvive: boolean): SwitchListing => ({
  agents: runs.filter((run) => run.kind === 'chat').map((run) => run.title),
  terminals: runs.filter((run) => run.kind === 'terminal').map((run) => run.title),
  cliWaits,
  otherDevices,
  terminalsSurvive,
});

// the runs a switch now stops: every run, or only the chats of a daemon that hands its terminals over
const stopping = (runs: readonly Run[], handsOver: boolean): number => (handsOver ? runs.filter((run) => run.kind === 'chat').length : runs.length);

const counts = (runs: readonly Run[]): { runningAgents: number; runningTerminals: number } => ({
  runningAgents: runs.filter((run) => run.kind === 'chat').length,
  runningTerminals: runs.filter((run) => run.kind === 'terminal').length,
});

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * The connect after the old connection went (A10): a connect that settles on a connection replaces the flow, so only a failed
 * attempt ends it here; one that resumes the old connection brings it back.
 */
function nextConnect(end: () => void, resumed: () => boolean): { gone(): void; isGone(): boolean; stateChanged(state: ProjectConnection): void } {
  let gone = false;
  let attempting = false;
  return {
    // a lost connection closes inside the attempt that tried to resume it, which still counts
    gone: () => {
      if (gone) return;
      gone = true;
      attempting = false;
    },
    isGone: () => gone,
    stateChanged: (state) => {
      if (!gone) return;
      if (state === 'connected') {
        if (resumed()) gone = false;
      } else if (state === 'connecting') {
        attempting = true;
      } else if (attempting) {
        end();
      }
    },
  };
}

export interface CompatibleSwitchDeps {
  readonly connection: Pick<RemoteConnection, 'serverVersion' | 'features' | 'control' | 'devices' | 'onDevices' | 'onRuns' | 'cliWaits' | 'onLost' | 'onClose' | 'lost'>;
  // this app's version
  readonly targetVersion: string;
  // the runs the daemon listed when it was asked (Adopted), so no update counts runs it has not listed
  readonly runs: readonly Run[];
  // the update changed
  readonly changed: () => void;
  // the switch is over without a connection replacing it: its next connect failed
  readonly ended: () => void;
  // Switch now's confirmation; true: switch
  readonly confirm: (listing: SwitchListing) => Promise<boolean>;
  // how often a daemon that does not push its runs (control.runs) is asked for them
  readonly pollMs: number;
  // when this app first found the daemon waiting to switch (epoch ms), as the authority's state keeps it across relaunches
  readonly waitingSince: number;
  // the daemon must switch by this epoch ms (requiredDeadline), when this flow switches it with no confirmation
  readonly required?: { readonly deadline: number };
  // DRAIN_MS, shortened by the e2e hook
  readonly drainMs?: number;
  // a switch this flow sent, as its command went out; undefined: the daemon refused it
  readonly switched?: (result: SwitchResult | undefined) => void;
  readonly log: (line: string) => void;
}

// docs/invariants.md "A pending switch waits only on running agents ...".
export function followCompatibleDaemon(deps: CompatibleSwitchDeps): PendingSwitch {
  const { connection, log, required, waitingSince } = deps;
  const pushes = connection.features.includes(RUNS_FEATURE);
  const handsOver = connection.features.includes(HAND_OVER_FEATURE);
  const decides = handsOver && connection.features.includes(HAND_OVER_IF_IDLE_FEATURE);
  let runs = deps.runs;
  let switched = false;
  let closed = false;
  let over = false;
  let timer: NodeJS.Timeout | undefined;
  let published = '';
  let drain: { readonly endsAt: number; readonly timer: WallTimer } | undefined;
  // an unasked switch that failed, sent again after pollMs
  let retry: { readonly timer: WallTimer; readonly forced: boolean } | undefined;
  let countdown = required !== undefined && Date.now() >= required.deadline - COUNTDOWN_MS;
  let sending: { readonly done: Promise<void>; readonly ifIdle: boolean } | undefined;
  // the pending damocles --wait requests as the latest runs event listed them, which hold a switch as agents do
  const waits = (): number => connection.cliWaits().length;
  const next = nextConnect(() => {
    log(`[update] the connect after the daemon of ${connection.serverVersion} went failed; the switch is over`);
    stop();
    deps.ended();
    deps.changed();
  }, () => !closed && !connection.lost());
  const update = (): HostUpdate => {
    const otherDevices = otherDeviceCount(connection.devices());
    return {
      source: 'compatible',
      phase: switched || next.isGone() ? 'switching' : 'waiting',
      serverVersion: appVersionOf(connection.serverVersion),
      targetVersion: deps.targetVersion,
      ...counts(runs),
      ...(waits() > 0 ? { cliWaits: waits() } : {}),
      terminalsSurvive: handsOver,
      ...(otherDevices !== undefined ? { otherDevices } : {}),
      ...(drain !== undefined ? { drainEndsAt: drain.endsAt } : {}),
      waitingSince,
      ...(required !== undefined ? { required: { deadline: required.deadline, countdown } } : {}),
    };
  };
  const publish = (): void => {
    if (over) return;
    const text = JSON.stringify(update());
    if (text === published) return;
    published = text;
    deps.changed();
  };
  const endDrain = (): void => {
    drain?.timer.cancel();
    drain = undefined;
    // only a deadline's switch outlasts the conditions that sent it; evaluate sends the others again
    if (retry?.forced === false) {
      retry.timer.cancel();
      retry = undefined;
    }
  };
  const stop = (): void => {
    over = true;
    clearTimeout(timer);
    endDrain();
    retry?.timer.cancel();
    for (const scheduled of deadlines) scheduled.cancel();
    for (const subscription of subscriptions) subscription.dispose();
  };
  // The switch itself; forced: the deadline sent it, which nothing confirmed; ifIdle: through handOverIfIdle, so the daemon
  // makes it only while it finds no chat run and no pending damocles --wait of its own.
  const send = (stopped: readonly Run[], forced: boolean, chosen?: true, ifIdle = false): Promise<void> => {
    // a switch that stops what runs still goes out once the daemon answered an ifIdle one idle
    if (sending?.ifIdle === true && !ifIdle) return sending.done.catch(() => undefined).then(() => (switched ? undefined : send(stopped, forced, chosen)));
    sending ??= { ifIdle, done: (async () => {
      const cliWaitsEnded = waits();
      const sent = (): void => {
        log(`[update] switching from the daemon of ${connection.serverVersion} ${forced ? 'at its deadline' : 'now'}: ${stopping(stopped, handsOver)} runs and ${cliWaitsEnded} damocles --wait requests stop`);
        switched = true;
        endDrain();
        publish();
        const { runningAgents, runningTerminals } = counts(stopped);
        deps.switched?.({ agentsStopped: runningAgents, terminalsClosed: handsOver ? 0 : runningTerminals, ...(cliWaitsEnded > 0 ? { cliWaitsEnded } : {}), ...(forced ? { forcedAt: Date.now() } : {}), ...(chosen ? { chosen } : {}) });
      };
      if (!ifIdle) {
        sent();
        await (handsOver ? handOverNow(connection, log) : shutDownNow(connection, log));
      } else if ((await handOverIfIdle(connection, log, sent)) === 'idle') {
        sending = undefined;
        log(`[update] not switching the daemon of ${connection.serverVersion}: it has an agent run or a damocles --wait after all`);
        endDrain();
        publish();
      }
    })().catch((err: unknown) => {
      sending = undefined;
      switched = false;
      // a connection still up got the daemon's refusal, so nothing switched; a dropped one may have switched it
      if (!closed && !connection.lost()) deps.switched?.(undefined);
      publish();
      throw err;
    }) };
    return sending.done;
  };
  // A switch nobody confirms: the drain's end, a required daemon that runs nothing more, the deadline. Only the deadline sends
  // it whatever runs; the others send it only while the daemon's latest list still allows it, else follow that list, and
  // through handOverIfIdle when the daemon decides itself.
  const sendUnasked = (why: string, forced: boolean): void => {
    if (over || switched) return;
    connection.control.request('listRuns', {}).then(({ runs: found }) => {
      if (over || switched) return undefined;
      if (!forced && stopping(found, handsOver) + waits() > 0) {
        log(`[update] not switching the daemon of ${connection.serverVersion}: it lists a run or a damocles --wait again`);
        return take(found);
      }
      log(`[update] ${why}`);
      return send(found, forced, undefined, !forced && decides);
    }).catch((err: unknown) => {
      log(`[update] switching from the daemon of ${connection.serverVersion} failed: ${message(err)}`);
      if (over || closed || (retry?.forced === true && !forced)) return;
      retry?.timer.cancel();
      retry = { timer: at(Date.now() + deps.pollMs, () => sendUnasked(why, forced)), forced };
    });
  };
  // Starts or cancels the drain, and switches a required daemon the moment the switch stops nothing.
  const evaluate = (): void => {
    if (over || switched) return;
    if (next.isGone()) return endDrain();
    if (required !== undefined) {
      if (stopping(runs, handsOver) + waits() === 0) sendUnasked(`the daemon of ${connection.serverVersion} must switch and runs nothing more`, false);
      return;
    }
    const drains = handsOver && !runs.some((run) => run.kind === 'chat') && waits() === 0 && (otherDeviceCount(connection.devices()) ?? 0) > 0;
    if (drains && drain === undefined) {
      const drainMs = deps.drainMs ?? DRAIN_MS;
      log(`[update] no agent runs and no damocles --wait on the daemon of ${connection.serverVersion}; the other computers keep it for ${drainMs} ms more`);
      const endsAt = Date.now() + drainMs;
      drain = { endsAt, timer: at(endsAt, () => sendUnasked(`the other computers kept the daemon of ${connection.serverVersion} for ${drainMs} ms`, false)) };
    } else if (!drains && drain !== undefined) {
      log(`[update] the daemon of ${connection.serverVersion} is no longer drained: an agent runs, a damocles --wait is pending, or no other computer is connected`);
      endDrain();
    }
  };
  const changed = (): void => {
    evaluate();
    publish();
  };
  const take = (found: readonly Run[]): void => {
    runs = found;
    changed();
  };
  const deadlines: WallTimer[] = required === undefined ? [] : [
    ...(countdown ? [] : [at(required.deadline - COUNTDOWN_MS, () => {
      countdown = true;
      publish();
    })]),
    at(required.deadline, () => sendUnasked(`the deadline of the daemon of ${connection.serverVersion} passed`, true)),
  ];
  const subscriptions: Disposable[] = [
    connection.onDevices(changed),
    connection.onLost(() => {
      next.gone();
      changed();
    }),
    connection.onClose(() => {
      closed = true;
      next.gone();
      changed();
    }),
    ...(pushes ? [connection.onRuns(take)] : []),
  ];
  const poll = (): void => {
    connection.control.request('listRuns', {}).then(({ runs: found }) => {
      if (!over) take(found);
    }, (err: unknown) => {
      if (!over && !closed) log(`[update] listing the runs of the daemon of ${connection.serverVersion} failed: ${message(err)}`);
    }).finally(() => {
      if (!over && !closed) timer = setTimeout(poll, deps.pollMs);
    });
  };
  evaluate();
  if (!pushes) poll();

  return {
    update,
    switchWhenIdle: () => (handsOver ? connection.control.request('handOver', { when: 'idle' }) : connection.control.request('shutdownWhenIdle', {})),
    switchNow: async (options) => {
      const found = (await connection.control.request('listRuns', {})).runs;
      if (!options?.confirmed && !(await deps.confirm(listingOf(found, connection.cliWaits(), otherDeviceCount(connection.devices()) ?? 0, handsOver)))) return false;
      await send(found, false, options?.confirmed ? undefined : true);
      return true;
    },
    following: () => undefined,
    stateChanged: (state) => {
      next.stateChanged(state);
      changed();
    },
    resumed: () => {
      for (const scheduled of [...deadlines, ...(drain ? [drain.timer] : []), ...(retry ? [retry.timer] : [])]) scheduled.rearm();
    },
    dispose: stop,
  };
}

export interface OtherProtocolHostDeps {
  readonly daemon: OtherProtocolDaemon;
  // the host's session mirror catches up over the daemon's frozen mirror.sync
  readonly syncMirror: () => Promise<void>;
  // the update changed (appeared, counted another run, waits, switches, went)
  readonly changed: () => void;
  // a connect of this app's own version, once the old daemon is gone
  readonly reconnect: () => void;
  // the flow is over: its daemon went with no switch asked, or the connect after the switch failed
  readonly ended: () => void;
  // Switch now's confirmation; true: switch
  readonly confirm: (listing: SwitchListing) => Promise<boolean>;
  // this app's version
  readonly targetVersion: string;
  // how often the read-only chats and the update follow the old daemon: the frozen commands carry no events
  readonly pollMs: number;
  // when this app first found the daemon waiting to switch (epoch ms), as the authority's state keeps it across relaunches
  readonly waitingSince: number;
  // settles with the epoch ms the daemon must switch by (requiredDeadline), when this flow switches it with no confirmation
  readonly required?: Promise<{ readonly deadline: number } | undefined>;
  // a switch this flow sent, as its command went out; undefined: the daemon refused it
  readonly switched?: (result: SwitchResult | undefined) => void;
  readonly log: (line: string) => void;
}

// The update in another phase of its switch; an outdated app's update has no switch, so it keeps its own.
function inPhase(update: HostUpdate, phase: HostUpdate['phase']): HostUpdate {
  return update.phase === 'appOutdated' || phase === 'appOutdated' ? update : { ...update, phase };
}

// docs/invariants.md "An updated app never stops a busy daemon of another build" and "A pending switch waits only on running
// agents ...". Its first update carries its listed runs and its requirement.
export function followOtherProtocolDaemon(deps: OtherProtocolHostDeps): PendingSwitch {
  const { daemon, log } = deps;
  const outdated = newerThanApp(deps.targetVersion, daemon.serverVersion);
  const handsOver = daemon.frozenFeatures.includes(HAND_OVER_FEATURE);
  let current: HostUpdate | undefined;
  let timer: NodeJS.Timeout | undefined;
  let open = true;
  let over = false;
  let required: { readonly deadline: number; countdown: boolean } | undefined;
  const deadlines: WallTimer[] = [];
  // the deadline's switch that failed, sent again after pollMs
  let retry: WallTimer | undefined;

  const publish = (next: HostUpdate): void => {
    if (JSON.stringify(next) === JSON.stringify(current)) return;
    current = next;
    deps.changed();
  };
  const requiredNow = (): Pick<HostUpdate, 'required'> => (required !== undefined ? { required: { deadline: required.deadline, countdown: required.countdown } } : {});
  // The switch itself, which the caller confirmed or the deadline forces.
  const send = async (runs: readonly Run[], forced: boolean, chosen?: true): Promise<void> => {
    log(`[update] switching from the daemon of ${daemon.serverVersion} ${forced ? 'at its deadline' : 'now'}: ${stopping(runs, handsOver)} runs stop`);
    const before = current?.phase;
    if (current) publish(inPhase(current, 'switching'));
    const { runningAgents, runningTerminals } = counts(runs);
    deps.switched?.({ agentsStopped: runningAgents, terminalsClosed: handsOver ? 0 : runningTerminals, ...(forced ? { forcedAt: Date.now() } : {}), ...(chosen ? { chosen } : {}) });
    try {
      await (handsOver ? daemon.control.request('handOver', { when: 'now' }) : daemon.control.request('shutdownNow', {}));
    } catch (err) {
      // a connection still open got the daemon's refusal, so nothing switched; a closed one may have switched it
      if (open) {
        deps.switched?.(undefined);
        if (current && before !== undefined) publish(inPhase(current, before));
      }
      throw err;
    }
  };
  const atDeadline = (): void => {
    if (!open || current?.phase === 'switching') return;
    daemon.control.request('listRuns', {}).then(({ runs }) => (open ? send(runs, true) : undefined)).catch((err: unknown) => {
      log(`[update] switching from the daemon of ${daemon.serverVersion} at its deadline failed: ${message(err)}`);
      if (!open) return;
      retry?.cancel();
      retry = at(Date.now() + deps.pollMs, atDeadline);
    });
  };
  const requirement = (deps.required ?? Promise.resolve(undefined)).then((found) => {
    if (found === undefined || outdated || !open) return;
    required = { deadline: found.deadline, countdown: Date.now() >= found.deadline - COUNTDOWN_MS };
    if (!required.countdown) {
      deadlines.push(at(found.deadline - COUNTDOWN_MS, () => {
        if (required) required.countdown = true;
        if (current) publish({ ...current, ...requiredNow() });
      }));
    }
    deadlines.push(at(found.deadline, atDeadline));
    if (current) publish({ ...current, ...requiredNow() });
  }, (err: unknown) => log(`[update] reading the requirement for the daemon of ${daemon.serverVersion} failed: ${message(err)}`));
  const end = (): void => {
    over = true;
    current = undefined;
    deps.ended();
  };
  const refuseOutdated = (): void => {
    if (outdated) throw new Error(`The daemon of ${daemon.serverVersion} is newer than this app; update this app to use it`);
  };
  const follow = async (): Promise<void> => {
    const runs = (await daemon.control.request('listRuns', {})).runs;
    await requirement;
    if (!open) return;
    const { runningAgents, runningTerminals } = counts(runs);
    log(`[update] the daemon of ${daemon.serverVersion} runs ${runningAgents} chats and ${runningTerminals} terminals`);
    if (!outdated && stopping(runs, handsOver) === 0 && (current === undefined || (required !== undefined && current.phase !== 'switching'))) {
      log(`[update] the daemon of ${daemon.serverVersion} (protocol ${daemon.protocolVersion}) runs ${handsOver ? 'no chat' : 'nothing'}; stopping it`);
      await (handsOver ? daemon.control.request('handOver', { when: 'now' }) : daemon.control.request('shutdownNow', {}));
      return;
    }
    publish({
      source: 'otherProtocol',
      ...(outdated ? { phase: 'appOutdated' as const, outdated: 'runs' as const } : { phase: current && current.phase !== 'appOutdated' ? current.phase : 'offer' }),
      serverVersion: appVersionOf(daemon.serverVersion),
      targetVersion: deps.targetVersion,
      runningAgents,
      runningTerminals,
      terminalsSurvive: handsOver,
      waitingSince: deps.waitingSince,
      ...requiredNow(),
    });
    await deps.syncMirror();
  };
  const poll = (): void => {
    follow().catch((err: unknown) => log(`[update] following the daemon of ${daemon.serverVersion} failed: ${message(err)}`)).finally(() => {
      if (open) timer = setTimeout(poll, deps.pollMs);
    });
  };
  const next = nextConnect(() => {
    log(`[update] the connect after the daemon of ${daemon.serverVersion} went failed; the switch is over`);
    end();
    deps.changed();
  }, () => false);
  const closed = daemon.onClose((reason) => {
    if (!open) return;
    open = false;
    clearTimeout(timer);
    retry?.cancel();
    for (const scheduled of deadlines) scheduled.cancel();
    const asked = current?.phase === 'waiting' || current?.phase === 'switching';
    log(`[update] the daemon of ${daemon.serverVersion} closed its connection (${reason}); connecting ${asked ? 'after its exit' : 'again'}`);
    if (asked && current) {
      current = inPhase(current, 'switching');
      next.gone();
    } else {
      end();
    }
    // before changed, so the host never reads offline
    deps.reconnect();
    deps.changed();
  });
  poll();

  return {
    update: () => current,
    switchWhenIdle: async () => {
      refuseOutdated();
      await (handsOver ? daemon.control.request('handOver', { when: 'idle' }) : daemon.control.request('shutdownWhenIdle', {}));
      if (current) publish(inPhase(current, 'waiting'));
    },
    switchNow: async (options) => {
      refuseOutdated();
      const runs = (await daemon.control.request('listRuns', {})).runs;
      if (!options?.confirmed && !(await deps.confirm(listingOf(runs, [], 0, handsOver)))) return false;
      await send(runs, false, options?.confirmed ? undefined : true);
      return true;
    },
    following: () => (open ? daemon : undefined),
    stateChanged: (state) => {
      if (!over) next.stateChanged(state);
    },
    resumed: () => {
      for (const scheduled of [...deadlines, ...(retry ? [retry] : [])]) scheduled.rearm();
    },
    dispose: () => {
      over = true;
      open = false;
      clearTimeout(timer);
      retry?.cancel();
      for (const scheduled of deadlines) scheduled.cancel();
      closed.dispose();
      daemon.close('the app let go of the old daemon');
    },
  };
}

/**
 * The host's security floor is above this app, so its bridge started no server: nothing runs and nothing can switch, and the
 * host shows that this app must update, with the floor as the version it needs. It lasts until a connect settles on a daemon.
 */
export function belowFloorSwitch(floor: string, targetVersion: string): PendingSwitch {
  const update: HostUpdate = { source: 'otherProtocol', phase: 'appOutdated', outdated: 'floor', serverVersion: floor, targetVersion, runningAgents: 0, runningTerminals: 0, terminalsSurvive: true, waitingSince: Date.now() };
  const refuse = async (): Promise<never> => {
    throw new Error(`The host needs Damocles ${floor} or later; update this app to use it`);
  };
  return { update: () => update, switchWhenIdle: refuse, switchNow: refuse, following: () => undefined, stateChanged: () => undefined, resumed: () => undefined, dispose: () => undefined };
}

/**
 * Each authority's pending switch. A new one replaces the one before; Forget host and the quit let go of theirs before the
 * connections close, or a closing old daemon would start a connect.
 */
export class PendingSwitches {
  private readonly flows = new Map<string, PendingSwitch>();

  get(authorityKey: string): PendingSwitch | undefined {
    return this.flows.get(authorityKey);
  }

  has(authorityKey: string): boolean {
    return this.flows.has(authorityKey);
  }

  /** start's flow becomes the authority's; it calls ended once it is over, which lets go of it. */
  follow(authorityKey: string, start: (ended: () => void) => PendingSwitch): void {
    this.forget(authorityKey);
    // a flow over before start returned is never kept
    const slot: { flow?: PendingSwitch; over: boolean } = { over: false };
    slot.flow = start(() => {
      slot.over = true;
      if (slot.flow !== undefined && this.flows.get(authorityKey) === slot.flow) this.flows.delete(authorityKey);
    });
    if (!slot.over) this.flows.set(authorityKey, slot.flow);
  }

  stateChanged(authorityKey: string, state: ProjectConnection): void {
    this.flows.get(authorityKey)?.stateChanged(state);
  }

  resumed(): void {
    for (const flow of this.flows.values()) flow.resumed();
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
