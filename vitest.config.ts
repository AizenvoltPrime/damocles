import { defineConfig } from 'vitest/config';
import vue from '@vitejs/plugin-vue';
import * as os from 'os';
import * as path from 'path';

const cpuCount = os.cpus().length;
const testWorkers = Math.max(1, Math.min(6, Math.floor(cpuCount / 2)));

const tests = (dirs: string[]): string[] => dirs.map((dir) => `${dir}/**/*.{test,spec}.ts`);

const sharedTest = {
  globals: true,
  root: '.',
  globalSetup: ['src/__mocks__/test-home.global-setup.ts'],
  // hermetic-home redirects the home through process.env, which a worker thread cannot do.
  pool: 'forks' as const,
};

// hermetic-home must run first, before any setup that could import paths.ts.
const hermeticHome = 'src/__mocks__/hermetic-home.setup.ts';
const fakePlatform = 'src/__mocks__/fake-platform.setup.ts';

const sharedAlias = { '@shared': path.resolve(__dirname, 'src/shared') };
const webviewAlias = { '@': path.resolve(__dirname, 'src/webview') };

export default defineConfig({
  test: {
    maxWorkers: testWorkers,
    minWorkers: 1,
    projects: [
      {
        // No `vscode` alias: a core file that imports vscode fails to resolve, since no runtime package exists.
        // `@` is there because parity tests join a core producer to the webview handler that consumes its messages.
        resolve: { alias: { ...sharedAlias, ...webviewAlias } },
        test: {
          ...sharedTest,
          name: 'core',
          // scripts/ tests need no host; release-targets.test.ts reports drift between scripts/release-targets.mjs and the release workflow matrix.
          include: [...tests(['src/core', 'src/platform', 'src/shared']), 'scripts/**/*.test.ts'],
          setupFiles: [hermeticHome, fakePlatform],
          benchmark: { include: ['src/core/**/*.bench.ts'] },
        },
      },
      {
        resolve: {
          alias: {
            ...sharedAlias,
            'vscode': path.resolve(__dirname, 'src/__mocks__/vscode.ts'),
          },
        },
        test: {
          ...sharedTest,
          name: 'vscode',
          include: tests(['src/vscode']),
          setupFiles: [hermeticHome, fakePlatform],
        },
      },
      {
        resolve: { alias: sharedAlias },
        test: {
          ...sharedTest,
          name: 'desktop',
          // Each suite mocks electron with vi.mock; the package export outside Electron is only the binary path.
          include: ['src/desktop/**/__tests__/**/*.test.ts'],
          // The shell is a Vue app; its tests run in the webview project.
          exclude: ['src/desktop/shell/**'],
          environment: 'node',
          setupFiles: [hermeticHome, fakePlatform],
        },
      },
      {
        plugins: [vue()],
        resolve: { alias: { ...sharedAlias, ...webviewAlias } },
        test: {
          ...sharedTest,
          name: 'webview',
          include: tests(['src/webview', 'src/desktop/shell']),
          setupFiles: [hermeticHome, fakePlatform, 'src/webview/__tests__/vitest.setup.ts'],
          benchmark: { include: ['src/webview/**/*.bench.ts'] },
        },
      },
    ],
  },
});
