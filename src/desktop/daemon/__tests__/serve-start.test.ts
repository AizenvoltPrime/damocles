import { spawn } from 'node:child_process';
import { once } from 'node:events';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { build } from 'esbuild';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { logFileName } from '../../local-services/log-sink';
import { DAEMON_LOG } from '../logs';
import { EXIT_START_FAILED } from '../serve';
import { localRunPaths } from '../token';
import { REPO_ROOT } from './in-process-daemon';

describe('a daemon start that fails', () => {
  let root: string;

  // a package root with the daemon and its launcher worker but no package.json, so the start fails once its log is open;
  // its packages resolve from the checkout through NODE_PATH
  beforeAll(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'dm-serve-start-'));
    const options = { bundle: true, platform: 'node', format: 'cjs', target: 'node24', logLevel: 'silent', write: true, packages: 'external' } as const;
    await Promise.all([
      build({ ...options, entryPoints: [path.join(REPO_ROOT, 'src', 'desktop', 'daemon', 'main.ts')], outfile: path.join(root, 'dist', 'daemon.js') }),
      build({ ...options, entryPoints: [path.join(REPO_ROOT, 'src', 'core', 'process-launcher', 'worker.ts')], outfile: path.join(root, 'dist', 'process-launcher-worker.js') }),
      build({ ...options, entryPoints: [path.join(REPO_ROOT, 'src', 'core', 'pi-session', 'tools', 'shell-sentinel.ts')], outfile: path.join(root, 'dist', 'sentinel.js') }),
    ]);
  }, 120_000);

  afterAll(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('records why in the daemon log, since a detached start\'s stderr goes nowhere', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dm-serve-home-'));
    const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, USERPROFILE: home, NODE_PATH: path.join(REPO_ROOT, 'node_modules') };
    delete env['ELECTRON_RUN_AS_NODE'];
    const daemon = spawn(process.execPath, [path.join(root, 'dist', 'daemon.js'), 'serve'], { env, stdio: 'ignore' });
    const [code] = await once(daemon, 'exit') as [number | null];
    expect(code).toBe(EXIT_START_FAILED);
    const log = fs.readFileSync(path.join((await localRunPaths(home)).logsDir, logFileName(DAEMON_LOG)), 'utf8');
    expect(log).toContain(`[daemon] exiting (${EXIT_START_FAILED}): could not start: `);
    expect(log).toContain(path.join(root, 'package.json'));
    fs.rmSync(home, { recursive: true, force: true });
  }, 60_000);
});
