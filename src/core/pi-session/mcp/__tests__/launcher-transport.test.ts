import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as mcp from '@earendil-works/pi-mcp';
import { SPAWN_TEST_TIMEOUT_MS } from '../../../../__mocks__/spawn-budget';
import { installProcessLauncher, type LaunchedProcess } from '../../../process-launcher';
import { LauncherStdioTransport } from '../launcher-transport';

// Answers each request with its own pid and a helper's; leaves on stdin's end unless told to ignore it.
const SERVER = `
const { spawn } = require('node:child_process');
const readline = require('node:readline');
const helper = spawn(process.execPath, ['-e', 'setInterval(() => undefined, 1 << 30)'], { stdio: 'ignore' });
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const request = JSON.parse(line);
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { pid: process.pid, helper: helper.pid } }) + '\\n');
});
process.stdin.on('end', () => {
  if (process.argv.includes('--ignore-stdin-end')) return;
  helper.kill();
  process.exit(0);
});
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
let framing: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'damocles-mcp-transport-'));
  script = path.join(dir, 'server.js');
  fs.writeFileSync(script, SERVER);
  framing = path.join(dir, 'framing.js');
  fs.writeFileSync(framing, FRAMING);
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

async function until(check: () => boolean, ms: number): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
}

function transport(command: string, args: string[]): LauncherStdioTransport {
  return new LauncherStdioTransport(mcp, { command, args, cwd: dir, env: { ...process.env } as Record<string, string>, stderr: 'pipe' });
}

async function ask(server: LauncherStdioTransport): Promise<{ pid: number; helper: number }> {
  const reply = new Promise<mcp.JsonRpcMessage>((resolve) => server.onMessage(resolve));
  await server.send({ jsonrpc: '2.0', id: 1, method: 'ping' });
  return ((await reply) as mcp.JsonRpcSuccessResponse).result as { pid: number; helper: number };
}

describe('LauncherStdioTransport', () => {
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

  it('kills a server that ignores stdin closing, with what it started', async () => {
    const server = transport(process.execPath, [script, '--ignore-stdin-end']);
    await server.start();
    const { pid, helper } = await ask(server);
    await server.close();
    await until(() => !alive(pid) && !alive(helper), 5_000);
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
    // cmd.exe starts and exits 1 on Windows, which cross-spawn reports after the start, as pi-mcp's transport does
    const started = await server.start().then(() => undefined, (error: NodeJS.ErrnoException) => error);
    await closed;
    const error = (started ?? errors[0]) as NodeJS.ErrnoException | undefined;
    expect(error?.code).toBe('ENOENT');
  }, SPAWN_TEST_TIMEOUT_MS);
});

describe('LauncherStdioTransport framing, as pi-mcp frames', () => {
  async function run(mode: string, until: (seen: { messages: mcp.JsonRpcMessage[]; errors: Error[] }) => boolean): Promise<{ server: LauncherStdioTransport; messages: mcp.JsonRpcMessage[]; errors: Error[] }> {
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

  it('rejects a send whose write to the server\'s stdin fails, as pi-mcp\'s does', async () => {
    const epipe = Object.assign(new Error('write EPIPE'), { code: 'EPIPE' });
    const pending = new Promise<never>(() => undefined);
    const child: LaunchedProcess = {
      pid: Promise.resolve(4242),
      exited: pending,
      closed: pending,
      onData: () => undefined,
      write: () => Promise.reject(epipe),
      end: () => undefined,
      kill: () => undefined,
    };
    const previous = installProcessLauncher({ launch: () => child, createSessionJob: () => ({ id: 1, dispose: () => undefined }), dispose: async () => undefined });
    try {
      const server = transport('/unused', []);
      await server.start();
      await expect(server.send({ jsonrpc: '2.0', id: 1, method: 'ping' })).rejects.toBe(epipe);
    } finally {
      installProcessLauncher(previous!);
    }
  });
});
