import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, posix, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FuseState, FuseV1Options, getCurrentFuseWire } from '@electron/fuses';
import { asarUnpackFor } from '../src/desktop/main/platform/unpacked-assets.ts';
import { asarFiles, readAsarFile, readAsarHeader } from './asar-archive.mjs';
import { isEntryPoint } from './entry-point.mjs';

// Checks one electron-builder output (the unpacked app directory, or the .app on macOS) for everything the
// packaged desktop app loads from disk, and reads the fuse wire back from its binary.

const USAGE = `Usage: node scripts/verify-desktop-package.mjs --platform <win32|darwin|linux> --arch <x64|arm64> --app <dir or .app>

  --app   win32: dist-desktop/win-unpacked (or win-arm64-unpacked); linux: dist-desktop/linux-unpacked
          (or linux-arm64-unpacked); darwin: dist-desktop/mac-arm64/Damocles.app`;

// Must equal electronFuses in electron-builder.yml; see docs/invariants.md "Desktop packaging and updates". Every other fuse the wire carries is reported, and one this script does not know fails.
export const EXPECTED_FUSES = {
  RunAsNode: true,
  EnableCookieEncryption: true,
  EnableNodeOptionsEnvironmentVariable: false,
  EnableNodeCliInspectArguments: false,
  EnableEmbeddedAsarIntegrityValidation: true,
  OnlyLoadAppFromAsar: true,
  GrantFileProtocolExtraPrivileges: false,
};
export const REPORTED_FUSES = ['LoadBrowserProcessSpecificV8Snapshot', 'WasmTrapHandlers'];

