import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { runInNewContext } from 'node:vm';
import { ESLint } from 'eslint';
import * as esbuild from 'esbuild';
import { afterAll, describe, expect, it } from 'vitest';
import { originalFs } from '../esbuild-original-fs.mjs';

/**
 * The build maps every bundled fs import to a shim that picks original-fs under Electron and node:fs under plain Node
 * (docs/invariants.md "Desktop packaging and updates"). Vitest imports source under plain Node, so nothing else runs the shim: these cases bundle
 * snippets and run them against a stub require, once per runtime.
 */

const ROOT = join(__dirname, '..', '..');
const ELECTRON = '44.9.0';

const stubFs = (id: string) => ({ id, promises: { id: `${id}/promises` } });

async function bundle(contents: string, loader: 'ts' | 'js' = 'ts', resolveDir = ROOT): Promise<string> {
  const result = await esbuild.build({
    stdin: { contents, loader, resolveDir, sourcefile: 'case.ts' },
    bundle: true,
    write: false,
    format: 'cjs',
    platform: 'node',
    target: 'node24',
    logLevel: 'silent',
    plugins: [originalFs],
  });
  return result.outputFiles[0]!.text;
}

/** Runs a CommonJS bundle with `electron` as process.versions.electron; returns its exports and every specifier it required. */
function run(code: string, electron: string | undefined): { exports: Record<string, unknown>; required: string[] } {
  const required: string[] = [];
  const modules: Record<string, unknown> = { 'node:fs': stubFs('node:fs'), 'original-fs': stubFs('original-fs') };
  const require = (specifier: string): unknown => {
    required.push(specifier);
    if (!(specifier in modules)) throw new Error(`unexpected require ${specifier}`);
    return modules[specifier];
  };
  const module = { exports: {} as Record<string, unknown> };
  const versions = electron === undefined ? { node: '24.21.0' } : { node: '24.21.0', electron };
  runInNewContext(`(function (module, exports, require, process) {\n${code}\n})`, {})(module, module.exports, require, { versions });
  return { exports: module.exports, required };
}

