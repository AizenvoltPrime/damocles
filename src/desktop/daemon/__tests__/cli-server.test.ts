import { existsSync, promises as fs } from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { sendCliRequest, type CliAnswer, type CliLanguage, type CliRelay, type CliRelayAnswer, type CliRequest } from '../../cli/cli-protocol';
import type { HostMessage, HostRequest } from '../../pty-host/protocol';
import type { PtyHostProcess } from '../../workspace/host-starters';
import { CLI_HOOK_ENV } from '../../workspace/terminal/terminal-env';
import { createCliServer, type CliClient, type CliServer } from '../cli-server';
import { createRunRegistry } from '../run-registry';
import { createTerminalHub, type HubClient } from '../terminal-hub';
import { touch } from '../token';

const OPEN: CliRequest = { kind: 'open', cwd: '/srv/app', items: [{ path: '/srv/app/README.md' }], wait: false };
const WAIT: CliRequest = { ...OPEN, wait: true };
const BIN = path.join(os.tmpdir(), 'damocles-server-root', 'bin');
const NOT_CONNECTED: CliAnswer = { ok: false, code: 'notConnected', language: 'en' };

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function server(language: (clientId: string) => CliLanguage | undefined = () => undefined, options: { readonly log?: (line: string) => void; readonly requestDeadlineMs?: number } = {}): Promise<CliServer> {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'damocles-cli-base-'));
  const cli = createCliServer({ platform: process.platform, version: '9.9.9', bin: BIN, language, log: options.log ?? (() => undefined), base: async () => base, ...(options.requestDeadlineMs !== undefined ? { requestDeadlineMs: options.requestDeadlineMs } : {}) });
  await cli.start();
  cleanups.push(async () => {
    await cli.close();
    await fs.rm(base, { recursive: true, force: true });
  });
  return cli;
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

const ask = (hook: string, request: CliRequest): Promise<CliAnswer> => sendCliRequest(() => net.connect(hook), request);

