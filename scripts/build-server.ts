/**
 * Builds the server packages: one archive per target holding the daemon's bundles, the Node the shipped
 * Electron embeds, and the production closure of the desktop externals for that target.
 *
 *   npm run build:server -- --target <target> [--node-version <v>] [--node-pty-binary <pty.node>] [--signed-browser-helper <browser.exe>]
 *   npm run build:server -- --all
 *   node scripts/build-server.ts --write-manifest <dir>
 *
 * The bundles are built once into dist/server-packages/.stage/, never over the dev tree's dist/. Node archives, the
 * target's native npm packages, the subscription plugin (scripts/subscription-plugin.ts) and the zig that compiles a Windows
 * package's bin/helpers/browser.exe (scripts/browser-helper.ts) download into dist/server-packages/.cache/, each checked against
 * its pinned SHA-256 or its package-lock.json integrity; `--signed-browser-helper` puts the release's signed copy of that
 * browser.exe in its place once it proves to be it. Archives land in dist/server-packages/, and dist/desktop/server-manifest.json lists every
 * package there for this version (the dev manifest, unpublished). `--write-manifest` writes the release manifest, the only
 * published one, from all eight packages in <dir>. Alpine targets need `--node-pty-binary`, node-pty compiled against musl (the release workflow builds it in
 * node:<version>-alpine); `--all` builds the other six.
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';
import { packagedBrowserHelper } from './browser-helper.ts';
import { cachedDownload as cachedFile } from './cached-download.ts';
import { DESKTOP_EXTERNALS } from './desktop-externals.ts';
import { EXTENSION_EXTERNALS } from './extension-externals.ts';
import { clampLoadAlign } from './elf-load-align.ts';
import { isEntryPoint } from './entry-point.ts';
import { readTarGz, readZip, sha256, tarGz, zip, type ArchiveEntry, type ReadEntry } from './server-archive.ts';
import { readProtocolVersion } from './protocol-compat.ts';
import {
  DEVCONTAINERS_CLI, NODE_RELEASES, SERVER_TARGETS, SERVER_TARGET_NAMES, isServerTarget, nodeArchive, serverArtifact, serverNodeVersion, serverTarget,
  type ServerTarget, type ServerTargetName,
} from './server-targets.ts';
import { DESKTOP_ONLY_PACKAGES, isPlatformBinary, platformFamilyGlob, productionClosure } from './sync-vscodeignore.ts';
import { PLUGIN_DIR, vendorSubscriptionPlugin } from './subscription-plugin.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const OUT_DIR = join(ROOT, 'dist', 'server-packages');
const CACHE_DIR = join(OUT_DIR, '.cache');
export const STAGE_DIR = join(OUT_DIR, '.stage');
export const MANIFEST_PATH = join(ROOT, 'dist', 'desktop', 'server-manifest.json');
const FLAVOR_MODULE = join(ROOT, 'src', 'desktop', 'daemon', 'server-package.ts');

// Package files that are executed, so their mode is 0755 whatever the build machine's file modes are.
const EXECUTABLES = [
  /^bin\/damocles-server$/,
  /^bin\/remote-cli\/damocles$/,
  /^bin\/helpers\/browser\.sh$/,
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

/** A package file still to be read from `source`. */
export interface SourceEntry { path: string; mode: number; source: string }

export type PackageEntry = ArchiveEntry | SourceEntry;

/** server-package.json's fields but `serverVersion`. */
export type PackageInfo = { name: string; version: string; target: string; node: string; externals: string[]; packages: string[] };

export interface PackageBuildOptions {
  version: string;
  nodeVersion: string;
  distDir: string;
  nodePtyBinary: string | undefined;
  signedBrowserHelper: Buffer | undefined;
}

export interface ManifestPackage { file: string; sha256: string; size: number; serverVersion: string }

export interface ServerManifest { version: string; protocolVersion: number; published: boolean; packages: Record<string, ManifestPackage> }

export function modeOf(path: string): number {
  return EXECUTABLES.some((re) => re.test(path)) ? 0o755 : 0o644;
}

