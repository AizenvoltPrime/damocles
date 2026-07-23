import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
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
    // `node:`-prefixed externals are Node builtins (e.g. `node:sqlite`) — they have no node_modules
    // to ship and no dependency closure, so they never belong in the VSIX allowlist.
    if (ext.startsWith('node:')) continue;
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

/**
 * Per-package narrow allowlists: packages that ship large, never-loaded alternate builds. Listing the
 * exact runtime files (instead of the whole `pkg/**`) drops the dead weight — safe because we control
 * the package's `!` patterns directly, so vsce's negate-wins rule can't re-include the omitted files.
 */
const NARROW_ALLOWLIST = {};

/**
 * Extension-level narrowing for big pure-runtime packages.
 *
 * A handful of packages — the pi agent harness, the provider SDKs it bundles, the MCP SDK — ship their
 * full publish tree: compiled `dist`/`esm` JS *plus* the TypeScript source, every `.map`, and (for the
 * pi harness) `docs/` + `examples/` + a 148 MB nested `node_modules`. Only the compiled JS, JSON, and a
 * few binary/asset files are ever `require()`d at runtime; the rest is ~67 MB / ~20k files of dead weight.
 *
 * vsce's filter is negate-wins and order-independent: a broad `!pkg/**` re-include forces the WHOLE
 * subtree in, and no later "node_modules slash-star-star slash-star.map" ignore can claw it back
 * (verified empirically). The only way to drop the dead files is to never negate them — i.e. emit
 * narrower `!` patterns that match just the runtime files. We do that with single-extension globs
 * (`!pkg/<dirstar>/<star>.js`, `.json`, …), where the leading double-star also matches root-level files.
 * Single-extension globs are as cheap as directory-prefix globs in vsce's minimatch (~75ms/200k matches,
 * measured); brace-extension globs (`<star>.{js,json}`) are the 5x-slower trap that timed `vsce package`
 * out, so we deliberately avoid them.
 *
 * RUNTIME_KEEP_EXTS is the closed set of extensions a shipped package may legitimately load at runtime:
 * compiled JS module formats, JSON, native/wasm binaries, and the static assets the pi harness reads via
 * fs (`template.html`/`template.css` for HTML export, `clankolas.png`, `photon_rs_bg.wasm`, protobuf
 * `.proto`, plus svg/gif/jpg images). DROP_EXTS is the reviewed set of definitely-dead extensions
 * (TS source, sourcemaps, docs/markdown, lint/editor/CI configs, shell shims, rust/c sources, man pages,
 * tsbuildinfo). Anything in a narrowed package whose extension is in NEITHER set — or an extensionless
 * file that is not a known license/ownership/shim file — trips assertReviewed() and fails the run, so a
 * future dependency bump can never silently drop a brand-new runtime asset type.
 */
const RUNTIME_NARROW_PKGS = new Set(
  (process.env.NARROW_PKGS
    ? process.env.NARROW_PKGS.split(',').map((s) => s.trim()).filter(Boolean)
    : [
        '@earendil-works/pi-coding-agent',
        '@earendil-works/pi-ai',
        '@earendil-works/pi-agent-core',
        '@earendil-works/pi-tui',
        '@mistralai/mistralai',
        'openai',
        '@anthropic-ai/sdk',
        '@modelcontextprotocol/sdk',
        '@google/genai',
        // Patchright driver tree (Slice 1). Both ship their full publish tree; only the compiled driver
        // JS/JSON + the browser-launch assets are loaded at runtime — narrow to drop TS source/maps/docs.
        'patchright',
        'patchright-core',
      ]),
);

const RUNTIME_KEEP_EXTS = new Set([
  'js', 'mjs', 'cjs', 'json', // JS module formats + manifests/data
  'node', 'wasm', // native + wasm binaries (all platforms — keeps the cross-platform VSIX correct)
  'css', 'html', 'png', 'svg', 'gif', 'jpg', 'proto', // static assets the harness reads at runtime
]);

const DROP_EXTS = new Set([
  'ts', 'mts', 'cts', 'map', 'tsbuildinfo', // TS source + declarations + sourcemaps + incremental cache
  'md', 'scss', 'rs', 'c', 'bnf', 'jsdoc', 'toml', 'sh', 'ps1', 'cmd', '1', 'yml', 'txt', // docs/source/scripts/man/CI/test-data
  'npmignore', 'keep', 'prettierrc', 'prettierignore', 'nvmrc', 'eslintrc', 'eslintignore', 'editorconfig', // tooling configs
  // Patchright driver dead weight (Slice 1). `license` = esbuild `<name>.js.LICENSE` legal sidecars.
  // `ttf`/`webmanifest` = codicon fonts + PWA manifest for the bundled trace-viewer/recorder/dashboard
  // web UIs (lib/vite/**) — served only by `show-trace`/`codegen`, which we never invoke; the
  // browser-launch driver (channel:'chrome' → open/navigate/screenshot) never loads them.
  'license', 'ttf', 'webmanifest',
]);

