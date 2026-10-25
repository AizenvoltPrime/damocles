import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createLoopback, parseCoreInit, type CoreInit } from '../../core-protocol';
import { INVALID } from '../../core-protocol/schema';
import type { CoreAttach, CoreState } from '../control-messages';
import type { DaemonState } from '../daemon-state';
import type { ForkedChild } from '../process-starts';
import { createRemoteCoreHost } from '../remote-core-host';
import { createRunRegistry } from '../run-registry';
import { runPaths } from '../token';

interface FakeCore {
  readonly pid: number;
  readonly sent: unknown[];
  exit(code: number): void;
  readonly killed: boolean;
}

function setUp() {
  const cores: FakeCore[] = [];
  let nextPid = 100;
  const fork = (): ForkedChild => {
    const exits: Array<(exit: { code: number; signal: string | null; error: string | null }) => void> = [];
    const core: FakeCore & { killed: boolean } = {
      pid: nextPid++,
      sent: [],
      killed: false,
      exit: (code) => { for (const listener of exits) listener({ code, signal: null, error: null }); },
    };
    cores.push(core);
    return {
      pid: core.pid,
      postMessage: (message) => core.sent.push(message),
      onMessage: () => undefined,
      onExit: (listener) => { exits.push(listener); },
      kill: () => {
        core.killed = true;
        core.exit(1);
      },
    };
  };
  const state: DaemonState = { snapshot: () => ({}), update: async () => undefined, applyClient: () => false, flush: async () => undefined };
  const host = createRemoteCoreHost({
    root: '/opt/damocles',
    paths: runPaths('/home/u', 'box'),
    git: { available: false, reason: 'no git' },
    e2eHooks: false,
    state,
    registry: createRunRegistry(),
    fork,
    log: () => undefined,
  });
  const states: CoreState[] = [];
  host.onState((value) => states.push(value));
  return { host, cores, states };
}

const attach = (n: number, hostId = 'client-host'): CoreAttach => ({
  attach: n,
  hostId,
  appInfo: { version: '9.9.9', host: 'desktop' },
  secretsPersistent: true,
  chatBrowserPane: true,
  mirrors: { state: { global: {}, workspace: {} }, trust: { keys: ['/srv/app'] }, folders: { folders: [] }, editor: {}, terminal: { shown: false, shortcut: '' }, language: { language: 'el' }, clientAuth: { providers: {} }, clientUser: { settings: {}, permissionRules: [] }, clientPolicy: { voice: false, allowBypass: false } },
});

function connection(host: ReturnType<typeof setUp>['host']) {
  const loop = createLoopback();
  const close = vi.fn();
  const received: unknown[] = [];
  loop.main.onMessage((raw) => received.push(raw));
  const core = host.connect('connection-1', loop.core, close);
  return { core, close, received, client: loop.main };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('remote core host', () => {
  it('forks core on the first attach with an init the daemon builds, carrying remote but no client value of it', () => {
    const { host, cores, states } = setUp();
    const { core } = connection(host);
    expect(host.state().epoch).toBeNull();
    const state = core.attach(attach(1));
    expect(cores).toHaveLength(1);
    expect(state).toMatchObject({ phase: 'starting', pid: 100, ppid: process.pid });
    expect(state.epoch).toMatch(/^[0-9a-f]{32}$/);
    const init = parseCoreInit(cores[0]!.sent[0]) as CoreInit;
    expect(init).not.toBe(INVALID);
    expect(init.remote?.hostId).toMatch(/^[0-9a-f]{32}$/);
    expect(init.remote?.hostId).not.toBe('client-host');
    expect(init.appInfo.version).toBe('9.9.9');
    expect(init.logs.dir).toBe(runPaths('/home/u', 'box').logsDir);
    expect(init.paths.askpass.node).toBe(process.execPath);
    expect(init.e2eHooks).toBe(false);
    expect(states.at(-1)).toEqual(state);
  });

  it('restarts a crashed core with a new epoch three times in the window, then halts until restartCore', () => {
    const { host, cores } = setUp();
    connection(host).core.attach(attach(1));
    const epochs = [host.state().epoch];
    for (let crash = 1; crash <= 3; crash++) {
      cores.at(-1)!.exit(1);
      expect(host.state()).toMatchObject({ phase: 'starting', restarts: crash });
      epochs.push(host.state().epoch);
    }
    expect(new Set(epochs).size).toBe(4);
    cores.at(-1)!.exit(1);
    expect(host.state()).toMatchObject({ phase: 'halted', pid: null });
    expect(cores).toHaveLength(4);
    // the next core takes over the leases the crashed ones held
    const init = parseCoreInit(cores.at(-1)!.sent[0]) as CoreInit;
    expect(init.endedCores.map((ended) => ended.pid)).toEqual([100, 101, 102]);
    host.restart();
    expect(cores).toHaveLength(5);
    expect(host.state()).toMatchObject({ phase: 'starting', restarts: 0, pid: 104 });
  });

  it('forks one new core for restarts that overlap, however many arrive before the old core exits', async () => {
    const { host, cores } = setUp();
    connection(host).core.attach(attach(1));
    host.restart();
    host.restart();
    // core.shutdown gets no answer from the fake, so the close limit passes and the old core is killed
    await vi.advanceTimersByTimeAsync(5000);
    host.restart();
    await vi.advanceTimersByTimeAsync(5000);
    expect(cores).toHaveLength(3);
    expect(cores.slice(0, 2).every((core) => core.killed)).toBe(true);
    expect(host.state()).toMatchObject({ phase: 'starting', pid: cores[2]!.pid });
  });

  it('frames every message with the attach generation and closes a connection that skips attachCore', () => {
    const { host } = setUp();
    const { core, close, client } = connection(host);
    core.attach(attach(1));
    // an earlier generation's leftover is dropped; a later one before its attach is a violation
    client.post({ attach: 1, envelope: { kind: 'event', name: 'power.suspend', payload: {} } });
    expect(close).not.toHaveBeenCalled();
    client.post({ attach: 2, envelope: { kind: 'event', name: 'power.suspend', payload: {} } });
    expect(close).toHaveBeenCalledTimes(1);
    expect(() => core.attach(attach(1))).toThrow('not after');
    client.post({ envelope: {} });
    expect(close).toHaveBeenCalledTimes(2);
  });
});
