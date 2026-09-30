import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, posix, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

// Builds the Linux deb and rpm for the WSL distro's architecture from this working tree, as the release
// workflow's Linux legs do: a Windows node_modules has no Linux ripgrep, watcher or koffi binaries, so the
// tree is copied into the distro and installed there. Artifacts are copied back to dist-desktop/.

const BUILD_DIR_NAME = '.damocles-desktop-build';
const MANIFEST_NAME = '.dist-linux-wsl-manifest.tmp';
const BUILD_TIMEOUT_MS = 60 * 60_000;
const PROBE_TIMEOUT_MS = 60_000;
// Gitignored build assets; copying them saves the fetch.
const UNTRACKED_ASSET_DIRS = ['resources/grammars', 'python/damocles_voice_sidecar/damocles_voice_sidecar/models/wake'];
const ARCH_BY_UNAME = { x86_64: 'x64', aarch64: 'arm64' };

const USAGE = `Usage: npm run dist:linux-wsl -- [--distro <name>]

  --distro   WSL distro to build in (default: the default distro). It needs Node 24 or later (on PATH, or through nvm),
             rpm (rpmbuild) and a glibc userland; the artifacts are for its architecture.

The build tree stays at ~/${BUILD_DIR_NAME} in the distro for installing and testing; the next run replaces it.`;

function fail(message, hint) {
  console.error(`ERROR: ${message}`);
  if (hint) console.error(hint);
  process.exit(1);
}

/** Single-quote a value for POSIX sh. */
function sh(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

// stdin is closed so a prompt dies on EOF instead of waiting, and every call has a deadline.
function wsl(script, { distro, capture = false, timeoutMs = PROBE_TIMEOUT_MS, hint } = {}) {
  const args = distro ? ['-d', distro] : [];
  const result = spawnSync('wsl', [...args, '-e', 'bash', '-lc', script], {
    stdio: capture ? ['ignore', 'pipe', 'inherit'] : ['ignore', 'inherit', 'inherit'],
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    timeout: timeoutMs,
    killSignal: 'SIGKILL',
  });
  if (result.error?.code === 'ETIMEDOUT') fail(`wsl command exceeded ${Math.round(timeoutMs / 1000)}s and was killed`, hint);
  if (result.error) fail(`could not run wsl: ${result.error.message}`, hint);
  if (result.signal) fail(`wsl command was killed by ${result.signal}`, hint);
  if (result.status !== 0) fail(`wsl command failed (exit ${result.status})`, hint);
  // wsl.exe emits UTF-16 diagnostics on some hosts, which arrive as embedded NULs.
  return capture ? result.stdout.replace(/\0/g, '').trim() : '';
}

function git(args) {
  const result = spawnSync('git', args, { cwd: repoRoot, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (result.error) fail(`could not run git: ${result.error.message}`);
  if (result.status !== 0) fail(`git ${args.join(' ')} failed (exit ${result.status})`);
  return result.stdout;
}

function listFiles(dir) {
  const abs = join(repoRoot, dir);
  if (!existsSync(abs)) return [];
  return readdirSync(abs, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => relative(repoRoot, join(e.parentPath, e.name)).split(sep).join(posix.sep));
}

if (process.argv.includes('--help') || process.argv.includes('-h')) {
  console.log(USAGE);
  process.exit(0);
}
const KNOWN_FLAGS = new Set(['--distro', '--help', '-h']);
for (const arg of process.argv.slice(2)) {
  if (arg.startsWith('-') && !KNOWN_FLAGS.has(arg)) fail(`unknown flag "${arg}"\n\n${USAGE}`);
}
if (process.platform !== 'win32') fail('this script shells out to WSL; on Linux run `npm run dist` directly');

const distroIndex = process.argv.indexOf('--distro');
const distro = distroIndex === -1 ? undefined : process.argv[distroIndex + 1];
if (distroIndex !== -1 && (!distro || distro.startsWith('--'))) fail('--distro requires a value');

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const wslRepoRoot = wsl(`wslpath -a ${sh(repoRoot)}`, { distro, capture: true });
if (!wslRepoRoot.startsWith('/')) fail(`wslpath returned an unexpected path: ${JSON.stringify(wslRepoRoot)}`);

const uname = wsl('uname -m', { distro, capture: true });
const arch = ARCH_BY_UNAME[uname];
if (!arch) fail(`the desktop app builds for x86_64 and aarch64; ${distro ?? 'the default distro'} is ${uname}`);

// Tracked plus untracked-but-not-ignored files: the working tree as it is, uncommitted work included.
const tree = git(['ls-files', '-z', '--cached', '--others', '--exclude-standard']).split('\0').filter(Boolean);
const files = [...new Set([...tree.filter((f) => existsSync(join(repoRoot, f))), ...UNTRACKED_ASSET_DIRS.flatMap(listFiles)])];
const manifestPath = join(repoRoot, MANIFEST_NAME);
writeFileSync(manifestPath, files.map((f) => f + '\0').join(''));
process.on('exit', () => rmSync(manifestPath, { force: true }));

const unpackedDir = arch === 'x64' ? 'linux-unpacked' : `linux-${arch}-unpacked`;
console.log(`Building the Linux ${arch} deb and rpm in WSL (${distro ?? 'default distro'}) from ${files.length} files`);
const buildHint = `Build tree kept at ~/${BUILD_DIR_NAME} in ${distro ?? 'the default distro'} for inspection.`;
wsl(
  [
    'set -euo pipefail',
    `BUILD_DIR="$HOME"/${BUILD_DIR_NAME}`,
    'rm -rf "$BUILD_DIR"',
    'mkdir -p "$BUILD_DIR"',
    `tar -C ${sh(wslRepoRoot)} --null --no-recursion -T ${sh(`${wslRepoRoot}/${MANIFEST_NAME}`)} -cf - | (cd "$BUILD_DIR" && tar -xf -)`,
    'cd "$BUILD_DIR"',
    // A login shell does not load nvm, which lives in the interactive rc file. Node 24, which CI builds with, is preferred when nvm has it.
    'if [ -s "$HOME/.nvm/nvm.sh" ]; then . "$HOME/.nvm/nvm.sh"; nvm use 24 >/dev/null 2>&1 || true; fi',
    `node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 24 ? 0 : 1)' || { echo "Node 24 or later is required in the distro (found $(node --version 2>&1))"; exit 1; }`,
    'command -v rpmbuild >/dev/null || { echo "rpmbuild is required: sudo apt-get install rpm"; exit 1; }',
    'npm ci',
    'npm run build',
    'npm run build:desktop',
    'node scripts/dist-desktop.mjs',
    `node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON scripts/verify-desktop-package.mjs --platform linux --arch ${arch} --app dist-desktop/${unpackedDir}`,
    `mkdir -p ${sh(`${wslRepoRoot}/dist-desktop`)}`,
    `cp dist-desktop/*.deb dist-desktop/*.rpm dist-desktop/latest-linux*.yml ${sh(`${wslRepoRoot}/dist-desktop/`)}`,
    `ls -l dist-desktop/*.deb dist-desktop/*.rpm dist-desktop/latest-linux*.yml`,
  ].join('\n'),
  { distro, timeoutMs: BUILD_TIMEOUT_MS, hint: buildHint },
);
console.log(`\nOK  deb, rpm and latest-linux*.yml copied to dist-desktop/. ${buildHint}`);