/**
 * Per-package dead top-level directories to exclude even though they contain keep-extension files.
 *
 * Whole-package keep-globs (`pkg/<star><star>/<star>.png`, etc.) already drop a package's `.ts`/`.map`
 * source, but a few packages also ship docs/examples whose *assets* (PNG screenshots, example
 * package.json/wasm) share an extension with real runtime files and would otherwise be negated back in.
 * The pi harness's `docs/` (incl. a 1.5 MB `docs/images/exy.png`) and `examples/` (a 380 KB
 * `doom-overlay/doom/build/doom.wasm`, sample manifests) are pure documentation — never required at
 * runtime. For these packages we scope the keep-globs to each runtime top-level dir instead of the whole
 * package, so the dead dirs are simply never negated. Only listed here when the dead dir actually holds
 * keep-extension files (so we don't pay extra patterns for packages whose docs are markdown-only).
 */
const NARROW_DROP_DIRS = {
  '@earendil-works/pi-coding-agent': new Set(['docs', 'examples']),
};

/** Extensionless files that are safe to drop from a narrowed package (license/ownership/build/CLI-shim). */
const DROP_BASENAMES = new Set([
  'LICENSE', 'license', 'License', 'LICENSE-MIT', 'CODEOWNERS', 'Makefile',
  '.keep', '.npmignore', '.prettierrc', '.prettierignore', '.nvmrc', '.eslintrc', '.eslintignore', '.editorconfig', '.gitignore', '.gitattributes', // dotfiles (no basename → treated as extensionless)
  'cli', 'node-which', 'marked', 'yaml', 'semver', 'pi-ai', 'openai', 'jiti', 'fxparser', 'anthropic-ai-sdk',
  // Patchright: Linux `xdg-open` shell shim (patchright-core/lib/xdg-open) — spawned only to open a URL
  // in the OS default app (openExternal / trace report), never on the browser-launch path. Dead weight.
  'xdg-open',
]);

/** Recursively list file basenames under a directory (skips traversal errors). */
function listFiles(dir, acc = []) {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return acc; }
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory()) listFiles(full, acc);
    else acc.push(e.name);
  }
  return acc;
}

/**
 * Fail loudly if a narrowed package contains a file whose extension is neither kept nor reviewed-dead.
 * This is the safety net that makes extension-level narrowing maintainable: drift in an upstream package
 * (a new asset type the runtime starts loading) surfaces as a build error here, not a broken VSIX.
 */
function assertReviewed(pkgName, dir) {
  const unknown = new Set();
  for (const name of listFiles(dir)) {
    const dot = name.lastIndexOf('.');
    if (dot <= 0) {
      // extensionless: allow only known license/ownership/build/shim files
      if (!DROP_BASENAMES.has(name)) unknown.add(name);
      continue;
    }
    const ext = name.slice(dot + 1).toLowerCase();
    if (!RUNTIME_KEEP_EXTS.has(ext) && !DROP_EXTS.has(ext)) unknown.add(`*.${ext}`);
  }
  if (unknown.size) {
    throw new Error(
      `Unreviewed file type(s) in narrowed package ${pkgName}: ${[...unknown].sort().join(', ')}. ` +
      `Add each to RUNTIME_KEEP_EXTS (if the runtime loads it) or DROP_EXTS/DROP_BASENAMES (if it is dead) ` +
      `in scripts/sync-vscodeignore.mjs, then re-run.`,
    );
  }
}

