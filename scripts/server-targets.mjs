/**
 * The server package targets and the Node each one bundles.
 *
 * The Node version is the one the shipped Electron embeds, derived by running the installed Electron as Node; it is never
 * chosen here. NODE_RELEASES pins the archives of that version, each SHA-256 copied from the release's SHASUMS256.txt
 * (nodejs.org/dist/v<version>/, and unofficial-builds.nodejs.org/download/release/v<version>/ for musl). A new Electron
 * whose Node has no entry fails this script until its archives and its Alpine build image are pinned.
 *
 * `runner` and `alpine` are the release workflow's `package-server` matrix columns; server-targets.test.ts fails on drift.
 *
 *   node scripts/server-targets.mjs                   # check the derived Node against the pinned archives
 *   node scripts/server-targets.mjs --node-version    # print the derived Node version
 *   node scripts/server-targets.mjs --github-outputs  # print version=, alpine-build-image= and alpine-target-image= lines
 */

import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { isEntryPoint } from './entry-point.mjs';

const NODE_DIST = 'https://nodejs.org/dist';
const NODE_UNOFFICIAL = 'https://unofficial-builds.nodejs.org/download/release';

export const SERVER_TARGETS = {
  'linux-x64': {
    platform: 'linux', arch: 'x64', libc: 'glibc', runner: 'ubuntu-latest', alpine: false,
    natives: ['@vscode/ripgrep-linux-x64', '@parcel/watcher-linux-x64-glibc'], ptyPrebuild: 'linux-x64',
  },
  'linux-arm64': {
    platform: 'linux', arch: 'arm64', libc: 'glibc', runner: 'ubuntu-24.04-arm', alpine: false,
    natives: ['@vscode/ripgrep-linux-arm64', '@parcel/watcher-linux-arm64-glibc'], ptyPrebuild: 'linux-arm64',
  },
  'alpine-x64': {
    platform: 'linux', arch: 'x64', libc: 'musl', runner: 'ubuntu-latest', alpine: true,
    natives: ['@vscode/ripgrep-linux-x64', '@parcel/watcher-linux-x64-musl'], ptyPrebuild: 'linux-x64',
  },
  'alpine-arm64': {
    platform: 'linux', arch: 'arm64', libc: 'musl', runner: 'ubuntu-24.04-arm', alpine: true,
    natives: ['@vscode/ripgrep-linux-arm64', '@parcel/watcher-linux-arm64-musl'], ptyPrebuild: 'linux-arm64',
  },
  'darwin-x64': {
    platform: 'darwin', arch: 'x64', libc: null, runner: 'macos-15-intel', alpine: false,
    natives: ['@vscode/ripgrep-darwin-x64', '@parcel/watcher-darwin-x64'], ptyPrebuild: 'darwin-x64',
  },
  'darwin-arm64': {
    platform: 'darwin', arch: 'arm64', libc: null, runner: 'macos-latest', alpine: false,
    natives: ['@vscode/ripgrep-darwin-arm64', '@parcel/watcher-darwin-arm64'], ptyPrebuild: 'darwin-arm64',
  },
  'win32-x64': {
    platform: 'win32', arch: 'x64', libc: null, runner: 'windows-latest', alpine: false,
    natives: ['@vscode/ripgrep-win32-x64', '@koromix/koffi-win32-x64'], ptyPrebuild: 'win32-x64',
  },
  'win32-arm64': {
    platform: 'win32', arch: 'arm64', libc: null, runner: 'windows-11-arm', alpine: false,
    natives: ['@vscode/ripgrep-win32-arm64', '@koromix/koffi-win32-arm64'], ptyPrebuild: 'win32-arm64',
  },
};

// A clean Alpine target holding only the prerequisites docs/release.md "Server packages" names, where the Alpine legs
// self-test; pinned by its multi-arch index digest.
export const ALPINE_TARGET_IMAGE = 'alpine:3.24@sha256:be2656061b536c1883c4034790e21d0a09c5aaaf51968b89368a3c0371ea2c9a';
export const ALPINE_PREREQUISITES = ['libstdc++', 'libgcc'];

/**
 * The Node releases a server package may bundle: the ABI Electron must report, each target's archive, and the
 * node:<version>-alpine image, by its multi-arch index digest, the Alpine legs build node-pty in.
 */
