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

// The Dev Containers CLI a server package carries for `containers.up`; the daemon runs this file with the package's Node.
export const DEVCONTAINERS_CLI = '@devcontainers/cli';
export const DEVCONTAINERS_CLI_ENTRY = `node_modules/${DEVCONTAINERS_CLI}/devcontainer.js`;

// A clean Alpine target holding only the prerequisites docs/release.md "Server packages" names, where the Alpine legs
// self-test; pinned by its multi-arch index digest.
export const ALPINE_TARGET_IMAGE = 'alpine:3.24@sha256:be2656061b536c1883c4034790e21d0a09c5aaaf51968b89368a3c0371ea2c9a';
export const ALPINE_PREREQUISITES = ['libstdc++', 'libgcc'];

/**
 * The Node releases a server package may bundle: the ABI Electron must report, each target's archive, and the
 * node:<version>-alpine image, by its multi-arch index digest, the Alpine legs build node-pty in.
 */
export const NODE_RELEASES = {
  '24.22.1': {
    modules: '150',
    napi: '10',
    alpineImage: 'node:24.22.1-alpine3.24@sha256:06d7adf3e0ef61a13f1d28682726366f97a15aa1888c934d3ecec86c33918b53',
    archives: {
      'linux-x64': { url: `${NODE_DIST}/v24.22.1/node-v24.22.1-linux-x64.tar.gz`, sha256: 'eb6728e77c576a35162c122c45ccadf224d89ff00abc8dae46cc2897c6002d7c' },
      'linux-arm64': { url: `${NODE_DIST}/v24.22.1/node-v24.22.1-linux-arm64.tar.gz`, sha256: '33c37be234ba8bee041961047b19160f4d7d0f164e8e246f78bdd10feff148b3' },
      'alpine-x64': { url: `${NODE_UNOFFICIAL}/v24.22.1/node-v24.22.1-linux-x64-musl.tar.gz`, sha256: '0a9eddce2d2e8f3addbe94fa46d751325b2d74f7fd1ce63296164d36b6dfc6e5' },
      'alpine-arm64': { url: `${NODE_UNOFFICIAL}/v24.22.1/node-v24.22.1-linux-arm64-musl.tar.gz`, sha256: '8254125825a3e5e834bd8a260dab4c8303f720464a741506ec27989b9ba1769b' },
      'darwin-x64': { url: `${NODE_DIST}/v24.22.1/node-v24.22.1-darwin-x64.tar.gz`, sha256: 'd132557e7ee2b85af08b0c8c34338e65c6430f2238d01f727728ef42dc83b035' },
      'darwin-arm64': { url: `${NODE_DIST}/v24.22.1/node-v24.22.1-darwin-arm64.tar.gz`, sha256: '89c682593d76cd44233fa53b1563264e7de9cbb189cad169135c5b4fadfbc0a7' },
      'win32-x64': { url: `${NODE_DIST}/v24.22.1/node-v24.22.1-win-x64.zip`, sha256: 'd2046d28c2c3dcd211ac5145c0bf30e2047ef9dfb306693c8c6e2eccd8b95fa5' },
      'win32-arm64': { url: `${NODE_DIST}/v24.22.1/node-v24.22.1-win-arm64.zip`, sha256: 'a0c807319fede24c4a0d8f84564c82a619bd313b16b10c007c383c2609e99171' },
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
