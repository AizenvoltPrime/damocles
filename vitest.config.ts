import { defineConfig } from 'vitest/config';
import vue from '@vitejs/plugin-vue';
import * as os from 'os';
import * as path from 'path';

const cpuCount = os.cpus().length;
const testWorkers = Math.max(1, Math.min(6, Math.floor(cpuCount / 2)));

export default defineConfig({
  plugins: [vue()],
  test: {
    globals: true,
    root: '.',
    // scripts/ is in scope so build tooling can be covered too — release-targets.test.ts is what
    // reports drift between scripts/release-targets.mjs and the release workflow matrix.
    include: ['src/**/*.test.ts', 'src/**/*.spec.ts', 'scripts/**/*.test.ts'],
    exclude: ['node_modules', 'dist'],
    setupFiles: ['src/webview/__tests__/vitest.setup.ts'],
    maxWorkers: testWorkers,
    minWorkers: 1,
  },
  bench: {
    globals: true,
    root: '.',
    include: ['src/**/*.bench.ts'],
    exclude: ['node_modules', 'dist'],
  },
  resolve: {
    alias: {
      '@shared': path.resolve(__dirname, 'src/shared'),
      '@': path.resolve(__dirname, 'src/webview'),
      'vscode': path.resolve(__dirname, 'src/__mocks__/vscode.ts'),
    },
  },
});
