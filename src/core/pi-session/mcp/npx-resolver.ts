/*
 * Lifted from pi-mcp-adapter (MIT). Copyright (c) 2026 Nico Bailon.
 * See THIRD-PARTY-NOTICES.md. Resolves npx/npm-exec invocations to the real binary so a
 * stdio MCP server is not launched under an npm parent process (avoids orphans on kill).
 */
import {
  existsSync,
  readFileSync,
  realpathSync,
  readdirSync,
  statSync,
  writeFileSync,
  renameSync,
  mkdirSync,
  openSync,
  readSync,
  closeSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join, dirname, extname, resolve, relative, isAbsolute, sep } from 'node:path';
import spawn from 'cross-spawn';
import { MCP_NPX_CACHE_PATH } from './paths';
import { killProcessTree } from './utils';

/** The npm CLI binary; cross-spawn resolves `npm` → `npm.cmd` on Windows (bare Node spawn cannot). */
const NPM_BIN = 'npm';

/**
 * A plain npm registry package spec: optional `@scope/`, a package name, and an optional `@version`
 * (tag or range). Rejects anything carrying a protocol or path (`file:`, `git+…`, `http(s):`, `/`, `\`,
 * `..`, `~`). This gates ONLY the parent-skip optimization: an unsafe spec makes `resolveNpxBinary`
 * return null and the caller (server-manager) launches the user's configured `npx`/`npm` command
 * verbatim — so it does not block execution (running the configured command is by design, bounded by
 * workspace trust-gating). It keeps the cache-glob + realpath bin-resolution path to registry specs only.
 */
const NPM_PACKAGE_SPEC = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*(?:@[a-zA-Z0-9._^~>=<|* -]+)?$/;

function isSafePackageSpec(spec: string): boolean {
  const trimmed = spec.trim();
  if (!trimmed || trimmed.length > 214) return false;
  if (trimmed.includes('://') || trimmed.includes('\\') || trimmed.includes('..')) return false;
  return NPM_PACKAGE_SPEC.test(trimmed);
}

/** Whether `child` resolves to a path strictly inside `parent` (defends the resolved bin against escape). */
function isPathInside(child: string, parent: string): boolean {
  const rel = relative(resolve(parent), resolve(child));
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}

const CACHE_VERSION = 1;
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

interface NpxCacheEntry {
  resolvedBin: string;
  resolvedAt: number;
  packageVersion?: string;
  isJs: boolean;
}

interface NpxCache {
  version: number;
  entries: Record<string, NpxCacheEntry>;
}

export interface NpxResolution {
  binPath: string;
  extraArgs: string[];
  isJs: boolean;
}

interface ParsedInvocation {
  packageSpec: string;
  binName?: string;
  extraArgs: string[];
}

export async function resolveNpxBinary(command: string, args: string[]): Promise<NpxResolution | null> {
  const parsed =
    command === 'npx' ? parseNpxArgs(args) : command === 'npm' ? parseNpmExecArgs(args) : null;
  if (!parsed) return null;
  if (!isSafePackageSpec(parsed.packageSpec)) return null;

  const cacheKey = JSON.stringify([command, ...args]);
  const cache = loadCache();
  const cached = cache?.entries?.[cacheKey];

  if (cached && Date.now() - cached.resolvedAt < CACHE_TTL_MS && existsSync(cached.resolvedBin)) {
    // Re-assert cache containment on the hit path too: a tampered cache file must not redirect
    // execution outside the npm cache (the fresh-resolve path enforces the same check).
    const cacheDir = getNpmCacheDir();
    if (cacheDir && isPathInside(cached.resolvedBin, cacheDir)) {
      return { binPath: cached.resolvedBin, extraArgs: parsed.extraArgs, isJs: cached.isJs };
    }
  }

  const resolved = resolveFromNpmCache(parsed.packageSpec, parsed.binName);
  if (resolved) {
    saveCacheEntry(cacheKey, resolved);
    return { binPath: resolved.resolvedBin, extraArgs: parsed.extraArgs, isJs: resolved.isJs };
  }

  await forceNpxCache(parsed.packageSpec);
  const resolvedAfterInstall = resolveFromNpmCache(parsed.packageSpec, parsed.binName);
  if (resolvedAfterInstall) {
    saveCacheEntry(cacheKey, resolvedAfterInstall);
    return {
      binPath: resolvedAfterInstall.resolvedBin,
      extraArgs: parsed.extraArgs,
      isJs: resolvedAfterInstall.isJs,
    };
  }

  return null;
}

