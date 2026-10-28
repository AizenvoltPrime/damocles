/**
 * Builds the server packages: one archive per target holding the daemon's bundles, the Node the shipped
 * Electron embeds, and the production closure of the desktop externals for that target.
 *
 *   npm run build:server -- --target <target> [--node-version <v>] [--node-pty-binary <pty.node>]
 *   npm run build:server -- --all
 *   node scripts/build-server.mjs --write-manifest <dir>
 *
 * The bundles are built once into dist/server-packages/.stage/, never over the dev tree's dist/. Node archives, the
 * target's native npm packages and the subscription plugin (scripts/subscription-plugin.mjs) download into
 * dist/server-packages/.cache/, each checked against its pinned SHA-256 or its package-lock.json integrity. Archives land in dist/server-packages/, and dist/desktop/server-manifest.json lists every
 * package there for this version (the dev manifest). `--write-manifest` writes the release manifest from all eight packages
 * in <dir>. Alpine targets need `--node-pty-binary`, node-pty compiled against musl (the release workflow builds it in
 * node:<version>-alpine); `--all` builds the other six.
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';
import { DESKTOP_EXTERNALS } from './desktop-externals.mjs';
import { EXTENSION_EXTERNALS } from './extension-externals.mjs';
import { isEntryPoint } from './entry-point.mjs';
import { readTarGz, readZip, sha256, tarGz, zip } from './server-archive.mjs';
import { readProtocolVersion } from './protocol-compat.mjs';
import { NODE_RELEASES, SERVER_TARGETS, nodeArchive, serverArtifact, serverNodeVersion } from './server-targets.mjs';
import { DESKTOP_ONLY_PACKAGES, isPlatformBinary, platformFamilyGlob, productionClosure } from './sync-vscodeignore.mjs';
import { PLUGIN_DIR, vendorSubscriptionPlugin } from './subscription-plugin.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const OUT_DIR = join(ROOT, 'dist', 'server-packages');
const CACHE_DIR = join(OUT_DIR, '.cache');
export const STAGE_DIR = join(OUT_DIR, '.stage');
export const MANIFEST_PATH = join(ROOT, 'dist', 'desktop', 'server-manifest.json');
const FLAVOR_MODULE = join(ROOT, 'src', 'desktop', 'daemon', 'server-package.ts');

// Package files that are executed, so their mode is 0755 whatever the build machine's file modes are.
const EXECUTABLES = [
  /^bin\/damocles-server$/,
  /^node\/node$/,
  /^node_modules\/@vscode\/ripgrep-[^/]+\/bin\/rg$/,
  /^node_modules\/node-pty\/prebuilds\/[^/]+\/spawn-helper$/,
  /^dist\/askpass\/[^/]+\.sh$/,
  /^dist\/git-credential\/[^/]+\.sh$/,
];

// Files from the checkout's root the daemon and its core read: the version and contributed configuration, the localized
// strings, the shell integration, the Compass grammars and the notices.
const ROOT_FILES = ['package.json', 'package.nls.json', 'package.nls.el.json', 'LICENSE', 'THIRD-PARTY-NOTICES.md'];
const ROOT_FOLDERS = ['l10n', 'resources/shell-integration', 'resources/grammars'];

export function modeOf(path) {
  return EXECUTABLES.some((re) => re.test(path)) ? 0o755 : 0o644;
}

/** The node_modules roots of `spec`: the desktop externals without Electron's, with node-pty, per platform. */
export function serverRoots(spec) {
  const roots = new Set(DESKTOP_EXTERNALS.filter((name) => !name.startsWith('node:')).map((name) => name.replace(/\/\*+$/, '')));
  roots.delete('electron');
  roots.delete('electron-updater');
  // Windows never loads @parcel/watcher (file-watcher-factory.ts), and only Windows loads koffi (process-tree.ts).
  if (spec.platform === 'win32') roots.delete('@parcel/watcher');
  else roots.delete('koffi');
  roots.add('node-pty');
  return [...roots].sort();
}

/** Server-only roots are desktop-only too, so sync-vscodeignore.mjs keeps every one of them out of the VSIX. */
export function serverOnlyOutsideVsixGuard(roots) {
  return roots.filter((name) => !EXTENSION_EXTERNALS.includes(name) && !DESKTOP_ONLY_PACKAGES.includes(name));
}

/**
 * The top-level packages of `spec`'s node_modules: the closure of its roots in this checkout with every installed
 * platform-binary package swapped for the target's `natives`. A platform package whose family the target names no native
 * for fails the build, so a new native dependency cannot ship for the build machine alone.
 */
