import * as esbuild from 'esbuild';
import { existsSync } from 'node:fs';
import { EXTENSION_EXTERNALS } from './scripts/extension-externals.mjs';
import { DESKTOP_EXTERNALS } from './scripts/desktop-externals.mjs';

const isWatch = process.argv.includes('--watch');
// --desktop builds the Electron main and preload plus the workers they spawn, and never the extension bundle.
const isDesktop = process.argv.includes('--desktop');

/**
 * Fail the build when an entry point produced no file. A missing dist/sentinel.js still packages
 * cleanly and only shows up as POSIX shell cleanup silently not happening.
 *
 * @type {esbuild.Plugin}
 */
const assertOutfileWritten = {
  name: 'assert-outfile-written',
  setup(build) {
    build.onEnd((result) => {
      const outfile = build.initialOptions.outfile;
      if (result.errors.length > 0 || outfile === undefined || existsSync(outfile)) return null;
      return { errors: [{ text: `${outfile} was not written by the build` }] };
    });
  },
};

/** @type {esbuild.BuildOptions} */
const extensionOptions = {
  entryPoints: ['src/vscode/extension.ts'],
  bundle: true,
  outfile: 'dist/extension.js',
  // The externals (and thus the VSIX node_modules allowlist) live in scripts/extension-externals.mjs so
  // the bundle and the package can't drift. Adding a new external there auto-includes it (+ its
  // production-dependency closure) in the VSIX via scripts/sync-vscodeignore.mjs (the `vscode:prepublish` step).
  external: EXTENSION_EXTERNALS,
  format: 'cjs',
  platform: 'node',
  target: 'node24',
  sourcemap: isWatch,
  minify: !isWatch,
  logLevel: 'info',
  plugins: [assertOutfileWritten],
};

/** @type {esbuild.BuildOptions} */
const workerOptions = {
  entryPoints: ['src/core/compass/compass-worker.ts'],
  bundle: true,
  outfile: 'dist/compass-worker.js',
  external: [
    // Node builtin — must not be bundled into the worker.
    'node:sqlite',
    'web-tree-sitter',
  ],
  format: 'cjs',
  platform: 'node',
  target: 'node24',
  sourcemap: isWatch,
  minify: !isWatch,
  logLevel: 'info',
  plugins: [assertOutfileWritten],
};

/** @type {esbuild.BuildOptions} */
const usageStatsWorkerOptions = {
  entryPoints: ['src/core/usage-stats/usage-stats-worker.ts'],
  bundle: true,
  outfile: 'dist/usage-stats-worker.js',
  // Node builtin, must not be bundled.
  external: ['node:sqlite'],
  format: 'cjs',
  platform: 'node',
  target: 'node24',
  sourcemap: isWatch,
  minify: !isWatch,
  logLevel: 'info',
  plugins: [assertOutfileWritten],
};

/** @type {esbuild.BuildOptions} */
const sentinelOptions = {
  entryPoints: ['src/core/pi-session/tools/shell-sentinel.ts'],
  bundle: true,
  outfile: 'dist/sentinel.js',
  // No externals on purpose: this process has to keep working with the extension host gone, so it may
  // depend on nothing but the Node standard library.
  format: 'cjs',
  platform: 'node',
  target: 'node24',
  sourcemap: isWatch,
  minify: !isWatch,
  logLevel: 'info',
  plugins: [assertOutfileWritten],
};

/** @type {esbuild.BuildOptions} */
const desktopMainOptions = {
  entryPoints: ['src/desktop/main/index.ts'],
  bundle: true,
  outfile: 'dist/desktop/main.js',
  external: DESKTOP_EXTERNALS,
  format: 'cjs',
  platform: 'node',
  target: 'node24',
  sourcemap: true,
  minify: false,
  logLevel: 'info',
  plugins: [assertOutfileWritten],
};

/** @type {esbuild.BuildOptions} */
const desktopPreloadOptions = {
  entryPoints: ['src/desktop/preload/panel.ts'],
  bundle: true,
  outfile: 'dist/desktop/preload-panel.js',
  // A sandboxed preload can require only electron and a few Node polyfills, so everything else is bundled.
  external: ['electron'],
  format: 'cjs',
  platform: 'node',
  target: 'node24',
  sourcemap: false,
  minify: false,
  logLevel: 'info',
  plugins: [assertOutfileWritten],
};

/** @type {esbuild.BuildOptions} */
const desktopShellPreloadOptions = {
  ...desktopPreloadOptions,
  entryPoints: ['src/desktop/preload/shell.ts'],
  outfile: 'dist/desktop/preload-shell.js',
};

/** @type {esbuild.BuildOptions} */
const desktopPanePreloadOptions = {
  ...desktopPreloadOptions,
  entryPoints: ['src/desktop/preload/pane.ts'],
  outfile: 'dist/desktop/preload-pane.js',
};

async function buildDesktop() {
  await Promise.all([
    esbuild.build(desktopMainOptions),
    esbuild.build(desktopPreloadOptions),
    esbuild.build(desktopShellPreloadOptions),
    esbuild.build(desktopPanePreloadOptions),
    esbuild.build(workerOptions),
    esbuild.build(usageStatsWorkerOptions),
    esbuild.build(sentinelOptions),
  ]);
  console.log('Desktop main + preload + workers + sentinel build complete');
}

async function build() {
  if (isDesktop) {
    await buildDesktop();
    return;
  }
  if (isWatch) {
    const [extCtx, workerCtx, usageStatsWorkerCtx, sentinelCtx] = await Promise.all([
      esbuild.context(extensionOptions),
      esbuild.context(workerOptions),
      esbuild.context(usageStatsWorkerOptions),
      esbuild.context(sentinelOptions),
    ]);
    await Promise.all([extCtx.watch(), workerCtx.watch(), usageStatsWorkerCtx.watch(), sentinelCtx.watch()]);
    console.log('Watching for changes...');
  } else {
    await Promise.all([
      esbuild.build(extensionOptions),
      esbuild.build(workerOptions),
      esbuild.build(usageStatsWorkerOptions),
      esbuild.build(sentinelOptions),
    ]);
    console.log('Extension + workers + sentinel build complete');
  }
}

build().catch((err) => {
  console.error(err);
  process.exit(1);
});
