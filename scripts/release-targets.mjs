/**
 * The packaging-relevant columns of the release matrix.
 *
 * `.github/workflows/release.yml` must keep its own static `strategy.matrix` — the runner image and
 * the Alpine-container switch are resolved by Actions before any JS could run — so it cannot import
 * this. `scripts/__tests__/release-targets.test.ts` parses that workflow and fails when the two
 * drift, which is the only thing standing between a renamed ripgrep package and a silently broken
 * release artifact.
 *
 * `arch`/`libc` are NOT in the workflow: there they are implied by the runner image and the
 * `node:24-alpine` container. A local build picks its own machine, so they have to be stated to be
 * checkable.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isEntryPoint } from './entry-point.mjs';

export const MIN_VSIX_BYTES = 30_000_000;

export const RELEASE_TARGETS = {
  'win32-x64': { rgPkg: 'ripgrep-win32-x64', rgBin: 'rg.exe' },
  'win32-arm64': { rgPkg: 'ripgrep-win32-arm64', rgBin: 'rg.exe' },
  'darwin-arm64': { rgPkg: 'ripgrep-darwin-arm64', rgBin: 'rg' },
  'linux-x64': { rgPkg: 'ripgrep-linux-x64', rgBin: 'rg', arch: 'x86_64', libc: 'glibc' },
  'linux-arm64': { rgPkg: 'ripgrep-linux-arm64', rgBin: 'rg', arch: 'aarch64', libc: 'glibc' },
  'alpine-x64': { rgPkg: 'ripgrep-linux-x64', rgBin: 'rg', arch: 'x86_64', libc: 'musl' },
  'alpine-arm64': { rgPkg: 'ripgrep-linux-arm64', rgBin: 'rg', arch: 'aarch64', libc: 'musl' },
};

/** Targets a WSL distro can produce — the ones whose `arch`/`libc` a local build can be checked against. */
export const WSL_TARGETS = Object.keys(RELEASE_TARGETS).filter((t) => RELEASE_TARGETS[t].libc);

/**
 * The desktop installer legs (the workflow's `package-desktop` matrix), keyed by the matrix `target`.
 * `os` is Node's `process.platform`, `builder` the electron-builder platform flag, `channel` the
 * Windows update channel passed as `-c.publish.channel` (the other platforms use electron-updater's
 * default feed names). `artifacts` are the files electron-builder writes to `dist-desktop/`, with
 * `${version}` the package.json version; the release attaches exactly these.
 */
export const DESKTOP_TARGETS = {
  'win-x64': {
    runner: 'windows-latest', os: 'win32', builder: 'win', arch: 'x64', channel: 'latest-x64',
    appDir: 'dist-desktop/win-unpacked', executable: 'dist-desktop/win-unpacked/Damocles.exe',
    artifacts: ['Damocles-Setup-${version}-x64.exe', 'Damocles-Setup-${version}-x64.exe.blockmap', 'latest-x64.yml'],
  },
  'win-arm64': {
    runner: 'windows-11-arm', os: 'win32', builder: 'win', arch: 'arm64', channel: 'latest-arm64',
    appDir: 'dist-desktop/win-arm64-unpacked', executable: 'dist-desktop/win-arm64-unpacked/Damocles.exe',
    artifacts: ['Damocles-Setup-${version}-arm64.exe', 'Damocles-Setup-${version}-arm64.exe.blockmap', 'latest-arm64.yml'],
  },
  'mac-arm64': {
    runner: 'macos-latest', os: 'darwin', builder: 'mac', arch: 'arm64',
    appDir: 'dist-desktop/mac-arm64/Damocles.app', executable: 'dist-desktop/mac-arm64/Damocles.app/Contents/MacOS/Damocles',
    artifacts: [
      'Damocles-${version}-arm64.dmg', 'Damocles-${version}-arm64.dmg.blockmap',
      'Damocles-${version}-arm64.zip', 'Damocles-${version}-arm64.zip.blockmap', 'latest-mac.yml',
    ],
  },
  'linux-x64': {
    runner: 'ubuntu-latest', os: 'linux', builder: 'linux', arch: 'x64',
    appDir: 'dist-desktop/linux-unpacked', executable: 'dist-desktop/linux-unpacked/damocles',
    artifacts: ['damocles_${version}_amd64.deb', 'damocles-${version}.x86_64.rpm', 'latest-linux.yml'],
  },
  'linux-arm64': {
    runner: 'ubuntu-24.04-arm', os: 'linux', builder: 'linux', arch: 'arm64',
    appDir: 'dist-desktop/linux-arm64-unpacked', executable: 'dist-desktop/linux-arm64-unpacked/damocles',
    artifacts: ['damocles_${version}_arm64.deb', 'damocles-${version}.aarch64.rpm', 'latest-linux-arm64.yml'],
  },
};

/** File names the release uploads from electron-builder output: installers, blockmaps and update feeds. */
export const DESKTOP_ARTIFACT_PATTERN = /(\.(exe|dmg|zip|deb|rpm|blockmap)|^latest.*\.yml)$/;

/** The artifact file names `target` produces at `version`. */
export function desktopArtifacts(target, version) {
  const spec = DESKTOP_TARGETS[target];
  if (!spec) throw new Error(`Unknown desktop target ${target}; known: ${Object.keys(DESKTOP_TARGETS).join(', ')}`);
  return spec.artifacts.map((name) => name.replaceAll('${version}', version));
}

/** Missing and unexpected desktop artifacts in `present` (file names) for `targets` at `version`. */
export function desktopArtifactProblems(targets, version, present) {
  const expected = new Set(targets.flatMap((target) => desktopArtifacts(target, version)));
  const found = new Set(present.filter((name) => DESKTOP_ARTIFACT_PATTERN.test(name)));
  return {
    missing: [...expected].filter((name) => !found.has(name)).sort(),
    unexpected: [...found].filter((name) => !expected.has(name)).sort(),
  };
}

/**
 * `node scripts/release-targets.mjs --check-desktop-artifacts <target|all> <dir>` exits 1 when `<dir>`
 * lacks an artifact the target(s) must produce, or holds one no target names.
 */
function main() {
  const flag = process.argv.indexOf('--check-desktop-artifacts');
  const [target, dir] = flag === -1 ? [] : process.argv.slice(flag + 1);
  if (!target || !dir) {
    console.error('Usage: node scripts/release-targets.mjs --check-desktop-artifacts <target|all> <dir>');
    process.exit(1);
  }
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const targets = target === 'all' ? Object.keys(DESKTOP_TARGETS) : [target];
  const { missing, unexpected } = desktopArtifactProblems(targets, version, readdirSync(dir));
  if (missing.length) console.error(`Missing desktop artifacts in ${dir}: ${missing.join(', ')}`);
  if (unexpected.length) console.error(`Desktop artifacts in ${dir} that no target in scripts/release-targets.mjs names: ${unexpected.join(', ')}`);
  if (missing.length || unexpected.length) process.exit(1);
  const count = targets.flatMap((t) => desktopArtifacts(t, version)).length;
  console.log(`All ${count} desktop artifacts for ${targets.join(', ')} at ${version} are in ${dir}.`);
}

// Gated so importing the module never runs the check.
if (isEntryPoint(import.meta.url)) main();