describe('the original-fs redirect', () => {
  const cases: Array<[string, string, 'ts' | 'js', (runtime: string) => unknown]> = [
    ['a namespace import', "import * as fs from 'fs'; export const r = (fs as any).id;", 'ts', (fs) => fs],
    ['a default import', "import fs from 'node:fs'; export const r = (fs as any).id;", 'ts', (fs) => fs],
    ['a named import', "import { id } from 'fs'; export const r = id;", 'ts', (fs) => fs],
    ['{ promises }', "import { promises } from 'node:fs'; export const r = (promises as any).id;", 'ts', (fs) => `${fs}/promises`],
    ['fs/promises', "import * as p from 'fs/promises'; export const r = (p as any).id;", 'ts', (fs) => `${fs}/promises`],
    ['node:fs/promises', "import p from 'node:fs/promises'; export const r = (p as any).id;", 'ts', (fs) => `${fs}/promises`],
    ['a CommonJS require', "const a = require('fs'); const b = require('node:fs'); module.exports = { r: a.id, same: a === b };", 'js', (fs) => fs],
  ];

  for (const [name, source, loader, expected] of cases) {
    it(`gives ${name} original-fs under Electron and node:fs under plain Node`, async () => {
      const code = await bundle(source, loader);
      for (const [electron, runtime] of [[ELECTRON, 'original-fs'], [undefined, 'node:fs']] as const) {
        const { exports, required } = run(code, electron);
        expect(exports['r']).toBe(expected(runtime));
        expect(required).toEqual([runtime]);
        if ('same' in exports) expect(exports['same']).toBe(true);
      }
    });
  }

  it('gives a dynamic import() the same choice', async () => {
    const code = await bundle("export const r = import('fs').then((m) => (m.default as any).id); export const p = import('node:fs/promises').then((m) => (m.default as any).id);");
    for (const [electron, runtime] of [[ELECTRON, 'original-fs'], [undefined, 'node:fs']] as const) {
      const { exports } = run(code, electron);
      await expect(exports['r']).resolves.toBe(runtime);
      await expect(exports['p']).resolves.toBe(`${runtime}/promises`);
    }
  });

  it('leaves require.resolve(\'fs\') alone, which loads nothing', async () => {
    const code = await bundle("module.exports = { r: require.resolve('fs') };", 'js');
    expect(code).toContain('require.resolve("fs")');
    expect(code).not.toContain('original-fs');
  });

  const bundleResourceFs = async (entry: string): Promise<string> => {
    const result = await esbuild.build({ entryPoints: [entry], bundle: true, write: false, format: 'cjs', platform: 'node', logLevel: 'silent', plugins: [originalFs] });
    return result.outputFiles[0]!.text;
  };

  it('leaves src/core/resource-fs.ts on Electron\'s archive-aware fs', async () => {
    const code = await bundleResourceFs(join(ROOT, 'src/core/resource-fs.ts'));
    expect(code).toContain('require("node:fs")');
    expect(code).toContain('require("node:fs/promises")');
    expect(code).not.toContain('original-fs');
  });

  it.runIf(process.platform === 'win32')('recognizes src/core/resource-fs.ts under a differently cased path', async () => {
    const code = await bundleResourceFs(join(ROOT, 'SRC', 'Core', 'Resource-FS.ts'));
    expect(code).toContain('require("node:fs")');
    expect(code).not.toContain('original-fs');
  });

  it('refuses a direct import of original-fs, which plain Node lacks', async () => {
    await expect(bundle("import 'original-fs';")).rejects.toThrow('Import fs; the build maps it to original-fs under Electron');
  });

  it('refuses ESM output, where the shim\'s require() throws', async () => {
    await expect(esbuild.build({ stdin: { contents: "import 'fs';", resolveDir: ROOT }, bundle: true, write: false, format: 'esm', platform: 'node', logLevel: 'silent', plugins: [originalFs] }))
      .rejects.toThrow("The original-fs plugin needs format: 'cjs'");
  });

  describe('the review gate', () => {
    const dir = mkdtempSync(join(tmpdir(), 'original-fs-gate-'));
    afterAll(() => rmSync(dir, { recursive: true, force: true }));
    const fakePackage = (name: string, source = "module.exports = require('fs').id;\n"): void => {
      mkdirSync(join(dir, 'node_modules', name), { recursive: true });
      writeFileSync(join(dir, 'node_modules', name, 'package.json'), JSON.stringify({ name, main: 'index.js' }));
      writeFileSync(join(dir, 'node_modules', name, 'index.js'), source);
    };
    fakePackage('@scope/unreviewed');
    fakePackage('tar');
    fakePackage('graceful-fs');
    fakePackage('wraps-fs', "module.exports = require('graceful-fs');\n");

    it('fails the build for a bundled package that uses fs and is not reviewed', async () => {
      await expect(bundle("import x from '@scope/unreviewed'; export const r = x;", 'ts', dir)).rejects.toThrow('@scope/unreviewed is bundled and uses fs');
    });

    it('fails the build for an unreviewed package that does its file work through graceful-fs', async () => {
      await expect(bundle("import x from 'wraps-fs'; export const r = x;", 'ts', dir)).rejects.toThrow('wraps-fs is bundled and uses fs');
    });

    it('passes a reviewed package', async () => {
      const code = await bundle("import x from 'tar'; export const r = x;", 'ts', dir);
      expect(run(code, ELECTRON).exports['r']).toBe('original-fs');
    });
  });

  it('is skipped only for the readers of Damocles\' own packed files', () => {
    const importers = (readdirSync(join(ROOT, 'src'), { recursive: true, encoding: 'utf8' }) as string[])
      .filter((file) => /\.(?:ts|vue)$/.test(file) && !/(?:^|[\\/])__tests__[\\/]|\.test\.ts$/.test(file))
      .filter((file) => /['"](?:\.\.?\/)+(?:core\/)?resource-fs['"]/.test(readFileSync(join(ROOT, 'src', file), 'utf8')))
      .map((file) => relative(ROOT, join(ROOT, 'src', file)).replaceAll('\\', '/'))
      .sort();
    expect(importers).toEqual([
      'src/core/config/read-contributed-configuration.ts',
      'src/core/pi-session/session-store/meta-index/worker.ts',
      'src/desktop/local-services/localization-service.ts',
      'src/desktop/main/protocol.ts',
      'src/desktop/main/release-notes.ts',
      'src/desktop/main/remote/server-manifest.ts',
    ]);
  });
});

describe('the getBuiltinModule lint guard', () => {
  const eslint = new ESLint({ cwd: ROOT });
  const PROBE = [
    "export const a = process.getBuiltinModule('fs');",
    "export const b = process.getBuiltinModule('node:fs/promises');",
    "export const c = process.getBuiltinModule('original-fs');",
    "export const d = globalThis.process.getBuiltinModule('fs');",
    "export const e = createRequire(__filename)('node:fs');",
    "export const f = process.getBuiltinModule('node:sqlite');",
    "export const g = createRequire(__filename).resolve('fs');",
  ].join('\n');
  // Test files get their tree's ban too.
  const NODE_FILES = [
    'src/core/probe.ts',
    'src/core/__tests__/probe.test.ts',
    'src/core/process-launcher/worker.ts',
    'src/desktop/main/probe.ts',
    'src/desktop/main/__tests__/probe.test.ts',
    'src/desktop/core-host/probe.ts',
    'src/desktop/core-host/__tests__/probe.test.ts',
    'src/desktop/local-services/probe.ts',
    'src/desktop/watch-worker/probe.ts',
    'src/desktop/watch-worker/__tests__/probe.test.ts',
    'src/desktop/formatter-host/probe.ts',
    'src/vscode/probe.ts',
    'src/vscode/__tests__/probe.test.ts',
  ];

  it.each(NODE_FILES)('refuses an fs lookup in %s and allows node:sqlite and require.resolve', async (file) => {
    const [result] = await eslint.lintText(PROBE, { filePath: join(ROOT, file) });
    const lines = (result?.messages ?? []).filter((message) => message.message.includes('scripts/esbuild-original-fs.mjs')).map((message) => message.line);
    expect(lines).toEqual([1, 2, 3, 4, 5]);
  }, 60_000);
});
