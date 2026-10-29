import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { forkChild, startDaemonDetached } from '../process-starts';

const GRANDCHILD_HOLD_MS = 30_000;

describe.runIf(process.platform === 'win32')('the bridge\'s detached start on Windows', () => {
  it('gives the started process its arguments, folder and environment exactly, non-ASCII, quotes and = included', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dm start '));
    const cwd = path.join(dir, 'wörk dir');
    fs.mkdirSync(cwd);
    const report = path.join(dir, 'report.json');
    const entry = path.join(dir, 'child.js');
    fs.writeFileSync(entry, `
      const fs = require('node:fs');
      fs.writeFileSync(process.argv[2] + '.tmp', JSON.stringify({ args: process.argv.slice(3), cwd: process.cwd(), value: process.env.DAMOCLES_START_PROBE }));
      fs.renameSync(process.argv[2] + '.tmp', process.argv[2]);
    `);
    const value = 'a=b "quoted" ünï 日本 \\ trailing\\';
    const env = { ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)), DAMOCLES_START_PROBE: value };
    try {
      await startDaemonDetached(process.execPath, [entry, report, 'with space', 'quote"inside', 'ends\\'], env, cwd);
      await expect.poll(() => fs.existsSync(report), { timeout: 15_000 }).toBe(true);
      expect(JSON.parse(fs.readFileSync(report, 'utf8'))).toEqual({ args: ['with space', 'quote"inside', 'ends\\'], cwd, value });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    }
  }, 30_000);
});

describe('a forked child of the daemon', () => {
  it('reports its exit and stderr tail while a grandchild still holds its stderr', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dm-fork-'));
    const pidFile = path.join(dir, 'grandchild.pid');
    const entry = path.join(dir, 'child.js');
    // as an MCP server started with stderr 'inherit' outlives the core that started it; detached, so no Windows job ends it
    fs.writeFileSync(entry, `
      const { spawn } = require('node:child_process');
      const grandchild = spawn(process.execPath, ['-e', 'setTimeout(() => undefined, ${GRANDCHILD_HOLD_MS})'], { stdio: ['ignore', 'ignore', 'inherit'], detached: true });
      require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(grandchild.pid));
      process.stderr.write('boom', () => process.exit(3));
    `);
    const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
    const child = forkChild(entry, [], env);
    const started = Date.now();
    const exit = await new Promise<{ code: number; error: string | null }>((resolve) => child.onExit(resolve));
    try {
      expect(Date.now() - started).toBeLessThan(GRANDCHILD_HOLD_MS / 2);
      expect(exit.code).toBe(3);
      expect(exit.error).toBe('boom');
    } finally {
      process.kill(Number(fs.readFileSync(pidFile, 'utf8')));
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);
});
