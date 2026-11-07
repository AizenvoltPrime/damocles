import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { PiCodingAgentModule } from '../../pi-session/pi-loader';
import type { LoadDesignSkillDetails } from '../../../shared/types/design';
import { runDesignCheck, type DesignCheckInput } from '../design-check';
import type { DesignInventory } from '../inventory';
import { designRuleSetById } from '../rule-set';
import SKILL_RULE_IDS from '../skill-rules.json' with { type: 'json' };
import { designSkill, designSkillNames, loadedSkillHints, skillsOnBranch, type DesignSkillRule } from '../skills';
import { DESIGN_SKILLS } from '../skills.generated';
import { createDesignChatTools, type DesignChatToolDeps } from '../tools/design-chat-tools';

const FIXTURES = path.join(__dirname, 'fixtures');
const INVENTORY: DesignInventory = {
  schemaVersion: 1,
  stack: 'Vue',
  tokens: null,
  breakpoints: { source: 'Tailwind defaults', values: { sm: 640, md: 768, lg: 1024, xl: 1280, '2xl': 1536 } },
  components: [{ name: 'Input', path: 'a.vue' }, { name: 'Table', path: 'a.vue' }],
  screens: [],
  types: [{ name: 'Contact', path: 'a.ts:1', fields: ['name'] }],
  stores: [],
  actions: [],
};

const loaded = (...names: string[]): unknown => ({ type: 'message', message: { role: 'toolResult', toolName: 'LoadDesignSkill', content: [], details: { skills: names.map((name) => ({ name, title: name, hints: 1 })) } satisfies LoadDesignSkillDetails } });

const folders: string[] = [];
afterEach(() => {
  for (const folder of folders.splice(0)) fs.rmSync(folder, { recursive: true, force: true });
});

function designWith(screen: string): string {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'design-skills-'));
  folders.push(folder);
  fs.mkdirSync(path.join(folder, 'screens'));
  fs.copyFileSync(path.join(FIXTURES, 'design.md'), path.join(folder, 'design.md'));
  fs.writeFileSync(path.join(folder, 'screens', 'S1-contacts.html'), screen);
  return folder;
}

function input(folder: string, branch: readonly unknown[]): DesignCheckInput {
  return { folder, inventory: INVENTORY, tokenNames: [], decisionIds: [], fidelity: 'static', skillHints: loadedSkillHints(branch) };
}

const page = (body: string, states = 'default'): string => `<!doctype html><html data-ds-screen="S1" data-ds-states="${states}"><head><title>Contacts</title></head><body>${body}</body></html>`;

