import { describe, it, expect } from 'vitest';
import { existsSync, readdirSync } from 'fs';
import { createRequire } from 'module';
import { join } from 'path';
import { ESLint } from 'eslint';
import { HOST_DIFF_ALLOWED, JSDIFF_LINEAR_EXPORTS } from '../../eslint.config.mjs';

/**
 * A jsdiff diff costs file length times changed lines, so the UI thread, Damocles Core's thread, the extension host's thread
 * and the daemon's main thread run none: line diffs go to the diff worker (src/core/diff). damocles/host-diff is scoped by
 * NO_SYNC_FILES and an allow list in eslint.config.mjs; a narrowed glob silently exempts a folder. This lints a diff import
 * as a file of every top-level folder of each tree, and checks the allowed files, tests and the renderers stay exempt.
 */

const ROOT = join(__dirname, '..', '..');
const TREE_ROOTS = [
  'src/core',
  'src/desktop/main',
  'src/desktop/core-host',
  'src/desktop/core-protocol',
  'src/desktop/local-services',
  'src/desktop/workspace',
  'src/desktop/daemon',
  'src/desktop/terminal-host',
  'src/remote',
  'src/platform',
  'src/shared',
  'src/vscode',
] as const;
const SKIPPED = new Set(['__tests__', '__mocks__', 'fixtures']);

const FOLDERS = TREE_ROOTS.flatMap((root) => [
  root,
  ...readdirSync(join(ROOT, root), { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !SKIPPED.has(entry.name))
    .map((entry) => `${root}/${entry.name}`),
]);

// jsdiff's value exports that cost more than linear time: its diff functions and their diff instances. With
// JSDIFF_LINEAR_EXPORTS they are every export, so a jsdiff upgrade that adds one fails until it is classified.
const JSDIFF_DIFF_EXPORTS = [
  'Diff', 'diffChars', 'characterDiff', 'diffWords', 'wordDiff', 'diffWordsWithSpace', 'wordsWithSpaceDiff', 'diffLines', 'lineDiff',
  'diffTrimmedLines', 'diffSentences', 'sentenceDiff', 'diffCss', 'cssDiff', 'diffJson', 'jsonDiff', 'diffArrays', 'arrayDiff',
  'structuredPatch', 'createTwoFilesPatch', 'createPatch',
];

const eslint = new ESLint({ cwd: ROOT });
// Each line of the probe file and the host-diff findings it yields.
const PROBE_LINES: ReadonlyArray<readonly [string, number]> = [
  ["import { diffLines, applyPatch } from 'diff';", 1],
  ["import { lineDiff } from 'diff';", 1],
  ["import { default as DefaultNamed } from 'diff';", 1],
  ["import DefaultDiff from 'diff';", 1],
  ["import * as Diff from 'diff';", 1],
  ["import DiffRequired = require('diff');", 1],
  ["export { structuredPatch } from 'diff';", 1],
  ["export * from 'diff';", 1],
  ["export * as DiffAll from 'diff';", 1],
  ["export type { Change, StructuredPatchHunk } from 'diff';", 0],
  ["export const probe = [diffLines, applyPatch, lineDiff, DefaultNamed, DefaultDiff, Diff, DiffRequired, import('diff'), require('diff')];", 2],
];
const PROBE = PROBE_LINES.map(([line]) => line).join('\n');
const PROBE_FINDINGS = PROBE_LINES.reduce((sum, [, findings]) => sum + findings, 0);

async function hostDiffFindings(filePath: string, text: string = PROBE): Promise<number> {
  const [result] = await eslint.lintText(text, { filePath: join(ROOT, filePath) });
  return (result?.messages ?? []).filter((message) => message.ruleId === 'damocles/host-diff').length;
}

it('probes the folders of every tree', () => {
  expect(FOLDERS).toEqual(expect.arrayContaining(['src/core/diff', 'src/core/pi-session', 'src/desktop/main', 'src/desktop/core-host/platform', 'src/desktop/daemon', 'src/vscode']));
});

describe.each(FOLDERS)('damocles/host-diff in %s', (dir) => {
  it('rejects a diff export, a default or namespace import, an import-equals, a re-export, a dynamic import and a require of jsdiff', async () => {
    expect(await hostDiffFindings(`${dir}/host-diff-lint-probe.ts`)).toBe(PROBE_FINDINGS);
  }, 60_000);
});

it.each(PROBE_LINES)('%s yields %i findings', async (line, findings) => {
  const declarations = 'declare const diffLines: unknown, applyPatch: unknown, lineDiff: unknown, DefaultNamed: unknown, DefaultDiff: unknown, Diff: unknown, DiffRequired: unknown;';
  const text = line.startsWith('export const') ? `${declarations}\n${line}\n` : `${line}\n`;
  expect(await hostDiffFindings('src/core/pi-session/chat-changes.ts', text)).toBe(findings);
}, 60_000);

it('classifies every jsdiff export as linear or a diff', () => {
  const exported = Object.keys(createRequire(import.meta.url)('diff') as object).sort();
  expect(exported).toEqual([...JSDIFF_LINEAR_EXPORTS, ...JSDIFF_DIFF_EXPORTS].sort());
});

it('rejects every jsdiff diff export by name', async () => {
  const text = `import { ${JSDIFF_DIFF_EXPORTS.join(', ')} } from 'diff';\nexport const probe = [${JSDIFF_DIFF_EXPORTS.join(', ')}];\n`;
  expect(await hostDiffFindings('src/core/pi-session/chat-changes.ts', text)).toBe(JSDIFF_DIFF_EXPORTS.length);
}, 60_000);

it('lets type imports and the linear exports through', async () => {
  const text = `import { ${JSDIFF_LINEAR_EXPORTS.join(', ')}, type StructuredPatchHunk } from 'diff';\nimport type { Change } from 'diff';\nexport { applyPatch as applyDiffPatch, type ChangeObject } from 'diff';\nexport const probe = [${JSDIFF_LINEAR_EXPORTS.join(', ')}];\nexport type Probe = StructuredPatchHunk | Change;\n`;
  expect(await hostDiffFindings('src/core/pi-session/chat-changes.ts', text)).toBe(0);
}, 60_000);

describe('the files allowed to diff', () => {
  it.each(HOST_DIFF_ALLOWED)('%s imports jsdiff\'s diff functions', async (file) => {
    expect(await hostDiffFindings(file)).toBe(0);
  }, 60_000);

  it('tests and the renderers, which the rule does not cover, diff freely', async () => {
    for (const file of ['src/core/pi-session/__tests__/probe.test.ts', 'src/core/memory/probe.test.ts', 'src/desktop/main/__tests__/probe.test.ts', 'src/desktop/shell/probe.ts', 'src/webview/utils/probe.ts']) {
      expect(await hostDiffFindings(file)).toBe(0);
    }
  }, 60_000);

  it('lists only files that exist', () => {
    expect(HOST_DIFF_ALLOWED.filter((file: string) => !existsSync(join(ROOT, file)))).toEqual([]);
  });
});
