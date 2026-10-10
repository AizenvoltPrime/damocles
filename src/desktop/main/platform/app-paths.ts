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

// dist/quick-open-worker.js, which a worker thread loads as a real file.
export function quickOpenWorkerPath(paths: AppPaths): string {
  return path.join(paths.unpackedRoot, 'dist', 'quick-open-worker.js');
}

// dist/watch-worker.js, which a worker thread loads as a real file.
export function watchWorkerPath(paths: AppPaths): string {
  return path.join(paths.unpackedRoot, 'dist', 'watch-worker.js');
}

export interface PtyHostPaths {
  // dist/pty-host.js, which a utility process loads as a real file.
  readonly script: string;
  // The node-pty package the host requires. Under app.asar when packaged: node-pty rewrites its spawn-helper path from app.asar to
  // app.asar.unpacked, so a copy loaded from app.asar.unpacked would point at app.asar.unpacked.unpacked.
  readonly nodePty: string;
  // resources/shell-integration, which shells read as real files: inside the install, never a folder a project can write
  readonly shellIntegration: string;
}

export function ptyHostPaths(paths: AppPaths): PtyHostPaths {
  return {
    script: path.join(paths.unpackedRoot, 'dist', 'pty-host.js'),
    nodePty: path.join(paths.resourceRoot, 'node_modules', 'node-pty'),
    shellIntegration: path.join(paths.unpackedRoot, 'resources', 'shell-integration'),
  };
}
