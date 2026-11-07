/**
 * Runs the remote end-to-end suite (playwright.remote.config.ts): test:desktop's setup, the server packages and sshd fixture
 * images the selected specs need, then Playwright with every argument given here. A Node script, because npm passes
 * arguments only to the last command of a chained script.
 *
 *   npm run test:remote [-- <playwright args>]                  # the Docker sshd suite
 *   npm run test:remote -- --grep @windows-target               # the Windows target suite, against this runner's sshd
 *   DAMOCLES_E2E_PACKAGED_APP=<app> npm run test:remote         # the @packaged specs against a packaged app
 *   DAMOCLES_E2E_PREBUILT=app,server-packages npm run test:remote  # skips what an earlier run or job built
 *   node scripts/test-remote.ts --build-server-packages linux-x64,alpine-x64  # only builds those packages
 *
 * A target suite (@windows-target, @darwin-target) runs only when --grep names its tag. The specs Playwright selects (its own
 * --list, so --grep, --shard and file arguments apply) decide the fixture images and server packages: ubuntu and the Linux
 * package for any Docker spec, the Alpine package with the alpine image; for a @wsl spec, which starts no fixture container,
 * the Linux and Alpine packages its distros install from the app's cache; and for a @devcontainer spec the same two packages,
 * which its dev containers install, with the sshd fixture images only for a spec that starts one (`sshd(`). Building the
 * Alpine package compiles node-pty in the pinned Alpine build image with docker, once per node-pty version, Node version and
 * image pin (dist/server-packages/.cache), so a run on a machine without Docker needs that file or
 * DAMOCLES_E2E_PREBUILT=server-packages. A compile needs `docker buildx` (bundled with Docker Desktop, a separate plugin on
 * docker-ce) and registry access to resolve the architecture's image; the other architecture's runs emulated, which on Linux
 * docker-ce needs binfmt/QEMU registered (`docker run --privileged --rm tonistiigi/binfmt --install arm64,amd64`).
 */

import { spawnSync } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, rmSync } from 'node:fs';
import { arch } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isEntryPoint } from './entry-point.ts';
import { npmCliPath } from './npm-cli.ts';
import { ALPINE_TARGET_IMAGE, NODE_RELEASES, SERVER_TARGETS, isServerTarget, serverArtifact, serverNodeVersion, type ServerTarget, type ServerTargetName } from './server-targets.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const IMAGES_DIR = join(ROOT, 'e2e', 'remote', 'support', 'images');
// e2e/remote/support/sshd.ts FixtureImage, imageTag, FIXTURE_LABEL, RUN_LABEL and RUN_ENV
const FIXTURE_IMAGES = ['ubuntu', 'alpine', 'centos7'] as const;
type FixtureImage = (typeof FIXTURE_IMAGES)[number];
const FIXTURE_LABEL = 'damocles-e2e-sshd';
const RUN_LABEL = 'damocles-e2e-run';
const RUN_ENV = 'DAMOCLES_E2E_RUN';
// alpine.Dockerfile's ARG: the clean Alpine the server packages self-test in
const IMAGE_BUILD_ARGS: Partial<Record<FixtureImage, string[]>> = { alpine: ['--build-arg', `ALPINE_IMAGE=${ALPINE_TARGET_IMAGE}`] };
const TARGET_SUITES = { '@windows-target': 'win32', '@darwin-target': 'darwin' } as const;
export type TargetTag = keyof typeof TARGET_SUITES;

function isTargetTag(tag: string): tag is TargetTag {
  return Object.hasOwn(TARGET_SUITES, tag);
}
const SERVER_PACKAGES_DIR = join(ROOT, 'dist', 'server-packages');
const PTY_CACHE = join(SERVER_PACKAGES_DIR, '.cache');
// scripts/build-server.ts MANIFEST_PATH, the dev manifest the unpackaged app reads
const MANIFEST_PATH = join(ROOT, 'dist', 'desktop', 'server-manifest.json');
const PREBUILT_PARTS = ['app', 'server-packages'];
const BUILD_SERVER_PACKAGES = '--build-server-packages';
// e2e/remote/support/wsl.ts WSL_TAG as Playwright's JSON listing names it: a test carrying it reaches WSL distros through
// wsl.exe, never a Docker fixture
const WSL_TAG = 'wsl';
// e2e/remote/support/devcontainer.ts DEVCONTAINER_TAG: a test carrying it builds containers on an engine, which install the
// Linux or Alpine package from the app's cache; it starts an sshd fixture only when its spec calls sshd(
const DEVCONTAINER_TAG = 'devcontainer';

