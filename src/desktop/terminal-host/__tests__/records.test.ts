import { promises as fs } from 'node:fs';
import type * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runPathsIn } from '../../daemon/token';
import type { HostedTerminal } from '../host-messages';
import { IDENTITY_RETRY_MAX_MS, serveTerminalHost, type ServedTerminalHost } from '../records';

// every server made, so a test reaches the host's endpoint
const servers = vi.hoisted((): net.Server[] => []);
vi.mock('node:net', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:net')>();
  const createServer = (...args: Parameters<typeof original.createServer>): ReturnType<typeof original.createServer> => {
    const server = original.createServer(...args);
    servers.push(server);
    return server;
  };
  return { ...original, default: { ...original, createServer }, createServer };
});

const DAY_MS = 24 * 60 * 60 * 1000;
const REWRITE_MS = 100_000;
const terminal = (id: string, pid: number): HostedTerminal => ({ id, pid, cols: 80, rows: 24, scrollback: 1000, title: 'sh', projectKey: '' });
// real I/O runs between the checks, while the faked timers stand still
const until = async (check: () => boolean): Promise<void> => {
  while (!check()) await new Promise((resolve) => setImmediate(resolve));
};

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function serve(identity: (pid: number) => Promise<string | undefined>, log: (line: string) => void = () => undefined): Promise<ServedTerminalHost> {
  const runDir = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'dm-records-')), 'run-0123456789abcdef');
  await fs.mkdir(runDir, { recursive: true });
  const served = await serveTerminalHost({ paths: runPathsIn(runDir), version: '3.7.0+0123456789ab', accept: (socket) => socket.destroy(), touchIntervalMs: DAY_MS, identity, rewriteMs: REWRITE_MS, log });
  cleanups.push(async () => {
    await served.close();
    await fs.rm(path.dirname(runDir), { recursive: true, force: true });
  });
  return served;
}

describe('a terminal host\'s endpoint', () => {
  // an accept error (EMFILE) must reach the host's log, never its uncaught-exception path
  it('logs an error of its server once it listens', async () => {
    const logs: string[] = [];
    const made = servers.length;
    const served = await serve(async (pid) => `start of ${pid}`, (line) => logs.push(line));
    const [server] = servers.slice(made);
    expect(() => server!.emit('error', new Error('accept EMFILE'))).not.toThrow();
    expect(logs).toContain(`[terminal-host] its endpoint ${served.record.endpoint} failed: accept EMFILE`);
  });
});

describe('the start identities in a terminal host\'s terminals file', () => {
  // a read that keeps failing (macOS ps timing out under load) must not start a tool per shell at once, every interval, for good
  it('reads failing ones one at a time, each again later after each failure, up to a cap', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const reads = new Map<number, number[]>();
    let running = 0;
    let mostRunning = 0;
    const served = await serve(async (pid) => {
      if (pid === process.pid) return `start of ${pid}`;
      reads.set(pid, [...(reads.get(pid) ?? []), Date.now()]);
      running++;
      mostRunning = Math.max(mostRunning, running);
      await new Promise((resolve) => setImmediate(resolve));
      running--;
      throw new Error('ps did not finish within 5000 ms');
    });
    served.list([terminal('term-1', 4001), terminal('term-2', 4002)]);
    for (let round = 1; round < 6; round++) {
      await until(() => reads.get(4002)?.length === round && vi.getTimerCount() === 1);
      await vi.advanceTimersToNextTimerAsync();
    }
    await until(() => reads.get(4002)?.length === 6);
    const gaps = (pid: number): number[] => reads.get(pid)!.slice(1).map((at, index) => at - reads.get(pid)![index]!);
    expect(gaps(4001)).toEqual([REWRITE_MS, 2 * REWRITE_MS, 4 * REWRITE_MS, IDENTITY_RETRY_MAX_MS, IDENTITY_RETRY_MAX_MS]);
    expect(gaps(4002)).toEqual(gaps(4001));
    expect(mostRunning).toBe(1);
  });
});
