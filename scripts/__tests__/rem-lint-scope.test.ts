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

// The quoted globs of a lint script's stylelint command, whatever flags sit among them.
function stylelintGlobs(script: string): string[] {
  const args = /stylelint\s([^&|;]*)/.exec(script)?.[1] ?? '';
  return [...args.matchAll(/"([^"]+)"/g)].map((match) => match[1]!);
}

const LINT_SCRIPT = (JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { scripts: Record<string, string> }).scripts.lint ?? '';

it('reads the stylelint globs past any flags, and finds some in the lint script', () => {
  for (const flags of ['--max-warnings 0', '--max-warnings=0', '-q', '--formatter json', '--custom-syntax postcss-html --cache']) {
    expect(stylelintGlobs(`eslint "src/**/*.ts" && stylelint ${flags} "a/**/*.css" "b/**/*.vue" && echo "done"`)).toEqual(['a/**/*.css', 'b/**/*.vue']);
  }
  expect(stylelintGlobs(LINT_SCRIPT).length).toBeGreaterThan(0);
});

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

  // A corner follows the theme's radius scale: the ramp, or a value scaled by --d-radius-scale.
  it('rejects a raw radius class and accepts the ramp, a scaled value and a value built on the ramp', async () => {
    for (const raw of ['rounded-[0.1875rem]', 'rounded-t-[0.25rem]', 'hover:rounded-[0.3125rem_0.875rem]']) {
      expect(await eslintErrors(dir, raw), raw).toContain('better-tailwindcss/no-restricted-classes');
    }
    for (const scaled of ['rounded-md', 'rounded-5', 'rounded-[calc(0.1875rem*var(--d-radius-scale,1))]', 'rounded-[calc(var(--radius-2xl)+var(--spacing)*1.25)]', 'rounded-[inherit]', 'rounded-[50%]']) {
      expect(await eslintErrors(dir, scaled), scaled).toEqual([]);
    }
  }, 60_000);

  // Motion is a class of motion.css or a renderer stylesheet, which the reduced-motion rules and the keyframe guard cover.
  it('rejects a Tailwind animation utility, arbitrary or built in, and accepts a motion class', async () => {
    for (const utility of ['animate-[d-fade_.2s]', 'animate-spin', 'after:animate-[o-sweep_1.3s_infinite]', 'in-[.leaving]:animate-[d-pop-out_.12s_both]']) {
      expect(await eslintErrors(dir, utility), utility).toContain('better-tailwindcss/no-restricted-classes');
    }
    for (const motion of ['d-fade-in', 'd-pulsing', 'd-pop-in [--enter-delay:60ms]']) {
      expect(await eslintErrors(dir, motion), motion).toEqual([]);
    }
  }, 60_000);

  it('rejects a raw radius in CSS and accepts the ramp, a scaled value, 0, a percentage and the pill', async () => {
    for (const raw of ['border-radius: 0.375rem', 'border-radius: 0 0.25rem 0.25rem 0', 'border-top-left-radius: 0.5rem', 'border-radius: 0.375rem !important']) {
      expect(await stylelintRules(dir, `.probe {\n  ${raw};\n}\n`), raw).toContain('declaration-property-value-disallowed-list');
    }
    for (const scaled of ['border-radius: var(--radius-6)', 'border-radius: 0 var(--radius-md) var(--radius-md) 0', 'border-radius: calc(0.0625rem * var(--d-radius-scale, 1))', 'border-radius: 0', 'border-radius: 50%', 'border-radius: 999rem', 'border-radius: inherit']) {
      expect(await stylelintRules(dir, `.probe {\n  ${scaled};\n}\n`), scaled).toEqual([]);
    }
  }, 60_000);

  it("is covered by the lint script's stylelint globs", () => {
    const files = new Set(globSync(stylelintGlobs(LINT_SCRIPT), { cwd: ROOT }).map((file) => file.replaceAll('\\', '/')));
    const own = globSync(`${dir}/**/*.{vue,css}`, { cwd: ROOT }).map((file) => file.replaceAll('\\', '/')).filter((file) => !file.includes('/__tests__/'));
    expect(own.length).toBeGreaterThan(0);
    expect(own.filter((file) => !files.has(file))).toEqual([]);
  });
});