/** A spec in Playwright's JSON listing, as far as this script reads it. */
interface ListedSpec {
  tags?: string[];
}

interface ListedSuite {
  specs?: ListedSpec[];
  suites?: ListedSuite[];
}

/** Playwright's JSON report of a --list run, as far as this script reads it: one top-level suite per spec file. */
export interface ListReport {
  config: { rootDir: string };
  suites: (ListedSuite & { file: string })[];
}

export interface SpecFiles {
  docker: string[];
  wsl: string[];
  devcontainer: string[];
}

/** Which fixtures fixturesToRemove picks: one run's, or every one whose run is no live process. */
export type FixtureSelection = { run: string; alive?: (pid: number) => boolean } | { run?: undefined; alive: (pid: number) => boolean };

// An entry of an OCI image index, as docker buildx imagetools inspect --raw prints it.
interface IndexManifest {
  digest: string;
  platform?: { os?: string; architecture?: string };
}

// scripts/build-server.ts's dev manifest, as far as this script reads it
interface DevManifest {
  packages: Partial<Record<string, { file?: string }>>;
}

interface ProcessOptions {
  env?: NodeJS.ProcessEnv;
  shell?: boolean;
}

/** The --grep pattern among Playwright's arguments, in any of its spellings; undefined without one. */
export function grepOf(args: string[]): string | undefined {
  for (const [i, arg] of args.entries()) {
    if (arg === '--grep' || arg === '-g') return args[i + 1];
    if (arg.startsWith('--grep=')) return arg.slice('--grep='.length);
  }
  return undefined;
}

/** What `grep` selects: the target suites it names, and whether anything else (the Docker suite) may match. */
export function selection(grep: string | undefined): { targets: TargetTag[]; docker: boolean } {
  const alternatives = grep === undefined ? [] : grep.split('|').map((part) => part.trim());
  const targets = Object.keys(TARGET_SUITES).filter(isTargetTag).filter((tag) => alternatives.includes(tag));
  const docker = grep === undefined || alternatives.some((part) => !(part in TARGET_SUITES));
  return { targets, docker };
}

/** What DAMOCLES_E2E_PREBUILT names as built already: `app` (test:desktop's setup) and `server-packages` (dist/server-packages). */
export function prebuiltParts(value = ''): Set<string> {
  const parts = value.split(',').map((part) => part.trim()).filter(Boolean);
  const unknown = parts.filter((part) => !PREBUILT_PARTS.includes(part));
  if (unknown.length) throw new Error(`DAMOCLES_E2E_PREBUILT names ${unknown.join(', ')}; it takes ${PREBUILT_PARTS.join(', ')}`);
  return new Set(parts);
}

/** `playwright test`'s arguments for this script's `args`: the remote config and, unless `args` names one, the dev project. */
export function playwrightArgs(args: string[], packaged = false): string[] {
  // the review captures run only when asked for with --project=screenshots, as in test:desktop; one token, because
  // Playwright's --project takes every value after it and `--project dev <spec>` would read the spec as a project
  const project = packaged || args.some((arg) => arg === '--project' || arg.startsWith('--project=')) ? [] : ['--project=dev'];
  return ['--config', 'playwright.remote.config.ts', ...project, ...args];
}

/** The targets `--build-server-packages <target>,...` names, each a SERVER_TARGETS key. */
export function serverPackageTargets(list = ''): ServerTargetName[] {
  const targets = list.split(',').filter(Boolean);
  const unknown = targets.filter((target) => !isServerTarget(target));
  if (!targets.length || unknown.length) throw new Error(`${BUILD_SERVER_PACKAGES} takes a comma-separated list of ${Object.keys(SERVER_TARGETS).join(', ')}${unknown.length ? `, not ${unknown.join(', ')}` : ''}`);
  return targets.filter(isServerTarget);
}

function reportTests(suite: ListedSuite): ListedSpec[] {
  return [...(suite.specs ?? []), ...(suite.suites ?? []).flatMap(reportTests)];
}

