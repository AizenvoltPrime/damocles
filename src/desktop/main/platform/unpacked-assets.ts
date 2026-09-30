// electron-builder.yml `asarUnpack` must equal this list; __tests__/app-paths.test.ts fails when they drift.
export const ASAR_UNPACK = [
  'dist/compass-worker.js',
  'dist/usage-stats-worker.js',
  'dist/sentinel.js',
  'resources/grammars/**',
  'python/**',
  // The compass worker runs from app.asar.unpacked/dist, so its one external resolves only from the unpacked node_modules.
  'node_modules/web-tree-sitter/**',
  // child_process.spawn cannot execute a file inside app.asar.
  'node_modules/@vscode/ripgrep-*/**',
  // Native Node-API prebuilds; the koffi and @parcel/watcher JS loaders stay inside the asar.
  'node_modules/@koromix/koffi-*/**',
  'node_modules/@parcel/watcher-*/**',
] as const;