describe('design skills', () => {
  it('ships the four initial skills, each hint naming a rule design-check.ts implements', () => {
    expect(designSkillNames().sort()).toEqual(['accessibility-states', 'empty-states', 'loading-skeleton', 'responsive-layout']);
    for (const skill of DESIGN_SKILLS) {
      expect(skill.body.length).toBeGreaterThan(200);
      for (const hint of skill.validationHints) expect(SKILL_RULE_IDS).toContain(hint.rule);
    }
  });

  it('counts a skill as loaded only while a LoadDesignSkill result on the branch lists it', () => {
    expect(skillsOnBranch([])).toEqual([]);
    const failed = { type: 'message', message: { role: 'toolResult', toolName: 'LoadDesignSkill', isError: true, details: { skills: [{ name: 'empty-states' }] } } };
    expect(skillsOnBranch([failed, loaded('nope', 'empty-states'), loaded('empty-states', 'loading-skeleton')]).map((skill) => skill.name)).toEqual(['empty-states', 'loading-skeleton']);
  });

  it('makes an input with only a placeholder an issue quoting the hint once accessibility-states is loaded (acceptance)', async () => {
    const folder = designWith(page('<main><input type="search" placeholder="Search contacts" data-ds-component="Input"><img src="../assets/a.png"></main>'));
    expect((await runDesignCheck(input(folder, []))).summary.errors).toEqual([]);
    const { summary } = await runDesignCheck(input(folder, [loaded('accessibility-states')]));
    const hint = designSkill('accessibility-states')!.validationHints.find((candidate) => candidate.rule === 'a11y.input-label')!;
    expect(summary.errors).toEqual([expect.objectContaining({ rule: 'a11y.input-label', severity: 'error', skill: 'accessibility-states', hint: hint.text, screen: 'S1', element: '<input data-ds-component="Input">' })]);
    expect(summary.errors[0]!.message).toContain(`"${hint.text}"`);
    expect(summary.warnings.map((issue) => issue.rule)).toEqual(['a11y.img-alt']);
    expect(summary.skillHints).toBe(2);
  });

  it('accepts a label, a wrapping label, aria-label and aria-labelledby, and exempts hidden and button inputs', async () => {
    const folder = designWith(page('<label for="a">A</label><input id="a"><label>B <input></label><input aria-label="C"><span id="d">D</span><input aria-labelledby="d"><input type="hidden"><input type="submit" value="Go"><img src="../assets/a.png" alt="">'));
    const { summary } = await runDesignCheck(input(folder, [loaded('accessibility-states')]));
    expect([...summary.errors, ...summary.warnings]).toEqual([]);
  });

  it('asks a collection for an empty state with an action, and bound data for a loading state', async () => {
    const bare = designWith(page('<table data-ds-component="Table"><tr><td data-ds-bind="Contact.name">Ada</td></tr></table>'));
    const issues = (await runDesignCheck(input(bare, [loaded('empty-states', 'loading-skeleton')]))).summary.warnings;
    expect(issues.map((issue) => issue.rule)).toEqual(['states.empty-declared', 'states.loading-declared']);
    const noAction = designWith(page('<ul><li data-ds-bind="Contact.name">Ada</li></ul><p data-ds-state-only="empty">None yet.</p><div data-ds-state-only="loading">…</div>', 'default empty loading'));
    expect((await runDesignCheck(input(noAction, [loaded('empty-states', 'loading-skeleton')]))).summary.warnings.map((issue) => issue.rule)).toEqual(['states.empty-action']);
    const complete = designWith(page('<ul><li data-ds-bind="Contact.name">Ada</li></ul><p data-ds-state-only="empty">None yet. <button>Add a contact</button></p><div data-ds-state-only="loading">…</div>', 'default empty loading'));
    expect((await runDesignCheck(input(complete, [loaded('empty-states', 'loading-skeleton')]))).summary.warnings).toEqual([]);
  });

  it('finds the empty and loading states in a block that lists them among others', async () => {
    const listed = designWith(page('<ul><li data-ds-bind="Contact.name">Ada</li></ul><p data-ds-state-only="empty no-results">None yet. <button>Add a contact</button></p><div data-ds-state-only="error loading">…</div>', 'default empty no-results loading error'));
    expect((await runDesignCheck(input(listed, [loaded('empty-states', 'loading-skeleton')]))).summary.warnings).toEqual([]);
  });

  it('flags viewport-scaled type outside clamp() and fixed widths wider than the smallest screen', async () => {
    const folder = designWith(page('<style>h1 { font-size: 4vw; } h2 { font-size: clamp(1rem, 2vw + var(--x, 1px), 3rem); } .a { width: 1200px; } .b { max-width: 1200px; width: 100%; } .c { min-width: 21rem; }</style>'));
    const { summary } = await runDesignCheck(input(folder, [loaded('responsive-layout')]));
    expect(summary.warnings.map((issue) => `${issue.rule} ${issue.element}`)).toEqual([
      'layout.viewport-font <style> font-size: 4vw',
      'layout.fixed-width <style> width: 1200px',
      'layout.fixed-width <style> min-width: 21rem',
    ]);
  });

  it('implements every rule of skill-rules.json, and none fires without its skill', async () => {
    const implemented: DesignSkillRule[] = ['a11y.input-label', 'a11y.img-alt', 'states.empty-declared', 'states.empty-action', 'states.loading-declared', 'layout.viewport-font', 'layout.fixed-width'];
    expect([...SKILL_RULE_IDS].sort()).toEqual([...implemented].sort());
    const folder = designWith(page('<style>h1 { font-size: 4vw; } .a { width: 1200px; }</style><input placeholder="x"><img src="../assets/a.png"><table><tr><td data-ds-bind="Contact.name">A</td></tr></table>'));
    const { summary } = await runDesignCheck(input(folder, []));
    expect([...summary.errors, ...summary.warnings].filter((issue) => issue.skill !== undefined)).toEqual([]);
  });

  it('reads a long run of digits in a font size in linear time', async () => {
    const folder = designWith(page(`<p style="font-size: ${'1'.repeat(500_000)}x">x</p>`));
    const started = performance.now();
    await runDesignCheck(input(folder, [loaded('responsive-layout')]));
    expect(performance.now() - started).toBeLessThan(2000);
  });
});

describe('LoadDesignSkill', () => {
  const pi = { defineTool: (definition: unknown) => definition } as unknown as PiCodingAgentModule;
  type Tool = { name: string; description: string; execute: (id: string, params: unknown) => Promise<{ content: { text: string }[]; details: unknown }> };
  const deps = { role: () => ({ designId: 'd', folder: '/x', parentSessionId: null, ruleSet: 'reduced', title: 't' }), enabled: () => true } as unknown as DesignChatToolDeps;
  const tool = (): Tool => (createDesignChatTools(pi, deps, designRuleSetById('reduced')) as unknown as Tool[]).find((candidate) => candidate.name === 'LoadDesignSkill')!;

  it('returns the bodies and lists the loaded skills in its details, writing nothing', async () => {
    const result = await tool().execute('call-1', { names: ['accessibility-states', 'accessibility-states'] });
    expect(result.details).toEqual({ skills: [{ name: 'accessibility-states', title: 'Accessibility and states', hints: 2 }] });
    expect(result.content[0]!.text).toContain('# Design skill: accessibility-states');
    expect(result.content[0]!.text).toContain('a11y.input-label (error)');
  });

  it('refuses an unknown name and names the skills', async () => {
    await expect(tool().execute('call-1', { names: ['nope'] })).rejects.toThrow(/No design skill is named nope\. The skills are /);
  });

  it('describes every skill, and its description is the same on every build', () => {
    expect(tool().description).toBe(tool().description);
    for (const name of designSkillNames()) expect(tool().description).toContain(name);
  });
});