/**
 * The spec files of a Playwright JSON report, absolute and each once: `wsl`, those with a test tagged @wsl; `devcontainer`,
 * those with one tagged @devcontainer; `docker`, those with any other test.
 */
export function specFilesOf(report: ListReport): SpecFiles {
  const docker = new Set<string>();
  const wsl = new Set<string>();
  const devcontainer = new Set<string>();
  for (const suite of report.suites) {
    const file = resolve(report.config.rootDir, suite.file);
    for (const test of reportTests(suite)) (test.tags?.includes(WSL_TAG) ? wsl : test.tags?.includes(DEVCONTAINER_TAG) ? devcontainer : docker).add(file);
  }
  return { docker: [...docker], wsl: [...wsl], devcontainer: [...devcontainer] };
}

/** The sources of the @devcontainer specs that start an sshd fixture, whose images the run builds. */
export function sshdSources(sources: string[]): string[] {
  return sources.filter((source) => /\bsshd\(/.test(source));
}

/** The fixture images specs with these sources start: ubuntu, the default, and every image an `image: '<name>'` option names. */
export function fixtureImagesIn(sources: string[]): FixtureImage[] {
  const images = new Set<string>(sources.length ? ['ubuntu'] : []);
  for (const source of sources) for (const [, image] of source.matchAll(/\bimage:\s*'(\w+)'/g)) if (image) images.add(image);
  return FIXTURE_IMAGES.filter((image) => images.has(image));
}

/**
 * The server packages a run needs: the Linux one for the fixtures, the Alpine one for its image, both for WSL distros and for
 * dev containers, and each target suite's.
 */
export function serverTargetsFor(images: FixtureImage[], targets: TargetTag[], cpu: string = arch(), wsl = false, devcontainer = false): string[] {
  return [...new Set([
    ...(images.length || wsl || devcontainer ? [`linux-${cpu}`] : []),
    ...(images.includes('alpine') || wsl || devcontainer ? [`alpine-${cpu}`] : []),
    ...targets.map((tag) => `${TARGET_SUITES[tag]}-${cpu}`),
  ])];
}

/**
 * The fixtures to remove among `listed` (docker's `<id>\t<run label>` lines): with `run`, only that run's; without it, every
 * one whose run is no live process, so another run's live fixtures stay.
 */
export function fixturesToRemove(listed: string, which: FixtureSelection): string[] {
  const removes = (owner: string): boolean => (which.run !== undefined ? owner === which.run : !(/^\d+$/.test(owner) && which.alive(Number(owner))));
  return listed.split('\n').flatMap((line) => {
    const [id = '', owner = ''] = line.trim().split('\t');
    return id && removes(owner) ? [id] : [];
  });
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err instanceof Error && 'code' in err && err.code === 'EPERM';
  }
}