export function serverClosure(spec, closureOf = productionClosure, isPlatform = isPlatformBinary) {
  const roots = serverRoots(spec);
  const stray = serverOnlyOutsideVsixGuard(roots);
  if (stray.length) throw new Error(`Server roots ${stray.join(', ')} are not in DESKTOP_ONLY_PACKAGES, so the VSIX could ship them.`);
  const { packages } = closureOf(roots, 'server package');
  const families = new Set(spec.natives.map(platformFamilyGlob));
  const hostBinaries = packages.filter(isPlatform);
  const orphans = hostBinaries.filter((name) => !families.has(platformFamilyGlob(name)));
  if (orphans.length) throw new Error(`The server closure holds platform packages with no native named for this target: ${orphans.join(', ')} (scripts/server-targets.mjs natives).`);
  return { portable: packages.filter((name) => !hostBinaries.includes(name)), natives: spec.natives };
}

function walk(dir, prefix = '') {
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    const full = join(dir, entry.name);
    if (entry.isSymbolicLink()) {
      if (entry.name === '.bin' || basename(dir) === '.bin') continue;
      throw new Error(`${full} is a symlink, which a server package does not carry`);
    }
    if (entry.isDirectory()) {
      if (entry.name !== '.bin') files.push(...walk(full, relative));
    } else if (entry.isFile()) {
      files.push(relative);
    }
  }
  return files;
}

