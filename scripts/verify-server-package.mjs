/**
 * Checks one server package, in the checkout that built it:
 *
 *   node scripts/verify-server-package.mjs --target <target> <archive> [--node-version <v>] [--node-pty-binary <pty.node>]
 *     [--require-self-test | --skip-self-test]
 *
 * - the bytes: the same inputs assemble the identical archive, so the file list is exact and the build reproducible;
 * - the Node it bundles is the version Electron embeds;
 * - exactly one node-pty prebuild, the target's, and on darwin, linux and alpine exactly one @parcel/watcher prebuild for
 *   the target and its libc;
 * - dist/subscription-plugin/ holds the subscription plugin whose digest subscription-pin.ts pins, with its LICENSE;
 * - on glibc targets, no ELF file needs a symbol version newer than GLIBC_2.28 or GLIBCXX_3.4.25 (readelf);
 * - on Alpine, Node, node-pty and the watcher link against musl;
 * - dist/git-credential/ holds the git credential relay helpers, the .sh with LF line ends and the .cmd with CRLF;
 * - the launcher and every other executable are mode 0755, and the gzip header is normalized;
 * - on the machine's own target, `bin/damocles-server self-test` passes; --require-self-test fails on another machine, and
 *   --skip-self-test leaves it to the caller (the release's Alpine legs run it in a clean container).
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { archiveOf, loaded, modeOf, STAGE_DIR, targetEntries } from './build-server.mjs';
import { isEntryPoint } from './entry-point.mjs';
import { gzipHeader, readTarGz, readZip, sha256 } from './server-archive.mjs';
import { SERVER_TARGETS, serverNodeVersion } from './server-targets.mjs';
import { subscriptionPluginProblems } from './subscription-plugin.mjs';

export const GLIBC_CEILING = '2.28';
export const GLIBCXX_CEILING = '3.4.25';

function newer(version, ceiling) {
  const a = version.split('.').map(Number);
  const b = ceiling.split('.').map(Number);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
  }
  return false;
}

/** Problems with the git credential relay helpers a daemon's core gives git (src/core/scm/askpass/credential-relay.ts). */
export function credentialRelayProblems(entries) {
  const problems = [];
  const sh = entries.find((entry) => entry.path === 'dist/git-credential/git-credential-relay.sh');
  const cmd = entries.find((entry) => entry.path === 'dist/git-credential/git-credential-relay.cmd');
  if (!sh || sh.data.length === 0) problems.push('no dist/git-credential/git-credential-relay.sh');
  else if (sh.data.includes(0x0d) || !sh.data.toString('utf8').startsWith('#!/bin/sh\n')) problems.push('dist/git-credential/git-credential-relay.sh is not an LF sh script');
  if (!cmd || cmd.data.length === 0) problems.push('no dist/git-credential/git-credential-relay.cmd');
  // .gitattributes keeps it CRLF: cmd.exe misparses a batch file with LF line ends, a label search above all
  else if (/(?<!\r)\n/.test(cmd.data.toString('utf8'))) problems.push('dist/git-credential/git-credential-relay.cmd is not a CRLF batch file');
  return problems;
}

/** The GLIBC_ and GLIBCXX_ versions in `readelf -V` output above the ceilings. */
export function symbolVersionProblems(readelfOutput) {
  const problems = new Set();
  for (const [, family, version] of readelfOutput.matchAll(/\b(GLIBCXX|GLIBC)_(\d+(?:\.\d+)+)\b/g)) {
    const ceiling = family === 'GLIBC' ? GLIBC_CEILING : GLIBCXX_CEILING;
    if (newer(version, ceiling)) problems.add(`${family}_${version}`);
  }
  return [...problems].sort();
}

