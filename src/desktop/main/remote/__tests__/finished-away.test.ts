import { describe, expect, it, vi } from 'vitest';
import type { Run } from '../../../daemon/control-messages';
import { announceFinishedAway, awayChats, finishedChats, type FinishedAwayDeps } from '../finished-away';
import type { AwayChat } from '../remote-state';

const run = (id: string, title: string, kind: Run['kind'] = 'chat'): Run => ({ kind, id, projectKey: '/srv/app', title, state: 'running', providers: [] });
const chat = (panelId: string, title: string): AwayChat => ({ panelId, sessionId: `session-of-${panelId}`, title });
// the localization's own substitution, so a test reads the text the user does
const t = (message: string, ...args: Array<string | number>): string => message.replace(/\{(\d+)\}/g, (_whole, index: string) => String(args[Number(index)]));

function deps(recorded: readonly AwayChat[], runs: readonly Run[], answer: (actions: readonly string[]) => string | undefined = () => undefined, coreRestarted = false) {
  const stored = new Map<string, readonly AwayChat[]>([['ssh+h1', recorded]]);
  const notices: Array<{ message: string; actions: readonly string[] }> = [];
  const opened: AwayChat[] = [];
  const value: FinishedAwayDeps = {
    recorded: (key) => stored.get(key) ?? [],
    record: async (key, chats) => {
      stored.set(key, chats);
    },
    runs: vi.fn(async () => runs),
    coreRestarted: () => coreRestarted,
    hostName: () => 'prod-1',
    t,
    notify: async (message, actions) => {
      notices.push({ message, actions });
      return answer(actions);
    },
    open: async (_key, chosen) => {
      opened.push(chosen);
    },
    log: () => undefined,
  };
  return { value, stored, notices, opened };
}

describe('finished while away', () => {
  it('records on detach only the chat runs this app knows a session for', () => {
    const sessions = new Map([['host-1', 'S1'], ['host-3', 'S3']]);
    expect(awayChats([run('host-1', 'Fix the parser'), run('host-2', 'Other device'), run('term-1', 'bash', 'terminal')], (id) => sessions.get(id))).toEqual([
      { panelId: 'host-1', sessionId: 'S1', title: 'Fix the parser' },
    ]);
  });

  it('counts a recorded chat finished once the host no longer runs it', () => {
    expect(finishedChats([chat('host-1', 'a'), chat('host-2', 'b')], [run('host-2', 'b')])).toEqual([chat('host-1', 'a')]);
  });

  it('tells about every chat that finished in one notification, each chat an action, and keeps the ones still running', async () => {
    const { value, stored, notices, opened } = deps([chat('host-1', 'Fix the parser'), chat('host-2', 'Write docs'), chat('host-3', 'Still going')], [run('host-3', 'Still going')], (actions) => actions[1]);
    await announceFinishedAway(value, 'ssh+h1');
    expect(notices).toEqual([{ message: '2 chats on prod-1 finished while you were away', actions: ['Fix the parser', 'Write docs'] }]);
    expect(opened).toEqual([chat('host-2', 'Write docs')]);
    expect(stored.get('ssh+h1')).toEqual([chat('host-3', 'Still going')]);
  });

  it('says one chat in the singular, names an untitled chat, and tells nothing twice', async () => {
    const { value, notices } = deps([chat('host-1', '')], []);
    await announceFinishedAway(value, 'ssh+h1');
    await announceFinishedAway(value, 'ssh+h1');
    expect(notices).toEqual([{ message: '1 chat on prod-1 finished while you were away', actions: ['New conversation'] }]);
  });

  // a restart kills every run, so a chat missing from the new core's runs did not finish
  it('says the recorded chats stopped, never finished, when their core ended while the app was away', async () => {
    const { value, stored, notices } = deps([chat('host-1', 'Fix the parser'), chat('host-2', 'Write docs')], [run('host-2', 'another panel with that id')], () => undefined, true);
    await announceFinishedAway(value, 'ssh+h1');
    expect(notices).toEqual([{ message: '2 chats on prod-1 stopped when Damocles restarted there', actions: ['Fix the parser', 'Write docs'] }]);
    expect(value.runs).not.toHaveBeenCalled();
    expect(stored.get('ssh+h1')).toEqual([]);
  });

  it('tells nothing, and asks the host nothing, when no chat was running at the detach', async () => {
    const { value, notices } = deps([], [run('host-1', 'x')]);
    await announceFinishedAway(value, 'ssh+h1');
    expect(value.runs).not.toHaveBeenCalled();
    expect(notices).toEqual([]);
  });
});
