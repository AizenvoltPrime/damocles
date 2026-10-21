// Electron's archive-aware fs, for Damocles' own files inside app.asar: every other bundled import of fs gets original-fs,
// which cannot read inside an archive. scripts/esbuild-original-fs.mjs skips this file by path. Never pass it a user's path.
export { readFileSync } from 'node:fs';
export { readFile, realpath, stat } from 'node:fs/promises';
