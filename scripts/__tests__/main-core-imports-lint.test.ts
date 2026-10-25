import { describe, it, expect } from 'vitest';
import { existsSync } from 'fs';
import { join } from 'path';
import { ESLint } from 'eslint';
import * as esbuild from 'esbuild';
import { MAIN_CORE_IMPORTS } from '../../eslint.config.mjs';

/**
 * Desktop main reaches the engine only through the core protocol: a value import from src/core must name a module of
 * MAIN_CORE_IMPORTS, a value import from src/desktop/core-host is refused, and a type import of any module stays allowed.
 * This lints probes as files of main and of a main subfolder, then bundles main to check what it really includes.
 */

const ROOT = join(__dirname, '..', '..');
const eslint = new ESLint({ cwd: ROOT });
const RULES = new Set(['@typescript-eslint/no-restricted-imports', 'no-restricted-syntax', '@typescript-eslint/no-import-type-side-effects']);

async function findings(filePath: string, text: string): Promise<number> {
  const [result] = await eslint.lintText(text, { filePath: join(ROOT, filePath) });
  return (result?.messages ?? []).filter((message) => message.ruleId !== null && RULES.has(message.ruleId)).length;
}

describe.each([
  ['src/desktop/main/core-imports-probe.ts', '../../core', '../core-host'],
  ['src/desktop/main/scm/core-imports-probe.ts', '../../../core', '../../core-host'],
])('a value import from %s', (filePath, core, coreHost) => {
  it('fails for the engine\'s chat-panel facade', async () => {
    expect(await findings(filePath, `import { ChatPanelProvider } from '${core}/chat-panel';\nexport const probe = ChatPanelProvider;\n`)).toBe(1);
    expect(await findings(filePath, `import { ChatPanelProvider } from '${core}/chat-panel/index';\nexport const probe = ChatPanelProvider;\n`)).toBe(1);
  }, 60_000);

  it('fails as a dynamic import or a require', async () => {
    expect(await findings(filePath, `export const probe = import('${core}/chat-panel');\n`)).toBe(1);
    expect(await findings(filePath, `export const probe = require('${core}/chat-panel');\n`)).toBe(1);
  }, 60_000);

  it('fails for Damocles Core\'s own code, in every form', async () => {
    expect(await findings(filePath, `import { startCoreService } from '${coreHost}/core-service';\nexport const probe = startCoreService;\n`)).toBe(1);
    expect(await findings(filePath, `export const probe = [import('${coreHost}/core-service'), require('${coreHost}/scm')];\n`)).toBe(2);
  }, 60_000);

  it('passes for an allowlisted stateless helper', async () => {
    expect(await findings(filePath, `import { folderKey } from '${core}/workspace-folders/folder-key';\nexport const probe = folderKey;\n`)).toBe(0);
  }, 60_000);

  it('passes as a type import, written so the build drops it', async () => {
    expect(await findings(filePath, `import type { ChatPanelProvider } from '${core}/chat-panel';\nexport type Probe = ChatPanelProvider;\n`)).toBe(0);
    expect(await findings(filePath, `import type { CoreService } from '${coreHost}/core-service';\nexport type Probe = CoreService;\n`)).toBe(0);
    expect(await findings(filePath, `export type Probe = typeof import('${coreHost}/core-service');\n`)).toBe(0);
  }, 60_000);

  it('fails as an inline type import, which verbatimModuleSyntax keeps as a side-effect import', async () => {
    expect(await findings(filePath, `import { type ChatPanelProvider } from '${core}/chat-panel';\nexport type Probe = ChatPanelProvider;\n`)).toBe(1);
  }, 60_000);
});

describe.each([
  ['src/desktop/main/workspace-imports-probe.ts', '../workspace'],
  ['src/desktop/main/search/workspace-imports-probe.ts', '../../workspace'],
])('a value import of the workspace modules from %s', (filePath, workspace) => {
  it('fails for a workspace service, which main reaches through workspaces.forProject', async () => {
    expect(await findings(filePath, `import { createFileSystem } from '${workspace}/file-system';\nexport const probe = createFileSystem;\n`)).toBe(1);
    expect(await findings(filePath, `export const probe = import('${workspace}/file-system');\n`)).toBe(1);
  }, 60_000);

  it('passes for an allowlisted export and for a type', async () => {
    expect(await findings(filePath, `import { WriteRefusedError } from '${workspace}/file-system';\nexport const probe = WriteRefusedError;\n`)).toBe(0);
    expect(await findings(filePath, `import type { WorkspaceFileSystem } from '${workspace}/file-system';\nexport type Probe = WorkspaceFileSystem;\n`)).toBe(0);
  }, 60_000);
});

it('lets main\'s own workspace folder import the workspace modules', async () => {
  expect(await findings('src/desktop/main/workspace/workspace-imports-probe.ts', "import { createFileSystem } from '../../workspace/file-system';\nexport const probe = createFileSystem;\n")).toBe(0);
  expect(await findings('src/desktop/main/search/workspace-imports-probe.ts', "import { createLocalWorkspace } from '../workspace/local-workspace';\nexport const probe = createLocalWorkspace;\n")).toBe(0);
}, 60_000);

it('allowlists only modules that exist', () => {
  const missing = MAIN_CORE_IMPORTS.filter((module) => !existsSync(join(ROOT, 'src/core', `${module}.ts`)) && !existsSync(join(ROOT, 'src/core', module, 'index.ts')));
  expect(missing).toEqual([]);
});

it('bundles exactly the allowlisted modules from main\'s own files, and not the engine', async () => {
  const result = await esbuild.build({
    entryPoints: [join(ROOT, 'src/desktop/main/index.ts')],
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
  const inputs = Object.entries(result.metafile.inputs).map(([file, input]) => [file.replaceAll('\\', '/'), input.imports.map((entry) => entry.path.replaceAll('\\', '/'))] as const);
  const imported = new Set(
    inputs
      .filter(([file]) => file.startsWith('src/desktop/main/'))
      .flatMap(([, paths]) => paths)
      .filter((path) => path.startsWith('src/core/'))
      .map((path) => path.slice('src/core/'.length).replace(/(?:\/index)?\.ts$/, '')),
  );
  expect([...imported].sort()).toEqual([...MAIN_CORE_IMPORTS].sort());
  const files = new Set(inputs.map(([file]) => file));
  expect(['src/core/chat-panel/index.ts', 'src/core/pi-session/pi-session.ts', 'src/core/scm/scm-service.ts', 'src/desktop/core-host/core-service.ts'].filter((file) => files.has(file))).toEqual([]);
}, 120_000);
