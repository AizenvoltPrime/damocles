import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { x as tarExtract } from 'tar';

function fwd(p) { return p.replace(/\\/g, '/'); }

const GRAMMAR_DIR = join(process.cwd(), 'resources', 'grammars');
const TMP_DIR = join(process.cwd(), '.grammar-tmp');
const PKG = 'tree-sitter-wasms@0.1.13';

const WASM_FILES = [
  'tree-sitter-python.wasm',
  'tree-sitter-javascript.wasm',
  'tree-sitter-typescript.wasm',
  'tree-sitter-tsx.wasm',
  'tree-sitter-go.wasm',
  'tree-sitter-rust.wasm',
  'tree-sitter-java.wasm',
  'tree-sitter-c.wasm',
  'tree-sitter-cpp.wasm',
  'tree-sitter-ruby.wasm',
  'tree-sitter-c_sharp.wasm',
  'tree-sitter-kotlin.wasm',
  'tree-sitter-scala.wasm',
  'tree-sitter-php.wasm',
  'tree-sitter-vue.wasm',
  'tree-sitter-bash.wasm',
];

const missing = WASM_FILES.filter(f => !existsSync(join(GRAMMAR_DIR, f)));

if (missing.length === 0) {
  console.log(`Done: 0 fetched, ${WASM_FILES.length} already present`);
  process.exit(0);
}

mkdirSync(GRAMMAR_DIR, { recursive: true });
mkdirSync(TMP_DIR, { recursive: true });

console.log(`Downloading ${PKG} (${missing.length} grammars needed)...`);
const result = execSync(`npm pack ${PKG} --pack-destination "${fwd(TMP_DIR)}"`, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
const tgzName = result.split('\n').pop().trim();
const tgzPath = join(TMP_DIR, tgzName);

const wantedEntries = new Set(missing.map(f => `package/out/${f}`));

console.log(`Extracting ${missing.length} grammars...`);
await tarExtract({
  file: tgzPath,
  cwd: TMP_DIR,
  strip: 2,
  filter: entryPath => wantedEntries.has(entryPath),
});

for (const wasmFile of missing) {
  renameSync(join(TMP_DIR, wasmFile), join(GRAMMAR_DIR, wasmFile));
}

try { rmSync(TMP_DIR, { recursive: true, force: true }); } catch { /* Windows directory lock */ }

console.log(`Done: ${missing.length} fetched, ${WASM_FILES.length - missing.length} already present`);
