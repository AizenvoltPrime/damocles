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
    // pi agent harness — pure ESM with import.meta(.resolve); must stay external and
    // ship as real node_modules, loaded only via dynamic import() from CJS (blocker B2).
    '@earendil-works/pi-coding-agent',
    '@earendil-works/pi-agent-core',
    '@earendil-works/pi-ai',
    '@earendil-works/pi-tui',
    'jiti',
    'typebox',
    // MCP SDK — pure ESM ("type": "module") with deep subpath imports; kept external and
    // loaded only via dynamic import() from CJS, mirroring the pi harness (US-014.0).
    '@modelcontextprotocol/sdk',
    '@modelcontextprotocol/sdk/*',
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
