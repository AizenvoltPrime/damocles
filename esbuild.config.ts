import * as esbuild from 'esbuild';
import { chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { EXTENSION_EXTERNALS } from './scripts/extension-externals.ts';
import { EXTENSION_BUNDLE_FILES } from './scripts/extension-bundles.ts';
import { DESKTOP_EXTERNALS } from './scripts/desktop-externals.ts';
import { originalFs } from './scripts/esbuild-original-fs.ts';
import { isEntryPoint } from './scripts/entry-point.ts';

const isWatch = process.argv.includes('--watch');
// --desktop builds the Electron main and preload plus the workers they spawn, and never the extension bundle.
const isDesktop = process.argv.includes('--desktop');

/**
 * Fail the build when an entry point produced no file. A missing dist/sentinel.js still packages
 * cleanly and only shows up as POSIX shell cleanup silently not happening.
 */
const assertOutfileWritten: esbuild.Plugin = {
  name: 'assert-outfile-written',
  setup(build) {
    build.onEnd((result) => {
      const outfile = build.initialOptions.outfile;
      if (result.errors.length > 0 || outfile === undefined || existsSync(outfile)) return null;
      return { errors: [{ text: `${outfile} was not written by the build` }] };
    });
  },
};

// Every Node bundle; the sandboxed preloads have no fs.
const nodePlugins = [assertOutfileWritten, originalFs];

/** A bundle's options; every bundle names its one output file. */
export type BundleOptions = esbuild.BuildOptions & { outfile: string };

const extensionOptions: BundleOptions = {
  entryPoints: ['src/vscode/extension.ts'],
  bundle: true,
  // VS Code loads `main` as ESM when the manifest says "type": "module", unless it ends in .cjs.
  outfile: EXTENSION_BUNDLE_FILES.extension,
  // The externals (and thus the VSIX node_modules allowlist) live in scripts/extension-externals.ts so
  // the bundle and the package can't drift. Adding a new external there auto-includes it (+ its
  // production-dependency closure) in the VSIX via scripts/sync-vscodeignore.ts (the `vscode:prepublish` step).
  external: EXTENSION_EXTERNALS,
  format: 'cjs',
  platform: 'node',
  target: 'node24',
  sourcemap: isWatch,
  minify: !isWatch,
  logLevel: 'info',
  plugins: nodePlugins,
};

const workerOptions: BundleOptions = {
  entryPoints: ['src/core/compass/compass-worker.ts'],
  bundle: true,
  outfile: EXTENSION_BUNDLE_FILES.compassWorker,
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
  plugins: nodePlugins,
};

const usageStatsWorkerOptions: BundleOptions = {
  entryPoints: ['src/core/usage-stats/usage-stats-worker.ts'],
  bundle: true,
  outfile: EXTENSION_BUNDLE_FILES.usageStatsWorker,
  // Node builtin, must not be bundled.
  external: ['node:sqlite'],
  format: 'cjs',
  platform: 'node',
  target: 'node24',
  sourcemap: isWatch,
  minify: !isWatch,
  logLevel: 'info',
  plugins: nodePlugins,
};

const memoryIntegrityWorkerOptions: BundleOptions = {
  ...usageStatsWorkerOptions,
  entryPoints: ['src/core/memory/integrity-worker.ts'],
  outfile: EXTENSION_BUNDLE_FILES.memoryIntegrityWorker,
};

const sessionMetaIndexWorkerOptions: BundleOptions = {
  ...usageStatsWorkerOptions,
  entryPoints: ['src/core/pi-session/session-store/meta-index/worker.ts'],
  outfile: EXTENSION_BUNDLE_FILES.sessionMetaIndexWorker,
  // pi is ESM-only and loads by dynamic import from the path the host passes, so it is never bundled.
  external: ['node:sqlite', '@earendil-works/*'],
};

const voiceExtractWorkerOptions: BundleOptions = {
  ...usageStatsWorkerOptions,
  entryPoints: ['src/core/voice/runtime/extract-worker.ts'],
  outfile: EXTENSION_BUNDLE_FILES.voiceExtractWorker,
  external: [],
};

const processLauncherWorkerOptions: BundleOptions = {
  entryPoints: ['src/core/process-launcher/worker.ts'],
  bundle: true,
  outfile: EXTENSION_BUNDLE_FILES.processLauncherWorker,
  // koffi resolves its native module relative to its own folder, so it is never bundled.
  external: ['koffi'],
  format: 'cjs',
  platform: 'node',
  target: 'node24',
  sourcemap: isWatch,
  minify: !isWatch,
  logLevel: 'info',
  plugins: nodePlugins,
};

const sentinelOptions: BundleOptions = {
  entryPoints: ['src/core/pi-session/tools/shell-sentinel.ts'],
  bundle: true,
  outfile: EXTENSION_BUNDLE_FILES.sentinel,
  // No externals on purpose: this process has to keep working with the extension host gone, so it may
  // depend on nothing but the Node standard library.
  format: 'cjs',
  platform: 'node',
  target: 'node24',
  sourcemap: isWatch,
  minify: !isWatch,
  logLevel: 'info',
  plugins: nodePlugins,
};

/** The extension build's bundles, one per `EXTENSION_BUNDLE_FILES` entry, which the VSIX ships from dist/. */
export const EXTENSION_BUNDLES: BundleOptions[] = [
  extensionOptions,
  workerOptions,
  usageStatsWorkerOptions,
  memoryIntegrityWorkerOptions,
  sessionMetaIndexWorkerOptions,
  voiceExtractWorkerOptions,
  processLauncherWorkerOptions,
  sentinelOptions,
];

const desktopMainOptions: BundleOptions = {
  entryPoints: ['src/desktop/main/index.ts'],
  bundle: true,
  outfile: 'dist/desktop/main.js',
  external: DESKTOP_EXTERNALS,
  // the stage and removal scripts main sends to a target as text (src/desktop/main/remote/bootstrap/stage1.ts, remove-server.ts)
  loader: { '.sh': 'text', '.ps1': 'text' },
  format: 'cjs',
  platform: 'node',
  target: 'node24',
  sourcemap: true,
  minify: false,
  logLevel: 'info',
  plugins: nodePlugins,
};

const coreHostOptions: BundleOptions = {
  ...desktopMainOptions,
  entryPoints: ['src/desktop/core-host/index.ts'],
  // Forked from inside app.asar (coreHostEntryPath), so its externals resolve from app.asar/node_modules as main's do.
  outfile: 'dist/core-host.js',
};

const daemonOptions: BundleOptions = {
  ...desktopMainOptions,
  entryPoints: ['src/desktop/daemon/main.ts'],
  // The loopback daemon (dev and e2e only): plain Node or Electron as Node, from the checkout; electron-builder never lists it.
  outfile: 'dist/daemon.js',
};

const desktopPreloadOptions: BundleOptions = {
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

const desktopShellPreloadOptions: BundleOptions = {
  ...desktopPreloadOptions,
  entryPoints: ['src/desktop/preload/shell.ts'],
  outfile: 'dist/desktop/preload-shell.js',
};

const desktopOverlayPreloadOptions: BundleOptions = {
  ...desktopPreloadOptions,
  entryPoints: ['src/desktop/preload/overlay.ts'],
  outfile: 'dist/desktop/preload-overlay.js',
};

const formatterHostOptions: BundleOptions = {
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
  plugins: nodePlugins,
};

const ptyHostOptions: BundleOptions = {
  ...formatterHostOptions,
  entryPoints: ['src/desktop/pty-host/index.ts'],
  outfile: 'dist/pty-host.js',
  // node-pty finds its native prebuild relative to its own lib directory, so it is never bundled.
  external: ['node-pty'],
};

const quickOpenWorkerOptions: BundleOptions = {
  ...formatterHostOptions,
  entryPoints: ['src/desktop/quick-open-worker/index.ts'],
  outfile: 'dist/quick-open-worker.js',
};

const watchWorkerOptions: BundleOptions = {
  ...formatterHostOptions,
  entryPoints: ['src/desktop/watch-worker/index.ts'],
  outfile: 'dist/watch-worker.js',
};

const askpassMainOptions: BundleOptions = {
  ...formatterHostOptions,
  entryPoints: ['src/desktop/askpass/askpass-main.ts'],
  outfile: 'dist/askpass-main.js',
};

const cliOptions: BundleOptions = {
  ...formatterHostOptions,
  entryPoints: ['src/desktop/cli/cli.ts'],
  // resources/bin/damocles runs it under the app's binary as Node, from app.asar.unpacked
  outfile: 'dist/cli.js',
};

const cliRemoteOptions: BundleOptions = {
  ...formatterHostOptions,
  entryPoints: ['src/desktop/cli/cli-remote.ts'],
  // a server package's bin/remote-cli and bin/helpers run it under the package's own Node, a checkout's dist/server-bin under the Node on PATH
  outfile: 'dist/cli-remote.js',
};

// The repo's package.json says "type": "module" and every bundle is CommonJS, so a dist/ that Node loads .js bundles from
// declares its own scope: the checkout's, a server package's (scripts/build-server.ts), the VSIX's and the packaged app's
// app.asar.unpacked/dist, which extraMetadata.type does not cover.
export function writeDistScope(dir = 'dist'): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(`${dir}/package.json`, `${JSON.stringify({ type: 'commonjs' })}\n`);
}

// git and ssh execute the askpass scripts, so the packaged mode comes from here, never from the checkout's file mode. The
// folder's .sh files are the list: verify-desktop-package.ts's ASKPASS_SCRIPTS is tested against it.
export function copyAskpassScripts(dir = 'dist/askpass'): void {
  mkdirSync(dir, { recursive: true });
  for (const name of readdirSync('resources/askpass').filter((file) => file.endsWith('.sh'))) {
    copyFileSync(`resources/askpass/${name}`, `${dir}/${name}`);
    chmodSync(`${dir}/${name}`, 0o755);
  }
}

// A daemon's core gives git dist/git-credential/git-credential-relay.sh, or the .cmd on a Windows target, as its credential
// helper (src/core/scm/askpass/credential-relay.ts); git runs the .sh, so its mode comes from here.
export const CREDENTIAL_RELAY_SCRIPTS = ['git-credential-relay.sh', 'git-credential-relay.cmd'];
export function copyCredentialRelayScripts(dir = 'dist/git-credential'): void {
  mkdirSync(dir, { recursive: true });
  for (const name of CREDENTIAL_RELAY_SCRIPTS) {
    copyFileSync(`resources/git-credential/${name}`, `${dir}/${name}`);
    chmodSync(`${dir}/${name}`, name.endsWith('.sh') ? 0o755 : 0o644);
  }
}

// electron-builder ships dist/bin as <install>/resources/bin (extraResources); the sh script runs from PATH, so its packaged
// mode comes from here, never from the checkout's file mode.
export const CLI_SCRIPTS = ['damocles', 'damocles.cmd'];
export function copyCliScripts(dir = 'dist/bin'): void {
  mkdirSync(dir, { recursive: true });
  for (const name of CLI_SCRIPTS) {
    copyFileSync(`resources/bin/${name}`, `${dir}/${name}`);
    chmodSync(`${dir}/${name}`, name.endsWith('.cmd') ? 0o644 : 0o755);
  }
}

/**
 * The bundles a server package carries in dist/ (scripts/build-server.ts): the daemon, Damocles Core, the hosts the daemon
 * forks, every worker in CoreInit.paths.workers, the watch worker, the askpass helper and the terminals' damocles command.
 */
export const SERVER_BUNDLES: BundleOptions[] = [
  daemonOptions,
  coreHostOptions,
  ptyHostOptions,
  formatterHostOptions,
  processLauncherWorkerOptions,
  sentinelOptions,
  sessionMetaIndexWorkerOptions,
  memoryIntegrityWorkerOptions,
  usageStatsWorkerOptions,
  workerOptions,
  voiceExtractWorkerOptions,
  watchWorkerOptions,
  askpassMainOptions,
  cliRemoteOptions,
];

/** What the desktop build writes in dist/: the app's bundles, and every bundle the loopback daemon runs from it as a server package's. */
export const DESKTOP_BUNDLES: BundleOptions[] = [
  formatterHostOptions,
  ptyHostOptions,
  quickOpenWorkerOptions,
  watchWorkerOptions,
  askpassMainOptions,
  cliOptions,
  cliRemoteOptions,
  desktopMainOptions,
  coreHostOptions,
  daemonOptions,
  desktopPreloadOptions,
  desktopShellPreloadOptions,
  desktopOverlayPreloadOptions,
  workerOptions,
  usageStatsWorkerOptions,
  memoryIntegrityWorkerOptions,
  sessionMetaIndexWorkerOptions,
  voiceExtractWorkerOptions,
  processLauncherWorkerOptions,
  sentinelOptions,
];

// A checkout's stand-in for a server package's bin/ (daemon/server-package.ts terminalBinFolder): a checkout has no Node of its
// own, so these run dist/cli-remote.js under the Node on PATH; their mode comes from here, never from the checkout's. On Windows
// the BROWSER is browser.exe (writeCheckoutBrowserHelper), as a server package's is.
export const CHECKOUT_SERVER_BIN = 'dist/server-bin';
export function writeCheckoutServerBin(dir = CHECKOUT_SERVER_BIN): void {
  const sh = (what: string, args: string) => [
    '#!/bin/sh',
    `# ${what} in a terminal of this checkout's loopback daemon: the Node on PATH runs this checkout's dist/cli-remote.js`,
    `cli=$(CDPATH='' cd -- "$(dirname -- "$0")/../.." && pwd -P)/cli-remote.js || exit 1`,
    '# Windows Node reads it only by its Windows path, which Git Bash, MSYS2 and Cygwin name with cygpath',
    'case $(uname -s) in',
    '  MINGW* | MSYS* | CYGWIN*) if command -v cygpath > /dev/null 2>&1; then cli=$(cygpath -m "$cli") || exit 1; fi ;;',
    'esac',
    `exec node "$cli"${args} "$@"`,
    '',
  ].join('\n');
  const cmd = (what: string, args: string) => [
    '@echo off',
    `rem ${what} in a terminal of this checkout's loopback daemon: the Node on PATH runs this checkout's dist\\cli-remote.js`,
    'rem DisableDelayedExpansion: a registry DelayedExpansion=1 would eat a ! in the arguments.',
    'setlocal DisableDelayedExpansion',
    `node "%~dp0..\\..\\cli-remote.js"${args} %*`,
    'endlocal & exit /b %ERRORLEVEL%',
    '',
  ].join('\r\n');
  const scripts: [name: string, text: string][] = [
    ['remote-cli/damocles', sh('damocles', '')],
    ['remote-cli/damocles.cmd', cmd('damocles', '')],
    ['helpers/browser.sh', sh('BROWSER', ' --open-external')],
  ];
  // drops a script an earlier build wrote and this one no longer does
  rmSync(dir, { recursive: true, force: true });
  for (const [name, text] of scripts) {
    mkdirSync(`${dir}/${name.split('/')[0]}`, { recursive: true });
    writeFileSync(`${dir}/${name}`, text);
    chmodSync(`${dir}/${name}`, name.endsWith('.cmd') ? 0o644 : 0o755);
  }
}

// helpers/browser.exe of the checkout's bin, built for this machine like a server package's with the pinned zig
// (scripts/browser-helper.ts), which runs the Node on PATH.
export async function writeCheckoutBrowserHelper(dir = CHECKOUT_SERVER_BIN, arch: string = process.arch): Promise<void> {
  const { compileBrowserHelper } = await import('./scripts/browser-helper.ts');
  mkdirSync(`${dir}/helpers`, { recursive: true });
  writeFileSync(`${dir}/helpers/browser.exe`, await compileBrowserHelper({ arch, checkout: true }));
}

async function buildDesktop() {
  await Promise.all(DESKTOP_BUNDLES.map((options) => esbuild.build(options)));
  writeDistScope();
  // Settings › About's What's new reads it next to main.js (src/desktop/main/release-notes.ts).
  copyFileSync('CHANGELOG.md', 'dist/desktop/CHANGELOG.md');
  copyAskpassScripts();
  copyCredentialRelayScripts();
  copyCliScripts();
  writeCheckoutServerBin();
  if (process.platform === 'win32') await writeCheckoutBrowserHelper();
  const { compileAskpassTrampoline } = await import('./scripts/askpass-trampoline.ts');
  compileAskpassTrampoline();
  // the loopback daemon's core loads it from the checkout's dist/, as a server package's core does from its own
  const { vendorSubscriptionPlugin } = await import('./scripts/subscription-plugin.ts');
  await vendorSubscriptionPlugin('dist/subscription-plugin');
  console.log('Desktop main + core host + preload + formatter host + pty host + askpass helper + workers + sentinel + subscription plugin build complete');
}

async function build() {
  if (isDesktop) {
    await buildDesktop();
    return;
  }
  writeDistScope();
  if (isWatch) {
    const contexts = await Promise.all(EXTENSION_BUNDLES.map((options) => esbuild.context(options)));
    await Promise.all(contexts.map((ctx) => ctx.watch()));
    console.log('Watching for changes...');
  } else {
    await Promise.all(EXTENSION_BUNDLES.map((options) => esbuild.build(options)));
    console.log('Extension + workers + sentinel build complete');
  }
}

// Gated so scripts/build-server.ts can import the options without building.
if (isEntryPoint(import.meta.url)) {
  build().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
