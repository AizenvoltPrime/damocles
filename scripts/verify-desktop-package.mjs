import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, posix, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FuseState, FuseV1Options, getCurrentFuseWire } from '@electron/fuses';
import { ASAR_UNPACK } from '../src/desktop/main/platform/unpacked-assets.ts';
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
const WORKERS = ['compass-worker.js', 'usage-stats-worker.js', 'sentinel.js'];
// The license notices electron-builder.yml ships inside app.asar (files) and beside it (extraResources).
const PACKED_NOTICES = ['LICENSE', 'THIRD-PARTY-NOTICES.md'];
const RESOURCE_NOTICES = ['monaco-editor-ThirdPartyNotices.txt'];
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

/** Every file under app.asar.unpacked matches an ASAR_UNPACK glob, and every glob matches a file. */
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

function watcherPackage(platform, arch) {
  return `@parcel/watcher-${platform}-${arch}${platform === 'linux' ? '-glibc' : ''}`;
}

/** Runs every check on one packaged app; `readFuseWire` defaults to @electron/fuses reading the binary. */
export async function verifyPackage({ platform, arch, app, repoRoot, readFuseWire = getCurrentFuseWire }) {
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
  if (manifestEntry === undefined) {
    results.push(fail('package.json', 'not in app.asar'));
  } else {
    const manifest = JSON.parse(readAsarFile(asarPath, dataOffset, manifestEntry.entry));
    const repoVersion = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')).version;
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

  const unpackedFiles = listFiles(unpacked);
  results.push(...checkUnpackedSet(unpackedFiles, ASAR_UNPACK));
  const unpackedScripts = unpackedFiles.filter((file) => /\.(c|m)?js$/.test(file));
  results.push(pass('unpacked scripts (outside asar integrity)', unpackedScripts.join(', ')));

  const rgBinary = platform === 'win32' ? 'rg.exe' : 'rg';
  results.push(checkFile('ripgrep', join(unpacked, 'node_modules', '@vscode', `ripgrep-${platform}-${arch}`, 'bin', rgBinary), { needsExecBit }));
  for (const worker of WORKERS) results.push(checkFile(`worker ${worker}`, join(unpacked, 'dist', worker)));
  results.push(checkFile('web-tree-sitter (compass worker external)', join(unpacked, 'node_modules', 'web-tree-sitter', 'tree-sitter.wasm')));
  results.push(checkSameFiles('grammars', join(repoRoot, 'resources', 'grammars'), join(unpacked, 'resources', 'grammars'), (file) => file.endsWith('.wasm')));

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
  results.push(checkFile('@parcel/watcher native', join(unpacked, 'node_modules', watcherPackage(platform, arch), 'watcher.node')));

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