/** The node_modules roots of `spec`: the desktop externals without Electron's, with node-pty and the Dev Containers CLI, per platform. */
export function serverRoots(spec: Pick<ServerTarget, 'platform'>): string[] {
  const roots = new Set(DESKTOP_EXTERNALS.filter((name) => !name.startsWith('node:')).map((name) => name.replace(/\/\*+$/, '')));
  roots.delete('electron');
  roots.delete('electron-updater');
  // Windows never loads @parcel/watcher (file-watcher-factory.ts), and only Windows loads koffi (process-tree.ts).
  if (spec.platform === 'win32') roots.delete('@parcel/watcher');
  else roots.delete('koffi');
  roots.add('node-pty');
  roots.add(DEVCONTAINERS_CLI);
  return [...roots].sort();
}

/** Server-only roots are desktop-only too, so sync-vscodeignore.ts keeps every one of them out of the VSIX. */
export function serverOnlyOutsideVsixGuard(roots: readonly string[]): string[] {
  return roots.filter((name) => !EXTENSION_EXTERNALS.includes(name) && !DESKTOP_ONLY_PACKAGES.includes(name));
}

/**
 * The top-level packages of `spec`'s node_modules: the closure of its roots in this checkout with every installed
 * platform-binary package swapped for the target's `natives`. A platform package whose family the target names no native
 * for fails the build, so a new native dependency cannot ship for the build machine alone.
 */
export function serverClosure(
  spec: Pick<ServerTarget, 'platform' | 'natives'>,
  closureOf: (roots: string[], label: string) => { packages: string[] } = productionClosure,
  isPlatform: (name: string) => boolean = isPlatformBinary,
): { portable: string[]; natives: string[] } {
  const roots = serverRoots(spec);
  const stray = serverOnlyOutsideVsixGuard(roots);
  if (stray.length) throw new Error(`Server roots ${stray.join(', ')} are not in DESKTOP_ONLY_PACKAGES, so the VSIX could ship them.`);
  const { packages } = closureOf(roots, 'server package');
  const families = new Set(spec.natives.map(platformFamilyGlob));
  const hostBinaries = packages.filter(isPlatform);
  const orphans = hostBinaries.filter((name) => !families.has(platformFamilyGlob(name)));
  if (orphans.length) throw new Error(`The server closure holds platform packages with no native named for this target: ${orphans.join(', ')} (scripts/server-targets.ts natives).`);
  return { portable: packages.filter((name) => !hostBinaries.includes(name)), natives: spec.natives };
}

