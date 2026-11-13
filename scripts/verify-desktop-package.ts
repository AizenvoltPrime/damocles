import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, posix, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FuseState, FuseV1Options, getCurrentFuseWire } from '@electron/fuses';
import { CREDENTIAL_RELAY_SCRIPTS } from '../esbuild.config.ts';
import { ASAR_UNPACK, asarUnpackFor } from '../src/desktop/main/platform/unpacked-assets.ts';
import { parseServerManifest } from '../src/desktop/main/remote/server-manifest-format.ts';
import { asarFiles, readAsarFile, readAsarHeader, type AsarFileEntry } from './asar-archive.ts';
import { serverManifest, type ManifestPackage, type ServerManifest } from './build-server.ts';
import { isEntryPoint } from './entry-point.ts';
import { SERVER_TARGETS } from './server-targets.ts';

// Checks one electron-builder output (the unpacked app directory, or the .app on macOS) for everything the
// packaged desktop app loads from disk, and reads the fuse wire back from its binary.

const USAGE = `Usage: node scripts/verify-desktop-package.ts --platform <win32|darwin|linux> --arch <x64|arm64> --app <dir or .app> [--server-packages <dir>]

  --app              win32: dist-desktop/win-unpacked (or win-arm64-unpacked); linux: dist-desktop/linux-unpacked
                     (or linux-arm64-unpacked); darwin: dist-desktop/mac-arm64/Damocles.app
  --server-packages  the release's eight server packages, which the app's server manifest must name exactly`;

export type PackagePlatform = 'win32' | 'darwin' | 'linux';
export type PackageArch = 'x64' | 'arm64';

export interface CheckResult {
  check: string;
  ok: boolean;
  detail: string;
}

/** A fuse wire as getCurrentFuseWire reads it: the wire version and the FuseState byte at each fuse index. */
export interface FuseWire {
  version: string;
  [index: number]: number | undefined;
}

/** The part of an asar header entry the core host and daemon checks read. */
export interface PackedEntry {
  path: string;
  entry: Pick<AsarFileEntry, 'unpacked'>;
}

// Must equal electronFuses in electron-builder.yml; see docs/invariants.md "Desktop packaging and updates". Every other fuse the wire carries is reported, and one this script does not know fails.
export const EXPECTED_FUSES: Record<string, boolean> = {
  RunAsNode: true,
  EnableCookieEncryption: true,
  EnableNodeOptionsEnvironmentVariable: false,
  EnableNodeCliInspectArguments: false,
  EnableEmbeddedAsarIntegrityValidation: true,
  OnlyLoadAppFromAsar: true,
  GrantFileProtocolExtraPrivileges: false,
};
export const REPORTED_FUSES: string[] = ['LoadBrowserProcessSpecificV8Snapshot', 'WasmTrapHandlers'];

