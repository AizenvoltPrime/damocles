import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EXTENSION_EXTERNALS } from './extension-externals.mjs';

/**
 * Keep the `.vscodeignore` node_modules allowlist in lockstep with the esbuild externals.
 *
 * `.vscodeignore` excludes all of node_modules, then re-includes only the packages that ship as real
 * node_modules: the esbuild externals (minus `vscode`) plus each one's full production-dependency
 * closure. Hand-maintaining that closure is error-prone and silently drifted before (the default `pi`
 * engine + MCP SDK + their ~200 transitive deps were missing from the VSIX). This derives it from the
 * actually-installed tree instead, so it is correct by construction and adapts per platform (each build
 * machine's installed optional native binaries are the ones that ship).
 *
 *   node scripts/sync-vscodeignore.mjs           # rewrite the managed block in .vscodeignore
 *   node scripts/sync-vscodeignore.mjs --check    # exit 1 if the block is stale (CI verify-job guard)
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const NM = join(ROOT, 'node_modules');
const IGNORE_FILE = join(ROOT, '.vscodeignore');
const BEGIN = '# >>> AUTO-GENERATED node_modules allowlist (scripts/sync-vscodeignore.mjs) — do not edit by hand';
const END = '# <<< AUTO-GENERATED node_modules allowlist';

/** The base package names that must ship: externals minus `vscode`, with `pkg/*` subpaths collapsed. */
function shipRoots() {
  const roots = new Set();
  for (const ext of EXTENSION_EXTERNALS) {
    if (ext === 'vscode') continue;
    roots.add(ext.replace(/\/\*+$/, ''));
  }
  return [...roots];
}

function pkgJson(dir) {
  const p = join(dir, 'package.json');
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

/** Where `dep` (required from `fromDir`) lives: nested under the parent (covered by its `/**`) or hoisted. */
function resolveDep(fromDir, dep) {
  const nested = join(fromDir, 'node_modules', dep);
  if (existsSync(nested)) return { dir: nested, hoisted: false };
  const top = join(NM, dep);
  if (existsSync(top)) return { dir: top, hoisted: true };
  return null;
}

/** The set of top-level node_modules package names to allowlist (the externals + their prod closure). */
function computeClosure() {
  const topLevel = new Set();
  const visited = new Set();

  function walk(dir) {
    if (visited.has(dir)) return;
    visited.add(dir);
    const json = pkgJson(dir);
    if (!json) return;
    // Include peerDependencies: when actually installed (resolveDep gates on existence), a peer the
    // package require()s at runtime must ship too. Uninstalled peers (host-provided) resolve to null.
    const deps = { ...(json.dependencies || {}), ...(json.optionalDependencies || {}), ...(json.peerDependencies || {}) };
    for (const dep of Object.keys(deps)) {
      const resolved = resolveDep(dir, dep);
      if (!resolved) continue; // optional/peer dep not installed (other platform / host-provided) — nothing to ship
      if (resolved.hoisted) topLevel.add(dep);
      walk(resolved.dir);
    }
  }

  for (const root of shipRoots()) {
    const dir = join(NM, root);
    if (!existsSync(dir)) {
      throw new Error(`External package not installed: ${root} (run npm install)`);
    }
    topLevel.add(root);
    walk(dir);
  }
  return [...topLevel].sort();
}

/** Platform tokens used in npm native-binary package names (os · cpu · libc/abi). */
const PLATFORM_TOKENS = new Set([
  'win32', 'darwin', 'linux', 'freebsd', 'openbsd', 'netbsd', 'android', 'sunos', 'aix',
  'x64', 'arm64', 'arm', 'ia32', 'x86', 'ppc64', 'ppc', 's390x', 'riscv64', 'loong64', 'mips64el', 'mips64', 'universal',
  'musl', 'gnu', 'gnueabihf', 'eabi', 'msvc',
]);

/** True if the installed package declares `os`/`cpu` — i.e. it is an npm platform-specific binary. */
function isPlatformBinary(pkgName) {
  const json = pkgJson(join(NM, pkgName));
  return !!(json && (Array.isArray(json.os) || Array.isArray(json.cpu)));
}

/**
 * Collapse a platform-binary package to a family glob by stripping trailing platform tokens, e.g.
 * `@vscode/ripgrep-win32-x64` → `@vscode/ripgrep-*`, `@scope/clipboard-linux-x64-musl` → `@scope/clipboard-*`.
 * The glob is platform-neutral, so a `.vscodeignore` generated on one OS still ships the right binary on
 * every other (matching the per-`--target` matrix release pipeline). Returns null when no token strips.
 */
function platformFamilyGlob(pkgName) {
  const slash = pkgName.lastIndexOf('/');
  const scope = slash >= 0 ? pkgName.slice(0, slash + 1) : '';
  const parts = (slash >= 0 ? pkgName.slice(slash + 1) : pkgName).split('-');
  let stripped = 0;
  while (parts.length > 1 && PLATFORM_TOKENS.has(parts[parts.length - 1].toLowerCase())) {
    parts.pop();
    stripped++;
  }
  return stripped > 0 ? `${scope}${parts.join('-')}-*` : null;
}

/** Allowlist pattern (with trailing `/**`) for a closure package: a family glob for native binaries, else the package itself. */
function allowPattern(pkgName) {
  if (isPlatformBinary(pkgName)) {
    const family = platformFamilyGlob(pkgName);
    if (family) return `${family}/**`;
  }
  return `${pkgName}/**`;
}

function buildBlock() {
  const patterns = new Set();
  for (const pkg of computeClosure()) patterns.add(allowPattern(pkg));
  const lines = [...patterns].sort().map((p) => `!node_modules/${p}`);
  return [BEGIN, ...lines, END].join('\n');
}

/** The file's dominant line ending, so a CRLF working tree (default Windows checkout) round-trips intact. */
function detectEol(text) {
  const crlf = (text.match(/\r\n/g) || []).length;
  const lf = (text.match(/(?<!\r)\n/g) || []).length;
  return crlf > lf ? '\r\n' : '\n';
}

/** Replace the managed block (or insert it right after `node_modules/**`), stripping stale `!node_modules` lines. */
function applyBlock(original, block) {
  const eol = detectEol(original);
  const lines = original.split(/\r?\n/); // tolerate CRLF: markers/anchors are compared without the trailing \r
  const out = [];
  let inBlock = false;
  let inserted = false;
  for (const line of lines) {
    if (line === BEGIN) { inBlock = true; continue; }
    if (line === END) { inBlock = false; continue; }
    if (inBlock) continue;
    if (line.startsWith('!node_modules/')) continue; // strip pre-managed hand-written allowlist lines
    out.push(line);
    if (line.trim() === 'node_modules/**' && !inserted) {
      out.push(...block.split('\n')); // emit per-line so the block adopts the file's line ending
      inserted = true;
    }
  }
  if (!inserted) throw new Error('.vscodeignore must contain a `node_modules/**` line to anchor the allowlist');
  return out.join(eol);
}

const check = process.argv.includes('--check');
const original = readFileSync(IGNORE_FILE, 'utf8');
const next = applyBlock(original, buildBlock());

if (next === original) {
  console.log('.vscodeignore node_modules allowlist is up to date.');
  process.exit(0);
}

if (check) {
  console.error('.vscodeignore node_modules allowlist is STALE. Run: node scripts/sync-vscodeignore.mjs');
  process.exit(1);
}

writeFileSync(IGNORE_FILE, next);
console.log('.vscodeignore node_modules allowlist updated.');