const PUBLISH = { provider: 'github', owner: 'AizenvoltPrime', repo: 'damocles' };
// The scripts main runs in another process or thread: the worker threads, the shell sentinel, the formatter host and the pty host.
const WORKERS = ['compass-worker.js', 'usage-stats-worker.js', 'quick-open-worker.js', 'watch-worker.js', 'sentinel.js', 'formatter-host.js', 'pty-host.js'];
// The license notices electron-builder.yml ships inside app.asar (files) and beside it (extraResources).
const PACKED_NOTICES = ['LICENSE', 'THIRD-PARTY-NOTICES.md'];
const RESOURCE_NOTICES = ['monaco-editor-ThirdPartyNotices.txt'];
// Settings › About's What's new reads it (src/desktop/main/release-notes.ts); the desktop build copies it from the repo root.
const PACKED_CHANGELOG = 'dist/desktop/CHANGELOG.md';
const LINUX_INSTALL_BINARY = '/opt/Damocles/damocles';
// Packages and paths that must never ship inside app.asar: sources, tests, build tooling and desktop-irrelevant bundles.
const FORBIDDEN_ASAR_PREFIXES = [
  'src/',
  'e2e/',
  'scripts/',
  'dist/extension.js',
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

const pass = (check, detail) => ({ check, ok: true, detail });
const fail = (check, detail) => ({ check, ok: false, detail });

/** Where the binary, the fuse-bearing file and the resources directory sit for each platform's electron-builder output. */
export function layoutFor(platform, app) {
  if (platform === 'darwin') {
    return { binary: join(app, 'Contents', 'MacOS', 'Damocles'), fuseTarget: app, resources: join(app, 'Contents', 'Resources') };
  }
  const binary = join(app, platform === 'win32' ? 'Damocles.exe' : 'damocles');
  return { binary, fuseTarget: binary, resources: join(app, 'resources') };
}

/** Compares a fuse wire (as getCurrentFuseWire returns it) with EXPECTED_FUSES. */
export function checkFuses(wire) {
  const results = [];
  if (wire.version !== '1') return [fail('fuses', `fuse wire version ${wire.version}; this check knows version 1 only`)];
  const seen = new Set();
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
export function checkUnpackedSet(files, patterns) {
  const outside = files.filter((file) => !patterns.some((pattern) => posix.matchesGlob(file, pattern)));
  const unused = patterns.filter((pattern) => !files.some((file) => posix.matchesGlob(file, pattern)));
  return [
    outside.length === 0 ? pass('unpacked set', `${files.length} files, all within ASAR_UNPACK`) : fail('unpacked set', `outside ASAR_UNPACK: ${outside.slice(0, 10).join(', ')}`),
    unused.length === 0 ? pass('unpacked globs', `${patterns.length} globs, each matches a file`) : fail('unpacked globs', `match nothing: ${unused.join(', ')}`),
  ];
}

/** The flat `key: value` lines of an electron-builder app-update.yml. */
export function parseFlatYaml(text) {
  const out = {};
  for (const line of text.split(/\r?\n/)) {
    const match = /^([A-Za-z]+):\s*(.*)$/.exec(line);
    if (match) out[match[1]] = match[2].replace(/^(['"])(.*)\1$/, '$2');
  }
  return out;
}

/** The update feed the installed app reads: the GitHub repo, and on Windows the per-arch channel the build flags set. */
export function checkAppUpdate(text, platform, arch) {
  if (text === undefined) return [fail('app-update.yml', 'missing; the installed app would have no update feed')];
  const config = parseFlatYaml(text);
  const problems = [];
  for (const [key, value] of Object.entries(PUBLISH)) {
    if (config[key] !== value) problems.push(`${key} is ${config[key] ?? 'absent'}, expected ${value}`);
  }
  if (!config.updaterCacheDirName) problems.push('updaterCacheDirName is absent');
  const channel = platform === 'win32' ? `latest-${arch}` : undefined;
  if (config.channel !== channel) problems.push(`channel is ${config.channel ?? 'absent'}, expected ${channel ?? 'absent (the default feed)'}`);
  return [problems.length === 0 ? pass('app-update.yml', Object.entries(config).map(([k, v]) => `${k}=${v}`).join(' ')) : fail('app-update.yml', problems.join('; '))];
}

/** The packed CHANGELOG.md is the repo's, and has a section for the packaged version. */
export function checkChangelog(packed, repo, version) {
  if (packed === undefined) return [fail('changelog', `${PACKED_CHANGELOG} is not in app.asar`)];
  const problems = [
    ...(packed === repo ? [] : ["differs from the repo's CHANGELOG.md"]),
    ...(packed.split(/\r?\n/).some((line) => line.startsWith(`## [${version}] - `)) ? [] : [`has no ## [${version}] section`]),
  ];
  return [problems.length === 0 ? pass('changelog', `${PACKED_CHANGELOG} has the ${version} section`) : fail('changelog', problems.join('; '))];
}

const NODE_PTY = 'node_modules/node-pty';
// The native files node-pty 1.2 loads from prebuilds/<platform>-<arch>; electron-builder.yml keeps only the target's directory.
const NODE_PTY_BINARIES = {
  win32: ['conpty.node', 'conpty_console_list.node'],
  darwin: ['pty.node', 'spawn-helper'],
  linux: ['pty.node'],
};

/**
 * node-pty ships exactly the target's prebuild, unpacked, with no debug symbols or native sources, and its JS inside
 * app.asar, where its rewrite of the spawn-helper path to app.asar.unpacked holds. `paths` is every asar header entry.
 */
export function checkNodePtyLayout(platform, arch, paths, unpackedFiles) {
  const target = `${platform}-${arch}`;
  const prebuildDirs = [...new Set(paths.filter((path) => path.startsWith(`${NODE_PTY}/prebuilds/`)).map((path) => path.split('/')[3]))].sort();
  const missing = NODE_PTY_BINARIES[platform].filter((file) => !unpackedFiles.includes(`${NODE_PTY}/prebuilds/${target}/${file}`));
  const dropped = paths.filter((path) => path.startsWith(`${NODE_PTY}/`) && (path.endsWith('.pdb') || ['build', 'deps', 'src', 'third_party', 'scripts'].includes(path.split('/')[2])));
  const packedJs = ['package.json', 'lib/index.js'].map((file) => `${NODE_PTY}/${file}`).filter((path) => !paths.includes(path) || unpackedFiles.includes(path));
  return [
    prebuildDirs.length === 1 && prebuildDirs[0] === target ? pass('node-pty prebuild', `only prebuilds/${target}`) : fail('node-pty prebuild', `prebuild directories [${prebuildDirs.join(', ')}], expected only ${target}`),
    missing.length === 0 ? pass('node-pty binaries', NODE_PTY_BINARIES[platform].join(', ')) : fail('node-pty binaries', `missing from app.asar.unpacked: ${missing.join(', ')}`),
    dropped.length === 0 ? pass('node-pty trimmed', 'no .pdb, build, deps, src, third_party or scripts') : fail('node-pty trimmed', `must not ship: ${dropped.slice(0, 10).join(', ')}`),
    packedJs.length === 0 ? pass('node-pty loader', 'package.json and lib in app.asar') : fail('node-pty loader', `not packed in app.asar: ${packedJs.join(', ')}`),
  ];
}

/** node-pty 1.1.0 shipped spawn-helper without the execute bit; the macOS pty cannot start a shell without it. */
export function checkSpawnHelperMode(mode) {
  const permissions = mode & 0o777;
  return permissions === 0o755 ? pass('node-pty spawn-helper mode', '0755') : fail('node-pty spawn-helper mode', `0${permissions.toString(8)}, expected 0755`);
}

/** `codesign -v` on one file; the ad hoc signed app's native binaries must each carry a valid signature. */
function codesignVerify(file) {
  const run = spawnSync('codesign', ['-v', file], { encoding: 'utf8' });
  if (run.error) throw run.error;
  return { ok: run.status === 0, output: `${run.stdout}${run.stderr}`.trim() };
}

/** Paths inside app.asar that must not ship. */
export function checkAsarEntries(entries) {
  const forbidden = entries.filter((entry) => FORBIDDEN_ASAR_PREFIXES.some((prefix) => entry.startsWith(prefix)) || entry.endsWith('.map'));
  return [forbidden.length === 0 ? pass('asar contents', `${entries.length} entries, no sources, tests, source maps or build tooling`) : fail('asar contents', `must not ship: ${forbidden.slice(0, 10).join(', ')}`)];
}

function listFiles(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => relative(dir, join(entry.parentPath, entry.name)).split(sep).join('/'))
    .sort();
}

const sha256 = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');

/** The packaged copy of every file in `sourceDir` (selected by `filter`) exists under `packagedDir` with identical bytes. */
function checkSameFiles(check, sourceDir, packagedDir, filter) {
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

// needsExecBit follows the package's target; a Windows host reads no exec bits, so it cannot check one there.
function checkFile(check, file, { needsExecBit = false } = {}) {
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

/** Each script exists and is not empty, and none but the PowerShell one holds a CR; `read` answers undefined for a missing file. */
export function checkShellIntegrationScripts(read) {
  const missing = SHELL_INTEGRATION_FILES.filter((file) => (read(file)?.length ?? 0) === 0);
  const crlf = SHELL_INTEGRATION_FILES.filter((file) => !file.endsWith('.ps1') && read(file)?.includes(0x0d));
  return [
    missing.length === 0 ? pass('shell integration scripts', SHELL_INTEGRATION_FILES.join(', ')) : fail('shell integration scripts', `missing or empty: ${missing.join(', ')}`),
    crlf.length === 0 ? pass('shell integration line endings', 'bash, zsh and fish scripts are LF') : fail('shell integration line endings', `CR in ${crlf.join(', ')}`),
  ];
}

function watcherPackage(platform, arch) {
  return `@parcel/watcher-${platform}-${arch}${platform === 'linux' ? '-glibc' : ''}`;
}

/** Runs every check on one packaged app; `readFuseWire` defaults to @electron/fuses reading the binary. */
export async function verifyPackage({ platform, arch, app, repoRoot, readFuseWire = getCurrentFuseWire, codesign = codesignVerify }) {
  const { binary, fuseTarget, resources } = layoutFor(platform, app);
  const asarPath = join(resources, 'app.asar');
  const unpacked = join(resources, 'app.asar.unpacked');
  const needsExecBit = platform !== 'win32';
  const results = [checkFile('binary', binary, { needsExecBit }), checkFile('app.asar', asarPath)];
  if (!results.every((result) => result.ok)) return results;

  const { header, dataOffset } = readAsarHeader(asarPath);
  const entries = asarFiles(header);
  const packedPaths = entries.filter(({ entry }) => !entry.unpacked).map(({ path }) => path);
  results.push(...checkAsarEntries(packedPaths));
  const manifestEntry = entries.find(({ path }) => path === 'package.json');
  const repoVersion = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')).version;
  if (manifestEntry === undefined) {
    results.push(fail('package.json', 'not in app.asar'));
  } else {
    const manifest = JSON.parse(readAsarFile(asarPath, dataOffset, manifestEntry.entry));
    const problems = [
      ...(manifest.main === 'dist/desktop/main.js' ? [] : [`main is ${manifest.main}, expected dist/desktop/main.js`]),
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
  results.push(...checkChangelog(packedChangelog, readFileSync(join(repoRoot, 'CHANGELOG.md'), 'utf8'), repoVersion));

  const unpackedFiles = listFiles(unpacked);
  results.push(...checkUnpackedSet(unpackedFiles, asarUnpackFor(platform)));
  const unpackedScripts = unpackedFiles.filter((file) => /\.(c|m)?js$/.test(file));
  results.push(pass('unpacked scripts (outside asar integrity)', unpackedScripts.join(', ')));

  const rgBinary = platform === 'win32' ? 'rg.exe' : 'rg';
  results.push(checkFile('ripgrep', join(unpacked, 'node_modules', '@vscode', `ripgrep-${platform}-${arch}`, 'bin', rgBinary), { needsExecBit }));
  for (const worker of WORKERS) results.push(checkFile(`worker ${worker}`, join(unpacked, 'dist', worker)));
  results.push(checkFile('web-tree-sitter (compass worker external)', join(unpacked, 'node_modules', 'web-tree-sitter', 'tree-sitter.wasm')));
  results.push(checkSameFiles('grammars', join(repoRoot, 'resources', 'grammars'), join(unpacked, 'resources', 'grammars'), (file) => file.endsWith('.wasm')));
  const shellIntegration = join(unpacked, 'resources', 'shell-integration');
  results.push(...checkShellIntegrationScripts((file) => (existsSync(join(shellIntegration, file)) ? readFileSync(join(shellIntegration, file)) : undefined)));

  const sidecar = join(unpacked, 'python', 'damocles_voice_sidecar', 'damocles_voice_sidecar');
  results.push(checkFile('python sidecar entry', join(sidecar, '__main__.py')));
  results.push(checkFile('python model manifest', join(sidecar, 'models', 'MODEL_MANIFEST.json')));
  results.push(checkSameFiles('wake models', join(repoRoot, 'python', 'damocles_voice_sidecar', 'damocles_voice_sidecar', 'models', 'wake'), join(sidecar, 'models', 'wake'), (file) => file.endsWith('.onnx')));
  const pythonJunk = listFiles(join(unpacked, 'python')).filter((file) => PYTHON_JUNK.test(file));
  results.push(pythonJunk.length === 0 ? pass('python package clean', 'no venvs, caches or tests') : fail('python package clean', pythonJunk.slice(0, 10).join(', ')));

  if (platform === 'win32') {
    const triplet = `win32_${arch}`;
    results.push(checkFile('koffi native', join(unpacked, 'node_modules', '@koromix', `koffi-win32-${arch}`, triplet, 'koffi.node')));
    results.push(packedPaths.includes('node_modules/koffi/package.json') ? pass('koffi loader', 'node_modules/koffi in app.asar') : fail('koffi loader', 'node_modules/koffi/package.json is not in app.asar'));
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

function readArg(argv, name) {
  const index = argv.indexOf(`--${name}`);
  const value = index === -1 ? undefined : argv[index + 1];
  return value === undefined || value.startsWith('--') ? undefined : value;
}

async function main(argv) {
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(USAGE);
    return 0;
  }
  const platform = readArg(argv, 'platform');
  const arch = readArg(argv, 'arch');
  const app = readArg(argv, 'app');
  if (!['win32', 'darwin', 'linux'].includes(platform) || !['x64', 'arm64'].includes(arch) || app === undefined) {
    console.error(USAGE);
    return 2;
  }
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
  const results = await verifyPackage({ platform, arch, app, repoRoot });
  for (const result of results) console.log(`${result.ok ? 'PASS' : 'FAIL'}  ${result.check}  ${result.detail}`);
  const failed = results.filter((result) => !result.ok).length;
  console.log(failed === 0 ? `\nOK  ${platform}-${arch}  ${results.length} checks passed` : `\nFAILED  ${platform}-${arch}  ${failed} of ${results.length} checks failed`);
  return failed === 0 ? 0 : 1;
}

if (isEntryPoint(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2));
}
