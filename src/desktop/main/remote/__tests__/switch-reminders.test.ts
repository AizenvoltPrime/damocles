import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HostUpdate } from '../../../../shared/host-update';
import { afterSwitchText, CONNECT_REMINDER_GAP_MS, countdownText, createSwitchReminders, handedOverText, nextReminderAt, reminderText, switchNowText, type NoticeText, type NoticeWording } from '../switch-reminders';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const HOST = 'ssh+prod-1';

// fields names a phase and its outdated together
const waiting = (fields: Partial<HostUpdate> = {}): HostUpdate => ({
  source: 'compatible', phase: 'waiting', serverVersion: '3.7.0', targetVersion: '3.9.0', runningAgents: 2, runningTerminals: 3, terminalsSurvive: true, otherDevices: 1, waitingSince: 0, ...fields,
}) as HostUpdate;

const english = (message: string, ...args: string[]): string => message.replace(/\{(\d)\}/g, (_match, index: string) => args[Number(index)]!);
// a fixed clock face, whatever the machine's time zone
const time = (at: number): string => `${String(Math.floor(at / HOUR) % 24).padStart(2, '0')}:${String(Math.floor(at / MINUTE) % 60).padStart(2, '0')}`;
const wording = (now = 0): NoticeWording => ({ t: english, hostName: 'prod-1', time, now });

describe('the reminder schedule', () => {
  it('reminds of a switch that is not required after 1 hour of waiting, then every 4 hours', () => {
    expect(nextReminderAt(waiting({ waitingSince: 1000 }), undefined)).toBe(1000 + HOUR);
    expect(nextReminderAt(waiting({ phase: 'offer', source: 'otherProtocol' }), undefined)).toBe(HOUR);
    expect(nextReminderAt(waiting(), HOUR)).toBe(5 * HOUR);
    // a host reminded before this switch started waiting is not reminded again within 4 hours
    expect(nextReminderAt(waiting({ waitingSince: 6 * HOUR }), 5 * HOUR)).toBe(9 * HOUR);
  });

  it('reminds of a required switch once seen, every 4 hours and 1 hour before the deadline, and never once the countdown runs', () => {
    const required = waiting({ required: { deadline: 24 * HOUR, countdown: false } });
    expect(nextReminderAt(required, undefined)).toBe(0);
    expect(nextReminderAt(required, 0)).toBe(4 * HOUR);
    expect(nextReminderAt(required, 20 * HOUR)).toBe(23 * HOUR);
    expect(nextReminderAt(required, 23 * HOUR)).toBe(27 * HOUR);
    expect(nextReminderAt(waiting({ required: { deadline: 24 * HOUR, countdown: true } }), undefined)).toBeUndefined();
  });

  it('reminds of nothing while the host switches or this app is outdated', () => {
    expect(nextReminderAt(waiting({ phase: 'switching' }), undefined)).toBeUndefined();
    expect(nextReminderAt(waiting({ phase: 'appOutdated', outdated: 'runs' }), undefined)).toBeUndefined();
  });
});

