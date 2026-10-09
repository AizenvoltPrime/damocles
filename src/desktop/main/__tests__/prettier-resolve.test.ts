import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isPrettierConfigured, nearestPrettierConfig, resolvePrettier, supportedMajor } from '../formatting/prettier-resolve';

const dirs: string[] = [];

function tempDir(): string {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'prs')));
  dirs.push(dir);
  return dir;
}

function put(file: string, content = ''): string {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return file;
}

/** A stub prettier package in `dir`/node_modules/prettier with its CommonJS entry. */
function installPrettier(dir: string, version: string, main = 'index.cjs'): string {
  const packageDir = path.join(dir, 'node_modules', 'prettier');
  put(path.join(packageDir, 'package.json'), JSON.stringify({ name: 'prettier', version, main }));
  put(path.join(packageDir, main), 'module.exports = {};');
  return packageDir;
}

// A junction on Windows needs no privilege; elsewhere the type is ignored and this is a directory symlink.
function link(target: string, at: string): void {
  fs.mkdirSync(path.dirname(at), { recursive: true });
  fs.symlinkSync(target, at, 'junction');
}

afterEach(() => {
  vi.unstubAllEnvs();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('resolvePrettier', () => {
  it('accepts a Prettier installed inside the root and names its real entry and version', async () => {
    const root = tempDir();
    const packageDir = installPrettier(root, '3.3.3');
    const file = put(path.join(root, 'src', 'a.ts'));
    expect(await resolvePrettier(root, file)).toEqual({ kind: 'inside', entry: path.join(packageDir, 'index.cjs'), version: '3.3.3' });
  });

  it('refuses a Prettier in a parent folder of the root and names where it is', async () => {
    const parent = tempDir();
    const packageDir = installPrettier(parent, '3.3.3');
    const root = path.join(parent, 'packages', 'app');
    const file = put(path.join(root, 'src', 'a.ts'));
    expect(await resolvePrettier(root, file)).toEqual({ kind: 'outside', packageDir });
  });

  it('never looks in NODE_PATH or a global folder', async () => {
    const global = tempDir();
    installPrettier(global, '3.3.3');
    vi.stubEnv('NODE_PATH', path.join(global, 'node_modules'));
    const root = tempDir();
    expect(await resolvePrettier(root, put(path.join(root, 'a.ts')))).toEqual({ kind: 'none' });
  });

  it('takes the nearest package in a monorepo opened at its root', async () => {
    const root = tempDir();
    installPrettier(root, '2.8.8', 'index.js');
    const nested = installPrettier(path.join(root, 'packages', 'web'), '3.3.3');
    const inWeb = put(path.join(root, 'packages', 'web', 'src', 'a.ts'));
    const inApi = put(path.join(root, 'packages', 'api', 'src', 'a.ts'));
    expect(await resolvePrettier(root, inWeb)).toEqual({ kind: 'inside', entry: path.join(nested, 'index.cjs'), version: '3.3.3' });
    expect(await resolvePrettier(root, inApi)).toEqual({ kind: 'inside', entry: path.join(root, 'node_modules', 'prettier', 'index.js'), version: '2.8.8' });
  });

  it('refuses the nearest package when it lies outside the root, even with another inside further up', async () => {
    const parent = tempDir();
    installPrettier(parent, '3.3.3');
    const root = path.join(parent, 'repo');
    installPrettier(root, '3.3.3');
    // The file's own folder has a Prettier linked to outside the root; it is the nearest, so nothing further up counts.
    const elsewhere = tempDir();
    const outside = installPrettier(elsewhere, '3.0.0');
    link(outside, path.join(root, 'pkg', 'node_modules', 'prettier'));
    const file = put(path.join(root, 'pkg', 'a.ts'));
    expect(await resolvePrettier(root, file)).toEqual({ kind: 'outside', packageDir: outside });
  });

  it('follows a symlink or junction under node_modules and refuses one that leaves the root', async () => {
    const root = tempDir();
    const elsewhere = tempDir();
    const outside = installPrettier(elsewhere, '3.3.3');
    link(outside, path.join(root, 'node_modules', 'prettier'));
    expect(await resolvePrettier(root, put(path.join(root, 'a.ts')))).toEqual({ kind: 'outside', packageDir: outside });
  });

  it('accepts a link that stays inside the root, by its real path', async () => {
    const root = tempDir();
    const store = installPrettier(path.join(root, 'node_modules', '.pnpm', 'prettier@3.3.3'), '3.3.3');
    link(store, path.join(root, 'node_modules', 'prettier'));
    expect(await resolvePrettier(root, put(path.join(root, 'a.ts')))).toEqual({ kind: 'inside', entry: path.join(store, 'index.cjs'), version: '3.3.3' });
  });

  it('refuses an entry whose main field climbs out of the root with ..', async () => {
    const parent = tempDir();
    const root = path.join(parent, 'repo');
    const evil = put(path.join(parent, 'evil.js'), 'module.exports = {};');
    put(path.join(root, 'node_modules', 'prettier', 'package.json'), JSON.stringify({ name: 'prettier', version: '3.3.3', main: '../../../evil.js' }));
    expect(await resolvePrettier(root, put(path.join(root, 'a.ts')))).toEqual({ kind: 'outside', packageDir: evil });
  });

  it('does not take a sibling folder whose name starts with the root\'s for the root', async () => {
    const parent = tempDir();
    const root = path.join(parent, 'root');
    const evil = installPrettier(path.join(parent, 'root-evil'), '3.3.3');
    link(path.join(parent, 'root-evil', 'node_modules'), path.join(root, 'node_modules'));
    expect(await resolvePrettier(root, put(path.join(root, 'a.ts')))).toEqual({ kind: 'outside', packageDir: evil });
  });

  it('finds nothing when no folder up to the filesystem root has Prettier', async () => {
    const root = tempDir();
    expect(await resolvePrettier(root, put(path.join(root, 'deep', 'er', 'a.ts')))).toEqual({ kind: 'none' });
  });
});

describe('supportedMajor', () => {
  it('runs 2.x and 3.x only', () => {
    expect(supportedMajor('2.8.8')).toBe(2);
    expect(supportedMajor('3.0.0-alpha.1')).toBe(3);
    expect(supportedMajor('1.19.1')).toBeUndefined();
    expect(supportedMajor('4.0.0')).toBeUndefined();
    expect(supportedMajor('')).toBeUndefined();
  });
});

describe('nearestPrettierConfig', () => {
  it('finds the nearest config source, inside the root, in a parent folder, or none', async () => {
    const parent = tempDir();
    const root = path.join(parent, 'repo');
    const file = put(path.join(root, 'src', 'a.ts'));
    expect(await nearestPrettierConfig(root, file, 3)).toBeUndefined();

    const outside = put(path.join(parent, 'prettier.config.js'), 'module.exports = {};');
    expect(await nearestPrettierConfig(root, file, 3)).toEqual({ path: outside, inside: false });

    // A package.json without a prettier key is no config; with one, it is the nearest source and wins.
    put(path.join(root, 'package.json'), JSON.stringify({ name: 'repo', devDependencies: { prettier: '^3' } }));
    expect(await nearestPrettierConfig(root, file, 3)).toEqual({ path: outside, inside: false });
    const manifest = put(path.join(root, 'package.json'), JSON.stringify({ name: 'repo', prettier: '@acme/prettier-config' }));
    expect(await nearestPrettierConfig(root, file, 3)).toEqual({ path: manifest, inside: true });
    const nearer = put(path.join(root, 'src', '.prettierrc.json'), '{}');
    expect(await nearestPrettierConfig(root, file, 3)).toEqual({ path: nearer, inside: true });
  });

  it('follows a config link out of the root by its real path', async () => {
    const root = tempDir();
    const elsewhere = tempDir();
    put(path.join(elsewhere, 'conf', '.prettierrc.cjs'), 'module.exports = {};');
    put(path.join(elsewhere, 'conf', 'a.ts'));
    link(path.join(elsewhere, 'conf'), path.join(root, 'src'));
    expect(await nearestPrettierConfig(root, path.join(root, 'src', 'a.ts'), 3)).toEqual({ path: path.join(elsewhere, 'conf', '.prettierrc.cjs'), inside: false });
  });

  // Each source below is one Prettier passes over, so it goes on to the parent folder's config: the search must too.
  describe.each([2, 3] as const)('skips what Prettier %i skips', (major) => {
    let parentConfig: string;
    let root: string;
    let file: string;

    beforeEach(() => {
      const parent = tempDir();
      root = path.join(parent, 'repo');
      file = put(path.join(root, 'a.ts'));
      parentConfig = put(path.join(parent, 'prettier.config.js'), 'module.exports = {};');
    });

    it('a folder named like a config file', async () => {
      fs.mkdirSync(path.join(root, '.prettierrc'));
      expect(await nearestPrettierConfig(root, file, major)).toEqual({ path: parentConfig, inside: false });
    });

    it.each([['null'], ['false'], ['""'], ['0']])('a package.json whose prettier key is %s', async (value) => {
      put(path.join(root, 'package.json'), `{ "name": "repo", "prettier": ${value} }`);
      expect(await nearestPrettierConfig(root, file, major)).toEqual({ path: parentConfig, inside: false });
    });

    it('a package.json that is not JSON', async () => {
      put(path.join(root, 'package.json'), '{ "name": ');
      expect(await nearestPrettierConfig(root, file, major)).toEqual({ path: parentConfig, inside: false });
    });
  });

  it.each([['prettier: ~'], ['prettier: null'], ['prettier: false'], ["prettier: ''"], ['prettier:'], ['name: repo']])('skips a package.yaml with %j', async (yaml) => {
    const parent = tempDir();
    const root = path.join(parent, 'repo');
    const file = put(path.join(root, 'a.ts'));
    const parentConfig = put(path.join(parent, '.prettierrc.json'), '{}');
    put(path.join(root, 'package.yaml'), `${yaml}\nversion: 1.0.0\n`);
    expect(await nearestPrettierConfig(root, file, 3)).toEqual({ path: parentConfig, inside: false });
  });

  it('takes a package.yaml with a prettier value or block under Prettier 3 only', async () => {
    const root = tempDir();
    const file = put(path.join(root, 'a.ts'));
    const yaml = put(path.join(root, 'package.yaml'), 'name: repo\nprettier:\n  semi: false\n');
    expect(await nearestPrettierConfig(root, file, 3)).toEqual({ path: yaml, inside: true });
    expect(await nearestPrettierConfig(root, file, 2)).toBeUndefined();
    put(path.join(root, 'package.yaml'), 'prettier: "@acme/prettier-config"\n');
    expect(await nearestPrettierConfig(root, file, 3)).toEqual({ path: yaml, inside: true });
  });

  it('skips an empty .prettierrc under Prettier 2, as cosmiconfig does, and takes it under Prettier 3', async () => {
    const parent = tempDir();
    const root = path.join(parent, 'repo');
    const file = put(path.join(root, 'a.ts'));
    const parentConfig = put(path.join(parent, '.prettierrc.json'), '{}');
    const empty = put(path.join(root, '.prettierrc'), ' \n');
    expect(await nearestPrettierConfig(root, file, 2)).toEqual({ path: parentConfig, inside: false });
    expect(await nearestPrettierConfig(root, file, 3)).toEqual({ path: empty, inside: true });
  });

  it.each([['.prettierrc.mjs'], ['.prettierrc.ts'], ['prettier.config.mts'], ['.prettierrc.cts'], ['package.yaml']])('does not take %s under Prettier 2, which never searches for it', async (name) => {
    const parent = tempDir();
    const root = path.join(parent, 'repo');
    const file = put(path.join(root, 'a.ts'));
    const parentConfig = put(path.join(parent, '.prettierrc.json'), '{}');
    put(path.join(root, name), name === 'package.yaml' ? 'prettier:\n  semi: false\n' : 'export default {};');
    expect(await nearestPrettierConfig(root, file, 2)).toEqual({ path: parentConfig, inside: false });
    expect(await nearestPrettierConfig(root, file, 3)).toEqual({ path: path.join(root, name), inside: true });
  });

  it('takes the file Prettier tries first in a folder: .prettierrc.toml last under both', async () => {
    const root = tempDir();
    const file = put(path.join(root, 'a.ts'));
    put(path.join(root, '.prettierrc.toml'), 'semi = false');
    const js = put(path.join(root, 'prettier.config.cjs'), 'module.exports = {};');
    expect(await nearestPrettierConfig(root, file, 2)).toEqual({ path: js, inside: true });
    expect(await nearestPrettierConfig(root, file, 3)).toEqual({ path: js, inside: true });
    // Prettier 3 tries .prettierrc.ts before prettier.config.cjs; Prettier 2 never tries it.
    const ts = put(path.join(root, '.prettierrc.ts'), 'export default {};');
    expect(await nearestPrettierConfig(root, file, 3)).toEqual({ path: ts, inside: true });
    expect(await nearestPrettierConfig(root, file, 2)).toEqual({ path: js, inside: true });
  });
});

describe('isPrettierConfigured', () => {
  it('finds a config file, a prettier key or a prettier dependency up to the root, and nothing above it', async () => {
    const parent = tempDir();
    const root = path.join(parent, 'repo');
    const file = put(path.join(root, 'src', 'a.ts'));
    put(path.join(parent, '.prettierrc'), '{}');
    expect(await isPrettierConfigured(root, file)).toBe(false);

    put(path.join(root, 'package.json'), JSON.stringify({ name: 'repo', dependencies: { left: '1' } }));
    expect(await isPrettierConfigured(root, file)).toBe(false);
    put(path.join(root, 'package.json'), JSON.stringify({ name: 'repo', devDependencies: { prettier: '^3' } }));
    expect(await isPrettierConfigured(root, file)).toBe(true);
    put(path.join(root, 'package.json'), JSON.stringify({ name: 'repo', prettier: { semi: false } }));
    expect(await isPrettierConfigured(root, file)).toBe(true);
    fs.rmSync(path.join(root, 'package.json'));

    put(path.join(root, 'src', 'prettier.config.mjs'), 'export default {};');
    expect(await isPrettierConfigured(root, file)).toBe(true);
    fs.rmSync(path.join(root, 'src', 'prettier.config.mjs'));
    put(path.join(root, '.prettierrc'), 'semi: false');
    expect(await isPrettierConfigured(root, file)).toBe(true);
  });
});
