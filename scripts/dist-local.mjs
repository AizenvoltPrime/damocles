import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MANIFEST_PATH, OUT_DIR } from './build-server.mjs';
import { isEntryPoint } from './entry-point.mjs';
import { npmCliPath } from './npm-cli.mjs';
import { sha256 } from './server-archive.mjs';
import { SERVER_TARGETS, serverArtifact, serverNodeVersion } from './server-targets.mjs';
import { muslNodePty } from './test-remote.mjs';

// npm run dist for a build with no GitHub release: builds all eight server packages (the Alpine ones compile node-pty in
// Docker, scripts/test-remote.mjs), packages the app with their unpublished manifest, and copies the packages into the
// packaged app's server cache on this computer, the only place its hosts get them from: SSH hosts are sent the cached copy,
// and WSL distros and dev containers copy it. Each build installs as its own server version (<version>+<build>), so it may
// keep a released version number. Extra arguments pass through to dist-desktop.mjs.

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Electron's userData of a packaged app (src/desktop/main/index.ts APP_NAME), for this process's platform and user. */
export function packagedUserData({ platform = process.platform, env = process.env, home = homedir(), uid = process.getuid?.() } = {}) {
  if (platform === 'win32') {
    if (!env.APPDATA) throw new Error('APPDATA is not set, so the packaged app\'s server cache cannot be found');
    return join(env.APPDATA, 'damocles');
  }
  if (platform === 'darwin') return join(home, 'Library', 'Application Support', 'damocles');
  if (env.SUDO_USER && uid === 0) throw new Error(`Run npm run dist:local as ${env.SUDO_USER}, not under sudo: the server cache is in the home of the user who runs the app`);
  // Chromium ignores a relative XDG_CONFIG_HOME
  const config = env.XDG_CONFIG_HOME && isAbsolute(env.XDG_CONFIG_HOME) ? env.XDG_CONFIG_HOME : join(home, '.config');
  return join(config, 'damocles');
}

/** Why a packaged app would refuse `manifest` for `version` (src/desktop/main/remote/server-manifest.ts), or undefined. */
export function manifestProblem(manifest, version, targets) {
  const missing = targets.filter((target) => manifest.packages?.[target]?.file !== serverArtifact(target, version));
  if (manifest.version === version && !missing.length) return undefined;
  return `${MANIFEST_PATH} is for ${manifest.version}${missing.length ? ` and lacks ${missing.join(', ')}` : ''}; this build is ${version}`;
}

/** Where dist-desktop.mjs writes the app for its pass-through `args`. */
export function outputDirectory(args) {
  const override = args.some((arg) => /^(-c|--config)\.directories\.output(=|$)/.test(arg));
  return override ? 'the output directory you passed' : 'dist-desktop/';
}

/** Whether `data` is the package `pkg` (a manifest entry) names, by SHA-256 and size. */
export function matchesPackage(data, pkg) {
  return data.length === pkg.size && sha256(data) === pkg.sha256;
}

function run(command, args) {
  console.log(`> ${[command, ...args].join(' ')}`);
  const result = spawnSync(command, args, { cwd: ROOT, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${[command, ...args].join(' ')} exited with ${result.status ?? result.signal}`);
}

async function main() {
  const passThrough = process.argv.slice(2);
  const { version } = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  const targets = Object.keys(SERVER_TARGETS);
  const cache = join(packagedUserData(), 'server-cache', version);
  const npm = npmCliPath();
  // build-server.mjs packs resources/grammars, which only fetch:grammars writes
  run(process.execPath, [npm, 'run', 'fetch:grammars']);
  const nodeVersion = serverNodeVersion();
  // --all builds the daemon bundles once for the six non-Alpine targets; each Alpine target takes its own node-pty
  const buildServer = join(ROOT, 'scripts', 'build-server.mjs');
  run(process.execPath, [buildServer, '--all', '--node-version', nodeVersion]);
  for (const target of targets.filter((name) => SERVER_TARGETS[name].alpine)) {
    run(process.execPath, [buildServer, '--target', target, '--node-version', nodeVersion, '--node-pty-binary', muslNodePty(target, nodeVersion)]);
  }
  const manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'));
  const problem = manifestProblem(manifest, version, targets);
  if (problem) throw new Error(problem);
  run(process.execPath, [npm, 'run', 'dist', '--', ...passThrough]);
  // src/desktop/main/remote/artifact-cache.ts: <userData>/server-cache/<version>/
  mkdirSync(cache, { recursive: true });
  for (const target of targets) {
    const name = serverArtifact(target, version);
    if (!matchesPackage(readFileSync(join(OUT_DIR, name)), manifest.packages[target])) throw new Error(`${join(OUT_DIR, name)} changed after the app was packaged with ${MANIFEST_PATH}; run npm run dist:local again`);
    copyFileSync(join(OUT_DIR, name), join(cache, name));
  }
  console.log(`Copied the ${targets.length} server packages to ${cache}. Install the app from ${outputDirectory(passThrough)}.`);
}

if (isEntryPoint(import.meta.url)) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
