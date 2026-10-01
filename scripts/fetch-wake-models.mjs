import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { isEntryPoint } from './entry-point.mjs';

// Single source of truth: MODEL_MANIFEST.json. The previous incarnation
// of this script duplicated URLs + SHAs as inline constants, which drifted
// from the manifest in two ways: the manifest only listed `hey_jarvis`
// (missing the two preprocessor ONNX files), and neither side enforced
// agreement. Now both ends read the same file, so manifest validation
// catches drift automatically.

const REPO_ROOT = process.cwd();
const MANIFEST_PATH = join(
  REPO_ROOT,
  'python',
  'damocles_voice_sidecar',
  'damocles_voice_sidecar',
  'models',
  'MODEL_MANIFEST.json',
);
const WAKE_DIR = join(
  REPO_ROOT,
  'python',
  'damocles_voice_sidecar',
  'damocles_voice_sidecar',
  'models',
  'wake',
);

// We ship `.onnx` because tflite-runtime has no Windows wheels on PyPI
// (only Linux/Mac). onnxruntime is cross-platform and already in our deps.
//
// openwakeword's pip package ships only Python code — the ONNX assets
// (the wake-word model PLUS the shared melspectrogram + embedding
// preprocessors) must be supplied separately. We bundle all three and
// pass explicit paths to Model(), so the runtime never relies on
// openwakeword's internal `resources/models/` directory.

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

function sha256OfBuffer(buf) {
  const hash = createHash('sha256');
  hash.update(buf);
  return hash.digest('hex');
}

function isAlreadyValid(path, expected) {
  if (!existsSync(path)) return false;
  const actual = sha256OfBuffer(readFileSync(path));
  return actual.toLowerCase() === expected.toLowerCase();
}

async function main() {
  const manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'));
  const WAKE_MODELS = manifest.wake_models_bundled;
  if (!Array.isArray(WAKE_MODELS) || WAKE_MODELS.length === 0) {
    console.error(`No wake_models_bundled[] entries found in ${MANIFEST_PATH}`);
    process.exit(1);
  }
  for (const m of WAKE_MODELS) {
    for (const required of ['filename', 'url', 'sha256', 'bytes']) {
      if (!(required in m)) {
        console.error(`wake_models_bundled[].${required} missing for ${m.id ?? '?'}`);
        process.exit(1);
      }
    }
  }

  mkdirSync(WAKE_DIR, { recursive: true });

  const missing = WAKE_MODELS.filter((m) => !isAlreadyValid(join(WAKE_DIR, m.filename), m.sha256));

  if (missing.length === 0) {
    console.log(`Done: 0 fetched, ${WAKE_MODELS.length} already present and verified`);
    process.exit(0);
  }

  for (const model of missing) {
    const dest = join(WAKE_DIR, model.filename);
    console.log(`Fetching ${model.filename} from ${model.url}...`);
    let buf;
    try {
      buf = await downloadWithRetry(model.url);
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
    const actual = sha256OfBuffer(buf);
    if (actual.toLowerCase() !== model.sha256.toLowerCase()) {
      console.error(
        `SHA-256 mismatch for ${model.filename}: expected ${model.sha256}, got ${actual}`,
      );
      process.exit(1);
    }
    if (buf.byteLength !== model.bytes) {
      console.error(
        `Size mismatch for ${model.filename}: expected ${model.bytes}, got ${buf.byteLength}`,
      );
      try {
        unlinkSync(dest);
      } catch {
        /* best-effort */
      }
      process.exit(1);
    }
    // Write to a sibling tmp file then atomic-rename to dest. A
    // process killed mid-writeFileSync would otherwise leave a
    // truncated .onnx that passes existsSync but fails sha256OfBuffer
    // on the next run, forcing a re-download.
    const tmp = `${dest}.tmp.${process.pid}`;
    writeFileSync(tmp, buf);
    renameSync(tmp, dest);
    console.log(`  ✓ ${model.filename} (${buf.byteLength} bytes, sha256 verified)`);
  }

  console.log(`Done: ${missing.length} fetched, ${WAKE_MODELS.length - missing.length} already present`);
}

if (isEntryPoint(import.meta.url)) await main();
