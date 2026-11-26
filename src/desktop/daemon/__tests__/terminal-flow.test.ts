import { describe, expect, it, vi } from 'vitest';
import type { StreamChannel } from '../../../remote/mux';
import { TERMINAL_HIGH_WATERMARK_CHARS } from '../../preload/terminal-channels';
import { parseHostRequest, type HostMessage, type HostRequest } from '../../pty-host/protocol';
import { INVALID } from '../../core-protocol/schema';
import { CLIENT_TO_WORKSPACE, WORKSPACE_TO_CLIENT } from '../../workspace/messages';
import { createPtyScreen } from '../../pty-host/screen';
import { createPtySessions, PROCESS_NAME_THROTTLE_MS, type Pty } from '../../pty-host/sessions';
import { MAX_HOSTED_VIEW_CHARS, ptySpawn, type HostedTerminal, type TerminalHostSpawn } from '../../terminal-host/host-messages';
import { createRunRegistry } from '../run-registry';
import { createTerminalHub, MAX_QUEUED_HOST_CHARS, MAX_QUEUED_HOST_REQUESTS, type HubClient } from '../terminal-hub';
import { fakeHost, fakeHosts, settled, type FakeHost, type Sent } from './fake-terminal-host';

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

function hubWith(current: FakeHost = fakeHost(100, 'own'), log: (line: string) => void = () => undefined) {
  const registry = createRunRegistry();
  const hosts = fakeHosts(current);
  const hub = createTerminalHub({ hosts: hosts.hosts, registry, log });
  return { hub, registry, hosts, host: current, toHost: current.sent, fromHost: current.fromHost };
}

