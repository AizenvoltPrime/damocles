import { spawn } from 'node:child_process';
import { once } from 'node:events';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { build } from 'esbuild';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { logFileName } from '../../local-services/log-sink';
import { DAEMON_LOG } from '../logs';
import { dropInheritedVariables, EXIT_START_FAILED } from '../serve';
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

  it.runIf(process.platform !== 'win32')('removes the git credential relay\'s folder when the start fails after making it', async () => {
    const versioned = fs.mkdtempSync(path.join(os.tmpdir(), 'dm-serve-root-'));
    fs.cpSync(path.join(root, 'dist'), path.join(versioned, 'dist'), { recursive: true });
    fs.writeFileSync(path.join(versioned, 'package.json'), JSON.stringify({ version: '0.0.0-test' }));
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dm-serve-home-'));
    // a pid file that cannot be read fails the start once the relay exists
    fs.mkdirSync((await localRunPaths(home)).pidFile, { recursive: true });
    const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, USERPROFILE: home, NODE_PATH: path.join(REPO_ROOT, 'node_modules') };
    delete env['ELECTRON_RUN_AS_NODE'];
    const daemon = spawn(process.execPath, [path.join(versioned, 'dist', 'daemon.js'), 'serve'], { env, stdio: 'ignore' });
    const [code] = await once(daemon, 'exit') as [number | null];
    expect(code).toBe(EXIT_START_FAILED);
    const log = fs.readFileSync(path.join((await localRunPaths(home)).logsDir, logFileName(DAEMON_LOG)), 'utf8');
    const handle = /\[daemon\] the git credential relay's handle is (\S+)/.exec(log)?.[1];
    expect(handle).toBeDefined();
    expect(fs.existsSync(path.dirname(handle!))).toBe(false);
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(versioned, { recursive: true, force: true });
  }, 60_000);
});

describe('the daemon\'s own environment', () => {
  it('holds no Electron variable and no SSH_AUTH_SOCK, which only a client\'s agent proxy socket may replace', () => {
    const env: NodeJS.ProcessEnv = { PATH: '/bin', ELECTRON_RUN_AS_NODE: '1', electron_no_attach_console: '1', SSH_AUTH_SOCK: '/tmp/ssh-started-the-daemon/agent.1', SSH_CONNECTION: '1 2 3 4' };
    dropInheritedVariables(env);
    expect(env).toEqual({ PATH: '/bin', SSH_CONNECTION: '1 2 3 4' });
  });
});
