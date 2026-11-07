import { readFileSync, writeFileSync, existsSync, readdirSync, type Dirent } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EXTENSION_EXTERNALS } from './extension-externals.ts';
import { DESKTOP_EXTERNALS } from './desktop-externals.ts';
import { EXTENSION_BUNDLE_FILES, WEBVIEW_DIST_FOLDER } from './extension-bundles.ts';
import { isEntryPoint } from './entry-point.ts';
import { readZip } from './server-archive.ts';

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
 *   node scripts/sync-vscodeignore.ts           # rewrite the managed block in .vscodeignore
 *   node scripts/sync-vscodeignore.ts --check    # exit 1 if the block is stale (CI verify-job guard)
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const NM = join(ROOT, 'node_modules');
const IGNORE_FILE = join(ROOT, '.vscodeignore');
const BEGIN = '# >>> AUTO-GENERATED node_modules allowlist (scripts/sync-vscodeignore.ts) — do not edit by hand';
const END = '# <<< AUTO-GENERATED node_modules allowlist';
const DIST_BEGIN = '# >>> AUTO-GENERATED dist allowlist (scripts/sync-vscodeignore.ts) — do not edit by hand';
const DIST_END = '# <<< AUTO-GENERATED dist allowlist';

/** The base package names that must ship: externals minus `vscode`, with `pkg/*` subpaths collapsed. */
function shipRoots(): string[] {
  const roots = new Set<string>();
  for (const ext of EXTENSION_EXTERNALS) {
    if (ext === 'vscode') continue;
    // `node:`-prefixed externals are Node builtins (e.g. `node:sqlite`) — they have no node_modules
    // to ship and no dependency closure, so they never belong in the VSIX allowlist.
    if (ext.startsWith('node:')) continue;
    roots.add(ext.replace(/\/\*+$/, ''));
  }
  return [...roots];
}

/** The package.json fields the closure walk reads. */
interface PackageJson {
  name?: string;
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  peerDependenciesMeta?: Record<string, { optional?: boolean }>;
  devDependencies?: Record<string, string>;
  os?: string[];
  cpu?: string[];
}

function pkgJson(dir: string): PackageJson | null {
  const p = join(dir, 'package.json');
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, 'utf8')) as PackageJson;
  } catch {
    return null;
  }
}

/**
 * Where `dep` (required from `fromDir`) lives, following Node's own resolution: the nearest
 * `node_modules` walking up the ancestor chain, ending at the project root. Stopping at the parent and
 * then jumping to the root skips the intermediate copies npm installs to satisfy a version conflict, and
 * so reports a hoisted root package (possibly a devDependency) that Node would never load from there.
 * `hoisted` means the match is a top-level package, which needs its own allowlist entry; a match deeper
 * in the chain already ships under its ancestor's patterns.
 */