const types = (sent: readonly Sent[]): string[] => sent.map((entry) => entry.type);
const quiet: HubClient = { id: 'quiet', message: () => undefined };

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

  it('cuts a slow client off and serves it a fresh screen once it caught up, without slowing the others, and acknowledges the host on receipt', async () => {
    const { hub, toHost, fromHost } = hubWith();
    const received = new Map<string, string[]>();
    const client = (id: string): HubClient => {
      received.set(id, []);
      return { id, message: (message) => received.get(id)!.push(message.type === 'data' ? `data:${message.data.length}` : message.type) };
    };
    const fast = client('fast');
    const slow = client('slow');
    hub.post(fast, SPAWN, '/srv/app');
    await settled();
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
    // the host is acknowledged for each data as it arrived, whatever any client acknowledged
    expect(toHost.filter((request) => request.type === 'ack')).toEqual([...Array.from({ length: 5 }, () => ({ type: 'ack', id: 'term-1', chars: 60_000 })), { type: 'ack', id: 'term-1', chars: 1 }]);
  });

  it('acknowledges output of a terminal it does not list, so the host never pauses that pty', () => {
    const { hosts, host } = hubWith();
    hosts.adopt(host);
    host.fromHost({ type: 'data', id: 'term-9', data: 'abc' });
    expect(host.sent).toEqual([{ type: 'ack', id: 'term-9', chars: 3 }]);
  });

  it('ends its terminals through the hosts or releases them, as asked', async () => {
    const { hub, hosts } = hubWith();
    await hub.endTerminals('attached');
    hub.release('the daemon is shutting down');
    expect(hosts.calls).toEqual(['endAll', 'release: the daemon is shutting down']);
  });

  it('keeps the scrollback the largest attached client asks for, and leaves it when a client detaches', async () => {
    const { hub, toHost } = hubWith();
    const scrollbacks = (): unknown[] => toHost.flatMap((request) => (request.type === 'scrollback' ? [request['scrollback']] : []));
    const a: HubClient = { id: 'a', message: () => undefined };
    const b: HubClient = { id: 'b', message: () => undefined };
    hub.post(a, SPAWN, '/srv/app');
    await settled();
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

  it('sends what a client asks of a terminal still starting once its host is attached, after the spawn and in order', async () => {
    const { hub, toHost } = hubWith();
    hub.post(quiet, SPAWN, '/srv/app');
    hub.post(quiet, { type: 'resize', id: 'term-1', cols: 100, rows: 30 }, undefined);
    hub.post(quiet, { type: 'input', id: 'term-1', data: 'ls\r' }, undefined);
    expect(toHost).toEqual([]);
    await settled();
    expect(toHost).toEqual([
      { type: 'spawn', id: 'term-1', file: '/bin/sh', args: [], cwd: '/', env: {}, cols: 80, rows: 24, scrollback: 1000, title: 'sh', projectKey: '/srv/app', endpoints: { cli: false, relay: false } },
      { type: 'resize', id: 'term-1', cols: 100, rows: 30 },
      { type: 'input', id: 'term-1', data: 'ls\r' },
    ]);
  });

  it('asks the host for the credential endpoints the spawn\'s environment names, and hands it the host\'s agent and relay connections', async () => {
    const host = fakeHost(100, 'own');
    const forwarded: string[] = [];
    const hub = createTerminalHub({
      hosts: fakeHosts(host).hosts,
      registry: createRunRegistry(),
      credentialEndpoints: (env) => ({ relay: env['DAMOCLES_CREDENTIAL_NONCE'] === 'daemon', ...(env['SSH_AUTH_SOCK'] === '/daemon/agent.sock' ? { agentKey: 'a'.repeat(24) } : {}) }),
      forward: (connection) => forwarded.push(connection.kind === 'agent' ? `agent ${connection.key}` : connection.kind),
      log: () => undefined,
    });
    hub.post(quiet, { ...SPAWN, env: { DAMOCLES_CREDENTIAL_NONCE: 'daemon', SSH_AUTH_SOCK: '/daemon/agent.sock' } }, '/srv/app');
    await settled();
    expect(host.sent[0]).toMatchObject({ type: 'spawn', endpoints: { cli: false, relay: true, agentKey: 'a'.repeat(24) } });
    const stream = { id: 17 } as StreamChannel;
    host.forward({ kind: 'agent', key: 'a'.repeat(24), stream });
    host.forward({ kind: 'relay', stream });
    expect(forwarded).toEqual([`agent ${'a'.repeat(24)}`, 'relay']);
  });

  it('answers error, and keeps no terminal, when no terminal host can be started', async () => {
    const registry = createRunRegistry();
    const lines: string[] = [];
    const hub = createTerminalHub({
      hosts: { ...fakeHosts(fakeHost(100, 'own')).hosts, currentHost: () => Promise.reject(new Error('the terminal host 7 wrote no record within 30000 ms')) },
      registry,
      log: (line) => lines.push(line),
    });
    const seen: HostMessage[] = [];
    hub.post({ id: 'a', message: (message) => seen.push(message) }, SPAWN, '/srv/app');
    await settled();
    expect(seen).toEqual([{ type: 'error', id: 'term-1', message: 'terminal term-1 could not start on this host' }]);
    expect(lines).toEqual(['[terminal] term-1 did not start: the terminal host 7 wrote no record within 30000 ms']);
    expect(registry.isEmpty()).toBe(true);
    expect(hub.list()).toEqual([]);
  });

  // the host may have started the shell before the link closed, and lists it to the next link if so
  it('keeps a terminal whose spawn its link closed under, and lets that host\'s next list settle it', async () => {
    for (const relisted of [true, false]) {
      const logs: string[] = [];
      const current: FakeHost = fakeHost(100, 'own', [], (sent) => {
        if (sent.type === 'spawn') current.link.close('nothing arrived for 20000 ms');
      });
      const { hub, hosts } = hubWith(current, (line) => logs.push(line));
      const seen: string[] = [];
      hub.post({ id: 'a', message: (message) => seen.push(`${message.type} ${message.id}`) }, SPAWN, '/srv/app');
      await settled();
      expect(seen).toEqual([]);
      expect(logs).toEqual(['[terminal] term-1 waits for its terminal host 100, whose link closed before it answered the spawn']);
      const again = fakeHost(100, 'own', relisted ? [{ id: 'term-1', pid: 42, cols: 80, rows: 24, scrollback: 1000, title: 'sh', projectKey: '/srv/app' }] : []);
      hosts.adopt(again);
      if (relisted) {
        expect(hub.list()).toEqual([{ id: 'term-1', pid: 42, cols: 80, rows: 24 }]);
        expect(again.sent).toEqual([{ type: 'viewed', id: 'term-1', viewed: true }, { type: 'serialize', id: 'term-1' }]);
      } else {
        expect(seen).toEqual(['exit term-1']);
      }
    }
  });

  it('keeps a terminal when its clients detach, and ends it for every viewer once the host reports the kill', async () => {
    const { hub, registry, toHost, fromHost } = hubWith();
    const seen: string[] = [];
    const a: HubClient = { id: 'a', message: () => undefined };
    const b: HubClient = { id: 'b', message: (message) => seen.push(message.type) };
    hub.post(a, SPAWN, '/srv/app');
    await settled();
    fromHost({ type: 'ready', id: 'term-1', pid: 42 });
    hub.detach(a);
    expect(hub.list()).toEqual([{ id: 'term-1', pid: 42, cols: 80, rows: 24 }]);
    expect(registry.runs()).toEqual([{ kind: 'terminal', id: 'term-1', projectKey: '/srv/app', title: 'sh', state: 'running', providers: [] }]);
    hub.post(b, { type: 'serialize', id: 'term-1' }, undefined);
    hub.post(a, SPAWN, undefined);
    hub.post(a, { type: 'serialize', id: 'term-1' }, undefined);
    hub.post(a, { type: 'kill', id: 'term-1' }, undefined);
    expect(types(toHost)).toEqual(['spawn', 'viewed', 'viewed', 'serialize', 'serialize', 'kill']);
    // the terminal is the host's until the host says it ended
    expect(seen).toEqual([]);
    await settled();
    expect(seen).toEqual(['exit']);
    expect(registry.isEmpty()).toBe(true);
    expect(hub.list()).toEqual([]);
  });

  it('shares one terminal between two devices: both type, each gets the output, one view closing leaves the other, a kill from a device that never viewed it ends it for both', async () => {
    const { hub, registry, toHost, fromHost } = hubWith();
    const received = new Map<string, string[]>();
    const device = (id: string): HubClient => {
      received.set(id, []);
      return { id, message: (message) => received.get(id)!.push(message.type === 'data' ? `data:${message.data}` : message.type) };
    };
    const a = device('a');
    const b = device('b');
    const c = device('c');
    const view = { root: '/srv/app', profile: { id: 'bash', name: 'bash', file: '/bin/bash', args: [], icon: 'bash' as const }, startCwd: '/srv/app', nonce: '0123456789abcdef0123456789abcdef' };
    hub.post(a, { ...SPAWN, view }, '/srv/app');
    await settled();
    // the host keeps the view as text it never parses
    expect(toHost[0]).toMatchObject({ type: 'spawn', view: JSON.stringify(view) });
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
    expect(toHost.some((request) => request.type === 'kill' || request.type === 'viewed')).toBe(false);
    expect(hub.list()).toHaveLength(1);
    // the host card's Kill on a device that never opened it ends it, and every viewer sees the exit
    hub.post(c, { type: 'kill', id: 'term-1' }, undefined);
    expect(toHost.at(-1)).toEqual({ type: 'kill', id: 'term-1' });
    await settled();
    expect(received.get('b')!.at(-1)).toBe('exit');
    expect(received.get('c')).toEqual([]);
    expect(hub.list()).toEqual([]);
    expect(registry.isEmpty()).toBe(true);
  });

  it('refuses a spawn whose view is longer than a terminal host keeps, and sends the host nothing', async () => {
    const { hub, registry, toHost } = hubWith();
    const seen: HostMessage[] = [];
    // longer than any view the client contract lets through, so only a later contract could send it
    const view = { root: 'r'.repeat(MAX_HOSTED_VIEW_CHARS), profile: { id: 'bash', name: 'bash', file: '/bin/bash', args: [], icon: 'bash' as const }, startCwd: '/srv/app', nonce: '0123456789abcdef0123456789abcdef' };
    hub.post({ id: 'a', message: (message) => seen.push(message) }, { ...SPAWN, view }, '/srv/app');
    await settled();
    expect(seen).toEqual([{ type: 'error', id: 'term-1', message: 'terminal term-1 names a profile and folder longer than a terminal host keeps' }]);
    expect(toHost).toEqual([]);
    expect(registry.isEmpty()).toBe(true);
  });

  it('forwards a screen\'s kept shell-integration payloads, process name and host clock to a client that attaches later', async () => {
    const nonce = '0123456789abcdef0123456789abcdef';
    const pty = new FakePty();
    // a host's sessions, in process; its foreground process name is read and posted
    const sessions = createPtySessions({ spawn: () => pty, post: (message) => host.fromHost(structuredClone(message)), throttleConpty: false, readProcessName: true, screen: createPtyScreen, selfAcknowledge: true, log: () => undefined });
    const host = fakeHost(100, 'own', [], (sent) => {
      if (sent.type === 'spawn') void sessions.handle(ptySpawn(sent as unknown as TerminalHostSpawn));
      else if (sent.type === 'serialize') void sessions.handle({ type: 'serialize', id: 'term-1' });
    });
    const { hub } = hubWith(host);
    const screens: HostMessage[] = [];
    const named: HostMessage[] = [];
    const starter: HubClient = { id: 'starter', message: (message) => { if (message.type === 'process') named.push(message); } };
    const relaunched: HubClient = { id: 'relaunched', message: (message) => { if (message.type === 'screen') screens.push(message); } };
    hub.post(starter, SPAWN, '/srv/app');
    await vi.waitFor(() => expect(hub.list()).toHaveLength(1));
    pty.print(`\x1b]633;A;${nonce}\x07$ \x1b]633;B;${nonce}\x07`);
    // the process name is read a moment after output
    await vi.waitFor(() => expect(named).toEqual([{ type: 'process', id: 'term-1', name: 'sh' }]), { timeout: PROCESS_NAME_THROTTLE_MS + 1000 });
    hub.detach(starter);
    hub.post(relaunched, { type: 'serialize', id: 'term-1' }, undefined);
    await vi.waitFor(() => expect(screens).toHaveLength(1));
    const expected = { shellSequences: [{ index: 0, body: `A;${nonce}`, time: expect.any(Number) }, { index: 1, body: `B;${nonce}`, time: expect.any(Number) }], processName: 'sh', now: expect.any(Number) };
    expect(screens[0]).toMatchObject({ type: 'screen', id: 'term-1', sequences: 2, ...expected });
    // and over the workspace channel to the client
    expect(WORKSPACE_TO_CLIENT.events['terminals.message']({ message: screens[0] })).toMatchObject({ message: expected });
  });

  // a host of another version answers by the frozen bounds, which a client's contract may not hold
  it('drops only the optional screen field a client would refuse, with a log line, and keeps the link and its terminals', async () => {
    const logs: string[] = [];
    const { hub, host, fromHost } = hubWith(fakeHost(100, 'own'), (line) => logs.push(line));
    const screens: HostMessage[] = [];
    const client: HubClient = { id: 'a', message: (message) => { if (message.type === 'screen') screens.push(message); } };
    hub.post(client, SPAWN, '/srv/app');
    await settled();
    fromHost({ type: 'ready', id: 'term-1', pid: 42 });
    hub.post(client, { type: 'serialize', id: 'term-1' }, undefined);
    fromHost({ type: 'screen', id: 'term-1', data: '$ ', cols: 80, rows: 24, marks: [], sequences: 1, shellSequences: [{ index: 1, body: 'A;x', time: 1 }], processName: 'sh', now: 2 });
    expect(host.closed()).toBe(false);
    expect(screens).toEqual([{ type: 'screen', id: 'term-1', data: '$ ', cols: 80, rows: 24, marks: [], sequences: 1, processName: 'sh', now: 2 }]);
    expect(logs).toContain('[terminal] dropped the shellSequences of term-1\'s screen, which is outside the contract');
    expect(hub.list()).toHaveLength(1);
  });

  it('sends live output again to a client whose screen was outside the contract, and says so', async () => {
    const logs: string[] = [];
    const { hub, fromHost } = hubWith(fakeHost(100, 'own'), (line) => logs.push(line));
    const seen: string[] = [];
    const client: HubClient = { id: 'a', message: (message) => seen.push(message.type === 'data' ? `data:${message.data}` : message.type) };
    hub.post(quiet, SPAWN, '/srv/app');
    await settled();
    fromHost({ type: 'ready', id: 'term-1', pid: 42 });
    hub.post(client, { type: 'serialize', id: 'term-1' }, undefined);
    fromHost({ type: 'screen', id: 'term-1', data: '$ ', cols: 0, rows: 24, marks: [], sequences: 0 });
    fromHost({ type: 'data', id: 'term-1', data: 'x' });
    expect(seen).toEqual(['data:x']);
    expect(logs).toEqual(['[terminal] dropped a screen of term-1 from the terminal host 100, which is outside the contract', '[terminal] a gets the live output of term-1 without the screen it asked for']);
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

  it('tells the host when the last view of a terminal closes and when one comes back, and nothing in between', async () => {
    const { hub, toHost, fromHost } = hubWith();
    const viewed = (): unknown[] => toHost.flatMap((request) => (request.type === 'viewed' ? [request['viewed']] : []));
    const a: HubClient = { id: 'a', message: () => undefined };
    const b: HubClient = { id: 'b', message: () => undefined };
    hub.post(a, SPAWN, '/srv/app');
    await settled();
    fromHost({ type: 'ready', id: 'term-1', pid: 42 });
    hub.post(b, { type: 'serialize', id: 'term-1' }, undefined);
    hub.post(b, { type: 'detach', id: 'term-1' }, undefined);
    // a host counts a terminal it just started as viewed
    expect(viewed()).toEqual([]);
    hub.post(a, { type: 'detach', id: 'term-1' }, undefined);
    expect(viewed()).toEqual([false]);
    hub.post(b, { type: 'serialize', id: 'term-1' }, undefined);
    hub.post(a, { type: 'serialize', id: 'term-1' }, undefined);
    expect(viewed()).toEqual([false, true]);
    // a device that goes away with its views open
    hub.detach(a);
    hub.detach(b);
    expect(viewed()).toEqual([false, true, false]);
  });

  it('keeps feeding a fast device while a slow one sits past its window, with input from both', async () => {
    const { hub, toHost, fromHost } = hubWith();
    const counts = new Map<string, number>([['fast', 0], ['slow', 0]]);
    const device = (id: string): HubClient => ({ id, message: (message) => { if (message.type === 'data') counts.set(id, counts.get(id)! + message.data.length); } });
    const fast = device('fast');
    const slow = device('slow');
    hub.post(fast, SPAWN, '/srv/app');
    await settled();
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
    // the host got every character acknowledged, so the slow device never paused the pty
    expect(toHost.filter((request) => request.type === 'ack')).toHaveLength(100);
  });
});

describe('the daemon\'s terminals across its terminal hosts', () => {
  const view = { root: '/srv/app', profile: { id: 'bash', name: 'bash', file: '/bin/bash', args: [], icon: 'bash' as const }, startCwd: '/srv/app', nonce: '0123456789abcdef0123456789abcdef' };
  const held = (id: string, extra: Partial<HostedTerminal> = {}): HostedTerminal => ({ id, pid: 7, cols: 120, rows: 40, scrollback: 2000, title: 'bash', projectKey: '/srv/app', ...extra });

  it('lists the terminals of every host it attached to, an older version\'s included, as terminals and as runs', () => {
    const { hub, registry, hosts } = hubWith();
    const older = fakeHost(200, 'older', [held('term-3', { view: JSON.stringify(view), detachedAt: 5 }), held('term-4', { pid: 0 })]);
    hosts.adopt(older);
    // a pty still connecting has no pid to show yet
    expect(hub.list()).toEqual([{ id: 'term-3', pid: 7, cols: 120, rows: 40, view }]);
    expect(registry.runs().map((run) => `${run.kind} ${run.id} ${run.projectKey} ${run.title}`)).toEqual(['terminal term-3 /srv/app bash', 'terminal term-4 /srv/app bash']);
    older.fromHost({ type: 'ready', id: 'term-4', pid: 9 });
    expect(hub.list().map((terminal) => terminal.pid)).toEqual([7, 9]);
    // nothing is told to a host about terminals nobody views: it already counts them unviewed
    expect(older.sent).toEqual([]);
  });

  it('lists a terminal whose view no longer parses without it, and says so', () => {
    const logs: string[] = [];
    const { hub, hosts } = hubWith(fakeHost(100, 'own'), (line) => logs.push(line));
    hosts.adopt(fakeHost(200, 'older', [held('term-3', { view: JSON.stringify({ ...view, profile: { ...view.profile, icon: 'an-icon-this-version-dropped' } }) }), held('term-4', { view: 'not json' })]));
    expect(hub.list()).toEqual([{ id: 'term-3', pid: 7, cols: 120, rows: 40 }, { id: 'term-4', pid: 7, cols: 120, rows: 40 }]);
    expect(logs).toEqual(['[terminal] term-3 is listed without its view, which is outside the contract', '[terminal] term-4 is listed without its view, which is outside the contract']);
  });

  it('sends each terminal\'s requests to its own host and starts new terminals only in the current one', async () => {
    const { hub, hosts, host: current } = hubWith();
    const older = fakeHost(200, 'older', [held('term-3')]);
    hosts.adopt(older);
    const seen: string[] = [];
    const client: HubClient = { id: 'a', message: (message) => seen.push(`${message.type} ${message.id}`) };
    hub.post(client, { ...SPAWN, id: 'term-5' }, '/srv/app');
    await settled();
    hub.post(client, { type: 'serialize', id: 'term-3' }, undefined);
    hub.post(client, { type: 'input', id: 'term-3', data: 'a' }, undefined);
    hub.post(client, { type: 'input', id: 'term-5', data: 'b' }, undefined);
    hub.post(client, { type: 'resize', id: 'term-3', cols: 90, rows: 20 }, undefined);
    expect(types(current.sent)).toEqual(['spawn', 'input']);
    expect(older.sent).toEqual([{ type: 'viewed', id: 'term-3', viewed: true }, { type: 'serialize', id: 'term-3' }, { type: 'input', id: 'term-3', data: 'a' }, { type: 'resize', id: 'term-3', cols: 90, rows: 20 }]);
    // each host's events reach the terminal's viewers, and a host cannot speak for another host's terminal
    older.fromHost({ type: 'data', id: 'term-5', data: 'forged' });
    current.fromHost({ type: 'ready', id: 'term-5', pid: 42 });
    older.fromHost({ type: 'screen', id: 'term-3', data: '$ ', cols: 90, rows: 20, marks: [], sequences: 0 });
    expect(seen).toEqual(['ready term-5', 'screen term-3']);
  });

  it('refuses a spawn under an id any attached host holds', async () => {
    const { hub, hosts, host: current } = hubWith();
    hosts.adopt(fakeHost(200, 'older', [held('term-3', { pid: 0 })]));
    const seen: HostMessage[] = [];
    hub.post({ id: 'a', message: (message) => seen.push(message) }, { ...SPAWN, id: 'term-3' }, '/srv/app');
    await settled();
    expect(seen).toEqual([{ type: 'error', id: 'term-3', message: 'terminal term-3 already exists on this host' }]);
    expect(current.sent).toEqual([]);
  });

  it('does not list a late host\'s terminal under an id it already lists, and says so', () => {
    const logs: string[] = [];
    const { hub, hosts } = hubWith(fakeHost(100, 'own'), (line) => logs.push(line));
    hosts.adopt(fakeHost(200, 'older', [held('term-3')]));
    hosts.adopt(fakeHost(300, 'oldest', [held('term-3', { pid: 8 })]));
    expect(hub.list()).toEqual([{ id: 'term-3', pid: 7, cols: 120, rows: 40 }]);
    expect(logs).toEqual(['[terminal] the terminal host 300 holds term-3, an id another host\'s terminal has; it is not listed']);
  });

  it('keeps a host\'s terminals when its link is lost: no viewer hears an exit, what is asked waits, and the next link of that host gets each view again', async () => {
    const { hub, registry, hosts } = hubWith();
    const older = fakeHost(200, 'older', [held('term-3'), held('term-4')]);
    hosts.adopt(older);
    const seen: string[] = [];
    const a: HubClient = { id: 'a', message: (message) => seen.push(`a ${message.type} ${message.id}`) };
    const b: HubClient = { id: 'b', message: (message) => seen.push(`b ${message.type} ${message.id}`) };
    hub.post(a, { type: 'serialize', id: 'term-3' }, undefined);
    hub.post(b, { type: 'serialize', id: 'term-3' }, undefined);
    older.fromHost({ type: 'screen', id: 'term-3', data: '$ ', cols: 120, rows: 40, marks: [], sequences: 0 });
    older.link.close('nothing arrived for 20000 ms');
    expect(seen).toEqual(['a screen term-3']);
    expect(hub.list().map((terminal) => terminal.id)).toEqual(['term-3', 'term-4']);
    expect(registry.runs().map((run) => run.id)).toEqual(['term-3', 'term-4']);
    hub.post(a, { type: 'input', id: 'term-3', data: 'ls\r' }, undefined);
    hub.post(a, { type: 'resize', id: 'term-3', cols: 90, rows: 20 }, undefined);
    const sentBefore = older.sent.length;
    // the host of that pid is attached again and still holds one of the two
    const again = fakeHost(200, 'older', [held('term-3', { pid: 7, cols: 120, rows: 40 })]);
    hosts.adopt(again);
    expect(older.sent).toHaveLength(sentBefore);
    // the host counts every terminal unviewed after an attach and forgot the screen b still waited for
    expect(again.sent).toEqual([{ type: 'viewed', id: 'term-3', viewed: true }, { type: 'serialize', id: 'term-3' }, { type: 'serialize', id: 'term-3' }, { type: 'input', id: 'term-3', data: 'ls\r' }, { type: 'resize', id: 'term-3', cols: 90, rows: 20 }]);
    again.fromHost({ type: 'screen', id: 'term-3', data: 'one', cols: 90, rows: 20, marks: [], sequences: 0 });
    again.fromHost({ type: 'screen', id: 'term-3', data: 'two', cols: 90, rows: 20, marks: [], sequences: 0 });
    again.fromHost({ type: 'data', id: 'term-3', data: 'x' });
    expect(seen).toEqual(['a screen term-3', 'a screen term-3', 'b screen term-3', 'a data term-3', 'b data term-3']);
    // term-4 ended while the link was away, which nobody viewed
    expect(hub.list().map((terminal) => terminal.id)).toEqual(['term-3']);
    // an event on the lost link is nobody's
    older.fromHost({ type: 'exit', id: 'term-3', exitCode: 0 });
    expect(hub.list().map((terminal) => terminal.id)).toEqual(['term-3']);
  });

  it('tells the viewers of a terminal that ended while its host\'s link was away, once the host is attached again', () => {
    const { hub, hosts } = hubWith();
    const older = fakeHost(200, 'older', [held('term-3'), held('term-4')]);
    hosts.adopt(older);
    const seen: HostMessage[] = [];
    hub.post({ id: 'a', message: (message) => seen.push(message) }, { type: 'serialize', id: 'term-4' }, undefined);
    older.link.close('nothing arrived for 20000 ms');
    hosts.adopt(fakeHost(200, 'older', [held('term-3')]));
    expect(seen).toEqual([{ type: 'exit', id: 'term-4', exitCode: 1 }]);
  });

  it('holds a bounded number of requests for a terminal whose host is not attached, and says once that it drops the rest', () => {
    const logs: string[] = [];
    const { hub, hosts } = hubWith(fakeHost(100, 'own'), (line) => logs.push(line));
    const older = fakeHost(200, 'older', [held('term-3')]);
    hosts.adopt(older);
    const a: HubClient = { id: 'a', message: () => undefined };
    hub.post(a, { type: 'serialize', id: 'term-3' }, undefined);
    older.link.close('nothing arrived for 20000 ms');
    for (let index = 0; index < MAX_QUEUED_HOST_REQUESTS + 50; index++) hub.post(a, { type: 'input', id: 'term-3', data: 'x' }, undefined);
    expect(logs).toEqual([`[terminal] term-3 holds ${MAX_QUEUED_HOST_REQUESTS} requests of ${MAX_QUEUED_HOST_REQUESTS} characters for its terminal host, which is not attached; later ones are dropped`]);
    const again = fakeHost(200, 'older', [held('term-3')]);
    hosts.adopt(again);
    expect(again.sent.filter((sent) => sent.type === 'input')).toHaveLength(MAX_QUEUED_HOST_REQUESTS);
  });

  it('holds a bounded number of characters for a terminal whose host is not attached, and drops every later request once it dropped one', () => {
    const logs: string[] = [];
    const { hub, hosts } = hubWith(fakeHost(100, 'own'), (line) => logs.push(line));
    const older = fakeHost(200, 'older', [held('term-3')]);
    hosts.adopt(older);
    const a: HubClient = { id: 'a', message: () => undefined };
    hub.post(a, { type: 'serialize', id: 'term-3' }, undefined);
    older.link.close('nothing arrived for 20000 ms');
    const half = 'x'.repeat(MAX_QUEUED_HOST_CHARS / 2);
    for (const data of [half, half, 'y', 'z']) hub.post(a, { type: 'input', id: 'term-3', data }, undefined);
    expect(logs).toEqual([`[terminal] term-3 holds 2 requests of ${MAX_QUEUED_HOST_CHARS} characters for its terminal host, which is not attached; later ones are dropped`]);
    const again = fakeHost(200, 'older', [held('term-3')]);
    hosts.adopt(again);
    expect(again.sent.filter((sent) => sent.type === 'input').map((sent) => (sent['data'] as string).length)).toEqual([half.length, half.length]);
  });

  it('holds a Kill in place of everything a terminal held for its host, dropped requests included, and holds no view or screen for a lost link', () => {
    const { hub, hosts } = hubWith();
    const older = fakeHost(200, 'older', [held('term-3')]);
    hosts.adopt(older);
    const a: HubClient = { id: 'a', message: () => undefined };
    hub.post(a, { type: 'serialize', id: 'term-3' }, undefined);
    older.link.close('nothing arrived for 20000 ms');
    hub.post({ id: 'b', message: () => undefined }, { type: 'serialize', id: 'term-3' }, undefined);
    for (let index = 0; index <= MAX_QUEUED_HOST_REQUESTS; index++) hub.post(a, { type: 'input', id: 'term-3', data: 'x' }, undefined);
    hub.post(a, { type: 'kill', id: 'term-3' }, undefined);
    const again = fakeHost(200, 'older', [held('term-3')]);
    hosts.adopt(again);
    // the view and the screens of a and b are the new link's own
    expect(again.sent).toEqual([{ type: 'viewed', id: 'term-3', viewed: true }, { type: 'serialize', id: 'term-3' }, { type: 'serialize', id: 'term-3' }, { type: 'kill', id: 'term-3' }]);
  });

  it('tells every viewer a terminal ended once its host has ended, and keeps the other hosts\' terminals', async () => {
    const { hub, registry, hosts, host: current } = hubWith();
    const older = fakeHost(200, 'older', [held('term-3'), held('term-4')]);
    hosts.adopt(older);
    const seen = new Map<string, HostMessage[]>([['a', []], ['b', []]]);
    const a: HubClient = { id: 'a', message: (message) => seen.get('a')!.push(message) };
    const b: HubClient = { id: 'b', message: (message) => seen.get('b')!.push(message) };
    hub.post(a, { ...SPAWN, id: 'term-5' }, '/srv/app');
    await settled();
    current.fromHost({ type: 'ready', id: 'term-5', pid: 42 });
    hub.post(a, { type: 'serialize', id: 'term-3' }, undefined);
    hub.post(b, { type: 'serialize', id: 'term-3' }, undefined);
    seen.get('a')!.length = 0;
    older.link.close('the connection closed');
    hosts.end(200);
    // one exit per terminal a client views; term-4 had no viewer
    expect(seen.get('a')).toEqual([{ type: 'exit', id: 'term-3', exitCode: 1 }]);
    expect(seen.get('b')).toEqual([{ type: 'exit', id: 'term-3', exitCode: 1 }]);
    expect(hub.list()).toEqual([{ id: 'term-5', pid: 42, cols: 80, rows: 24 }]);
    expect(registry.runs().map((run) => run.id)).toEqual(['term-5']);
  });

  it('says a host is empty once its last terminal ended, and not before', () => {
    const { hosts } = hubWith();
    const older = fakeHost(200, 'older', [held('term-3'), held('term-4')]);
    hosts.adopt(older);
    older.fromHost({ type: 'exit', id: 'term-3', exitCode: 0 });
    expect(hosts.emptied).toEqual([]);
    older.fromHost({ type: 'exit', id: 'term-4', exitCode: 0 });
    expect(hosts.emptied).toEqual([older.link]);
  });

  // the next daemon adopts them: a viewer told they ended would close tabs whose shells run on
  it('tells no viewer a terminal ended when the daemon releases its hosts', () => {
    const { hub, hosts } = hubWith();
    const older = fakeHost(200, 'older', [held('term-3')]);
    hosts.adopt(older);
    const seen: HostMessage[] = [];
    hub.post({ id: 'a', message: (message) => seen.push(message) }, { type: 'serialize', id: 'term-3' }, undefined);
    hub.release('the daemon lock was compromised');
    older.link.close('the daemon lock was compromised');
    hosts.end(200);
    expect(seen).toEqual([]);
  });
});
