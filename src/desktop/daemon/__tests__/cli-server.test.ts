import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMux, MAX_FRAME_BYTES, type Mux } from '../../../remote/mux';
import { createPersistentProtocol } from '../../../remote/persistent-protocol';
import { holdStream, pipeStream } from '../../../remote/tunnel-pipe';
import { socketPair } from '../../../remote/__tests__/sockets';
import { sendCliRequest, type CliAnswer, type CliLanguage, type CliRelay, type CliRelayAnswer, type CliRequest } from '../../cli/cli-protocol';
import { CLI_HOOK_ENV } from '../../workspace/terminal/terminal-env';
import { createCliServer, type CliClient, type CliServer } from '../cli-server';
import { createRunRegistry, type RunRegistry } from '../run-registry';
import { createTerminalHub, type HubClient } from '../terminal-hub';
import { fakeHost, fakeHosts, settled, type FakeHost } from './fake-terminal-host';

const OPEN: CliRequest = { kind: 'open', cwd: '/srv/app', items: [{ path: '/srv/app/README.md' }], wait: false };
const WAIT: CliRequest = { ...OPEN, wait: true };
const BIN = path.join(os.tmpdir(), 'run-0123456789abcdef', 'active', 'bin');
const NOT_CONNECTED: CliAnswer = { ok: false, code: 'notConnected', language: 'en' };
const windows = process.platform === 'win32';
const log = (): void => undefined;

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

// A server whose endpoint listens from its start. reattachMs: how long after that the clients of a switch may still reattach;
// reattachUntil instead leaves the endpoint to the test.
function server(language: (clientId: string) => CliLanguage | undefined = () => undefined, options: { readonly log?: (line: string) => void; readonly requestDeadlineMs?: number; readonly reattachMs?: number; readonly reattachUntil?: () => number | undefined; readonly registry?: RunRegistry } = {}): CliServer {
  const reattachUntil = options.reattachUntil ?? ((end) => () => end)(Date.now() + (options.reattachMs ?? 100));
  const registry = options.registry ?? createRunRegistry();
  const cli = createCliServer({ platform: process.platform, version: '9.9.9', bin: BIN, language, log: options.log ?? log, reattachUntil, cliWait: (title) => registry.cliWait(title), ...(options.requestDeadlineMs !== undefined ? { requestDeadlineMs: options.requestDeadlineMs } : {}) });
  if (!options.reattachUntil) cli.accepting();
  cleanups.push(() => cli.close());
  return cli;
}

// whether promise has settled, read synchronously
function tracked<T>(promise: Promise<T>): { readonly pending: () => boolean } {
  let pending = true;
  const settle = (): void => {
    pending = false;
  };
  void promise.then(settle, settle);
  return { pending: () => pending };
}

// a terminal's command socket as forwarded() makes it, also handing the test each connection cli serves
async function forwardedWith(cli: CliServer, terminalId: string): Promise<{ readonly hook: string; readonly served: net.Socket[] }> {
  const served: net.Socket[] = [];
  const hook = await endpointName();
  await listenAt(hook, (socket) => {
    served.push(socket);
    cli.serve(terminalId, socket);
  });
  return { hook, served };
}

function client(clientId: string, answer: (relay: CliRelay) => Promise<CliRelayAnswer> = async () => ({ ok: true }), lost = false): CliClient & { readonly relayed: CliRelay[] } {
  const relayed: CliRelay[] = [];
  return {
    clientId,
    relayed,
    lost: () => lost,
    relay: (relay) => {
      relayed.push(relay);
      return answer(relay);
    },
  };
}

// a socket path or pipe name a test listens at
async function endpointName(): Promise<string> {
  if (windows) return `\\\\.\\pipe\\damocles-test-cli-${randomBytes(8).toString('hex')}`;
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'dm-cli-'));
  cleanups.push(() => fs.rm(folder, { recursive: true, force: true }));
  return path.join(folder, 'cli.sock');
}

async function listenAt(name: string, connection: (socket: net.Socket) => void): Promise<void> {
  const listening = net.createServer({ allowHalfOpen: true }, connection);
  await new Promise<void>((resolve) => listening.listen(name, resolve));
  cleanups.push(() => new Promise<void>((resolve) => listening.close(() => resolve())));
}

// a terminal's damocles command socket whose every connection cli serves, as its terminal host forwards it
async function forwarded(cli: CliServer, terminalId: string): Promise<string> {
  const name = await endpointName();
  await listenAt(name, (socket) => cli.serve(terminalId, socket));
  return name;
}

