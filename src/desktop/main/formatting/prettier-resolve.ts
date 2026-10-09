import { promises as fs } from 'node:fs';
import { createRequire } from 'node:module';
import * as path from 'node:path';
import { isInsideRealRoot } from '../documents/confine';

export type PrettierResolution =
  // the nearest Prettier, its package and entry real paths inside the root
  | { readonly kind: 'inside'; readonly entry: string; readonly version: string }
  // the nearest Prettier lies outside the root (a parent folder), or a link takes it there; packageDir is its real path
  | { readonly kind: 'outside'; readonly packageDir: string }
  | { readonly kind: 'none' };

// The names Prettier tries in each folder, in its order: Prettier 3's config-searcher.js, and Prettier 2's cosmiconfig
// searchPlaces in resolve-config.js. package.json and package.yaml count only with a truthy prettier key.
const CONFIG_FILES: Readonly<Record<2 | 3, readonly string[]>> = {
  3: [
    'package.json', 'package.yaml', '.prettierrc', '.prettierrc.json', '.prettierrc.yml', '.prettierrc.yaml', '.prettierrc.json5',
    '.prettierrc.js', 'prettier.config.js', '.prettierrc.ts', 'prettier.config.ts', '.prettierrc.mjs', 'prettier.config.mjs',
    '.prettierrc.mts', 'prettier.config.mts', '.prettierrc.cjs', 'prettier.config.cjs', '.prettierrc.cts', 'prettier.config.cts',
    '.prettierrc.toml',
  ],
  2: [
    'package.json', '.prettierrc', '.prettierrc.json', '.prettierrc.yaml', '.prettierrc.yml', '.prettierrc.json5', '.prettierrc.js',
    '.prettierrc.cjs', 'prettier.config.js', 'prettier.config.cjs', '.prettierrc.toml',
  ],
};
// A YAML scalar that loads as null, false or an empty string.
const FALSY_YAML = /^(?:~|null|Null|NULL|false|False|FALSE|''|""|)$/;
const DEPENDENCY_FIELDS: readonly string[] = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'];

function isMissing(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException).code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

async function isDirectory(target: string): Promise<boolean> {
  try {
    return (await fs.stat(target)).isDirectory();
  } catch (err) {
    if (isMissing(err)) return false;
    throw err;
  }
}

async function exists(target: string): Promise<boolean> {
  try {
    await fs.stat(target);
    return true;
  } catch (err) {
    if (isMissing(err)) return false;
    throw err;
  }
}

async function isFile(target: string): Promise<boolean> {
  try {
    return (await fs.stat(target)).isFile();
  } catch (err) {
    if (isMissing(err)) return false;
    throw err;
  }
}

// From dir up to the filesystem root, as Node's module lookup walks; a node_modules folder gets no node_modules of its own.
function* ancestors(dir: string): Generator<string> {
  let current = dir;
  for (;;) {
    yield current;
    const parent = path.dirname(current);
    if (parent === current) return;
    current = parent;
  }
}

/**
 * The Prettier Node's module lookup finds for a file, walking node_modules folders up from the file's folder and never
 * NODE_PATH or a global folder. Only the nearest one counts, and it is accepted only when its package and entry real
 * paths (links and junctions followed) lie inside realRoot. realRoot and realFile are native real paths.
 */
export async function resolvePrettier(realRoot: string, realFile: string): Promise<PrettierResolution> {
  for (const dir of ancestors(path.dirname(realFile))) {
    if (path.basename(dir) === 'node_modules') continue;
    const candidate = path.join(dir, 'node_modules', 'prettier');
    if (!(await isDirectory(candidate))) continue;
    const packageDir = await fs.realpath(candidate);
    if (!isInsideRealRoot(realRoot, packageDir)) return { kind: 'outside', packageDir };
    const manifest = JSON.parse(await fs.readFile(path.join(packageDir, 'package.json'), 'utf8')) as { version?: unknown };
    // An absolute directory resolves through its package.json main field, never through NODE_PATH.
    const entry = await fs.realpath(createRequire(path.join(packageDir, 'package.json')).resolve(packageDir));
    if (!isInsideRealRoot(realRoot, entry)) return { kind: 'outside', packageDir: entry };
    return { kind: 'inside', entry, version: typeof manifest.version === 'string' ? manifest.version : '' };
  }
  return { kind: 'none' };
}

