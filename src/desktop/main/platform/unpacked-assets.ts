// Nothing on Windows loads @parcel/watcher and electron-builder.yml files leaves out its Windows prebuild, so this glob matches nothing there.
export const WATCHER_UNPACK = 'node_modules/@parcel/watcher-*/**';

// electron-builder.yml `asarUnpack` must equal this list; __tests__/app-paths.test.ts fails when they drift.
export const ASAR_UNPACK: readonly string[] = [
  'dist/compass-worker.js',
  'dist/usage-stats-worker.js',
  'dist/sentinel.js',
  // A utility process loads its script as a real file.
  'dist/formatter-host.js',
  'dist/pty-host.js',
  'dist/quick-open-worker.js',
  'dist/watch-worker.js',
  'resources/grammars/**',
  // bash, zsh, fish and PowerShell read their integration scripts as real files.
  'resources/shell-integration/**',
  'python/**',
  // The compass worker runs from app.asar.unpacked/dist, so its one external resolves only from the unpacked node_modules.
  'node_modules/web-tree-sitter/**',
  // child_process.spawn cannot execute a file inside app.asar.
  'node_modules/@vscode/ripgrep-*/**',
  // Native Node-API prebuilds; the koffi and @parcel/watcher JS loaders stay inside the asar.
  'node_modules/@koromix/koffi-*/**',
  WATCHER_UNPACK,
  // node-pty's JS stays inside the asar: loaded from there, its spawn-helper path rewrite to app.asar.unpacked is correct.
  'node_modules/node-pty/prebuilds/**',
];

/** The ASAR_UNPACK globs that match files in a package built for `platform`. */
export function asarUnpackFor(platform: string): readonly string[] {
  return platform === 'win32' ? ASAR_UNPACK.filter((glob) => glob !== WATCHER_UNPACK) : ASAR_UNPACK;
}
