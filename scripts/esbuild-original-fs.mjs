import { statSync } from 'node:fs';
import { basename } from 'node:path';
import { fileURLToPath } from 'node:url';

// Bundled fs becomes original-fs under Electron, node:fs under plain Node; Damocles' packed files are read only through
// src/core/resource-fs.ts. Why: docs/invariants.md "Desktop packaging and updates".

const RESOURCE_FS = fileURLToPath(new URL('../src/core/resource-fs.ts', import.meta.url));
const NAMESPACE = 'original-fs';
const FS_SPECIFIER = /^(?:node:)?fs(?:\/promises)?$/;
// Packages that hand their importers an fs: the importers do the file work, so the gate reviews them.
const FS_WRAPPER = /^graceful-fs$/;
const CHOICE = "(process.versions.electron === undefined ? require('node:fs') : require('original-fs'))";

/**
 * Bundled packages that use fs, each checked to read no file inside app.asar: original-fs cannot see inside an archive.
 * A package that reads its own packed files is an external instead (scripts/*-externals.mjs).
 */
export const REVIEWED_PACKAGES = [
  // reads the first bytes of the command it starts
  'cross-spawn',
  // exports a patched copy of fs; its importers are reviewed for what they read
  'graceful-fs',
  // stats PATH candidates
  'isexe',
  // lock folders beside the settings and session files it locks (json-config-write.ts, session-lease.ts)
  'proper-lockfile',
  // the voice runtime's downloaded tarball and its extraction folder
  'tar',
  // mock snapshot files, a testing API Damocles does not use
  'undici',
];

// The skip compares file identity, so a differently spelled path to resource-fs.ts (case, 8.3 name, junction) still matches.
function fileId(file) {
  const stats = statSync(file, { bigint: true, throwIfNoEntry: false });
  return stats === undefined ? undefined : `${stats.dev}:${stats.ino}`;
}

function packageOf(importer) {
  const parts = importer.split(/[\\/]/);
  const at = parts.lastIndexOf('node_modules');
  if (at < 0 || parts[at + 1] === undefined) return undefined;
  return parts[at + 1].startsWith('@') ? `${parts[at + 1]}/${parts[at + 2]}` : parts[at + 1];
}

/** @type {import('esbuild').Plugin} */
export const originalFs = {
  name: 'original-fs',
  setup(build) {
    // The shim's require() works only in CommonJS output; esbuild's ESM output turns it into a throwing __require.
    if (build.initialOptions.format !== 'cjs') throw new Error(`The original-fs plugin needs format: 'cjs', not ${build.initialOptions.format ?? 'the default'}.`);
    const resourceFsId = fileId(RESOURCE_FS);
    if (resourceFsId === undefined) throw new Error(`${RESOURCE_FS} is missing.`);
    const isResourceFs = (importer) => basename(importer).toLowerCase() === 'resource-fs.ts' && fileId(importer) === resourceFsId;
    const fsUsers = new Set();
    const recordUser = (importer) => {
      const pkg = packageOf(importer);
      if (pkg !== undefined) fsUsers.add(pkg);
    };
    build.onStart(() => {
      fsUsers.clear();
    });
    build.onResolve({ filter: /^original-fs$/ }, (args) => {
      if (args.namespace === NAMESPACE) return { path: 'original-fs', external: true };
      return { errors: [{ text: 'Import fs; the build maps it to original-fs under Electron (scripts/esbuild-original-fs.mjs).' }] };
    });
    build.onResolve({ filter: FS_WRAPPER }, (args) => {
      recordUser(args.importer);
      return undefined;
    });
    build.onResolve({ filter: FS_SPECIFIER }, (args) => {
      if (args.namespace === NAMESPACE) return { path: 'node:fs', external: true };
      if (args.kind === 'require-resolve' || isResourceFs(args.importer)) return undefined;
      recordUser(args.importer);
      return { path: args.path.endsWith('/promises') ? 'fs/promises' : 'fs', namespace: NAMESPACE };
    });
    build.onLoad({ filter: /^fs(?:\/promises)?$/, namespace: NAMESPACE }, (args) => ({
      contents: `module.exports = ${CHOICE}${args.path === 'fs/promises' ? '.promises' : ''};`,
      loader: 'js',
    }));
    build.onEnd(() => {
      const unreviewed = [...fsUsers].filter((pkg) => !REVIEWED_PACKAGES.includes(pkg)).sort();
      if (unreviewed.length === 0) return null;
      return {
        errors: unreviewed.map((pkg) => ({
          text: `${pkg} is bundled and uses fs; check it reads no file inside app.asar, then add it to REVIEWED_PACKAGES, or make it an external.`,
        })),
      };
    });
  },
};