/** Problems with the prebuilds of `spec` among the archive's paths. */
export function prebuildProblems(spec, paths) {
  const problems = [];
  const ptyDirs = new Set(paths.map((path) => /^node_modules\/node-pty\/prebuilds\/([^/]+)\//.exec(path)?.[1]).filter(Boolean));
  if (ptyDirs.size !== 1 || !ptyDirs.has(spec.ptyPrebuild)) problems.push(`node-pty prebuilds ${[...ptyDirs].join(', ') || 'none'}, expected only ${spec.ptyPrebuild}`);
  const ptyBinary = `node_modules/node-pty/prebuilds/${spec.ptyPrebuild}/${spec.platform === 'win32' ? 'conpty.node' : 'pty.node'}`;
  if (!paths.includes(ptyBinary)) problems.push(`no ${ptyBinary}`);
  if (paths.some((path) => path.startsWith('node_modules/node-pty/build/'))) problems.push('node-pty carries a build/ folder, which it would load ahead of the prebuild');
  const watchers = new Set(paths.map((path) => /^node_modules\/(@parcel\/watcher-[^/]+)\//.exec(path)?.[1]).filter(Boolean));
  const expected = spec.natives.filter((name) => name.startsWith('@parcel/watcher-'));
  if ([...watchers].sort().join() !== expected.join()) problems.push(`@parcel/watcher prebuilds ${[...watchers].join(', ') || 'none'}, expected ${expected.join(', ') || 'none'}`);
  for (const name of expected) if (!paths.includes(`node_modules/${name}/watcher.node`)) problems.push(`no node_modules/${name}/watcher.node`);
  return problems;
}

/** The program interpreter, the NEEDED libraries and each library's required versions in `readelf -l -d -V --wide` output. */
export function dynamicLinkage(readelfOutput) {
  const interpreter = /\[Requesting program interpreter: ([^\]]+)\]/.exec(readelfOutput)?.[1] ?? null;
  const needed = [...readelfOutput.matchAll(/\(NEEDED\)\s+Shared library: \[([^\]]+)\]/g)].map((match) => match[1]);
  const versionNeeds = [];
  const section = readelfOutput.split(/^Version needs section .*$/m)[1] ?? '';
  let library = null;
  for (const line of section.split('\n').slice(1)) {
    if (!line.trim()) break;
    const file = /\bFile: (\S+)/.exec(line);
    if (file) library = file[1];
    const name = /\bName: (\S+)/.exec(line);
    if (name && library) versionNeeds.push({ library, version: name[1] });
  }
  return { interpreter, needed, versionNeeds };
}

// Alpine's musl has the soname libc.musl-<arch>.so.1; upstream musl, which cross toolchains link, has libc.so.
const MUSL_LIBC = /^(libc\.musl-[^/]+\.so\.1|libc\.so)$/;

/** Why `linkage` (from dynamicLinkage) of the file at `path` would not load on musl, or links glibc. */
export function muslLinkageProblems(path, { interpreter, needed, versionNeeds }) {
  const problems = [];
  // GCC's libgcc_s exports __register_frame_info under the version GLIBC_2.0 on aarch64 Linux, musl toolchains included.
  const glibcVersion = versionNeeds.some(({ library, version }) => version.startsWith('GLIBC_') && library !== 'libgcc_s.so.1');
  if (/\/ld-linux[^/]*$/.test(interpreter ?? '') || needed.includes('libc.so.6') || glibcVersion) problems.push(`${path} links against glibc`);
  const musl = interpreter ? /\/ld-musl-[^/]+\.so\.1$/.test(interpreter) : needed.some((name) => MUSL_LIBC.test(name));
  if (!musl) problems.push(`${path} shows no musl linkage`);
  return problems;
}

function readelf(args, file) {
  const result = spawnSync('readelf', [...args, file], { encoding: 'utf8' });
  if (result.error || result.status !== 0) throw new Error(`readelf ${args.join(' ')} ${file} failed: ${result.error?.message ?? result.stderr}`);
  return result.stdout;
}

const isElf = (data) => data.length > 4 && data.readUInt32BE(0) === 0x7f454c46;

function elfProblems(spec, entries) {
  const scratch = mkdtempSync(join(tmpdir(), 'damocles-verify-elf-'));
  try {
    const problems = [];
    for (const entry of entries.filter((candidate) => isElf(candidate.data))) {
      const file = join(scratch, entry.path.replaceAll('/', '_'));
      writeFileSync(file, entry.data);
      if (spec.libc === 'glibc') {
        const found = symbolVersionProblems(readelf(['-V', '--wide'], file));
        if (found.length) problems.push(`${entry.path} needs ${found.join(', ')}`);
      }
    }
    if (spec.libc === 'musl') {
      const linked = entries.filter((entry) => entry.path === 'node/node' || /\/(pty|watcher)\.node$/.test(entry.path));
      for (const entry of linked) {
        const file = join(scratch, entry.path.replaceAll('/', '_'));
        problems.push(...muslLinkageProblems(entry.path, dynamicLinkage(readelf(['-l', '-d', '-V', '--wide'], file))));
      }
    }
    return problems;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/** The target this machine runs: its platform and arch, with alpine for a musl Linux. */
export function hostTarget() {
  if (process.platform !== 'linux') return `${process.platform}-${process.arch}`;
  const glibc = process.report.getReport().header.glibcVersionRuntime;
  return `${glibc ? 'linux' : 'alpine'}-${process.arch}`;
}

/** Whether this machine self-tests `target` under `mode` (`require`, `skip` or `auto`): `{ run }`, or why not. */
export function selfTestPlan(mode, host, target) {
  if (mode === 'skip') return { run: false, note: 'self-test skipped: --skip-self-test' };
  if (host === target) return { run: true };
  if (mode === 'require') return { run: false, problem: `this machine is ${host}, not ${target}, and --require-self-test needs the self-test here` };
  return { run: false, note: `self-test skipped: this machine is ${host}, not ${target}` };
}

/** The spawnSync arguments that run the unpacked package's launcher in `dir` with `self-test`. */
export function selfTestCommand(platform, dir) {
  if (platform !== 'win32') return [join(dir, 'bin', 'damocles-server'), ['self-test'], { encoding: 'utf8', timeout: 300_000 }];
  // cmd /s strips the outer quotes and runs the rest, so the launcher path keeps its own quotes for a folder with a space
  const command = `""${join(dir, 'bin', 'damocles-server.cmd')}" self-test"`;
  return [join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'cmd.exe'), ['/d', '/s', '/c', command], { encoding: 'utf8', windowsVerbatimArguments: true, timeout: 300_000 }];
}

function selfTest(spec, archive) {
  const dir = mkdtempSync(join(tmpdir(), 'damocles-server-self-test-'));
  try {
    const windows = spec.platform === 'win32';
    const tar = windows ? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe') : 'tar';
    const unpack = spawnSync(tar, [windows ? '-xf' : '-xzf', archive, '-C', dir], { encoding: 'utf8' });
    if (unpack.status !== 0) return [`${tar} could not unpack the package: ${unpack.stderr}`];
    const run = spawnSync(...selfTestCommand(spec.platform, dir));
    process.stdout.write(run.stdout ?? '');
    if (run.status !== 0) {
      process.stderr.write(run.stderr ?? '');
      return [`self-test exited with ${run.status ?? run.signal ?? run.error?.message}`];
    }
    return [];
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
  }
}

const VALUE_OPTIONS = ['--target', '--node-version', '--node-pty-binary'];

function option(name) {
  const at = process.argv.indexOf(name);
  return at === -1 ? undefined : process.argv[at + 1];
}

async function main() {
  const target = option('--target');
  const spec = SERVER_TARGETS[target];
  const archive = process.argv.slice(2).filter((arg, i, args) => !arg.startsWith('--') && !VALUE_OPTIONS.includes(args[i - 1])).at(-1);
  if (!spec || !archive) throw new Error(`Usage: verify-server-package.mjs --target <${Object.keys(SERVER_TARGETS).join('|')}> <archive>`);
  const data = readFileSync(archive);
  const entries = spec.platform === 'win32' ? readZip(data) : readTarGz(data);
  const paths = entries.map((entry) => entry.path);
  const problems = [];

  const info = JSON.parse(entries.find((entry) => entry.path === 'server-package.json')?.data.toString('utf8') ?? '{}');
  const nodeVersion = option('--node-version') ?? serverNodeVersion();
  if (info.target !== target) problems.push(`server-package.json names target ${info.target}`);
  if (info.node !== nodeVersion) problems.push(`the package bundles Node ${info.node}, Electron embeds ${nodeVersion}`);

  const rebuilt = loaded(await targetEntries(target, { version: info.version, nodeVersion, distDir: join(STAGE_DIR, 'dist'), nodePtyBinary: option('--node-pty-binary') }));
  const again = archiveOf(target, rebuilt);
  if (sha256(again) !== sha256(data)) {
    const expected = new Set(rebuilt.map((entry) => entry.path));
    const missing = [...expected].filter((path) => !paths.includes(path));
    const extra = paths.filter((path) => !expected.has(path));
    problems.push(`the inputs assemble different bytes (missing: ${missing.slice(0, 20).join(', ') || 'none'}; unexpected: ${extra.slice(0, 20).join(', ') || 'none'})`);
  }

  problems.push(...prebuildProblems(spec, paths));
  problems.push(...subscriptionPluginProblems(entries));
  problems.push(...credentialRelayProblems(entries));
  for (const entry of entries) if (entry.mode !== modeOf(entry.path)) problems.push(`${entry.path} has mode ${entry.mode.toString(8)}, expected ${modeOf(entry.path).toString(8)}`);
  if (spec.platform !== 'win32') {
    const header = gzipHeader(data);
    if (header.mtime !== 0 || header.os !== 3) problems.push(`gzip header mtime ${header.mtime} and OS ${header.os}, expected 0 and 3`);
  }
  if (spec.platform === 'linux') problems.push(...elfProblems(spec, entries));
  const plan = selfTestPlan(process.argv.includes('--require-self-test') ? 'require' : process.argv.includes('--skip-self-test') ? 'skip' : 'auto', hostTarget(), target);
  if (plan.problem) problems.push(plan.problem);
  if (plan.note) console.log(plan.note);
  if (problems.length === 0 && plan.run) problems.push(...selfTest(spec, archive));

  if (problems.length) {
    console.error(`${basename(archive)} failed verification:\n- ${problems.join('\n- ')}`);
    process.exit(1);
  }
  console.log(`${basename(archive)} (${target}, ${entries.length} files, sha256 ${sha256(data)}) passed verification.`);
}

if (isEntryPoint(import.meta.url)) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
