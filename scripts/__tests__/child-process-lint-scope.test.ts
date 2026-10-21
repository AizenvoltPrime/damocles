import { describe, it, expect } from 'vitest';
import { existsSync, readdirSync } from 'fs';
import { join } from 'path';
import { ESLint } from 'eslint';
import * as esbuild from 'esbuild';
import { PROCESS_STARTERS_CORE, PROCESS_STARTERS_DESKTOP } from '../../eslint.config.mjs';

/**
 * A process start blocks the thread that makes it (CreateProcessW), so the UI thread, Damocles Core's thread and the extension
 * host's thread start none: they go through src/core/process-launcher. The ban lives in the no-restricted-imports and
 * no-restricted-syntax option lists of each tree's block in eslint.config.mjs, and the files allowed to start processes get
 * later blocks that restate their tree's electron and vscode bans. This lints a process import as a file of every top-level
 * folder of each tree, checks the allowed files keep the other bans, and that no host bundle includes an allowed file.
 */

const ROOT = join(__dirname, '..', '..');
const TREE_ROOTS = [
  'src/core',
  'src/desktop/main',
  'src/desktop/core-host',
  'src/desktop/core-protocol',
  'src/desktop/local-services',
  'src/desktop/quick-open-worker',
  'src/desktop/watch-worker',
  'src/desktop/askpass',
  'src/desktop/shell',
  'src/desktop/preload',
  'src/platform',
  'src/shared',
  'src/vscode',
  'src/webview',
] as const;
const HOST_ENTRIES = ['src/desktop/main/index.ts', 'src/desktop/core-host/index.ts', 'src/vscode/extension.ts'];
const CORE_HOST_PROBES = ['src/desktop/core-host/probe.ts', 'src/desktop/core-host/platform/probe.ts', 'src/desktop/core-protocol/probe.ts', 'src/desktop/local-services/probe.ts'];
const SKIPPED = new Set(['__tests__', '__mocks__', 'fixtures']);

const FOLDERS = TREE_ROOTS.flatMap((root) => [
  root,
  ...readdirSync(join(ROOT, root), { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !SKIPPED.has(entry.name))
    .map((entry) => `${root}/${entry.name}`),
]);

const eslint = new ESLint({ cwd: ROOT });
const PROCESS_PROBE = [
  "import { spawn } from 'node:child_process';",
  "import * as cp from 'child_process';",
  "import crossSpawn from 'cross-spawn';",
  "export const probe = [spawn, cp, crossSpawn, import('node:child_process'), require('child_process')];",
].join('\n');
const PROCESS_FINDINGS = 5;

async function findings(text: string, filePath: string): Promise<Array<{ ruleId: string | null; message: string }>> {
  const [result] = await eslint.lintText(text, { filePath: join(ROOT, filePath) });
  return (result?.messages ?? []).filter((message) => message.ruleId === '@typescript-eslint/no-restricted-imports' || message.ruleId === 'no-restricted-syntax');
}

async function processFindings(filePath: string, text: string = PROCESS_PROBE): Promise<number> {
  return (await findings(text, filePath)).filter((message) => message.message.includes('src/core/process-launcher')).length;
}

/** How many of a vscode import, an electron import and a dynamic electron import the file's bans reject. */
async function hostModuleFindings(filePath: string): Promise<number> {
  const text = "import * as vscode from 'vscode';\nimport { app } from 'electron';\nexport const probe = [vscode, app, import('electron/main')];\n";
  return (await findings(text, filePath)).length;
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
      'src/core/voice',
      'src/desktop/main',
      'src/desktop/main/search',
      'src/desktop/core-host/platform',
      'src/desktop/core-protocol',
      'src/desktop/local-services',
      'src/desktop/askpass',
      'src/desktop/shell',
      'src/desktop/preload',
      'src/webview/components',
      'src/vscode',
    ]),
  );
});