describe('the notices\' wording', () => {
  it('a reminder names what the switch waits for: agents, else the drain\'s end, else a legacy daemon\'s other devices', () => {
    expect(reminderText(waiting(), wording())).toEqual({ severity: 'info', title: 'prod-1 still runs Damocles 3.7.0', message: 'Damocles 3.9.0 waits for 2 agents to finish.' });
    expect(reminderText(waiting({ runningAgents: 1 }), wording()).message).toBe('Damocles 3.9.0 waits for 1 agent to finish.');
    expect(reminderText(waiting({ runningAgents: 0, drainEndsAt: 14 * HOUR + 5 * MINUTE }), wording()).message).toBe('It switches to Damocles 3.9.0 at 14:05. 1 other device reconnects then.');
    expect(reminderText(waiting({ runningAgents: 0, otherDevices: 2, drainEndsAt: 14 * HOUR + 5 * MINUTE }), wording()).message).toBe('It switches to Damocles 3.9.0 at 14:05. 2 other devices reconnect then.');
    expect(reminderText(waiting({ runningAgents: 0, runningTerminals: 0, terminalsSurvive: false }), wording()).message).toBe('Damocles 3.9.0 waits for 1 other device to disconnect.');
    expect(reminderText(waiting({ runningAgents: 0, otherDevices: 3, terminalsSurvive: false }), wording()).message).toBe('Damocles 3.9.0 waits for 3 other devices to disconnect. Its 3 terminals close too.');
    expect(reminderText(waiting({ runningAgents: 0, otherDevices: 0 }), wording()).message).toBe('Damocles 3.9.0 is ready.');
    expect(reminderText(waiting({ runningTerminals: 1, terminalsSurvive: false }), wording()).message).toBe('Damocles 3.9.0 waits for 2 agents to finish. Its terminal closes too.');
  });

  it('a required reminder is a warning with the deadline, in whole hours or in minutes under one hour', () => {
    const required = waiting({ required: { deadline: 16 * HOUR + 30 * MINUTE, countdown: false } });
    expect(reminderText(required, wording(13 * HOUR + 30 * MINUTE))).toEqual({ severity: 'warning', title: 'prod-1 still runs Damocles 3.7.0', message: 'It must switch to Damocles 3.9.0 by 16:30, in 3 h. 2 agents are running and stop then.' });
    expect(reminderText({ ...required, runningAgents: 1 }, wording(15 * HOUR + 30 * MINUTE)).message).toBe('It must switch to Damocles 3.9.0 by 16:30, in 1 h. 1 agent is running and stops then.');
    expect(reminderText({ ...required, runningAgents: 0 }, wording(15 * HOUR + 45 * MINUTE)).message).toBe('It must switch to Damocles 3.9.0 by 16:30, in 45 minutes.');
    expect(reminderText({ ...required, runningAgents: 0, terminalsSurvive: false }, wording(16 * HOUR + 10 * MINUTE)).message).toBe('It must switch to Damocles 3.9.0 by 16:30, in 20 minutes. Its 3 terminals close too.');
  });

  it('the countdown is an error whose title the toast ends with the time left', () => {
    expect(countdownText(waiting({ required: { deadline: HOUR, countdown: true } }), wording())).toEqual({ severity: 'error', title: 'prod-1 switches in', message: 'Damocles 3.9.0 is required. 2 agents stop then; their chats are kept.' });
    expect(countdownText(waiting({ runningAgents: 1, runningTerminals: 1, terminalsSurvive: false }), wording()).message).toBe('Damocles 3.9.0 is required. 1 agent stops then; its chat is kept. Its terminal closes too.');
    expect(countdownText(waiting({ runningAgents: 0 }), wording()).message).toBe('Damocles 3.9.0 is required.');
  });

  it('the after-switch notice names what stopped, the forced one first when it ran, and is absent when nothing stopped', () => {
    expect(afterSwitchText({ agentsStopped: 2, terminalsClosed: 0 }, '3.9.0', wording())).toEqual({ severity: 'info', title: 'prod-1 now runs Damocles 3.9.0', message: '2 agents stopped; their chats are kept.' });
    expect(afterSwitchText({ agentsStopped: 1, terminalsClosed: 3, forcedAt: 16 * HOUR + 30 * MINUTE }, '3.9.0', wording())).toEqual({ severity: 'warning', title: 'prod-1 now runs Damocles 3.9.0', message: 'The required update ran at 16:30. 1 agent stopped; its chat is kept. 3 terminals closed.' });
    expect(afterSwitchText({ agentsStopped: 0, terminalsClosed: 1 }, '3.9.0', wording())?.message).toBe('1 terminal closed.');
    expect(afterSwitchText({ agentsStopped: 0, terminalsClosed: 0, forcedAt: 0 }, '3.9.0', wording())?.message).toBe('The required update ran at 00:00.');
    // a switch nobody asked for that stopped nothing says nothing; one the user chose always says it ran
    expect(afterSwitchText({ agentsStopped: 0, terminalsClosed: 0 }, '3.9.0', wording())).toBeUndefined();
    expect(afterSwitchText({ agentsStopped: 0, terminalsClosed: 0, chosen: true }, '3.9.0', wording())).toEqual({ severity: 'info', title: 'prod-1 now runs Damocles 3.9.0', message: '' });
  });
});

