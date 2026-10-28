import { describe, expect, it, vi } from 'vitest';
import { TERMINAL_HIGH_WATERMARK_CHARS } from '../../preload/terminal-channels';
import { parseHostRequest, type HostMessage, type HostRequest } from '../../pty-host/protocol';
import { INVALID } from '../../core-protocol/schema';
import { CLIENT_TO_WORKSPACE } from '../../workspace/messages';
import { createPtyScreen } from '../../pty-host/screen';
import { createPtySessions, type Pty } from '../../pty-host/sessions';
import type { PtyHostProcess } from '../../workspace/host-starters';
import { createRunRegistry } from '../run-registry';
import { createTerminalHub, type HubClient } from '../terminal-hub';

class FakePty implements Pty {
  readonly pid = 42;
  readonly process = 'sh';
  paused = false;
  pauses = 0;
  private dataListener: (data: string) => void = () => undefined;
  onData(listener: (data: string) => void): void {
    this.dataListener = listener;
  }
  onExit(): void {}
  print(data: string): void {
    this.dataListener(data);
  }
  write(): void {}
  resize(): void {}
  pause(): void {
    this.paused = true;
    this.pauses++;
  }
  resume(): void {
    this.paused = false;
  }
  kill(): void {}
}

const SPAWN: Extract<HostRequest, { type: 'spawn' }> = { type: 'spawn', id: 'term-1', file: '/bin/sh', args: [], cwd: '/', env: {}, cols: 80, rows: 24, scrollback: 1000 };

function sessionsWith(selfAcknowledge: boolean): { sessions: ReturnType<typeof createPtySessions>; pty: FakePty; posted: HostMessage[] } {
  const pty = new FakePty();
  const posted: HostMessage[] = [];
  const sessions = createPtySessions({ spawn: () => pty, post: (message) => posted.push(message), throttleConpty: false, readProcessName: false, screen: createPtyScreen, selfAcknowledge, log: () => undefined });
  return { sessions, pty, posted };
}