function run(command: string, args: string[], options: ProcessOptions = {}): void {
  console.log(`> ${[command, ...args].join(' ')}`);
  const result = spawnSync(command, args, { cwd: ROOT, stdio: 'inherit', ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${[command, ...args].join(' ')} exited with ${result.status ?? result.signal}`);
}

function output(command: string, args: string[], options: ProcessOptions = {}): string {
  const result = spawnSync(command, args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${[command, ...args].join(' ')} exited with ${result.status ?? result.signal}: ${result.stderr.trim() || result.stdout.trim().slice(0, 4000)}`);
  return result.stdout;
}

const npm = (...args: string[]): void => run(process.execPath, [npmCliPath(), ...args]);

// test:desktop's own commands up to its Playwright run, so both suites build the app the same way.
function desktopSetup() {
  const { scripts } = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { scripts: { 'test:desktop': string } };
  const steps = scripts['test:desktop'].split(' && ');
  const playwright = steps.findIndex((step) => step.startsWith('playwright '));
  if (playwright === -1) throw new Error('package.json test:desktop no longer ends with its playwright run');
  for (const step of steps.slice(0, playwright)) run(step, [], { shell: true });
}

// ELF e_machine of each server target arch
const ELF_MACHINE = { x64: 0x3e, arm64: 0xb7 } satisfies Record<ServerTarget['arch'], number>;

/** Whether `data` starts with an ELF header whose e_machine (uint16 LE at offset 18) is `cpu`'s, a SERVER_TARGETS arch. */
export function isElfFor(data: Buffer, cpu: ServerTarget['arch']): boolean {
  return data.length >= 20 && data.readUInt32BE(0) === 0x7f454c46 && data.readUInt16LE(18) === ELF_MACHINE[cpu];
}

function builtFor(file: string, cpu: ServerTarget['arch']): boolean {
  const fd = openSync(file, 'r');
  try {
    const header = Buffer.alloc(20);
    return isElfFor(header.subarray(0, readSync(fd, header, 0, 20, 0)), cpu);
  } finally {
    closeSync(fd);
  }
}

// node-pty compiled against musl in the pinned Alpine build image, as the release's Alpine legs build it; kept per version and
// index digest, which fixes each architecture's image digest.
export function muslNodePty(target: string, nodeVersion: string): string {
  const { version } = JSON.parse(readFileSync(join(ROOT, 'node_modules', 'node-pty', 'package.json'), 'utf8')) as { version: string };
  const release = NODE_RELEASES[nodeVersion];
  if (!release) throw new Error(`Node ${nodeVersion} is not in NODE_RELEASES`);
  if (!isServerTarget(target)) throw new Error(`${target} is not a server target`);
  const { alpineImage } = release;
  const cpu = SERVER_TARGETS[target].arch;
  const digest = alpineImage.split('@sha256:')[1];
  if (!digest) throw new Error(`${alpineImage} is not pinned by digest`);
  const pin = digest.slice(0, 12);
  const out = join(PTY_CACHE, `node-pty-${version}-${target}-node-${nodeVersion}-${pin}.node`);
  if (existsSync(out)) {
    if (builtFor(out, cpu)) return out;
    console.log(`${out} is not an ${cpu} ELF binary; rebuilding it`);
    rmSync(out);
  }
  mkdirSync(PTY_CACHE, { recursive: true });
  const cache = relative(ROOT, PTY_CACHE).split('\\').join('/');
  const script = [
    'set -e',
    'apk add --no-cache python3 make g++ linux-headers',
    'mkdir -p /build/node_modules',
    'cp -a /work/node_modules/node-pty /work/node_modules/node-addon-api /build/node_modules/',
    'cd /build/node_modules/node-pty',
    'rm -rf build',
    'node /usr/local/lib/node_modules/npm/node_modules/node-gyp/bin/node-gyp.js rebuild',
    `cp build/Release/pty.node "/work/${cache}/${out.slice(PTY_CACHE.length + 1)}"`,
  ].join('\n');
  const dockerArch = cpu === 'x64' ? 'amd64' : 'arm64';
  run('docker', ['run', '--rm', '--platform', `linux/${dockerArch}`, '-v', `${ROOT}:/work`, platformImage(alpineImage, dockerArch), 'sh', '-c', script]);
  if (!builtFor(out, cpu)) {
    rmSync(out, { force: true });
    throw new Error(`The node-pty built for ${target} is not an ${cpu} ELF binary`);
  }
  return out;
}

/** `image` (a `name:tag@digest` multi-arch index reference) by the digest of its linux/`dockerArch` entry in `index`, the index's JSON. */
export function platformDigestRef(image: string, index: unknown, dockerArch: string): string {
  const at = image.indexOf('@');
  if (at === -1) throw new Error(`${image} is not pinned by digest`);
  const manifests: unknown = typeof index === 'object' && index !== null && 'manifests' in index ? index.manifests : undefined;
  if (!Array.isArray(manifests)) throw new Error(`${image} is not a multi-arch index`);
  const entry = (manifests as IndexManifest[]).find((manifest) => manifest.platform?.os === 'linux' && manifest.platform.architecture === dockerArch);
  if (!entry) throw new Error(`${image} has no linux/${dockerArch} image`);
  return `${image.slice(0, at)}@${entry.digest}`;
}

// By the platform's own digest: Docker's classic image store holds one platform per reference, so a second platform of the
// index's digest fails with "cannot overwrite digest".
function platformImage(image: string, dockerArch: string): string {
  return platformDigestRef(image, JSON.parse(output('docker', ['buildx', 'imagetools', 'inspect', '--raw', image])), dockerArch);
}

function serverPackages(targets: string[]): void {
  const nodeVersion = serverNodeVersion();
  for (const target of targets) {
    const pty = target.startsWith('alpine-') ? ['--node-pty-binary', muslNodePty(target, nodeVersion)] : [];
    npm('run', 'build:server', '--', '--target', target, ...pty);
  }
}

function checkPrebuiltPackages(targets: string[]): void {
  const { version } = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { version: string };
  const manifest: DevManifest = existsSync(MANIFEST_PATH) ? (JSON.parse(readFileSync(MANIFEST_PATH, 'utf8')) as DevManifest) : { packages: {} };
  const missing = targets.filter((target) => manifest.packages[target]?.file !== serverArtifact(target, version) || !existsSync(join(SERVER_PACKAGES_DIR, serverArtifact(target, version))));
  if (missing.length) throw new Error(`DAMOCLES_E2E_PREBUILT names server-packages, but ${relative(ROOT, SERVER_PACKAGES_DIR)} or ${relative(ROOT, MANIFEST_PATH)} lacks ${missing.join(', ')}`);
}

/** The specs Playwright selects for `args`, by its own --list: `{ docker, wsl, devcontainer }` as specFilesOf splits them. */
function selectedSpecs(cli: string, args: string[], env: NodeJS.ProcessEnv): SpecFiles {
  return specFilesOf(JSON.parse(output(process.execPath, [cli, 'test', ...args, '--list', '--reporter=json'], { env })) as ListReport);
}

// Containers before networks: a network with a container attached cannot be removed.
function removeFixtures(which: FixtureSelection): void {
  const format = `{{.ID}}\t{{.Label "${RUN_LABEL}"}}`;
  const containers = fixturesToRemove(output('docker', ['ps', '-a', '--filter', `label=${FIXTURE_LABEL}`, '--format', format]), which);
  if (containers.length) run('docker', ['rm', '-f', '-v', ...containers]);
  const networks = fixturesToRemove(output('docker', ['network', 'ls', '--filter', `label=${FIXTURE_LABEL}`, '--format', format]), which);
  if (networks.length) run('docker', ['network', 'rm', ...networks]);
}

function fixtureImages(images: FixtureImage[]): void {
  for (const image of images) {
    run('docker', ['build', '-q', '-t', `damocles-e2e-sshd-${image}`, ...(IMAGE_BUILD_ARGS[image] ?? []), '-f', join(IMAGES_DIR, `${image}.Dockerfile`), IMAGES_DIR]);
  }
}

function main() {
  const args = process.argv.slice(2);
  if (args[0] === BUILD_SERVER_PACKAGES) {
    serverPackages(serverPackageTargets(args[1]));
    return;
  }
  const prebuilt = prebuiltParts(process.env.DAMOCLES_E2E_PREBUILT);
  const packaged = !!process.env.DAMOCLES_E2E_PACKAGED_APP;
  const { targets, docker } = selection(grepOf(args));
  const cli = join(ROOT, 'node_modules', '@playwright', 'test', 'cli.js');
  const playwright = playwrightArgs(args, packaged);
  const runId = String(process.pid);
  const env = { ...process.env, DAMOCLES_E2E_REMOTE_TARGETS: targets.join(','), [RUN_ENV]: runId };
  const specs: SpecFiles = docker && !packaged ? selectedSpecs(cli, playwright, env) : { docker: [], wsl: [], devcontainer: [] };
  const images = fixtureImagesIn([...specs.docker, ...specs.devcontainer.filter((file) => sshdSources([readFileSync(file, 'utf8')]).length > 0)].map((file) => readFileSync(file, 'utf8')));
  if (!packaged) {
    if (!prebuilt.has('app')) desktopSetup();
    const packages = serverTargetsFor(images, targets, arch(), specs.wsl.length > 0, specs.devcontainer.length > 0);
    if (prebuilt.has('server-packages')) checkPrebuiltPackages(packages);
    else serverPackages(packages);
  }
  if (images.length) {
    removeFixtures({ alive: isAlive });
    fixtureImages(images);
  }
  try {
    run(process.execPath, [cli, 'test', ...playwright], { env });
  } finally {
    if (images.length) removeFixtures({ run: runId });
  }
}

if (isEntryPoint(import.meta.url)) {
  try {
    main();
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}
