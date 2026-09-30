import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { collectEnvDump, mergeLoginShellEnv, probeGit, type EnvDumpResult } from '../shell-env';

let saved: NodeJS.ProcessEnv;
let dir: string;
const lines: string[] = [];
const log = (line: string): void => {
  lines.push(line);
};

beforeEach(() => {
  saved = { ...process.env };
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'damocles-shell-env-'));
  lines.length = 0;
});

afterEach(() => {
  for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
  Object.assign(process.env, saved);
  fs.rmSync(dir, { recursive: true, force: true });
});

/** A stand-in login shell: profile noise around the command, then a profile export, as a real rc file would. */
function fakeShell(body: string): string {
  const shell = path.join(dir, 'fake-login-shell');
  fs.writeFileSync(shell, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  return shell;
}

describe('collectEnvDump', () => {
  const MARKER = '__M__';
  function collect(maxBytes = 1024 * 1024): { stdout: PassThrough; results: EnvDumpResult[] } {
    const stdout = new PassThrough();
    const results: EnvDumpResult[] = [];
    collectEnvDump(stdout, MARKER, maxBytes, (result) => results.push(result));
    return { stdout, results };
  }
  const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

  it('keeps a character that one read splits from the next whole', async () => {
    const { stdout, results } = collect();
    const dump = Buffer.from(`noise ${MARKER}${JSON.stringify({ HOME: '/home/Γιώργος', PATH: '/opt/ζ/bin' })}${MARKER}`, 'utf8');
    const split = dump.indexOf(Buffer.from('ώ', 'utf8')) + 1;
    stdout.write(dump.subarray(0, split));
    stdout.write(dump.subarray(split));
    await flush();
    expect(results).toEqual([{ env: { HOME: '/home/Γιώργος', PATH: '/opt/ζ/bin' } }]);
  });

  it('settles as soon as the closing marker arrives, though stdout stays open', async () => {
    const { stdout, results } = collect();
    stdout.write(`${MARKER}{"A":"1"}${MARKER}`);
    await flush();
    expect(results).toEqual([{ env: { A: '1' } }]);
    expect(stdout.writableEnded).toBe(false);
    stdout.write('a background job keeps printing');
    await flush();
    expect(results).toHaveLength(1);
  });

  it('counts the output cap in bytes, not characters', async () => {
    const { stdout, results } = collect(100);
    stdout.write('ζ'.repeat(60));
    await flush();
    expect(results).toEqual([{ error: 'printed more than 100 bytes' }]);
  });

  it('reports an environment that does not parse', async () => {
    const { stdout, results } = collect();
    stdout.write(`${MARKER}{not json${MARKER}`);
    await flush();
    expect(results).toEqual([{ error: expect.stringContaining('does not parse') }]);
  });
});

describe('mergeLoginShellEnv', () => {
  it.skipIf(process.platform !== 'win32')('leaves the environment alone on Windows, whose GUI apps inherit it', async () => {
    process.env['SHELL'] = 'C:\\nonexistent\\shell.exe';
    const before = { ...process.env };
    await mergeLoginShellEnv(log);
    expect(process.env).toEqual(before);
  });

  describe.skipIf(process.platform === 'win32')('on macOS and Linux', () => {
    it('merges what the login shell exports, past profile noise on stdout', async () => {
      const bin = path.join(dir, 'profile-bin');
      process.env['SHELL'] = fakeShell([
        'echo "Welcome back! $(date)"',
        `export PATH="${bin}:$PATH"`,
        'export DAMOCLES_FROM_PROFILE=yes',
        'eval "$4"',
        'echo "goodbye"',
      ].join('\n'));
      await mergeLoginShellEnv(log);
      expect(process.env['DAMOCLES_FROM_PROFILE']).toBe('yes');
      expect(process.env['PATH']!.split(path.delimiter)[0]).toBe(bin);
      expect(process.env['ELECTRON_RUN_AS_NODE']).toBe(saved['ELECTRON_RUN_AS_NODE']);
    });

    it('never runs an environment value as a command', async () => {
      const marker = path.join(dir, 'pwned');
      const hostile = `$(touch ${marker}); \`touch ${marker}\`; ' "`;
      process.env['DAMOCLES_HOSTILE'] = hostile;
      process.env['SHELL'] = fakeShell('eval "$4"');
      await mergeLoginShellEnv(log);
      expect(fs.existsSync(marker)).toBe(false);
      expect(process.env['DAMOCLES_HOSTILE']).toBe(hostile);
    });

    it('merges the environment without waiting for a background job that holds stdout open', async () => {
      process.env['SHELL'] = fakeShell(['(sleep 30) &', 'export DAMOCLES_FROM_PROFILE=early', 'eval "$4"'].join('\n'));
      const started = Date.now();
      await mergeLoginShellEnv(log, 5_000);
      expect(process.env['DAMOCLES_FROM_PROFILE']).toBe('early');
      expect(Date.now() - started).toBeLessThan(4_000);
    });

    it('gives up on a profile that never prints the environment within the deadline', async () => {
      process.env['SHELL'] = fakeShell('sleep 30');
      const before = { ...process.env };
      await mergeLoginShellEnv(log, 300);
      expect(process.env).toEqual(before);
      expect(lines.some((line) => line.includes('did not print its environment within 300 ms'))).toBe(true);
    });

    it('logs and keeps the launch environment when the shell prints no environment', async () => {
      process.env['SHELL'] = fakeShell('echo "broken profile"; exit 3');
      const before = { ...process.env };
      await mergeLoginShellEnv(log);
      expect(process.env).toEqual(before);
      expect(lines.some((line) => line.includes('keeping the launch environment'))).toBe(true);
    });
  });
});

describe('probeGit', () => {
  it('reports git missing from PATH with a localized reason the user can act on', async () => {
    process.env['PATH'] = dir;
    const t = vi.fn((message: string) => `[el] ${message}`);
    const probe = await probeGit(log, t);
    expect(probe).toEqual({ available: false, reason: '[el] Git was not found on PATH, so checkpoints and rewind are turned off. Install Git and restart Damocles.' });
  });
});