function parseNpxArgs(args: string[]): ParsedInvocation | null {
  const separatorIndex = args.indexOf('--');
  const before = separatorIndex >= 0 ? args.slice(0, separatorIndex) : args;
  const after = separatorIndex >= 0 ? args.slice(separatorIndex + 1) : [];

  const positionals: string[] = [];
  let packageSpec: string | undefined;
  let sawPackageFlag = false;
  let foundFirstPositional = false;

  for (let i = 0; i < before.length; i++) {
    const arg = before[i] as string;
    if (foundFirstPositional) {
      positionals.push(arg);
      continue;
    }
    if (arg === '-y' || arg === '--yes') continue;
    if (arg === '-p' || arg === '--package') {
      const value = before[i + 1];
      if (!value || value.startsWith('-')) return null;
      if (!packageSpec) packageSpec = value;
      sawPackageFlag = true;
      i++;
      continue;
    }
    if (arg.startsWith('--package=')) {
      const value = arg.slice('--package='.length);
      if (!value) return null;
      if (!packageSpec) packageSpec = value;
      sawPackageFlag = true;
      continue;
    }
    if (arg.startsWith('-')) {
      return null;
    }
    positionals.push(arg);
    foundFirstPositional = true;
  }

  if (sawPackageFlag) {
    const binName = positionals[0];
    if (!packageSpec || !binName) return null;
    const extraArgs = positionals.slice(1).concat(after);
    return { packageSpec, binName, extraArgs };
  }

  const packagePositional = positionals[0];
  if (!packagePositional) return null;
  const extraArgs = positionals.slice(1).concat(after);
  return { packageSpec: packagePositional, extraArgs };
}

function parseNpmExecArgs(args: string[]): ParsedInvocation | null {
  if (args[0] !== 'exec') return null;
  const execArgs = args.slice(1);
  const separatorIndex = execArgs.indexOf('--');
  if (separatorIndex < 0) return null;

  const before = execArgs.slice(0, separatorIndex);
  const after = execArgs.slice(separatorIndex + 1);

  let packageSpec: string | undefined;
  for (let i = 0; i < before.length; i++) {
    const arg = before[i] as string;
    if (arg === '-y' || arg === '--yes') continue;
    if (arg === '--package') {
      const value = before[i + 1];
      if (!value || value.startsWith('-')) return null;
      if (!packageSpec) packageSpec = value;
      i++;
      continue;
    }
    if (arg.startsWith('--package=')) {
      const value = arg.slice('--package='.length);
      if (!value) return null;
      if (!packageSpec) packageSpec = value;
      continue;
    }
    if (arg.startsWith('-')) {
      return null;
    }
  }

  const binName = after[0];
  if (!packageSpec || !binName) return null;
  const extraArgs = after.slice(1);
  return { packageSpec, binName, extraArgs };
}

