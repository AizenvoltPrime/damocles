import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as mcp from '@earendil-works/pi-mcp';
import { alive } from '../../../../__mocks__/process-alive';
import { SPAWN_TEST_TIMEOUT_MS } from '../../../../__mocks__/spawn-budget';
import { installProcessLauncher, type KillOptions, type LaunchedProcess, type ProcessExit } from '../../../process-launcher';
import { launcherPipe } from '../launcher-transport';

// Answers each request with its own pid and a helper's; leaves on stdin's end unless told to ignore it.
// With --leave-helper the helper holds the server's stdout and outlives the server's exit.
const SERVER = `
const { spawn } = require('node:child_process');
const readline = require('node:readline');
const leaveHelper = process.argv.includes('--leave-helper');
const helper = spawn(process.execPath, ['-e', 'setInterval(() => undefined, 1 << 30)'], { stdio: ['ignore', leaveHelper ? 'inherit' : 'ignore', 'ignore'] });
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const request = JSON.parse(line);
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { pid: process.pid, helper: helper.pid } }) + '\\n');
});
process.stdin.on('end', () => {
  if (process.argv.includes('--ignore-stdin-end')) return;
  if (!leaveHelper) helper.kill();
  process.exit(0);
});
`;

// Ignores stdin closing and SIGTERM; reports its pid on stderr once both are in place.
const STUBBORN = `
process.on('SIGTERM', () => undefined);
process.stdin.resume();
process.stderr.write('ready ' + process.pid + '\\n');
`;

// Writes what its mode names, then leaves on stdin's end.
const FRAMING = `
const mode = process.argv[2];
const message = (method) => JSON.stringify({ jsonrpc: '2.0', method });
const leave = () => process.exit(0);
if (mode === 'split') {
  process.stdout.write(message('split').slice(0, 10));
  setTimeout(() => process.stdout.write(message('split').slice(10) + '\\n'), 100);
}
if (mode === 'crlf') process.stdout.write(message('crlf') + '\\r\\n');
if (mode === 'oversized') process.stdout.write(Buffer.alloc(16 * 1024 * 1024 + 1, 0x78), () => process.stdout.write('\\n' + message('after') + '\\n'));
if (mode === 'incomplete') process.stdout.write('{"jsonrpc":"2.0"', leave);
if (mode === 'stderr') process.stderr.write('e'.repeat(70 * 1024) + 'END', leave);
process.stdin.resume();
process.stdin.on('end', leave);
`;

let dir: string;
let script: string;
let stubborn: string;
let framing: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'damocles-mcp-transport-'));
  script = path.join(dir, 'server.js');
  fs.writeFileSync(script, SERVER);
  stubborn = path.join(dir, 'stubborn.js');
  fs.writeFileSync(stubborn, STUBBORN);
  framing = path.join(dir, 'framing.js');
  fs.writeFileSync(framing, FRAMING);
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

async function until(check: () => boolean, ms: number): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
}

function open(command: string, args: string[]): mcp.PipeTransportOptions['open'] {
  return launcherPipe({ command, args, cwd: dir, env: { ...process.env } as Record<string, string>, stderr: 'pipe' });
}

// The grace server-manager.ts gives a server after stdin closes.
function transport(command: string, args: string[], closeTimeoutMs = 500): mcp.PipeTransport {
  return new mcp.PipeTransport({ open: open(command, args), closeTimeoutMs });
}

async function ask(server: mcp.PipeTransport): Promise<{ pid: number; helper: number }> {
  const reply = new Promise<mcp.JsonRpcMessage>((resolve) => server.onMessage(resolve));
  await server.send({ jsonrpc: '2.0', id: 1, method: 'ping' });
  return ((await reply) as mcp.JsonRpcSuccessResponse).result as { pid: number; helper: number };
}

// Above every platform's pid range, so the host-exit hook can never signal a real group with it.
const FAKE_PID = 4_194_305;

interface FakeChild {
  readonly child: LaunchedProcess;
  readonly kills: KillOptions[];
  readonly ended: () => boolean;
  /** The server process exits; its output stays open. */
  exit(): void;
  /** The server's output closes, settling `closed`. */
  closeOutput(): void;
  reply(message: object): void;
}

/** A launched process whose tree kill ends it, as the launcher's does. */
function fakeChild(write: (line: string) => Promise<void> = async () => undefined): FakeChild {
  let stdout: (chunk: Buffer) => void = () => undefined;
  let exit!: (value: ProcessExit) => void;
  let close!: () => void;
  let ended = false;
  const exited = new Promise<ProcessExit>((resolve) => (exit = resolve));
  const closed = new Promise<void>((resolve) => (close = resolve));
  const kills: KillOptions[] = [];
  const child: LaunchedProcess = {
    pid: Promise.resolve(FAKE_PID),
    exited,
    closed,
    leftRunning: closed.then(() => false),
    onData: (stream, listener) => {
      if (stream === 'stdout') stdout = listener;
    },
    write: (chunk) => write(String(chunk)),
    end: () => {
      ended = true;
    },
    kill: (options = {}) => {
      kills.push(options);
      if (!options.tree) return;
      exit({ code: null, signal: 'SIGTERM' });
      close();
    },
  };
  return {
    child,
    kills,
    ended: () => ended,
    exit: () => exit({ code: 0, signal: null }),
    closeOutput: () => close(),
    reply: (message) => stdout(Buffer.from(`${JSON.stringify(message)}\n`)),
  };
}

