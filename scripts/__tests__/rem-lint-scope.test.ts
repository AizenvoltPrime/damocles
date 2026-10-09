import { describe, it, expect } from 'vitest';
import { globSync, readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { ESLint } from 'eslint';
import stylelint from 'stylelint';

/**
 * Renderer sizes are rem in both renderer trees (docs/invariants.md "Design tokens"). The lint rules that enforce it are
 * scoped by file globs in eslint.config.mjs and in package.json's lint script, so a narrowed glob silently exempts a folder;
 * this lints a px size and its rem equivalent as files of every top-level folder of each tree that holds Vue files.
 */

const ROOT = join(__dirname, '..', '..');
const TREE_ROOTS = ['src/webview', 'src/desktop/shell'] as const;

// Each tree's root and every top-level folder under it that holds a .vue file, at any depth.
const FOLDERS = TREE_ROOTS.flatMap((root) => [
  root,
  ...readdirSync(join(ROOT, root), { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name !== '__tests__' && globSync(`${root}/${entry.name}/**/*.vue`, { cwd: ROOT }).length > 0)
    .map((entry) => `${root}/${entry.name}`),
]);

const eslint = new ESLint({ cwd: ROOT });

async function eslintErrors(dir: string, classes: string): Promise<string[]> {
  const code = `<template>\n  <div class="${classes}" />\n</template>\n`;
  const [result] = await eslint.lintText(code, { filePath: join(ROOT, dir, 'RemLintProbe.vue') });
  return (result?.messages ?? []).filter((message) => message.severity === 2).map((message) => message.ruleId ?? message.message);
}

async function stylelintRules(dir: string, css: string): Promise<string[]> {
  const { results } = await stylelint.lint({ code: css, codeFilename: join(ROOT, dir, 'rem-lint-probe.css'), cwd: ROOT });
  return results.flatMap((result) => result.warnings.map((warning) => warning.rule));
}

// The stylelint globs of package.json's lint script.
function stylelintGlobs(): string[] {
  const script = (JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { scripts: Record<string, string> }).scripts.lint ?? '';
  const args = /stylelint((?:\s+"[^"]+")+)/.exec(script)?.[1] ?? '';
  return [...args.matchAll(/"([^"]+)"/g)].map((match) => match[1]!);
}

it('probes the folders that hold the renderers\' components', () => {
  expect(FOLDERS).toEqual(expect.arrayContaining(['src/webview/components', 'src/desktop/shell/components', 'src/desktop/shell/terminal', 'src/desktop/shell/editor', 'src/desktop/shell/overlay']));
});

describe.each(FOLDERS)('rem lint in %s', (dir) => {
  it('rejects a px class and accepts its rem equivalent', async () => {
    expect(await eslintErrors(dir, 'text-[13px]')).toContain('better-tailwindcss/no-restricted-classes');
    expect(await eslintErrors(dir, 'text-13')).toEqual([]);
  }, 60_000);

  it('rejects a px font-size in CSS and accepts its rem equivalent', async () => {
    expect(await stylelintRules(dir, '.probe {\n  font-size: 13px;\n}\n')).toContain('declaration-property-unit-disallowed-list');
    expect(await stylelintRules(dir, '.probe {\n  font-size: 0.8125rem;\n}\n')).toEqual([]);
  }, 60_000);

  it("is covered by the lint script's stylelint globs", () => {
    const files = new Set(globSync(stylelintGlobs(), { cwd: ROOT }).map((file) => file.replaceAll('\\', '/')));
    const own = globSync(`${dir}/**/*.{vue,css}`, { cwd: ROOT }).map((file) => file.replaceAll('\\', '/')).filter((file) => !file.includes('/__tests__/'));
    expect(own.length).toBeGreaterThan(0);
    expect(own.filter((file) => !files.has(file))).toEqual([]);
  });
});
