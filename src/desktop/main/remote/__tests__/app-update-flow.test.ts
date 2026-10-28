import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Run } from '../../../daemon/control-messages';
import { adoptCompatibleDaemon, FollowedDaemons, followOtherProtocolDaemon, otherDeviceCount, shutDownNow, type CompatibleDaemon, type SwitchListing } from '../app-update-flow';
import type { OtherProtocolDaemon } from '../connection';

const quiet = (): void => undefined;
const chat = (id: string, title: string): Run => ({ kind: 'chat', id, projectKey: '/srv/app', title, state: 'running', providers: [] });
const terminal = (id: string, title: string): Run => ({ kind: 'terminal', id, projectKey: '', title, state: 'running', providers: [] });

function compatible(serverVersion: string, runs: readonly Run[], otherDevices = 0) {
  const calls: string[] = [];
  const daemon: CompatibleDaemon = {
    serverVersion,
    listRuns: async () => runs,
    otherDevices: () => otherDevices,
    shutdownWhenIdle: async () => {
      calls.push('shutdownWhenIdle');
    },
    shutdownNow: async () => {
      calls.push('shutdownNow');
    },
  };
  return { daemon, calls };
}

describe('a compatible daemon of another app version', () => {
  it('is attached as is when it runs this version', async () => {
    const { daemon, calls } = compatible('3.7.0', [chat('host-1', 'busy')]);
    expect(await adoptCompatibleDaemon('3.7.0', daemon, quiet)).toBe('current');
    expect(calls).toEqual([]);
  });

  it('keeps its runs: attached, it is asked to exit once idle, never stopped', async () => {
    const { daemon, calls } = compatible('3.6.9', [chat('host-1', 'Fix the parser')]);
    expect(await adoptCompatibleDaemon('3.7.0', daemon, quiet)).toBe('switchWhenIdle');
    expect(calls).toEqual(['shutdownWhenIdle']);
  });

  it('is kept alive by a terminal alone, which delays the switch until it closes', async () => {
    const { daemon, calls } = compatible('3.6.9', [terminal('term-1', 'bash')]);
    expect(await adoptCompatibleDaemon('3.7.0', daemon, quiet)).toBe('switchWhenIdle');
    expect(calls).toEqual(['shutdownWhenIdle']);
  });

  it('serving another device, waits for idle though it runs nothing', async () => {
    const { daemon, calls } = compatible('3.6.9', [], 1);
    expect(await adoptCompatibleDaemon('3.7.0', daemon, quiet)).toBe('switchWhenIdle');
    expect(calls).toEqual(['shutdownWhenIdle']);
  });

  it('idle and alone, is stopped now so this version starts', async () => {
    const { daemon, calls } = compatible('3.6.9', [], 0);
    expect(await adoptCompatibleDaemon('3.7.0', daemon, quiet)).toBe('replaceNow');
    expect(calls).toEqual(['shutdownNow']);
  });
});

// A frozen-commands-only daemon whose runs the test changes; its connection closes when the test says it exited.
function otherProtocol(initial: readonly Run[]) {
  let runs = initial;
  const requests: string[] = [];
  const closeListeners = new Set<(reason: string) => void>();
  const daemon = {
    serverVersion: '3.6.9',
    protocolVersion: 2,
    control: {
      request: vi.fn(async (method: string) => {
        requests.push(method);
        return method === 'listRuns' ? { runs } : undefined;
      }),
    },
    receiveStream: vi.fn(),
    onClose: (listener: (reason: string) => void) => {
      closeListeners.add(listener);
      return { dispose: () => { closeListeners.delete(listener); } };
    },
    close: vi.fn(),
  } as unknown as OtherProtocolDaemon;
  return {
    daemon,
    requests,
    setRuns: (next: readonly Run[]) => { runs = next; },
    exit: () => { for (const listener of [...closeListeners]) listener('the daemon exited'); },
  };
}

