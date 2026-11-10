import * as fs from 'node:fs';
import * as path from 'node:path';
import * as ts from 'typescript';
import { describe, expect, it } from 'vitest';
import type { JourneyStep } from '../../../shared/types/design';
import { journeyToPlaywright } from '../journey-playwright';
import contacts from '../../../../e2e/fixtures/design-app/static/contacts.preview-journey.json' with { type: 'json' };

const VIEWPORTS = [{ breakpoint: 'base', width: 390 }, { breakpoint: 'xl', width: 1280 }];
const CONTACTS_SPEC = path.join(__dirname, '..', '..', '..', '..', 'e2e', 'fixtures', 'design-app', 'static', 'contacts.journey.spec.ts');

/** Runs a generated spec against a recording page, as Playwright would call it, and answers what each test did. */
async function runSpec(source: string): Promise<{ titles: string[]; calls: unknown[][] }> {
  const { outputText, diagnostics } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }, reportDiagnostics: true });
  expect(diagnostics ?? []).toEqual([]);
  const titles: string[] = [];
  const calls: unknown[][] = [];
  const locator = (...made: unknown[]): unknown => new Proxy({}, { get: (_target, method) => (...args: unknown[]) => calls.push([...made, method, ...args]) });
  const page = new Proxy({}, { get: (_target, method) => (...args: unknown[]) => (String(method).startsWith('getBy') ? locator(method, ...args) : calls.push([method, ...args])) });
  const tests: (() => Promise<void>)[] = [];
  const test = Object.assign((title: string, body: (fixtures: { page: unknown }) => Promise<void>) => {
    titles.push(title);
    tests.push(() => body({ page }));
  }, { info: () => ({ annotations: { push: (...notes: unknown[]) => calls.push(['annotate', ...notes]) } }) });
  const expect_ = (target: unknown) => new Proxy({}, { get: (_target, matcher) => (...args: unknown[]) => calls.push(['expect', target === undefined ? 'none' : 'locator', matcher, ...args]) });
  const run = new Function('require', 'exports', 'process', outputText) as (require: (name: string) => unknown, exports: object, process: object) => void;
  run((name) => {
    if (name !== '@playwright/test') throw new Error(`The spec required ${name}`);
    return { test, expect: expect_ };
  }, {}, { env: {} });
  for (const body of tests) await body();
  return { titles, calls };
}

