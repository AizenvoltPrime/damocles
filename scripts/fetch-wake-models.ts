import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { isEntryPoint } from './entry-point.ts';

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

export interface WakeFile {
  readonly filename: string;
  readonly archive_path: string;
  readonly sha256: string;
  readonly bytes: number;
}

interface Checksum {
  readonly sha256: string;
  readonly bytes: number;
}

export interface WakeModel {
  readonly archive: Checksum & { readonly url: string };
  readonly files: readonly WakeFile[];
}

export interface DownloadOptions {
  readonly fetchImpl?: (url: string, init: RequestInit) => Promise<Response>;
  readonly sleep?: (ms: number) => Promise<unknown>;
  readonly random?: () => number;
  readonly now?: () => number;
  readonly log?: (message: string) => void;
  readonly attempts?: number;
}

export interface TarOptions {
  readonly platform?: NodeJS.Platform;
  readonly env?: NodeJS.ProcessEnv;
  readonly exists?: (path: string) => boolean;
}

export interface FetchWakeModelOptions {
  readonly manifestPath: string;
  readonly wakeDir: string;
  readonly download?: (url: string) => Promise<Buffer>;
  readonly tarPath?: () => string;
  readonly log?: (message: string) => void;
}

export interface WakeModelResult {
  readonly fetched: number;
  readonly present: number;
  readonly removed: readonly string[];
}

/** Statuses a later identical request can succeed after; any other failure is permanent. */
function isTransientStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

/** `Retry-After` as seconds or an HTTP date, in milliseconds, or undefined when absent or unreadable. */
function retryAfterMs(header: string | null, now: number): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(header);
  return Number.isNaN(date) ? undefined : Math.max(0, date - now);
}

/** Exponential backoff with equal jitter: half the step is fixed, half random. */
function backoffMs(attempt: number, random: () => number): number {
  const step = Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** (attempt - 1));
  return step / 2 + random() * (step / 2);
}

/**
 * The body at `url`, retrying network errors, timeouts, 408, 429 and 5xx with backoff. A 404 or any
 * other 4xx fails at once. Retrying is safe because the caller verifies the size and SHA-256.
 */
export async function downloadWithRetry(url: string, {
  fetchImpl = fetch,
  sleep = delay,
  random = Math.random,
  now = Date.now,
  log = console.log,
  attempts = DOWNLOAD_ATTEMPTS,
}: DownloadOptions = {}): Promise<Buffer> {
  const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));
  for (let attempt = 1; ; attempt++) {
    let failure: string | undefined;
    let serverWaitMs = 0;
    let res: Response | undefined;
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
export function systemTarPath({ platform = process.platform, env = process.env, exists = existsSync }: TarOptions = {}): string {
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

function sha256Of(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

/** Why `buf` is not the manifest's `expected`, or null when it is. */
function mismatch(buf: Buffer, expected: Checksum): string | null {
  if (buf.byteLength !== expected.bytes) return `expected ${expected.bytes} bytes, got ${buf.byteLength}`;
  const actual = sha256Of(buf);
  return actual === expected.sha256.toLowerCase() ? null : `expected sha256 ${expected.sha256}, got ${actual}`;
}

function isAlreadyValid(path: string, expected: Checksum): boolean {
  return existsSync(path) && mismatch(readFileSync(path), expected) === null;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null;
}

/** The manifest's `wake_model`, after the checks that keep every file a bare name inside the wake directory. */
export function readWakeModel(manifestPath: string): WakeModel {
  const manifest: unknown = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const wakeModel = isRecord(manifest) ? manifest.wake_model : undefined;
  const archive = isRecord(wakeModel) ? wakeModel.archive : undefined;
  if (!isRecord(wakeModel) || !isRecord(archive) || typeof archive.url !== 'string' || typeof archive.sha256 !== 'string' || typeof archive.bytes !== 'number') {
    throw new Error(`${manifestPath}: wake_model.archive needs url, sha256 and bytes`);
  }
  const entries: unknown = wakeModel.files;
  if (!Array.isArray(entries) || entries.length === 0) throw new Error(`${manifestPath}: wake_model.files is empty`);
  const list: readonly unknown[] = entries;
  const files = list.map((file): WakeFile => {
    const entry: Readonly<Record<string, unknown>> = isRecord(file) ? file : {};
    const { filename, archive_path, sha256, bytes } = entry;
    if (typeof filename !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(filename)) {
      throw new Error(`${manifestPath}: wake_model.files[].filename must be a bare file name, got ${JSON.stringify(filename)}`);
    }
    if (typeof archive_path !== 'string' || typeof sha256 !== 'string' || typeof bytes !== 'number') {
      throw new Error(`${manifestPath}: wake_model.files[] ${filename} needs archive_path, sha256 and bytes`);
    }
    return { filename, archive_path, sha256, bytes };
  });
  return { archive: { url: archive.url, sha256: archive.sha256, bytes: archive.bytes }, files };
}

/** Deletes each .onnx in `wakeDir` the manifest does not list, so a removed model never ships. */
function removeStaleModels(wakeDir: string, wakeModel: WakeModel, log: (message: string) => void): string[] {
  const listed = new Set(wakeModel.files.map((file) => file.filename));
  const stale = readdirSync(wakeDir).filter((name) => name.endsWith('.onnx') && !listed.has(name));
  for (const name of stale) {
    rmSync(join(wakeDir, name), { force: true });
    log(`  removed ${name}, which the manifest does not list`);
  }
  return stale;
}

function extract(tarPath: string, archivePath: string, outDir: string, archivePaths: readonly string[]): void {
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
}: FetchWakeModelOptions): Promise<WakeModelResult> {
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

async function main(): Promise<void> {
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