function resolveDep(fromDir: string, dep: string): { dir: string; hoisted: boolean } | null {
  let dir = fromDir;
  for (;;) {
    const candidate = join(dir, 'node_modules', dep);
    if (existsSync(candidate)) return { dir: candidate, hoisted: dir === ROOT };
    if (dir === ROOT) return null;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * Externals this project declares in `optionalDependencies`, which npm is allowed to leave uninstalled
 * when its build fails on the current platform. A required external staying absent is still a hard error.
 */
function optionalShipRoots(): Set<string> {
  const json = pkgJson(ROOT);
  return new Set(Object.keys((json && json.optionalDependencies) || {}));
}

/**
 * The top-level node_modules packages `roots` load: each root and its production-dependency closure, as Node resolves it
 * from this checkout's installed tree. `label` names the artifact in the errors. Shared by the VSIX allowlist and the
 * server packages (scripts/build-server.ts).
 */
export function productionClosure(roots: string[], label: string): { packages: string[]; requirers: Map<string, Set<string>> } {
  const topLevel = new Set<string>();
  const visited = new Set<string>();
  const optional = optionalShipRoots();
  const requirers = new Map<string, Set<string>>(); // top-level package -> the shipped packages that declare it
  const buildTools = new Set<string>(); // build-tool packages reached at any depth, with their requirer

  function walk(dir: string): void {
    if (visited.has(dir)) return;
    visited.add(dir);
    const json = pkgJson(dir);
    if (!json) return;
    // Include peerDependencies: when actually installed (resolveDep gates on existence), a peer the
    // package require()s at runtime must ship too. Uninstalled peers (host-provided) resolve to null.
    const deps = { ...(json.dependencies || {}), ...(json.optionalDependencies || {}), ...(json.peerDependencies || {}) };
    for (const dep of Object.keys(deps)) {
      if (isUnwalkedPeer(json, dep)) continue;
      const resolved = resolveDep(dir, dep);
      if (!resolved) continue; // optional/peer dep not installed (other platform / host-provided) — nothing to ship
      if (isBuildToolPackage(dep)) buildTools.add(`${dep} (required by ${json.name}@${deps[dep]})`);
      if (resolved.hoisted) {
        topLevel.add(dep);
        let declared = requirers.get(dep);
        if (!declared) requirers.set(dep, (declared = new Set()));
        declared.add(`${json.name}@${deps[dep]}`);
      }
      walk(resolved.dir);
    }
  }

  for (const root of roots) {
    const dir = join(NM, root);
    if (!existsSync(dir)) {
      // An optional external that failed to build on this platform ships nothing; the release VSIX
      // content gate is what catches its absence on a platform that actually needs it.
      if (optional.has(root)) {
        console.warn(`Warning: ${root} is not installed, so the ${label} will ship without it.`);
        continue;
      }
      throw new Error(`External package not installed: ${root} (run npm install)`);
    }
    topLevel.add(root);
    walk(dir);
  }
  assertNoBuildToolPackages(buildTools, label);
  assertNoDevOnlyPackages(topLevel, requirers, label);
  return { packages: [...topLevel].sort(), requirers };
}

/** The set of top-level node_modules package names to allowlist (the externals + their prod closure). */
function computeClosure(): string[] {
  const { packages, requirers } = productionClosure(shipRoots(), 'packaged extension');
  assertNoDesktopOnlyPackages(new Set(packages), requirers);
  return packages;
}

/** esbuild and its per-platform binaries: build tooling no shipped code path loads. */
export function isBuildToolPackage(name: string): boolean {
  return name === 'esbuild' || name.startsWith('@esbuild/');
}

/**
 * Fail when the closure reaches esbuild at any depth. A nested copy under a shipped package is not
 * top-level, so assertNoDevOnlyPackages never sees it, and its native binaries would ship in the VSIX unused.
 */
function assertNoBuildToolPackages(found: Set<string>, label: string): void {
  if (found.size) {
    throw new Error(
      `Build-tool package(s) in the ${label} closure: ${[...found].sort().join('; ')}. ` +
      `Check whether the requiring package can reach esbuild at runtime before shipping it.`,
    );
  }
}

/**
 * Optional peers a shipped package declares that no shipped code path loads, so they are not walked.
 * openai 7 requires undici only from its opt-in `auth/x509-transport` subpath, which neither pi nor
 * Damocles imports. Re-check on an openai bump.
 * @google/genai names @modelcontextprotocol/sdk only in its type declarations, and the hoisted SDK is the
 * MCP interop test's devDependency. Re-check on a @google/genai bump.
 */
const UNREACHABLE_OPTIONAL_PEERS = new Map([
  ['openai', new Set(['undici'])],
  ['@google/genai', new Set(['@modelcontextprotocol/sdk'])],
]);

/**
 * Required peers a shipped package names only in its type declarations, so they are not walked.
 * marked-cjk-friendly's dist/index.js imports nothing; pi-tui only takes the tokenizer it returns into its own
 * nested marked, and the hoisted marked is the webview's devDependency. Re-check on a pi-tui or marked-cjk-friendly bump.
 */
const TYPE_ONLY_PEERS = new Map([['marked-cjk-friendly', new Set(['marked'])]]);

function isUnwalkedPeer(json: PackageJson, dep: string): boolean {
  const declaredOnlyAsPeer = !Object.hasOwn(json.dependencies || {}, dep) && !Object.hasOwn(json.optionalDependencies || {}, dep);
  const name = json.name ?? '';
  if (TYPE_ONLY_PEERS.get(name)?.has(dep)) return declaredOnlyAsPeer;
  if (!UNREACHABLE_OPTIONAL_PEERS.get(name)?.has(dep)) return false;
  return declaredOnlyAsPeer && json.peerDependenciesMeta?.[dep]?.optional === true;
}

/**
 * Packages this project declares only in `devDependencies` that a shipped runtime package also requires,
 * with a top-level copy satisfying both ranges. Each was checked against the requiring package's declared
 * range: `@earendil-works/pi-coding-agent` requires `diff@8.0.4`, `@google/genai` requires `ws@^8.18.0` and
 * `openai` declares it as an optional peer `^8.21.0`, `@earendil-works/pi-mcp` requires `cross-spawn@7.0.6`,
 * `protobufjs` requires `@types/node@>=13.7.0`, `@earendil-works/pi-coding-agent` requires `yaml@2.9.0`. They
 * ship because the runtime loads them, not because the build tooling does.
 */
const DEV_DEPS_SHARED_WITH_RUNTIME = new Set(['@types/node', 'cross-spawn', 'diff', 'ws', 'yaml']);

/**
 * Fail loudly when a package this project declares only as a devDependency reaches the ship closure.
 * A new one means a runtime package's dependency resolved to the hoisted build-time copy instead of the
 * nested copy Node would load, which is how a 10 MB compiler binary gets into the VSIX.
 */
function assertNoDevOnlyPackages(topLevel: Set<string>, requirers: Map<string, Set<string>>, label: string): void {
  const json: PackageJson = pkgJson(ROOT) || {};
  const runtime = new Set([
    ...Object.keys(json.dependencies || {}),
    ...Object.keys(json.optionalDependencies || {}),
    ...Object.keys(json.peerDependencies || {}),
  ]);
  const devOnly = [...topLevel].filter(
    (name) =>
      Object.hasOwn(json.devDependencies || {}, name) &&
      !runtime.has(name) &&
      !DEV_DEPS_SHARED_WITH_RUNTIME.has(name),
  );
  if (devOnly.length) {
    const detail = devOnly.sort().map((name) => `${name} (required by ${[...(requirers.get(name) || ['?'])].sort().join(', ')})`);
    throw new Error(
      `devDependencies-only package(s) in the ${label} closure: ${detail.join('; ')}. ` +
      `Check whether the requiring package declares a version the top-level copy does not satisfy; if so ` +
      `the resolution is wrong, not the allowlist.`,
    );
  }
}

/**
 * Packages only the desktop app uses: its externals that the extension lacks (Electron, the native
 * watcher, the updater), node-pty, which only the pty host loads, and the desktop editor, terminal, fonts, test and packaging tooling.
 */
export const DESKTOP_ONLY_PACKAGES = [
  ...DESKTOP_EXTERNALS.filter((name) => !EXTENSION_EXTERNALS.includes(name)),
  'node-pty',
  // main and the daemon run its devcontainer.js by path; nothing imports it
  '@devcontainers/cli',
  'monaco-editor',
  '@fontsource-variable/geist',
  '@fontsource-variable/geist-mono',
  '@fontsource-variable/inter',
  '@playwright/test',
  'playwright',
  'playwright-core',
  'electron-builder',
  'app-builder-lib',
  'app-builder-bin',
  'dmg-builder',
  '@electron/fuses',
];

/** Package name prefixes that are desktop-only as a family: every `@electron/*` tool, the watcher's native prebuilds and xterm with its addons. */
export const DESKTOP_ONLY_PACKAGE_PREFIXES = ['@electron/', '@parcel/watcher-', '@xterm/'];

function isDesktopOnly(name: string): boolean {
  return DESKTOP_ONLY_PACKAGES.includes(name) || DESKTOP_ONLY_PACKAGE_PREFIXES.some((prefix) => name.startsWith(prefix));
}

/** The names in `packages` that belong to the desktop app alone. */
export function desktopOnlyIn(packages: Iterable<string>): string[] {
  return [...packages].filter(isDesktopOnly).sort();
}

/** Fail when a desktop-only package reaches the VSIX closure; the extension never loads one. */
function assertNoDesktopOnlyPackages(topLevel: Set<string>, requirers: Map<string, Set<string>>): void {
  const found = desktopOnlyIn(topLevel);
  if (found.length) {
    const detail = found.map((name) => `${name} (required by ${[...(requirers.get(name) || ['an extension external'])].sort().join(', ')})`);
    throw new Error(`desktop-only package(s) in the VSIX closure: ${detail.join('; ')}.`);
  }
}

/** Platform tokens used in npm native-binary package names (os · cpu · libc/abi). */
const PLATFORM_TOKENS = new Set([
  'win32', 'darwin', 'linux', 'freebsd', 'openbsd', 'netbsd', 'android', 'sunos', 'aix',
  'x64', 'arm64', 'arm', 'ia32', 'x86', 'ppc64', 'ppc', 's390x', 'riscv64', 'loong64', 'mips64el', 'mips64', 'universal',
  'musl', 'glibc', 'gnu', 'gnueabihf', 'eabi', 'msvc',
]);

/** True if the installed package declares `os`/`cpu` — i.e. it is an npm platform-specific binary. */
export function isPlatformBinary(pkgName: string): boolean {
  const json = pkgJson(join(NM, pkgName));
  return !!(json && (Array.isArray(json.os) || Array.isArray(json.cpu)));
}

/**
 * Collapse a platform-binary package to a family glob by stripping trailing platform tokens, e.g.
 * `@vscode/ripgrep-win32-x64` → `@vscode/ripgrep-*`, `@scope/clipboard-linux-x64-musl` → `@scope/clipboard-*`.
 * A name that is nothing but platform tokens (`@esbuild/win32-x64`) leaves no family stem, so the scope
 * itself is the family and the glob becomes `@esbuild/*`.
 * The glob is platform-neutral, so a `.vscodeignore` generated on one OS still ships the right binary on
 * every other (matching the per-`--target` matrix release pipeline). Returns null when no token strips,
 * and null for an unscoped all-token name, which carries no family stem to collapse to.
 */
export function platformFamilyGlob(pkgName: string): string | null {
  const slash = pkgName.lastIndexOf('/');
  const scope = slash >= 0 ? pkgName.slice(0, slash + 1) : '';
  const parts = (slash >= 0 ? pkgName.slice(slash + 1) : pkgName).split('-');
  let stripped = 0;
  while (parts.length > 0 && PLATFORM_TOKENS.has(parts[parts.length - 1]!.toLowerCase())) {
    parts.pop();
    stripped++;
  }
  if (stripped === 0) return null;
  if (parts.length === 0) return scope ? `${scope}*` : null;
  return `${scope}${parts.join('-')}-*`;
}

/**
 * Per-package narrow allowlists: packages that ship large, never-loaded alternate builds. Listing the
 * exact runtime files (instead of the whole `pkg/**`) drops the dead weight — safe because we control
 * the package's `!` patterns directly, so vsce's negate-wins rule can't re-include the omitted files.
 */
const NARROW_ALLOWLIST: Record<string, string[]> = {};

/**
 * Extension-level narrowing for big pure-runtime packages.
 *
 * A handful of packages — the pi agent harness, the provider SDKs it bundles, the MCP SDK — ship their
 * full publish tree: compiled `dist`/`esm` JS *plus* the TypeScript source, every `.map`, and (for the
 * pi harness) `docs/` + `examples/` + `schemas/` + a 9.3 MB nested `node_modules`. Only the compiled JS, JSON, and a
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
 * (TS source, sourcemaps, docs/markdown, lint/editor/CI configs, shell shims, native build sources and
 * headers in rust, C and Objective-C, man pages, tsbuildinfo). Anything in a narrowed package whose
 * extension is in NEITHER set, or an extensionless file that is not a known license/ownership/shim
 * file, trips assertReviewed() and fails the run, so a future dependency bump can never silently drop
 * a brand-new runtime asset type.
 */
const RUNTIME_NARROW_PKGS = new Set(
  (process.env.NARROW_PKGS
    ? process.env.NARROW_PKGS.split(',').map((s) => s.trim()).filter(Boolean)
    : [
        '@earendil-works/pi-coding-agent',
        '@earendil-works/pi-ai',
        '@earendil-works/pi-agent-core',
        '@earendil-works/pi-telemetry',
        '@earendil-works/pi-tui',
        '@earendil-works/pi-mcp',
        '@earendil-works/pi-codemode',
        'quickjs-wasi',
        'openai',
        '@anthropic-ai/sdk',
        '@modelcontextprotocol/sdk',
        '@google/genai',
        // Patchright driver tree (Slice 1). Both ship their full publish tree; only the compiled driver
        // JS/JSON + the browser-launch assets are loaded at runtime — narrow to drop TS source/maps/docs.
        'patchright',
        'patchright-core',
        // Not in the current closure — pi dropped the Mistral SDK in 0.84.2. Kept as a standing rule so
        // a future pi release reintroducing it narrows automatically instead of silently shipping its
        // full publish tree (TS source + maps). Entries for absent packages cost nothing.
        '@mistralai/mistralai',
      ]),
);

const RUNTIME_KEEP_EXTS = new Set([
  'js', 'mjs', 'cjs', 'json', // JS module formats + manifests/data
  'node', 'wasm', // native + wasm binaries (all platforms — keeps the cross-platform VSIX correct)
  'so', // quickjs-wasi's extensions: wasm side modules (wasi-sdk shared libraries) it loads by path
  'css', 'html', 'png', 'svg', 'gif', 'jpg', 'proto', // static assets the harness reads at runtime
]);

const DROP_EXTS = new Set([
  'ts', 'mts', 'cts', 'map', 'tsbuildinfo', // TS source + declarations + sourcemaps + incremental cache
  'md', 'scss', 'rs', 'c', 'h', 'm', 'bnf', 'jsdoc', 'toml', 'sh', 'ps1', 'cmd', '1', 'yml', 'txt', // docs/source/scripts/man/CI/test-data
  'npmignore', 'keep', 'prettierrc', 'prettierignore', 'nvmrc', 'eslintrc', 'eslintignore', 'editorconfig', // tooling configs
  // Patchright driver dead weight (Slice 1).
  // `ttf`/`webmanifest` = codicon fonts + PWA manifest for the bundled trace-viewer/recorder/dashboard
  // web UIs (lib/vite/**) — served only by `show-trace`/`codegen`, which we never invoke; the
  // browser-launch driver (channel:'chrome' → open/navigate/screenshot) never loads them.
  'ttf', 'webmanifest',
]);

/**
 * License, notice and copyright files a narrowed package keeps whatever their extension, because MIT and
 * Apache-2.0 require the text to travel with every copy: a basename that names a license or notice
 * (`LICENSE`, `LICENSE.md`, `ThirdPartyNotices.txt`, esbuild's `<name>.js.LICENSE` sidecars) or any file
 * in a `LICENSES` directory (pi-mcp's only license text is `LICENSES/modelcontextprotocol-typescript-sdk.txt`).
 */
const LICENSE_FILE_NAME = /licen[cs]e|notice/i;

function isLicenseFile(name: string, parentDirName: string): boolean {
  return parentDirName === 'LICENSES' || LICENSE_FILE_NAME.test(name);
}

/**
 * Per-package dead top-level directories to exclude even though they contain keep-extension files.
 *
 * Whole-package keep-globs (`pkg/<star><star>/<star>.png`, etc.) already drop a package's `.ts`/`.map`
 * source, but a few packages also ship docs/examples whose *assets* (PNG screenshots, example
 * package.json/wasm) share an extension with real runtime files and would otherwise be negated back in.
 * The pi harness's `docs/` (incl. a 1.5 MB `docs/images/exy.png`) and `examples/` (a 380 KB
 * `doom-overlay/doom/build/doom.wasm`, sample manifests) are pure documentation, and its `schemas/`
 * holds editor JSON Schemas its theme files cite only by `https://pi.dev` URL; none is read at
 * runtime. For these packages we scope the keep-globs to each runtime top-level dir instead of the whole
 * package, so the dead dirs are simply never negated. Only listed here when the dead dir actually holds
 * keep-extension files (so we don't pay extra patterns for packages whose docs are markdown-only).
 */
const NARROW_DROP_DIRS: Record<string, Set<string>> = {
  '@earendil-works/pi-coding-agent': new Set(['docs', 'examples', 'schemas']),
};

/** Extensionless files that are safe to drop from a narrowed package (ownership/build/CLI-shim). */
const DROP_BASENAMES = new Set([
  'CODEOWNERS', 'Makefile',
  '.keep', '.npmignore', '.prettierrc', '.prettierignore', '.nvmrc', '.eslintrc', '.eslintignore', '.editorconfig', '.gitignore', '.gitattributes', // dotfiles (no basename → treated as extensionless)
  'cli', 'node-which', 'marked', 'yaml', 'semver', 'pi-ai', 'openai', 'jiti', 'fxparser', 'anthropic-ai-sdk',
  // Patchright: Linux `xdg-open` shell shim (patchright-core/lib/xdg-open) — spawned only to open a URL
  // in the OS default app (openExternal / trace report), never on the browser-launch path. Dead weight.
  'xdg-open',
]);

/** Recursively list `{ name, parent }` (basename and parent dir basename) under a directory, skipping traversal errors. */
function listFiles(dir: string, acc: { name: string; parent: string }[] = []): { name: string; parent: string }[] {
  let entries: Dirent[];
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return acc; }
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory()) listFiles(full, acc);
    else acc.push({ name: e.name, parent: basename(dir) });
  }
  return acc;
}