export const NODE_RELEASES = {
  '24.22.0': {
    modules: '150',
    napi: '10',
    alpineImage: 'node:24.22.0-alpine3.24@sha256:44fce696f38ba8c987c4db89954051000bbd05ffd8d8659ba15ed4a8602e937f',
    archives: {
      'linux-x64': { url: `${NODE_DIST}/v24.22.0/node-v24.22.0-linux-x64.tar.gz`, sha256: '28ea0a438de9a13bd7891fd758eee6c7819ee8af5442dfd8d45bd65e56d4228c' },
      'linux-arm64': { url: `${NODE_DIST}/v24.22.0/node-v24.22.0-linux-arm64.tar.gz`, sha256: 'b7e7991d5407815adfa74a2a9cd4db683552c8ce32ff4a295c22e972849c3f5d' },
      'alpine-x64': { url: `${NODE_UNOFFICIAL}/v24.22.0/node-v24.22.0-linux-x64-musl.tar.gz`, sha256: '72cd253fbe0c2539d52208ed098d47b78ff2c32ba76295d8e6b5b0ce067dcba5' },
      'alpine-arm64': { url: `${NODE_UNOFFICIAL}/v24.22.0/node-v24.22.0-linux-arm64-musl.tar.gz`, sha256: '6812a53e5b37fbc32476d6c3511038d2bc3bbd1b3bb348d6c04dd2c70a1c8f4a' },
      'darwin-x64': { url: `${NODE_DIST}/v24.22.0/node-v24.22.0-darwin-x64.tar.gz`, sha256: '495e3f273c645f3c4677d438304cdfc701729ea5dec5728f5c8e76a2dece4b91' },
      'darwin-arm64': { url: `${NODE_DIST}/v24.22.0/node-v24.22.0-darwin-arm64.tar.gz`, sha256: '6a9724d9b50a5f22b4816cded441b5a8d9ddae546191a5e5b7efa5a5e2ee26d5' },
      'win32-x64': { url: `${NODE_DIST}/v24.22.0/node-v24.22.0-win-x64.zip`, sha256: 'f9683a19877e12a9b167305c8db71040d812876359de21f0d2e97c3f321f80c3' },
      'win32-arm64': { url: `${NODE_DIST}/v24.22.0/node-v24.22.0-win-arm64.zip`, sha256: '3a5c209a5bc59e65b3bc0fa13ed5e166a26bd3d55332847f498b76b037408d61' },
    },
  },
};

/** The versions the installed Electron reports when run as Node: `{ node, modules, napi, electron }`. */
export function electronNodeVersions(electronPath = createRequire(import.meta.url)('electron')) {
  const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1' };
  const script = 'process.stdout.write(JSON.stringify({ node: process.versions.node, modules: process.versions.modules, napi: process.versions.napi, electron: process.versions.electron }))';
  const result = spawnSync(electronPath, ['-e', script], { env, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`${electronPath} -e failed (${result.status ?? result.error?.message}): ${result.stderr}`);
  return JSON.parse(result.stdout);
}

/** Why `versions` (Electron's) has no pinned Node archives, or undefined when every target's archive is pinned for it. */
export function nodeReleaseProblem(versions, releases = NODE_RELEASES) {
  const release = releases[versions.node];
  if (!release) return `Electron ${versions.electron} embeds Node ${versions.node}, which has no pinned archives in scripts/server-targets.mjs NODE_RELEASES (pinned: ${Object.keys(releases).join(', ')}).`;
  if (release.modules !== versions.modules || release.napi !== versions.napi) {
    return `Electron ${versions.electron} embeds Node ${versions.node} with modules ${versions.modules} and napi ${versions.napi}, but NODE_RELEASES pins modules ${release.modules} and napi ${release.napi}.`;
  }
  const missing = Object.keys(SERVER_TARGETS).filter((target) => !release.archives[target]);
  if (missing.length) return `NODE_RELEASES ${versions.node} has no archive for ${missing.join(', ')}.`;
  if (!release.alpineImage) return `NODE_RELEASES ${versions.node} pins no alpineImage.`;
  return undefined;
}

/** The package file name of `target` at `version`: a .zip for Windows, unpacked there by tar.exe, else a .tar.gz. */
export function serverArtifact(target, version) {
  const spec = SERVER_TARGETS[target];
  if (!spec) throw new Error(`Unknown server target ${target}; known: ${Object.keys(SERVER_TARGETS).join(', ')}`);
  return `damocles-server-${version}-${target}.${spec.platform === 'win32' ? 'zip' : 'tar.gz'}`;
}

/** The pinned archive of `target` for Node `version`; throws when it is not pinned. */
export function nodeArchive(target, version, releases = NODE_RELEASES) {
  const archive = releases[version]?.archives[target];
  if (!archive) throw new Error(`No Node ${version} archive is pinned for ${target} in scripts/server-targets.mjs.`);
  return archive;
}

/** The Node version the server packages bundle: Electron's, checked against the pinned archives. */
export function serverNodeVersion() {
  const versions = electronNodeVersions();
  const problem = nodeReleaseProblem(versions);
  if (problem) throw new Error(problem);
  return versions.node;
}

function main() {
  try {
    const version = serverNodeVersion();
    if (process.argv.includes('--github-outputs')) console.log(`version=${version}\nalpine-build-image=${NODE_RELEASES[version].alpineImage}\nalpine-target-image=${ALPINE_TARGET_IMAGE}`);
    else console.log(process.argv.includes('--node-version') ? version : `Electron's Node ${version} has pinned archives for all ${Object.keys(SERVER_TARGETS).length} server targets.`);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}

// Gated so importing the module never runs Electron.
if (isEntryPoint(import.meta.url)) main();
