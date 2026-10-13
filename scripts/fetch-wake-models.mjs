import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { isEntryPoint } from './entry-point.mjs';

// The wake model is one release archive in MODEL_MANIFEST.json's `wake_model`; this script extracts the files it lists
// into models/wake/, which the sidecar loads and the packaging checks compare against the same manifest.

const MODELS_DIR = join('python', 'damocles_voice_sidecar', 'damocles_voice_sidecar', 'models');
export const MANIFEST_RELATIVE_PATH = join(MODELS_DIR, 'MODEL_MANIFEST.json');
export const WAKE_DIR_RELATIVE_PATH = join(MODELS_DIR, 'wake');

export const DOWNLOAD_ATTEMPTS = 5;
const BACKOFF_BASE_MS = 2_000;
const BACKOFF_CAP_MS = 30_000;
const RETRY_AFTER_CAP_MS = 60_000;
/** Covers the headers and the whole body of one attempt, so a stalled transfer is retried instead of hanging the build. */
const ATTEMPT_TIMEOUT_MS = 120_000;

/** Statuses a later identical request can succeed after; any other failure is permanent. */
function isTransientStatus(status) {
  return status === 408 || status === 429 || status >= 500;
}

/** `Retry-After` as seconds or an HTTP date, in milliseconds, or undefined when absent or unreadable. */
function retryAfterMs(header, now) {
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(header);
  return Number.isNaN(date) ? undefined : Math.max(0, date - now);
}

/** Exponential backoff with equal jitter: half the step is fixed, half random. */
function backoffMs(attempt, random) {
  const step = Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** (attempt - 1));
  return step / 2 + random() * (step / 2);
}

/**
 * The body at `url`, retrying network errors, timeouts, 408, 429 and 5xx with backoff. A 404 or any
 * other 4xx fails at once. Retrying is safe because the caller verifies the size and SHA-256.
 */
export async function downloadWithRetry(url, {
  fetchImpl = fetch,
  sleep = delay,
  random = Math.random,
  now = Date.now,
  log = console.log,
  attempts = DOWNLOAD_ATTEMPTS,
} = {}) {
  const message = (error) => (error instanceof Error ? error.message : String(error));
  for (let attempt = 1; ; attempt++) {
    let failure;
    let serverWaitMs = 0;
    let res;
    try {
      res = await fetchImpl(url, { redirect: 'follow', signal: AbortSignal.timeout(ATTEMPT_TIMEOUT_MS) });
    } catch (error) {
      failure = message(error);
    }
    if (res?.ok) {
      try {
        return Buffer.from(await res.arrayBuffer());
      } catch (error) {
        failure = message(error);
      }
    } else if (res) {
      await res.body?.cancel();
      // HTTP/2 responses carry no status text.
      failure = res.statusText ? `${res.status} ${res.statusText}` : String(res.status);
      if (!isTransientStatus(res.status)) throw new Error(`Download failed (${failure}): ${url}`);
      serverWaitMs = Math.min(RETRY_AFTER_CAP_MS, retryAfterMs(res.headers.get('retry-after'), now()) ?? 0);
    }
    if (attempt >= attempts) throw new Error(`Download failed after ${attempts} attempts (${failure}): ${url}`);
    const waitMs = Math.max(serverWaitMs, backoffMs(attempt, random));
    log(`  ${failure}; retrying in ${(waitMs / 1000).toFixed(1)}s (attempt ${attempt + 1} of ${attempts})`);
    await sleep(waitMs);
  }
}

/**
 * The OS's own tar by absolute path, never one found on PATH: Node cannot read bzip2, and Git for Windows' GNU tar on
 * PATH reads `C:\...` as a remote host.
 */
export function systemTarPath({ platform = process.platform, env = process.env, exists = existsSync } = {}) {
  if (platform === 'win32') {
    if (!env.SystemRoot) throw new Error('SystemRoot is not set, so the Windows tar.exe cannot be located');
    const tar = join(env.SystemRoot, 'System32', 'tar.exe');
    if (!exists(tar)) throw new Error(`${tar} not found; it ships with Windows 10 1803 and later`);
    return tar;
  }
  const tar = ['/usr/bin/tar', '/bin/tar'].find((candidate) => exists(candidate));
  if (tar === undefined) throw new Error('No tar at /usr/bin/tar or /bin/tar');
  return tar;
}

