import { afterEach, describe, expect, it } from 'vitest';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { renderDesignSkills, OUTPUT_FILE } from '../generate-design-skills.ts';

const ROOT = join(__dirname, '..', '..');

const SKILL = (name: string, rule = 'a11y.img-alt', severity = 'warning'): string => `---
name: ${name}
title: A skill
description: What it is for.
validationHints:
  - rule: ${rule}
    severity: ${severity}
    text: The hint.
---

The body.
`;

describe('design skills module', () => {
  let root: string | undefined;
  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true });
    root = undefined;
  });

  // A root with the real rule list and NOTICE, and the given skills.
  function rootWith(skills: Record<string, string>): string {
    root = mkdtempSync(join(tmpdir(), 'design-skills-'));
    mkdirSync(join(root, 'design-skills'));
    mkdirSync(join(root, 'src', 'core', 'design'), { recursive: true });
    copyFileSync(join(ROOT, 'src', 'core', 'design', 'skill-rules.json'), join(root, 'src', 'core', 'design', 'skill-rules.json'));
    copyFileSync(join(ROOT, 'design-skills', 'NOTICE'), join(root, 'design-skills', 'NOTICE'));
    for (const [file, text] of Object.entries(skills)) writeFileSync(join(root, 'design-skills', file), text);
    return root;
  }

  it('the committed file is what the generator produces from design-skills/', () => {
    const committed = readFileSync(OUTPUT_FILE, 'utf8').replace(/\r\n/g, '\n');
    expect(committed, 'design-skills/ changed without a regenerate. Run: npm run generate:design-skills').toBe(renderDesignSkills(ROOT).text);
  });

  it('ships the four initial skills with the MIT notice of open-codesign', () => {
    const { text, count } = renderDesignSkills(ROOT);
    expect(count).toBe(4);
    for (const name of ['empty-states', 'loading-skeleton', 'accessibility-states', 'responsive-layout']) expect(text).toContain(`name: "${name}"`);
    expect(text).toContain(' * Copyright (c) 2026 OpenCoworkAI Contributors');
    expect(text).toContain(' * MIT License');
  });

  // esbuild keeps only legal comments in a bundle, so a // notice would not ship.
  it('writes the notice as one /*! legal comment holding the whole NOTICE', () => {
    const { text } = renderDesignSkills(ROOT);
    const legal = /\/\*!\n([\s\S]*?)\n \*\//.exec(text)?.[1];
    expect(legal).toBeDefined();
    const notice = readFileSync(join(ROOT, 'design-skills', 'NOTICE'), 'utf8').replace(/\r\n/g, '\n').trim();
    expect(legal?.split('\n').map((line) => line.replace(/^ \*( |$)/, '')).join('\n')).toBe(notice);
    expect(text).not.toMatch(/^\/\/ (MIT License|Copyright)/m);
  });

  it('fails on a hint whose rule design-check.ts does not implement', () => {
    expect(() => renderDesignSkills(rootWith({ 'a.md': SKILL('a', 'a11y.made-up') }))).toThrow(/a11y\.made-up" is not a rule design-check\.ts implements/);
  });

  it('fails on two skills with one name', () => {
    expect(() => renderDesignSkills(rootWith({ 'a.md': SKILL('same'), 'b.md': SKILL('same') }))).toThrow(/duplicate skill name same/);
  });

  it('fails on a severity other than error or warning, and defaults an absent one to warning', () => {
    expect(() => renderDesignSkills(rootWith({ 'a.md': SKILL('a', 'a11y.img-alt', 'info') }))).toThrow(/severity must be error or warning/);
    const { text } = renderDesignSkills(rootWith({ 'a.md': SKILL('a').replace('    severity: warning\n', '') }));
    expect(text).toContain('{ rule: "a11y.img-alt", severity: "warning", text: "The hint." }');
  });
});
