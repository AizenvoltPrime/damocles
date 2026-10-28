import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createLoopback, parseCoreInit, processActor, type CoreInit } from '../../core-protocol';
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
  // the actor of the context it was forked in, which its channel keeps
  readonly actor: string | undefined;
  exit(code: number): void;
  readonly killed: boolean;
}

function setUp(sockets: { agentFolder?: string; relayHandle?: string } = {}) {
  const cores: FakeCore[] = [];
  let nextPid = 100;
  const fork = (): ForkedChild => {
    const exits: Array<(exit: { code: number; signal: string | null; error: string | null }) => void> = [];
    const core: FakeCore & { killed: boolean } = {
      pid: nextPid++,
      sent: [],
      actor: processActor.current(),
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
    agentFolder: () => sockets.agentFolder,
    ...(sockets.relayHandle !== undefined ? { credentialRelay: () => ({ helper: '/opt/damocles/dist/git-credential/git-credential-relay.sh', nonce: 'a'.repeat(64), handle: sockets.relayHandle! }) } : {}),
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

function connection(host: ReturnType<typeof setUp>['host'], id = 'connection-1', clientId = 'device-a') {
  const loop = createLoopback();
  const close = vi.fn();
  const received: unknown[] = [];
  loop.main.onMessage((raw) => received.push(raw));
  const core = host.connect(id, clientId, loop.core, close, { drained: () => Promise.resolve(), lost: () => false, onLostChange: () => ({ dispose: () => undefined }) });
  return { core, close, received, client: loop.main };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('remote core host', () => {
  it('names a client by its hello client id, and keeps the values of a device that attached again when its old connection closes late', () => {
    const { host, cores } = setUp();
    const first = connection(host, 'connection-1', 'device-a');
    first.core.attach(attach(1));
    const second = connection(host, 'connection-2', 'device-a');
    second.core.attach(attach(1));
    first.core.dispose();
    cores.at(-1)!.exit(1);
    const init = parseCoreInit(cores.at(-1)!.sent[0]) as CoreInit;
    expect(Object.keys(init.mirrors.clientAuth)).toEqual(['device-a']);
    expect(init.mirrors.actingClient).toEqual({ clientId: 'device-a' });
    second.core.dispose();
    cores.at(-1)!.exit(1);
    expect((parseCoreInit(cores.at(-1)!.sent[0]) as CoreInit).mirrors.clientAuth).toEqual({});
  });

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

  it('forks core outside the actor of the client whose request restarted it', async () => {
    const { host, cores } = setUp();
    connection(host).core.attach(attach(1));
    processActor.run('device-a', () => host.restart());
    await vi.advanceTimersByTimeAsync(5000);
    expect(cores).toHaveLength(2);
    expect(cores.map((core) => core.actor)).toEqual([undefined, undefined]);
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

  it('gives core the agent folder and relay handle in its init, publishes them when they move, and a later core reads the new ones', () => {
    const sockets = { agentFolder: '/tmp/damocles-agent1', relayHandle: '/tmp/damocles-relay1/askpass.sock' };
    const { host, cores } = setUp(sockets);
    // no core yet: nothing to tell
    host.socketsMoved();
    connection(host).core.attach(attach(1));
    const first = parseCoreInit(cores[0]!.sent[0]) as CoreInit;
    expect(first.remote?.agentFolder).toBe('/tmp/damocles-agent1');
    expect(first.paths.askpass.credentialRelay?.handle).toBe('/tmp/damocles-relay1/askpass.sock');
    sockets.agentFolder = '/tmp/damocles-agent2';
    sockets.relayHandle = '/tmp/damocles-relay2/askpass.sock';
    host.socketsMoved();
    expect(cores[0]!.sent.filter((message) => (message as { topic?: string }).topic === 'hostSockets')).toEqual([{ kind: 'mirror', topic: 'hostSockets', version: 1, patch: { agentFolder: '/tmp/damocles-agent2', relayHandle: '/tmp/damocles-relay2/askpass.sock' } }]);
    cores[0]!.exit(1);
    const next = parseCoreInit(cores[1]!.sent[0]) as CoreInit;
    expect(next.remote?.agentFolder).toBe('/tmp/damocles-agent2');
    expect(next.paths.askpass.credentialRelay?.handle).toBe('/tmp/damocles-relay2/askpass.sock');
  });
});