function sha256Of(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

/** Why `buf` is not the manifest's `expected` {sha256, bytes}, or null when it is. */
function mismatch(buf, expected) {
  if (buf.byteLength !== expected.bytes) return `expected ${expected.bytes} bytes, got ${buf.byteLength}`;
  const actual = sha256Of(buf);
  return actual === expected.sha256.toLowerCase() ? null : `expected sha256 ${expected.sha256}, got ${actual}`;
}

function isAlreadyValid(path, expected) {
  return existsSync(path) && mismatch(readFileSync(path), expected) === null;
}

/** The manifest's `wake_model`, after the checks that keep every file a bare name inside the wake directory. */
export function readWakeModel(manifestPath) {
  const wakeModel = JSON.parse(readFileSync(manifestPath, 'utf8')).wake_model;
  const archive = wakeModel?.archive;
  if (typeof archive?.url !== 'string' || typeof archive.sha256 !== 'string' || typeof archive.bytes !== 'number') {
    throw new Error(`${manifestPath}: wake_model.archive needs url, sha256 and bytes`);
  }
  if (!Array.isArray(wakeModel.files) || wakeModel.files.length === 0) throw new Error(`${manifestPath}: wake_model.files is empty`);
  for (const file of wakeModel.files) {
    if (typeof file.filename !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(file.filename)) {
      throw new Error(`${manifestPath}: wake_model.files[].filename must be a bare file name, got ${JSON.stringify(file.filename)}`);
    }
    if (typeof file.archive_path !== 'string' || typeof file.sha256 !== 'string' || typeof file.bytes !== 'number') {
      throw new Error(`${manifestPath}: wake_model.files[] ${file.filename} needs archive_path, sha256 and bytes`);
    }
  }
  return wakeModel;
}

/** Deletes each .onnx in `wakeDir` the manifest does not list, so a removed model never ships. */
function removeStaleModels(wakeDir, wakeModel, log) {
  const listed = new Set(wakeModel.files.map((file) => file.filename));
  const stale = readdirSync(wakeDir).filter((name) => name.endsWith('.onnx') && !listed.has(name));
  for (const name of stale) {
    rmSync(join(wakeDir, name), { force: true });
    log(`  removed ${name}, which the manifest does not list`);
  }
  return stale;
}

function extract(tarPath, archivePath, outDir, archivePaths) {
  const result = spawnSync(tarPath, ['-xjf', archivePath, '-C', outDir, ...archivePaths], { encoding: 'utf8' });
  if (result.error) throw new Error(`${tarPath} failed to start: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`${tarPath} exited with ${result.status ?? result.signal}: ${result.stderr.trim()}`);
}

/**
 * Makes `wakeDir` hold exactly the manifest's wake files: downloads the archive only when one is missing or differs,
 * verifies the archive and each extracted file, and moves nothing in until every file has passed.
 */
export async function fetchWakeModel({
  manifestPath,
  wakeDir,
  download = downloadWithRetry,
  tarPath = systemTarPath,
  log = console.log,
}) {
  const wakeModel = readWakeModel(manifestPath);
  mkdirSync(wakeDir, { recursive: true });
  const removed = removeStaleModels(wakeDir, wakeModel, log);
  const missing = wakeModel.files.filter((file) => !isAlreadyValid(join(wakeDir, file.filename), file));
  if (missing.length === 0) return { fetched: 0, present: wakeModel.files.length, removed };

  const tar = tarPath();
  const workDir = mkdtempSync(join(tmpdir(), 'damocles-wake-'));
  try {
    log(`Fetching ${wakeModel.archive.url}...`);
    const archive = await download(wakeModel.archive.url);
    const archiveProblem = mismatch(archive, wakeModel.archive);
    if (archiveProblem !== null) throw new Error(`Wake model archive ${wakeModel.archive.url}: ${archiveProblem}`);
    const archivePath = join(workDir, 'archive.tar.bz2');
    writeFileSync(archivePath, archive);

    const outDir = join(workDir, 'out');
    mkdirSync(outDir);
    extract(tar, archivePath, outDir, missing.map((file) => file.archive_path));
    const extracted = missing.map((file) => {
      const path = join(outDir, ...file.archive_path.split('/'));
      if (!existsSync(path)) throw new Error(`The archive has no ${file.archive_path}`);
      const problem = mismatch(readFileSync(path), file);
      if (problem !== null) throw new Error(`${file.archive_path}: ${problem}`);
      return { file, path };
    });

    // Staged next to its destination, so the rename never crosses volumes and a killed run leaves no partial file.
    for (const { file, path } of extracted) {
      const dest = join(wakeDir, file.filename);
      const staged = `${dest}.tmp.${process.pid}`;
      copyFileSync(path, staged);
      renameSync(staged, dest);
      log(`  ✓ ${file.filename} (${file.bytes} bytes, sha256 verified)`);
    }
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
  return { fetched: missing.length, present: wakeModel.files.length - missing.length, removed };
}

async function main() {
  const root = process.cwd();
  try {
    const { fetched, present } = await fetchWakeModel({
      manifestPath: join(root, MANIFEST_RELATIVE_PATH),
      wakeDir: join(root, WAKE_DIR_RELATIVE_PATH),
    });
    console.log(`Done: ${fetched} fetched, ${present} already present and verified`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

if (isEntryPoint(import.meta.url)) await main();