// what electron-builder.yml drops from node-pty: other targets' prebuilds, debug symbols, sources and any local build
function keepNodePtyFile(file, ptyPrebuild) {
  if (/^(build|deps|src|third_party|scripts)\//.test(file) || file.endsWith('.pdb')) return false;
  const prebuild = /^prebuilds\/([^/]+)\//.exec(file);
  return !prebuild || prebuild[1] === ptyPrebuild;
}

function file(path, source) {
  return { path, mode: modeOf(path), source };
}

function bytes(path, data) {
  return { path, mode: modeOf(path), data: Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8') };
}

/** bin/damocles-server (sh) and, for Windows, bin/damocles-server.cmd: the package's Node runs dist/daemon.js. */
export function launchers(spec) {
  const node = spec.platform === 'win32' ? 'node/node.exe' : 'node/node';
  const sh = [
    '#!/bin/sh',
    '# damocles-server attach|serve|self-test: the package\'s own Node runs the daemon',
    'root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd -P) || exit 1',
    `exec "$root/${node}" "$root/dist/daemon.js" "$@"`,
    '',
  ].join('\n');
  const entries = [bytes('bin/damocles-server', sh)];
  if (spec.platform === 'win32') entries.push(bytes('bin/damocles-server.cmd', '@echo off\r\n"%~dp0..\\node\\node.exe" "%~dp0..\\dist\\daemon.js" %*\r\n'));
  return entries;
}

/** node/node (or node.exe) and node/LICENSE from a Node release archive. */
export function nodeEntries(spec, archiveName, archive) {
  const entries = archiveName.endsWith('.zip') ? readZip(archive) : readTarGz(archive);
  const top = archiveName.replace(/\.(zip|tar\.gz)$/, '');
  const wanted = spec.platform === 'win32' ? { [`${top}/node.exe`]: 'node/node.exe', [`${top}/LICENSE`]: 'node/LICENSE' } : { [`${top}/bin/node`]: 'node/node', [`${top}/LICENSE`]: 'node/LICENSE' };
  const found = entries.filter((entry) => entry.type === 'file' && wanted[entry.path]).map((entry) => bytes(wanted[entry.path], entry.data));
  if (found.length !== 2) throw new Error(`${archiveName} lacks ${Object.keys(wanted).join(' or ')}`);
  return found;
}

/** An npm tarball's files as node_modules/<name>/..., source maps dropped. */
export function npmPackageEntries(name, tarball) {
  return readTarGz(tarball)
    .filter((entry) => entry.type === 'file' && entry.path.startsWith('package/') && !entry.path.endsWith('.map'))
    .map((entry) => bytes(`node_modules/${name}/${entry.path.slice('package/'.length)}`, entry.data));
}

/**
 * Every file of `spec`'s package, without the node and native parts: launchers, dist/ from `distDir`, the portable
 * node_modules closure from `nodeModules`, and the checkout's root files. Entries carry `source` (a file to read) or `data`.
 */
export function packageEntries({ spec, target, version, nodeVersion, distDir, nodeModules = join(ROOT, 'node_modules'), root = ROOT, portable, externals }) {
  const entries = [...launchers(spec)];
  for (const name of walk(distDir)) if (!name.endsWith('.map')) entries.push(file(`dist/${name}`, join(distDir, name)));
  for (const name of portable) {
    const dir = join(nodeModules, name);
    for (const relative of walk(dir)) {
      if (relative.endsWith('.map')) continue;
      if (name === 'node-pty' && !keepNodePtyFile(relative, spec.ptyPrebuild)) continue;
      entries.push(file(`node_modules/${name}/${relative}`, join(dir, relative)));
    }
  }
  for (const name of ROOT_FILES) entries.push(file(name, join(root, name)));
  for (const folder of ROOT_FOLDERS) for (const relative of walk(join(root, folder))) entries.push(file(`${folder}/${relative}`, join(root, folder, relative)));
  const packages = [...portable, ...spec.natives].sort();
  entries.push(bytes('server-package.json', `${JSON.stringify({ name: 'damocles-server', version, target, node: nodeVersion, externals, packages }, null, 2)}\n`));
  return entries;
}

/** The roots self-test imports: what the bundles require, minus node-pty, which only the pty host loads, by path. */
export function selfTestExternals(spec) {
  return serverRoots(spec).filter((name) => name !== 'node-pty');
}

function lockfileEntry(name) {
  const lock = JSON.parse(readFileSync(join(ROOT, 'package-lock.json'), 'utf8'));
  const entry = lock.packages?.[`node_modules/${name}`];
  if (!entry?.resolved || !entry.integrity) throw new Error(`package-lock.json has no resolved tarball and integrity for ${name}`);
  return entry;
}

function matchesIntegrity(data, integrity) {
  const [algorithm, expected] = integrity.split('-', 2);
  return createHash(algorithm).update(data).digest('base64') === expected;
}

/** A download, cached under .cache/ and accepted only when `valid` holds for its bytes. */
async function cachedDownload(url, name, valid) {
  mkdirSync(CACHE_DIR, { recursive: true });
  const cached = join(CACHE_DIR, name);
  if (existsSync(cached)) {
    const data = readFileSync(cached);
    if (valid(data)) return data;
  }
  console.log(`Downloading ${url}`);
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url} answered ${response.status}`);
  const data = Buffer.from(await response.arrayBuffer());
  if (!valid(data)) throw new Error(`${url} does not match its pinned hash`);
  writeFileSync(cached, data);
  return data;
}

async function nativeEntries(spec) {
  const entries = [];
  for (const name of spec.natives) {
    const lock = lockfileEntry(name);
    const tarball = await cachedDownload(lock.resolved, `${name.replace('/', '+')}-${lock.version}.tgz`, (data) => matchesIntegrity(data, lock.integrity));
    entries.push(...npmPackageEntries(name, tarball));
  }
  return entries;
}

// the flag that makes a packaged daemon refuse e2e hooks: the same module, compiled with SERVER_PACKAGE true
export const serverFlavor = {
  name: 'server-package-flavor',
  setup(build) {
    const source = readFileSync(FLAVOR_MODULE, 'utf8');
    const flipped = source.replace('export const SERVER_PACKAGE: boolean = false;', 'export const SERVER_PACKAGE: boolean = true;');
    if (flipped === source) throw new Error(`${FLAVOR_MODULE} no longer declares SERVER_PACKAGE as build-server.mjs expects`);
    build.onLoad({ filter: /[\\/]src[\\/]desktop[\\/]daemon[\\/]server-package\.ts$/ }, () => ({ contents: flipped, loader: 'ts' }));
  },
};

/** Builds the server bundles into `<stage>/dist`, with the original-fs shim and the server flavor, beside the pinned subscription plugin. */
export async function buildBundles(stage = STAGE_DIR) {
  const { SERVER_BUNDLES, copyAskpassScripts, copyCredentialRelayScripts } = await import('../esbuild.config.mjs');
  const dist = join(stage, 'dist');
  rmSync(dist, { recursive: true, force: true });
  await Promise.all(SERVER_BUNDLES.map((options) => esbuild.build({
    ...options,
    outfile: join(dist, basename(options.outfile)),
    sourcemap: false,
    logLevel: 'warning',
    plugins: [serverFlavor, ...(options.plugins ?? [])],
  })));
  copyAskpassScripts(join(dist, 'askpass'));
  copyCredentialRelayScripts(join(dist, 'git-credential'));
  await vendorSubscriptionPlugin(join(dist, PLUGIN_DIR));
  if (!readFileSync(join(dist, 'daemon.js'), 'utf8').includes('SERVER_PACKAGE = true')) throw new Error('The staged daemon.js was not built with SERVER_PACKAGE true');
  return dist;
}

/** Reads every `source` entry into `data`. */
export function loaded(entries) {
  return entries.map((entry) => (entry.data ? entry : { path: entry.path, mode: entry.mode, data: readFileSync(entry.source) }));
}

/** All of `target`'s entries; `nodePtyBinary` replaces the prebuild of an Alpine target. */
export async function targetEntries(target, { version, nodeVersion, distDir, nodePtyBinary }) {
  const spec = SERVER_TARGETS[target];
  const { portable } = serverClosure(spec);
  const archive = nodeArchive(target, nodeVersion);
  const archiveName = basename(new URL(archive.url).pathname);
  const nodeArchiveData = await cachedDownload(archive.url, archiveName, (data) => sha256(data) === archive.sha256);
  const entries = [
    ...packageEntries({ spec, target, version, nodeVersion, distDir, portable, externals: selfTestExternals(spec) }),
    ...nodeEntries(spec, archiveName, nodeArchiveData),
    ...(await nativeEntries(spec)),
  ];
  if (spec.alpine) {
    const prebuilt = `node_modules/node-pty/prebuilds/${spec.ptyPrebuild}/pty.node`;
    const at = entries.findIndex((entry) => entry.path === prebuilt);
    if (at === -1) throw new Error(`${prebuilt} is not in the closure`);
    entries[at] = { path: prebuilt, mode: modeOf(prebuilt), source: nodePtyBinary };
  }
  return entries;
}

/** `target`'s archive of loaded `entries`. */
export function archiveOf(target, entries) {
  return SERVER_TARGETS[target].platform === 'win32' ? zip(entries) : tarGz(entries);
}

/** The release manifest of the packages in `dir` for `targets`: `{ version, protocolVersion, packages }`. */
export function serverManifest(dir, version, targets) {
  const { protocolVersion } = readProtocolVersion();
  const packages = {};
  for (const target of targets) {
    const name = serverArtifact(target, version);
    const data = readFileSync(join(dir, name));
    packages[target] = { file: name, sha256: sha256(data), size: data.length };
  }
  return { version, protocolVersion, packages };
}

function writeManifest(dir, version, targets) {
  mkdirSync(dirname(MANIFEST_PATH), { recursive: true });
  writeFileSync(MANIFEST_PATH, `${JSON.stringify(serverManifest(dir, version, targets), null, 2)}\n`);
  console.log(`Wrote ${MANIFEST_PATH} for ${targets.join(', ') || 'no package'}`);
}

function option(name) {
  const at = process.argv.indexOf(name);
  return at === -1 ? undefined : process.argv[at + 1];
}

async function main() {
  process.chdir(ROOT);
  const { version } = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  const manifestDir = option('--write-manifest');
  if (manifestDir) {
    const targets = Object.keys(SERVER_TARGETS);
    const missing = targets.filter((target) => !existsSync(join(manifestDir, serverArtifact(target, version))));
    if (missing.length) throw new Error(`${manifestDir} lacks the server packages of ${missing.join(', ')}`);
    writeManifest(manifestDir, version, targets);
    return;
  }
  const target = option('--target');
  const all = process.argv.includes('--all');
  if (!all && !SERVER_TARGETS[target]) throw new Error(`Usage: build-server.mjs --target <${Object.keys(SERVER_TARGETS).join('|')}> | --all`);
  const nodePtyBinary = option('--node-pty-binary');
  const targets = all ? Object.keys(SERVER_TARGETS).filter((name) => !SERVER_TARGETS[name].alpine) : [target];
  if (!all && SERVER_TARGETS[target].alpine && !nodePtyBinary) throw new Error(`${target} needs --node-pty-binary <pty.node compiled against musl>`);
  const pinned = option('--node-version');
  const nodeVersion = pinned ?? serverNodeVersion();
  if (!NODE_RELEASES[nodeVersion]) throw new Error(`Node ${nodeVersion} has no pinned archives in scripts/server-targets.mjs`);
  const distDir = await buildBundles();
  mkdirSync(OUT_DIR, { recursive: true });
  for (const name of targets) {
    const entries = loaded(await targetEntries(name, { version, nodeVersion, distDir, nodePtyBinary }));
    const archive = archiveOf(name, entries);
    const out = join(OUT_DIR, serverArtifact(name, version));
    writeFileSync(out, archive);
    console.log(`${out}: ${entries.length} files, ${archive.length} bytes, sha256 ${sha256(archive)}`);
    if (SERVER_TARGETS[name].alpine) console.log(`node-pty for ${name}: sha256 ${sha256(readFileSync(nodePtyBinary))}`);
  }
  const built = Object.keys(SERVER_TARGETS).filter((name) => existsSync(join(OUT_DIR, serverArtifact(name, version))));
  writeManifest(OUT_DIR, version, built);
}

if (isEntryPoint(import.meta.url)) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
