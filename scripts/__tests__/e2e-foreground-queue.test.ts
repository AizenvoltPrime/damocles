import { spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

// Playwright workers are processes, so each worker here is a child process running e2e/desktop/support/foreground.ts. Each
// test gives its workers a temp folder of its own: the real one holds the lock of any desktop e2e run on this machine.
const FOREGROUND = pathToFileURL(path.join(__dirname, '..', '..', 'e2e', 'desktop', 'support', 'foreground.ts')).href;

// JOB=hold holds the foreground HOLDS times back to back, each until the test sends 'release'. JOB=open records an app as a
// launch does; openingApp takes its place in the queue before its first await, so 'asked' means it is waiting.
const WORKER = `
import { registerHooks } from 'node:module';
// The e2e support files import each other without an extension, as Playwright's loader resolves them.
registerHooks({
  resolve: (specifier, context, nextResolve) => {
    try {
      return nextResolve(specifier, context);
    } catch (err) {
      if (err.code !== 'ERR_MODULE_NOT_FOUND' || !specifier.startsWith('.')) throw err;
      return nextResolve(specifier + '.ts', context);
    }
  },
});
const { openingApp, withForeground } = await import(${JSON.stringify(FOREGROUND)});
const message = (wanted) => new Promise((resolve) => {
  const listener = (got) => {
    if (got !== wanted) return;
    process.off('message', listener);
    resolve();
  };
  process.on('message', listener);
});
if (process.env.JOB === 'hold') {
  for (let i = 0; i < Number(process.env.HOLDS); i++) {
    await withForeground(async () => {
      const released = message('release');
      process.send('held');
      await released;
    });
  }
} else {
  const opening = openingApp();
  process.send('asked');
  const closeApp = await opening;
  const closed = message('close');
  process.send('opened');
  await closed;
  closeApp();
}
process.disconnect();
`;

interface Worker {
  readonly child: ChildProcess;
  readonly exited: Promise<number | null>;
  send(message: string): void;
  /** Resolves on the worker's next `event`. */
  next(event: string): Promise<void>;
}

describe('e2e foreground queue', () => {
  const children: Worker[] = [];
  const dirs: string[] = [];
  afterEach(async () => {
    for (const worker of children.splice(0)) {
      worker.child.kill('SIGKILL');
      await worker.exited;
    }
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10 });
  });

  function startWorker(name: string, dir: string, log: string[], env: Record<string, string>): Worker {
    const child = spawn(process.execPath, ['--disable-warning=MODULE_TYPELESS_PACKAGE_JSON', '--input-type=module', '-e', WORKER], {
      env: { ...process.env, TEMP: dir, TMP: dir, TMPDIR: dir, ...env },
      stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
    });
    const exited = new Promise<number | null>((resolve) => child.once('exit', resolve));
    child.on('message', (event) => log.push(`${name} ${String(event)}`));
    const worker: Worker = {
      child,
      exited,
      send: (message) => child.send(message),
      next: (event) => new Promise((resolve) => {
        const listener = (got: unknown): void => {
          if (got !== event) return;
          child.off('message', listener);
          resolve();
        };
        child.on('message', listener);
      }),
    };
    children.push(worker);
    return worker;
  }

  function tempDir(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fg-queue-'));
    dirs.push(dir);
    return dir;
  }

  it('serves a launch that waits on the foreground before the worker that just released it holds it again', async () => {
    const dir = tempDir();
    const log: string[] = [];
    const hog = startWorker('hog', dir, log, { JOB: 'hold', HOLDS: '2' });
    await hog.next('held');
    const launch = startWorker('launch', dir, log, { JOB: 'open' });
    await launch.next('asked');
    void launch.next('opened').then(() => launch.send('close'));
    void hog.next('held').then(() => hog.send('release'));
    // The hog asks again the instant it releases, as a worker running two foreground tests back to back does.
    hog.send('release');
    expect(await Promise.all([hog.exited, launch.exited])).toEqual([0, 0]);
    expect(log.filter((event) => !event.endsWith(' asked'))).toEqual(['hog held', 'launch opened', 'hog held']);
  }, 30_000);

  it('skips the place of a worker that died while it waited', async () => {
    const dir = tempDir();
    const log: string[] = [];
    const hog = startWorker('hog', dir, log, { JOB: 'hold', HOLDS: '1' });
    await hog.next('held');
    const dead = startWorker('dead', dir, log, { JOB: 'open' });
    await dead.next('asked');
    dead.child.kill('SIGKILL');
    await dead.exited;
    const launch = startWorker('launch', dir, log, { JOB: 'open' });
    await launch.next('asked');
    void launch.next('opened').then(() => launch.send('close'));
    hog.send('release');
    expect(await Promise.all([hog.exited, launch.exited])).toEqual([0, 0]);
    expect(log.filter((event) => !event.endsWith(' asked'))).toEqual(['hog held', 'launch opened']);
  }, 30_000);
});