describe('journeyToPlaywright (PD-45)', () => {
  it('writes exact: false only where a target set it, and a scroll as scrollIntoViewIfNeeded and mouse.wheel (acceptance)', () => {
    const steps: JourneyStep[] = [
      { action: 'click', target: { role: 'button', name: 'Folding the sections', exact: false } },
      { action: 'assert', target: { text: 'save', exact: false }, expect: { visible: true } },
      { action: 'scroll', target: { role: 'list', name: 'Results' } },
      { action: 'assert', target: { role: 'list', name: 'Results' }, expect: { visible: true } },
      { action: 'scroll', target: { role: 'list', name: 'Results' }, to: 'end' },
      { action: 'assert', target: { text: 'Item 21' }, expect: { visible: true } },
      { action: 'scroll', to: 'end' },
      { action: 'assert', target: { text: 'Item 41' }, expect: { visible: true } },
    ];
    const spec = journeyToPlaywright({ screen: 'S1', state: 'default', steps, untested: [], viewports: VIEWPORTS });
    const { diagnostics } = ts.transpileModule(spec, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }, reportDiagnostics: true });
    expect(diagnostics ?? []).toEqual([]);
    expect(spec).toContain('await page.getByRole("button", { name: "Folding the sections", exact: false }).click();');
    expect(spec).toContain('await expect(page.getByText("save", { exact: false })).toBeVisible();');
    expect(spec).toContain('    await page.getByRole("list", { name: "Results", exact: true }).scrollIntoViewIfNeeded();\n');
    expect(spec).toContain('await page.getByRole("list", { name: "Results", exact: true }).scrollIntoViewIfNeeded(); await page.getByRole("list", { name: "Results", exact: true }).hover(); await page.mouse.wheel(0, 100000);');
    expect(spec).toContain('    await page.mouse.wheel(0, 100000);\n');
    expect(spec).toContain('await expect(page.getByText("Item 41", { exact: true })).toBeVisible();');
  });

  it('writes the contacts journey as the committed spec that Playwright runs against contacts.html', () => {
    const spec = journeyToPlaywright({ screen: 'S1', state: contacts.state, steps: contacts.steps as JourneyStep[], untested: contacts.untested, viewports: VIEWPORTS });
    expect(fs.readFileSync(CONTACTS_SPEC, 'utf8')).toBe(spec);
  });

  it('locates by role, label, placeholder and text, exactly, and uses fill, selectOption, click, press and the three expectations', () => {
    const spec = journeyToPlaywright({ screen: 'S1', state: 'default', steps: contacts.steps as JourneyStep[], untested: [], viewports: VIEWPORTS });
    expect(spec).toContain('await page.getByPlaceholder("Search contacts", { exact: true }).fill("Grace");');
    expect(spec).toContain('await expect(page.getByRole("list", { name: "Contacts", exact: true })).toContainText("Grace Hopper");');
    expect(spec).toContain('await page.getByLabel("Group", { exact: true }).selectOption("work");');
    expect(spec).toContain('await expect(page.getByLabel("Name", { exact: true })).toHaveValue("Ada Lovelace");');
    expect(spec).toContain('await page.getByLabel("Name", { exact: true }).press("Escape");');
    expect(spec).toContain('await expect(page.getByRole("dialog", { name: "New contact", exact: true })).toBeHidden();');
    expect(spec).toContain('await expect(page.getByText("Grace Hopper", { exact: true })).toBeVisible();');
    expect(spec).toContain('for (const width of [390, 1280]) {');
  });

  it('carries hostile names and values into the source only as string literals', async () => {
    const hostile = ['"; process.exit(1); "', '`${process.exit(1)}`', '\'); require("child_process"); (\'', 'a */ process.exit(1); /* b', 'line\nbreak', 'para\u2028graph\u2029end', '\\', '</script>', 'admin\u202E\u2066 // check\u2069\u202C', '\u200Ex\u200F\u061C\u00AD', 'tag\u{E0041}'];
    const steps: JourneyStep[] = hostile.flatMap((text): JourneyStep[] => [
      { action: 'fill', target: { label: text }, value: text },
      { action: 'assert', target: { text }, expect: { valueEquals: text } },
    ]);
    const spec = journeyToPlaywright({ screen: hostile[0]!, state: 'default', steps, untested: hostile, viewports: VIEWPORTS });
    for (const line of spec.split('\n').filter((candidate) => candidate.trimStart().startsWith('//'))) {
      for (const text of hostile) expect(line).not.toContain(text);
    }
    // a bidi control or another format character would show a reviewer a line that reads differently from what it runs
    expect(spec).not.toMatch(/[\p{Cf}\p{Zl}\p{Zp}]/u);
    const { titles, calls } = await runSpec(spec);
    expect(titles).toEqual([`${hostile[0]} journey at 390 px`, `${hostile[0]} journey at 1280 px`]);
    const fills = calls.filter((call) => call[3] === 'fill');
    expect(fills.slice(0, hostile.length).map((call) => [call[1], call[4]])).toEqual(hostile.map((text) => [text, text]));
    const asserted = calls.filter((call) => call[0] === 'expect' && call[2] === 'toHaveValue');
    expect(asserted.slice(0, hostile.length).map((call) => call[3])).toEqual(hostile);
    expect(calls.filter((call) => call[0] === 'annotate')[0]!.slice(2).map((note) => (note as { description: string }).description)).toEqual(hostile);
  });
});
