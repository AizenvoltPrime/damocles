import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync, rmSync } from 'node:fs';
import { dirname, join, posix, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RELEASE_TARGETS, WSL_TARGETS, MIN_VSIX_BYTES } from './release-targets.mjs';

// Builds a Linux-targeted VSIX for a Remote-SSH / container test without touching the Windows
// working tree. Packaging a Linux target from Windows does not work: `@vscode/ripgrep` resolves its
// binary from a per-platform optional dependency, so a Windows `npm install` leaves the tree with
// rg.exe and nothing for Linux, and a Unix executable bit cannot survive an NTFS round-trip anyway.
// So the source is copied into the WSL filesystem and `npm ci` + `vsce package` run there — the same
// two commands the release workflow's matrix legs run, with the same post-checks.

const BUILD_DIR_NAME = '.damocles-vsix-build';
const MANIFEST_NAME = '.package-wsl-manifest.tmp';
// Every wait is bounded. An unbounded spawnSync on a prompt (npx install confirmation, first-run
// distro setup, an npm auth challenge, anything interactive in ~/.profile) hangs with no deadline
// and almost no output — the failure mode docs/postmortems/pgrep-self-match-hang.md was written for.
const BUILD_TIMEOUT_MS = 45 * 60_000;
const PROBE_TIMEOUT_MS = 60_000;

// Build assets that are gitignored because they are fetched at build time. Copying them lets
// `fetch:assets` find them already present instead of re-downloading ~26 MB every run.
const UNTRACKED_ASSET_DIRS = [
  'resources/grammars',
  'python/damocles_voice_sidecar/damocles_voice_sidecar/models/wake',
];

const USAGE = `Usage: npm run package:linux-wsl -- [--target <target>] [--distro <name>]

  --target   ${WSL_TARGETS.join(' | ')}   (default: linux-x64)
  --distro   WSL distro to build in (default: the default distro)

The distro must match the target: an alpine-* target needs a musl distro, and the architecture must
match too — otherwise the artifact links against the wrong libc and only fails on the target host.`;

function fail(message, hint) {
  console.error(`ERROR: ${message}`);
  if (hint) console.error(hint);
  process.exit(1);
}

