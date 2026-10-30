/**
 * Builds the reference server package daemon-upgrade.spec.ts attaches to: the server package of a git ref (the tag
 * `remote-protocol-ref` in CI), versioned `<its version>-ref` so it never shares a package name or an install folder with
 * this tree's. The ref is read with `git archive`, so the clone's index, working tree and refs stay untouched.
 *
 *   node e2e/remote/support/reference-package.mjs --ref <git ref> --target <server target> --out <empty or absent folder>
 *   node e2e/remote/support/reference-package.mjs --ref <git ref> --check
 *
 * Prints the archive's absolute path as its only stdout line; the build's own output goes to stderr. `--check` only checks
 * that the ref names a commit in this clone, so a workflow fails on a missing tag before it builds anything.
 */

import { spawn, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { isEntryPoint } from '../../../scripts/entry-point.mjs';
import { npmCliPath } from '../../../scripts/npm-cli.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
export const REFERENCE_TAG = 'remote-protocol-ref';
// The commit the owner tagged as the oldest protocol peer.
export const REFERENCE_COMMIT = '0c58749c';
const FETCH_GRAMMARS = join('scripts', 'fetch-grammars.mjs');
const GRAMMARS = join('resources', 'grammars');

function option(args, name) {
  const index = args.indexOf(name);
  const value = index === -1 ? undefined : args[index + 1];
  if (value === undefined || value.startsWith('--')) throw new Error(`${name} <value> is required`);
  return value;
}

const npm = (args, cwd) => run(process.execPath, [npmCliPath(), ...args], cwd);

function run(command, args, cwd) {
  process.stderr.write(`> ${[command, ...args].join(' ')}\n`);
  const result = spawnSync(command, args, { cwd, stdio: ['ignore', 2, 2] });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${[command, ...args].join(' ')} exited with ${result.status ?? result.signal}`);
}

/** Why `ref` cannot be built in the clone at `root`, naming the fix; undefined when it names a commit. */
export function refProblem(ref, root = ROOT) {
  const commit = spawnSync('git', ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], { cwd: root, encoding: 'utf8' });
  if (commit.status === 0) return undefined;
  if (ref !== REFERENCE_TAG) return `${ref} names no commit in this clone`;
  return `the tag ${REFERENCE_TAG} is not in this clone. The owner creates and pushes it: git tag ${REFERENCE_TAG} ${REFERENCE_COMMIT} && git push origin ${REFERENCE_TAG}. A CI checkout needs fetch-depth: 0 to get tags.`;
}

/**
 * Copies this tree's grammars into the reference tree when its fetch script is this tree's, so its fetch:grammars finds every
 * file present and downloads nothing; with another script it fetches its own. Returns the names of the files copied.
 */
export function seedGrammars(out, root = ROOT) {
  const script = (dir) => (existsSync(join(dir, FETCH_GRAMMARS)) ? readFileSync(join(dir, FETCH_GRAMMARS), 'utf8').replaceAll('\r\n', '\n') : undefined);
  const theirs = script(out);
  if (theirs === undefined || theirs !== script(root) || !existsSync(join(root, GRAMMARS))) return [];
  const names = readdirSync(join(root, GRAMMARS)).filter((name) => name.endsWith('.wasm'));
  mkdirSync(join(out, GRAMMARS), { recursive: true });
  for (const name of names) copyFileSync(join(root, GRAMMARS, name), join(out, GRAMMARS, name));
  return names;
}

// git archive's tar stream straight into tar, so nothing is written inside the clone
function extract(ref, out) {
  return new Promise((done, fail) => {
    const archive = spawn('git', ['archive', '--format=tar', ref], { cwd: ROOT, stdio: ['ignore', 'pipe', 2] });
    const untar = spawn('tar', ['-x', '-f', '-', '-C', out], { stdio: ['pipe', 2, 2] });
    archive.stdout.pipe(untar.stdin);
    const exits = [archive, untar].map((child, index) => new Promise((settle, reject) => {
      child.once('error', reject);
      child.once('close', (code) => (code === 0 ? settle() : reject(new Error(`${index === 0 ? `git archive ${ref}` : 'tar -x'} exited with ${code}`))));
    }));
    Promise.all(exits).then(() => done(), fail);
  });
}

async function main() {
  const args = process.argv.slice(2);
  const ref = option(args, '--ref');
  const problem = refProblem(ref);
  if (problem !== undefined) throw new Error(problem);
  if (args.includes('--check')) return;
  const target = option(args, '--target');
  const out = resolve(option(args, '--out'));
  if (existsSync(out) && readdirSync(out).length > 0) throw new Error(`${out} is not empty`);
  mkdirSync(out, { recursive: true });
  await extract(ref, out);
  process.stderr.write(`seeded ${seedGrammars(out).length} grammars from this tree\n`);
  npm(['ci', '--ignore-scripts'], out);
  npm(['rebuild'], out);
  npm(['run', 'fetch:grammars'], out);
  const { version } = JSON.parse(readFileSync(join(out, 'package.json'), 'utf8'));
  const referenceVersion = `${version}-ref`;
  npm(['pkg', 'set', `version=${referenceVersion}`], out);
  npm(['run', 'build:server', '--', '--target', target], out);
  const packages = join(out, 'dist', 'server-packages');
  const archive = readdirSync(packages).find((name) => name.startsWith(`damocles-server-${referenceVersion}-${target}.`));
  if (archive === undefined) throw new Error(`build:server wrote no ${referenceVersion} package for ${target} into ${packages}`);
  process.stdout.write(`${join(packages, archive)}\n`);
}

if (isEntryPoint(import.meta.url)) {
  main().catch((err) => {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}
