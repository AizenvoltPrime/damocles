import * as esbuild from 'esbuild';
import { existsSync } from 'node:fs';
import { EXTENSION_EXTERNALS } from './scripts/extension-externals.mjs';

const isWatch = process.argv.includes('--watch');

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
  entryPoints: ['src/extension/extension.ts'],
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
  entryPoints: ['src/extension/compass/compass-worker.ts'],
  bundle: true,
  outfile: 'dist/compass-worker.js',
  external: [
    // Node builtin — must not be bundled into the worker.
    'node:sqlite',
    'web-tree-sitter',
  ],
  alias: {
    'vscode': './src/extension/compass/worker-vscode-shim.js',
  },
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
  entryPoints: ['src/extension/pi-session/tools/shell-sentinel.ts'],
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

async function build() {
  if (isWatch) {
    const [extCtx, workerCtx, sentinelCtx] = await Promise.all([
      esbuild.context(extensionOptions),
      esbuild.context(workerOptions),
      esbuild.context(sentinelOptions),
    ]);
    await Promise.all([extCtx.watch(), workerCtx.watch(), sentinelCtx.watch()]);
    console.log('Watching for changes...');
  } else {
    await Promise.all([
      esbuild.build(extensionOptions),
      esbuild.build(workerOptions),
      esbuild.build(sentinelOptions),
    ]);
    console.log('Extension + worker + sentinel build complete');
  }
}

build().catch((err) => {
  console.error(err);
  process.exit(1);
});