/** The major version 2 or 3, which the host runs, else undefined. */
export function supportedMajor(version: string): 2 | 3 | undefined {
  const major = /^(\d+)\./.exec(version)?.[1];
  return major === '2' ? 2 : major === '3' ? 3 : undefined;
}

async function readManifest(file: string): Promise<Record<string, unknown> | undefined> {
  if (!(await exists(file))) return undefined;
  const manifest = JSON.parse(await fs.readFile(file, 'utf8')) as unknown;
  return typeof manifest === 'object' && manifest !== null && !Array.isArray(manifest) ? (manifest as Record<string, unknown>) : undefined;
}

// Prettier's filter: a package.json that does not parse is no config source.
async function hasPrettierKey(manifestPath: string): Promise<boolean> {
  try {
    const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8')) as unknown;
    return typeof manifest === 'object' && manifest !== null && Boolean((manifest as Record<string, unknown>)['prettier']);
  } catch {
    return false;
  }
}

// A top-level prettier key whose value is no falsy scalar; an empty value counts only with an indented block under it.
function yamlHasPrettierKey(text: string): boolean {
  const lines = text.split(/\r?\n/);
  const at = lines.findIndex((line) => /^prettier\s*:/.test(line));
  if (at < 0) return false;
  const value = lines[at]!.replace(/^prettier\s*:/, '').replace(/\s#.*$/, '').trim();
  if (value !== '') return !FALSY_YAML.test(value);
  const next = lines.slice(at + 1).find((line) => line.trim() !== '' && !line.trimStart().startsWith('#'));
  return next !== undefined && /^\s/.test(next);
}

// The file in dir Prettier takes its config from, tried in Prettier's order with its rules: a regular file (links
// followed), a package.json or package.yaml only with a truthy prettier key, and under Prettier 2 no empty file.
async function configSourceIn(dir: string, major: 2 | 3): Promise<string | undefined> {
  for (const name of CONFIG_FILES[major]) {
    const file = path.join(dir, name);
    if (!(await isFile(file))) continue;
    if (name === 'package.json') {
      if (await hasPrettierKey(file)) return file;
    } else if (name === 'package.yaml') {
      if (yamlHasPrettierKey(await fs.readFile(file, 'utf8'))) return file;
    } else if (major === 3 || (await fs.readFile(file, 'utf8')).trim() !== '') {
      return file;
    }
  }
  return undefined;
}

/**
 * The config source Prettier `major` would load for the file: the nearest one from the file's folder up to the filesystem
 * root, by its real path and whether that lies inside realRoot. undefined when there is none. The host loads exactly this
 * file, so a config Prettier would have found past it never loads.
 */
export async function nearestPrettierConfig(realRoot: string, realFile: string, major: 2 | 3): Promise<{ readonly path: string; readonly inside: boolean } | undefined> {
  for (const dir of ancestors(path.dirname(realFile))) {
    const source = await configSourceIn(dir, major);
    if (source === undefined) continue;
    const real = await fs.realpath(source);
    return { path: real, inside: isInsideRealRoot(realRoot, real) };
  }
  return undefined;
}

function dependsOnPrettier(manifest: Record<string, unknown>): boolean {
  return DEPENDENCY_FIELDS.some((field) => {
    const dependencies = manifest[field];
    return typeof dependencies === 'object' && dependencies !== null && Object.hasOwn(dependencies, 'prettier');
  });
}

/**
 * Whether the project configures Prettier for the file: a Prettier config file, a `prettier` key in package.json or
 * package.yaml, or prettier among package.json's dependencies, in the file's folder or any folder up to realRoot.
 */
export async function isPrettierConfigured(realRoot: string, realFile: string): Promise<boolean> {
  for (const dir of ancestors(path.dirname(realFile))) {
    if (!isInsideRealRoot(realRoot, dir)) return false;
    if ((await configSourceIn(dir, 3)) !== undefined) return true;
    const manifest = await readManifest(path.join(dir, 'package.json'));
    if (manifest && dependsOnPrettier(manifest)) return true;
  }
  return false;
}
