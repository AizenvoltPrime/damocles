import { randomBytes } from 'node:crypto';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { cliRequestLimit, commandLineLimit, CommandLineRefusal, commandLineSwitch, MAX_CLI_REQUEST_BYTES, parseCliAnswer, parseCliRequest, parseCommandLine, sendCliRequest, serveCliConnection, type CliAnswer, type CliRequest } from '../cli-protocol';

const OPEN: CliRequest = { kind: 'open', cwd: '/srv/app', items: [{ path: '/srv/app/src/app.ts', line: 42 }], wait: false };

const servers: net.Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

const hookPath = (): string => (process.platform === 'win32' ? `\\\\.\\pipe\\damocles-cli-test-${randomBytes(8).toString('hex')}` : path.join(os.tmpdir(), `damocles-cli-test-${randomBytes(8).toString('hex')}.sock`));

// a CLI socket whose handler records what reached it and answers once release is called
async function serve(answer: (request: CliRequest) => Promise<CliAnswer> = async () => ({ ok: true })): Promise<{ hook: string; handled: CliRequest[] }> {
  const hook = hookPath();
  const handled: CliRequest[] = [];
  const server = net.createServer({ allowHalfOpen: true }, (socket) => serveCliConnection(socket, (request) => {
    handled.push(request);
    return answer(request);
  }, () => undefined));
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(hook, resolve));
  return { hook, handled };
}

// sends raw bytes and reads everything the socket answers until it ends the connection; end: the client ends it first
function raw(hook: string, chunks: readonly (string | Buffer)[], end = false): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(hook);
    const answer: Buffer[] = [];
    socket.on('connect', () => {
      for (const chunk of chunks) socket.write(chunk);
      if (end) socket.end();
    });
    socket.on('data', (chunk: Buffer) => answer.push(chunk));
    socket.on('error', reject);
    socket.on('close', () => resolve(Buffer.concat(answer).toString('utf8')));
  });
}

