// A pending server switch's notices (docs/invariants.md "Remote daemon and wire", the update flow): reminders while it waits,
// the countdown of a required one, what a switch stopped, and Switch now's confirmation. The update strip shows the whole time;
// these only remind.
import { appVersionOf } from '../../../shared/app-version';
import type { HostUpdate } from '../../../shared/host-update';
import type { NoticeSeverity } from '../../preload/notifications';
import { COUNTDOWN_MS, type SwitchListing, type SwitchResult } from './app-update-flow';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
// a switch that is not required reminds once it waited this long, then at most this often
const FIRST_REMINDER_MS: number = HOUR;
const REMINDER_EVERY_MS: number = 4 * HOUR;
// a fresh connection reminds again, at most once in this long across reconnects
export const CONNECT_REMINDER_GAP_MS: number = 15 * MINUTE;
// a required switch reminds once more this long before its deadline
const DEADLINE_REMINDER_MS: number = HOUR;

type Pending = Pick<HostUpdate, 'phase' | 'waitingSince' | 'required'>;

const waits = (update: Pending): boolean => update.phase === 'offer' || update.phase === 'waiting';

// by the clock too: a timer that slept can fire after the countdown started and before the flow's own timer published it
const countsDown = (required: NonNullable<Pending['required']>, now: number): boolean => required.countdown || required.deadline - now <= COUNTDOWN_MS;

/**
 * When the pending switch's next reminder is due (epoch ms), `last` being when its host last showed one; undefined when none
 * is. Not required: FIRST_REMINDER_MS after it started waiting, then every REMINDER_EVERY_MS. Required: once seen, every
 * REMINDER_EVERY_MS and DEADLINE_REMINDER_MS before the deadline, and none once the countdown runs.
 */
export function nextReminderAt(update: Pending, last: number | undefined): number | undefined {
  if (!waits(update)) return undefined;
  const { required } = update;
  if (required === undefined) return last === undefined ? update.waitingSince + FIRST_REMINDER_MS : last + REMINDER_EVERY_MS;
  if (required.countdown) return undefined;
  if (last === undefined) return update.waitingSince;
  const beforeDeadline = required.deadline - DEADLINE_REMINDER_MS;
  return last < beforeDeadline ? Math.min(last + REMINDER_EVERY_MS, beforeDeadline) : last + REMINDER_EVERY_MS;
}

type Translate = (message: string, ...args: string[]) => string;

export interface NoticeText {
  readonly severity: NoticeSeverity;
  readonly title: string;
  readonly message: string;
}

export interface NoticeWording {
  readonly t: Translate;
  readonly hostName: string;
  // epoch ms as the locale's short time, e.g. 16:30
  readonly time: (at: number) => string;
  readonly now: number;
}

// "in 3 h", or minutes under one hour: more than COUNTDOWN_MS, since a reminder never shows once countsDown
function timeLeft(ms: number, t: Translate): string {
  if (ms >= HOUR) {
    const hours = Math.round(ms / HOUR);
    return hours === 1 ? t('in 1 h') : t('in {0} h', String(hours));
  }
  return t('in {0} minutes', String(Math.ceil(ms / MINUTE)));
}

// a legacy daemon's terminals end with it
function terminalsClose(update: HostUpdate, t: Translate): string {
  if (update.terminalsSurvive || update.runningTerminals === 0) return '';
  return ` ${update.runningTerminals === 1 ? t('Its terminal closes too.') : t('Its {0} terminals close too.', String(update.runningTerminals))}`;
}

// the pending damocles --wait requests, which the switch answers not connected
function cliWaitsStop(update: HostUpdate, t: Translate): string {
  const waits = update.cliWaits ?? 0;
  if (waits === 0) return '';
  return ` ${waits === 1 ? t('1 terminal is waiting for a file and stops waiting then.') : t('{0} terminals are waiting for files and stop waiting then.', String(waits))}`;
}