const PUBLISH = { provider: 'github', owner: 'AizenvoltPrime', repo: 'damocles' };
// Must equal win.signtoolOptions.publisherName in electron-builder.yml: the common name of the SignPath Foundation release certificate.
export const WINDOWS_PUBLISHER = 'SignPath Foundation';
// Every bundled script ASAR_UNPACK lists: the worker threads (the process launcher's among them), the shell sentinel, the
// formatter and pty hosts, the Quick Open and watch workers, and the askpass helper git and ssh start.
export const WORKERS = ASAR_UNPACK.filter((glob) => /^dist\/[^/*]+\.js$/.test(glob)).map((glob) => glob.slice('dist/'.length));
// The license notices electron-builder.yml ships inside app.asar (files) and beside it (extraResources).
const PACKED_NOTICES = ['LICENSE', 'THIRD-PARTY-NOTICES.md'];
const RESOURCE_NOTICES = ['monaco-editor-ThirdPartyNotices.txt'];
// Damocles Core's bundle: utilityProcess.fork loads it from inside app.asar, so it stays under asar integrity (coreHostEntryPath).
export const CORE_HOST_BUNDLE = 'dist/core-host.js';
// The loopback daemon is dev and e2e only: electron-builder never lists it.
export const DAEMON_BUNDLE = 'dist/daemon.js';
// Settings › About's What's new reads it (src/desktop/main/release-notes.ts); the desktop build copies it from the repo root.
const PACKED_CHANGELOG = 'dist/desktop/CHANGELOG.md';
// readServerManifest reads it beside main.js; package-desktop writes it from the release's server packages
export const PACKED_SERVER_MANIFEST = 'dist/desktop/server-manifest.json';
const LINUX_INSTALL_BINARY = '/opt/Damocles/damocles';
// Packages and paths that must never ship inside app.asar: sources, tests, build tooling and desktop-irrelevant bundles.
const FORBIDDEN_ASAR_PREFIXES = [
  'src/',
  'e2e/',
  'scripts/',
  'dist/extension.cjs',
  'dist/e2e',
  'node_modules/electron/',
  'node_modules/electron-builder/',
  'node_modules/@electron/fuses/',
  'node_modules/@playwright/test/',
  'node_modules/playwright/',
  'node_modules/vitest/',
  'node_modules/monaco-editor/',
  'node_modules/esbuild/',
  'node_modules/@esbuild/',
  'node_modules/typescript/',
  'node_modules/vite/',
];
const PYTHON_JUNK = /(^|\/)(\.venv|__pycache__|\.pytest_cache|tests|[^/]+\.egg-info)(\/|$)|\.pyc$/;

const pass = (check: string, detail: string): CheckResult => ({ check, ok: true, detail });
const fail = (check: string, detail: string): CheckResult => ({ check, ok: false, detail });

/** Where the binary, the fuse-bearing file and the resources directory sit for each platform's electron-builder output. */
export function layoutFor(platform: PackagePlatform, app: string): { binary: string; fuseTarget: string; resources: string } {
  if (platform === 'darwin') {
    return { binary: join(app, 'Contents', 'MacOS', 'Damocles'), fuseTarget: app, resources: join(app, 'Contents', 'Resources') };
  }
  const binary = join(app, platform === 'win32' ? 'Damocles.exe' : 'damocles');
  return { binary, fuseTarget: binary, resources: join(app, 'resources') };
}

/** Compares a fuse wire (as getCurrentFuseWire returns it) with EXPECTED_FUSES. */
export function checkFuses(wire: FuseWire): CheckResult[] {
  const results: CheckResult[] = [];
  if (wire.version !== '1') return [fail('fuses', `fuse wire version ${wire.version}; this check knows version 1 only`)];
  const seen = new Set<string>();
  const indexes = Object.keys(wire).filter((key) => key !== 'version').map(Number).sort((a, b) => a - b);
  for (const index of indexes) {
    const name = FuseV1Options[index];
    const state = wire[index];
    const label = state === FuseState.ENABLE ? 'Enabled' : state === FuseState.DISABLE ? 'Disabled' : state === FuseState.REMOVED ? 'Removed' : `unknown state ${state}`;
    if (name === undefined) {
      results.push(fail(`fuse #${index}`, `${label}; not a fuse @electron/fuses knows, review it before shipping`));
      continue;
    }
    seen.add(name);
    if (Object.hasOwn(EXPECTED_FUSES, name)) {
      const expected = EXPECTED_FUSES[name] ? FuseState.ENABLE : FuseState.DISABLE;
      const expectedLabel = EXPECTED_FUSES[name] ? 'Enabled' : 'Disabled';
      results.push(state === expected ? pass(`fuse ${name}`, label) : fail(`fuse ${name}`, `${label}, expected ${expectedLabel}`));
    } else if (REPORTED_FUSES.includes(name)) {
      results.push(pass(`fuse ${name}`, `${label} (Electron default, not set by electron-builder.yml)`));
    } else {
      results.push(fail(`fuse ${name}`, `${label}; not in EXPECTED_FUSES or REPORTED_FUSES, review it before shipping`));
    }
  }
  for (const name of Object.keys(EXPECTED_FUSES)) {
    if (!seen.has(name)) results.push(fail(`fuse ${name}`, 'missing from the binary fuse wire'));
  }
  return results;
}

/** Every file under app.asar.unpacked matches one of `patterns` (the platform's ASAR_UNPACK globs, asarUnpackFor), and every pattern matches a file. */
export function checkUnpackedSet(files: string[], patterns: readonly string[]): CheckResult[] {
  const outside = files.filter((file) => !patterns.some((pattern) => posix.matchesGlob(file, pattern)));
  const unused = patterns.filter((pattern) => !files.some((file) => posix.matchesGlob(file, pattern)));
  return [
    outside.length === 0 ? pass('unpacked set', `${files.length} files, all within ASAR_UNPACK`) : fail('unpacked set', `outside ASAR_UNPACK: ${outside.slice(0, 10).join(', ')}`),
    unused.length === 0 ? pass('unpacked globs', `${patterns.length} globs, each matches a file`) : fail('unpacked globs', `match nothing: ${unused.join(', ')}`),
  ];
}

/** The unpacked bundles' dist/package.json declares them CommonJS, so no package.json above the install folder sets their type. */
export function checkDistScope(file: string): CheckResult {
  if (!existsSync(file)) return fail('dist scope', `${file} is missing`);
  const { type } = JSON.parse(readFileSync(file, 'utf8')) as { type?: string };
  return type === 'commonjs' ? pass('dist scope', 'dist/package.json declares type commonjs') : fail('dist scope', `dist/package.json declares type ${type ?? 'none'}, not commonjs`);
}

/** The flat `key: value` lines of an electron-builder app-update.yml, and the `- item` list under an empty key (Windows publisherName). */
export function parseFlatYaml(text: string): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  let list: string[] | undefined;
  for (const line of text.split(/\r?\n/)) {
    const item = /^\s+-\s+(.*)$/.exec(line);
    if (item && list !== undefined) {
      list.push(unquote(item[1]!));
      continue;
    }
    const match = /^([A-Za-z]+):\s*(.*)$/.exec(line);
    if (!match) continue;
    const value = match[2]!;
    list = value === '' ? [] : undefined;
    out[match[1]!] = list ?? unquote(value);
  }
  return out;
}

function unquote(value: string): string {
  return value.trim().replace(/^(['"])(.*)\1$/, '$2');
}

/** The update feed the installed app reads: the GitHub repo, and on Windows the per-arch channel the build flags set and the update publisher. */
export function checkAppUpdate(text: string | undefined, platform: PackagePlatform, arch: PackageArch): CheckResult[] {
  if (text === undefined) return [fail('app-update.yml', 'missing; the installed app would have no update feed')];
  const config = parseFlatYaml(text);
  const problems: string[] = [];
  for (const [key, value] of Object.entries(PUBLISH)) {
    if (config[key] !== value) problems.push(`${key} is ${config[key] ?? 'absent'}, expected ${value}`);
  }
  if (!config.updaterCacheDirName) problems.push('updaterCacheDirName is absent');
  const channel = platform === 'win32' ? `latest-${arch}` : undefined;
  if (config.channel !== channel) problems.push(`channel is ${config.channel ?? 'absent'}, expected ${channel ?? 'absent (the default feed)'}`);
  const publisher = platform === 'win32' ? [WINDOWS_PUBLISHER] : undefined;
  if (JSON.stringify(config.publisherName) !== JSON.stringify(publisher)) {
    problems.push(`publisherName is ${JSON.stringify(config.publisherName) ?? 'absent'}, expected ${JSON.stringify(publisher) ?? 'absent'}`);
  }
  return [problems.length === 0 ? pass('app-update.yml', Object.entries(config).map(([k, v]) => `${k}=${v}`).join(' ')) : fail('app-update.yml', problems.join('; '))];
}

/** The packed CHANGELOG.md is the repo's, and has the section the release-notes job would publish. */
export function checkChangelog(packed: string | undefined, repo: string, version: string, tagged?: boolean): CheckResult[] {
  if (packed === undefined) return [fail('changelog', `${PACKED_CHANGELOG} is not in app.asar`)];
  // Same section choice as release.yml's "Extract changelog section": a tag run takes the version's, any other run
  // [Unreleased] while the changelog has it. That section's body, up to the next "## " heading, is the release notes.
  const lines = packed.split(/\r?\n/);
  const label = !tagged && lines.some((line) => line.startsWith('## [Unreleased]')) ? 'Unreleased' : version;
  const heading = lines.findIndex((line) => line.startsWith(label === 'Unreleased' ? '## [Unreleased]' : `## [${version}] - `));
  const next = lines.findIndex((line, index) => index > heading && line.startsWith('## '));
  const body = lines.slice(heading + 1, next === -1 ? undefined : next);
  const problems = [
    ...(packed === repo ? [] : ["differs from the repo's CHANGELOG.md"]),
    ...(heading === -1 ? [`has no ## [${label}] section`] : body.some((line) => line.trim() !== '') ? [] : [`has an empty ## [${label}] section`]),
  ];
  return [problems.length === 0 ? pass('changelog', `${PACKED_CHANGELOG} has the ${label} section`) : fail('changelog', problems.join('; '))];
}

const NODE_PTY = 'node_modules/node-pty';
// The native files node-pty 1.2 loads from prebuilds/<platform>-<arch>; electron-builder.yml keeps only the target's directory.
const NODE_PTY_BINARIES: Record<PackagePlatform, string[]> = {
  win32: ['conpty.node', 'conpty_console_list.node'],
  darwin: ['pty.node', 'spawn-helper'],
  linux: ['pty.node'],
};

/**
 * node-pty ships exactly the target's prebuild, unpacked, with no debug symbols or native sources, and its JS inside
 * app.asar, where its rewrite of the spawn-helper path to app.asar.unpacked holds. `paths` is every asar header entry.
 */
export function checkNodePtyLayout(platform: PackagePlatform, arch: PackageArch, paths: string[], unpackedFiles: string[]): CheckResult[] {
  const target = `${platform}-${arch}`;
  const prebuildDirs = [...new Set(paths.filter((path) => path.startsWith(`${NODE_PTY}/prebuilds/`)).map((path) => path.split('/')[3]))].sort();
  const missing = NODE_PTY_BINARIES[platform].filter((file) => !unpackedFiles.includes(`${NODE_PTY}/prebuilds/${target}/${file}`));
  const dropped = paths.filter((path) => path.startsWith(`${NODE_PTY}/`) && (path.endsWith('.pdb') || ['build', 'deps', 'src', 'third_party', 'scripts'].includes(path.split('/')[2]!)));
  const packedJs = ['package.json', 'lib/index.js'].map((file) => `${NODE_PTY}/${file}`).filter((path) => !paths.includes(path) || unpackedFiles.includes(path));
  return [
    prebuildDirs.length === 1 && prebuildDirs[0] === target ? pass('node-pty prebuild', `only prebuilds/${target}`) : fail('node-pty prebuild', `prebuild directories [${prebuildDirs.join(', ')}], expected only ${target}`),
    missing.length === 0 ? pass('node-pty binaries', NODE_PTY_BINARIES[platform].join(', ')) : fail('node-pty binaries', `missing from app.asar.unpacked: ${missing.join(', ')}`),
    dropped.length === 0 ? pass('node-pty trimmed', 'no .pdb, build, deps, src, third_party or scripts') : fail('node-pty trimmed', `must not ship: ${dropped.slice(0, 10).join(', ')}`),
    packedJs.length === 0 ? pass('node-pty loader', 'package.json and lib in app.asar') : fail('node-pty loader', `not packed in app.asar: ${packedJs.join(', ')}`),
  ];
}

/** node-pty 1.1.0 shipped spawn-helper without the execute bit; the macOS pty cannot start a shell without it. */
export function checkSpawnHelperMode(mode: number): CheckResult {
  const permissions = mode & 0o777;
  return permissions === 0o755 ? pass('node-pty spawn-helper mode', '0755') : fail('node-pty spawn-helper mode', `0${permissions.toString(8)}, expected 0755`);
}

/** `codesign -v` on one file; the ad hoc signed app's native binaries must each carry a valid signature. */
interface CodesignResult {
  ok: boolean;
  output: string;
}

function codesignVerify(file: string): CodesignResult {
  const run = spawnSync('codesign', ['-v', file], { encoding: 'utf8' });
  if (run.error) throw run.error;
  return { ok: run.status === 0, output: `${run.stdout}${run.stderr}`.trim() };
}

/** Paths inside app.asar that must not ship. */
export function checkAsarEntries(entries: string[]): CheckResult[] {
  const forbidden = entries.filter((entry) => FORBIDDEN_ASAR_PREFIXES.some((prefix) => entry.startsWith(prefix)) || entry.endsWith('.map'));
  return [forbidden.length === 0 ? pass('asar contents', `${entries.length} entries, no sources, tests, source maps or build tooling`) : fail('asar contents', `must not ship: ${forbidden.slice(0, 10).join(', ')}`)];
}

/** The core host bundle is packed inside app.asar and has no unpacked copy. */
export function checkCoreHost(entries: PackedEntry[], unpackedFiles: string[]): CheckResult[] {
  const entry = entries.find(({ path }) => path === CORE_HOST_BUNDLE);
  const problems = [
    ...(entry === undefined ? ['not in app.asar'] : []),
    ...(entry?.entry.unpacked ? ['marked unpacked in app.asar'] : []),
    ...(unpackedFiles.includes(CORE_HOST_BUNDLE) ? ['has a copy in app.asar.unpacked'] : []),
  ];
  return [problems.length === 0 ? pass('core host', `${CORE_HOST_BUNDLE} is inside app.asar only`) : fail('core host', problems.join('; '))];
}

/**
 * The packed server manifest parses as the app reads it, is for `version`, is published, so hosts download from the release,
 * and names exactly the packages of `expected` with their server versions.
 */
export function checkServerManifest(packed: string | undefined, version: string, expected: Pick<ServerManifest, 'protocolVersion' | 'packages'>): CheckResult[] {
  if (packed === undefined) return [fail('server manifest', `${PACKED_SERVER_MANIFEST} is not in app.asar`)];
  const manifest = parseServerManifest(JSON.parse(packed));
  if (manifest === undefined) return [fail('server manifest', `${PACKED_SERVER_MANIFEST} does not parse as the app reads it`)];
  const packages: Readonly<Partial<Record<string, ManifestPackage>>> = manifest.packages;
  const same = (a: ManifestPackage | undefined, b: ManifestPackage): boolean => a !== undefined && a.file === b.file && a.sha256 === b.sha256 && a.size === b.size && a.serverVersion === b.serverVersion;
  const problems = [
    ...(manifest.version === version ? [] : [`it is for ${manifest.version}, the app is ${version}`]),
    ...(manifest.published ? [] : ['it is unpublished, the dev manifest build-server.ts writes without --write-manifest']),
    ...(manifest.protocolVersion === expected.protocolVersion ? [] : [`it names protocol ${manifest.protocolVersion}, the build ${expected.protocolVersion}`]),
    ...Object.entries(expected.packages).filter(([target, pkg]) => !same(packages[target], pkg)).map(([target, pkg]) => `${target} is not ${pkg.file} with its SHA-256, size and server version ${pkg.serverVersion}`),
  ];
  return [problems.length === 0 ? pass('server manifest', `names the ${Object.keys(expected.packages).length} release packages`) : fail('server manifest', problems.join('; '))];
}

/** The loopback daemon ships neither in app.asar nor beside it. */
export function checkNoDaemon(entries: PackedEntry[], unpackedFiles: string[]): CheckResult[] {
  const found = [...entries.filter(({ path }) => path === DAEMON_BUNDLE).map(() => 'in app.asar'), ...(unpackedFiles.includes(DAEMON_BUNDLE) ? ['in app.asar.unpacked'] : [])];
  return [found.length === 0 ? pass('loopback daemon', `${DAEMON_BUNDLE} does not ship`) : fail('loopback daemon', `${DAEMON_BUNDLE} ships ${found.join(' and ')}`)];
}

function listFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => relative(dir, join(entry.parentPath, entry.name)).split(sep).join('/'))
    .sort();
}

const sha256 = (file: string): string => createHash('sha256').update(readFileSync(file)).digest('hex');

/** The packaged copy of every file in `sourceDir` (selected by `filter`) exists under `packagedDir` with identical bytes. */
function checkSameFiles(check: string, sourceDir: string, packagedDir: string, filter: (file: string) => boolean): CheckResult {
  const expected = listFiles(sourceDir).filter(filter);
  if (expected.length === 0) return fail(check, `${sourceDir} has none; fetch the build assets first (npm run build)`);
  const missing = expected.filter((file) => !existsSync(join(packagedDir, file)));
  const differ = expected.filter((file) => !missing.includes(file) && sha256(join(sourceDir, file)) !== sha256(join(packagedDir, file)));
  const extra = listFiles(packagedDir).filter(filter).filter((file) => !expected.includes(file));
  const problems = [
    ...(missing.length ? [`missing ${missing.join(', ')}`] : []),
    ...(differ.length ? [`differ from the repo: ${differ.join(', ')}`] : []),
    ...(extra.length ? [`not in the repo: ${extra.join(', ')}`] : []),
  ];
  return problems.length === 0 ? pass(check, `${expected.length} identical to the repo: ${expected.join(', ')}`) : fail(check, problems.join('; '));
}

// The wake directory's own package files, which the fetch script neither writes nor removes.
const WAKE_PACKAGE_FILES = new Set(['__init__.py', '.gitkeep']);

/** The packaged wake directory holds exactly the files the manifest's `wake_model` lists, each at its listed size and SHA-256. */
interface WakeModelFile {
  filename: string;
  bytes: number;
  sha256: string;
}

export function checkWakeModel(manifestPath: string, packagedDir: string): CheckResult {
  const check = 'wake model';
  if (!existsSync(manifestPath)) return fail(check, `${manifestPath} is missing`);
  const files = (JSON.parse(readFileSync(manifestPath, 'utf8')) as { wake_model?: { files?: WakeModelFile[] } }).wake_model?.files;
  if (!Array.isArray(files) || files.length === 0) return fail(check, `${manifestPath} lists no wake_model.files`);
  const listed = new Set(files.map((file) => file.filename));
  const missing = files.filter((file) => !existsSync(join(packagedDir, file.filename))).map((file) => file.filename);
  const differ = files
    .filter((file) => !missing.includes(file.filename))
    .filter((file) => statSync(join(packagedDir, file.filename)).size !== file.bytes || sha256(join(packagedDir, file.filename)) !== file.sha256)
    .map((file) => file.filename);
  const extra = listFiles(packagedDir).filter((file) => !listed.has(file) && !WAKE_PACKAGE_FILES.has(file));
  const problems = [
    ...(missing.length ? [`missing ${missing.join(', ')}`] : []),
    ...(differ.length ? [`differ from the manifest: ${differ.join(', ')}`] : []),
    ...(extra.length ? [`not in the manifest: ${extra.join(', ')}`] : []),
  ];
  return problems.length === 0 ? pass(check, `${files.length} files match the manifest: ${[...listed].join(', ')}`) : fail(check, problems.join('; '));
}

// needsExecBit follows the package's target; a Windows host reads no exec bits, so it cannot check one there.
function checkFile(check: string, file: string, { needsExecBit = false }: { needsExecBit?: boolean } = {}): CheckResult {
  if (!existsSync(file)) return fail(check, `${file} is missing`);
  const stat = statSync(file);
  if (!stat.isFile() || stat.size === 0) return fail(check, `${file} is empty or not a file`);
  if (needsExecBit && process.platform !== 'win32' && (stat.mode & 0o111) === 0) return fail(check, `${file} is not executable`);
  return pass(check, `${file} (${stat.size} bytes)`);
}

// The shell-integration scripts (src/desktop/main/terminal/shell-integration-injection.ts); bash, zsh and fish read a CR as
// part of a line, so theirs must be LF.
export const SHELL_INTEGRATION_FILES = [
  'shellIntegration.ps1',
  'shellIntegration-bash.sh',
  'shellIntegration.fish',
  'shellIntegration-env.zsh',
  'shellIntegration-profile.zsh',
  'shellIntegration-rc.zsh',
  'shellIntegration-login.zsh',
];

/** A file's bytes, or undefined when it is missing. */
type ReadFile = (file: string) => Buffer | undefined;
/** A file's mode, or undefined when it is missing. */
type StatFile = (file: string) => { mode: number } | undefined;

// The askpass scripts git and ssh execute (src/core/scm/askpass/askpass-server.ts): every .sh file in resources/askpass, which
// the desktop build copies with 0755.
export const ASKPASS_SCRIPTS = ['askpass.sh', 'ssh-askpass.sh'];

/** Windows ssh's SSH_ASKPASS (scripts/askpass-trampoline.ts): a PE executable, since a .cmd would run through cmd.exe. */
export function checkAskpassTrampoline(bytes: Buffer | undefined): CheckResult {
  if (bytes === undefined || bytes.length === 0) return fail('askpass trampoline', 'dist/askpass/ssh-askpass.exe is missing');
  return bytes[0] === 0x4d && bytes[1] === 0x5a ? pass('askpass trampoline', `ssh-askpass.exe (${bytes.length} bytes)`) : fail('askpass trampoline', 'ssh-askpass.exe is not a PE executable');
}

/**
 * Each askpass script exists, holds no CR (sh reads it as part of a line) and is exactly
 * 0755 where the file system keeps modes; `read` and `stat` answer undefined for a missing file.
 */
export function checkAskpassScripts(read: ReadFile, stat: StatFile, keepsModes: boolean): CheckResult[] {
  const missing = ASKPASS_SCRIPTS.filter((file) => (read(file)?.length ?? 0) === 0);
  const crlf = ASKPASS_SCRIPTS.filter((file) => read(file)?.includes(0x0d));
  const modes = !keepsModes ? [] : ASKPASS_SCRIPTS.flatMap((file) => {
    const mode = stat(file)?.mode;
    return mode !== undefined && (mode & 0o777) !== 0o755 ? [`${file} 0${(mode & 0o777).toString(8)}`] : [];
  });
  return [
    missing.length === 0 ? pass('askpass scripts', ASKPASS_SCRIPTS.join(', ')) : fail('askpass scripts', `missing or empty: ${missing.join(', ')}`),
    crlf.length === 0 ? pass('askpass line endings', 'LF') : fail('askpass line endings', `CR in ${crlf.join(', ')}`),
    !keepsModes
      ? pass('askpass mode', 'not kept on a Windows file system')
      : modes.length === 0 ? pass('askpass mode', '0755') : fail('askpass mode', `${modes.join(', ')}, expected 0755`),
  ];
}

/**
 * The credential helper scripts unpacked from app.asar: the .sh is an LF sh script, exactly 0755 where the file system keeps
 * modes; the .cmd is CRLF and turns delayed expansion off. `read` and `stat` answer undefined for a missing file.
 */
export function checkCredentialHelperScripts(read: ReadFile, stat: StatFile, keepsModes: boolean): CheckResult[] {
  const sh = read('git-credential-relay.sh');
  const cmd = read('git-credential-relay.cmd');
  const mode = stat('git-credential-relay.sh')?.mode;
  return [
    sh === undefined || sh.length === 0 ? fail('credential helper', 'dist/git-credential/git-credential-relay.sh is missing or empty')
      : sh.includes(0x0d) || !sh.toString('utf8').startsWith('#!/bin/sh\n') ? fail('credential helper', 'dist/git-credential/git-credential-relay.sh is not an LF sh script')
        : pass('credential helper', 'git-credential-relay.sh, LF'),
    cmd === undefined || cmd.length === 0 ? fail('credential helper .cmd', 'dist/git-credential/git-credential-relay.cmd is missing or empty')
      : /(?<!\r)\n/.test(cmd.toString('utf8')) ? fail('credential helper .cmd', 'dist/git-credential/git-credential-relay.cmd is not a CRLF batch file')
        // a registry DelayedExpansion=1 would eat a ! in the paths
        : !/^setlocal DisableDelayedExpansion\r$/im.test(cmd.toString('utf8')) ? fail('credential helper .cmd', 'dist/git-credential/git-credential-relay.cmd does not turn delayed expansion off')
          : pass('credential helper .cmd', 'CRLF, delayed expansion off'),
    !keepsModes ? pass('credential helper mode', 'not kept on a Windows file system')
      : mode !== undefined && (mode & 0o777) === 0o755 ? pass('credential helper mode', '0755') : fail('credential helper mode', `0${((mode ?? 0) & 0o777).toString(8)}, expected 0755`),
  ];
}

/**
 * The damocles command beside app.asar (resources/bin): the sh script, which macOS, Linux and WSL shells run, exists, is LF
 * and 0755 where the file system keeps modes; damocles.cmd, which cmd.exe runs, is CRLF and turns delayed expansion off.
 * `read` and `stat` answer undefined for a missing file.
 */
export function checkCliScripts(read: ReadFile, stat: StatFile, keepsModes: boolean): CheckResult[] {
  const sh = read('damocles');
  const cmd = read('damocles.cmd');
  const mode = stat('damocles')?.mode;
  return [
    sh === undefined || sh.length === 0 ? fail('damocles command', 'resources/bin/damocles is missing or empty')
      : sh.includes(0x0d) || !sh.toString('utf8').startsWith('#!/bin/sh\n') ? fail('damocles command', 'resources/bin/damocles is not an LF sh script')
        : pass('damocles command', 'resources/bin/damocles, LF'),
    cmd === undefined || cmd.length === 0 ? fail('damocles.cmd', 'resources/bin/damocles.cmd is missing or empty')
      : /(?<!\r)\n/.test(cmd.toString('utf8')) ? fail('damocles.cmd', 'resources/bin/damocles.cmd is not a CRLF batch file')
        // a registry DelayedExpansion=1 would eat a ! in the arguments
        : !/^setlocal DisableDelayedExpansion\r$/im.test(cmd.toString('utf8')) ? fail('damocles.cmd', 'resources/bin/damocles.cmd does not turn delayed expansion off')
          : pass('damocles.cmd', 'CRLF, delayed expansion off'),
    !keepsModes ? pass('damocles command mode', 'not kept on a Windows file system')
      : mode !== undefined && (mode & 0o777) === 0o755 ? pass('damocles command mode', '0755') : fail('damocles command mode', `0${((mode ?? 0) & 0o777).toString(8)}, expected 0755`),
  ];
}

/** Each script exists and is not empty, and none but the PowerShell one holds a CR; `read` answers undefined for a missing file. */
export function checkShellIntegrationScripts(read: ReadFile): CheckResult[] {
  const missing = SHELL_INTEGRATION_FILES.filter((file) => (read(file)?.length ?? 0) === 0);
  const crlf = SHELL_INTEGRATION_FILES.filter((file) => !file.endsWith('.ps1') && read(file)?.includes(0x0d));
  return [
    missing.length === 0 ? pass('shell integration scripts', SHELL_INTEGRATION_FILES.join(', ')) : fail('shell integration scripts', `missing or empty: ${missing.join(', ')}`),
    crlf.length === 0 ? pass('shell integration line endings', 'bash, zsh and fish scripts are LF') : fail('shell integration line endings', `CR in ${crlf.join(', ')}`),
  ];
}

function watcherPackage(platform: PackagePlatform, arch: PackageArch): string {
  return `@parcel/watcher-${platform}-${arch}${platform === 'linux' ? '-glibc' : ''}`;
}

/**
 * Runs every check on one packaged app; `readFuseWire` defaults to @electron/fuses reading the binary. With `serverPackages`,
 * the folder of the release's server packages, the app's server manifest must name them.
 */
export interface VerifyOptions {
  platform: PackagePlatform;
  arch: PackageArch;
  app: string;
  repoRoot: string;
  serverPackages?: string;
  readFuseWire?: (fuseTarget: string) => Promise<FuseWire>;
  codesign?: (file: string) => CodesignResult;
}

export async function verifyPackage({ platform, arch, app, repoRoot, serverPackages, readFuseWire = getCurrentFuseWire, codesign = codesignVerify }: VerifyOptions): Promise<CheckResult[]> {
  const { binary, fuseTarget, resources } = layoutFor(platform, app);
  const asarPath = join(resources, 'app.asar');
  const unpacked = join(resources, 'app.asar.unpacked');
  const needsExecBit = platform !== 'win32';
  const results: CheckResult[] = [checkFile('binary', binary, { needsExecBit }), checkFile('app.asar', asarPath)];
  if (!results.every((result) => result.ok)) return results;

  const { header, dataOffset } = readAsarHeader(asarPath);
  const entries = asarFiles(header);
  const packedPaths = entries.filter(({ entry }) => !entry.unpacked).map(({ path }) => path);
  results.push(...checkAsarEntries(packedPaths));
  const manifestEntry = entries.find(({ path }) => path === 'package.json');
  const repoVersion = (JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as { version: string }).version;
  if (manifestEntry === undefined) {
    results.push(fail('package.json', 'not in app.asar'));
  } else {
    const manifest = JSON.parse(readAsarFile(asarPath, dataOffset, manifestEntry.entry)) as { main?: string; type?: string; version?: string; devDependencies?: unknown };
    const problems = [
      ...(manifest.main === 'dist/desktop/main.js' ? [] : [`main is ${manifest.main}, expected dist/desktop/main.js`]),
      ...(manifest.type === 'commonjs' ? [] : [`type is ${manifest.type ?? 'unset'}, expected commonjs`]),
      ...(manifest.version === repoVersion ? [] : [`version ${manifest.version} differs from the repo's ${repoVersion}`]),
      ...(manifest.devDependencies === undefined ? [] : ['carries devDependencies']),
    ];
    results.push(problems.length === 0 ? pass('package.json', `main=${manifest.main} version=${manifest.version}`) : fail('package.json', problems.join('; ')));
  }

  for (const notice of PACKED_NOTICES) {
    results.push(packedPaths.includes(notice) ? pass(`notice ${notice}`, 'in app.asar') : fail(`notice ${notice}`, 'not in app.asar'));
  }
  for (const notice of RESOURCE_NOTICES) results.push(checkFile(`notice ${notice}`, join(resources, notice)));
  const changelogEntry = entries.find(({ path, entry }) => path === PACKED_CHANGELOG && !entry.unpacked);
  const packedChangelog = changelogEntry === undefined ? undefined : readAsarFile(asarPath, dataOffset, changelogEntry.entry);
  results.push(...checkChangelog(packedChangelog, readFileSync(join(repoRoot, 'CHANGELOG.md'), 'utf8'), repoVersion, process.env.GITHUB_REF_TYPE === 'tag'));
  if (serverPackages !== undefined) {
    const manifestFile = entries.find(({ path, entry }) => path === PACKED_SERVER_MANIFEST && !entry.unpacked);
    const packed = manifestFile === undefined ? undefined : readAsarFile(asarPath, dataOffset, manifestFile.entry);
    results.push(...checkServerManifest(packed, repoVersion, serverManifest(serverPackages, repoVersion, Object.keys(SERVER_TARGETS), { published: true })));
  }

  const unpackedFiles = listFiles(unpacked);
  results.push(...checkUnpackedSet(unpackedFiles, asarUnpackFor(platform)));
  results.push(...checkCoreHost(entries, unpackedFiles));
  results.push(...checkNoDaemon(entries, unpackedFiles));
  const unpackedScripts = unpackedFiles.filter((file) => /\.(c|m)?js$/.test(file));
  results.push(pass('unpacked scripts (outside asar integrity)', unpackedScripts.join(', ')));

  const rgBinary = platform === 'win32' ? 'rg.exe' : 'rg';
  results.push(checkFile('ripgrep', join(unpacked, 'node_modules', '@vscode', `ripgrep-${platform}-${arch}`, 'bin', rgBinary), { needsExecBit }));
  for (const worker of WORKERS) results.push(checkFile(`worker ${worker}`, join(unpacked, 'dist', worker)));
  results.push(checkDistScope(join(unpacked, 'dist', 'package.json')));
  results.push(checkFile('web-tree-sitter (compass worker external)', join(unpacked, 'node_modules', 'web-tree-sitter', 'tree-sitter.wasm')));
  results.push(checkSameFiles('grammars', join(repoRoot, 'resources', 'grammars'), join(unpacked, 'resources', 'grammars'), (file) => file.endsWith('.wasm')));
  const shellIntegration = join(unpacked, 'resources', 'shell-integration');
  results.push(...checkShellIntegrationScripts((file) => (existsSync(join(shellIntegration, file)) ? readFileSync(join(shellIntegration, file)) : undefined)));
  const askpass = join(unpacked, 'dist', 'askpass');
  results.push(...checkAskpassScripts(
    (file) => (existsSync(join(askpass, file)) ? readFileSync(join(askpass, file)) : undefined),
    (file) => (existsSync(join(askpass, file)) ? statSync(join(askpass, file)) : undefined),
    process.platform !== 'win32',
  ));
  results.push(checkSameFiles('askpass script contents', join(repoRoot, 'resources', 'askpass'), askpass, (file) => file.endsWith('.sh')));
  const credentialHelper = join(unpacked, 'dist', 'git-credential');
  results.push(...checkCredentialHelperScripts(
    (file) => (existsSync(join(credentialHelper, file)) ? readFileSync(join(credentialHelper, file)) : undefined),
    (file) => (existsSync(join(credentialHelper, file)) ? statSync(join(credentialHelper, file)) : undefined),
    process.platform !== 'win32',
  ));
  results.push(checkSameFiles('credential helper contents', join(repoRoot, 'resources', 'git-credential'), credentialHelper, (file) => CREDENTIAL_RELAY_SCRIPTS.includes(file)));
  const bin = join(resources, 'bin');
  results.push(...checkCliScripts(
    (file) => (existsSync(join(bin, file)) ? readFileSync(join(bin, file)) : undefined),
    (file) => (existsSync(join(bin, file)) ? statSync(join(bin, file)) : undefined),
    process.platform !== 'win32',
  ));
  if (platform === 'win32') results.push(checkAskpassTrampoline(existsSync(join(askpass, 'ssh-askpass.exe')) ? readFileSync(join(askpass, 'ssh-askpass.exe')) : undefined));

  const sidecar = join(unpacked, 'python', 'damocles_voice_sidecar', 'damocles_voice_sidecar');
  results.push(checkFile('python sidecar entry', join(sidecar, '__main__.py')));
  results.push(checkFile('python model manifest', join(sidecar, 'models', 'MODEL_MANIFEST.json')));
  results.push(checkWakeModel(join(repoRoot, 'python', 'damocles_voice_sidecar', 'damocles_voice_sidecar', 'models', 'MODEL_MANIFEST.json'), join(sidecar, 'models', 'wake')));
  const pythonJunk = listFiles(join(unpacked, 'python')).filter((file) => PYTHON_JUNK.test(file));
  results.push(pythonJunk.length === 0 ? pass('python package clean', 'no venvs, caches or tests') : fail('python package clean', pythonJunk.slice(0, 10).join(', ')));

  if (platform === 'win32') {
    const triplet = `win32_${arch}`;
    results.push(checkFile('koffi native', join(unpacked, 'node_modules', '@koromix', `koffi-win32-${arch}`, triplet, 'koffi.node')));
    // the launcher worker runs from app.asar.unpacked, so it requires koffi from there
    results.push(checkFile('koffi loader', join(unpacked, 'node_modules', 'koffi', 'package.json')));
  }
  if (platform === 'win32') {
    // Windows watches with fs.watch and never loads @parcel/watcher; electron-builder.yml files leaves out its prebuild.
    const prebuild = [...entries.map(({ path }) => path), ...unpackedFiles].filter((file) => file.startsWith('node_modules/@parcel/watcher-'));
    results.push(prebuild.length === 0 ? pass('@parcel/watcher prebuild left out', 'nothing on Windows loads it') : fail('@parcel/watcher prebuild left out', `ships ${[...new Set(prebuild)].slice(0, 10).join(', ')}`));
  } else {
    results.push(checkFile('@parcel/watcher native', join(unpacked, 'node_modules', watcherPackage(platform, arch), 'watcher.node')));
  }
  results.push(...checkNodePtyLayout(platform, arch, [...new Set([...entries.map(({ path }) => path), ...unpackedFiles])], unpackedFiles));
  if (platform === 'darwin') {
    const prebuild = join(unpacked, ...NODE_PTY.split('/'), 'prebuilds', `${platform}-${arch}`);
    const spawnHelper = join(prebuild, 'spawn-helper');
    // A Windows host reads no exec bits; macOS packages are built and verified on macOS.
    if (existsSync(spawnHelper) && process.platform !== 'win32') results.push(checkSpawnHelperMode(statSync(spawnHelper).mode));
    for (const binary of NODE_PTY_BINARIES.darwin) {
      const file = join(prebuild, binary);
      if (!existsSync(file)) continue;
      const { ok, output } = codesign(file);
      results.push(ok ? pass(`node-pty codesign ${binary}`, 'codesign -v passes') : fail(`node-pty codesign ${binary}`, output));
    }
  }

  const appUpdate = join(resources, 'app-update.yml');
  results.push(...checkAppUpdate(existsSync(appUpdate) ? readFileSync(appUpdate, 'utf8') : undefined, platform, arch));
  if (platform === 'linux') {
    results.push(checkFile('chrome-sandbox', join(app, 'chrome-sandbox')));
    results.push(checkFile('package-type', join(resources, 'package-type')));
    const profilePath = join(resources, 'apparmor-profile');
    if (!existsSync(profilePath)) {
      results.push(fail('apparmor-profile', `${profilePath} is missing; build the deb/rpm targets, not --dir`));
    } else {
      const profile = readFileSync(profilePath, 'utf8');
      const ok = profile.includes(`profile damocles ${LINUX_INSTALL_BINARY} flags=(unconfined)`) && /^\s*userns,\s*$/m.test(profile) && !/\$\{[A-Za-z]+\}/.test(profile);
      results.push(ok ? pass('apparmor-profile', `grants userns to ${LINUX_INSTALL_BINARY} only`) : fail('apparmor-profile', `does not grant userns to exactly ${LINUX_INSTALL_BINARY}:\n${profile}`));
    }
  }

  results.push(...checkFuses(await readFuseWire(fuseTarget)));
  return results;
}

function readArg(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(`--${name}`);
  const value = index === -1 ? undefined : argv[index + 1];
  return value === undefined || value.startsWith('--') ? undefined : value;
}

const isPlatform = (value: string | undefined): value is PackagePlatform => value === 'win32' || value === 'darwin' || value === 'linux';
const isArch = (value: string | undefined): value is PackageArch => value === 'x64' || value === 'arm64';

async function main(argv: string[]): Promise<number> {
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(USAGE);
    return 0;
  }
  const platform = readArg(argv, 'platform');
  const arch = readArg(argv, 'arch');
  const app = readArg(argv, 'app');
  if (!isPlatform(platform) || !isArch(arch) || app === undefined) {
    console.error(USAGE);
    return 2;
  }
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
  const serverPackages = readArg(argv, 'server-packages');
  const results = await verifyPackage({ platform, arch, app, repoRoot, ...(serverPackages !== undefined ? { serverPackages } : {}) });
  for (const result of results) console.log(`${result.ok ? 'PASS' : 'FAIL'}  ${result.check}  ${result.detail}`);
  const failed = results.filter((result) => !result.ok).length;
  console.log(failed === 0 ? `\nOK  ${platform}-${arch}  ${results.length} checks passed` : `\nFAILED  ${platform}-${arch}  ${failed} of ${results.length} checks failed`);
  return failed === 0 ? 0 : 1;
}

if (isEntryPoint(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2));
}
