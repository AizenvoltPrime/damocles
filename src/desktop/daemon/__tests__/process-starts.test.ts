import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import { PassThrough } from 'node:stream';
import { EventEmitter } from 'node:events';
import { buildSync } from 'esbuild';
import { describe, expect, it, vi } from 'vitest';
import { forkChild, startDetached, WMI_TIMEOUT_MS } from '../process-starts';

// hung: the PowerShell a start runs answers nothing until it is killed; spawned: every file started meanwhile
const H = vi.hoisted(() => ({ hung: false, spawned: [] as string[], killed: 0 }));

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    spawn: (...args: Parameters<typeof actual.spawn>) => {
      if (!H.hung) return actual.spawn(...args);
      H.spawned.push(String(args[0]));
      const shell = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: () => { H.killed++; } });
      return shell;
    },
  };
});

const GRANDCHILD_HOLD_MS = 30_000;
const quiet = (): void => undefined;
const ownEnv = (): Record<string, string> => Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe.runIf(process.platform === 'win32')('the bridge\'s detached start on Windows', () => {
  // Win32_Process.Create may still start the process after its PowerShell is killed, so a second start could run it twice
  it('fails without a detached start when WMI does not answer in time', async () => {
    H.hung = true;
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const lines: string[] = [];
      const starting = startDetached(process.execPath, ['child.js'], ownEnv(), os.tmpdir(), (line) => lines.push(line));
      const failed = expect(starting).rejects.toThrow(`the WMI start did not finish within ${WMI_TIMEOUT_MS} ms`);
      await vi.advanceTimersByTimeAsync(WMI_TIMEOUT_MS);
      await failed;
      expect(H.spawned).toHaveLength(1);
      expect(path.basename(H.spawned[0]!).toLowerCase()).toBe('powershell.exe');
      expect(H.killed).toBe(1);
      expect(lines).toEqual([]);
    } finally {
      vi.useRealTimers();
      H.hung = false;
    }
  });

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
      await startDetached(process.execPath, [entry, report, 'with space', 'quote"inside', 'ends\\'], env, cwd, quiet);
      await expect.poll(() => fs.existsSync(report), { timeout: 15_000 }).toBe(true);
      expect(JSON.parse(fs.readFileSync(report, 'utf8'))).toEqual({ args: ['with space', 'quote"inside', 'ends\\'], cwd, value });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    }
  }, 30_000);
});

describe('the bridge\'s detached start', () => {
  // the started daemon outlives the app, so a crashpad handler it connected to would outlive it too, holding the app's stdio
  it('gives the started process none of the starter\'s crashpad handler', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dm-crashpad-'));
    const report = path.join(dir, 'report.json');
    const entry = path.join(dir, 'child.js');
    fs.writeFileSync(entry, `
      const fs = require('node:fs');
      fs.writeFileSync(process.argv[2] + '.tmp', JSON.stringify({ pipe: process.env.CHROME_CRASHPAD_PIPE_NAME ?? null, probe: process.env.DAMOCLES_START_PROBE, pid: process.pid }));
      fs.renameSync(process.argv[2] + '.tmp', process.argv[2]);
    `);
    const env = {
      ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)),
      CHROME_CRASHPAD_PIPE_NAME: '\\\\.\\pipe\\crashpad_1_ABCDEF',
      DAMOCLES_START_PROBE: 'kept',
    };
    try {
      const pid = await startDetached(process.execPath, [entry, report], env, dir, quiet);
      await expect.poll(() => fs.existsSync(report), { timeout: 15_000 }).toBe(true);
      expect(JSON.parse(fs.readFileSync(report, 'utf8'))).toEqual({ pipe: null, probe: 'kept', pid });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    }
  }, 30_000);
});

