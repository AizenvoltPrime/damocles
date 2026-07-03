import * as esbuild from 'esbuild';
import { EXTENSION_EXTERNALS } from './scripts/extension-externals.mjs';

const isWatch = process.argv.includes('--watch');

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
};

async function build() {
  if (isWatch) {
    const [extCtx, workerCtx] = await Promise.all([
      esbuild.context(extensionOptions),
      esbuild.context(workerOptions),
    ]);
    await Promise.all([extCtx.watch(), workerCtx.watch()]);
    console.log('Watching for changes...');
  } else {
    await Promise.all([
      esbuild.build(extensionOptions),
      esbuild.build(workerOptions),
    ]);
    console.log('Extension + worker build complete');
  }
}

build().catch((err) => {
  console.error(err);
  process.exit(1);
});
