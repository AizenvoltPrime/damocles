import * as path from 'node:path';
import type { AppPaths, WorkerName } from '../../../platform/app-paths';

const WORKER_BUNDLES: Readonly<Record<WorkerName, string>> = {
  compass: 'compass-worker.js',
  usageStats: 'usage-stats-worker.js',
  sentinel: 'sentinel.js',
};

export type DesktopLayout =
  // `electron dist/desktop/main.js` from a checkout: everything is a real file under the repo root.
  | { readonly packaged: false; readonly repoRoot: string }
  // An installed app: `asarPath` is `app.getAppPath()`, and every ASAR_UNPACK entry sits under its `.unpacked` sibling.
  | { readonly packaged: true; readonly asarPath: string };

// The main bundle runs from <repo>/dist/desktop/main.js in the unpackaged layout.
export function unpackagedResourceRoot(mainBundleDir: string): string {
  return path.resolve(mainBundleDir, '..', '..');
}

// Worker bundle names match the esbuild.config.mjs outfiles under dist/.
export function createDesktopAppPaths(layout: DesktopLayout): AppPaths {
  const resourceRoot = layout.packaged ? layout.asarPath : layout.repoRoot;
  const unpackedRoot = layout.packaged ? `${layout.asarPath}.unpacked` : layout.repoRoot;
  return {
    resourceRoot,
    unpackedRoot,
    workerEntry: (name) => path.join(unpackedRoot, 'dist', WORKER_BUNDLES[name]),
  };
}
