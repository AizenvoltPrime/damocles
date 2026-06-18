import { defineConfig } from 'vitest/config';
import * as os from 'os';
import * as path from 'path';

const cpuCount = os.cpus().length;
const testWorkers = Math.max(1, Math.min(6, Math.floor(cpuCount / 2)));

export default defineConfig({
  test: {
    globals: true,
    root: '.',
    include: ['src/**/*.test.ts', 'src/**/*.spec.ts'],
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