/** Single-quote a value for POSIX sh. */
function sh(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function readArg(name, fallback) {
  const flag = `--${name}`;
  const index = process.argv.indexOf(flag);
  if (index === -1) return fallback;
  const value = process.argv[index + 1];
  if (!value || value.startsWith('--')) return fail(`${flag} requires a value`);
  return value;
}

/**
 * Run a bash script inside WSL. stdin is closed so anything that tries to prompt dies on EOF rather
 * than waiting forever, and every call carries a deadline.
 */
function wsl(script, { distro, capture = false, timeoutMs = PROBE_TIMEOUT_MS, hint } = {}) {
  const args = distro ? ['-d', distro] : [];
  const result = spawnSync('wsl', [...args, '-e', 'bash', '-lc', script], {
    stdio: capture ? ['ignore', 'pipe', 'inherit'] : ['ignore', 'inherit', 'inherit'],
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    timeout: timeoutMs,
    killSignal: 'SIGKILL',
  });
  if (result.error?.code === 'ETIMEDOUT') {
    fail(`wsl command exceeded ${Math.round(timeoutMs / 1000)}s and was killed`, hint);
  }
  if (result.error) fail(`could not run wsl: ${result.error.message}`, hint);
  if (result.signal) fail(`wsl command was killed by ${result.signal}`, hint);
  if (result.status !== 0) fail(`wsl command failed (exit ${result.status})`, hint);
  // wsl.exe itself emits UTF-16 diagnostics on some hosts, which arrive here as embedded NULs.
  return capture ? result.stdout.replace(/\0/g, '').trim() : '';
}

function git(args) {
  const result = spawnSync('git', args, { cwd: repoRoot, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (result.error) fail(`could not run git: ${result.error.message}`);
  if (result.status !== 0) fail(`git ${args.join(' ')} failed (exit ${result.status})`);
  return result.stdout;
}

/** Every file under `dir`, repo-relative with forward slashes; empty when the directory is absent. */
function listFiles(dir) {
  const abs = join(repoRoot, dir);
  if (!existsSync(abs)) return [];
  return readdirSync(abs, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => relative(repoRoot, join(e.parentPath ?? e.path, e.name)).split(sep).join(posix.sep));
}

if (process.argv.includes('--help') || process.argv.includes('-h')) {
  console.log(USAGE);
  process.exit(0);
}
// An unrecognised flag must not be silently ignored: `--tgt linux-arm64` would otherwise build
// linux-x64 and report success.
const KNOWN_FLAGS = new Set(['--target', '--distro', '--help', '-h']);
for (const arg of process.argv.slice(2)) {
  if (arg.startsWith('-') && !KNOWN_FLAGS.has(arg)) fail(`unknown flag "${arg}"\n\n${USAGE}`);
}

if (process.platform !== 'win32') {
  fail('this script shells out to WSL; on Linux run `npx @vscode/vsce package --target <target>` directly');
}

const target = readArg('target', 'linux-x64');
if (!WSL_TARGETS.includes(target)) fail(`unsupported target "${target}"\n\n${USAGE}`);
const distro = readArg('distro', undefined);
const spec = RELEASE_TARGETS[target];

// Script-relative, so running from a subdirectory still reads this repo's package.json and packs
// this repo's tree.
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const { version } = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'));
const vsixName = `damocles-${target}-v${version}.vsix`;
const vsixPath = join(repoRoot, vsixName);

// `wslpath` rather than a hand-built /mnt/c path: the repo may sit on a mapped or non-C drive. An
// empty or relative answer would make the `cd` below land in wsl.exe's default cwd and silently pack
// the wrong tree, so it is validated rather than trusted.
const wslRepoRoot = wsl(`wslpath -a ${sh(repoRoot)}`, { distro, capture: true });
if (!wslRepoRoot.startsWith('/')) {
  fail(`wslpath returned an unexpected path: ${JSON.stringify(wslRepoRoot)}`);
}

// The artifact links against whatever libc and architecture the BUILD distro has, and neither the
// ripgrep check nor the size check can see that: alpine-* reuses the glibc ripgrep package name, so
// an Alpine target built in Ubuntu passes both and then fails to load on the actual Alpine host.
const probe = wsl('uname -m; (. /etc/os-release 2>/dev/null && echo "${ID:-unknown}") || echo unknown', {
  distro,
  capture: true,
});
const [distroArch = '', distroId = ''] = probe.split('\n').map((line) => line.trim());
const distroLibc = distroId === 'alpine' ? 'musl' : 'glibc';
if (distroArch !== spec.arch) {
  fail(
    `--target ${target} must be built on ${spec.arch}; ${distro ?? 'the default distro'} is ${distroArch || 'unknown'}`,
    'Cross-building is not supported here — use the release workflow for the other architecture.',
  );
}
if (distroLibc !== spec.libc) {
  fail(
    `--target ${target} must be built against ${spec.libc}; ${distro ?? 'the default distro'} reports ID=${distroId || 'unknown'} (${distroLibc})`,
    spec.libc === 'musl'
      ? 'Install an Alpine distro and pass --distro <name>, or build alpine-* in the release workflow.'
      : 'Pass --distro <name> for a glibc distro (Ubuntu, Debian, …).',
  );
}

// A tracked-file manifest, not a prune-list: the exclude approach was a hand-maintained partial copy
// of .gitignore, so anything it missed (a locally built sidecar wheel, .claude/worktrees with whole
// nested checkouts, stray logs) shipped inside the VSIX. Paths come from the index but content comes
// from the working tree, so uncommitted edits — the reason to run this at all — are still packed.
const tracked = git(['ls-files', '-z']).split('\0').filter(Boolean);
// Deduped: the asset directories carry tracked placeholders (.gitkeep) that the index lists too.
const files = [...new Set([...tracked.filter((f) => existsSync(join(repoRoot, f))), ...UNTRACKED_ASSET_DIRS.flatMap(listFiles)])];
const manifestPath = join(repoRoot, MANIFEST_NAME);
// NUL-terminated, not NUL-separated: that is what `tar --null -T` reads.
writeFileSync(manifestPath, files.map((f) => f + '\0').join(''));
// `fail()` exits the process, which skips `finally`; an exit hook is the only cleanup that always runs.
process.on('exit', () => rmSync(manifestPath, { force: true }));

console.log(`Packaging ${vsixName} in WSL (${distro ?? 'default distro'}, ${distroId || '?'}/${distroArch || '?'})`);
console.log(`  ${files.length} files from ${wslRepoRoot}`);

const buildDir = `"$HOME"/${BUILD_DIR_NAME}`;
const buildHint = `Build tree kept at ~/${BUILD_DIR_NAME} in ${distro ?? 'the default distro'} for inspection.`;
wsl(
  [
    // pipefail matters on the tar|tar line: without it a producer failure (`file changed as we read
    // it` on a live working tree, a permission error) leaves the consumer's exit 0 as the pipeline
    // status and the build proceeds on a truncated tree.
    'set -euo pipefail',
    `BUILD_DIR=${buildDir}`,
    'rm -rf "$BUILD_DIR"',
    'mkdir -p "$BUILD_DIR"',
    `tar -C ${sh(wslRepoRoot)} --null --no-recursion -T ${sh(`${wslRepoRoot}/${MANIFEST_NAME}`)} -cf - ` +
      '| (cd "$BUILD_DIR" && tar -xf -)',
    'cd "$BUILD_DIR"',
    'npm ci',
    // --yes: @vscode/vsce is not a devDependency, so npx would otherwise prompt to install it, and
    // that prompt is the classic unbounded wait. vsce runs `vscode:prepublish` (sync-vscodeignore +
    // full build), exactly as the release workflow does.
    `npx --yes @vscode/vsce package --target ${sh(target)} --out ${sh(vsixName)}`,
    `cp ${sh(vsixName)} ${sh(`${wslRepoRoot}/${vsixName}`)}`,
  ].join('\n'),
  { distro, timeoutMs: BUILD_TIMEOUT_MS, hint: buildHint },
);


if (!existsSync(vsixPath)) fail(`packaging reported success but ${vsixName} is not in the repo root`, buildHint);

// The same two post-checks the release workflow runs; both read the file that will actually be
// shipped (the copy in the repo root), so a truncated cross-filesystem copy cannot slip past.
// Filtered inside WSL: an 18k-entry listing overflows the spawnSync buffer.
const rgEntry = `extension/node_modules/@vscode/${spec.rgPkg}/bin/${spec.rgBin}`;
const rgCheck = wsl(
  `command -v unzip >/dev/null 2>&1 || { echo NO_UNZIP; exit 0; }; ` +
    `if unzip -Z1 ${sh(`${wslRepoRoot}/${vsixName}`)} | grep -qFx ${sh(rgEntry)}; then echo FOUND; else echo MISSING; fi`,
  { distro, capture: true, hint: buildHint },
);
if (rgCheck === 'NO_UNZIP') {
  fail(
    `cannot verify ${vsixName}: unzip is not installed in ${distro ?? 'the default distro'}`,
    'Install it (apt install unzip / apk add unzip) and re-run — the VSIX itself is already built.',
  );
}
if (rgCheck !== 'FOUND') {
  fail(`${vsixName} is missing ${rgEntry} (ripgrep binary for @ file autocomplete)`, buildHint);
}

const size = statSync(vsixPath).size;
if (size < MIN_VSIX_BYTES) {
  fail(`${vsixName} is suspiciously small (${size} bytes — bundled deps/assets likely missing)`, buildHint);
}

// Checks passed and the artifact is out; the build tree is several GB inside a VHDX that never
// shrinks, so it is not kept as a cache.
wsl(`rm -rf ${buildDir}`, { distro });

console.log(`\nOK  ${vsixName}  (${(size / 1_000_000).toFixed(1)} MB)`);
console.log('Install on the remote host with:');
console.log(`  code --install-extension ${vsixName}    (from a Remote-SSH window, or scp it over first)`);