// A terminal host's CLI endpoint as host.ts makes it: each connection crosses on a stream the host opens on its link, which
// the daemon's side hands the hub as a forwarded connection.
async function hostEndpoint(host: FakeHost, terminalId: string): Promise<string> {
  const [a, b] = socketPair();
  const refuse = (reason: string): never => {
    throw new Error(reason);
  };
  const hostSide: Mux = createMux({ protocol: createPersistentProtocol({ socket: a, maxBodyBytes: MAX_FRAME_BYTES, log }), side: 'daemon', acceptStreams: false, onOverflow: () => refuse('overflow'), onViolation: refuse, log });
  const daemonSide: Mux = createMux({ protocol: createPersistentProtocol({ socket: b, maxBodyBytes: MAX_FRAME_BYTES, log }), side: 'client', acceptStreams: true, onOverflow: () => refuse('overflow'), onViolation: refuse, log });
  cleanups.push(() => {
    hostSide.dispose();
    daemonSide.dispose();
  });
  daemonSide.onStream((stream) => host.forward({ kind: 'cli', terminalId, stream: holdStream(stream) }));
  const name = await endpointName();
  await listenAt(name, (socket) => {
    pipeStream(socket, hostSide.openStream(), () => undefined, (closed) => closed.destroy());
  });
  return name;
}

const ask = (hook: string, request: CliRequest): Promise<CliAnswer> => sendCliRequest(() => net.connect(hook), request);