/**
 * Fail loudly if a narrowed package contains a file whose extension is neither kept nor reviewed-dead.
 * This is the safety net that makes extension-level narrowing maintainable: drift in an upstream package
 * (a new asset type the runtime starts loading) surfaces as a build error here, not a broken VSIX.
 */
function assertReviewed(pkgName: string, dir: string): void {
  const unknown = new Set<string>();
  for (const { name, parent } of listFiles(dir)) {
    if (isLicenseFile(name, parent)) continue;
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
      `in scripts/sync-vscodeignore.ts, then re-run.`,
    );
  }
}

/** The re-include base for one top-level dir of a narrowed package ('' is the package root). */
function prefixBase(pkgName: string, prefix: string): string {
  return prefix ? `${pkgName}/${prefix}` : pkgName;
}

/** The runtime keep-extension globs for a narrowed package — only for extensions actually present. */
function runtimeKeepPatterns(pkgName: string, dir: string): string[] {
  assertReviewed(pkgName, dir);
  const dropDirs = NARROW_DROP_DIRS[pkgName] || new Set<string>();
  const perDir = dropDirs.size > 0;

  // Collect the keep-extensions actually present, per top-level dir (so a package with dead doc/example
  // dirs can scope its globs to just the runtime dirs). `roots` keys: '' = package root files, else the
  // top-level dir name. Each maps to the set of keep-extensions present anywhere beneath it.
  const roots = new Map<string, Set<string>>();
  // Same keys as `roots`; each maps to the license file basenames present beneath it.
  const licenses = new Map<string, Set<string>>();
  function addTo(map: Map<string, Set<string>>, prefix: string, value: string): void {
    let set = map.get(prefix);
    if (!set) map.set(prefix, (set = new Set()));
    set.add(value);
  }
  function scan(base: string, prefix: string): void {
    let entries: Dirent[];
    try { entries = readdirSync(base, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.isDirectory()) { scan(join(base, e.name), prefix); continue; }
      if (isLicenseFile(e.name, basename(base))) { addTo(licenses, prefix, e.name); continue; }
      const dot = e.name.lastIndexOf('.');
      if (dot <= 0) continue;
      const ext = e.name.slice(dot + 1).toLowerCase();
      if (!RUNTIME_KEEP_EXTS.has(ext)) continue;
      addTo(roots, prefix, ext);
    }
  }
  if (perDir) {
    // Scan each top-level entry under its own prefix; skip the dead doc/example dirs entirely.
    for (const top of readdirSync(dir, { withFileTypes: true })) {
      if (top.isDirectory()) {
        if (dropDirs.has(top.name)) continue;
        scan(join(dir, top.name), top.name);
      } else {
        if (isLicenseFile(top.name, basename(dir))) { addTo(licenses, '', top.name); continue; }
        const dot = top.name.lastIndexOf('.');
        if (dot <= 0) continue;
        const ext = top.name.slice(dot + 1).toLowerCase();
        if (RUNTIME_KEEP_EXTS.has(ext)) addTo(roots, '', ext);
      }
    }
  } else {
    // Whole-package globs: one `pkg/<star><star>/<star>.ext` per present extension (cheapest pattern set).
    scan(dir, '');
  }

  const globs: string[] = [];
  for (const [prefix, exts] of roots) {
    // prefix '' = package-root files: match a single level (`pkg/*.ext`) so the recursive `**` can't
    // pull keep-ext assets back out of a dropped dir. A package needing no per-dir scoping keeps the
    // cheaper whole-tree `pkg/**/*.ext` form (its '' prefix came from scan(dir,'') over the whole tree).
    if (prefix === '' && perDir) {
      for (const ext of [...exts].sort()) globs.push(`${pkgName}/*.${ext}`);
    } else {
      const base = prefixBase(pkgName, prefix);
      for (const ext of [...exts].sort()) globs.push(`${base}/**/*.${ext}`);
    }
  }
  for (const [prefix, names] of licenses) {
    if (prefix === '' && perDir) {
      for (const name of [...names].sort()) globs.push(`${pkgName}/${name}`);
    } else {
      const base = prefixBase(pkgName, prefix);
      for (const name of [...names].sort()) globs.push(`${base}/**/${name}`);
    }
  }
  globs.sort();
  return globs.length ? globs : [`${pkgName}/**`];
}

