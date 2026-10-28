import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createLifetime, IDLE_EXIT_MS } from '../lifetime';
import { createRunRegistry } from '../run-registry';

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
    lifetime.connectionsChanged(['connected']);
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

  it('exits once idle after shutdownWhenIdle, clients or not', () => {
    const registry = createRunRegistry();
    const exits: string[] = [];
    const lifetime = createLifetime(registry, (reason) => exits.push(reason));
    lifetime.connectionsChanged(['connected', 'connected']);
    registry.addTerminal({ id: 'term-1', projectKey: '', title: 'sh' });
    lifetime.shutdownWhenIdle();
    expect(exits).toEqual([]);
    registry.removeTerminal('term-1');
    expect(exits).toEqual(['shutdownWhenIdle, and no run or terminal is left']);
  });

  it('does not stay alive for a connection inside its reconnection grace', () => {
    const registry = createRunRegistry();
    const exits: string[] = [];
    const lifetime = createLifetime(registry, (reason) => exits.push(reason));
    lifetime.connectionsChanged(['connected', 'inGrace']);
    vi.advanceTimersByTime(IDLE_EXIT_MS * 3);
    expect(exits).toEqual([]);
    lifetime.connectionsChanged(['inGrace']);
    vi.advanceTimersByTime(IDLE_EXIT_MS);
    expect(exits).toEqual([`no client, run or terminal for ${IDLE_EXIT_MS} ms`]);
  });
});