describe('the notice of another device\'s switch', () => {
  it('names the device that switched the host, and how many of this device\'s agents stopped', () => {
    expect(handedOverText('DESKTOP-A', 0, '3.9.0+bbbbbbbbbbbb', wording())).toEqual({ severity: 'info', title: 'prod-1 now runs Damocles 3.9.0', message: 'DESKTOP-A switched it.' });
    expect(handedOverText('DESKTOP-A', 1, '3.9.0', wording()).message).toBe('DESKTOP-A switched it. 1 of your agents stopped; its chat is kept.');
    expect(handedOverText('DESKTOP-A', 3, '3.9.0', wording()).message).toBe('DESKTOP-A switched it. 3 of your agents stopped; their chats are kept.');
  });
});

describe('the notices\' wording of pending damocles --wait requests', () => {
  it('a reminder names the terminals waiting for files, alone or after the agents', () => {
    expect(reminderText(waiting({ runningAgents: 0, cliWaits: 1 }), wording()).message).toBe('Damocles 3.9.0 waits for you to close the file a terminal is waiting for.');
    expect(reminderText(waiting({ runningAgents: 0, cliWaits: 2 }), wording()).message).toBe('Damocles 3.9.0 waits for you to close the files 2 terminals are waiting for.');
    expect(reminderText(waiting({ runningAgents: 1, cliWaits: 1 }), wording()).message).toBe('Damocles 3.9.0 waits for 1 agent to finish. 1 terminal is waiting for a file.');
    expect(reminderText(waiting({ runningAgents: 1, cliWaits: 3 }), wording()).message).toBe('Damocles 3.9.0 waits for 1 agent to finish. 3 terminals are waiting for files.');
  });

  it('a required reminder and the countdown say the terminals stop waiting then, and the after-switch notice that they did', () => {
    const required = waiting({ runningAgents: 1, cliWaits: 1, required: { deadline: 16 * HOUR + 30 * MINUTE, countdown: false } });
    expect(reminderText(required, wording(13 * HOUR + 30 * MINUTE)).message).toBe('It must switch to Damocles 3.9.0 by 16:30, in 3 h. 1 agent is running and stops then. 1 terminal is waiting for a file and stops waiting then.');
    expect(reminderText({ ...required, runningAgents: 0, cliWaits: 2 }, wording(13 * HOUR + 30 * MINUTE)).message).toBe('It must switch to Damocles 3.9.0 by 16:30, in 3 h. 2 terminals are waiting for files and stop waiting then.');
    expect(countdownText({ ...required, runningAgents: 0 }, wording()).message).toBe('Damocles 3.9.0 is required. 1 terminal is waiting for a file and stops waiting then.');
    expect(afterSwitchText({ agentsStopped: 1, terminalsClosed: 0, cliWaitsEnded: 1 }, '3.9.0', wording())?.message).toBe('1 agent stopped; its chat is kept. 1 terminal stopped waiting for its file.');
    expect(afterSwitchText({ agentsStopped: 0, terminalsClosed: 0, cliWaitsEnded: 2 }, '3.9.0', wording())?.message).toBe('2 terminals stopped waiting for their files.');
  });

  it('Switch now\'s confirmation lists the terminals waiting for files among what stops', () => {
    const one = switchNowText({ agents: ['Fix the parser'], terminals: ['bash'], cliWaits: ['COMMIT_EDITMSG'], otherDevices: 0, terminalsSurvive: true }, '3.9.0', wording());
    expect(one).toEqual({
      message: 'Switch prod-1 to Damocles 3.9.0 now?',
      detail: 'This agent stops now. Its chat keeps the transcript, and you can continue it after the switch. Terminals keep running. A terminal is waiting for you to close a file. Its command stops waiting and fails; the file stays open.',
      preview: ['Agent: Fix the parser', 'Waiting for file: COMMIT_EDITMSG'],
    });
    const two = switchNowText({ agents: [], terminals: [], cliWaits: ['COMMIT_EDITMSG', 'old.txt, new.txt'], otherDevices: 0, terminalsSurvive: true }, '3.9.0', wording());
    expect(two.detail).toBe('No agent is running. 2 terminals are waiting for you to close files. Their commands stop waiting and fail; the files stay open.');
    expect(two.preview).toEqual(['Waiting for file: COMMIT_EDITMSG', 'Waiting for file: old.txt, new.txt']);
  });

  it('Switch now\'s confirmation names the other devices that disconnect', () => {
    const listing = { agents: [], terminals: [], cliWaits: [], terminalsSurvive: true };
    expect(switchNowText({ ...listing, otherDevices: 1 }, '3.9.0', wording()).detail).toBe('No agent is running. 1 other device connected to prod-1 disconnects, then reconnects to Damocles 3.9.0.');
    expect(switchNowText({ ...listing, otherDevices: 2 }, '3.9.0', wording()).detail).toBe('No agent is running. 2 other devices connected to prod-1 disconnect, then reconnect to Damocles 3.9.0.');
    expect(switchNowText({ ...listing, otherDevices: 1, terminalsSurvive: false }, '3.9.0', wording()).detail).toBe('No agent is running. 1 other device connected to prod-1 disconnects.');
    expect(switchNowText({ ...listing, otherDevices: 2, terminalsSurvive: false }, '3.9.0', wording()).detail).toBe('No agent is running. 2 other devices connected to prod-1 disconnect.');
  });
});

