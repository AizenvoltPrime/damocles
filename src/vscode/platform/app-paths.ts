import * as path from 'path';
import type { AppPaths, WorkerName } from '../../platform/app-paths';

const WORKER_BUNDLES: Readonly<Record<WorkerName, string>> = {
  compass: 'compass-worker.js',
  usageStats: 'usage-stats-worker.js',
  sentinel: 'sentinel.js',
};

// Worker bundle names must match the esbuild.config.mjs outfiles under dist/.
export function createVsCodeAppPaths(extensionPath: string): AppPaths {
  return {
    resourceRoot: extensionPath,
    unpackedRoot: extensionPath,
    workerEntry: (name) => path.join(extensionPath, 'dist', WORKER_BUNDLES[name]),
  };
}