/** The runtime keep-extension globs for a narrowed package — only for extensions actually present. */
function runtimeKeepPatterns(pkgName, dir) {
  assertReviewed(pkgName, dir);
  const dropDirs = NARROW_DROP_DIRS[pkgName];

  // Collect the keep-extensions actually present, per top-level dir (so a package with dead doc/example
  // dirs can scope its globs to just the runtime dirs). `roots` keys: '' = package root files, else the
  // top-level dir name. Each maps to the set of keep-extensions present anywhere beneath it.
  const roots = new Map();
  function scan(base, prefix) {
    let entries;
    try { entries = readdirSync(base, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.isDirectory()) { scan(join(base, e.name), prefix); continue; }
      const dot = e.name.lastIndexOf('.');
      if (dot <= 0) continue;
      const ext = e.name.slice(dot + 1).toLowerCase();
      if (!RUNTIME_KEEP_EXTS.has(ext)) continue;
      if (!roots.has(prefix)) roots.set(prefix, new Set());
      roots.get(prefix).add(ext);
    }
  }
  if (dropDirs) {
    // Scan each top-level entry under its own prefix; skip the dead doc/example dirs entirely.
    for (const top of readdirSync(dir, { withFileTypes: true })) {
      if (top.isDirectory()) {
        if (dropDirs.has(top.name)) continue;
        scan(join(dir, top.name), top.name);
      } else {
        const dot = top.name.lastIndexOf('.');
        if (dot <= 0) continue;
        const ext = top.name.slice(dot + 1).toLowerCase();
        if (RUNTIME_KEEP_EXTS.has(ext)) { if (!roots.has('')) roots.set('', new Set()); roots.get('').add(ext); }
      }
    }
  } else {
    // Whole-package globs: one `pkg/<star><star>/<star>.ext` per present extension (cheapest pattern set).
    scan(dir, '');
  }

  const globs = [];
  for (const [prefix, exts] of roots) {
    // prefix '' = package-root files: match a single level (`pkg/*.ext`) so the recursive `**` can't
    // pull keep-ext assets back out of a dropped docs/examples dir. A non-drop-dir package keeps the
    // cheaper whole-tree `pkg/**/*.ext` form (its '' prefix came from scan(dir,'') over the whole tree).
    if (prefix === '' && dropDirs) {
      for (const ext of [...exts].sort()) globs.push(`${pkgName}/*.${ext}`);
    } else {
      const base = prefix ? `${pkgName}/${prefix}` : pkgName;
      for (const ext of [...exts].sort()) globs.push(`${base}/**/*.${ext}`);
    }
  }
  globs.sort();
  return globs.length ? globs : [`${pkgName}/**`];
}

/** Allowlist patterns for a closure package: a narrow override, a native-binary family glob, else `pkg/**`. */
function allowPatterns(pkgName) {
  if (NARROW_ALLOWLIST[pkgName]) return NARROW_ALLOWLIST[pkgName];
  if (isPlatformBinary(pkgName)) {
    const family = platformFamilyGlob(pkgName);
    if (family) return [`${family}/**`];
  }
  if (RUNTIME_NARROW_PKGS.has(pkgName)) {
    return runtimeKeepPatterns(pkgName, join(NM, pkgName));
  }
  return [`${pkgName}/**`];
}

/**
 * Collapse a scope whose every on-disk member ships in full to a single `@scope/**` pattern.
 *
 * vsce 3.x filters every file in the on-disk prod-dep tree with string-`minimatch` against ALL ignore +
 * negate patterns — the `package` cost is O(files × patterns), not zip-bound (profiled: the minimatch
 * filter is the dominant phase). Fewer negate patterns is therefore a direct, file-set-neutral speedup.
 * When EVERY installed sub-package under a scope (e.g. all 19 `@aws-sdk/*`, all 9 `@smithy/*`) is already
 * allowlisted with a plain `sub` re-include, one `@scope` wildcard matches exactly the same files with a
 * fraction of the patterns. We only collapse scopes where no member is narrowed (a per-extension keep
 * list) or a platform-family glob — those must stay granular — and where the closure covers every member
 * actually present on disk, so the merge can't pull in a non-closure package.
 */
function consolidateScopes(patterns) {
  // Group the simple `@scope/sub/**` patterns by scope; track scopes that have any non-collapsible pattern.
  const byScope = new Map(); // scope -> Set(sub names) covered by a plain `@scope/sub/**`
  const blockedScopes = new Set(); // scope has a narrowed/family/non-simple pattern → never collapse
  for (const p of patterns) {
    const simple = /^(@[^/]+)\/([^/]+)\/\*\*$/.exec(p); // @scope/sub/**
    if (simple) {
      const [, scope, sub] = simple;
      if (sub.endsWith('-*')) { blockedScopes.add(scope); continue; } // platform-family glob — keep granular
      if (!byScope.has(scope)) byScope.set(scope, new Set());
      byScope.get(scope).add(sub);
      continue;
    }
    const scoped = /^(@[^/]+)\//.exec(p); // any other @scope/... pattern (narrowed keep-list, exact file)
    if (scoped) blockedScopes.add(scoped[1]);
  }

  const result = new Set(patterns);
  for (const [scope, covered] of byScope) {
    if (blockedScopes.has(scope)) continue;
    const dir = join(NM, scope);
    let members;
    try { members = readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name); }
    catch { continue; }
    if (members.length < 2) continue; // nothing to save
    if (!members.every((m) => covered.has(m))) continue; // closure doesn't cover every on-disk member — unsafe
    for (const sub of covered) result.delete(`${scope}/${sub}/**`);
    result.add(`${scope}/**`);
  }
  return result;
}

function buildBlock() {
  let patterns = new Set();
  for (const pkg of computeClosure()) {
    for (const p of allowPatterns(pkg)) patterns.add(p);
  }
  if (process.env.NO_CONSOLIDATE !== '1') patterns = consolidateScopes(patterns);
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
