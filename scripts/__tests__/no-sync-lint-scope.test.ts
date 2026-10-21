import { describe, it, expect } from 'vitest';
import { existsSync, readdirSync } from 'fs';
import { join } from 'path';
import { ESLint } from 'eslint';
import * as esbuild from 'esbuild';
import { WORKER_ONLY_FILES } from '../../eslint.config.mjs';

/**
 * A synchronous call on the UI thread, Damocles Core's thread or the extension host's thread freezes the window or every
 * chat (docs/perf.md). damocles/no-sync is scoped by globs and a list of worker-only files in eslint.config.mjs: a narrowed
 * glob silently exempts a folder, and a listed file a host imports exempts host code. This lints a synchronous call as a
 * file of every top-level folder of each tree, and checks no host bundle includes a listed file.
 */

const ROOT = join(__dirname, '..', '..');
const TREE_ROOTS = [
  'src/core',
  'src/desktop/main',
  'src/desktop/core-host',
  'src/desktop/core-protocol',
  'src/desktop/local-services',
  'src/platform',
  'src/shared',
  'src/vscode',
] as const;
const HOST_ENTRIES = ['src/desktop/main/index.ts', 'src/desktop/core-host/index.ts', 'src/vscode/extension.ts'];
const SKIPPED = new Set(['__tests__', '__mocks__', 'fixtures']);

const FOLDERS = TREE_ROOTS.flatMap((root) => [
  root,
  ...readdirSync(join(ROOT, root), { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !SKIPPED.has(entry.name))
    .map((entry) => `${root}/${entry.name}`),
]);

const eslint = new ESLint({ cwd: ROOT });
const PROBE = "import * as fs from 'node:fs';\nexport const probe = fs.readFileSync('x', 'utf8') + String(fs.existsSync('y'));\n";

async function noSyncFindings(filePath: string, text: string = PROBE): Promise<number> {
  const [result] = await eslint.lintText(text, { filePath: join(ROOT, filePath) });
  return (result?.messages ?? []).filter((message) => message.ruleId === 'damocles/no-sync').length;
}

// src/ inputs of a host bundle; packages stay external, as only Damocles' own files can be listed.
async function hostInputs(entry: string): Promise<Set<string>> {
  const result = await esbuild.build({
    entryPoints: [join(ROOT, entry)],
    absWorkingDir: ROOT,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    write: false,
    metafile: true,
    packages: 'external',
    external: ['electron', 'vscode'],
    loader: { '.node': 'empty' },
    logLevel: 'silent',
  });
  return new Set(Object.keys(result.metafile.inputs).map((file) => file.replaceAll('\\', '/')));
}

it('probes the folders of every tree', () => {
  expect(FOLDERS).toEqual(
    expect.arrayContaining([
      'src/core/memory',
      'src/core/pi-session',
      'src/desktop/main',
      'src/desktop/main/platform',
      'src/desktop/core-host/platform',
      'src/desktop/core-protocol',
      'src/desktop/local-services',
      'src/shared/scm',
      'src/vscode',
    ]),
  );
});

describe.each(FOLDERS)('damocles/no-sync in %s', (dir) => {
  it('rejects a synchronous call', async () => {
    expect(await noSyncFindings(`${dir}/no-sync-lint-probe.ts`)).toBe(2);
  }, 60_000);
});

it('exempts tests, wherever they sit, and worker-only files', async () => {
  expect(await noSyncFindings('src/core/memory/__tests__/no-sync-lint-probe.test.ts')).toBe(0);
  expect(await noSyncFindings('src/core/memory/no-sync-lint-probe.test.ts')).toBe(0);
  expect(await noSyncFindings('src/core/memory/no-sync-lint-probe.bench.ts')).toBe(0);
  expect(await noSyncFindings(WORKER_ONLY_FILES[0])).toBe(0);
}, 60_000);

it('exempts only the async queue helpers of `this` named like a sync call', async () => {
  const text = 'export class Probe {\n  run(other: Probe) {\n    this._withProviderSync();\n    other._withProviderSync();\n    this._readSync();\n  }\n}\n';
  expect(await noSyncFindings('src/core/pi-session/no-sync-lint-probe.ts', text)).toBe(2);
}, 60_000);

it('lists only files that exist', () => {
  expect(WORKER_ONLY_FILES.filter((file: string) => !existsSync(join(ROOT, file)))).toEqual([]);
});

it('lists no file a host bundle includes', async () => {
  const inputs = new Set<string>();
  for (const entry of HOST_ENTRIES) for (const file of await hostInputs(entry)) inputs.add(file);
  expect(inputs.has('src/core/chat-panel/index.ts')).toBe(true);
  expect(inputs.has('src/core/scm/scm-service.ts')).toBe(true);
  expect(WORKER_ONLY_FILES.filter((file: string) => inputs.has(file))).toEqual([]);
}, 120_000);