describe('the damocles command on a target', () => {
  it('gives a terminal\'s shell bin/remote-cli first on PATH and the BROWSER helper as named, and leaves the socket to its terminal host', () => {
    const cli = server();
    const env = cli.environment({ PATH: '/usr/bin' });
    expect(env['PATH']).toBe(`${path.join(BIN, 'remote-cli')}${windows ? ';' : ':'}/usr/bin`);
    expect(env['BROWSER']).toBe(path.join(BIN, 'helpers', windows ? 'browser.exe' : 'browser.sh'));
    expect(env[CLI_HOOK_ENV]).toBeUndefined();
  });

  it('answers status for a terminal no client views', async () => {
    const cli = server();
    const hook = await forwarded(cli, 'term-1');
    await expect(ask(hook, { kind: 'status' })).resolves.toEqual({ ok: true, version: '9.9.9', connected: false, language: 'en' });
  });

  it('relays a forwarded connection to the client that most recently attached the terminal\'s view', async () => {
    const cli = server();
    const laptop = client('laptop');
    const desktop = client('desktop');
    cli.connected('conn-laptop', laptop);
    cli.connected('conn-desktop', desktop);
    const hook = await forwarded(cli, 'term-1');
    cli.attached('term-1', 'conn-laptop');
    cli.attached('term-1', 'conn-desktop');
    await expect(ask(hook, OPEN)).resolves.toEqual({ ok: true });
    expect(desktop.relayed).toEqual([{ request: OPEN }]);
    // attaching again moves the laptop last
    cli.attached('term-1', 'conn-laptop');
    await ask(hook, OPEN);
    expect(laptop.relayed).toHaveLength(1);
    // its view detached: the desktop again
    cli.detached('term-1', 'conn-laptop');
    await ask(hook, OPEN);
    expect(desktop.relayed).toHaveLength(2);
  });

  it('answers main\'s refusal with its message', async () => {
    const cli = server();
    cli.connected('conn', client('laptop', async () => ({ ok: false, message: 'damocles: /srv/other was not added as a project.' })));
    const hook = await forwarded(cli, 'term-1');
    cli.attached('term-1', 'conn');
    await expect(ask(hook, OPEN)).resolves.toEqual({ ok: false, code: 'refused', message: 'damocles: /srv/other was not added as a project.' });
  });

  it('answers not connected, in the language of the client that last attached the view, once no client is attached', async () => {
    const languages = new Map<string, CliLanguage>([['greek-laptop', 'el']]);
    const cli = server((clientId) => languages.get(clientId));
    const hook = await forwarded(cli, 'term-1');
    await expect(ask(hook, OPEN)).resolves.toEqual({ ok: false, code: 'notConnected', language: 'en' });
    const connection = cli.connected('conn', client('greek-laptop'));
    cli.attached('term-1', 'conn');
    connection.dispose();
    await expect(ask(hook, OPEN)).resolves.toEqual({ ok: false, code: 'notConnected', language: 'el' });
    await expect(ask(hook, { kind: 'status' })).resolves.toEqual({ ok: true, version: '9.9.9', connected: false, language: 'el' });
  });

  it('skips a connection that dropped and waits inside its grace, and answers not connected when only that one is attached', async () => {
    const cli = server();
    const held = client('laptop', async () => new Promise<CliRelayAnswer>(() => undefined), true);
    const live = client('desktop');
    cli.connected('conn-held', held);
    const hook = await forwarded(cli, 'term-1');
    cli.attached('term-1', 'conn-held');
    await expect(ask(hook, OPEN)).resolves.toEqual({ ok: false, code: 'notConnected', language: 'en' });
    cli.connected('conn-live', live);
    cli.attached('term-1', 'conn-live');
    cli.attached('term-1', 'conn-held');
    await expect(ask(hook, OPEN)).resolves.toEqual({ ok: true });
    expect(held.relayed).toEqual([]);
    expect(live.relayed).toHaveLength(1);
  });

  it('answers not connected when the connection ends before its client answered', async () => {
    const cli = server();
    cli.connected('conn', client('laptop', async () => { throw new Error('the connection closed'); }));
    const hook = await forwarded(cli, 'term-1');
    cli.attached('term-1', 'conn');
    await expect(ask(hook, OPEN)).resolves.toEqual({ ok: false, code: 'notConnected', language: 'en' });
  });

  it('answers not connected and drops the connection once the terminal ends while its relay waits', async () => {
    const cli = server();
    const waiting = client('laptop', () => new Promise<CliRelayAnswer>(() => undefined));
    cli.connected('conn', waiting);
    const hook = await forwarded(cli, 'term-1');
    cli.attached('term-1', 'conn');
    const answer = ask(hook, WAIT);
    await vi.waitFor(() => expect(waiting.relayed).toHaveLength(1));
    cli.closed('term-1');
    await expect(answer).resolves.toEqual(NOT_CONNECTED);
  });

  it('closes at once while a relay waits for its client, answering the command not connected and ending its pending wait', async () => {
    const registry = createRunRegistry();
    const cli = server(undefined, { registry });
    const waiting = client('laptop', () => new Promise<CliRelayAnswer>(() => undefined));
    cli.connected('conn', waiting);
    const hook = await forwarded(cli, 'term-1');
    cli.attached('term-1', 'conn');
    const answer = ask(hook, WAIT);
    await vi.waitFor(() => expect(waiting.relayed).toHaveLength(1));
    expect(registry.cliWaits()).toEqual(['README.md']);
    cli.close();
    await expect(answer).resolves.toEqual(NOT_CONNECTED);
    expect(registry.cliWaits()).toEqual([]);
  });

  // a pending wait holds a hand-over (lifetime.ts), so a git commit's message tab is not cut by a switch once idle
  it('holds a --wait as pending while its client has it, named by its files, and nothing that does not wait', async () => {
    const registry = createRunRegistry();
    const cli = server(undefined, { registry });
    const during: Array<readonly string[]> = [];
    cli.connected('conn', client('laptop', async () => {
      during.push(registry.cliWaits());
      return { ok: true };
    }));
    const hook = await forwarded(cli, 'term-1');
    cli.attached('term-1', 'conn');
    await expect(ask(hook, { kind: 'open', cwd: '/srv/app', items: [{ path: '/srv/app/.git/COMMIT_EDITMSG' }, { path: 'notes.md' }], wait: true })).resolves.toEqual({ ok: true });
    await expect(ask(hook, { kind: 'diff', cwd: '/srv/app', left: '/srv/app/old.txt', right: 'new.txt', wait: true })).resolves.toEqual({ ok: true });
    await expect(ask(hook, OPEN)).resolves.toEqual({ ok: true });
    expect(during).toEqual([['COMMIT_EDITMSG, notes.md'], ['old.txt, new.txt'], []]);
    expect(registry.cliWaits()).toEqual([]);
  });

  it('closes at once while a connection sends nothing, and drops it, and drops any connection after the close', async () => {
    const cli = server();
    const hook = await forwarded(cli, 'term-1');
    const idle = net.connect(hook);
    idle.on('error', () => undefined);
    const dropped = new Promise<void>((resolve) => idle.on('close', () => resolve()));
    // served after the idle connection, so that one is the server's too
    await ask(hook, { kind: 'status' });
    cli.close();
    await dropped;
    // closed unanswered, which the command reads as not connected
    await expect(ask(hook, { kind: 'status' })).resolves.toEqual(NOT_CONNECTED);
  });

  it('drops a connection whose request line is not complete within the deadline', async () => {
    const lines: string[] = [];
    const cli = server(undefined, { log: (line) => lines.push(line), requestDeadlineMs: 50 });
    const hook = await forwarded(cli, 'term-1');
    const silent = net.connect(hook, () => silent.write('{"kind":'));
    silent.on('error', () => undefined);
    await new Promise<void>((resolve) => silent.on('close', () => resolve()));
    expect(lines).toContain('[cli] dropped a connection that sent no request in time');
  });

  it('keeps a connection whose request came within the deadline while its client takes longer to answer', async () => {
    const cli = server(undefined, { requestDeadlineMs: 50 });
    cli.connected('conn', client('laptop', () => new Promise<CliRelayAnswer>((resolve) => setTimeout(() => resolve({ ok: true }), 200))));
    const hook = await forwarded(cli, 'term-1');
    cli.attached('term-1', 'conn');
    await expect(ask(hook, WAIT)).resolves.toEqual({ ok: true });
  });

  it('follows the terminal hub: a forwarded connection of a spawned terminal goes to the client that last attached its view, until the exit', async () => {
    const cli = server();
    const host = fakeHost(100, 'own');
    const { sent: toHost, fromHost } = host;
    const hub = createTerminalHub({ hosts: fakeHosts(host).hosts, registry: createRunRegistry(), cli, log });
    const hubClient = (id: string): HubClient => ({ id, message: () => undefined });
    const laptop = client('laptop');
    const desktop = client('desktop');
    cli.connected('laptop', laptop);
    cli.connected('desktop', desktop);
    const laptopView = hubClient('laptop');
    const desktopView = hubClient('desktop');
    hub.post(laptopView, { type: 'spawn', id: 'term-1', file: '/bin/sh', args: [], cwd: '/srv/app', env: { PATH: '/usr/bin' }, cols: 80, rows: 24, scrollback: 1000 }, '/srv/app');
    await settled();
    // the host makes the socket and names it in the shell's environment
    expect(toHost.find((request) => request.type === 'spawn')).toMatchObject({ endpoints: { cli: true, relay: false } });
    fromHost({ type: 'ready', id: 'term-1', pid: 7 });
    const hook = await hostEndpoint(host, 'term-1');
    await expect(ask(hook, OPEN)).resolves.toEqual({ ok: true });
    expect(laptop.relayed).toHaveLength(1);
    hub.post(desktopView, { type: 'serialize', id: 'term-1' }, undefined);
    await ask(hook, OPEN);
    expect(desktop.relayed).toHaveLength(1);
    hub.post(desktopView, { type: 'detach', id: 'term-1' }, undefined);
    await ask(hook, OPEN);
    expect(laptop.relayed).toHaveLength(2);
    fromHost({ type: 'exit', id: 'term-1', exitCode: 0 });
    // the ended terminal's connection is closed unanswered, which the command reads as not connected
    await expect(ask(hook, OPEN)).resolves.toEqual(NOT_CONNECTED);
    expect(laptop.relayed).toHaveLength(2);
  });

  it('holds a request of a terminal adopted in a switch until a client first attaches its view, as the app\'s reattach does, then relays it there', async () => {
    const reattachUntil = vi.fn(((end) => () => end)(Date.now() + 30_000));
    const cli = server(undefined, { reattachUntil });
    cli.accepting();
    const host = fakeHost(100, 'own', [{ id: 'term-1', pid: 7, cols: 80, rows: 24, scrollback: 1000, title: 'sh', projectKey: '/srv/app' }]);
    const hosts = fakeHosts(fakeHost(200, 'own'));
    const hub = createTerminalHub({ hosts: hosts.hosts, registry: createRunRegistry(), cli, log });
    hosts.adopt(host);
    const laptop = client('laptop');
    const hook = await hostEndpoint(host, 'term-1');
    const answer = ask(hook, OPEN);
    const state = tracked(answer);
    // the request waits for the terminal's first client
    await vi.waitFor(() => expect(reattachUntil).toHaveBeenCalled());
    expect(state.pending()).toBe(true);
    cli.connected('laptop', laptop);
    hub.post({ id: 'laptop', message: () => undefined }, { type: 'serialize', id: 'term-1' }, undefined);
    await expect(answer).resolves.toEqual({ ok: true });
    expect(laptop.relayed).toEqual([{ request: OPEN }]);
  });

  it('starts the wait of a request made before the endpoint listens only once it does, so the window runs from then', async () => {
    // the server's reattach window, unknown until its endpoint listens
    const reattach: { until?: number } = {};
    const reattachUntil = vi.fn(() => reattach.until);
    const cli = server(undefined, { reattachUntil });
    const hook = await forwarded(cli, 'term-1');
    const answer = ask(hook, OPEN);
    const state = tracked(answer);
    await vi.waitFor(() => expect(reattachUntil).toHaveBeenCalled());
    // a window that would be over had the wait started before the endpoint listened
    reattach.until = Date.now();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(state.pending()).toBe(true);
    cli.accepting();
    await expect(answer).resolves.toEqual(NOT_CONNECTED);
  });

  it('carries out no request whose command went away while it waited for the first view', async () => {
    const reattachUntil = vi.fn(((end) => () => end)(Date.now() + 30_000));
    const cli = server(undefined, { reattachUntil });
    cli.accepting();
    const { hook, served } = await forwardedWith(cli, 'term-1');
    const gone = net.connect(hook, () => gone.write(`${JSON.stringify(OPEN)}\n`));
    gone.on('error', () => undefined);
    await vi.waitFor(() => expect(reattachUntil).toHaveBeenCalled());
    gone.destroy();
    // the daemon's side closed, which ends the wait
    await vi.waitFor(() => expect(served[0]?.closed).toBe(true));
    const laptop = client('laptop');
    cli.connected('conn', laptop);
    cli.attached('term-1', 'conn');
    await new Promise((resolve) => setImmediate(resolve));
    expect(laptop.relayed).toEqual([]);
  });

  it('answers not connected once the terminal ends while a request waits for its first view', async () => {
    const reattachUntil = vi.fn(((end) => () => end)(Date.now() + 30_000));
    const cli = server(undefined, { reattachUntil });
    cli.accepting();
    const hook = await forwarded(cli, 'term-1');
    const answer = ask(hook, WAIT);
    await vi.waitFor(() => expect(reattachUntil).toHaveBeenCalled());
    cli.closed('term-1');
    await expect(answer).resolves.toEqual(NOT_CONNECTED);
  });

  it('answers not connected once it closes while a request waits for its terminal\'s first view, as a second switch within the window does', async () => {
    const reattachUntil = vi.fn(((end) => () => end)(Date.now() + 30_000));
    const cli = server(undefined, { reattachUntil });
    cli.accepting();
    const hook = await forwarded(cli, 'term-1');
    const answer = ask(hook, WAIT);
    await vi.waitFor(() => expect(reattachUntil).toHaveBeenCalled());
    cli.close();
    await expect(answer).resolves.toEqual(NOT_CONNECTED);
  });

  it('answers not connected at once once the clients of a switch had their time to reattach, as for a gone computer\'s terminal', async () => {
    const cli = server(undefined, { reattachMs: -1 });
    const hook = await forwarded(cli, 'term-1');
    await expect(ask(hook, OPEN)).resolves.toEqual(NOT_CONNECTED);
  });

  it('answers not connected when no client attaches a terminal\'s view within the wait', async () => {
    const cli = server(undefined, { reattachMs: 2_000 });
    const hook = await forwarded(cli, 'term-1');
    const answer = ask(hook, OPEN);
    const state = tracked(answer);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(state.pending()).toBe(true);
    await expect(answer).resolves.toEqual(NOT_CONNECTED);
  });

  it('answers not connected at once, within the switch\'s window, once a terminal\'s clients left', async () => {
    const cli = server(undefined, { reattachMs: 30_000 });
    const hook = await forwarded(cli, 'term-1');
    const connection = cli.connected('conn', client('laptop'));
    cli.attached('term-1', 'conn');
    connection.dispose();
    await expect(ask(hook, OPEN)).resolves.toEqual(NOT_CONNECTED);
  });

  it('closes a forwarded connection that names a terminal its host does not hold here', async () => {
    const cli = server();
    const lines: string[] = [];
    const host = fakeHost(100, 'own', [{ id: 'term-1', pid: 7, cols: 80, rows: 24, scrollback: 1000, title: 'sh', projectKey: '/srv/app' }]);
    const other = fakeHost(200, 'own');
    const hosts = fakeHosts(other);
    createTerminalHub({ hosts: hosts.hosts, registry: createRunRegistry(), cli, log: (line) => lines.push(line) });
    hosts.adopt(host);
    hosts.adopt(other);
    cli.connected('laptop', client('laptop'));
    const hook = await hostEndpoint(other, 'term-1');
    await expect(ask(hook, OPEN)).resolves.toEqual(NOT_CONNECTED);
    expect(lines).toContain('[terminal] closed a damocles command connection of term-1, which the terminal host 200 does not hold here');
  });
});