describe('a busy daemon of another protocol', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function follow(daemon: OtherProtocolDaemon, confirm: (listing: SwitchListing) => boolean = () => true) {
    const reconnect = vi.fn();
    const syncMirror = vi.fn(async () => undefined);
    const confirmed: SwitchListing[] = [];
    const host = followOtherProtocolDaemon({
      daemon,
      syncMirror,
      changed: quiet,
      reconnect,
      confirm: async (listing) => {
        confirmed.push(listing);
        return confirm(listing);
      },
      pollMs: 5000,
      log: quiet,
    });
    return { host, reconnect, syncMirror, confirmed };
  }

  it('shows its running agents read-only from the mirror, which the poll keeps live with the banner', async () => {
    const old = otherProtocol([chat('host-1', 'Fix the parser'), chat('host-2', 'Write docs'), terminal('term-1', 'bash')]);
    const { host, syncMirror } = follow(old.daemon);
    await vi.advanceTimersByTimeAsync(0);
    expect(host.update()).toEqual({ serverVersion: '3.6.9', runningAgents: 2, phase: 'offer' });
    expect(syncMirror).toHaveBeenCalledOnce();
    old.setRuns([chat('host-2', 'Write docs')]);
    await vi.advanceTimersByTimeAsync(5000);
    expect(host.update()).toEqual({ serverVersion: '3.6.9', runningAgents: 1, phase: 'offer' });
    expect(syncMirror).toHaveBeenCalledTimes(2);
    expect(old.requests).not.toContain('shutdownNow');
    host.dispose();
  });

  it('stopped at once when it runs nothing, and this version connects once it is gone', async () => {
    const old = otherProtocol([]);
    const { host, reconnect } = follow(old.daemon);
    await vi.advanceTimersByTimeAsync(0);
    expect(old.requests).toEqual(['listRuns', 'shutdownNow']);
    expect(host.update()).toBeUndefined();
    old.exit();
    expect(reconnect).toHaveBeenCalledOnce();
  });

  it('switches when they finish: asked to exit once idle, the banner waits, and its exit connects this version', async () => {
    const old = otherProtocol([chat('host-1', 'Fix the parser')]);
    const { host, reconnect } = follow(old.daemon);
    await vi.advanceTimersByTimeAsync(0);
    await host.switchWhenIdle();
    expect(old.requests).toContain('shutdownWhenIdle');
    expect(old.requests).not.toContain('shutdownNow');
    expect(host.update()?.phase).toBe('waiting');
    expect(reconnect).not.toHaveBeenCalled();
    old.exit();
    expect(host.update()).toBeUndefined();
    expect(reconnect).toHaveBeenCalledOnce();
  });

  it('switches now only after a confirmation that lists the agents that stop and the terminals that close', async () => {
    const old = otherProtocol([chat('host-1', 'Fix the parser'), terminal('term-1', 'bash')]);
    let accept = false;
    const { host, confirmed } = follow(old.daemon, () => accept);
    await vi.advanceTimersByTimeAsync(0);
    expect(await host.switchNow()).toBe(false);
    expect(old.requests).not.toContain('shutdownNow');
    accept = true;
    expect(await host.switchNow()).toBe(true);
    expect(confirmed).toEqual([
      { agents: ['Fix the parser'], terminals: ['bash'] },
      { agents: ['Fix the parser'], terminals: ['bash'] },
    ]);
    expect(old.requests.filter((method) => method === 'shutdownNow')).toHaveLength(1);
    host.dispose();
  });
});

