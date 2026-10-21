import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import * as os from 'node:os';
import * as path from 'node:path';
import { build, type BuildOptions, type Plugin } from 'esbuild';
import { getShellConfig } from '@earendil-works/pi-coding-agent';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { SPAWN_TEST_TIMEOUT_MS } from '../../../../__mocks__/spawn-budget';
import { createLauncherPool, installProcessLauncher, type Launcher, type SessionJob } from '../../../process-launcher';
import type { PiCodingAgentModule } from '../../pi-loader';
import { createTrackedBashOperations } from '../bash-tool';

// The shell tool on the production launcher: worker threads, the job objects or the sentinel, and real shells.

const pi = { getShellConfig } as unknown as PiCodingAgentModule;
const CWD = process.cwd();
// Git Bash reads a Windows path with forward slashes.
const NODE = process.execPath.replace(/\\/g, '/');

// koffi finds its native module beside its own files, so the bundle requires it from the repository.
const koffiExternal: Plugin = {
  name: 'koffi-external',
  setup(b) {
    const resolved = createRequire(import.meta.url).resolve('koffi');
    b.onResolve({ filter: /^koffi$/ }, () => ({ path: resolved, external: true }));
  },
};

let root: string;
let launcher: Launcher;
let previous: Launcher | undefined;
let inheritedFds: number[] = [];
const jobs: SessionJob[] = [];

const O_CLOEXEC = 0o2000000;

/** This process's fds above stdio without close-on-exec, which its parent leaked (a GitHub Linux runner leaks two). */
function leakedFds(): number[] {
  return fs
    .readdirSync('/proc/self/fd')
    .filter((fd) => {
      if (Number(fd) <= 2) return false;
      try {
        const flags = /^flags:\s*([0-7]+)$/m.exec(fs.readFileSync(`/proc/self/fdinfo/${fd}`, 'utf8'));
        return flags !== null && (parseInt(flags[1]!, 8) & O_CLOEXEC) === 0;
      } catch {
        // the directory handle readdirSync listed is closed by now
        return false;
      }
    })
    .map(Number)
    .sort((a, b) => a - b);
}

beforeAll(async () => {
  // Read before the launcher opens anything, so a launcher fd that a shell would inherit cannot hide in the expectation.
  if (process.platform === 'linux') inheritedFds = leakedFds();
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'damocles-shell-lifetime-'));
  const options: BuildOptions = { bundle: true, platform: 'node', format: 'cjs', target: 'node24', logLevel: 'silent', plugins: [koffiExternal] };
  const workerPath = path.join(root, 'process-launcher-worker.js');
  const sentinelPath = path.join(root, 'sentinel.js');
  await Promise.all([
    build({ ...options, entryPoints: [path.resolve(__dirname, '..', '..', '..', 'process-launcher', 'worker.ts')], outfile: workerPath }),
    build({ ...options, entryPoints: [path.resolve(__dirname, '..', 'shell-sentinel.ts')], outfile: sentinelPath }),
  ]);
  launcher = createLauncherPool({ workerPath, sentinelPath });
  previous = installProcessLauncher(launcher);
}, 60_000);

afterEach(() => {
  for (const job of jobs.splice(0)) job.dispose();
});

afterAll(async () => {
  if (previous) installProcessLauncher(previous);
  await launcher.dispose();
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 });
});

function sessionJob(): SessionJob {
  const job = launcher.createSessionJob();
  jobs.push(job);
  return job;
}

// A zombie still answers signal 0, so on Linux its state decides.
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  if (process.platform !== 'linux') return true;
  try {
    return !/^\d+ \(.*\) Z/.test(fs.readFileSync(`/proc/${pid}/stat`, 'utf8'));
  } catch {
    return false;
  }
}

/** A backgrounded node process that keeps the shell's stdout open and records its own OS pid in `file`. */
function background(file: string): string {
  const script = `require("fs").writeFileSync(${JSON.stringify(file.replace(/\\/g, '/'))}, String(process.pid)); setInterval(() => {}, 1000)`;
  return `"${NODE}" -e '${script}' &`;
}

async function pidIn(file: string): Promise<number> {
  await vi.waitFor(() => expect(fs.readFileSync(file, 'utf8')).toMatch(/^\d+$/), { timeout: SPAWN_TEST_TIMEOUT_MS });
  return Number(fs.readFileSync(file, 'utf8'));
}

async function run(job: SessionJob, command: string, signal?: AbortSignal): Promise<{ exitCode: number | null; output: string }> {
  let output = '';
  const { exitCode } = await createTrackedBashOperations(pi, () => ({}), job).exec(command, CWD, {
    onData: (chunk) => {
      output += chunk.toString();
    },
    env: process.env,
    ...(signal ? { signal } : {}),
  });
  return { exitCode, output };
}

describe('a shell call started on the launcher', { timeout: SPAWN_TEST_TIMEOUT_MS * 3 }, () => {
  it('leaves a backgrounded job running past its call, and the job dies when the panel session job closes', async () => {
    const job = sessionJob();
    const pidFile = path.join(root, 'background-pid');

    const result = await run(job, `${background(pidFile)} echo started`);
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain('started');
    const pid = await pidIn(pidFile);
    // The call returns once its shell closed, when the worker has released the call job, which carries no kill-on-close.
    expect(alive(pid)).toBe(true);

    job.dispose();

    await vi.waitFor(() => expect(alive(pid)).toBe(false), { timeout: SPAWN_TEST_TIMEOUT_MS });
  });

  it('kills the whole tree on Stop, a backgrounded job included', async () => {
    const job = sessionJob();
    const pidFile = path.join(root, 'stopped-pid');
    const controller = new AbortController();

    const pending = run(job, `${background(pidFile)} sleep 600`, controller.signal);
    const pid = await pidIn(pidFile);
    controller.abort();

    await expect(pending).rejects.toThrow('aborted');
    await vi.waitFor(() => expect(alive(pid)).toBe(false), { timeout: SPAWN_TEST_TIMEOUT_MS });
  });

  it.runIf(process.platform === 'linux')('starts a shell holding no fd the launcher opened while its session sentinel runs', async () => {
    const job = sessionJob();
    // The first call starts the sentinel, so the second runs while the sentinel's pipe is open.
    await run(job, 'true');

    // `; true` stops bash from exec'ing ls in its own place, which would list ls's directory fd instead.
    const result = await run(job, 'ls /proc/$$/fd; true');

    const shellFds = result.output.trim().split(/\s+/).map(Number).sort((a, b) => a - b);
    expect(shellFds).toEqual([0, 1, 2, ...inheritedFds]);
  });
});