function resolveFromNpmCache(packageSpec: string, binName?: string): NpxCacheEntry | null {
  const cacheDir = getNpmCacheDir();
  if (!cacheDir) return null;

  const packageName = extractPackageName(packageSpec);
  if (!packageName) return null;

  const packageDir = findCachedPackageDir(cacheDir, packageName);
  if (!packageDir) return null;

  const packageJsonPath = join(packageDir, 'package.json');
  if (!existsSync(packageJsonPath)) return null;

  let pkg: { bin?: string | Record<string, string>; version?: string } | null = null;
  try {
    pkg = JSON.parse(readFileSync(packageJsonPath, 'utf-8')) as {
      bin?: string | Record<string, string>;
      version?: string;
    };
  } catch {
    return null;
  }

  const binField = pkg?.bin;
  if (!binField) return null;

  const candidates = buildBinCandidates(packageName, binName);
  let chosenBinName: string | undefined;
  let binRel: string | undefined;

  if (typeof binField === 'string') {
    chosenBinName = defaultBinName(packageName);
    binRel = binField;
  } else {
    for (const candidate of candidates) {
      if (binField[candidate]) {
        chosenBinName = candidate;
        binRel = binField[candidate];
        break;
      }
    }
    if (!binRel) {
      const firstEntry = Object.entries(binField)[0];
      if (firstEntry) {
        chosenBinName = firstEntry[0];
        binRel = firstEntry[1];
      }
    }
  }

  if (!binRel) return null;

  const nodeModulesDir = findNodeModulesDir(packageDir);
  const binLink = chosenBinName ? join(nodeModulesDir, '.bin', chosenBinName) : null;
  let resolvedBin = binLink && existsSync(binLink) ? safeRealpath(binLink) : '';
  if (!resolvedBin) {
    resolvedBin = resolve(packageDir, binRel);
    if (!existsSync(resolvedBin)) return null;
  }

  // The resolved binary (after symlink realpath / `bin` join) must stay within the npm cache, so a
  // crafted `.bin` symlink or `bin` field with `../` cannot redirect execution outside the cache (L8).
  if (!isPathInside(resolvedBin, cacheDir)) return null;

  const isJs = detectJsBinary(resolvedBin);
  const entry: NpxCacheEntry = { resolvedBin, resolvedAt: Date.now(), isJs };
  if (pkg?.version !== undefined) entry.packageVersion = pkg.version;
  return entry;
}

const FORCE_CACHE_TIMEOUT_MS = 30_000;

async function forceNpxCache(packageSpec: string): Promise<void> {
  try {
    await new Promise<void>((resolveP, reject) => {
      const proc = spawn(NPM_BIN, ['exec', '--yes', '--package', packageSpec, '--', 'node', '-e', '1'], {
        stdio: 'ignore',
      });
      const timer = setTimeout(() => {
        // Tree-kill: `npm exec` spawns the install + the probe `node` underneath it (L6/H1).
        if (typeof proc.pid === 'number') void killProcessTree(proc.pid);
        else proc.kill();
        reject(new Error('timeout'));
      }, FORCE_CACHE_TIMEOUT_MS);
      timer.unref();
      proc.on('close', () => {
        clearTimeout(timer);
        resolveP();
      });
      proc.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });
  } catch {
    // Ignore failures; resolution falls back to the original command.
  }
}

function buildBinCandidates(packageName: string, explicitBin?: string): string[] {
  const candidates: string[] = [];
  if (explicitBin) candidates.push(explicitBin);

  if (packageName.startsWith('@')) {
    const namePart = packageName.split('/')[1] ?? '';
    const scopePart = packageName.split('/')[0]?.replace('@', '') ?? '';
    if (namePart) candidates.push(namePart);
    if (scopePart && namePart) candidates.push(`${scopePart}-${namePart}`);
  } else {
    candidates.push(packageName);
  }

  return [...new Set(candidates.filter(Boolean))];
}

function extractPackageName(spec: string): string | null {
  const trimmed = spec.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith('@')) {
    const slashIndex = trimmed.indexOf('/');
    if (slashIndex < 0) return null;
    const atIndex = trimmed.lastIndexOf('@');
    if (atIndex > slashIndex) {
      return trimmed.slice(0, atIndex);
    }
    return trimmed;
  }
  const atIndex = trimmed.indexOf('@');
  return atIndex >= 0 ? trimmed.slice(0, atIndex) : trimmed;
}

function defaultBinName(packageName: string): string {
  if (packageName.startsWith('@')) {
    const parts = packageName.split('/');
    return parts[1] ?? packageName.replace('@', '').replace('/', '-');
  }
  return packageName;
}

