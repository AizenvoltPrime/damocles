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
 *   node scripts/server-targets.ts                   # check the derived Node against the pinned archives
 *   node scripts/server-targets.ts --node-version    # print the derived Node version
 *   node scripts/server-targets.ts --github-outputs  # print version=, alpine-build-image= and alpine-target-image= lines
 */

import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { isEntryPoint } from './entry-point.ts';

const NODE_DIST = 'https://nodejs.org/dist';
const NODE_UNOFFICIAL = 'https://unofficial-builds.nodejs.org/download/release';

export interface ServerTarget {
  platform: 'linux' | 'darwin' | 'win32';
  arch: 'x64' | 'arm64';
  libc: 'glibc' | 'musl' | null;
  runner: string;
  alpine: boolean;
  natives: string[];
  ptyPrebuild: string;
}

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
} satisfies Record<string, ServerTarget>;

export type ServerTargetName = keyof typeof SERVER_TARGETS;

export function isServerTarget(name: string): name is ServerTargetName {
  return Object.hasOwn(SERVER_TARGETS, name);
}

export const SERVER_TARGET_NAMES: ServerTargetName[] = Object.keys(SERVER_TARGETS).filter(isServerTarget);

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
export interface NodeArchive { url: string; sha256: string }

export interface NodeRelease {
  modules: string;
  napi: string;
  alpineImage: string;
  archives: Partial<Record<string, NodeArchive>>;
}

/** A release as nodeReleaseProblem checks it, which may still lack its Alpine image. */
export type PinnedReleases = Record<string, Omit<NodeRelease, 'alpineImage'> & { alpineImage?: string }>;

export const NODE_RELEASES: Record<string, NodeRelease> = {
  '24.22.3': {
    modules: '150',
    napi: '10',
    alpineImage: 'node:24.22.3-alpine3.24@sha256:116b800c3754b440ee0aa3ed2f20f5bf3d99a554bfd9adeea09ea8017f6e85f5',
    archives: {
      'linux-x64': { url: `${NODE_DIST}/v24.22.3/node-v24.22.3-linux-x64.tar.gz`, sha256: '061ec3e3062115705b56b51fa9cc330ab50d34b6969387d4e4b1a50c6809acc2' },
      'linux-arm64': { url: `${NODE_DIST}/v24.22.3/node-v24.22.3-linux-arm64.tar.gz`, sha256: '261af2af250dfd7e9f25cf151d1b2713a0adf8f10a9ad116c4947f68627affe8' },
      'alpine-x64': { url: `${NODE_UNOFFICIAL}/v24.22.3/node-v24.22.3-linux-x64-musl.tar.gz`, sha256: '2db4f8a40abe5f5b5d119964223fedc9c4c7c5e7c632901ae860af522c7844b2' },
      'alpine-arm64': { url: `${NODE_UNOFFICIAL}/v24.22.3/node-v24.22.3-linux-arm64-musl.tar.gz`, sha256: '248c96a84f6c8338646b9fd73bf125124678f8fb08db5f23023f462055e0eedc' },
      'darwin-x64': { url: `${NODE_DIST}/v24.22.3/node-v24.22.3-darwin-x64.tar.gz`, sha256: '977614af0504c81045e7fd85596dbca0e5f951b96681516dadafedcca8c447f7' },
      'darwin-arm64': { url: `${NODE_DIST}/v24.22.3/node-v24.22.3-darwin-arm64.tar.gz`, sha256: 'ff6e17d4874b76d272212b908cc020d6e815fba5a6c7eaaa06add725840307fd' },
      'win32-x64': { url: `${NODE_DIST}/v24.22.3/node-v24.22.3-win-x64.zip`, sha256: 'e612af99f626ab415ea225af6bce5c971feb448cb5cae250bb1c3fa50c5f7d9f' },
      'win32-arm64': { url: `${NODE_DIST}/v24.22.3/node-v24.22.3-win-arm64.zip`, sha256: 'b3cc74a295b39d4f273271e96f58c06dd2b35757ca12abec64c7d0598b434f14' },
    },
  },
};

