import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { chromium, type Browser, type BrowserContext, type ElectronApplication, type Page } from '@playwright/test';

/** Absolute path of a packaged Damocles executable; set, the suite drives that app instead of dist/desktop/main.js. Read only by the harness. */
export const PACKAGED_APP_ENV = 'DAMOCLES_E2E_PACKAGED_APP';

const DEVTOOLS_BANNER = /DevTools listening on (ws:\/\/\S+)/;
const CONNECT_TIMEOUT_MS = 60_000;
// The credential-store switches Playwright's Electron loader gives every dev launch. Without them the packaged app reads
// the runner's macOS Keychain, whose modal prompt blocks the main thread.
const CREDENTIAL_STORE_ARGS = ['--use-mock-keychain', '--password-store=basic'];
const QUIT_TIMEOUT_MS = 30_000;

// The packaged binary's enableNodeCliInspectArguments fuse is off, so Playwright's Electron driver (which attaches over --inspect) cannot reach its main process.
const NO_MAIN_PROCESS =
  'needs the Electron main process, which a packaged app does not expose (its enableNodeCliInspectArguments fuse is off); keep this spec out of PACKAGED_SPECS in e2e/desktop/support/packaged-app.ts';

// Specs that need no Electron main-process access, the only kind a packaged app (inspect fuse off) can run. The dev
// project runs them without main-process access too (withoutMainProcess), so a main call fails there first.
// network.spec.ts stays out: the disabled nodeOptions fuse makes Electron drop NODE_EXTRA_CA_CERTS, which both its tests set.
export const PACKAGED_SPECS: readonly string[] = ['packaged-assets.spec.ts', 'chat-stream.spec.ts', 'auth-refresh.spec.ts', 'quit.spec.ts'];

const MAIN_PROCESS_CALLS = new Set<PropertyKey>(['evaluate', 'evaluateHandle', 'browserWindow']);