function findCachedPackageDir(cacheDir: string, packageName: string): string | null {
  const npxDir = join(cacheDir, '_npx');
  if (!existsSync(npxDir)) return null;

  const packagePathParts = packageName.startsWith('@') ? packageName.split('/') : [packageName];

  const candidates = readdirSync(npxDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const full = join(npxDir, entry.name);
      const mtime = safeStatMtime(full);
      return { name: entry.name, mtime };
    })
    .sort((a, b) => b.mtime - a.mtime);

  for (const entry of candidates) {
    const pkgDir = join(npxDir, entry.name, 'node_modules', ...packagePathParts);
    if (existsSync(join(pkgDir, 'package.json'))) {
      return pkgDir;
    }
  }

  return null;
}

function findNodeModulesDir(packageDir: string): string {
  const parts = packageDir.split(sep);
  const idx = parts.lastIndexOf('node_modules');
  if (idx >= 0) {
    return parts.slice(0, idx + 1).join(sep);
  }
  return join(packageDir, '..');
}

function detectJsBinary(binPath: string): boolean {
  const ext = extname(binPath).toLowerCase();
  if (ext === '.js' || ext === '.mjs' || ext === '.cjs') return true;
  try {
    const fd = openSync(binPath, 'r');
    try {
      const buf = Buffer.alloc(256);
      readSync(fd, buf, 0, 256, 0);
      const firstLine = buf.toString('utf-8').split('\n')[0] ?? '';
      return firstLine.startsWith('#!') && firstLine.includes('node');
    } finally {
      closeSync(fd);
    }
  } catch {
    return false;
  }
}

let npmCacheDirCached: string | null | undefined;

function getNpmCacheDir(): string | null {
  if (npmCacheDirCached !== undefined) return npmCacheDirCached;
  if (process.env['NPM_CONFIG_CACHE']) {
    npmCacheDirCached = process.env['NPM_CONFIG_CACHE'];
    return npmCacheDirCached;
  }
  try {
    const result = spawn.sync(NPM_BIN, ['config', 'get', 'cache'], { encoding: 'utf-8' });
    if (result.status === 0) {
      const path = String(result.stdout).trim();
      npmCacheDirCached = path || null;
      return npmCacheDirCached;
    }
  } catch {
    npmCacheDirCached = null;
    return null;
  }
  npmCacheDirCached = null;
  return null;
}

function loadCache(): NpxCache | null {
  if (!existsSync(MCP_NPX_CACHE_PATH)) return null;
  try {
    const raw = JSON.parse(readFileSync(MCP_NPX_CACHE_PATH, 'utf-8'));
    if (!raw || typeof raw !== 'object') return null;
    if (raw.version !== CACHE_VERSION) return null;
    if (!raw.entries || typeof raw.entries !== 'object') return null;
    return raw as NpxCache;
  } catch {
    return null;
  }
}

function saveCacheEntry(key: string, entry: NpxCacheEntry): void {
  const dir = dirname(MCP_NPX_CACHE_PATH);
  mkdirSync(dir, { recursive: true });

  const merged: NpxCache = { version: CACHE_VERSION, entries: {} };
  try {
    if (existsSync(MCP_NPX_CACHE_PATH)) {
      const existing = JSON.parse(readFileSync(MCP_NPX_CACHE_PATH, 'utf-8')) as NpxCache;
      if (existing && existing.version === CACHE_VERSION && existing.entries) {
        merged.entries = { ...existing.entries };
      }
    }
  } catch {
    // Ignore parse errors.
  }

  merged.entries[key] = entry;
  // Unique temp name per write so a write can never clobber another's temp file before rename. (The
  // read-merge-write above is already atomic within a process — saveCacheEntry is fully synchronous.)
  const tmpPath = `${MCP_NPX_CACHE_PATH}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(tmpPath, JSON.stringify(merged, null, 2), 'utf-8');
  renameSync(tmpPath, MCP_NPX_CACHE_PATH);
}

function safeRealpath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return '';
  }
}

function safeStatMtime(path: string): number {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return 0;
  }
}