describe('Damocles Core, its protocol and the per-process services', () => {
  const MAIN_PROBE = [
    "import { a } from '../../main/views';",
    "import { b } from '../main';",
    "import { c } from '../../../desktop/main/views';",
    "export const probe = [a, b, c, import('../../main/index')];",
  ].join('\n');
  const mainFindings = async (file: string): Promise<number> =>
    (await findings(MAIN_PROBE, file)).filter((message) => message.message.includes('never imports desktop main')).length;
  const TEST_PROBES = CORE_HOST_PROBES.map((file) => file.replace(/probe\.ts$/, '__tests__/probe.test.ts'));

  it.each(CORE_HOST_PROBES)('%s keeps the vscode and electron bans', async (file) => {
    expect(await hostModuleFindings(file)).toBe(3);
  }, 60_000);

  it.each(CORE_HOST_PROBES)('%s imports nothing from desktop main', async (file) => {
    expect(await mainFindings(file)).toBe(4);
  }, 60_000);

  it.each(TEST_PROBES)('%s, a test, starts processes and keeps both bans', async (file) => {
    expect(await processFindings(file)).toBe(0);
    expect(await hostModuleFindings(file)).toBe(3);
    expect(await mainFindings(file)).toBe(4);
  }, 60_000);
});

describe.each(FOLDERS)('the process start ban in %s', (dir) => {
  it('rejects child_process and cross-spawn, imported, dynamically imported or required', async () => {
    expect(await processFindings(`${dir}/child-process-lint-probe.ts`)).toBe(PROCESS_FINDINGS);
  }, 60_000);
});

it('rejects node:child_process in memory, a module of the host thread', async () => {
  expect(await processFindings('src/core/memory/index.ts', "import { spawn } from 'node:child_process';\nexport const probe = spawn;\n")).toBe(1);
}, 60_000);

it('lets a type-only import through, which starts nothing', async () => {
  expect(await processFindings('src/core/memory/index.ts', "import type { ChildProcess } from 'node:child_process';\nexport type Probe = ChildProcess;\n")).toBe(0);
}, 60_000);

describe('the files allowed to start processes', () => {
  it.each(PROCESS_STARTERS_CORE)('%s starts processes and keeps the vscode and electron bans', async (file) => {
    expect(await processFindings(file)).toBe(0);
    expect(await hostModuleFindings(file)).toBe(3);
  }, 60_000);

  it.each(['src/desktop/pty-host/probe.ts', 'src/desktop/formatter-host/probe.ts'])('%s, an Electron utility process, starts processes and keeps the vscode ban', async (file) => {
    expect(await processFindings(file)).toBe(0);
    expect(await hostModuleFindings(file)).toBe(1);
  }, 60_000);

  it('tests start processes and keep their tree\'s bans', async () => {
    expect(await processFindings('src/core/memory/__tests__/probe.test.ts')).toBe(0);
    expect(await hostModuleFindings('src/core/memory/__tests__/probe.test.ts')).toBe(3);
    expect(await processFindings('src/core/memory/probe.test.ts')).toBe(0);
    expect(await processFindings('src/desktop/main/__tests__/probe.test.ts')).toBe(0);
    expect(await hostModuleFindings('src/desktop/main/__tests__/probe.test.ts')).toBe(1);
    expect(await processFindings('src/vscode/__tests__/probe.test.ts')).toBe(0);
    expect(await hostModuleFindings('src/vscode/__tests__/probe.test.ts')).toBe(2);
    expect(await processFindings('src/desktop/shell/__tests__/probe.test.ts')).toBe(0);
    expect(await hostModuleFindings('src/desktop/shell/__tests__/probe.test.ts')).toBe(3);
    expect(await processFindings('src/desktop/quick-open-worker/__tests__/probe.test.ts')).toBe(0);
    expect(await hostModuleFindings('src/desktop/quick-open-worker/__tests__/probe.test.ts')).toBe(3);
  }, 60_000);

  it('lists only files and folders that exist', () => {
    const paths = [...PROCESS_STARTERS_CORE, ...PROCESS_STARTERS_DESKTOP.map((glob: string) => glob.replace(/\/\*\*\/\*\.ts$/, ''))];
    expect(paths.filter((file: string) => !existsSync(join(ROOT, file)))).toEqual([]);
  });

  it('runs on no host thread: no host bundle includes one', async () => {
    const inputs = new Set<string>();
    for (const entry of HOST_ENTRIES) for (const file of await hostInputs(entry)) inputs.add(file);
    expect(inputs.has('src/core/process-launcher/pool.ts')).toBe(true);
    expect(inputs.has('src/core/scm/scm-service.ts')).toBe(true);
    expect(PROCESS_STARTERS_CORE.filter((file: string) => inputs.has(file))).toEqual([]);
  }, 120_000);
});
