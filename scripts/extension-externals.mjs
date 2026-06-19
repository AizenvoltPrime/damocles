/**
 * Single source of truth for the extension bundle's esbuild `external` packages — the dependencies that
 * are deliberately NOT bundled into dist/extension.js (pure-ESM packages with import.meta, native
 * binaries, packages that must keep a single shared instance) and therefore reach the running extension
 * via `require()` / dynamic `import()`. Every entry except `vscode` (provided by the host) MUST ship in
 * the VSIX as real node_modules.
 *
 * `esbuild.config.mjs` uses this for its `external` list, and `scripts/sync-vscodeignore.mjs` derives the
 * `.vscodeignore` node_modules allowlist from it + each package's production-dependency closure. Keeping
 * the externals here — not duplicated in both files — is what stops the bundle and the VSIX from drifting
 * (the bug that previously left the default `pi` engine's deps out of the package).
 */
export const EXTENSION_EXTERNALS = [
  'vscode',
  '@anthropic-ai/claude-agent-sdk',
  'sql.js-fts5',
  'zod',
  'web-tree-sitter',
  '@vscode/ripgrep',
  // pi agent harness — pure ESM with import.meta(.resolve); must stay external and ship as real
  // node_modules, loaded only via dynamic import() from CJS (blocker B2).
  '@earendil-works/pi-coding-agent',
  '@earendil-works/pi-agent-core',
  '@earendil-works/pi-ai',
  '@earendil-works/pi-tui',
  'jiti',
  'typebox',
  // MCP SDK — pure ESM ("type": "module") with deep subpath imports; kept external and loaded only via
  // dynamic import() from CJS, mirroring the pi harness (US-014.0).
  '@modelcontextprotocol/sdk',
  '@modelcontextprotocol/sdk/*',
];