describe('terminal flow control on the daemon', () => {
  it('never blocks a terminal that prints 1 MB while no client is attached', async () => {
    const { sessions, pty } = sessionsWith(true);
    await sessions.handle(SPAWN);
    const line = `${'x'.repeat(1023)}\n`;
    for (let index = 0; index < 1024; index++) pty.print(line);
    // the screen has consumed everything once a serialize answers
    await sessions.handle({ type: 'serialize', id: 'term-1' });
    expect(pty.paused).toBe(false);
  });

  it('leaves the pty paused without acks when the host does not acknowledge itself', async () => {
    const { sessions, pty } = sessionsWith(false);
    await sessions.handle(SPAWN);
    pty.print('x'.repeat(TERMINAL_HIGH_WATERMARK_CHARS + 1));
    await sessions.handle({ type: 'serialize', id: 'term-1' });
    expect(pty.paused).toBe(true);
  });

  it('ignores a client\'s acks in self-acknowledging mode', async () => {
    const { sessions, pty } = sessionsWith(true);
    await sessions.handle(SPAWN);
    pty.print('x'.repeat(TERMINAL_HIGH_WATERMARK_CHARS + 1));
    await sessions.handle({ type: 'ack', id: 'term-1', chars: 1 });
    await sessions.handle({ type: 'serialize', id: 'term-1' });
    expect(pty.paused).toBe(false);
  });

  it('cuts a slow client off and serves it a fresh screen once it caught up, without slowing the others', () => {
    const toHost: HostRequest[] = [];
    let fromHost: (message: unknown) => void = () => undefined;
    const host: PtyHostProcess = {
      postMessage: (message) => toHost.push(message),
      onMessage: (listener) => { fromHost = listener; },
      onExit: () => undefined,
      kill: () => undefined,
    };
    const hub = createTerminalHub({ start: () => host, registry: createRunRegistry(), log: () => undefined });
    const received = new Map<string, string[]>();
    const client = (id: string): HubClient => {
      received.set(id, []);
      return { id, message: (message) => received.get(id)!.push(message.type === 'data' ? `data:${message.data.length}` : message.type), hostExit: () => undefined };
    };
    const fast = client('fast');
    const slow = client('slow');
    hub.post(fast, SPAWN, '/srv/app');
    fromHost({ type: 'ready', id: 'term-1', pid: 42 });
    hub.post(slow, { type: 'serialize', id: 'term-1' }, undefined);
    fromHost({ type: 'screen', id: 'term-1', data: '', cols: 80, rows: 24, marks: [], sequences: 0 });
    const chunk = 'y'.repeat(60_000);
    for (let index = 0; index < 4; index++) {
      fromHost({ type: 'data', id: 'term-1', data: chunk });
      hub.post(fast, { type: 'ack', id: 'term-1', chars: chunk.length }, undefined);
    }
    expect(received.get('fast')).toEqual(['ready', 'data:60000', 'data:60000', 'data:60000', 'data:60000']);
    // the slow client passed the high watermark after its second chunk and gets nothing live since
    expect(received.get('slow')).toEqual(['screen', 'data:60000', 'data:60000']);
    expect(toHost.filter((request) => request.type === 'serialize')).toHaveLength(1);
    hub.post(slow, { type: 'ack', id: 'term-1', chars: 116_000 }, undefined);
    // under the low watermark: the hub asks for a fresh screen for it alone
    expect(toHost.filter((request) => request.type === 'serialize')).toHaveLength(2);
    fromHost({ type: 'data', id: 'term-1', data: chunk });
    fromHost({ type: 'screen', id: 'term-1', data: 'fresh', cols: 80, rows: 24, marks: [], sequences: 0 });
    fromHost({ type: 'data', id: 'term-1', data: 'z' });
    expect(received.get('slow')).toEqual(['screen', 'data:60000', 'data:60000', 'screen', 'data:1']);
    expect(received.get('fast')!.slice(-2)).toEqual(['data:60000', 'data:1']);
    // no client ever acknowledged the pty host itself
    expect(toHost.some((request) => request.type === 'ack')).toBe(false);
  });

  it('kills a pty host that does not end within its shutdown limit', async () => {
    vi.useFakeTimers();
    try {
      let exited: (exit: { code: number; reason: null; error: null }) => void = () => undefined;
      const toHost: HostRequest[] = [];
      let killed = false;
      const hub = createTerminalHub({
        start: () => ({
          postMessage: (message) => toHost.push(message),
          onMessage: () => undefined,
          onExit: (listener) => { exited = listener; },
          kill: () => {
            killed = true;
            exited({ code: 1, reason: null, error: null });
          },
        }),
        registry: createRunRegistry(),
        log: () => undefined,
      });
      hub.post({ id: 'a', message: () => undefined, hostExit: () => undefined }, SPAWN, '/srv/app');
      let done = false;
      void hub.shutdown().then(() => {
        done = true;
      });
      await vi.advanceTimersByTimeAsync(1999);
      expect(toHost.at(-1)).toEqual({ type: 'shutdown' });
      expect(killed).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(killed).toBe(true);
      expect(done).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps the scrollback the largest attached client asks for, and leaves it when a client detaches', () => {
    const toHost: HostRequest[] = [];
    const hub = createTerminalHub({
      start: () => ({ postMessage: (message) => toHost.push(message), onMessage: () => undefined, onExit: () => undefined, kill: () => undefined }),
      registry: createRunRegistry(),
      log: () => undefined,
    });
    const scrollbacks = (): number[] => toHost.flatMap((request) => (request.type === 'scrollback' ? [request.scrollback] : []));
    const a: HubClient = { id: 'a', message: () => undefined, hostExit: () => undefined };
    const b: HubClient = { id: 'b', message: () => undefined, hostExit: () => undefined };
    hub.post(a, SPAWN, '/srv/app');
    hub.post(b, { type: 'serialize', id: 'term-1' }, undefined);
    hub.post(b, { type: 'scrollback', id: 'term-1', scrollback: 500 }, undefined);
    expect(scrollbacks()).toEqual([]);
    hub.post(b, { type: 'scrollback', id: 'term-1', scrollback: 5000 }, undefined);
    hub.post(a, { type: 'scrollback', id: 'term-1', scrollback: 200 }, undefined);
    expect(scrollbacks()).toEqual([5000]);
    hub.detach(b);
    expect(scrollbacks()).toEqual([5000]);
    // b comes back and posts its own again: the screen kept its history for it
    hub.post(b, { type: 'serialize', id: 'term-1' }, undefined);
    hub.post(b, { type: 'scrollback', id: 'term-1', scrollback: 5000 }, undefined);
    hub.post(a, { type: 'scrollback', id: 'term-1', scrollback: 100 }, undefined);
    expect(scrollbacks()).toEqual([5000]);
    hub.detach(b);
    hub.post(a, { type: 'scrollback', id: 'term-1', scrollback: 300 }, undefined);
    expect(scrollbacks()).toEqual([5000, 300]);
  });

  it('keeps a terminal when its clients detach, and ends it on kill for every viewer', () => {
    const toHost: HostRequest[] = [];
    let fromHost: (message: unknown) => void = () => undefined;
    const registry = createRunRegistry();
    const hub = createTerminalHub({
      start: () => ({ postMessage: (message) => toHost.push(message), onMessage: (listener) => { fromHost = listener; }, onExit: () => undefined, kill: () => undefined }),
      registry,
      log: () => undefined,
    });
    const seen: string[] = [];
    const a: HubClient = { id: 'a', message: () => undefined, hostExit: () => undefined };
    const b: HubClient = { id: 'b', message: (message) => seen.push(message.type), hostExit: () => undefined };
    hub.post(a, SPAWN, '/srv/app');
    fromHost({ type: 'ready', id: 'term-1', pid: 42 });
    hub.detach(a);
    expect(hub.list()).toEqual([{ id: 'term-1', pid: 42, cols: 80, rows: 24 }]);
    expect(registry.runs()).toEqual([{ kind: 'terminal', id: 'term-1', projectKey: '/srv/app', title: 'sh', state: 'running', providers: [] }]);
    hub.post(b, { type: 'serialize', id: 'term-1' }, undefined);
    hub.post(a, SPAWN, undefined);
    hub.post(a, { type: 'serialize', id: 'term-1' }, undefined);
    hub.post(a, { type: 'kill', id: 'term-1' }, undefined);
    expect(toHost.map((request) => request.type)).toEqual(['spawn', 'serialize', 'serialize', 'kill']);
    expect(seen).toEqual(['exit']);
    expect(registry.isEmpty()).toBe(true);
    expect(hub.list()).toEqual([]);
  });

  it('shares one terminal between two devices: both type, each gets the output, one view closing leaves the other, a kill from a device that never viewed it ends it for both', () => {
    const toHost: HostRequest[] = [];
    let fromHost: (message: unknown) => void = () => undefined;
    const registry = createRunRegistry();
    const hub = createTerminalHub({
      start: () => ({ postMessage: (message) => toHost.push(message), onMessage: (listener) => { fromHost = listener; }, onExit: () => undefined, kill: () => undefined }),
      registry,
      log: () => undefined,
    });
    const received = new Map<string, string[]>();
    const device = (id: string): HubClient => {
      received.set(id, []);
      return { id, message: (message) => received.get(id)!.push(message.type === 'data' ? `data:${message.data}` : message.type), hostExit: () => undefined };
    };
    const a = device('a');
    const b = device('b');
    const c = device('c');
    const view = { root: '/srv/app', profile: { id: 'bash', name: 'bash', file: '/bin/bash', args: [], icon: 'bash' as const }, startCwd: '/srv/app', nonce: '0123456789abcdef0123456789abcdef' };
    hub.post(a, { ...SPAWN, view }, '/srv/app');
    fromHost({ type: 'ready', id: 'term-1', pid: 42 });
    // another device finds what it needs to show the terminal
    expect(hub.list()).toEqual([{ id: 'term-1', pid: 42, cols: 80, rows: 24, view }]);
    hub.post(b, { type: 'serialize', id: 'term-1' }, undefined);
    fromHost({ type: 'screen', id: 'term-1', data: '$ ', cols: 80, rows: 24, marks: [], sequences: 0 });
    hub.post(a, { type: 'input', id: 'term-1', data: 'ls\r' }, undefined);
    hub.post(b, { type: 'input', id: 'term-1', data: 'pwd\r' }, undefined);
    // a device that views nothing types into nothing
    hub.post(c, { type: 'input', id: 'term-1', data: 'rm -rf ~\r' }, undefined);
    expect(toHost.filter((request) => request.type === 'input')).toEqual([{ type: 'input', id: 'term-1', data: 'ls\r' }, { type: 'input', id: 'term-1', data: 'pwd\r' }]);
    fromHost({ type: 'data', id: 'term-1', data: 'one' });
    expect(received.get('a')).toEqual(['ready', 'data:one']);
    expect(received.get('b')).toEqual(['screen', 'data:one']);
    // a closes its tab: the terminal runs on, b still gets its output, a gets none
    hub.post(a, { type: 'detach', id: 'term-1' }, undefined);
    fromHost({ type: 'data', id: 'term-1', data: 'two' });
    expect(received.get('a')).toEqual(['ready', 'data:one']);
    expect(received.get('b')).toEqual(['screen', 'data:one', 'data:two']);
    expect(toHost.some((request) => request.type === 'kill' || request.type === 'detach')).toBe(false);
    expect(hub.list()).toHaveLength(1);
    // the host card's Kill on a device that never opened it ends it, and every viewer sees the exit
    hub.post(c, { type: 'kill', id: 'term-1' }, undefined);
    expect(toHost.at(-1)).toEqual({ type: 'kill', id: 'term-1' });
    expect(received.get('b')!.at(-1)).toBe('exit');
    expect(received.get('c')).toEqual([]);
    expect(hub.list()).toEqual([]);
    expect(registry.isEmpty()).toBe(true);
  });

  it('takes a spawn\'s view and a view\'s detach over the wire only within the contract', () => {
    const view = { root: '/srv/app\u0000wt-1', profile: { id: 'bash', name: 'bash', file: '/bin/bash', args: ['-l'], icon: 'bash' }, startCwd: '/srv/app', nonce: 'ab'.repeat(16) };
    const post = CLIENT_TO_WORKSPACE.events['terminals.post'];
    expect(post({ request: { ...SPAWN, view } })).toEqual({ request: { ...SPAWN, view } });
    expect(post({ request: { type: 'detach', id: 'term-1' } })).toEqual({ request: { type: 'detach', id: 'term-1' } });
    expect(post({ request: { ...SPAWN, view: { ...view, nonce: 'not-a-nonce' } } })).toBe(INVALID);
    expect(post({ request: { ...SPAWN, view: { ...view, profile: { ...view.profile, icon: 'evil' } } } })).toBe(INVALID);
    expect(parseHostRequest({ ...SPAWN, view: { ...view, startCwd: '' } })).toBeUndefined();
    const listed = CLIENT_TO_WORKSPACE.requests['terminals.list'].result;
    expect(listed([{ id: 'term-1', pid: 1, cols: 80, rows: 24, view }])).toEqual([{ id: 'term-1', pid: 1, cols: 80, rows: 24, view }]);
    expect(listed([{ id: 'term-1', pid: 1, cols: 80, rows: 24 }])).toEqual([{ id: 'term-1', pid: 1, cols: 80, rows: 24 }]);
  });

  it('starts the idle clock once the last view of a terminal closes while its device stays connected', () => {
    let fromHost: (message: unknown) => void = () => undefined;
    const attached: number[] = [];
    const registry = createRunRegistry();
    const setAttached = registry.setAttached.bind(registry);
    registry.setAttached = (id, connections) => {
      attached.push(connections);
      setAttached(id, connections);
    };
    const hub = createTerminalHub({
      start: () => ({ postMessage: () => undefined, onMessage: (listener) => { fromHost = listener; }, onExit: () => undefined, kill: () => undefined }),
      registry,
      log: () => undefined,
    });
    const a: HubClient = { id: 'a', message: () => undefined, hostExit: () => undefined };
    const b: HubClient = { id: 'b', message: () => undefined, hostExit: () => undefined };
    hub.post(a, SPAWN, '/srv/app');
    fromHost({ type: 'ready', id: 'term-1', pid: 42 });
    hub.post(b, { type: 'serialize', id: 'term-1' }, undefined);
    hub.post(b, { type: 'detach', id: 'term-1' }, undefined);
    hub.post(a, { type: 'detach', id: 'term-1' }, undefined);
    expect(attached).toEqual([1, 2, 1, 0]);
  });

  it('keeps feeding a fast device while a slow one sits past its window, with input from both', () => {
    const toHost: HostRequest[] = [];
    let fromHost: (message: unknown) => void = () => undefined;
    const hub = createTerminalHub({
      start: () => ({ postMessage: (message) => toHost.push(message), onMessage: (listener) => { fromHost = listener; }, onExit: () => undefined, kill: () => undefined }),
      registry: createRunRegistry(),
      log: () => undefined,
    });
    const counts = new Map<string, number>([['fast', 0], ['slow', 0]]);
    const device = (id: string): HubClient => ({ id, message: (message) => { if (message.type === 'data') counts.set(id, counts.get(id)! + message.data.length); }, hostExit: () => undefined });
    const fast = device('fast');
    const slow = device('slow');
    hub.post(fast, SPAWN, '/srv/app');
    fromHost({ type: 'ready', id: 'term-1', pid: 42 });
    hub.post(slow, { type: 'serialize', id: 'term-1' }, undefined);
    fromHost({ type: 'screen', id: 'term-1', data: '', cols: 80, rows: 24, marks: [], sequences: 0 });
    const chunk = 'x'.repeat(10_000);
    for (let index = 0; index < 100; index++) {
      fromHost({ type: 'data', id: 'term-1', data: chunk });
      hub.post(fast, { type: 'ack', id: 'term-1', chars: chunk.length }, undefined);
    }
    expect(counts.get('fast')).toBe(1_000_000);
    expect(counts.get('slow')).toBeLessThanOrEqual(TERMINAL_HIGH_WATERMARK_CHARS + chunk.length);
    // the slow device is behind on output, not on input
    hub.post(slow, { type: 'input', id: 'term-1', data: 'q' }, undefined);
    expect(toHost.at(-1)).toEqual({ type: 'input', id: 'term-1', data: 'q' });
    expect(toHost.some((request) => request.type === 'ack')).toBe(false);
  });
});