describe('the update flows of every authority', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function start(followed: FollowedDaemons, authorityKey: string, daemon: OtherProtocolDaemon) {
    const reconnect = vi.fn();
    followed.follow(authorityKey, (ended) => followOtherProtocolDaemon({
      daemon,
      syncMirror: async () => undefined,
      changed: quiet,
      reconnect: () => {
        ended();
        reconnect();
      },
      confirm: async () => true,
      pollMs: 5000,
      log: quiet,
    }));
    return reconnect;
  }

  it('lets go of every flow at the quit, so the old daemons closing with the connections connect nothing', async () => {
    const followed = new FollowedDaemons();
    const first = otherProtocol([chat('host-1', 'Fix the parser')]);
    const second = otherProtocol([terminal('term-1', 'bash')]);
    const reconnects = [start(followed, 'ssh+h1', first.daemon), start(followed, 'ssh+h2', second.daemon)];
    await vi.advanceTimersByTimeAsync(0);
    followed.dispose();
    first.exit();
    second.exit();
    expect(reconnects.map((reconnect) => reconnect.mock.calls.length)).toEqual([0, 0]);
    expect(first.daemon.close).toHaveBeenCalled();
    expect(followed.has('ssh+h1') || followed.has('ssh+h2')).toBe(false);
  });

  it('Forget host lets go of that host\'s flow alone', async () => {
    const followed = new FollowedDaemons();
    const forgotten = otherProtocol([chat('host-1', 'Fix the parser')]);
    const kept = otherProtocol([chat('host-2', 'Write docs')]);
    const reconnects = [start(followed, 'ssh+h1', forgotten.daemon), start(followed, 'ssh+h2', kept.daemon)];
    await vi.advanceTimersByTimeAsync(0);
    followed.forget('ssh+h1');
    forgotten.exit();
    kept.exit();
    expect(reconnects.map((reconnect) => reconnect.mock.calls.length)).toEqual([0, 1]);
    expect(followed.has('ssh+h1')).toBe(false);
    // the kept host's flow ended with its daemon's exit
    expect(followed.has('ssh+h2')).toBe(false);
  });

  it('replaces an authority\'s flow, and keeps none whose daemon closed before it started', async () => {
    const followed = new FollowedDaemons();
    const before = otherProtocol([chat('host-1', 'Fix the parser')]);
    const after = otherProtocol([chat('host-1', 'Fix the parser')]);
    const reconnects = [start(followed, 'ssh+h1', before.daemon), start(followed, 'ssh+h1', after.daemon)];
    before.exit();
    expect(reconnects[0]).not.toHaveBeenCalled();
    expect(followed.get('ssh+h1')?.daemon).toBe(after.daemon);
    after.exit();
    expect(followed.has('ssh+h1')).toBe(false);
    const closed = otherProtocol([]);
    const closedDaemon = { ...closed.daemon, onClose: (listener: (reason: string) => void) => {
      listener('already closed');
      return { dispose: () => undefined };
    } } as OtherProtocolDaemon;
    start(followed, 'ssh+h1', closedDaemon);
    expect(followed.has('ssh+h1')).toBe(false);
  });
});

describe('the other devices of a daemon', () => {
  it('are unknown until the daemon listed this device, as one without the clients feature never does', () => {
    expect(otherDeviceCount([])).toBeUndefined();
    expect(otherDeviceCount([{ deviceName: 'laptop', self: true }])).toBe(0);
    expect(otherDeviceCount([{ deviceName: 'laptop', self: true }, { deviceName: 'desktop', self: false }])).toBe(1);
  });

  it('when unknown, an idle daemon is asked to exit once idle, never stopped at once', async () => {
    const { daemon, calls } = compatible('3.6.9', []);
    expect(await adoptCompatibleDaemon('3.7.0', { ...daemon, otherDevices: () => otherDeviceCount([]) }, quiet)).toBe('switchWhenIdle');
    expect(calls).toEqual(['shutdownWhenIdle']);
  });
});

describe('shutting a daemon down now', () => {
  function connection() {
    const listeners = new Set<() => void>();
    const subscribe = (listener: () => void) => {
      listeners.add(listener);
      return { dispose: () => { listeners.delete(listener); } };
    };
    const value = { control: { request: vi.fn(async () => undefined) }, onClose: subscribe, onLost: subscribe };
    return { value: value as unknown as Parameters<typeof shutDownNow>[0], listeners, end: () => { for (const listener of [...listeners]) listener(); } };
  }

  it('settles once the daemon ended the connection, and keeps no listener on it', async () => {
    const { value, listeners, end } = connection();
    let done = false;
    const shutting = shutDownNow(value, () => undefined).then(() => { done = true; });
    await vi.waitFor(() => expect(value.control.request).toHaveBeenCalledWith('shutdownNow', {}));
    expect(done).toBe(false);
    end();
    await shutting;
    expect(listeners.size).toBe(0);
  });

  it('stops waiting for a daemon that answered but never ended the connection', async () => {
    vi.useFakeTimers();
    try {
      const { value, listeners } = connection();
      const lines: string[] = [];
      let done = false;
      void shutDownNow(value, (line) => lines.push(line), 500).then(() => { done = true; });
      await vi.advanceTimersByTimeAsync(500);
      expect(done).toBe(true);
      expect(listeners.size).toBe(0);
      expect(lines).toEqual(['[update] the daemon answered shutdownNow but did not end the connection within 500 ms']);
    } finally {
      vi.useRealTimers();
    }
  });
});
