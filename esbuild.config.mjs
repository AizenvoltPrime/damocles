import * as esbuild from 'esbuild';

const isWatch = process.argv.includes('--watch');

/** @type {esbuild.BuildOptions} */
const extensionOptions = {
  entryPoints: ['src/extension/extension.ts'],
  bundle: true,
  outfile: 'dist/extension.js',
  external: [
    'vscode',
    '@anthropic-ai/claude-agent-sdk',
    'sql.js-fts5',
    'zod',
    'web-tree-sitter',
    '@vscode/ripgrep',
  ],
  format: 'cjs',
  platform: 'node',
  target: 'node20',
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
    'sql.js-fts5',
    'web-tree-sitter',
  ],
  alias: {
    'vscode': './src/extension/compass/worker-vscode-shim.js',
  },
  format: 'cjs',
  platform: 'node',
  target: 'node20',
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
