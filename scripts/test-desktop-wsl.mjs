import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, posix, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

// Runs the desktop e2e suite on Linux in WSL, as the release workflow's Linux leg does: a Windows node_modules has no
// Linux Electron, ripgrep, watcher or koffi binaries, so the working tree is synced into a WSL-native directory and
// installed there. Chromium's namespace sandbox works under WSL's kernel, so no setuid helper (and no sudo) is needed.

const E2E_DIR_NAME = 'damocles-e2e';
// Kept inside the WSL copy: the previous run's file list (to delete files the tree no longer has) and the lockfile hash
// of the last successful `npm ci`.
const PREVIOUS_MANIFEST = '.wsl-e2e-manifest';
const LOCK_STAMP = '.wsl-e2e-lock.sha256';
const SYNC_TIMEOUT_MS = 15 * 60_000;
const BUILD_TIMEOUT_MS = 45 * 60_000;
const TEST_TIMEOUT_MS = 3 * 60 * 60_000;
const PROBE_TIMEOUT_MS = 60_000;
// After its deadline `timeout` sends TERM, and KILL this many seconds later to whatever is left.
const KILL_AFTER_S = 30;
// GNU timeout's exit status when the command ran past its deadline.
const TIMED_OUT_STATUS = 124;
// Gitignored build assets; copying them saves the fetch.
const UNTRACKED_ASSET_DIRS = ['resources/grammars', 'python/damocles_voice_sidecar/damocles_voice_sidecar/models/wake'];
// Never copied even when a file under them is tracked: the distro installs and builds its own.
const EXCLUDED_ROOTS = /^(node_modules|dist[^/]*)\//;
// release.yml's Linux step; the worker count comes from playwright.desktop.config.ts.
const XVFB = `xvfb-run -a -s '-screen 0 1920x1080x24'`;

const USAGE = `Usage: node scripts/test-desktop-wsl.mjs [--distro <name>] [specs...]

  --distro   WSL distro to run in (default: the default distro). It needs Node 24 through nvm, xvfb-run, openbox,
             xauth, rsync and Electron's runtime libraries.
  specs      Playwright spec filters such as e2e/desktop/quit.spec.ts (default: the whole desktop suite).

The copy lives at ~/${E2E_DIR_NAME} in the distro and is updated incrementally; npm ci runs only when
package-lock.json changed. Results and the HTML report stay under ~/${E2E_DIR_NAME}/dist/e2e-results and
~/${E2E_DIR_NAME}/dist/e2e-report there.`;

function fail(message, hint) {
  console.error(`ERROR: ${message}`);
  if (hint) console.error(hint);
  process.exit(1);
}

