import { createHash } from 'node:crypto';
import { createReadStream, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseDocument } from 'yaml';
// Internal module of electron-builder 26.15.7, which package.json pins exactly; re-check this path when bumping it.
import { buildBlockMap } from 'app-builder-lib/out/targets/blockmap/blockmap.js';
import { isEntryPoint } from './entry-point.mjs';

// Signing an NSIS installer changes its bytes after electron-builder hashed it, so the blockmap and the sha512 and size in
// latest-<arch>.yml must be rebuilt from the signed file, or electron-updater rejects the download (docs/desktop-signing.md).

const USAGE = `Usage: node scripts/signed-windows-feed.mjs --rewrite <dir> <arch>...
       node scripts/signed-windows-feed.mjs --check <dir> <arch>...

<dir> holds the signed Damocles-Setup-<version>-<arch>.exe files with their latest-<arch>.yml and .blockmap.
--rewrite rebuilds each installer's blockmap and writes its sha512 and size into latest-<arch>.yml.
--check fails unless every file each latest-<arch>.yml names matches its sha512 and size and its blockmap is current.`;

function feedPath(dir, arch) {
  return join(dir, `latest-${arch}.yml`);
}

/** The installers latest-<arch>.yml names, with their entries; throws on any other shape. */
function readFeed(dir, arch) {
  const file = feedPath(dir, arch);
  const doc = parseDocument(readFileSync(file, 'utf8'));
  const feed = doc.toJS();
  if (!Array.isArray(feed?.files) || feed.files.length === 0 || typeof feed.path !== 'string') {
    throw new Error(`${file} is not an electron-builder update feed`);
  }
  if (!feed.files.some((entry) => entry.url === feed.path)) throw new Error(`${file}: path ${feed.path} is not among its files`);
  return { file, doc, feed };
}

async function sha512OfFile(file) {
  const hash = createHash('sha512');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('base64');
}

/** Rebuilds the blockmap of every installer latest-<arch>.yml names and records the signed files' sha512 and size. */
export async function rewriteFeed(dir, arch) {
  const { file, doc, feed } = readFeed(dir, arch);
  for (const [index, entry] of feed.files.entries()) {
    const installer = join(dir, entry.url);
    const { sha512, size } = await buildBlockMap(installer, 'gzip', `${installer}.blockmap`);
    doc.setIn(['files', index, 'sha512'], sha512);
    doc.setIn(['files', index, 'size'], size);
    if (entry.url === feed.path) doc.set('sha512', sha512);
  }
  writeFileSync(file, doc.toString());
}

/** Every mismatch between latest-<arch>.yml, its installers and their blockmaps. */
export async function feedProblems(dir, arch) {
  const { file, feed } = readFeed(dir, arch);
  const problems = [];
  const scratch = mkdtempSync(join(tmpdir(), 'signed-feed-'));
  try {
    for (const entry of feed.files) {
      const installer = join(dir, entry.url);
      if (!existsSync(installer)) {
        problems.push(`${entry.url} is missing`);
        continue;
      }
      const sha512 = await sha512OfFile(installer);
      const size = statSync(installer).size;
      if (entry.sha512 !== sha512) problems.push(`${file}: sha512 of ${entry.url} does not match the file`);
      if (entry.size !== size) problems.push(`${file}: size of ${entry.url} is ${entry.size}, the file has ${size}`);
      if (entry.url === feed.path && feed.sha512 !== sha512) problems.push(`${file}: top-level sha512 does not match ${entry.url}`);
      const blockmap = `${installer}.blockmap`;
      if (!existsSync(blockmap)) {
        problems.push(`${entry.url}.blockmap is missing`);
        continue;
      }
      const fresh = join(scratch, `${entry.url}.blockmap`);
      await buildBlockMap(installer, 'gzip', fresh);
      if (!readFileSync(fresh).equals(readFileSync(blockmap))) problems.push(`${entry.url}.blockmap was not built from the file`);
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  return problems;
}

async function main() {
  const [mode, dir, ...arches] = process.argv.slice(2);
  if (!['--rewrite', '--check'].includes(mode) || !dir || arches.length === 0) {
    console.error(USAGE);
    process.exit(2);
  }
  if (mode === '--rewrite') {
    for (const arch of arches) await rewriteFeed(dir, arch);
    console.log(`Rewrote the update feed of ${arches.join(', ')} in ${dir}.`);
    return;
  }
  const problems = (await Promise.all(arches.map((arch) => feedProblems(dir, arch)))).flat();
  if (problems.length) {
    for (const problem of problems) console.error(problem);
    process.exit(1);
  }
  console.log(`The update feed of ${arches.join(', ')} in ${dir} matches its installers and blockmaps.`);
}

if (isEntryPoint(import.meta.url)) await main();