/** The reminder toast of a pending switch (design "Remote server update states", S4): what it waits for, or its deadline. */
export function reminderText(update: HostUpdate, { t, hostName, time, now }: NoticeWording): NoticeText {
  const title = t('{0} still runs Damocles {1}', hostName, update.serverVersion);
  const to = update.targetVersion;
  const agents = update.runningAgents;
  const waits = update.cliWaits ?? 0;
  const devices = update.otherDevices ?? 0;
  if (update.required !== undefined) {
    const lead = t('It must switch to Damocles {0} by {1}, {2}.', to, time(update.required.deadline), timeLeft(update.required.deadline - now, t));
    const stops = agents === 0 ? '' : ` ${agents === 1 ? t('1 agent is running and stops then.') : t('{0} agents are running and stop then.', String(agents))}`;
    return { severity: 'warning', title, message: `${lead}${stops}${cliWaitsStop(update, t)}${terminalsClose(update, t)}` };
  }
  const waitsToo = agents === 0 || waits === 0 ? '' : ` ${waits === 1 ? t('1 terminal is waiting for a file.') : t('{0} terminals are waiting for files.', String(waits))}`;
  const waiting = agents > 0
    ? `${agents === 1 ? t('Damocles {0} waits for 1 agent to finish.', to) : t('Damocles {0} waits for {1} agents to finish.', to, String(agents))}${waitsToo}`
    : waits > 0
      ? (waits === 1 ? t('Damocles {0} waits for you to close the file a terminal is waiting for.', to) : t('Damocles {0} waits for you to close the files {1} terminals are waiting for.', to, String(waits)))
      : update.drainEndsAt !== undefined
        ? `${t('It switches to Damocles {0} at {1}.', to, time(update.drainEndsAt))} ${devices === 1 ? t('1 other device reconnects then.') : t('{0} other devices reconnect then.', String(devices))}`
        : devices > 0 && !update.terminalsSurvive
          ? (devices === 1 ? t('Damocles {0} waits for 1 other device to disconnect.', to) : t('Damocles {0} waits for {1} other devices to disconnect.', to, String(devices)))
          : t('Damocles {0} is ready.', to);
  return { severity: 'info', title, message: `${waiting}${terminalsClose(update, t)}` };
}

/** The sticky countdown notice; its title ends with the time left, which the toast appends from the deadline. */
export function countdownText(update: HostUpdate, { t, hostName }: NoticeWording): NoticeText {
  const agents = update.runningAgents;
  const stops = agents === 0 ? '' : ` ${agents === 1 ? t('1 agent stops then; its chat is kept.') : t('{0} agents stop then; their chats are kept.', String(agents))}`;
  return { severity: 'error', title: t('{0} switches in', hostName), message: `${t('Damocles {0} is required.', update.targetVersion)}${stops}${cliWaitsStop(update, t)}${terminalsClose(update, t)}` };
}

/** What a switch this app sent stopped, once the host runs `targetVersion`; undefined when it stopped nothing and nobody chose or forced it. */
export function afterSwitchText(result: SwitchResult, targetVersion: string, { t, hostName, time }: NoticeWording): NoticeText | undefined {
  const parts = [
    ...(result.forcedAt !== undefined ? [t('The required update ran at {0}.', time(result.forcedAt))] : []),
    ...(result.agentsStopped === 0 ? [] : [result.agentsStopped === 1 ? t('1 agent stopped; its chat is kept.') : t('{0} agents stopped; their chats are kept.', String(result.agentsStopped))]),
    ...(!result.cliWaitsEnded ? [] : [result.cliWaitsEnded === 1 ? t('1 terminal stopped waiting for its file.') : t('{0} terminals stopped waiting for their files.', String(result.cliWaitsEnded))]),
    ...(result.terminalsClosed === 0 ? [] : [result.terminalsClosed === 1 ? t('1 terminal closed.') : t('{0} terminals closed.', String(result.terminalsClosed))]),
  ];
  if (parts.length === 0 && !result.chosen) return undefined;
  return { severity: result.forcedAt !== undefined ? 'warning' : 'info', title: t('{0} now runs Damocles {1}', hostName, targetVersion), message: parts.join(' ') };
}

/** Another device's switch of the host to `serverVersion`, and how many of this device's agents it stopped. */
export function handedOverText(deviceName: string, agentsStopped: number, serverVersion: string, { t, hostName }: Pick<NoticeWording, 't' | 'hostName'>): NoticeText {
  const stopped = agentsStopped === 0 ? '' : ` ${agentsStopped === 1 ? t('1 of your agents stopped; its chat is kept.') : t('{0} of your agents stopped; their chats are kept.', String(agentsStopped))}`;
  return { severity: 'info', title: t('{0} now runs Damocles {1}', hostName, appVersionOf(serverVersion)), message: `${t('{0} switched it.', deviceName)}${stopped}` };
}

/**
 * Switch now's confirmation (design "Remote server update states", S3): the agents that stop, the terminals that close or keep
 * running, the terminals whose damocles --wait fails, the other devices that disconnect; the preview lists the agents, the
 * waited-for files and the terminals that close.
 */