/** `app` with the main-process calls a packaged app cannot serve throwing as they do there. */
export function withoutMainProcess(app: ElectronApplication): ElectronApplication {
  return new Proxy(app, {
    get(target, property) {
      if (MAIN_PROCESS_CALLS.has(property)) {
        return () => {
          throw new Error(`${String(property)}() ${NO_MAIN_PROCESS}`);
        };
      }
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

const SAMPLE_LINES = 300;

/** The main thread's call graph from macOS `sample`, which reads a child process without any permission prompt. */
function mainThreadSample(pid: number): string {
  const file = path.join(os.tmpdir(), `damocles-quit-${pid}.sample.txt`);
  try {
    execFileSync('sample', [String(pid), '2', '-file', file], { stdio: 'ignore', timeout: 90_000 });
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    const start = lines.findIndex((line) => line.includes('com.apple.main-thread'));
    if (start < 0) return `\nsample found no main thread in:\n${lines.slice(0, SAMPLE_LINES).join('\n')}`;
    const end = lines.findIndex((line, i) => i > start && /^ {4}\d+ Thread_/.test(line));
    return `\nmain thread while it failed to quit:\n${lines.slice(start, end < 0 ? undefined : end).slice(0, SAMPLE_LINES).join('\n')}`;
  } catch (err) {
    return `\nsample failed: ${err instanceof Error ? err.message : String(err)}`;
  } finally {
    fs.rmSync(file, { force: true });
  }
}

export function packagedAppPath(): string | undefined {
  const value = process.env[PACKAGED_APP_ENV];
  return value === undefined || value === '' ? undefined : value;
}

/**
 * The ElectronApplication calls that renderer-only access can serve, over Chromium's DevTools protocol.
 * Main-process calls (evaluate, evaluateHandle, browserWindow) throw.
 */
class PackagedApplication {
  private readonly proc: ChildProcess;
  private readonly browser: Browser;
  private readonly ctx: BrowserContext;

  constructor(proc: ChildProcess, browser: Browser, ctx: BrowserContext) {
    this.proc = proc;
    this.browser = browser;
    this.ctx = ctx;
  }

  process(): ChildProcess {
    return this.proc;
  }

  context(): BrowserContext {
    return this.ctx;
  }

  windows(): Page[] {
    return this.ctx.pages();
  }

  async firstWindow(): Promise<Page> {
    return this.ctx.pages()[0] ?? this.ctx.waitForEvent('page');
  }

  waitForEvent(event: string, optionsOrPredicate?: { predicate?: (page: Page) => boolean | Promise<boolean>; timeout?: number } | ((page: Page) => boolean | Promise<boolean>)): Promise<Page> {
    if (event !== 'window') throw new Error(`waitForEvent('${event}') ${NO_MAIN_PROCESS}`);
    return this.ctx.waitForEvent('page', optionsOrPredicate);
  }

  evaluate(): never {
    throw new Error(`evaluate() ${NO_MAIN_PROCESS}`);
  }

  evaluateHandle(): never {
    throw new Error(`evaluateHandle() ${NO_MAIN_PROCESS}`);
  }

  browserWindow(): never {
    throw new Error(`browserWindow() ${NO_MAIN_PROCESS}`);
  }

  // Browser.close runs Electron's app.quit(), so before-quit and the core dispose chain run as on a user's quit.
  async close(): Promise<void> {
    if (this.proc.exitCode !== null || this.proc.signalCode !== null) return;
    const exited = new Promise<void>((resolve) => this.proc.once('exit', () => resolve()));
    const session = await this.browser.newBrowserCDPSession();
    // The connection drops as the app exits, so the command's own reply may never arrive.
    session.send('Browser.close').catch(() => undefined);
    let timer: NodeJS.Timeout | undefined;
    const timedOut = new Promise<'timeout'>((resolve) => (timer = setTimeout(() => resolve('timeout'), QUIT_TIMEOUT_MS)));
    const outcome = await Promise.race([exited.then(() => 'exited' as const), timedOut]);
    clearTimeout(timer);
    if (outcome === 'timeout') {
      const stack = process.platform === 'darwin' && this.proc.pid !== undefined ? mainThreadSample(this.proc.pid) : '';
      this.proc.kill('SIGKILL');
      throw new Error(`the packaged app did not quit within ${QUIT_TIMEOUT_MS} ms of Browser.close; killed it${stack}`);
    }
  }
}

/** Spawns the packaged app with a DevTools port on loopback and connects to its renderers. The argv never carries --no-sandbox. */
export async function launchPackaged(executable: string, args: string[], env: Record<string, string>, cwd: string): Promise<ElectronApplication> {
  const proc = spawn(executable, [...args, ...CREDENTIAL_STORE_ARGS, '--remote-debugging-port=0'], { env, cwd, stdio: ['ignore', 'pipe', 'pipe'] });
  let banner = '';
  const endpoint = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => {
      proc.kill('SIGKILL');
      reject(new Error(`no DevTools banner from ${executable} within ${CONNECT_TIMEOUT_MS} ms; output so far:\n${banner}`));
    }, CONNECT_TIMEOUT_MS);
    const onData = (data: Buffer): void => {
      banner += data.toString();
      const match = DEVTOOLS_BANNER.exec(banner);
      if (!match) return;
      clearTimeout(timer);
      proc.stderr?.off('data', onData);
      proc.stdout?.off('data', onData);
      resolve(match[1]!);
    };
    proc.stderr?.on('data', onData);
    proc.stdout?.on('data', onData);
    proc.once('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    proc.once('exit', (code, signal) => {
      clearTimeout(timer);
      reject(new Error(`${executable} exited (${code ?? signal}) before its DevTools banner; output:\n${banner}`));
    });
  });
  try {
    const browser = await chromium.connectOverCDP(endpoint);
    const context = browser.contexts()[0];
    if (!context) throw new Error('the packaged app exposed no browser context over CDP');
    // One adapter for the ElectronApplication calls the packaged specs make; the rest throw with the reason.
    return new PackagedApplication(proc, browser, context) as unknown as ElectronApplication;
  } catch (err) {
    // The caller never receives an app it could close, so the process ends here.
    proc.kill('SIGKILL');
    throw err;
  }
}
