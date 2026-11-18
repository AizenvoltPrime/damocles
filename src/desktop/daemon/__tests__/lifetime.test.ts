import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createLifetime, IDLE_EXIT_MS } from '../lifetime';
import { createRunRegistry } from '../run-registry';
import type { ConnectionPresence } from '../connections';

const connected = (id: string): ConnectionPresence => ({ id, state: 'connected' });
const inGrace = (id: string): ConnectionPresence => ({ id, state: 'inGrace' });
const SWITCHED = 'shutdownWhenIdle, and no run, terminal or other client is left';

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
    const lifetime = createLifetime(registry, (reason) => exits.push(reason));
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
    const lifetime = createLifetime(registry, (reason) => exits.push(reason));
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
    const lifetime = createLifetime(registry, (reason) => exits.push(reason));
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
    const lifetime = createLifetime(registry, (reason) => exits.push(reason));
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
    const lifetime = createLifetime(registry, (reason) => exits.push(reason));
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
    const lifetime = createLifetime(registry, (reason) => exits.push(reason));
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
    const lifetime = createLifetime(registry, (reason) => exits.push(reason));
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
    const lifetime = createLifetime(registry, (reason) => exits.push(reason));
    lifetime.connectionsChanged([connected('asker'), connected('owner')]);
    lifetime.shutdownWhenIdle('asker');
    lifetime.connectionClosed('asker');
    lifetime.connectionsChanged([connected('owner'), connected('third')]);
    lifetime.connectionsChanged([]);
    expect(exits).toEqual([]);
    vi.advanceTimersByTime(IDLE_EXIT_MS);
    expect(exits).toEqual([`no client, run or terminal for ${IDLE_EXIT_MS} ms`]);
  });

  it('does not stay alive for a connection inside its reconnection grace', () => {
    const registry = createRunRegistry();
    const exits: string[] = [];
    const lifetime = createLifetime(registry, (reason) => exits.push(reason));
    lifetime.connectionsChanged([connected('a'), inGrace('b')]);
    vi.advanceTimersByTime(IDLE_EXIT_MS * 3);
    expect(exits).toEqual([]);
    lifetime.connectionsChanged([inGrace('b')]);
    vi.advanceTimersByTime(IDLE_EXIT_MS);
    expect(exits).toEqual([`no client, run or terminal for ${IDLE_EXIT_MS} ms`]);
  });
});