// A starter process starts a long-lived child through startDetached and exits; the child must run on, under the pid the
// starter was answered.
describe('a process started detached', () => {
  // the starter is process-starts.ts bundled, as the daemon's bundle carries it
  const starter = (dir: string, mode: 'primary' | 'fallback'): string => {
    const source = path.join(dir, 'starter.ts');
    const started = path.join(dir, 'started.json');
    fs.writeFileSync(source, `
      import * as fs from 'node:fs';
      import { startDetached } from ${JSON.stringify(path.resolve(__dirname, '..', 'process-starts.ts'))};
      const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
      const lines: string[] = [];
      // a system folder with no PowerShell makes the WMI start fail, as a host whose WMI refuses does; the child keeps the real one
      if (${JSON.stringify(mode)} === 'fallback') process.env['SystemRoot'] = ${JSON.stringify(path.join(dir, 'no-windows'))};
      void startDetached(process.execPath, [${JSON.stringify(path.join(dir, 'child.js'))}], env, ${JSON.stringify(dir)}, (line) => lines.push(line)).then((pid) => {
        fs.writeFileSync(${JSON.stringify(`${started}.tmp`)}, JSON.stringify({ pid, lines }));
        fs.renameSync(${JSON.stringify(`${started}.tmp`)}, ${JSON.stringify(started)});
        process.exit(0);
      });
    `);
    const outfile = path.join(dir, 'starter.cjs');
    buildSync({ entryPoints: [source], bundle: true, platform: 'node', format: 'cjs', outfile, logLevel: 'silent' });
    return outfile;
  };

  const run = async (mode: 'primary' | 'fallback'): Promise<{ pid: number; childPid: number; lines: string[]; starterGone: boolean; dir: string }> => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dm-detached-'));
    fs.writeFileSync(path.join(dir, 'child.js'), `
      const fs = require('node:fs');
      fs.writeFileSync(${JSON.stringify(path.join(dir, 'child.pid'))}, String(process.pid));
      setTimeout(() => undefined, ${GRANDCHILD_HOLD_MS});
    `);
    const starting = spawn(process.execPath, [starter(dir, mode)], { stdio: 'ignore', env: ownEnv() });
    await new Promise<void>((resolve) => starting.once('exit', () => resolve()));
    await expect.poll(() => fs.existsSync(path.join(dir, 'child.pid')), { timeout: 20_000 }).toBe(true);
    const started = JSON.parse(fs.readFileSync(path.join(dir, 'started.json'), 'utf8')) as { pid: number; lines: string[] };
    return { ...started, childPid: Number(fs.readFileSync(path.join(dir, 'child.pid'), 'utf8')), starterGone: !alive(starting.pid!), dir };
  };

  it.runIf(process.platform === 'win32')('through WMI answers the pid of a child that outlives its starter', async () => {
    const started = await run('primary');
    try {
      expect(started.lines).toEqual([]);
      expect(started.pid).toBe(started.childPid);
      expect(started.starterGone).toBe(true);
      expect(alive(started.childPid)).toBe(true);
    } finally {
      process.kill(started.childPid);
      fs.rmSync(started.dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    }
  }, 60_000);

  it.runIf(process.platform === 'win32')('falls back to a detached spawn when WMI refuses, says so, and the child outlives its starter', async () => {
    const started = await run('fallback');
    try {
      expect(started.lines).toHaveLength(1);
      expect(started.lines[0]).toMatch(/^\[start\] .*; starting .* detached instead$/);
      expect(started.pid).toBe(started.childPid);
      expect(started.starterGone).toBe(true);
      expect(alive(started.childPid)).toBe(true);
    } finally {
      process.kill(started.childPid);
      fs.rmSync(started.dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    }
  }, 60_000);

  it.runIf(process.platform !== 'win32')('answers the pid of a child that outlives its starter', async () => {
    const started = await run('primary');
    try {
      expect(started.pid).toBe(started.childPid);
      expect(started.starterGone).toBe(true);
      expect(alive(started.childPid)).toBe(true);
    } finally {
      process.kill(started.childPid);
      fs.rmSync(started.dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    }
  }, 60_000);
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