async function withLauncher<T>(child: LaunchedProcess, run: () => Promise<T>): Promise<T> {
  const previous = installProcessLauncher({ launch: () => child, createSessionJob: () => ({ id: 1, dispose: () => undefined }), dispose: async () => undefined });
  try {
    return await run();
  } finally {
    installProcessLauncher(previous!);
  }
}

const noOutput: mcp.McpPipeHandlers = { onStdout: () => undefined, onStderr: () => undefined };

describe('launcherPipe under PipeTransport', () => {
  it('exchanges newline-delimited JSON-RPC, and a server that leaves on stdin closing closes the transport', async () => {
    const server = transport(process.execPath, [script]);
    let closed = 0;
    server.onClose(() => closed++);
    await server.start();
    const { pid } = await ask(server);
    await server.close();
    expect(closed).toBe(1);
    await until(() => !alive(pid), 2_000);
    expect(alive(pid)).toBe(false);
    await expect(server.send({ jsonrpc: '2.0', id: 2, method: 'ping' })).rejects.toBeInstanceOf(mcp.McpConnectionClosedError);
  }, SPAWN_TEST_TIMEOUT_MS);

  it('stops a server that ignores stdin closing within 2.5 s, with what it started', async () => {
    const server = transport(process.execPath, [script, '--ignore-stdin-end']);
    await server.start();
    const { pid, helper } = await ask(server);
    const started = Date.now();
    await server.close();
    expect(Date.now() - started).toBeLessThan(2_500);
    await until(() => !alive(pid) && !alive(helper), 5_000);
    expect([alive(pid), alive(helper)]).toEqual([false, false]);
  }, SPAWN_TEST_TIMEOUT_MS);

  it('ends what a server that exits during the close left holding its output, without waiting out the grace', async () => {
    // Only the kill at the server's exit can end the helper before this grace runs out.
    const server = transport(process.execPath, [script, '--leave-helper'], 60_000);
    await server.start();
    const { pid, helper } = await ask(server);
    await server.close();
    expect([alive(pid), alive(helper)]).toEqual([false, false]);
  }, SPAWN_TEST_TIMEOUT_MS);

  it.runIf(process.platform === 'win32')('starts a .cmd shim through cmd.exe and kills the server under it on close', async () => {
    const shim = path.join(dir, 'server shim.cmd');
    fs.writeFileSync(shim, `@"${process.execPath}" "${script}" %*\r\n`);
    const server = transport(shim, ['--ignore-stdin-end']);
    await server.start();
    const { pid, helper } = await ask(server);
    await server.close();
    await until(() => !alive(pid) && !alive(helper), 5_000);
    expect([alive(pid), alive(helper)]).toEqual([false, false]);
  }, SPAWN_TEST_TIMEOUT_MS);

  it('reports a command that does not exist as ENOENT', async () => {
    const server = transport('damocles-no-such-command', []);
    const errors: Error[] = [];
    server.onError((error) => errors.push(error));
    const closed = new Promise<void>((resolve) => server.onClose(resolve));
    // cmd.exe starts and exits 1 on Windows, which cross-spawn reports after the start, as pi-mcp's stdio transport does
    const started = await server.start().then(() => undefined, (error: NodeJS.ErrnoException) => error);
    if (started === undefined) await closed;
    const error = (started ?? errors[0]) as NodeJS.ErrnoException | undefined;
    expect(error?.code).toBe('ENOENT');
  }, SPAWN_TEST_TIMEOUT_MS);

  it('settles exited after close(), escalating to SIGKILL on POSIX for a server that ignores SIGTERM', async () => {
    let ready!: (pid: number) => void;
    const readyPid = new Promise<number>((resolve) => (ready = resolve));
    const pipe = await open(process.execPath, [stubborn])({
      onStdout: () => undefined,
      onStderr: (bytes) => {
        const match = /ready (\d+)/.exec(Buffer.from(bytes).toString('utf8'));
        if (match) ready(Number(match[1]));
      },
    });
    const pid = await readyPid;
    pipe.close();
    await pipe.exited;
    expect(alive(pid)).toBe(false);
  }, SPAWN_TEST_TIMEOUT_MS);
});