function walk(dir: string, prefix = ''): string[] {
  const files: string[] = [];
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
function keepNodePtyFile(file: string, ptyPrebuild: string): boolean {
  if (/^(build|deps|src|third_party|scripts)\//.test(file) || file.endsWith('.pdb')) return false;
  const prebuild = /^prebuilds\/([^/]+)\//.exec(file);
  return !prebuild || prebuild[1] === ptyPrebuild;
}

function file(path: string, source: string): SourceEntry {
  return { path, mode: modeOf(path), source };
}

function bytes(path: string, data: Buffer | string): ArchiveEntry {
  return { path, mode: modeOf(path), data: Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8') };
}

/** bin/damocles-server (sh) and, for Windows, bin/damocles-server.cmd: the package's Node runs dist/daemon.js. */
export function launchers(spec: Pick<ServerTarget, 'platform'>): ArchiveEntry[] {
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

// The damocles command and the BROWSER helper of a target's user terminals (resources/server-bin), for POSIX or Windows. Windows
// also gets the sh forms for Git Bash, MSYS2 and Cygwin, whose sh finds no .cmd, and the BROWSER cli-server.ts sets there is
// bin/helpers/browser.exe (targetEntries), since cmd.exe would parse the address.
const CLI_SCRIPTS = {
  posix: ['remote-cli/damocles', 'helpers/browser.sh'],
  win32: ['remote-cli/damocles', 'remote-cli/damocles.cmd', 'helpers/browser.sh'],
};
export const BROWSER_HELPER_PATH = 'bin/helpers/browser.exe';

/** bin/remote-cli and bin/helpers for `spec`'s platform, from resources/server-bin; each runs dist/cli-remote.js. */
export function cliScripts(spec: Pick<ServerTarget, 'platform'>, root = ROOT): SourceEntry[] {
  return CLI_SCRIPTS[spec.platform === 'win32' ? 'win32' : 'posix'].map((name) => file(`bin/${name}`, join(root, 'resources', 'server-bin', name)));
}

/** Whether `spec`'s executables must load on WSL 1, whose ELF loader takes no PT_LOAD aligned past 4 KiB: x64 Linux only, as arm64 kernels may use 64 KiB pages. */
export function clampsLoadAlign(spec: Pick<ServerTarget, 'platform' | 'arch'>): boolean {
  return spec.platform === 'linux' && spec.arch === 'x64';
}

/** node/node (or node.exe) and node/LICENSE from a Node release archive, node/node's PT_LOAD alignment clamped where `clampsLoadAlign`. */
export function nodeEntries(spec: Pick<ServerTarget, 'platform' | 'arch'>, archiveName: string, archive: Buffer): ArchiveEntry[] {
  const entries = archiveName.endsWith('.zip') ? readZip(archive) : readTarGz(archive);
  const top = archiveName.replace(/\.(zip|tar\.gz)$/, '');
  const wanted: Record<string, string> = spec.platform === 'win32' ? { [`${top}/node.exe`]: 'node/node.exe', [`${top}/LICENSE`]: 'node/LICENSE' } : { [`${top}/bin/node`]: 'node/node', [`${top}/LICENSE`]: 'node/LICENSE' };
  const contents = (entry: ReadEntry, path: string) => (path === 'node/node' && clampsLoadAlign(spec) ? clampLoadAlign(entry.data, `${archiveName} ${entry.path}`) : entry.data);
  const found = entries.flatMap((entry) => {
    const path = wanted[entry.path];
    return entry.type === 'file' && path ? [bytes(path, contents(entry, path))] : [];
  });
  if (found.length !== 2) throw new Error(`${archiveName} lacks ${Object.keys(wanted).join(' or ')}`);
  return found;
}

/** An npm tarball's files as node_modules/<name>/..., source maps dropped. */
export function npmPackageEntries(name: string, tarball: Buffer): ArchiveEntry[] {
  return readTarGz(tarball)
    .filter((entry) => entry.type === 'file' && entry.path.startsWith('package/') && !entry.path.endsWith('.map'))
    .map((entry) => bytes(`node_modules/${name}/${entry.path.slice('package/'.length)}`, entry.data));
}

/**
 * Every file of `spec`'s package, without the node and native parts: launchers, dist/ from `distDir`, the portable
 * node_modules closure from `nodeModules`, and the checkout's root files. Entries carry `source` (a file to read) or `data`.
 */
export function packageEntries({ spec, distDir, nodeModules = join(ROOT, 'node_modules'), root = ROOT, portable }: {
  spec: Pick<ServerTarget, 'platform' | 'ptyPrebuild'>;
  distDir: string;
  nodeModules?: string;
  root?: string;
  portable: readonly string[];
}): PackageEntry[] {
  const entries: PackageEntry[] = [...launchers(spec), ...cliScripts(spec, root)];
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
  return entries;
}

const SERVER_PACKAGE_FILE = 'server-package.json';

/** server-package.json's fields but `serverVersion`, in the order packageBuild hashes them. */
export function packageInfo({ spec, target, version, nodeVersion, portable }: {
  spec: Pick<ServerTarget, 'platform' | 'natives'>;
  target: string;
  version: string;
  nodeVersion: string;
  portable: readonly string[];
}): PackageInfo {
  return { name: 'damocles-server', version, target, node: nodeVersion, externals: selfTestExternals(spec), packages: [...portable, ...spec.natives].sort() };
}

/**
 * The package's build: the first 12 hex digits of SHA-256 over every loaded entry but server-package.json, sorted by path, each
 * as `<path>\0<mode octal>\0<sha256 of data>\n`, then `server-package.json\0<JSON of info>\n`.
 */
export function packageBuild(entries: readonly ArchiveEntry[], info: Readonly<Record<string, unknown>>): string {
  const hash = createHash('sha256');
  const files = entries.filter((entry) => entry.path !== SERVER_PACKAGE_FILE).sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  for (const entry of files) hash.update(`${entry.path}\0${entry.mode.toString(8)}\0${sha256(entry.data)}\n`);
  hash.update(`${SERVER_PACKAGE_FILE}\0${JSON.stringify(info)}\n`);
  return hash.digest('hex').slice(0, 12);
}

// src/remote/handshake.ts VERSION, which the welcome's serverVersion and the pid file's version must pass
const SERVER_VERSION = /^[0-9A-Za-z.+-]{1,64}$/;

/** `<version>+<build>`, the server version of a package: server-package.json, the manifest, the host's folder and the welcome carry it. */
export function serverVersionOf(version: string, build: string): string {
  if (version.includes('+')) throw new Error(`package.json's version ${version} holds a +, which only the server version's build may add`);
  const serverVersion = `${version}+${build}`;
  if (!SERVER_VERSION.test(serverVersion)) throw new Error(`The server version ${serverVersion} is not 1 to 64 letters, digits, dots, pluses and hyphens`);
  return serverVersion;
}

/** The roots self-test imports: what the bundles require, minus node-pty and the Dev Containers CLI, which load by path. */
export function selfTestExternals(spec: Pick<ServerTarget, 'platform'>): string[] {
  return serverRoots(spec).filter((name) => name !== 'node-pty' && name !== DEVCONTAINERS_CLI);
}

interface LockPackage { resolved?: string; integrity?: string; version?: string }

function lockfileEntry(name: string): { resolved: string; integrity: string; version: string | undefined } {
  const lock = JSON.parse(readFileSync(join(ROOT, 'package-lock.json'), 'utf8')) as { packages?: Record<string, LockPackage> };
  const entry = lock.packages?.[`node_modules/${name}`];
  if (!entry?.resolved || !entry.integrity) throw new Error(`package-lock.json has no resolved tarball and integrity for ${name}`);
  return { resolved: entry.resolved, integrity: entry.integrity, version: entry.version };
}

function matchesIntegrity(data: Buffer, integrity: string): boolean {
  // split always yields a first element
  const [algorithm = '', expected] = integrity.split('-', 2);
  return createHash(algorithm).update(data).digest('base64') === expected;
}

/** A download, cached under .cache/ and accepted only when `valid` holds for its bytes. */
function cachedDownload(url: string, name: string, valid: (data: Buffer) => boolean): Promise<Buffer> {
  return cachedFile(url, join(CACHE_DIR, name), valid);
}

async function nativeEntries(spec: Pick<ServerTarget, 'natives'>): Promise<ArchiveEntry[]> {
  const entries: ArchiveEntry[] = [];
  for (const name of spec.natives) {
    const lock = lockfileEntry(name);
    const tarball = await cachedDownload(lock.resolved, `${name.replace('/', '+')}-${lock.version}.tgz`, (data) => matchesIntegrity(data, lock.integrity));
    entries.push(...npmPackageEntries(name, tarball));
  }
  return entries;
}

// the flag that makes a packaged daemon refuse e2e hooks: the same module, compiled with SERVER_PACKAGE true
export const serverFlavor: esbuild.Plugin = {
  name: 'server-package-flavor',
  setup(build) {
    const source = readFileSync(FLAVOR_MODULE, 'utf8');
    const flipped = source.replace('export const SERVER_PACKAGE: boolean = false;', 'export const SERVER_PACKAGE: boolean = true;');
    if (flipped === source) throw new Error(`${FLAVOR_MODULE} no longer declares SERVER_PACKAGE as build-server.ts expects`);
    build.onLoad({ filter: /[\\/]src[\\/]desktop[\\/]daemon[\\/]server-package\.ts$/ }, () => ({ contents: flipped, loader: 'ts' }));
  },
};

/** Builds the server bundles into `<stage>/dist`, with the original-fs shim and the server flavor, beside the pinned subscription plugin. */
export async function buildBundles(stage = STAGE_DIR): Promise<string> {
  const { SERVER_BUNDLES, copyAskpassScripts, copyCredentialRelayScripts, writeDistScope } = await import('../esbuild.config.ts');
  const dist = join(stage, 'dist');
  rmSync(dist, { recursive: true, force: true });
  await Promise.all(SERVER_BUNDLES.map((options) => esbuild.build({
    ...options,
    outfile: join(dist, basename(options.outfile)),
    sourcemap: false,
    logLevel: 'warning',
    plugins: [serverFlavor, ...(options.plugins ?? [])],
  })));
  writeDistScope(dist);
  copyAskpassScripts(join(dist, 'askpass'));
  copyCredentialRelayScripts(join(dist, 'git-credential'));
  await vendorSubscriptionPlugin(join(dist, PLUGIN_DIR));
  if (!readFileSync(join(dist, 'daemon.js'), 'utf8').includes('SERVER_PACKAGE = true')) throw new Error('The staged daemon.js was not built with SERVER_PACKAGE true');
  return dist;
}

/** Reads every `source` entry into `data`. */
function loaded(entries: readonly PackageEntry[]): ArchiveEntry[] {
  return entries.map((entry) => ('data' in entry ? entry : { path: entry.path, mode: entry.mode, data: readFileSync(entry.source) }));
}

// All of `target`'s entries but server-package.json; `nodePtyBinary` replaces the prebuild of an Alpine target, and
// `signedBrowserHelper`, the release's signed copy of the browser.exe built here, the Windows one.
async function targetEntries(target: string, { version, nodeVersion, distDir, nodePtyBinary, signedBrowserHelper, portable }: PackageBuildOptions & { portable: string[] }): Promise<PackageEntry[]> {
  const spec = serverTarget(target);
  const archive = nodeArchive(target, nodeVersion);
  const archiveName = basename(new URL(archive.url).pathname);
  const nodeArchiveData = await cachedDownload(archive.url, archiveName, (data) => sha256(data) === archive.sha256);
  const entries: PackageEntry[] = [
    ...packageEntries({ spec, distDir, portable }),
    ...nodeEntries(spec, archiveName, nodeArchiveData),
    ...(await nativeEntries(spec)),
  ];
  if (spec.platform === 'win32') entries.push(bytes(BROWSER_HELPER_PATH, await packagedBrowserHelper(spec.arch, version, signedBrowserHelper)));
  else if (signedBrowserHelper) throw new Error(`${target} carries no browser.exe to replace with a signed one`);
  if (spec.alpine) {
    const prebuilt = `node_modules/node-pty/prebuilds/${spec.ptyPrebuild}/pty.node`;
    const at = entries.findIndex((entry) => entry.path === prebuilt);
    if (at === -1) throw new Error(`${prebuilt} is not in the closure`);
    if (nodePtyBinary === undefined) throw new Error(`${target} needs --node-pty-binary <pty.node compiled against musl>`);
    entries[at] = { path: prebuilt, mode: modeOf(prebuilt), source: nodePtyBinary };
  }
  return entries;
}

/** Every loaded entry of `target`'s package, server-package.json last, naming the server version the others hash to. */
export async function assemblePackage(target: string, { version, nodeVersion, distDir, nodePtyBinary, signedBrowserHelper }: PackageBuildOptions): Promise<ArchiveEntry[]> {
  const spec = serverTarget(target);
  const { portable } = serverClosure(spec);
  const entries = loaded(await targetEntries(target, { version, nodeVersion, distDir, nodePtyBinary, signedBrowserHelper, portable }));
  const info = packageInfo({ spec, target, version, nodeVersion, portable });
  return [...entries, serverPackageEntry(info, serverVersionOf(version, packageBuild(entries, info)))];
}

/** server-package.json: info's fields in info's order with serverVersion after version, so dropping it gives back what packageBuild hashed. */
export function serverPackageEntry(info: PackageInfo, serverVersion: string): ArchiveEntry {
  const fields = Object.fromEntries(Object.entries(info).flatMap((field) => (field[0] === 'version' ? [field, ['serverVersion', serverVersion]] : [field])));
  return bytes(SERVER_PACKAGE_FILE, `${JSON.stringify(fields, null, 2)}\n`);
}

/** `target`'s archive of loaded `entries`. */
export function archiveOf(target: string, entries: readonly ArchiveEntry[]): Buffer {
  return serverTarget(target).platform === 'win32' ? zip(entries) : tarGz(entries);
}

const BUILD = /^[0-9a-f]{12}$/;

// The server-package.json of `target`'s archive `data`, whose fields serverManifest checks.
function archivedPackageInfo(target: string, data: Buffer): { version?: unknown; target?: unknown; serverVersion?: unknown } {
  const entries = serverTarget(target).platform === 'win32' ? readZip(data) : readTarGz(data);
  const found = entries.find((entry) => entry.path === SERVER_PACKAGE_FILE);
  if (!found) throw new Error(`The ${target} package has no ${SERVER_PACKAGE_FILE}`);
  return JSON.parse(found.data.toString('utf8')) as { version?: unknown; target?: unknown; serverVersion?: unknown };
}

/**
 * The manifest of the packages in `dir` for `targets`: `{ version, protocolVersion, published, packages }`, each package with the
 * server version its server-package.json names. Only the release's manifest is `published`, so only its hosts download.
 */
export function serverManifest(dir: string, version: string, targets: readonly string[], { published }: { published: boolean }): ServerManifest {
  const { protocolVersion } = readProtocolVersion();
  const packages: Record<string, ManifestPackage> = {};
  for (const target of targets) {
    const name = serverArtifact(target, version);
    const data = readFileSync(join(dir, name));
    const info = archivedPackageInfo(target, data);
    if (info.version !== version || info.target !== target) throw new Error(`${name} holds the server package of ${info.version} for ${info.target}`);
    const serverVersion = info.serverVersion;
    if (typeof serverVersion !== 'string' || !serverVersion.startsWith(`${version}+`) || !BUILD.test(serverVersion.slice(version.length + 1))) {
      const ptyOption = serverTarget(target).alpine ? ' --node-pty-binary <pty.node compiled against musl>' : '';
      throw new Error(`${name} names the server version ${serverVersion}, not ${version}+<12 hex digits>; build it again with npm run build:server -- --target ${target}${ptyOption}, or delete it`);
    }
    packages[target] = { file: name, sha256: sha256(data), size: data.length, serverVersion };
  }
  return { version, protocolVersion, published, packages };
}

function writeManifest(dir: string, version: string, targets: readonly string[], published: boolean): void {
  mkdirSync(dirname(MANIFEST_PATH), { recursive: true });
  writeFileSync(MANIFEST_PATH, `${JSON.stringify(serverManifest(dir, version, targets, { published }), null, 2)}\n`);
  console.log(`Wrote ${MANIFEST_PATH} for ${targets.join(', ') || 'no package'}${published ? ', published' : ''}`);
}

function option(name: string): string | undefined {
  const at = process.argv.indexOf(name);
  return at === -1 ? undefined : process.argv[at + 1];
}

async function main() {
  process.chdir(ROOT);
  const { version } = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { version: string };
  const manifestDir = option('--write-manifest');
  if (manifestDir) {
    const targets = Object.keys(SERVER_TARGETS);
    const missing = targets.filter((target) => !existsSync(join(manifestDir, serverArtifact(target, version))));
    if (missing.length) throw new Error(`${manifestDir} lacks the server packages of ${missing.join(', ')}`);
    writeManifest(manifestDir, version, targets, true);
    return;
  }
  const target = option('--target');
  const all = process.argv.includes('--all');
  const nodePtyBinary = option('--node-pty-binary');
  const signedHelperFile = option('--signed-browser-helper');
  let targets: ServerTargetName[];
  if (all) {
    targets = SERVER_TARGET_NAMES.filter((name) => !SERVER_TARGETS[name].alpine);
  } else {
    if (target === undefined || !isServerTarget(target)) throw new Error(`Usage: build-server.ts --target <${Object.keys(SERVER_TARGETS).join('|')}> | --all`);
    if (SERVER_TARGETS[target].alpine && !nodePtyBinary) throw new Error(`${target} needs --node-pty-binary <pty.node compiled against musl>`);
    targets = [target];
  }
  if (signedHelperFile && all) throw new Error('--signed-browser-helper names one architecture\'s browser.exe, so it needs --target');
  const signedBrowserHelper = signedHelperFile ? readFileSync(signedHelperFile) : undefined;
  const pinned = option('--node-version');
  const nodeVersion = pinned ?? serverNodeVersion();
  if (!NODE_RELEASES[nodeVersion]) throw new Error(`Node ${nodeVersion} has no pinned archives in scripts/server-targets.ts`);
  const distDir = await buildBundles();
  mkdirSync(OUT_DIR, { recursive: true });
  for (const name of targets) {
    const entries = await assemblePackage(name, { version, nodeVersion, distDir, nodePtyBinary, signedBrowserHelper });
    const archive = archiveOf(name, entries);
    const out = join(OUT_DIR, serverArtifact(name, version));
    writeFileSync(out, archive);
    const packageFile = entries.at(-1);
    if (packageFile === undefined) throw new Error(`The ${name} package has no ${SERVER_PACKAGE_FILE}`);
    console.log(`${out}: server ${(JSON.parse(packageFile.data.toString('utf8')) as { serverVersion: string }).serverVersion}, ${entries.length} files, ${archive.length} bytes, sha256 ${sha256(archive)}`);
    if (SERVER_TARGETS[name].alpine && nodePtyBinary) console.log(`node-pty for ${name}: sha256 ${sha256(readFileSync(nodePtyBinary))}`);
  }
  const built = Object.keys(SERVER_TARGETS).filter((name) => existsSync(join(OUT_DIR, serverArtifact(name, version))));
  writeManifest(OUT_DIR, version, built, false);
}

if (isEntryPoint(import.meta.url)) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
