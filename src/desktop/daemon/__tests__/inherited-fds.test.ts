import { spawn } from 'node:child_process';
import { once } from 'node:events';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { build } from 'esbuild';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// The fd Electron main's Chromium would hand the bridge: above 15, so Node's startup leaves it without FD_CLOEXEC too.
const LEAKED_FD = 19;
// How long the stand-in daemon stays up unless killed; far past the wait for the bridge's close.
const DAEMON_HOLD_MS = 30_000;
const CLOSE_WITHIN_MS = 5_000;

const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe.runIf(process.platform === 'linux')('a daemon the bridge starts detached', () => {
  let root: string;
  let bridgePath: string;

  beforeAll(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'damocles-inherited-fds-'));
    bridgePath = path.join(root, 'bridge.js');
    const daemonPath = path.join(root, 'daemon.js');
    const options = { bundle: true, platform: 'node', format: 'cjs', target: 'node24', logLevel: 'silent', write: true } as const;
    const resolveDir = path.resolve(__dirname, '..');
    await Promise.all([
      build({ ...options, outfile: bridgePath, stdin: { resolveDir, loader: 'ts', contents: `
        import { startDaemonDetached } from './process-starts';
        void startDaemonDetached(process.execPath, [${JSON.stringify(daemonPath)}], process.env as Record<string, string>, ${JSON.stringify(root)}).then(() => process.exit(0));
      ` } }),
      build({ ...options, outfile: daemonPath, stdin: { resolveDir, loader: 'ts', contents: `
        import { writeFileSync } from 'node:fs';
        import { closeInheritedFds } from './process-starts';
        const named = process.env['DAMOCLES_INHERITED_FDS'] ?? '';
        closeInheritedFds();
        writeFileSync(${JSON.stringify(path.join(root, 'daemon.json'))}, JSON.stringify({ pid: process.pid, named }));
        setTimeout(() => undefined, ${DAEMON_HOLD_MS});
      ` } }),
    ]);
  }, 60_000);

  afterAll(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('keeps none of the fds its starter inherited, so the starter\'s pipes close when it exits', async () => {
    const stdio = Array.from({ length: LEAKED_FD + 1 }, (_, fd) => (fd === LEAKED_FD ? 'pipe' : 'ignore') as 'pipe' | 'ignore');
    const bridge = spawn(process.execPath, [bridgePath], { stdio });
    const report = path.join(root, 'daemon.json');
    let daemon: { pid: number; named: string } | undefined;
    try {
      const closed = once(bridge, 'close');
      await once(bridge, 'exit');
      const outcome = await Promise.race([closed.then(() => 'closed'), new Promise((resolve) => setTimeout(() => resolve('held open'), CLOSE_WITHIN_MS))]);
      await expect.poll(() => fs.existsSync(report)).toBe(true);
      daemon = JSON.parse(fs.readFileSync(report, 'utf8')) as { pid: number; named: string };
      expect(outcome).toBe('closed');
      expect(isAlive(daemon.pid)).toBe(true);
      expect(daemon.named.split(',')).toContain(String(LEAKED_FD));
    } finally {
      if (daemon && isAlive(daemon.pid)) process.kill(daemon.pid, 'SIGKILL');
      bridge.kill('SIGKILL');
    }
  }, 30_000);
});