/** Allowlist patterns for a closure package: a narrow override, a native-binary family glob, else `pkg/**`. */
export function allowPatterns(pkgName: string): string[] {
  const narrow = NARROW_ALLOWLIST[pkgName];
  if (narrow) return narrow;
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
function consolidateScopes(patterns: Set<string>): Set<string> {
  // Group the simple `@scope/sub/**` patterns by scope; track scopes that have any non-collapsible pattern.
  const byScope = new Map<string, Set<string>>(); // scope -> Set(sub names) covered by a plain `@scope/sub/**`
  const blockedScopes = new Set<string>(); // scope has a narrowed/family/non-simple pattern → never collapse
  for (const p of patterns) {
    const simple = /^(@[^/]+)\/([^/]+)\/\*\*$/.exec(p); // @scope/sub/**
    if (simple) {
      const scope = simple[1]!;
      const sub = simple[2]!;
      if (sub.includes('*')) { blockedScopes.add(scope); continue; } // platform-family glob — keep granular
      let covered = byScope.get(scope);
      if (!covered) byScope.set(scope, (covered = new Set()));
      covered.add(sub);
      continue;
    }
    const scoped = /^(@[^/]+)\//.exec(p); // any other @scope/... pattern (narrowed keep-list, exact file)
    if (scoped) blockedScopes.add(scoped[1]!);
  }

  const result = new Set(patterns);
  for (const [scope, covered] of byScope) {
    if (blockedScopes.has(scope)) continue;
    const dir = join(NM, scope);
    let members: string[];
    try { members = readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name); }
    catch { continue; }
    if (members.length < 2) continue; // nothing to save
    if (!members.every((m) => covered.has(m))) continue; // closure doesn't cover every on-disk member — unsafe
    for (const sub of covered) result.delete(`${scope}/${sub}/**`);
    result.add(`${scope}/**`);
  }
  return result;
}