export function switchNowText(listing: SwitchListing, targetVersion: string, { t, hostName }: Pick<NoticeWording, 't' | 'hostName'>): { readonly message: string; readonly detail: string; readonly preview: readonly string[] } {
  const agents = listing.agents.length;
  const terminals = listing.terminals.length;
  const waits = listing.cliWaits.length;
  const devices = listing.otherDevices;
  const detail = [
    agents === 0 ? t('No agent is running.') : agents === 1
      ? t('This agent stops now. Its chat keeps the transcript, and you can continue it after the switch.')
      : t('These {0} agents stop now. Their chats keep the transcript, and you can continue them after the switch.', String(agents)),
    ...(terminals === 0 ? [] : listing.terminalsSurvive ? [t('Terminals keep running.')] : [terminals === 1 ? t('This terminal closes, and what runs in it stops.') : t('These {0} terminals close, and what runs in them stops.', String(terminals))]),
    ...(waits === 0 ? [] : [waits === 1
      ? t('A terminal is waiting for you to close a file. Its command stops waiting and fails; the file stays open.')
      : t('{0} terminals are waiting for you to close files. Their commands stop waiting and fail; the files stay open.', String(waits))]),
    ...(devices === 0 ? [] : listing.terminalsSurvive
      ? [devices === 1 ? t('1 other device connected to {0} disconnects, then reconnects to Damocles {1}.', hostName, targetVersion) : t('{0} other devices connected to {1} disconnect, then reconnect to Damocles {2}.', String(devices), hostName, targetVersion)]
      : [devices === 1 ? t('1 other device connected to {0} disconnects.', hostName) : t('{0} other devices connected to {1} disconnect.', String(devices), hostName)]),
  ];
  const preview = [
    ...listing.agents.map((title) => t('Agent: {0}', title === '' ? t('New conversation') : title)),
    ...listing.cliWaits.map((files) => t('Waiting for file: {0}', files)),
    ...(listing.terminalsSurvive ? [] : listing.terminals.map((name) => t('Terminal: {0}', name))),
  ];
  return { message: t('Switch {0} to Damocles {1} now?', hostName, targetVersion), detail: detail.join(' '), preview };
}

export interface SwitchRemindersDeps {
  // the authority's wording as of now
  readonly wording: (authority: string) => NoticeWording;
  // a reminder toast, which follows the popup policy
  readonly remind: (authority: string, notice: NoticeText) => void;
  // the sticky, time-sensitive countdown to `deadline`, until withdrawn
  readonly countDown: (authority: string, notice: NoticeText, deadline: number) => { withdraw(): void };
  // what a switch stopped; forced: time-sensitive
  readonly switched: (authority: string, notice: NoticeText, forced: boolean) => void;
  readonly log: (line: string) => void;
}

export interface SwitchReminders {
  // the authority's pending switch changed; undefined: none is pending
  changed(authority: string, update: HostUpdate | undefined): void;
  // a fresh connection (not a resume) settled, after changed told what it found pending; pendingBefore: the authority's state
  // kept that switch from an earlier connection, of this run or one before, so it reminds, at most once per CONNECT_REMINDER_GAP_MS
  connected(authority: string, pendingBefore: boolean): void;
  // the countdown's notice was answered and what its answer started is over; it shows again while the countdown still runs
  countdownAnswered(authority: string): void;
  // this app sent the authority's switch; undefined: the daemon refused it
  switchSent(authority: string, result: SwitchResult | undefined, targetVersion: string): void;
  // the connect after a switch settled; current: on this app's version
  settled(authority: string, current: boolean): void;
  // this app sent or follows the switch of the authority's daemon of serverVersion
  following(authority: string, serverVersion: string): void;
  // another device's switch ends the authority's daemon of serverVersion (control.handingOver), stopping agentsStopped of this
  // device's agents
  handingOver(authority: string, ending: HandingOver): void;
  // a fresh connection reached the authority's daemon of serverVersion, before it is published: true when a switch this app sent
  // or followed, or another device's, brought another version, whose own notice tells the restart; the other device's shows here
  arrived(authority: string, serverVersion: string): boolean;
  // Forget host
  forget(authority: string): void;
  // the computer resumed from sleep: every schedule reads the wall clock again
  resumed(): void;
  dispose(): void;
}

interface Tracked {
  update?: HostUpdate | undefined;
  // when the host last showed a reminder, kept across its switches
  last?: number;
  // a fresh connection's reminder is due then
  connectDue?: number | undefined;
  timer?: NodeJS.Timeout | undefined;
  sticky?: { withdraw(): void } | undefined;
  sent?: { readonly result: SwitchResult; readonly targetVersion: string } | undefined;
  // the server version of the daemon whose switch this app sent or follows
  switchingFrom?: string | undefined;
  handingOver?: HandingOver | undefined;
}

export interface HandingOver {
  readonly deviceName: string;
  readonly agentsStopped: number;
  readonly serverVersion: string;
}

