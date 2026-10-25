import { describe, expect, it, vi } from 'vitest';
import { TERMINAL_HIGH_WATERMARK_CHARS } from '../../preload/terminal-channels';
import type { HostMessage, HostRequest } from '../../pty-host/protocol';
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
});