function buildBlock(): string {
  let patterns = new Set<string>();
  for (const pkg of computeClosure()) {
    for (const p of allowPatterns(pkg)) patterns.add(p);
  }
  if (process.env.NO_CONSOLIDATE !== '1') patterns = consolidateScopes(patterns);
  const lines = [...patterns].sort().map((p) => `!node_modules/${p}`);
  return [BEGIN, ...lines, END].join('\n');
}

/** The file's dominant line ending, so a CRLF working tree (default Windows checkout) round-trips intact. */
function detectEol(text: string): string {
  const crlf = (text.match(/\r\n/g) || []).length;
  const lf = (text.match(/(?<!\r)\n/g) || []).length;
  return crlf > lf ? '\r\n' : '\n';
}

/** Replace the managed block (or insert it right after `node_modules/**`), stripping stale `!node_modules` lines. */
function applyBlock(original: string, block: string): string {
  const eol = detectEol(original);
  const lines = original.split(/\r?\n/); // tolerate CRLF: markers/anchors are compared without the trailing \r
  const out: string[] = [];
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

/** The negations that re-include the extension's own files of dist/: its scope file and each bundle, by exact path. */
export function distNegations(): string[] {
  return ['dist/package.json', ...Object.values(EXTENSION_BUNDLE_FILES)].map((file) => `!${file}`);
}

/**
 * The managed dist/ block: every file of dist/ is excluded except the webview build's folder, whose own rules (Monaco,
 * source maps) still apply, and the extension's files are re-included by exact path. vsce keeps a file any negation
 * matches, whatever the line order, so no negation here may name a folder or a wildcard.
 */
export function buildDistBlock(): string {
  return [DIST_BEGIN, 'dist/*', `dist/!(${WEBVIEW_DIST_FOLDER})/**`, ...distNegations(), DIST_END].join('\n');
}

/** Replace the managed dist/ block, or insert it right after the node_modules block. */
export function applyDistBlock(original: string, block: string): string {
  const eol = detectEol(original);
  const lines = original.split(/\r?\n/);
  const out: string[] = [];
  let inBlock = false;
  let inserted = false;
  for (const line of lines) {
    if (line === DIST_BEGIN) { inBlock = true; continue; }
    if (line === DIST_END) {
      inBlock = false;
      if (!inserted) { out.push(...block.split('\n')); inserted = true; }
      continue;
    }
    if (inBlock) continue;
    out.push(line);
  }
  if (!inserted) {
    const anchor = out.indexOf(END);
    if (anchor === -1) throw new Error('.vscodeignore must hold the node_modules allowlist block to anchor the dist allowlist');
    out.splice(anchor + 1, 0, ...block.split('\n'));
  }
  return out.join(eol);
}

/**
 * `.vscodeignore` rules that keep desktop-only files out of the VSIX: the Monaco editor
 * (vite.config.ts emits all of it under `dist/webview/assets/monaco-`), the desktop build output and
 * packaging config, the end-to-end suite and its output, typecheck-only stubs, the Windows icon file, the terminal's
 * shell-integration scripts, the askpass helper and its scripts, the daemon, its git credential relay and the server
 * packages, and logs.
 * Each must appear verbatim as a line of `.vscodeignore`; the syntax is limited to `*` and `**`.
 */
export const DESKTOP_EXCLUDE_RULES = [
  'dist/webview/assets/monaco-*',
  '**/*.log',
  'dist/desktop/**',
  'dist/desktop-shell/**',
  'dist/core-host.js',
  'dist/daemon.js',
  'dist/subscription-plugin/**',
  'dist/server-packages/**',
  'dist/formatter-host.js',
  'dist/pty-host.js',
  'dist/quick-open-worker.js',
  'dist/watch-worker.js',
  'dist/askpass-main.js',
  'dist/askpass/**',
  'dist/git-credential/**',
  'dist/e2e*/**',
  'dist-desktop/**',
  'e2e/**',
  'build/**',
  'types/**',
  'electron-builder.yml',
  'playwright.*.config.ts',
  'vite.shell.config.ts',
  'resources/icon.ico',
  'resources/shell-integration/**',
  'resources/askpass/**',
  'resources/git-credential/**',
];

/** Why .vscodeignore could let a desktop-only file into the VSIX; empty when every exclusion holds. */
export function vsixExclusionProblems(ignoreText: string): string[] {
  const lines = ignoreText.split(/\r?\n/).map((line) => line.trim());
  const problems: string[] = [];
  for (const rule of DESKTOP_EXCLUDE_RULES) {
    if (!lines.includes(rule)) problems.push(`missing the rule ${rule}`);
  }
  // vsce keeps a file that any negation matches, so only the generated node_modules block, the generated dist/ files and
  // root file names may negate.
  const distFiles = new Set(distNegations());
  const desktopRules = DESKTOP_EXCLUDE_RULES.map(ruleRegex);
  for (const line of lines) {
    if (!line.startsWith('!') || line.startsWith('!node_modules/')) continue;
    if (distFiles.has(line) && !desktopRules.some((re) => re.test(line.slice(1)))) continue;
    if (/[*?[{/]/.test(line.slice(1))) problems.push(`the negation ${line} could re-include a desktop-only file`);
  }
  return problems;
}

/** A DESKTOP_EXCLUDE_RULES glob as an anchored regex over a package-relative path. */
function ruleRegex(rule: string): RegExp {
  const escaped = rule.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  const source = escaped
    .replace(/^\*\*\//, '\u0000')
    .replace(/\/\*\*$/, '\u0001')
    .replace(/\*/g, '[^/]*')
    .replace('\u0000', '(?:.*/)?')
    .replace('\u0001', '/.*');
  return new RegExp(`^${source}$`);
}

/**
 * The entries of a VSIX listing (`unzip -Z1` lines, `extension/`-prefixed) that are desktop-only: a
 * DESKTOP_EXCLUDE_RULES match outside node_modules, or a top-level desktop-only package.
 */
export function forbiddenVsixEntries(listing: string[]): string[] {
  const rules = DESKTOP_EXCLUDE_RULES.map(ruleRegex);
  const found: string[] = [];
  for (const entry of listing) {
    if (!entry.startsWith('extension/')) continue;
    const path = entry.slice('extension/'.length);
    if (path.startsWith('node_modules/')) {
      const [, first = '', second] = path.split('/');
      const name = first.startsWith('@') ? `${first}/${second}` : first;
      if (isDesktopOnly(name)) found.push(entry);
    } else if (rules.some((re) => re.test(path))) {
      found.push(entry);
    }
  }
  return found;
}

const VSIX_MANIFEST = 'extension/package.json';
const VSIX_DIST_SCOPE = 'extension/dist/package.json';

/** The entries a VSIX needs to load its bundles as CommonJS under the manifest's "type": "module": the manifest, its `main` and dist/'s scope. */
export function requiredVsixEntries(main: string): string[] {
  return [VSIX_MANIFEST, VSIX_DIST_SCOPE, `extension/${main.replace(/^\.\//, '')}`];
}

/** Why a VSIX would not load its bundles as CommonJS, from its listing and the manifest and dist/package.json read from it; empty when it would. */
export function vsixScopeProblems(listing: readonly string[], files: ReadonlyMap<string, Buffer>): string[] {
  const manifest = files.get(VSIX_MANIFEST);
  if (!manifest) return [`no ${VSIX_MANIFEST}`];
  const { main } = JSON.parse(manifest.toString('utf8')) as { main?: unknown };
  if (typeof main !== 'string') return [`${VSIX_MANIFEST} names no main`];
  const problems = requiredVsixEntries(main).filter((entry) => !listing.includes(entry)).map((entry) => `missing ${entry}`);
  const scope = files.get(VSIX_DIST_SCOPE);
  if (scope) {
    const { type } = JSON.parse(scope.toString('utf8')) as { type?: unknown };
    if (type !== 'commonjs') problems.push(`${VSIX_DIST_SCOPE} declares type ${String(type ?? 'none')}, not commonjs`);
  }
  return problems;
}

/**
 * `--check-vsix-listing <file> --vsix <vsix>`: exit 1 when a built VSIX (listed by `unzip -Z1`) carries a desktop-only
 * file or would not load its bundles as CommonJS.
 */
function checkVsixListing(listingFile: string, vsixFile: string): void {
  const listing = readFileSync(listingFile, 'utf8').split(/\r?\n/).filter(Boolean);
  if (!listing.some((entry) => entry === VSIX_MANIFEST)) {
    console.error(`${listingFile} is not a VSIX listing: it has no ${VSIX_MANIFEST} entry.`);
    process.exit(1);
  }
  const found = forbiddenVsixEntries(listing);
  if (found.length > 0) {
    console.error(`The VSIX carries ${found.length} desktop-only file(s):\n${found.join('\n')}`);
    process.exit(1);
  }
  const wanted = new Set([VSIX_MANIFEST, VSIX_DIST_SCOPE]);
  const files = new Map(readZip(readFileSync(vsixFile), (path) => wanted.has(path)).map((entry) => [entry.path, entry.data]));
  const scopeProblems = vsixScopeProblems(listing, files);
  if (scopeProblems.length > 0) {
    console.error(`${vsixFile} would not load its bundles as CommonJS: ${scopeProblems.join('; ')}.`);
    process.exit(1);
  }
  console.log(`The VSIX carries no desktop-only file and keeps its CommonJS scope (${listing.length} entries checked).`);
}

function flagValue(flag: string): string | undefined {
  const at = process.argv.indexOf(flag);
  return at === -1 ? undefined : process.argv[at + 1];
}

function main(): void {
  if (process.argv.includes('--check-vsix-listing')) {
    const listingFile = flagValue('--check-vsix-listing');
    const vsixFile = flagValue('--vsix');
    if (!listingFile || !vsixFile) {
      console.error('--check-vsix-listing needs the path of an `unzip -Z1` listing, and --vsix the VSIX it lists.');
      process.exit(1);
    }
    checkVsixListing(listingFile, vsixFile);
    return;
  }
  const check = process.argv.includes('--check');
  const original = readFileSync(IGNORE_FILE, 'utf8');
  const exclusionProblems = vsixExclusionProblems(original);
  if (exclusionProblems.length > 0) {
    console.error(`.vscodeignore does not keep desktop-only files out of the VSIX: ${exclusionProblems.join('; ')}.`);
    process.exit(1);
  }
  const next = applyDistBlock(applyBlock(original, buildBlock()), buildDistBlock());

  if (next === original) {
    console.log('.vscodeignore node_modules and dist allowlists are up to date.');
    process.exit(0);
  }

  if (check) {
    console.error('.vscodeignore node_modules or dist allowlist is STALE. Run: node scripts/sync-vscodeignore.ts');
    process.exit(1);
  }

  writeFileSync(IGNORE_FILE, next);
  console.log('.vscodeignore node_modules and dist allowlists updated.');
}

// Gated so a test can import platformFamilyGlob without rewriting .vscodeignore as a side effect.
if (isEntryPoint(import.meta.url)) main();
