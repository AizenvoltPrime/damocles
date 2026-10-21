import * as esbuild from 'esbuild';
import { chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
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
const memoryIntegrityWorkerOptions = {
  ...usageStatsWorkerOptions,
  entryPoints: ['src/core/memory/integrity-worker.ts'],
  outfile: 'dist/memory-integrity-worker.js',
};

/** @type {esbuild.BuildOptions} */
const sessionMetaIndexWorkerOptions = {
  ...usageStatsWorkerOptions,
  entryPoints: ['src/core/pi-session/session-store/meta-index/worker.ts'],
  outfile: 'dist/session-meta-index-worker.js',
  // pi is ESM-only and loads by dynamic import from the path the host passes, so it is never bundled.
  external: ['node:sqlite', '@earendil-works/*'],
};

/** @type {esbuild.BuildOptions} */
const voiceExtractWorkerOptions = {
  ...usageStatsWorkerOptions,
  entryPoints: ['src/core/voice/runtime/extract-worker.ts'],
  outfile: 'dist/voice-extract-worker.js',
  external: [],
};

/** @type {esbuild.BuildOptions} */
const processLauncherWorkerOptions = {
  entryPoints: ['src/core/process-launcher/worker.ts'],
  bundle: true,
  outfile: 'dist/process-launcher-worker.js',
  // koffi resolves its native module relative to its own folder, so it is never bundled.
  external: ['koffi'],
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
const coreHostOptions = {
  ...desktopMainOptions,
  entryPoints: ['src/desktop/core-host/index.ts'],
  // Forked from inside app.asar (coreHostEntryPath), so its externals resolve from app.asar/node_modules as main's do.
  outfile: 'dist/core-host.js',
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
const desktopOverlayPreloadOptions = {
  ...desktopPreloadOptions,
  entryPoints: ['src/desktop/preload/overlay.ts'],
  outfile: 'dist/desktop/preload-overlay.js',
};

/** @type {esbuild.BuildOptions} */
const formatterHostOptions = {
  entryPoints: ['src/desktop/formatter-host/index.ts'],
  bundle: true,
  outfile: 'dist/formatter-host.js',
  // No externals: the host runs as an Electron utility process from app.asar.unpacked and loads only the project's Prettier,
  // which is never bundled.
  format: 'cjs',
  platform: 'node',
  target: 'node24',
  sourcemap: false,
  minify: false,
  logLevel: 'info',
  plugins: [assertOutfileWritten],
};

/** @type {esbuild.BuildOptions} */
const ptyHostOptions = {
  ...formatterHostOptions,
  entryPoints: ['src/desktop/pty-host/index.ts'],
  outfile: 'dist/pty-host.js',
  // node-pty finds its native prebuild relative to its own lib directory, so it is never bundled.
  external: ['node-pty'],
};

/** @type {esbuild.BuildOptions} */
const quickOpenWorkerOptions = {
  ...formatterHostOptions,
  entryPoints: ['src/desktop/quick-open-worker/index.ts'],
  outfile: 'dist/quick-open-worker.js',
};

/** @type {esbuild.BuildOptions} */
const watchWorkerOptions = {
  ...formatterHostOptions,
  entryPoints: ['src/desktop/watch-worker/index.ts'],
  outfile: 'dist/watch-worker.js',
};

/** @type {esbuild.BuildOptions} */
const askpassMainOptions = {
  ...formatterHostOptions,
  entryPoints: ['src/desktop/askpass/askpass-main.ts'],
  outfile: 'dist/askpass-main.js',
};

// git and ssh execute the askpass scripts, so the packaged mode comes from here, never from the checkout's file mode. The
// folder is the list: verify-desktop-package.mjs's ASKPASS_SCRIPTS is tested against it.
function copyAskpassScripts() {
  mkdirSync('dist/askpass', { recursive: true });
  for (const name of readdirSync('resources/askpass')) {
    copyFileSync(`resources/askpass/${name}`, `dist/askpass/${name}`);
    chmodSync(`dist/askpass/${name}`, 0o755);
  }
}

async function buildDesktop() {
  await Promise.all([
    esbuild.build(formatterHostOptions),
    esbuild.build(ptyHostOptions),
    esbuild.build(quickOpenWorkerOptions),
    esbuild.build(watchWorkerOptions),
    esbuild.build(askpassMainOptions),
    esbuild.build(desktopMainOptions),
    esbuild.build(coreHostOptions),
    esbuild.build(desktopPreloadOptions),
    esbuild.build(desktopShellPreloadOptions),
    esbuild.build(desktopOverlayPreloadOptions),
    esbuild.build(workerOptions),
    esbuild.build(usageStatsWorkerOptions),
    esbuild.build(memoryIntegrityWorkerOptions),
    esbuild.build(sessionMetaIndexWorkerOptions),
    esbuild.build(voiceExtractWorkerOptions),
    esbuild.build(processLauncherWorkerOptions),
    esbuild.build(sentinelOptions),
  ]);
  // Settings › About's What's new reads it next to main.js (src/desktop/main/release-notes.ts).
  copyFileSync('CHANGELOG.md', 'dist/desktop/CHANGELOG.md');
  copyAskpassScripts();
  console.log('Desktop main + core host + preload + formatter host + pty host + askpass helper + workers + sentinel build complete');
}

async function build() {
  if (isDesktop) {
    await buildDesktop();
    return;
  }
  if (isWatch) {
    const contexts = await Promise.all([
      esbuild.context(extensionOptions),
      esbuild.context(workerOptions),
      esbuild.context(usageStatsWorkerOptions),
      esbuild.context(memoryIntegrityWorkerOptions),
      esbuild.context(sessionMetaIndexWorkerOptions),
      esbuild.context(voiceExtractWorkerOptions),
      esbuild.context(processLauncherWorkerOptions),
      esbuild.context(sentinelOptions),
    ]);
    await Promise.all(contexts.map((ctx) => ctx.watch()));
    console.log('Watching for changes...');
  } else {
    await Promise.all([
      esbuild.build(extensionOptions),
      esbuild.build(workerOptions),
      esbuild.build(usageStatsWorkerOptions),
      esbuild.build(memoryIntegrityWorkerOptions),
      esbuild.build(sessionMetaIndexWorkerOptions),
      esbuild.build(voiceExtractWorkerOptions),
      esbuild.build(processLauncherWorkerOptions),
      esbuild.build(sentinelOptions),
    ]);
    console.log('Extension + workers + sentinel build complete');
  }
}

build().catch((err) => {
  console.error(err);
  process.exit(1);
});