describe('the CLI socket protocol', () => {
  it('answers one request with one JSON line, and the client reads it', async () => {
    const { hook, handled } = await serve();
    await expect(sendCliRequest(() => net.connect(hook), OPEN)).resolves.toEqual({ ok: true });
    expect(handled).toEqual([OPEN]);
    expect(await raw(hook, [`${JSON.stringify({ kind: 'status' })}\n`])).toBe('{"ok":true}\n');
  });

  it('hands nobody a request whose connection ended before its newline', async () => {
    const { hook, handled } = await serve();
    await raw(hook, [JSON.stringify(OPEN)], true);
    expect(handled).toEqual([]);
  });

  it('refuses a request over 64 KiB without reading on, and hands it to nobody', async () => {
    const { hook, handled } = await serve();
    const huge = JSON.stringify({ ...OPEN, cwd: `/${'a'.repeat(MAX_CLI_REQUEST_BYTES)}` });
    expect(await raw(hook, [huge])).toBe('{"ok":false,"code":"tooLarge"}\n');
    expect(handled).toEqual([]);
  });

  it('takes a request of exactly 64 KiB', async () => {
    const { hook, handled } = await serve();
    // paths stay within their own 4096-character bound, so the request's bound is the one reached
    const items = Array.from({ length: 16 }, (_, index) => ({ path: `/${String(index).padEnd(3900, 'a')}` }));
    const base = JSON.stringify({ kind: 'open', cwd: '/', items, wait: false });
    const exact = JSON.stringify({ kind: 'open', cwd: `/${'a'.repeat(MAX_CLI_REQUEST_BYTES - base.length)}`, items, wait: false });
    expect(Buffer.byteLength(exact)).toBe(MAX_CLI_REQUEST_BYTES);
    expect(await raw(hook, [exact.slice(0, 1000), `${exact.slice(1000)}\n`])).toBe('{"ok":true}\n');
    expect(handled).toHaveLength(1);
  });

  it('refuses malformed JSON and an empty line', async () => {
    const { hook, handled } = await serve();
    expect(await raw(hook, ['{"kind":"open",\n'])).toBe('{"ok":false,"code":"malformed"}\n');
    expect(await raw(hook, ['\n'])).toBe('{"ok":false,"code":"malformed"}\n');
    expect(handled).toEqual([]);
  });

  it('refuses an unknown field at any level, an unknown kind, and a field past its bound', async () => {
    const { hook, handled } = await serve();
    expect(await raw(hook, [`${JSON.stringify({ ...OPEN, extra: true })}\n`])).toBe('{"ok":false,"code":"malformed"}\n');
    expect(await raw(hook, [`${JSON.stringify({ ...OPEN, items: [{ path: '/a', line: 1, goto: 2 }] })}\n`])).toBe('{"ok":false,"code":"malformed"}\n');
    expect(await raw(hook, [`${JSON.stringify({ kind: 'shell', command: 'rm' })}\n`])).toBe('{"ok":false,"code":"malformed"}\n');
    expect(handled).toEqual([]);
    expect(parseCliRequest({ kind: 'openExternal', url: `https://a.test/${'a'.repeat(8192)}` })).toBeUndefined();
    expect(parseCliRequest({ ...OPEN, items: [{ path: '/a', line: 0 }] })).toBeUndefined();
    expect(parseCliRequest({ kind: 'status', version: '1' })).toBeUndefined();
    expect(parseCliRequest({ kind: 'diff', cwd: '/', left: '/a', right: '/b', wait: true })).toEqual({ kind: 'diff', cwd: '/', left: '/a', right: '/b', wait: true });
  });

  it('refuses a second request on one connection, in the same chunk or while the first is handled', async () => {
    const { hook, handled } = await serve();
    const line = `${JSON.stringify(OPEN)}\n`;
    expect(await raw(hook, [line + line])).toBe('{"ok":false,"code":"oneRequest"}\n');
    expect(handled).toEqual([]);
    const releases: Array<() => void> = [];
    const held = await serve(() => new Promise((resolve) => { releases.push(() => resolve({ ok: true })); }));
    const answer = raw(held.hook, [line]);
    await expect.poll(() => held.handled.length).toBe(1);
    // the second line goes out only once the first reached the handler, so it arrives while that request is handled
    const second = new Promise<string>((resolve) => {
      const socket = net.connect(held.hook);
      socket.on('connect', () => {
        socket.write(line);
        void expect.poll(() => held.handled.length).toBe(2).then(() => socket.write(line));
      });
      const chunks: Buffer[] = [];
      socket.on('data', (chunk: Buffer) => chunks.push(chunk));
      socket.on('close', () => resolve(Buffer.concat(chunks).toString('utf8')));
    });
    expect(await second).toBe('{"ok":false,"code":"oneRequest"}\n');
    for (const release of releases) release();
    expect(await answer).toBe('{"ok":true}\n');
  });

  it('answers a handler\'s failure as a refusal within the answer\'s bound', async () => {
    const { hook } = await serve(async () => { throw new Error('x'.repeat(10_000)); });
    const answer = await sendCliRequest(() => net.connect(hook), OPEN);
    expect(answer).toMatchObject({ ok: false, code: 'refused' });
    expect(parseCliAnswer(answer)).toEqual(answer);
  });

  it('carries a command-line request in one switch, refusing a wait marker that is no damocles-wait file', () => {
    const marker = path.join(os.tmpdir(), `damocles-wait-${'a'.repeat(32)}`);
    const commandLine = { request: { kind: 'open', cwd: 'C:\\work', items: [{ path: 'C:\\work\\a b.txt' }], wait: true }, remote: 'ssh+prod-1', waitMarker: marker } as const;
    expect(parseCommandLine(['damocles.exe', '--flag', commandLineSwitch(commandLine)])).toEqual(commandLine);
    expect(parseCommandLine(['damocles.exe'])).toBeUndefined();
    expect(() => parseCommandLine([commandLineSwitch(commandLine), commandLineSwitch(commandLine)])).toThrow('2 times');
    expect(() => parseCommandLine([commandLineSwitch({ ...commandLine, waitMarker: path.join(os.tmpdir(), 'settings.json') })])).toThrow('not a damocles-wait file');
    expect(() => parseCommandLine([commandLineSwitch({ ...commandLine, waitMarker: 'damocles-wait-' + 'a'.repeat(32) })])).toThrow('not a damocles-wait file');
    const status = `--damocles-cli=${Buffer.from(JSON.stringify({ request: { kind: 'status' } })).toString('base64url')}`;
    expect(() => parseCommandLine([status])).toThrow('outside the contract');
  });

  it('names the wait marker of a switch it refuses, when that switch\'s JSON names a damocles-wait file, so main still deletes it', () => {
    const marker = path.join(os.tmpdir(), `damocles-wait-${'b'.repeat(32)}`);
    const refusal = (value: unknown): unknown => {
      try {
        parseCommandLine([`--damocles-cli=${Buffer.from(JSON.stringify(value)).toString('base64url')}`]);
      } catch (err) {
        return err;
      }
      throw new Error('accepted');
    };
    const items = Array.from({ length: 65 }, (_, index) => ({ path: `/srv/${index}` }));
    expect(refusal({ request: { kind: 'open', cwd: '/', items, wait: true }, waitMarker: marker })).toMatchObject({ name: 'CommandLineRefusal', waitMarker: marker });
    expect(refusal({ request: { kind: 'open', cwd: '/', items: [{ path: 'x'.repeat(70_000) }], wait: true }, waitMarker: marker })).toMatchObject({ waitMarker: marker });
    expect(refusal({ request: { kind: 'status' }, waitMarker: path.join(os.tmpdir(), 'settings.json') })).toMatchObject({ waitMarker: undefined });
    expect(() => parseCommandLine(['--damocles-cli=bm90IGpzb24'])).toThrow(CommandLineRefusal);
  });

  it('names the first bound a request breaks: its paths, each path\'s length, a URL\'s, then its bytes', () => {
    const open = (items: readonly string[], cwd = '/srv'): CliRequest => ({ kind: 'open', cwd, items: items.map((item) => ({ path: item })), wait: false });
    expect(cliRequestLimit(open(Array.from({ length: 64 }, (_, index) => `/srv/${index}`)), 100)).toBeUndefined();
    expect(cliRequestLimit(open(Array.from({ length: 65 }, (_, index) => `/srv/${index}`)), 100)).toEqual({ kind: 'items', max: 64 });
    expect(cliRequestLimit(open(['/srv/a', `/${'p'.repeat(4096)}`]), 100)).toEqual({ kind: 'chars', value: `/${'p'.repeat(4096)}`, max: 4096 });
    expect(cliRequestLimit(open([], `/${'c'.repeat(4096)}`), 100)).toMatchObject({ kind: 'chars', max: 4096 });
    expect(cliRequestLimit({ kind: 'diff', cwd: '/', left: '/a', right: `/${'r'.repeat(4096)}`, wait: false }, 100)).toMatchObject({ kind: 'chars', max: 4096 });
    expect(cliRequestLimit({ kind: 'openExternal', url: `https://a.test/${'u'.repeat(8192)}` }, 100)).toMatchObject({ kind: 'chars', max: 8192 });
    expect(cliRequestLimit(open(['/srv/a']), MAX_CLI_REQUEST_BYTES)).toBeUndefined();
    expect(cliRequestLimit(open(['/srv/a']), MAX_CLI_REQUEST_BYTES + 1)).toEqual({ kind: 'bytes', max: MAX_CLI_REQUEST_BYTES });
    // every request within the bounds the command checks is one the contract takes
    const within = open(Array.from({ length: 64 }, (_, index) => `/${String(index).padStart(4096, 'q')}`.slice(0, 4096)));
    expect(cliRequestLimit(within, Buffer.byteLength(JSON.stringify(within)))).toEqual({ kind: 'bytes', max: MAX_CLI_REQUEST_BYTES });
    const commandLine = { request: { kind: 'open', cwd: '/', items: [{ path: '/a' }], wait: false }, remote: `ssh+${'h'.repeat(1020)}` } as const;
    expect(commandLineLimit(commandLine)).toBeUndefined();
    expect(commandLineLimit({ ...commandLine, remote: `ssh+${'h'.repeat(1021)}` })).toMatchObject({ kind: 'chars', max: 1024 });
    expect(parseCommandLine([commandLineSwitch(commandLine)])).toEqual(commandLine);
  });
});
