import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

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

mkdirSync(WAKE_DIR, { recursive: true });

const missing = WAKE_MODELS.filter((m) => !isAlreadyValid(join(WAKE_DIR, m.filename), m.sha256));

if (missing.length === 0) {
  console.log(`Done: 0 fetched, ${WAKE_MODELS.length} already present and verified`);
  process.exit(0);
}

for (const model of missing) {
  const dest = join(WAKE_DIR, model.filename);
  console.log(`Fetching ${model.filename} from ${model.url}...`);
  const res = await fetch(model.url, { redirect: 'follow' });
  if (!res.ok) {
    console.error(`Download failed (${res.status} ${res.statusText}): ${model.url}`);
    process.exit(1);
  }
  const buf = Buffer.from(await res.arrayBuffer());
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
