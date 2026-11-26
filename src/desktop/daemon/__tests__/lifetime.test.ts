import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createLifetime, IDLE_EXIT_MS } from '../lifetime';
import { createRunRegistry } from '../run-registry';
import type { ConnectionPresence } from '../connections';

const connected = (id: string): ConnectionPresence => ({ id, state: 'connected' });
const inGrace = (id: string): ConnectionPresence => ({ id, state: 'inGrace' });
const SWITCHED = 'shutdownWhenIdle, and no run, terminal or other client is left';
const HANDED_OVER = 'handOver, and no agent run, damocles --wait or other client is left';
const quiet = (): void => undefined;

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('daemon lifetime', () => {
  it('exits 5 minutes after it has no client, no run and no terminal', () => {
    const registry = createRunRegistry();
    const exits: string[] = [];
    const lifetime = createLifetime(registry, (reason) => exits.push(reason), quiet);
    lifetime.connectionsChanged([connected('a')]);
    vi.advanceTimersByTime(IDLE_EXIT_MS * 3);
    expect(exits).toEqual([]);
    lifetime.connectionsChanged([]);
    vi.advanceTimersByTime(IDLE_EXIT_MS - 1);
    expect(exits).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(exits).toHaveLength(1);
  });

  it('stays alive while a terminal exists, with no client', () => {
    const registry = createRunRegistry();
    const exits: string[] = [];
    const lifetime = createLifetime(registry, (reason) => exits.push(reason), quiet);
    registry.addTerminal({ id: 'term-1', projectKey: '', title: 'sh' });
    lifetime.connectionsChanged([]);
    vi.advanceTimersByTime(IDLE_EXIT_MS * 10);
    expect(exits).toEqual([]);
    registry.removeTerminal('term-1');
    vi.advanceTimersByTime(IDLE_EXIT_MS);
    expect(exits).toHaveLength(1);
  });

  it('exits after shutdownWhenIdle once no run or terminal is left, with only the connections that asked connected', () => {
    const registry = createRunRegistry();
    const exits: string[] = [];
    const lifetime = createLifetime(registry, (reason) => exits.push(reason), quiet);
    lifetime.connectionsChanged([connected('a'), connected('b')]);
    registry.addTerminal({ id: 'term-1', projectKey: '', title: 'sh' });
    lifetime.shutdownWhenIdle('a');
    lifetime.shutdownWhenIdle('b');
    expect(exits).toEqual([]);
    registry.removeTerminal('term-1');
    expect(exits).toEqual([SWITCHED]);
  });

  // two apps of different builds on one host: each asks the other's daemon to switch, which must not end the other's connection
  it('stays after shutdownWhenIdle while a connection that did not ask is connected, and exits once it leaves', () => {
    const registry = createRunRegistry();
    const exits: string[] = [];
    const lifetime = createLifetime(registry, (reason) => exits.push(reason), quiet);
    lifetime.connectionsChanged([connected('owner'), connected('other-build')]);
    lifetime.shutdownWhenIdle('other-build');
    vi.advanceTimersByTime(IDLE_EXIT_MS * 3);
    expect(exits).toEqual([]);
    lifetime.connectionsChanged([inGrace('owner'), connected('other-build')]);
    expect(exits).toEqual([SWITCHED]);
  });

  it('stays after shutdownWhenIdle while a run is left, after the other connections left', () => {
    const registry = createRunRegistry();
    const exits: string[] = [];
    const lifetime = createLifetime(registry, (reason) => exits.push(reason), quiet);
    lifetime.connectionsChanged([connected('asker'), connected('other')]);
    registry.addTerminal({ id: 'term-1', projectKey: '', title: 'sh' });
    lifetime.shutdownWhenIdle('asker');
    lifetime.connectionClosed('other');
    lifetime.connectionsChanged([connected('asker')]);
    vi.advanceTimersByTime(IDLE_EXIT_MS * 3);
    expect(exits).toEqual([]);
    registry.removeTerminal('term-1');
    expect(exits).toEqual([SWITCHED]);
  });

  // a client of another protocol asks over its refused connection, which is never listed
  it('honors an ask from a connection it does not list', () => {
    const registry = createRunRegistry();
    const exits: string[] = [];
    const lifetime = createLifetime(registry, (reason) => exits.push(reason), quiet);
    lifetime.connectionsChanged([connected('owner')]);
    registry.addTerminal({ id: 'term-1', projectKey: '', title: 'sh' });
    lifetime.shutdownWhenIdle('refused');
    registry.removeTerminal('term-1');
    expect(exits).toEqual([]);
    lifetime.connectionsChanged([]);
    expect(exits).toEqual([SWITCHED]);
  });

  it('keeps an ask while its connection is inside its grace', () => {
    const registry = createRunRegistry();
    const exits: string[] = [];
    const lifetime = createLifetime(registry, (reason) => exits.push(reason), quiet);
    lifetime.connectionsChanged([connected('asker'), connected('owner')]);
    lifetime.shutdownWhenIdle('asker');
    lifetime.connectionsChanged([inGrace('asker'), connected('owner')]);
    lifetime.connectionsChanged([connected('asker'), connected('owner')]);
    expect(exits).toEqual([]);
    lifetime.connectionsChanged([connected('asker')]);
    expect(exits).toEqual([SWITCHED]);
  });

  // the asker left for good: a connection of the daemon's own build that attached since keeps the usual idle exit
  it('drops an ask once its connection closes, so a later connection gets the usual idle exit', () => {
    const registry = createRunRegistry();
    const exits: string[] = [];
    const lifetime = createLifetime(registry, (reason) => exits.push(reason), quiet);
    lifetime.connectionsChanged([connected('asker'), connected('owner')]);
    lifetime.shutdownWhenIdle('asker');
    lifetime.connectionClosed('asker');
    lifetime.connectionsChanged([connected('owner'), connected('third')]);
    lifetime.connectionsChanged([]);
    expect(exits).toEqual([]);
    vi.advanceTimersByTime(IDLE_EXIT_MS);
    expect(exits).toEqual([`no client, run or terminal for ${IDLE_EXIT_MS} ms`]);
  });

  it('logs each ask to switch with its connection and what blocks it, then the blockers again only when they change', () => {
    const registry = createRunRegistry();
    const lines: string[] = [];
    const lifetime = createLifetime(registry, () => undefined, (line) => lines.push(line));
    lifetime.connectionsChanged([connected('connection-1'), connected('connection-2')]);
    registry.addTerminal({ id: 'term-1', projectKey: '', title: 'sh' });
    registry.panelActivity({ panelId: 'panel-1', projectKey: '/srv/app', title: 'Fix it' }, { state: 'running', pendingKinds: [], pendingPrompts: [], background: false }, 'client-1');
    expect(lines).toEqual([]);
    lifetime.shutdownWhenIdle('connection-2');
    // a change that leaves the blockers as they were logs nothing
    lifetime.connectionsChanged([connected('connection-1'), connected('connection-2')]);
    registry.removeTerminal('term-1');
    lifetime.connectionsChanged([connected('connection-2')]);
    expect(lines).toEqual([
      '[lifetime] connection-2 asks to switch once idle; it waits for 1 agent runs, 1 terminals, connected clients that did not ask: connection-1',
      '[lifetime] the switch now waits for 1 agent runs, 0 terminals, connected clients that did not ask: connection-1',
      '[lifetime] the switch now waits for 1 agent runs, 0 terminals, connected clients that did not ask: none',
    ]);
  });

  it('logs an ask that nothing blocks before it exits', () => {
    const registry = createRunRegistry();
    const lines: string[] = [];
    const exits: string[] = [];
    const lifetime = createLifetime(registry, (reason) => exits.push(reason), (line) => lines.push(line));
    lifetime.connectionsChanged([connected('connection-1')]);
    lifetime.shutdownWhenIdle('connection-1');
    expect(lines).toEqual(['[lifetime] connection-1 asks to switch once idle; nothing blocks it']);
    expect(exits).toEqual([SWITCHED]);
  });

  const RUNNING = { state: 'running', pendingKinds: [], pendingPrompts: [], background: false } as const;
  const IDLE = { ...RUNNING, state: 'idle' } as const;
  const PANEL = { panelId: 'panel-1', projectKey: '/srv/app', title: 'Fix it' };

  it('exits on handOver idle once no chat run is left, whatever terminals run', () => {
    const registry = createRunRegistry();
    const exits: string[] = [];
    const lifetime = createLifetime(registry, (reason) => exits.push(reason), quiet);
    lifetime.connectionsChanged([connected('a')]);
    registry.addTerminal({ id: 'term-1', projectKey: '', title: 'sh' });
    registry.panelActivity(PANEL, RUNNING, 'client-1');
    lifetime.handOver('a', 'idle');
    expect(exits).toEqual([]);
    registry.panelActivity(PANEL, IDLE, 'client-1');
    expect(exits).toEqual([HANDED_OVER]);
  });

  // a git commit whose message tab is open would abort
  it('waits on handOver idle for a pending damocles --wait, as for a chat run', () => {
    const registry = createRunRegistry();
    const exits: string[] = [];
    const lifetime = createLifetime(registry, (reason) => exits.push(reason), quiet);
    lifetime.connectionsChanged([connected('a')]);
    registry.addTerminal({ id: 'term-1', projectKey: '', title: 'sh' });
    const wait = registry.cliWait('COMMIT_EDITMSG');
    lifetime.handOver('a', 'idle');
    expect(exits).toEqual([]);
    wait.dispose();
    expect(exits).toEqual([HANDED_OVER]);
  });

  it('exits at once on handOver now while a damocles --wait is pending', () => {
    const registry = createRunRegistry();
    const exits: string[] = [];
    const lifetime = createLifetime(registry, (reason) => exits.push(reason), quiet);
    lifetime.connectionsChanged([connected('a')]);
    registry.cliWait('COMMIT_EDITMSG');
    lifetime.handOver('a', 'now');
    expect(exits).toEqual(['handOver now']);
  });

  it('exits at once on handOver idle with a terminal and no chat run', () => {
    const registry = createRunRegistry();
    const exits: string[] = [];
    const lifetime = createLifetime(registry, (reason) => exits.push(reason), quiet);
    lifetime.connectionsChanged([connected('a')]);
    registry.addTerminal({ id: 'term-1', projectKey: '', title: 'sh' });
    lifetime.handOver('a', 'idle');
    expect(exits).toEqual([HANDED_OVER]);
  });

  it('waits on handOver idle for a connected client that did not ask, and counts one that asked shutdownWhenIdle as asking', () => {
    const registry = createRunRegistry();
    const exits: string[] = [];
    const lifetime = createLifetime(registry, (reason) => exits.push(reason), quiet);
    lifetime.connectionsChanged([connected('a'), connected('b')]);
    registry.addTerminal({ id: 'term-1', projectKey: '', title: 'sh' });
    lifetime.handOver('a', 'idle');
    expect(exits).toEqual([]);
    lifetime.shutdownWhenIdle('b');
    expect(exits).toEqual([HANDED_OVER]);
  });

  // the frozen meaning: a terminal keeps the daemon for an app that knows no handOver
  it('keeps waiting for a terminal after shutdownWhenIdle alone, and again once the handOver ask\'s connection closed', () => {
    const registry = createRunRegistry();
    const exits: string[] = [];
    const lifetime = createLifetime(registry, (reason) => exits.push(reason), quiet);
    lifetime.connectionsChanged([connected('legacy'), connected('new')]);
    registry.addTerminal({ id: 'term-1', projectKey: '', title: 'sh' });
    registry.panelActivity(PANEL, RUNNING, 'client-1');
    lifetime.shutdownWhenIdle('legacy');
    lifetime.handOver('new', 'idle');
    // the hand-over ask ends with its connection
    lifetime.connectionClosed('new');
    lifetime.connectionsChanged([connected('legacy')]);
    registry.panelActivity(PANEL, IDLE, 'client-1');
    expect(exits).toEqual([]);
    registry.removeTerminal('term-1');
    expect(exits).toEqual([SWITCHED]);
  });

  it('exits at once on handOver now, whatever runs and whoever is connected, and says who asked', () => {
    const registry = createRunRegistry();
    const exits: string[] = [];
    const lines: string[] = [];
    const lifetime = createLifetime(registry, (reason) => exits.push(reason), (line) => lines.push(line));
    lifetime.connectionsChanged([connected('connection-1'), connected('connection-2')]);
    registry.addTerminal({ id: 'term-1', projectKey: '', title: 'sh' });
    registry.panelActivity(PANEL, RUNNING, 'client-1');
    lifetime.handOver('connection-2', 'now');
    expect(exits).toEqual(['handOver now']);
    expect(lines).toEqual(['[lifetime] connection-2 asks to switch now']);
  });

  // a git commit whose message tab opened after the app's runs event
  it('keeps a damocles --wait registered just before handOverIfIdle, which waits as handOver idle', () => {
    const registry = createRunRegistry();
    const exits: string[] = [];
    const lines: string[] = [];
    const lifetime = createLifetime(registry, (reason) => exits.push(reason), (line) => lines.push(line));
    lifetime.connectionsChanged([connected('connection-1')]);
    const wait = registry.cliWait('COMMIT_EDITMSG');
    const answered = vi.fn(() => Promise.resolve());
    expect(lifetime.handOverIfIdle('connection-1', answered)).toBe('idle');
    expect(exits).toEqual([]);
    expect(answered).not.toHaveBeenCalled();
    expect(lines).toEqual(['[lifetime] connection-1 asks to switch once idle; it waits for 0 agent runs, 1 damocles --wait requests, connected clients that did not ask: none']);
    wait.dispose();
    expect(exits).toEqual([HANDED_OVER]);
  });

  it('answers handOverIfIdle idle for a chat run, and hands over once it ends', () => {
    const registry = createRunRegistry();
    const exits: string[] = [];
    const lifetime = createLifetime(registry, (reason) => exits.push(reason), quiet);
    lifetime.connectionsChanged([connected('connection-1')]);
    registry.panelActivity(PANEL, RUNNING, 'client-1');
    expect(lifetime.handOverIfIdle('connection-1', () => Promise.resolve())).toBe('idle');
    expect(exits).toEqual([]);
    registry.panelActivity(PANEL, IDLE, 'client-1');
    expect(exits).toEqual([HANDED_OVER]);
  });

  it('answers handOverIfIdle now with nothing pending, whatever terminals run and whoever is connected, and exits handed over once the answer went out', async () => {
    const registry = createRunRegistry();
    const exits: Array<[string, boolean]> = [];
    const lines: string[] = [];
    const lifetime = createLifetime(registry, (reason, handedOver) => exits.push([reason, handedOver]), (line) => lines.push(line));
    lifetime.connectionsChanged([connected('connection-1'), connected('connection-2')]);
    registry.addTerminal({ id: 'term-1', projectKey: '', title: 'sh' });
    let sent!: () => void;
    const answer = new Promise<void>((resolve) => { sent = resolve; });
    expect(lifetime.handOverIfIdle('connection-2', () => answer)).toBe('now');
    // decided: a wait that registers while the answer drains changes nothing
    registry.cliWait('COMMIT_EDITMSG');
    await vi.advanceTimersByTimeAsync(0);
    expect(exits).toEqual([]);
    sent();
    await vi.advanceTimersByTimeAsync(0);
    expect(exits).toEqual([['handOver now, and no agent run or damocles --wait was pending', true]]);
    expect(lines).toEqual(['[lifetime] connection-2 asks to switch now if idle; no agent run or damocles --wait is pending']);
  });

  it('does not exit for a handOverIfIdle decided before it was disposed', async () => {
    const exits: string[] = [];
    const lifetime = createLifetime(createRunRegistry(), (reason) => exits.push(reason), quiet);
    lifetime.connectionsChanged([connected('connection-1')]);
    let sent!: () => void;
    expect(lifetime.handOverIfIdle('connection-1', () => new Promise<void>((resolve) => { sent = resolve; }))).toBe('now');
    lifetime.dispose();
    sent();
    await vi.advanceTimersByTimeAsync(0);
    expect(exits).toEqual([]);
  });

  it('tells its exit apart as a hand-over only for control.handOver, now or once idle', () => {
    const handedOver = (act: (lifetime: ReturnType<typeof createLifetime>) => void): boolean[] => {
      const exits: boolean[] = [];
      const lifetime = createLifetime(createRunRegistry(), (_reason, handOver) => exits.push(handOver), quiet);
      lifetime.connectionsChanged([connected('connection-1')]);
      act(lifetime);
      return exits;
    };
    expect(handedOver((lifetime) => lifetime.handOver('connection-1', 'now'))).toEqual([true]);
    expect(handedOver((lifetime) => lifetime.handOver('connection-1', 'idle'))).toEqual([true]);
    expect(handedOver((lifetime) => lifetime.shutdownWhenIdle('connection-1'))).toEqual([false]);
    expect(handedOver((lifetime) => {
      lifetime.connectionsChanged([]);
      vi.advanceTimersByTime(IDLE_EXIT_MS);
    })).toEqual([false]);
  });

  it('names the connection whose ask ended it: the asker of a switch now, the ask a switch once idle was waiting on, the earliest ask when a run ending triggers it, and none for the idle exit', async () => {
    const by = async (act: (lifetime: ReturnType<typeof createLifetime>, registry: ReturnType<typeof createRunRegistry>) => void | Promise<void>): Promise<Array<string | undefined>> => {
      const registry = createRunRegistry();
      const exits: Array<string | undefined> = [];
      const lifetime = createLifetime(registry, (_reason, _handedOver, asker) => exits.push(asker), quiet);
      lifetime.connectionsChanged([connected('connection-1'), connected('connection-2')]);
      await act(lifetime, registry);
      return exits;
    };
    expect(await by((lifetime) => lifetime.handOver('connection-2', 'now'))).toEqual(['connection-2']);
    expect(await by(async (lifetime) => {
      lifetime.handOverIfIdle('connection-2', () => Promise.resolve());
      await vi.advanceTimersByTimeAsync(0);
    })).toEqual(['connection-2']);
    expect(await by((lifetime) => {
      lifetime.handOver('connection-1', 'idle');
      lifetime.handOver('connection-2', 'idle');
    })).toEqual(['connection-2']);
    expect(await by((lifetime, registry) => {
      registry.panelActivity(PANEL, RUNNING, 'client-1');
      lifetime.handOver('connection-2', 'idle');
      lifetime.handOver('connection-1', 'idle');
      registry.panelActivity(PANEL, IDLE, 'client-1');
    })).toEqual(['connection-2']);
    expect(await by((lifetime) => {
      lifetime.connectionsChanged([]);
      vi.advanceTimersByTime(IDLE_EXIT_MS);
    })).toEqual([undefined]);
  });

  it('logs a handOver ask and its blockers without the terminals, which do not block it', () => {
    const registry = createRunRegistry();
    const lines: string[] = [];
    const lifetime = createLifetime(registry, () => undefined, (line) => lines.push(line));
    lifetime.connectionsChanged([connected('connection-1'), connected('connection-2')]);
    registry.addTerminal({ id: 'term-1', projectKey: '', title: 'sh' });
    registry.panelActivity(PANEL, RUNNING, 'client-1');
    const wait = registry.cliWait('COMMIT_EDITMSG');
    lifetime.handOver('connection-2', 'idle');
    lifetime.connectionsChanged([connected('connection-2')]);
    registry.panelActivity(PANEL, IDLE, 'client-1');
    wait.dispose();
    expect(lines).toEqual([
      '[lifetime] connection-2 asks to switch once idle; it waits for 1 agent runs, 1 damocles --wait requests, connected clients that did not ask: connection-1',
      '[lifetime] the switch now waits for 1 agent runs, 1 damocles --wait requests, connected clients that did not ask: none',
      '[lifetime] the switch now waits for 0 agent runs, 1 damocles --wait requests, connected clients that did not ask: none',
    ]);
  });

  it('does not stay alive for a connection inside its reconnection grace', () => {
    const registry = createRunRegistry();
    const exits: string[] = [];
    const lifetime = createLifetime(registry, (reason) => exits.push(reason), quiet);
    lifetime.connectionsChanged([connected('a'), inGrace('b')]);
    vi.advanceTimersByTime(IDLE_EXIT_MS * 3);
    expect(exits).toEqual([]);
    lifetime.connectionsChanged([inGrace('b')]);
    vi.advanceTimersByTime(IDLE_EXIT_MS);
    expect(exits).toEqual([`no client, run or terminal for ${IDLE_EXIT_MS} ms`]);
  });
});
