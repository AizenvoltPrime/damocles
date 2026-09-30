import * as path from 'node:path';
import { defineConfig } from '@playwright/test';
import { packagedAppPath } from './e2e/desktop/support/packaged-app';
import { devElectronDist } from './scripts/dev-electron-binary.mjs';

// Playwright launches require('electron'); on Windows that is the branded copy test:desktop writes, as for dev:desktop.
if (process.platform === 'win32' && packagedAppPath() === undefined) {
  process.env.ELECTRON_OVERRIDE_DIST_PATH = devElectronDist(path.dirname(require.resolve('electron/package.json')));
}

// Specs that need no Electron main-process access, the only kind a packaged app (inspect fuse off) can run.
// network.spec.ts stays out: the disabled nodeOptions fuse makes Electron drop NODE_EXTRA_CA_CERTS, which both its tests set.
const PACKAGED_SPECS = ['packaged-assets.spec.ts', 'chat-stream.spec.ts', 'auth-refresh.spec.ts', 'quit.spec.ts'];
// A CI leg runs both projects in turn and uploads the parent folders, so neither run's results replace the other's.
const PROJECT = packagedAppPath() === undefined ? 'dev' : 'packaged';

// Desktop end-to-end suite (Electron driver); vitest never loads e2e/, and this config never loads src/.
// DAMOCLES_E2E_PACKAGED_APP selects the project: unset runs `dev` against dist/desktop/main.js, set runs `packaged` against that executable.
export default defineConfig({
  testDir: './e2e/desktop',
  globalSetup: './e2e/desktop/global-setup.ts',
  outputDir: `./dist/e2e-results/${PROJECT}`,
  // Each test launches its own Electron app and pi runtime; more workers than this starves the stub's streaming. Linux and
  // macOS give keyboard focus to one app's window and each test's app takes it on launch, so a parallel test there loses
  // native key presses.
  workers: process.platform === 'win32' ? 2 : 1,
  fullyParallel: true,
  timeout: 120_000,
  expect: { timeout: 20_000 },
  // A pass on retry is reported as flaky, which is the signal; it never turns a flaky test green silently.
  retries: process.env.CI ? 1 : 0,
  forbidOnly: !!process.env.CI,
  reporter: [['list'], ['html', { open: 'never', outputFolder: `./dist/e2e-report/${PROJECT}` }]],
  projects: PROJECT === 'dev'
    ? [{ name: 'dev', testMatch: '**/*.spec.ts' }]
    : [{ name: 'packaged', testMatch: PACKAGED_SPECS.map((spec) => `**/${spec}`) }],
});
