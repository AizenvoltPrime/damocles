import * as esbuild from 'esbuild';

const isWatch = process.argv.includes('--watch');

/** @type {esbuild.BuildOptions} */
const buildOptions = {
  entryPoints: ['src/extension/extension.ts'],
  bundle: true,
  outfile: 'dist/extension.js',
  external: ['vscode', '@anthropic-ai/claude-agent-sdk', 'sql.js-fts5', 'zod'],
  format: 'cjs',
  platform: 'node',
  target: 'node20',
  sourcemap: isWatch,
  minify: !isWatch,
  logLevel: 'info',
};

async function build() {
  if (isWatch) {
    const ctx = await esbuild.context(buildOptions);
    await ctx.watch();
    console.log('Watching for changes...');
  } else {
    await esbuild.build(buildOptions);
    console.log('Extension build complete');
  }
}

build().catch((err) => {
  console.error(err);
  process.exit(1);
});