/** Each authority's reminders, one at a time: the timer of the next one, the sticky countdown and the result of a sent switch. */
export function createSwitchReminders(deps: SwitchRemindersDeps): SwitchReminders {
  const tracked = new Map<string, Tracked>();
  const of = (authority: string): Tracked => {
    let state = tracked.get(authority);
    if (!state) {
      state = {};
      tracked.set(authority, state);
    }
    return state;
  };
  const quiet = (state: Tracked): void => {
    clearTimeout(state.timer);
    state.timer = undefined;
  };
  const withdraw = (state: Tracked): void => {
    state.sticky?.withdraw();
    state.sticky = undefined;
  };
  const arm = (authority: string): void => {
    const state = of(authority);
    quiet(state);
    const { update } = state;
    if (update === undefined || !waits(update)) {
      state.connectDue = undefined;
      return withdraw(state);
    }
    const counting = update.required !== undefined && countsDown(update.required, Date.now());
    if (!counting) withdraw(state);
    if (counting && state.sticky !== undefined) return;
    const due = counting ? Date.now() : Math.min(nextReminderAt(update, state.last) ?? Infinity, state.connectDue ?? Infinity);
    if (due === Infinity) return;
    state.timer = setTimeout(() => {
      state.timer = undefined;
      try {
        show(authority, state, due);
      } catch (err) {
        deps.log(`[update] ${authority}: showing the notice of the pending switch failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }, Math.max(0, due - Date.now()));
  };
  const show = (authority: string, state: Tracked, due: number): void => {
    const { update } = state;
    if (update === undefined || !waits(update)) return;
    const wording = deps.wording(authority);
    if (update.required !== undefined && countsDown(update.required, wording.now)) {
      deps.log(`[update] ${authority}: the countdown to the required switch shows`);
      state.sticky = deps.countDown(authority, countdownText(update, wording), update.required.deadline);
      return;
    }
    const notice = reminderText(update, wording);
    // the slot it was due for: a timer fires a few ms early by Date.now(), which would leave that slot due again
    state.last = Math.max(wording.now, due);
    state.connectDue = undefined;
    deps.log(`[update] ${authority}: reminding of the pending switch`);
    deps.remind(authority, notice);
    arm(authority);
  };

  return {
    changed: (authority, update) => {
      of(authority).update = update;
      arm(authority);
    },
    connected: (authority, pendingBefore) => {
      const state = of(authority);
      const now = Date.now();
      // the connection that first finds the switch pending shows the strip alone
      if (!pendingBefore || state.update === undefined || state.update.required !== undefined) return;
      if (state.last !== undefined && now - state.last < CONNECT_REMINDER_GAP_MS) return;
      state.connectDue = now;
      arm(authority);
    },
    countdownAnswered: (authority) => {
      of(authority).sticky = undefined;
      arm(authority);
    },
    switchSent: (authority, result, targetVersion) => {
      of(authority).sent = result === undefined ? undefined : { result, targetVersion };
    },
    settled: (authority, current) => {
      const state = of(authority);
      const { sent } = state;
      state.sent = undefined;
      if (sent === undefined || !current) return;
      const notice = afterSwitchText(sent.result, sent.targetVersion, deps.wording(authority));
      if (notice) deps.switched(authority, notice, sent.result.forcedAt !== undefined);
    },
    following: (authority, serverVersion) => {
      const state = of(authority);
      state.switchingFrom = serverVersion;
      state.handingOver = undefined;
    },
    handingOver: (authority, ending) => {
      of(authority).handingOver = ending;
    },
    arrived: (authority, serverVersion) => {
      const state = of(authority);
      const { switchingFrom, handingOver } = state;
      state.switchingFrom = undefined;
      state.handingOver = undefined;
      // this app's own switch tells its result through settled, or nothing
      if (switchingFrom !== undefined) return switchingFrom !== serverVersion;
      if (handingOver === undefined || handingOver.serverVersion === serverVersion) return false;
      deps.log(`[update] ${authority}: ${handingOver.deviceName} switched the host from ${handingOver.serverVersion} to ${serverVersion}`);
      deps.switched(authority, handedOverText(handingOver.deviceName, handingOver.agentsStopped, serverVersion, deps.wording(authority)), false);
      return true;
    },
    forget: (authority) => {
      const state = tracked.get(authority);
      if (!state) return;
      quiet(state);
      withdraw(state);
      tracked.delete(authority);
    },
    resumed: () => {
      for (const authority of tracked.keys()) arm(authority);
    },
    dispose: () => {
      for (const state of tracked.values()) {
        quiet(state);
        withdraw(state);
      }
      tracked.clear();
    },
  };
}
