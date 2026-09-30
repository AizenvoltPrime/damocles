import * as fs from 'node:fs';
import * as path from 'node:path';
import { _electron as electron, type ElectronApplication, type TestInfo } from '@playwright/test';
import { hermeticEnv, REPO_ROOT, type HermeticHome } from './hermetic';
import { launchPackaged, packagedAppPath } from './packaged-app';

export const MAIN_SCRIPT = path.join(REPO_ROOT, 'dist', 'desktop', 'main.js');

export interface DesktopApp {
  readonly app: ElectronApplication;
  /** Main-process stdout and stderr so far. */
  output(): string;
  startTracing(): Promise<void>;
  /** Stops tracing if it is running, saving the trace when `path` is given. */
  stopTracing(path?: string): Promise<void>;
  close(): Promise<void>;
}

export interface LaunchOptions {
  env?: Record<string, string>;
  args?: string[];
}

/** Launches the desktop app on the hermetic home (the packaged executable when PACKAGED_APP_ENV names one), with its output captured for artifacts. */
export async function launchDesktop(h: HermeticHome, options: LaunchOptions = {}): Promise<DesktopApp> {
  const args = ['--user-data-dir', h.userData, ...(options.args ?? [])];
  const env = hermeticEnv(h, options.env);
  const packaged = packagedAppPath();
  const app = packaged !== undefined
    ? await launchPackaged(packaged, args, env, h.root)
    // chromiumSandbox: without it Playwright prepends --no-sandbox on Linux.
    : await electron.launch({ args: [MAIN_SCRIPT, ...args], env, cwd: h.root, chromiumSandbox: true });
  let output = '';
  let tracing = false;
  const proc = app.process();
  proc.stdout?.on('data', (d: Buffer) => (output += d.toString()));
  proc.stderr?.on('data', (d: Buffer) => (output += d.toString()));
  return {
    app,
    output: () => output,
    startTracing: async () => {
      await app.context().tracing.start({ screenshots: true, snapshots: true });
      tracing = true;
    },
    stopTracing: async (tracePath) => {
      if (!tracing || proc.exitCode !== null) return;
      tracing = false;
      await app.context().tracing.stop(tracePath ? { path: tracePath } : {});
    },
    close: async () => {
      if (proc.exitCode !== null || proc.signalCode !== null) return;
      await app.close();
    },
  };
}

/**
 * The main process log, which holds every line from the first one on; captured stdout starts only once Playwright attaches.
 * The sink flushes on the next turn of the event loop, so poll it.
 */
export function mainLog(h: HermeticHome): string {
  const file = path.join(h.userData, 'logs', 'Damocles.log');
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
}

/** Attaches the main-process output and every log file under userData, so a failure is debuggable offline. */
export async function attachDiagnostics(testInfo: TestInfo, name: string, desktop: DesktopApp, h: HermeticHome): Promise<void> {
  await testInfo.attach(`${name}-main-output.txt`, { body: desktop.output(), contentType: 'text/plain' });
  const logs = path.join(h.userData, 'logs');
  if (!fs.existsSync(logs)) return;
  for (const file of fs.readdirSync(logs)) {
    await testInfo.attach(`${name}-${file}`, { path: path.join(logs, file), contentType: 'text/plain' });
  }
}
