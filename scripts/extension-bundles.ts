/**
 * The files the extension build writes into dist/, besides `dist/package.json` (`writeDistScope`) and the webview build's
 * folder. `esbuild.config.ts` builds each of these bundles, and `scripts/sync-vscodeignore.ts` re-includes exactly these in
 * the VSIX after excluding the rest of dist/, so a local file left in dist/ never ships. No imports: the release hosts run
 * the VSIX check with Node alone.
 */
export const EXTENSION_BUNDLE_FILES = {
  extension: 'dist/extension.cjs',
  compassWorker: 'dist/compass-worker.js',
  usageStatsWorker: 'dist/usage-stats-worker.js',
  memoryIntegrityWorker: 'dist/memory-integrity-worker.js',
  sessionMetaIndexWorker: 'dist/session-meta-index-worker.js',
  voiceExtractWorker: 'dist/voice-extract-worker.js',
  processLauncherWorker: 'dist/process-launcher-worker.js',
  sentinel: 'dist/sentinel.js',
} as const;

/** The webview build's output folder below dist/; vite.config.ts writes it (`outDir`). */
export const WEBVIEW_DIST_FOLDER = 'webview';