describe('the daemon\'s CLI sockets', () => {
  it('opens one socket per terminal and gives its shell the hook, bin/remote-cli first on PATH and the BROWSER helper', async () => {
    const cli = await server();
    const first = cli.open('term-1', { PATH: '/usr/bin', [CLI_HOOK_ENV]: 'inherited' });
    const second = cli.open('term-2', {});
    const windows = process.platform === 'win32';
    expect(first[CLI_HOOK_ENV]).not.toBe(second[CLI_HOOK_ENV]);
    expect(first[CLI_HOOK_ENV]).toMatch(windows ? /^\\\\\.\\pipe\\damocles-cli-[0-9a-f]{32}$/ : /[\\/]cli-[0-9a-f]{24}\.sock$/);
    expect(first['PATH']).toBe(`${path.join(BIN, 'remote-cli')}${windows ? ';' : ':'}/usr/bin`);
    expect(first['BROWSER']).toBe(path.join(BIN, 'helpers', windows ? 'browser.exe' : 'browser.sh'));
    await expect(ask(first[CLI_HOOK_ENV]!, { kind: 'status' })).resolves.toEqual({ ok: true, version: '9.9.9', connected: false, language: 'en' });
  });

  it.runIf(process.platform !== 'win32')('keeps every socket in one 0700 folder, each socket 0600', async () => {
    const cli = await server();
    const hook = cli.open('term-1', {})[CLI_HOOK_ENV]!;
    await ask(hook, { kind: 'status' });
    expect((await fs.stat(path.dirname(hook))).mode & 0o777).toBe(0o700);
    expect((await fs.stat(hook)).mode & 0o777).toBe(0o600);
    expect(cli.kept()?.files).toEqual([path.dirname(hook), hook]);
  });

  it('closes a terminal\'s socket when the terminal ends', async () => {
    const cli = await server();
    const hook = cli.open('term-1', {})[CLI_HOOK_ENV]!;
    cli.closed('term-1');
    await expect.poll(() => ask(hook, { kind: 'status' }).then(() => 'answered', () => 'refused')).toBe('refused');
  });

  it('relays to the client that most recently attached the terminal\'s view, naming the terminal\'s project', async () => {
    const cli = await server();
    const laptop = client('laptop');
    const desktop = client('desktop');
    cli.connected('conn-laptop', laptop);
    cli.connected('conn-desktop', desktop);
    const hook = cli.open('term-1', {})[CLI_HOOK_ENV]!;
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
    const cli = await server();
    cli.connected('conn', client('laptop', async () => ({ ok: false, message: 'damocles: /srv/other was not added as a project.' })));
    const hook = cli.open('term-1', {})[CLI_HOOK_ENV]!;
    cli.attached('term-1', 'conn');
    await expect(ask(hook, OPEN)).resolves.toEqual({ ok: false, code: 'refused', message: 'damocles: /srv/other was not added as a project.' });
  });

  it('answers not connected, in the language of the client that last attached the view, once no client is attached', async () => {
    const languages = new Map<string, CliLanguage>([['greek-laptop', 'el']]);
    const cli = await server((clientId) => languages.get(clientId));
    const hook = cli.open('term-1', {})[CLI_HOOK_ENV]!;
    await expect(ask(hook, OPEN)).resolves.toEqual({ ok: false, code: 'notConnected', language: 'en' });
    const connection = cli.connected('conn', client('greek-laptop'));
    cli.attached('term-1', 'conn');
    connection.dispose();
    await expect(ask(hook, OPEN)).resolves.toEqual({ ok: false, code: 'notConnected', language: 'el' });
    await expect(ask(hook, { kind: 'status' })).resolves.toEqual({ ok: true, version: '9.9.9', connected: false, language: 'el' });
  });

  it('skips a connection that dropped and waits inside its grace, and answers not connected when only that one is attached', async () => {
    const cli = await server();
    const held = client('laptop', async () => new Promise<CliRelayAnswer>(() => undefined), true);
    const live = client('desktop');
    cli.connected('conn-held', held);
    const hook = cli.open('term-1', {})[CLI_HOOK_ENV]!;
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
    const cli = await server();
    cli.connected('conn', client('laptop', async () => { throw new Error('the connection closed'); }));
    const hook = cli.open('term-1', {})[CLI_HOOK_ENV]!;
    cli.attached('term-1', 'conn');
    await expect(ask(hook, OPEN)).resolves.toEqual({ ok: false, code: 'notConnected', language: 'en' });
  });

  it('follows the terminal hub: a spawn opens the socket in its environment, a serialize attaches, a detach and the exit close', async () => {
    const cli = await server();
    const toHost: HostRequest[] = [];
    let fromHost: (message: unknown) => void = () => undefined;
    const host: PtyHostProcess = { postMessage: (message) => toHost.push(message), onMessage: (listener) => { fromHost = listener; }, onExit: () => undefined, kill: () => undefined };
    const hub = createTerminalHub({ start: () => host, registry: createRunRegistry(), cli, log: () => undefined });
    const hubClient = (id: string): HubClient => ({ id, message: () => undefined, hostExit: () => undefined });
    const laptop = client('laptop');
    const desktop = client('desktop');
    cli.connected('laptop', laptop);
    cli.connected('desktop', desktop);
    const laptopView = hubClient('laptop');
    const desktopView = hubClient('desktop');
    hub.post(laptopView, { type: 'spawn', id: 'term-1', file: '/bin/sh', args: [], cwd: '/srv/app', env: { PATH: '/usr/bin' }, cols: 80, rows: 24, scrollback: 1000 }, '/srv/app');
    const spawn = toHost.find((request) => request.type === 'spawn');
    const hook = spawn?.type === 'spawn' ? spawn.env[CLI_HOOK_ENV] : undefined;
    expect(hook).toBeDefined();
    fromHost({ type: 'ready', id: 'term-1', pid: 7 });
    await ask(hook!, OPEN);
    expect(laptop.relayed).toHaveLength(1);
    hub.post(desktopView, { type: 'serialize', id: 'term-1' }, undefined);
    await ask(hook!, OPEN);
    expect(desktop.relayed).toHaveLength(1);
    hub.post(desktopView, { type: 'detach', id: 'term-1' }, undefined);
    await ask(hook!, OPEN);
    expect(laptop.relayed).toHaveLength(2);
    fromHost({ type: 'exit', id: 'term-1', exitCode: 0 });
    await expect.poll(() => ask(hook!, { kind: 'status' }).then(() => 'answered', () => 'refused')).toBe('refused');
  });

  it('starts no terminal and tells its client when the terminal\'s socket cannot open', async () => {
    const cli = await server();
    await cli.close();
    const toHost: HostRequest[] = [];
    const host: PtyHostProcess = { postMessage: (message) => toHost.push(message), onMessage: () => undefined, onExit: () => undefined, kill: () => undefined };
    const registry = createRunRegistry();
    const hub = createTerminalHub({ start: () => host, registry, cli, log: () => undefined });
    const heard: HostMessage[] = [];
    hub.post({ id: 'laptop', message: (message) => heard.push(message), hostExit: () => undefined }, { type: 'spawn', id: 'term-1', file: '/bin/sh', args: [], cwd: '/srv/app', env: {}, cols: 80, rows: 24, scrollback: 1000 }, '/srv/app');
    expect(heard).toEqual([{ type: 'error', id: 'term-1', message: 'terminal term-1 could not open its damocles command socket' }]);
    expect(toHost).toEqual([]);
    expect(registry.hasTerminal('term-1')).toBe(false);
  });

  it('closes at once while a relay waits for its client, answering the command not connected', async () => {
    const cli = await server();
    const waiting = client('laptop', () => new Promise<CliRelayAnswer>(() => undefined));
    cli.connected('conn', waiting);
    const hook = cli.open('term-1', {})[CLI_HOOK_ENV]!;
    cli.attached('term-1', 'conn');
    const answer = ask(hook, WAIT);
    await vi.waitFor(() => expect(waiting.relayed).toHaveLength(1));
    await cli.close();
    await expect(answer).resolves.toEqual(NOT_CONNECTED);
  });

  it('closes at once while a connection sends nothing, and drops it', async () => {
    const cli = await server();
    const hook = cli.open('term-1', {})[CLI_HOOK_ENV]!;
    const idle = net.connect(hook);
    idle.on('error', () => undefined);
    const dropped = new Promise<void>((resolve) => idle.on('close', () => resolve()));
    // accepted after the idle connection, so that one is the server's too
    await ask(hook, { kind: 'status' });
    await cli.close();
    await dropped;
  });

  it('drops a connection whose request line is not complete within the deadline', async () => {
    const lines: string[] = [];
    const cli = await server(undefined, { log: (line) => lines.push(line), requestDeadlineMs: 50 });
    const hook = cli.open('term-1', {})[CLI_HOOK_ENV]!;
    const silent = net.connect(hook, () => silent.write('{"kind":'));
    silent.on('error', () => undefined);
    await new Promise<void>((resolve) => silent.on('close', () => resolve()));
    expect(lines).toContain('[cli] dropped a connection that sent no request in time');
  });

  it('keeps a connection whose request came within the deadline while its client takes longer to answer', async () => {
    const cli = await server(undefined, { requestDeadlineMs: 50 });
    cli.connected('conn', client('laptop', () => new Promise<CliRelayAnswer>((resolve) => setTimeout(() => resolve({ ok: true }), 200))));
    const hook = cli.open('term-1', {})[CLI_HOOK_ENV]!;
    cli.attached('term-1', 'conn');
    await expect(ask(hook, WAIT)).resolves.toEqual({ ok: true });
  });

  it.runIf(process.platform !== 'win32')('makes the new folder while a relay waits on a socket a cleaner removed, answering that command not connected', async () => {
    const cli = await server();
    const waiting = client('laptop', () => new Promise<CliRelayAnswer>(() => undefined));
    cli.connected('conn', waiting);
    const hook = cli.open('term-1', {})[CLI_HOOK_ENV]!;
    cli.attached('term-1', 'conn');
    const answer = ask(hook, WAIT);
    await vi.waitFor(() => expect(waiting.relayed).toHaveLength(1));
    const kept = cli.kept()!;
    await fs.rm(kept.folder!, { recursive: true });
    await kept.rebind();
    await expect(answer).resolves.toEqual(NOT_CONNECTED);
    const moved = cli.kept()!.folder!;
    expect(moved).not.toBe(kept.folder);
    expect(existsSync(moved)).toBe(true);
    expect(path.dirname(cli.open('term-2', {})[CLI_HOOK_ENV]!)).toBe(moved);
  });

  it.runIf(process.platform !== 'win32')('takes the missing socket of a terminal that ended after its files were read for no removal', async () => {
    const lines: string[] = [];
    const cli = await server(undefined, { log: (line) => lines.push(line) });
    const hook = cli.open('term-1', {})[CLI_HOOK_ENV]!;
    cli.open('term-2', {});
    const kept = cli.kept()!;
    cli.closed('term-1');
    await vi.waitFor(() => expect(existsSync(hook)).toBe(false));
    expect(await touch(kept.files)).toBe(false);
    await kept.rebind();
    expect(lines.filter((line) => line.includes('was removed'))).toEqual([]);
    expect(cli.kept()!.folder).toBe(kept.folder);
  });
});