describe('the reminders of every host', () => {
  let reminded: Array<{ authority: string; notice: NoticeText; at: number }>;
  let countdowns: Array<{ authority: string; notice: NoticeText; deadline: number; withdrawn: boolean }>;
  let results: Array<{ authority: string; notice: NoticeText; forced: boolean }>;

  beforeEach(() => {
    vi.useFakeTimers({ now: 0 });
    reminded = [];
    countdowns = [];
    results = [];
  });
  afterEach(() => vi.useRealTimers());

  const reminders = () => createSwitchReminders({
    wording: () => wording(Date.now()),
    remind: (authority, notice) => reminded.push({ authority, notice, at: Date.now() }),
    countDown: (authority, notice, deadline) => {
      const shown = { authority, notice, deadline, withdrawn: false };
      countdowns.push(shown);
      return { withdraw: () => { shown.withdrawn = true; } };
    },
    switched: (authority, notice, forced) => results.push({ authority, notice, forced }),
    log: () => undefined,
  });
  const times = (): number[] => reminded.map((entry) => entry.at);

  it('remind of a waiting switch after 1 hour, then every 4 hours, with what it waits for then, until it switches', async () => {
    const all = reminders();
    all.changed(HOST, waiting());
    all.connected(HOST, false);
    await vi.advanceTimersByTimeAsync(HOUR - 1);
    expect(reminded).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(reminded).toEqual([{ authority: HOST, at: HOUR, notice: { severity: 'info', title: 'prod-1 still runs Damocles 3.7.0', message: 'Damocles 3.9.0 waits for 2 agents to finish.' } }]);
    all.changed(HOST, waiting({ runningAgents: 1 }));
    await vi.advanceTimersByTimeAsync(4 * HOUR);
    expect(times()).toEqual([HOUR, 5 * HOUR]);
    expect(reminded[1]!.notice.message).toBe('Damocles 3.9.0 waits for 1 agent to finish.');
    all.changed(HOST, waiting({ phase: 'switching' }));
    all.changed(HOST, undefined);
    await vi.advanceTimersByTimeAsync(24 * HOUR);
    expect(times()).toEqual([HOUR, 5 * HOUR]);
    all.dispose();
  });

  it('remind on a fresh connection that finds the switch still pending, at most once in 15 minutes across reconnects, and never on the first', async () => {
    const all = reminders();
    all.changed(HOST, waiting());
    all.connected(HOST, false);
    await vi.advanceTimersByTimeAsync(10 * MINUTE);
    expect(reminded).toEqual([]);
    // the same daemon, met again by a new connection
    all.changed(HOST, waiting());
    all.connected(HOST, true);
    await vi.advanceTimersByTimeAsync(0);
    expect(times()).toEqual([10 * MINUTE]);
    all.changed(HOST, waiting());
    all.connected(HOST, true);
    await vi.advanceTimersByTimeAsync(5 * MINUTE);
    expect(times()).toHaveLength(1);
    vi.setSystemTime(10 * MINUTE + CONNECT_REMINDER_GAP_MS);
    all.changed(HOST, waiting());
    all.connected(HOST, true);
    await vi.advanceTimersByTimeAsync(0);
    expect(times()).toHaveLength(2);
    // a connection that finds a new pending switch reminds only on its schedule
    all.changed(HOST, undefined);
    all.connected(HOST, false);
    await vi.advanceTimersByTimeAsync(HOUR);
    all.changed(HOST, waiting({ waitingSince: Date.now() }));
    all.connected(HOST, false);
    await vi.advanceTimersByTimeAsync(MINUTE);
    expect(times()).toHaveLength(2);
    all.dispose();
  });

  it('remind on the first connection after a relaunch when the switch was pending before it, once, on the stored schedule', async () => {
    vi.setSystemTime(10 * MINUTE);
    const all = reminders();
    // waiting since before this run, as the authority's state kept it
    all.changed(HOST, waiting({ waitingSince: 0 }));
    all.connected(HOST, true);
    await vi.advanceTimersByTimeAsync(0);
    expect(times()).toEqual([10 * MINUTE]);
    await vi.advanceTimersByTimeAsync(HOUR);
    expect(times()).toHaveLength(1);
    all.dispose();
  });

  // the first schedule's slot, an hour after the switch started waiting, passed long before this run
  it('remind once after a relaunch long after the switch started waiting, though its first slot and the connect\'s are both due', async () => {
    vi.setSystemTime(10 * HOUR);
    const all = reminders();
    all.changed(HOST, waiting({ waitingSince: 0 }));
    all.connected(HOST, true);
    await vi.advanceTimersByTimeAsync(0);
    expect(times()).toEqual([10 * HOUR]);
    await vi.advanceTimersByTimeAsync(4 * HOUR - 1);
    expect(times()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(times()).toEqual([10 * HOUR, 14 * HOUR]);
    all.dispose();
  });

  it('keep each host\'s reminders apart', async () => {
    const all = reminders();
    all.changed(HOST, waiting());
    all.changed('ssh+dev-1', waiting({ waitingSince: 30 * MINUTE }));
    await vi.advanceTimersByTimeAsync(90 * MINUTE);
    expect(reminded.map((entry) => [entry.authority, entry.at])).toEqual([[HOST, HOUR], ['ssh+dev-1', 90 * MINUTE]]);
    all.forget(HOST);
    await vi.advanceTimersByTimeAsync(4 * HOUR);
    expect(reminded.map((entry) => entry.authority)).toEqual([HOST, 'ssh+dev-1', 'ssh+dev-1']);
    all.dispose();
  });

  it('remind of a required switch once seen, every 4 hours and 1 hour before its deadline, then show the sticky countdown until the switch', async () => {
    const all = reminders();
    const required = (countdown: boolean, fields: Partial<HostUpdate> = {}): HostUpdate => waiting({ required: { deadline: 10 * HOUR, countdown }, ...fields });
    all.changed(HOST, required(false));
    all.connected(HOST, false);
    expect(reminded).toEqual([]);
    await vi.advanceTimersByTimeAsync(0);
    expect(reminded).toEqual([{ authority: HOST, at: 0, notice: { severity: 'warning', title: 'prod-1 still runs Damocles 3.7.0', message: 'It must switch to Damocles 3.9.0 by 10:00, in 10 h. 2 agents are running and stop then.' } }]);
    await vi.advanceTimersByTimeAsync(9 * HOUR + 44 * MINUTE);
    expect(times()).toEqual([0, 4 * HOUR, 8 * HOUR, 9 * HOUR]);
    expect(countdowns).toEqual([]);

    all.changed(HOST, required(true));
    await vi.advanceTimersByTimeAsync(0);
    expect(countdowns).toEqual([{ authority: HOST, deadline: 10 * HOUR, withdrawn: false, notice: { severity: 'error', title: 'prod-1 switches in', message: 'Damocles 3.9.0 is required. 2 agents stop then; their chats are kept.' } }]);
    // main never resends the countdown
    all.changed(HOST, required(true, { runningAgents: 1 }));
    await vi.advanceTimersByTimeAsync(10 * MINUTE);
    expect(countdowns).toHaveLength(1);
    expect(times()).toHaveLength(4);

    all.changed(HOST, required(true, { phase: 'switching' }));
    expect(countdowns[0]!.withdrawn).toBe(true);
    all.dispose();
  });

  it('show the countdown alone when the grace is shorter than it, with the latest counts, and withdraw it with Forget host', async () => {
    const all = reminders();
    all.changed(HOST, waiting({ runningAgents: 0, required: { deadline: 36_000, countdown: true } }));
    all.changed(HOST, waiting({ runningAgents: 1, required: { deadline: 36_000, countdown: true } }));
    expect(countdowns).toEqual([]);
    await vi.advanceTimersByTimeAsync(0);
    expect(countdowns).toHaveLength(1);
    expect(countdowns[0]!.notice.message).toBe('Damocles 3.9.0 is required. 1 agent stops then; its chat is kept.');
    expect(reminded).toEqual([]);
    all.forget(HOST);
    expect(countdowns[0]!.withdrawn).toBe(true);
  });

  // Node stamps a timer's start with the loop's cached clock, so it fires a few ms early by Date.now()
  it('remind once an hour before the deadline when the timer fires before Date.now() reaches its slot', async () => {
    const all = createSwitchReminders({
      wording: () => wording(Date.now() - 1),
      remind: (authority, notice) => reminded.push({ authority, notice, at: Date.now() }),
      countDown: () => ({ withdraw: () => undefined }),
      switched: () => undefined,
      log: () => undefined,
    });
    all.changed(HOST, waiting({ required: { deadline: 10 * HOUR, countdown: false } }));
    await vi.advanceTimersByTimeAsync(9 * HOUR + 30 * MINUTE);
    expect(times()).toEqual([0, 4 * HOUR, 8 * HOUR, 9 * HOUR]);
    all.dispose();
  });

  it('read the wall clock again on a resume, so a reminder due while the computer slept shows then', async () => {
    const all = reminders();
    all.changed(HOST, waiting());
    // the timers' clock stood still while the wall clock moved on
    vi.setSystemTime(2 * HOUR);
    all.resumed();
    await vi.advanceTimersByTimeAsync(0);
    expect(times()).toEqual([2 * HOUR]);
    all.dispose();
  });

  it('show the countdown, never a reminder, once the clock is inside the countdown before the flow published it', async () => {
    const all = reminders();
    all.changed(HOST, waiting({ required: { deadline: 10 * HOUR, countdown: false } }));
    await vi.advanceTimersByTimeAsync(0);
    expect(times()).toEqual([0]);
    vi.setSystemTime(9 * HOUR + 50 * MINUTE);
    all.resumed();
    await vi.advanceTimersByTimeAsync(0);
    expect(times()).toEqual([0]);
    expect(countdowns).toMatchObject([{ authority: HOST, deadline: 10 * HOUR, withdrawn: false }]);
    // the flow's own countdown keeps it
    all.changed(HOST, waiting({ required: { deadline: 10 * HOUR, countdown: true } }));
    expect(countdowns).toHaveLength(1);
    expect(countdowns[0]!.withdrawn).toBe(false);
    all.dispose();
  });

  it('log a notice that fails to show, which throws nothing out of its timer', async () => {
    const lines: string[] = [];
    const all = createSwitchReminders({
      wording: () => { throw new Error('No saved host ssh+prod-1'); },
      remind: () => undefined,
      countDown: () => ({ withdraw: () => undefined }),
      switched: () => undefined,
      log: (line) => lines.push(line),
    });
    all.changed(HOST, waiting());
    await vi.advanceTimersByTimeAsync(HOUR);
    expect(lines).toEqual([`[update] ${HOST}: showing the notice of the pending switch failed: No saved host ssh+prod-1`]);
    all.dispose();
  });

  it('take the restart of a switch this app sent or followed as the switch\'s once the server version changed, so no restart notice shows, and a same-version restart as a restart', () => {
    const all = reminders();
    all.following(HOST, '3.7.0+aaaaaaaaaaaa');
    expect(all.arrived(HOST, '3.9.0+bbbbbbbbbbbb')).toBe(true);
    expect(all.arrived(HOST, '3.9.0+bbbbbbbbbbbb')).toBe(false);
    all.following(HOST, '3.9.0+bbbbbbbbbbbb');
    expect(all.arrived(HOST, '3.9.0+bbbbbbbbbbbb')).toBe(false);
    expect(results).toEqual([]);
  });

  it('tell another device\'s switch once, naming that device and this device\'s agents it stopped, when the next attach runs another version', () => {
    const all = reminders();
    all.handingOver(HOST, { deviceName: 'DESKTOP-A', agentsStopped: 2, serverVersion: '3.7.0+aaaaaaaaaaaa' });
    expect(all.arrived(HOST, '3.9.0+bbbbbbbbbbbb')).toBe(true);
    expect(results).toEqual([{ authority: HOST, forced: false, notice: { severity: 'info', title: 'prod-1 now runs Damocles 3.9.0', message: 'DESKTOP-A switched it. 2 of your agents stopped; their chats are kept.' } }]);
    expect(all.arrived(HOST, '3.9.0+bbbbbbbbbbbb')).toBe(false);
    expect(results).toHaveLength(1);
    // the same version came back: a restart, which says nothing of a switch
    all.handingOver(HOST, { deviceName: 'DESKTOP-A', agentsStopped: 1, serverVersion: '3.9.0+bbbbbbbbbbbb' });
    expect(all.arrived(HOST, '3.9.0+bbbbbbbbbbbb')).toBe(false);
    expect(results).toHaveLength(1);
    // this app followed the switch too: its own result alone
    all.following(HOST, '3.9.0+bbbbbbbbbbbb');
    all.handingOver(HOST, { deviceName: 'DESKTOP-A', agentsStopped: 0, serverVersion: '3.9.0+bbbbbbbbbbbb' });
    expect(all.arrived(HOST, '4.0.0+cccccccccccc')).toBe(true);
    expect(results).toHaveLength(1);
  });

  it('tell what a sent switch stopped once the next connect runs this version, forced or chosen, and nothing when that connect found another daemon', () => {
    const all = reminders();
    all.switchSent(HOST, { agentsStopped: 2, terminalsClosed: 0, forcedAt: 16 * HOUR + 30 * MINUTE }, '3.9.0');
    expect(results).toEqual([]);
    all.settled(HOST, true);
    expect(results).toEqual([{ authority: HOST, forced: true, notice: { severity: 'warning', title: 'prod-1 now runs Damocles 3.9.0', message: 'The required update ran at 16:30. 2 agents stopped; their chats are kept.' } }]);
    all.settled(HOST, true);
    expect(results).toHaveLength(1);

    all.switchSent(HOST, { agentsStopped: 1, terminalsClosed: 0 }, '3.9.0');
    all.settled(HOST, true);
    expect(results[1]).toEqual({ authority: HOST, forced: false, notice: { severity: 'info', title: 'prod-1 now runs Damocles 3.9.0', message: '1 agent stopped; its chat is kept.' } });

    all.switchSent(HOST, { agentsStopped: 1, terminalsClosed: 0 }, '3.9.0');
    all.settled(HOST, false);
    all.settled(HOST, true);
    all.switchSent(HOST, { agentsStopped: 0, terminalsClosed: 0 }, '3.9.0');
    all.settled(HOST, true);
    expect(results).toHaveLength(2);

    // the daemon refused it, so a later switch nobody sent tells nothing
    all.switchSent(HOST, { agentsStopped: 1, terminalsClosed: 0, forcedAt: 0 }, '3.9.0');
    all.switchSent(HOST, undefined, '3.9.0');
    all.settled(HOST, true);
    expect(results).toHaveLength(2);
  });
});