/** `electron` is absent when the executable is plain Node. */
export interface ElectronVersions { node: string; modules: string; napi: string; electron?: string }

/** The versions the installed Electron reports when run as Node. */
export function electronNodeVersions(electronPath: string = createRequire(import.meta.url)('electron')): ElectronVersions {
  const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1' };
  const script = 'process.stdout.write(JSON.stringify({ node: process.versions.node, modules: process.versions.modules, napi: process.versions.napi, electron: process.versions.electron }))';
  const result = spawnSync(electronPath, ['-e', script], { env, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`${electronPath} -e failed (${result.status ?? result.error?.message}): ${result.stderr}`);
  return JSON.parse(result.stdout) as ElectronVersions;
}

/** Why `versions` (Electron's) has no pinned Node archives, or undefined when every target's archive is pinned for it. */
export function nodeReleaseProblem(versions: ElectronVersions, releases: PinnedReleases = NODE_RELEASES): string | undefined {
  const release = releases[versions.node];
  if (!release) return `Electron ${versions.electron} embeds Node ${versions.node}, which has no pinned archives in scripts/server-targets.ts NODE_RELEASES (pinned: ${Object.keys(releases).join(', ')}).`;
  if (release.modules !== versions.modules || release.napi !== versions.napi) {
    return `Electron ${versions.electron} embeds Node ${versions.node} with modules ${versions.modules} and napi ${versions.napi}, but NODE_RELEASES pins modules ${release.modules} and napi ${release.napi}.`;
  }
  const missing = Object.keys(SERVER_TARGETS).filter((target) => !release.archives[target]);
  if (missing.length) return `NODE_RELEASES ${versions.node} has no archive for ${missing.join(', ')}.`;
  if (!release.alpineImage) return `NODE_RELEASES ${versions.node} pins no alpineImage.`;
  return undefined;
}

/** The package file name of `target` at `version`: a .zip for Windows, unpacked there by tar.exe, else a .tar.gz. */
export function serverArtifact(target: string, version: string): string {
  return `damocles-server-${version}-${target}.${serverTarget(target).platform === 'win32' ? 'zip' : 'tar.gz'}`;
}

/** The spec of `target`; throws on a name SERVER_TARGETS does not hold. */
export function serverTarget(target: string): ServerTarget {
  if (!isServerTarget(target)) throw new Error(`Unknown server target ${target}; known: ${Object.keys(SERVER_TARGETS).join(', ')}`);
  return SERVER_TARGETS[target];
}

/** The pinned archive of `target` for Node `version`; throws when it is not pinned. */
export function nodeArchive(target: string, version: string, releases: PinnedReleases = NODE_RELEASES): NodeArchive {
  const archive = releases[version]?.archives[target];
  if (!archive) throw new Error(`No Node ${version} archive is pinned for ${target} in scripts/server-targets.ts.`);
  return archive;
}

/** The Node version the server packages bundle: Electron's, checked against the pinned archives. */
export function serverNodeVersion(): string {
  const versions = electronNodeVersions();
  const problem = nodeReleaseProblem(versions);
  if (problem) throw new Error(problem);
  return versions.node;
}

function main() {
  try {
    const version = serverNodeVersion();
    if (process.argv.includes('--github-outputs')) console.log(`version=${version}\nalpine-build-image=${NODE_RELEASES[version]?.alpineImage}\nalpine-target-image=${ALPINE_TARGET_IMAGE}`);
    else console.log(process.argv.includes('--node-version') ? version : `Electron's Node ${version} has pinned archives for all ${Object.keys(SERVER_TARGETS).length} server targets.`);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}

// Gated so importing the module never runs Electron.
if (isEntryPoint(import.meta.url)) main();