/** Single-quote a value for POSIX sh. */
function sh(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

// stdin is closed so a prompt dies on EOF instead of waiting, and every call has a deadline. The deadline is enforced in the
// distro by `timeout`, which signals its whole process group (Xvfb, Electron, Playwright), since killing wsl.exe leaves
// the Linux processes running; wsl.exe's own deadline is only a backstop.
function wsl(script, { distro, capture = false, timeoutMs = PROBE_TIMEOUT_MS, hint } = {}) {
  const args = distro ? ['-d', distro] : [];
  const seconds = Math.ceil(timeoutMs / 1000);
  const result = spawnSync('wsl', [...args, '-e', 'timeout', `--kill-after=${KILL_AFTER_S}`, String(seconds), 'bash', '-lc', script], {
    stdio: capture ? ['ignore', 'pipe', 'inherit'] : ['ignore', 'inherit', 'inherit'],
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    timeout: (seconds + KILL_AFTER_S + 30) * 1000,
    killSignal: 'SIGKILL',
  });
  if (result.status === TIMED_OUT_STATUS) fail(`wsl command exceeded ${seconds}s and was stopped`, hint);
  if (result.error?.code === 'ETIMEDOUT') fail(`wsl.exe did not return after its command's ${seconds}s deadline and was killed`, hint);
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

const argv = process.argv.slice(2);
if (argv.includes('--help') || argv.includes('-h')) {
  console.log(USAGE);
  process.exit(0);
}
let distro;
const specs = [];
for (let i = 0; i < argv.length; i++) {
  const arg = argv[i];
  if (arg === '--distro') {
    distro = argv[++i];
    if (!distro || distro.startsWith('-')) fail('--distro requires a value');
  } else if (arg.startsWith('-')) {
    fail(`unknown flag "${arg}"\n\n${USAGE}`);
  } else {
    specs.push(arg.split(sep).join(posix.sep));
  }
}
if (process.platform !== 'win32') fail('this script shells out to WSL; on Linux run `npm run test:desktop` under xvfb-run directly');

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const distroName = distro ?? 'the default distro';

// The file list rsync reads, outside the working tree. Node fires 'exit' on Ctrl+C only while a SIGINT listener exists.
const manifestDir = mkdtempSync(join(tmpdir(), 'damocles-wsl-e2e-'));
process.on('exit', () => rmSync(manifestDir, { recursive: true, force: true }));
process.on('SIGINT', () => process.exit(130));
const manifestPath = join(manifestDir, 'manifest');

// Tracked plus untracked-but-not-ignored files: the working tree as it is, uncommitted work included.
const tree = git(['ls-files', '-z', '--cached', '--others', '--exclude-standard']).split('\0').filter(Boolean);
const files = [
  ...new Set([...tree.filter((f) => !EXCLUDED_ROOTS.test(f) && existsSync(join(repoRoot, f))), ...UNTRACKED_ASSET_DIRS.flatMap(listFiles)]),
];
writeFileSync(manifestPath, files.map((f) => f + '\0').join(''));

const [wslRepoRoot, wslManifest] = wsl(`wslpath -a ${sh(repoRoot)} && wslpath -a ${sh(manifestPath)}`, { distro, capture: true }).split('\n').map((line) => line.trim());
for (const converted of [wslRepoRoot, wslManifest]) {
  if (!converted?.startsWith('/')) fail(`wslpath returned an unexpected path: ${JSON.stringify(converted)}`);
}

// nvm lives in the interactive rc file, which a login shell skips. The distro's PATH also carries the Windows npm shim
// under /mnt/c, which must never run here.
const NODE_SETUP = [
  '[ -s "$HOME/.nvm/nvm.sh" ] || { echo "nvm is required in the distro (~/.nvm/nvm.sh not found)"; exit 1; }',
  '. "$HOME/.nvm/nvm.sh"',
  'nvm use 24 >/dev/null || { echo "Node 24 is required through nvm: nvm install 24"; exit 1; }',
  'case "$(command -v npm)" in /mnt/*) echo "npm resolves to the Windows shim $(command -v npm), not nvm\'s Node 24"; exit 1;; esac',
];
const keptHint = `The copy is kept at ~/${E2E_DIR_NAME} in ${distroName} for inspection.`;

console.log(`Syncing ${files.length} files into ~/${E2E_DIR_NAME} in WSL (${distroName})`);
wsl(
  [
    'set -euo pipefail',
    'for tool in rsync xvfb-run openbox xauth; do command -v "$tool" >/dev/null || { echo "$tool is required in the distro"; exit 1; }; done',
    `E2E_DIR="$HOME"/${E2E_DIR_NAME}`,
    'mkdir -p "$E2E_DIR"',
    `rsync -rlt --from0 --files-from=${sh(wslManifest)} ${sh(`${wslRepoRoot}/`)} "$E2E_DIR"/`,
    'cd "$E2E_DIR"',
    `if [ -f ${PREVIOUS_MANIFEST} ]; then comm -z -23 <(sort -z ${PREVIOUS_MANIFEST}) <(sort -z ${sh(wslManifest)}) | xargs -0 -r rm -f --; fi`,
    `cp ${sh(wslManifest)} ${PREVIOUS_MANIFEST}`,
  ].join('\n'),
  { distro, timeoutMs: SYNC_TIMEOUT_MS, hint: 'rsync needs read access to the Windows working tree through /mnt.' },
);

console.log('Installing and building in WSL');
wsl(
  [
    'set -euo pipefail',
    `cd "$HOME"/${E2E_DIR_NAME}`,
    ...NODE_SETUP,
    `LOCK_HASH="$(sha256sum package-lock.json | cut -d' ' -f1)"`,
    `if [ ! -d node_modules ] || [ "$(cat ${LOCK_STAMP} 2>/dev/null)" != "$LOCK_HASH" ]; then`,
    `  rm -f ${LOCK_STAMP}`,
    '  npm ci',
    `  echo "$LOCK_HASH" > ${LOCK_STAMP}`,
    'else',
    '  echo "package-lock.json unchanged; skipping npm ci"',
    'fi',
    'npx --no install-electron',
    'npm run build',
    'npm run build:desktop',
  ].join('\n'),
  { distro, timeoutMs: BUILD_TIMEOUT_MS, hint: keptHint },
);

const playwright = ['npx', '--no', 'playwright', 'test', ...specs, '--config', 'playwright.desktop.config.ts', '--project=dev'].map(sh).join(' ');
console.log(`Running ${specs.length ? specs.join(' ') : 'the whole desktop suite'} under Xvfb and openbox`);
wsl(
  ['set -euo pipefail', `cd "$HOME"/${E2E_DIR_NAME}`, ...NODE_SETUP, `${XVFB} sh -c ${sh(`openbox & exec ${playwright}`)}`].join('\n'),
  {
    distro,
    timeoutMs: TEST_TIMEOUT_MS,
    hint: `${keptHint} Traces and screenshots: ~/${E2E_DIR_NAME}/dist/e2e-results/dev; report: ~/${E2E_DIR_NAME}/dist/e2e-report/dev.`,
  },
);
console.log(`\nOK  desktop e2e passed in WSL (${distroName}).`);
