import * as path from 'node:path';
import { defineConfig } from '@playwright/test';
import { packagedAppPath } from './e2e/desktop/support/packaged-app';
import { devElectronDist } from './scripts/dev-electron-binary.mjs';

// Playwright launches require('electron'); on Windows that is the branded copy the desktop build step writes.
if (process.platform === 'win32' && packagedAppPath() === undefined) {
  process.env.ELECTRON_OVERRIDE_DIST_PATH = devElectronDist(path.dirname(require.resolve('electron/package.json')));
}

const PROJECT = packagedAppPath() === undefined ? 'dev' : 'packaged';
// The target suites scripts/test-remote.mjs was asked for by --grep; every other target suite stays out of the run.
const TARGET_TAGS = ['@windows-target', '@darwin-target'];
const named = (process.env['DAMOCLES_E2E_REMOTE_TARGETS'] ?? '').split(',').filter((tag) => tag !== '');
const excluded = [...TARGET_TAGS.filter((tag) => !named.includes(tag)), '@packaged'];

// Remote end-to-end suite: the desktop app against SSH targets (Docker sshd fixtures, or the runner's own sshd for the target
// suites). Run it through `npm run test:remote`, which builds the app, the server packages and the fixture images first.
export default defineConfig({
  testDir: './e2e/remote',
  globalSetup: './e2e/desktop/global-setup.ts',
  outputDir: `./dist/e2e-results/remote-${PROJECT}`,
  // As in playwright.desktop.config.ts: Linux and macOS give keyboard focus to one app's window. The target suites share the
  // runner account's one daemon, so they run one test at a time.
  workers: process.platform === 'win32' && named.length === 0 ? 2 : 1,
  fullyParallel: true,
  timeout: 300_000,
  expect: { timeout: 20_000 },
  retries: process.env.CI ? 1 : 0,
  failOnFlakyTests: !!process.env.CI,
  // Below every test:remote step's timeout-minutes (docs/release.md "Time limits"), so a hung run still writes its report.
  globalTimeout: process.env.CI ? 45 * 60_000 : 0,
  forbidOnly: !!process.env.CI,
  reporter: [['list'], ['html', { open: 'never', outputFolder: `./dist/e2e-report/remote-${PROJECT}` }]],
  projects: PROJECT === 'dev'
    ? [
        { name: 'dev', testMatch: '**/*.spec.ts', grepInvert: new RegExp(excluded.join('|')) },
        // Review captures, not tests, as in playwright.desktop.config.ts: select them with --project=screenshots.
        { name: 'screenshots', testMatch: '**/*.screenshots.ts', outputDir: './dist/e2e-results/remote-screenshots' },
      ]
    : [{ name: 'packaged', testMatch: '**/*.spec.ts', grep: /@packaged/ }],
});
