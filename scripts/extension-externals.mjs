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
  // Node built-in SQLite (memory subsystem, Slice 1). A `node:`-prefixed builtin — esbuild
  // auto-externalizes it for platform:'node', and it has no node_modules to ship, so
  // sync-vscodeignore.mjs skips `node:`-prefixed entries when deriving the VSIX allowlist.
  'node:sqlite',
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
  // Patchright (patched Playwright, Apache-2.0) — the browser automation engine (Slice 1). CJS
  // `require('patchright')` from src/extension/browser; must stay external and ship as real
  // node_modules (it spawns a Node driver subprocess from patchright-core via process.execPath —
  // esbuild bundling would break that path resolution). `patchright-core` (the driver package) flows
  // into the VSIX allowlist automatically via the production-dependency closure walk. NO browsers are
  // bundled — Chrome is launched via channel:'chrome'.
  'patchright',
];