describe('launcherPipe with a stand-in launcher', () => {
  it('kills the tree when the server exits after stdin closed, and not when it exits on its own', async () => {
    const own = fakeChild();
    await withLauncher(own.child, async () => {
      const pipe = await open('/unused', [])(noOutput);
      own.exit();
      await own.child.exited;
      await Promise.resolve();
      expect(own.kills).toEqual([]);
      pipe.close();
    });

    const closing = fakeChild();
    await withLauncher(closing.child, async () => {
      const pipe = await open('/unused', [])(noOutput);
      pipe.closeStdin();
      expect(closing.ended()).toBe(true);
      closing.exit();
      await pipe.exited;
      expect(closing.kills).toEqual([{ tree: true, signal: 'SIGTERM' }]);
    });
  });

  it('stops the server when a write to its stdin fails, so pending requests fail at once', async () => {
    const epipe = Object.assign(new Error('write EPIPE'), { code: 'EPIPE' });
    const fake: FakeChild = fakeChild(async (line) => {
      const message = JSON.parse(line) as { id?: number; method: string };
      if (message.method === 'initialize') {
        fake.reply({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: mcp.LATEST_PROTOCOL_VERSION, capabilities: {}, serverInfo: { name: 'fake', version: '1' } } });
      }
      if (message.method === 'tools/list') throw epipe;
    });
    await withLauncher(fake.child, async () => {
      const client = new mcp.McpClient({ name: 'test', version: '1' });
      await client.connect(new mcp.PipeTransport({ open: open('/unused', []), closeTimeoutMs: 500 }));
      const started = Date.now();
      await expect(client.listTools({ timeoutMs: 60_000 })).rejects.toBeInstanceOf(mcp.McpConnectionClosedError);
      expect(Date.now() - started).toBeLessThan(5_000);
      expect(fake.kills[0]).toEqual({ tree: true, signal: 'SIGTERM' });
    });
  });

  it('leaves a server that already ended alone when a write in flight fails', async () => {
    let reject!: (error: Error) => void;
    const fake = fakeChild(() => new Promise<void>((_resolve, rejectWrite) => (reject = rejectWrite)));
    await withLauncher(fake.child, async () => {
      const pipe = await open('/unused', [])(noOutput);
      pipe.write('{}\n');
      fake.exit();
      fake.closeOutput();
      await pipe.exited;
      reject(Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }));
      await new Promise((resolve) => setImmediate(resolve));
      expect(fake.kills).toEqual([]);
    });
  });
});

describe('launcherPipe framing, as pi-mcp frames', () => {
  async function run(mode: string, until: (seen: { messages: mcp.JsonRpcMessage[]; errors: Error[] }) => boolean): Promise<{ server: mcp.PipeTransport; messages: mcp.JsonRpcMessage[]; errors: Error[] }> {
    const server = transport(process.execPath, [framing, mode]);
    const seen = { messages: [] as mcp.JsonRpcMessage[], errors: [] as Error[] };
    server.onMessage((message) => seen.messages.push(message));
    server.onError((error) => seen.errors.push(error));
    await server.start();
    await vi.waitFor(() => expect(until(seen)).toBe(true), { timeout: SPAWN_TEST_TIMEOUT_MS });
    return { server, ...seen };
  }

  it('joins a message split across reads', async () => {
    const { server, messages, errors } = await run('split', (seen) => seen.messages.length > 0);
    expect(messages).toEqual([{ jsonrpc: '2.0', method: 'split' }]);
    expect(errors).toEqual([]);
    await server.close();
  }, SPAWN_TEST_TIMEOUT_MS);

  it('reads a CRLF-terminated message', async () => {
    const { server, messages } = await run('crlf', (seen) => seen.messages.length > 0);
    expect(messages).toEqual([{ jsonrpc: '2.0', method: 'crlf' }]);
    await server.close();
  }, SPAWN_TEST_TIMEOUT_MS);

  it('reports a message past 16 MiB and keeps reading the ones after it', async () => {
    const { server, messages, errors } = await run('oversized', (seen) => seen.messages.length > 0);
    expect(errors[0]?.message).toBe(`MCP stdio message exceeds ${16 * 1024 * 1024} bytes`);
    expect(messages).toEqual([{ jsonrpc: '2.0', method: 'after' }]);
    await server.close();
  }, SPAWN_TEST_TIMEOUT_MS * 2);

  it('reports an incomplete message left at the close', async () => {
    const server = transport(process.execPath, [framing, 'incomplete']);
    const errors: Error[] = [];
    server.onError((error) => errors.push(error));
    const closed = new Promise<void>((resolve) => server.onClose(resolve));
    await server.start();
    await closed;
    expect(errors.map((error) => error.message)).toEqual(['MCP stdio server closed with an incomplete JSON-RPC message']);
  }, SPAWN_TEST_TIMEOUT_MS);

  it('keeps the last 64 KiB of stderr', async () => {
    const server = transport(process.execPath, [framing, 'stderr']);
    const closed = new Promise<void>((resolve) => server.onClose(resolve));
    await server.start();
    await closed;
    expect(server.stderr).toHaveLength(64 * 1024);
    expect(server.stderr.endsWith('eeeEND')).toBe(true);
  }, SPAWN_TEST_TIMEOUT_MS);
});
