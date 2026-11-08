import { globSync } from 'node:fs';
import { join } from 'node:path';
import * as esbuild from 'esbuild';
import { describe, expect, it } from 'vitest';

// docs/invariants.md "No source Playwright loads reads a CommonJS global".
const ROOT = join(__dirname, '..', '..');
const COMMONJS_GLOBALS = ['require', '__dirname', '__filename'];
const MARKER = 'COMMONJS_ONLY_GLOBAL_';
// Never loaded by Playwright: the second host runs as a CommonJS bundle, the fixtures in the app under test.
const NOT_PLAYWRIGHT_LOADED = /^e2e\/desktop\/(second-process|fixtures)\//;

const FIXTURES = 'scripts/__tests__/fixtures/commonjs-globals';

const posix = (file: string): string => file.replaceAll('\\', '/');

const PLAYWRIGHT_ENTRIES = [...globSync('playwright.*.config.ts', { cwd: ROOT }), ...globSync('e2e/**/*.ts', { cwd: ROOT })]
  .map(posix)
  .filter((file) => !file.endsWith('.d.ts') && !file.includes('/node_modules/') && !NOT_PLAYWRIGHT_LOADED.test(file));

/** The repo's own ES module sources the entries import, through value imports; packages stay external. */
async function importedSources(entries: readonly string[]): Promise<string[]> {
  const result = await esbuild.build({
    entryPoints: entries.map((entry) => join(ROOT, entry)),
    absWorkingDir: ROOT,
    bundle: true,
    write: false,
    outdir: join(ROOT, 'out'),
    format: 'esm',
    platform: 'node',
    packages: 'external',
    metafile: true,
    logLevel: 'silent',
  });
  // a .cjs file an ES module imports loads as CommonJS, where these globals are bound
  return Object.keys(result.metafile.inputs).map(posix).filter((file) => /\.(ts|tsx|mts|js|mjs)$/.test(file));
}

/** `file: global` for each CommonJS global a file reads unbound; esbuild's define replaces only an unbound name. */
async function commonJsGlobalReads(files: readonly string[]): Promise<string[]> {
  const result = await esbuild.build({
    entryPoints: files.map((file) => join(ROOT, file)),
    absWorkingDir: ROOT,
    bundle: true,
    write: false,
    outdir: join(ROOT, 'out'),
    outbase: ROOT,
    format: 'esm',
    platform: 'node',
    metafile: true,
    logLevel: 'silent',
    define: Object.fromEntries(COMMONJS_GLOBALS.map((name) => [name, `${MARKER}${name}`])),
    // each file alone, so a finding names the file that reads the global
    plugins: [{ name: 'entries-only', setup: (build) => build.onResolve({ filter: /.*/ }, (args) => (args.kind === 'entry-point' ? undefined : { path: args.path, external: true })) }],
  });
  const entryOf = new Map(Object.entries(result.metafile.outputs).map(([output, meta]) => [posix(join(ROOT, output)), meta.entryPoint]));
  return result.outputFiles.flatMap((output) => {
    const entry = posix(entryOf.get(posix(output.path)) ?? output.path);
    return COMMONJS_GLOBALS.filter((name) => output.text.includes(`${MARKER}${name}`)).map((name) => `${entry}: ${name}`);
  });
}

describe("the sources Playwright's ES module loader runs", () => {
  it('read no CommonJS global, so none is undefined at runtime', async () => {
    expect(PLAYWRIGHT_ENTRIES).toEqual(expect.arrayContaining(['e2e/desktop/global-setup.ts', 'e2e/desktop/support/app.ts', 'playwright.desktop.config.ts']));
    expect(await commonJsGlobalReads(await importedSources(PLAYWRIGHT_ENTRIES))).toEqual([]);
  }, 60_000);

  it('finds each CommonJS global a source reads unbound, and no member or binding of the same name', async () => {
    // scm-service.ts calls a `this.require` member; binds-dirname.ts declares its own __dirname
    expect(await commonJsGlobalReads([
      'src/desktop/main/cli-path-win32.ts',
      'src/core/scm/scm-service.ts',
      `${FIXTURES}/reads-dirname.ts`,
      `${FIXTURES}/reads-filename.ts`,
      `${FIXTURES}/binds-dirname.ts`,
    ])).toEqual(['src/desktop/main/cli-path-win32.ts: require', `${FIXTURES}/reads-dirname.ts: __dirname`, `${FIXTURES}/reads-filename.ts: __filename`]);
  }, 60_000);
});
