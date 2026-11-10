import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DESIGN_CHECK_SEVERITY, runDesignCheck, type DesignCheckInput, type DesignCheckRule } from '../design-check';
import type { DesignInventory } from '../inventory';
import { issueCount } from '../../../shared/types/design';
import { record } from './decision-kit';

const FIXTURES = path.join(__dirname, 'fixtures');

const INVENTORY: DesignInventory = {
  schemaVersion: 1,
  stack: 'Laravel 11, Inertia, Vue 3, Tailwind 4',
  tokens: null,
  breakpoints: { source: 'Tailwind defaults', values: { sm: 640, md: 768, lg: 1024, xl: 1280, '2xl': 1536 } },
  components: [
    { name: 'Button', path: 'resources/js/components/ui/Button.vue', variants: ['primary', 'secondary', 'ghost', 'danger'] },
    { name: 'Input', path: 'resources/js/components/ui/Input.vue' },
    { name: 'Table', path: 'resources/js/components/ui/Table.vue', variants: ['comfortable', 'compact'] },
  ],
  screens: [],
  types: [{ name: 'Contact', path: 'types/contact.ts:1', fields: ['id', 'name', 'email', 'phone', 'status'] }],
  stores: [],
  actions: [],
};
const TOKENS = ['--spacing', '--color-surface', '--color-muted-foreground', '--color-border', '--radius-sm', '--radius-md'];

const folders: string[] = [];
afterEach(() => {
  for (const folder of folders.splice(0)) fs.rmSync(folder, { recursive: true, force: true });
});

/** A design folder holding design.md and one screen copied from the fixtures. */
function designWith(screen: string, doc = 'design.md'): string {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'design-check-'));
  folders.push(folder);
  fs.mkdirSync(path.join(folder, 'screens'));
  fs.copyFileSync(path.join(FIXTURES, doc), path.join(folder, 'design.md'));
  fs.copyFileSync(path.join(FIXTURES, screen), path.join(folder, 'screens', 'S1-contacts.html'));
  return folder;
}

function input(folder: string, overrides: Partial<DesignCheckInput> = {}): DesignCheckInput {
  return { folder, inventory: INVENTORY, tokenNames: TOKENS, decisions: [record('D1', 'Fidelity', 'Static mockup'), record('D2', 'Density', 'Compact')], fidelity: 'static', skillHints: [], screenshots: true, ...overrides };
}

// the static rules; the width rules run on probes (design-check-widths.test.ts)
const FAILING_RULES = Object.keys(DESIGN_CHECK_SEVERITY).filter((rule) => !['design.frontmatter', 'screen.size', 'layout.overflow', 'ds.hidden-required', 'journey.required', 'motion.reduced-motion', 'decisions.conflict', 'decisions.unchecked', 'ds.decision-replaced'].includes(rule)) as DesignCheckRule[];

describe('DesignCheck, the decisions (D99)', () => {
  const answered = record('D3', 'Surfaces', 'No white', { conflicts: [{ id: 'D2', kind: 'contradicts', reason: 'white cards vs no white' }] });

  it('errors on a current question decision whose stored flag names another current decision, until a refinement replaces it (acceptance)', async () => {
    const folder = designWith('pass.html');
    const flagged = await runDesignCheck(input(folder, { decisions: [record('D1', 'Fidelity', 'Static mockup'), record('D2', 'Cards', 'White'), answered] }));
    expect(flagged.summary.errors).toEqual([expect.objectContaining({ rule: 'decisions.conflict', severity: 'error', screen: 'decisions.md', element: 'D3' })]);
    expect(flagged.summary.errors[0]!.message).toContain('RecordDecision, source {kind: "question", ref: "D3"}, replaces: ["D3", "D2"]');
    const refined = record('D4', 'Surfaces', 'Warm glass', { kind: 'question', source: { kind: 'question', ref: 'D3' }, replaces: ['D3', 'D2'] });
    const resolved = await runDesignCheck(input(folder, { decisions: [record('D1', 'Fidelity', 'Static mockup'), record('D2', 'Cards', 'White'), answered, refined] }));
    expect(resolved.summary.errors.map((issue) => issue.rule)).not.toContain('decisions.conflict');
  });

  it('warns on a decision recorded unchecked and on a screen that cites a replaced decision (acceptance)', async () => {
    const decisions = [record('D1', 'Fidelity', 'Static mockup'), record('D2', 'Density', 'Compact', { conflictCheck: 'unchecked', uncheckedReason: 'noModel' }), record('D3', 'Fidelity', 'Static mockup', { replaces: ['D1'] })];
    const { summary } = await runDesignCheck(input(designWith('pass.html'), { decisions }));
    expect(summary.errors).toEqual([]);
    expect(summary.warnings.map((issue) => [issue.rule, issue.screen, issue.element])).toEqual([
      ['decisions.unchecked', 'decisions.md', 'D2'],
      ['ds.decision-replaced', 'S1', expect.stringContaining('<button')],
    ]);
    expect(summary.warnings[1]!.message).toBe('D1 was replaced by D3; cite the current decision.');
  });
});

describe('DesignCheck, static', () => {
  it('passes a screen that uses only inventory components, tokens, decisions and local assets', async () => {
    const { summary, screens } = await runDesignCheck(input(designWith('pass.html')));
    expect(summary.errors).toEqual([]);
    expect(summary.warnings).toEqual([]);
    expect(screens.map((screen) => screen.id)).toEqual(['S1']);
    expect(summary.attributesChecked).toBeGreaterThan(10);
    expect(summary.tokensChecked).toBe(TOKENS.length);
  });

  it.each(FAILING_RULES)('flags %s on the screen that breaks it, and nothing else', async (rule) => {
    const { summary } = await runDesignCheck(input(designWith(`fail-${rule}.html`)));
    expect(summary.errors.map((issue) => issue.rule)).toEqual(expect.arrayContaining([rule]));
    expect(new Set(summary.errors.map((issue) => issue.rule))).toEqual(new Set([rule]));
    expect(summary.errors.every((issue) => issue.severity === 'error' && issue.screen === 'S1')).toBe(true);
  });

  it('flags an off-token color, an unknown component and an unnamed button with no model call (acceptance)', async () => {
    for (const rule of ['tokens.color', 'ds.component-known', 'a11y.control-name'] as const) {
      const { summary } = await runDesignCheck(input(designWith(`fail-${rule}.html`)));
      expect(summary.errors.some((issue) => issue.rule === rule)).toBe(true);
    }
  });

  it('allows scripts in an interactive design', async () => {
    const { summary } = await runDesignCheck(input(designWith('fail-fidelity.static-no-scripts.html'), { fidelity: 'interactive' }));
    expect(summary.errors).toEqual([]);
  });

  it('validates design.md frontmatter against the inventory breakpoints', async () => {
    const { summary } = await runDesignCheck(input(designWith('pass.html', 'design-bad.md')));
    expect(summary.errors.map((issue) => issue.rule)).toEqual(['design.frontmatter', 'design.frontmatter', 'design.frontmatter', 'design.frontmatter']);
    expect(summary.errors.every((issue) => issue.screen === 'design.md')).toBe(true);
  });

  it('reports a missing design.md', async () => {
    const folder = designWith('pass.html');
    fs.rmSync(path.join(folder, 'design.md'));
    const { summary } = await runDesignCheck(input(folder));
    expect(summary.errors.map((issue) => issue.rule)).toEqual(['design.frontmatter']);
  });

  it('refuses to read a screen past 2 MiB', async () => {
    const folder = designWith('pass.html');
    fs.writeFileSync(path.join(folder, 'screens', 'S2-big.html'), `<html>${'x'.repeat(2 * 1024 * 1024)}</html>`);
    const { summary } = await runDesignCheck(input(folder));
    expect(summary.errors.map((issue) => `${issue.rule} ${issue.screen}`)).toEqual(['screen.size S2-big']);
  });

  it('warns when a script or keyframes move things and nothing checks prefers-reduced-motion, linked files included (acceptance)', async () => {
    const page = (head: string, body = ''): string => `<!doctype html><html lang="en" data-ds-screen="S1" data-ds-states="default"><head><title>Contacts</title><link rel="stylesheet" href="../tokens.css">${head}</head><body><main>${body}</main></body></html>`;
    const warnings = async (html: string, files: Record<string, string> = {}): Promise<string[]> => {
      const folder = designWith('pass.html');
      fs.writeFileSync(path.join(folder, 'screens', 'S1-contacts.html'), html);
      for (const [name, text] of Object.entries(files)) {
        fs.mkdirSync(path.dirname(path.join(folder, name)), { recursive: true });
        fs.writeFileSync(path.join(folder, name), text);
      }
      const { summary } = await runDesignCheck(input(folder, { fidelity: 'interactive' }));
      return summary.warnings.filter((issue) => issue.rule === 'motion.reduced-motion').map((issue) => `${issue.severity} ${issue.element}`);
    };
    const countUp = '<script>let n = 0; const tick = () => { n += 1; if (n < 100) requestAnimationFrame(tick); }; requestAnimationFrame(tick);</script>';
    expect(await warnings(page('', countUp))).toEqual(['warning <script>']);
    expect(await warnings(page('', `<script>if (!matchMedia('(prefers-reduced-motion: reduce)').matches) { setInterval(() => undefined, 100); }</script>`))).toEqual([]);
    expect(await warnings(page('<style>@keyframes fade { from { opacity: 0 } }</style>'))).toEqual(['warning <style>']);
    expect(await warnings(page('<style>@keyframes fade { from { opacity: 0 } } @media (prefers-reduced-motion: reduce) { * { animation: none } }</style>'))).toEqual([]);
    expect(await warnings(page('<script src="count.js"></script>'), { 'screens/count.js': 'el.animate([{ opacity: 0 }, { opacity: 1 }], 300);' })).toEqual(['warning <script src="count.js">']);
    // a stylesheet's reduced-motion rule cannot stop a script's motion, so each animating script is judged by its own text
    expect(await warnings(page('<script src="count.js"></script><link rel="stylesheet" href="../motion.css">'), { 'screens/count.js': 'setInterval(step, 16);', 'motion.css': '@media (prefers-reduced-motion: reduce) { .count { transition: none } }' })).toEqual(['warning <script src="count.js">']);
    expect(await warnings(page('<style>@media (prefers-reduced-motion: reduce) { * { animation: none } }</style>', countUp))).toEqual(['warning <script>']);
    expect(await warnings(page('<script src="count.js"></script>'), { 'screens/count.js': "if (matchMedia('(prefers-reduced-motion: reduce)').matches) done(); else setInterval(step, 16);" })).toEqual([]);
  });

  it('words the reduced-motion advice for the rule set: DesignScreenshot only where it exists', async () => {
    const folder = designWith('pass.html');
    fs.writeFileSync(path.join(folder, 'screens', 'S1-contacts.html'), '<!doctype html><html lang="en" data-ds-screen="S1" data-ds-states="default"><head><title>Contacts</title></head><body><main><script>setInterval(() => undefined, 16);</script></main></body></html>');
    const advice = async (screenshots: boolean): Promise<string> => (await runDesignCheck(input(folder, { fidelity: 'interactive', screenshots }))).summary.warnings.find((issue) => issue.rule === 'motion.reduced-motion')!.message;
    expect(await advice(true)).toContain('check that with DesignScreenshot media { reducedMotion: "reduce" }');
    const reduced = await advice(false);
    expect(reduced).not.toContain('DesignScreenshot');
    expect(reduced).toContain('opening the screen in a browser with reduced motion turned on');
  });

  it('has a label for every rule in each webview locale, so no card shows a raw rule id', () => {
    for (const locale of ['en', 'el']) {
      const messages = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', '..', 'webview', 'i18n', 'locales', `${locale}.json`), 'utf8')) as { design: { check: { rule: Record<string, Record<string, unknown>> } } };
      const missing = Object.keys(DESIGN_CHECK_SEVERITY).filter((rule) => {
        const [group, name] = [rule.slice(0, rule.indexOf('.')), rule.slice(rule.indexOf('.') + 1)];
        return typeof messages.design.check.rule[group]?.[name] !== 'string';
      });
      expect(missing, locale).toEqual([]);
    }
  });

  it('fixes every rule\'s severity in its definition; only ds.hidden-required, motion.reduced-motion, decisions.unchecked and ds.decision-replaced warn', () => {
    expect(Object.entries(DESIGN_CHECK_SEVERITY).filter(([, severity]) => severity === 'warning').map(([rule]) => rule)).toEqual(['ds.hidden-required', 'motion.reduced-motion', 'decisions.unchecked', 'ds.decision-replaced']);
  });

  it('refuses a javascript: link at every fidelity, naming a button', async () => {
    const { summary } = await runDesignCheck(input(designWith('fail-links.no-javascript.html'), { fidelity: 'interactive' }));
    expect(summary.errors.map((issue) => issue.rule)).toEqual(['links.no-javascript', 'links.no-javascript', 'links.no-javascript']);
    expect(summary.errors[0]!.message).toMatch(/Use a <button> for an action/);
  });

  it('names 20k labelled inputs in linear time, the label and id lookups built once per screen', async () => {
    const fields = Array.from({ length: 20_000 }, (_, n) => `<label for="f${n}">F${n}</label><input id="f${n}" aria-labelledby="x f${n}">`).join('');
    const folder = screenWith(`<form>${fields}<input type="submit"></form>`);
    const hint = { rule: 'a11y.input-label', severity: 'warning', text: 'Label every input.', skill: 'accessibility-states' } as const;
    const started = performance.now();
    const { summary } = await runDesignCheck(input(folder, { skillHints: [hint] }));
    expect(performance.now() - started).toBeLessThan(15_000);
    expect([...summary.errors, ...summary.warnings]).toEqual([]);
  });
});

/** A design folder whose one screen holds `body`, with `head` in its <head>. */
function screenWith(body: string, head = ''): string {
  const folder = designWith('pass.html');
  fs.writeFileSync(path.join(folder, 'screens', 'S1-contacts.html'), `<!doctype html><html data-ds-screen="S1" data-ds-states="default"><head><link rel="stylesheet" href="../tokens.css">${head}</head><body>${body}</body></html>`);
  return folder;
}

const rulesOf = async (folder: string, overrides: Partial<DesignCheckInput> = {}): Promise<string[]> => {
  const { summary } = await runDesignCheck(input(folder, overrides));
  return [...summary.errors, ...summary.warnings].map((issue) => issue.rule);
};

describe('DesignCheck, the token rules', () => {
  it('reads no color in a url() or a string, such as an asset named logo-white.svg or a fragment like #a1b', async () => {
    const folder = screenWith('<div style="background: url(../assets/logo-white.svg) no-repeat; color: var(--color-muted-foreground)">x</div><div style="background-image: url(\'../assets/icons.svg#a1b\')">y</div><p style="color: var(--color-surface, &quot;red&quot;)">z</p>');
    expect(await rulesOf(folder)).toEqual([]);
  });

  it('checks colors in gradients, filters and masks, SVG presentation attributes and bgcolor', async () => {
    const folder = screenWith('<div style="background-image: linear-gradient(#fff, var(--color-surface))">a</div><div style="filter: drop-shadow(0 0 2px black)">b</div><svg><circle fill="red" stroke="none"></circle><stop stop-color="#00ff00"></stop><path fill="url(#g)" stroke="currentColor"></path></svg><table bgcolor="tan"><tr><td>c</td></tr></table>');
    expect(await rulesOf(folder)).toEqual(['tokens.color', 'tokens.color', 'tokens.color', 'tokens.color', 'tokens.color']);
  });

  it('lets a screen point a token at another token, and refuses a token set to a literal (acceptance)', async () => {
    expect(await rulesOf(screenWith('<p style="--color-surface: var(--color-border); --spacing: calc(var(--radius-sm) * 2)">x</p>'))).toEqual([]);
    const { summary } = await runDesignCheck(input(designWith('fail-tokens.redefined.html')));
    expect(summary.errors.map((issue) => issue.message)).toEqual([
      '--color-surface: #f0f sets a token to a literal; a screen may only point a token at another one, such as --color-surface: var(--other-token).',
      '--spacing: 13px sets a token to a literal; a screen may only point a token at another one, such as --spacing: var(--other-token).',
    ]);
  });
});

describe('DesignCheck, state blocks', () => {
  const statesScreen = (body: string): string => {
    const folder = designWith('pass.html');
    fs.writeFileSync(path.join(folder, 'screens', 'S1-contacts.html'), `<!doctype html><html data-ds-screen="S1" data-ds-states="default empty no-results"><head><link rel="stylesheet" href="../tokens.css"></head><body>${body}</body></html>`);
    return folder;
  };

  it('takes data-ds-state-only as a list of declared states, however it is spaced', async () => {
    expect(await rulesOf(statesScreen('<p data-ds-state-only="default no-results">Filters</p><p data-ds-state-only=" empty\tno-results\n">None</p>'))).toEqual([]);
  });

  it('names each state of the list <html> does not declare in its own issue', async () => {
    const { summary } = await runDesignCheck(input(statesScreen('<p id="f" data-ds-state-only="default loading no-results error">Filters</p>')));
    expect(summary.errors.map((issue) => [issue.rule, issue.element, issue.message])).toEqual([
      ['screen.states', '<p#f>', 'data-ds-state-only names "loading", a state <html> does not declare in data-ds-states.'],
      ['screen.states', '<p#f>', 'data-ds-state-only names "error", a state <html> does not declare in data-ds-states.'],
    ]);
  });

  it('refuses an empty data-ds-state-only, which shows its block in no state', async () => {
    const { summary } = await runDesignCheck(input(statesScreen('<p id="e" data-ds-state-only=" ">x</p>')));
    expect(summary.errors.map((issue) => [issue.rule, issue.element])).toEqual([['screen.states', '<p#e>']]);
    expect(summary.errors[0]!.message).toMatch(/names no state/);
  });
});

describe('DesignCheck, network and links', () => {
  it('reports a string @import from the network once, and no url() inside a comment', async () => {
    const folder = screenWith('<p>x</p>', '<style>@import "https://fonts.example/a.css"; /* background: url(https://cdn.example/b.png) */ .a { background: url(../assets/a.png); }</style>');
    const { summary } = await runDesignCheck(input(folder));
    expect(summary.errors.map((issue) => [issue.rule, issue.message])).toEqual([['net.no-external', 'https://fonts.example/a.css loads from the network; a design loads nothing from outside its folder.']]);
  });

  it('reports a url() in a declaration once', async () => {
    const folder = screenWith('<p>x</p>', '<style>.a { background: url(https://cdn.example/b.png); }</style>');
    expect(await rulesOf(folder)).toEqual(['net.no-external']);
  });
});

describe('DesignCheck, control names', () => {
  it('names a submit or reset input with no value as a browser does, and still refuses an unnamed button input', async () => {
    expect(await rulesOf(screenWith('<form><input type="submit"><input type="RESET"></form>'))).toEqual([]);
    expect(await rulesOf(screenWith('<form><input type="button"></form>'))).toEqual(['a11y.control-name']);
    expect(await rulesOf(screenWith('<form><input type="submit" value=" "></form>'))).toEqual(['a11y.control-name']);
  });
});

describe('DesignCheck, bounded output', () => {
  it('takes data-ds-screen only as a plain name, under screen.states', async () => {
    const folder = designWith('pass.html');
    fs.writeFileSync(path.join(folder, 'screens', 'S1-contacts.html'), `<html data-ds-screen="S1 &quot;list&quot;" data-ds-states="default"><body><p>x</p></body></html>`);
    const { summary, screens } = await runDesignCheck(input(folder));
    expect(summary.errors.map((issue) => [issue.rule, issue.screen])).toEqual([['screen.states', 'S1-contacts']]);
    expect(screens.map((screen) => screen.id)).toEqual(['S1-contacts']);
  });

  it('cuts a quoted value to 120 characters and reports at most 20 issues of one rule on one screen, the last counting the rest', async () => {
    const long = 'X'.repeat(5000);
    const unknown = Array.from({ length: 25 }, (_, n) => `<div data-ds-component="Card${n}">x</div>`).join('');
    const { summary } = await runDesignCheck(input(screenWith(`<div data-ds-component="${long}">x</div>${unknown}`)));
    const issues = summary.errors.filter((issue) => issue.rule === 'ds.component-known');
    expect(issues).toHaveLength(20);
    expect(issues[0]!.message.length).toBeLessThan(400);
    expect(issues[0]!.element).toBe(`<div data-ds-component="${'X'.repeat(120)}…">`);
    // The count is structured, so every view words it and every count reads the true total.
    expect(issues.map((issue) => issue.more)).toEqual([...Array(19).fill(undefined), 6]);
    expect(issueCount(issues)).toBe(26);
    expect(issues.some((issue) => /more .* issues/.test(issue.message))).toBe(false);
  });
});

describe('DesignCheck, the skill hints', () => {
  it('takes clamp() with a nested function as bounded type, and still flags a bare viewport unit', async () => {
    const hint = { rule: 'layout.viewport-font', severity: 'warning', text: 'Bound fluid type with clamp().', skill: 'responsive-layout' } as const;
    expect(await rulesOf(screenWith('<h1 style="font-size: clamp(1rem, calc(0.5rem + 2vw), 2rem)">x</h1>'), { skillHints: [hint] })).toEqual([]);
    expect(await rulesOf(screenWith('<h1 style="font-size: calc(1rem + 2vw)">x</h1>'), { skillHints: [hint] })).toEqual(['layout.viewport-font']);
  });
});

describe('DesignCheck, design.md viewports', () => {
  it('names each viewport the preview would drop: a breakpoint name outside the design alphabet and widths past 16', async () => {
    const folder = designWith('pass.html');
    const widths = Array.from({ length: 18 }, (_, n) => 400 + n * 10);
    fs.writeFileSync(path.join(folder, 'design.md'), `---\napp: Vue\nviewports:\n  primary: md\n  checked: ["bad name", md]\n  journey: [${widths.join(', ')}]\n---\n`);
    const inventory = { ...INVENTORY, breakpoints: { source: 'declared', values: { md: 768, 'bad name': 900 } } };
    const { summary } = await runDesignCheck(input(folder, { inventory }));
    expect(summary.errors.map((issue) => issue.message)).toEqual([
      'viewports.checked: "bad name" is not a preset (base, md) or a width from 320 to 2560.',
      'viewports.journey names more than 16 widths, so 560 px, past the 16 smallest, is left out.',
      'viewports.journey names more than 16 widths, so 570 px, past the 16 smallest, is left out.',
    ]);
  });
});

describe('DesignCheck, linear time', () => {
  it('reads a long run of digits in a style in linear time', async () => {
    const folder = designWith('pass.html');
    fs.writeFileSync(path.join(folder, 'screens', 'S1-contacts.html'), `<html data-ds-screen="S1" data-ds-states="default"><body><p style="margin: ${'1'.repeat(500_000)}x">x</p></body></html>`);
    const started = performance.now();
    await runDesignCheck(input(folder));
    expect(performance.now() - started).toBeLessThan(2000);
  });
});

describe('DesignCheck, shared styles and scripts (D64)', () => {
  const SHELL_CSS = [
    '@import "../tokens.css";',
    '.shell { display: grid; gap: calc(var(--spacing) * 4); padding: calc(var(--spacing) * 6); background: var(--color-surface); }',
    '.shell nav a { color: var(--color-muted-foreground); border-bottom: 1px solid var(--color-border); border-radius: var(--radius-sm); }',
    '.brand { background: url(../assets/logo.png) no-repeat; }',
  ].join('\n');
  const SHELL_JS = 'document.querySelector("[data-menu]")?.addEventListener("click", () => document.body.classList.toggle("menu-open"));';
  const NAV = '<nav aria-label="Main"><a href="S1-contacts.html">Contacts</a> <a href="S2-companies.html">Companies</a></nav><button type="button" data-menu>Menu</button>';
  const page = (id: string, head: string, body: string): string =>
    `<!doctype html><html lang="en" data-ds-screen="${id}" data-ds-states="default"><head><title>${id}</title><link rel="stylesheet" href="../tokens.css">${head}</head><body><div class="shell">${NAV}<main><h1>${id}</h1>${body}</main></div></body></html>`;
  const SCREENS = ['S1-contacts', 'S2-companies', 'S3-deals', 'S4-tasks', 'S5-notes', 'S6-reports', 'S7-settings'];

  function sevenScreens(shared: boolean, files: Record<string, string> = {}): string {
    const folder = designWith('pass.html');
    fs.rmSync(path.join(folder, 'screens', 'S1-contacts.html'));
    const head = shared ? '<link rel="stylesheet" href="../shared/base.css"><script src="../shared/app.js" defer></script>' : `<style>${SHELL_CSS.replace('@import "../tokens.css";', '')}</style><script>${SHELL_JS}</script>`;
    SCREENS.forEach((name, index) => fs.writeFileSync(path.join(folder, 'screens', `${name}.html`), page(`S${index + 1}`, head, '<p>Body.</p>')));
    if (shared) files = { 'shared/base.css': SHELL_CSS, 'shared/app.js': SHELL_JS, ...files };
    for (const [name, text] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(folder, name)), { recursive: true });
      fs.writeFileSync(path.join(folder, name), text);
    }
    return folder;
  }

  it('passes 7 screens that link ../shared/base.css and ../shared/app.js, as it passes the same shell copied into each (acceptance)', async () => {
    const interactive = { fidelity: 'interactive' as const };
    const shared = await runDesignCheck(input(sevenScreens(true), interactive));
    const copied = await runDesignCheck(input(sevenScreens(false), interactive));
    expect(shared.summary.errors).toEqual([]);
    expect(shared.summary.warnings).toEqual([]);
    expect(copied.summary.errors).toEqual([]);
    expect(shared.screens.map((screen) => screen.id)).toEqual(['S1', 'S2', 'S3', 'S4', 'S5', 'S6', 'S7']);
  });

  it('reports a literal colour in shared/base.css as tokens.color, naming the file and its line (acceptance)', async () => {
    const folder = sevenScreens(true, { 'shared/base.css': `${SHELL_CSS}\n.alert { color: #c00; }` });
    const { summary } = await runDesignCheck(input(folder, { fidelity: 'interactive' }));
    expect(summary.errors).toEqual([expect.objectContaining({ rule: 'tokens.color', severity: 'error', screen: 'shared/base.css', element: 'line 5 color: #c00' })]);
  });

  it('applies the token, network and asset rules of a <style> to a shared stylesheet, resolving its refs against shared/', async () => {
    const css = [
      '@import url(https://fonts.example/inter.css);',
      ':root { --color-surface: #fff; }',
      '.a { margin: 12px; border-radius: 4px; color: var(--color-unknown); }',
      '.b { background: url(../logo.png); }',
      '.c { background: url(../assets/ok.png); }',
    ].join('\n');
    const folder = sevenScreens(true, { 'shared/base.css': css });
    const { summary } = await runDesignCheck(input(folder, { fidelity: 'interactive' }));
    expect(summary.errors.map((issue) => [issue.rule, issue.screen])).toEqual([
      ['tokens.redefined', 'shared/base.css'], ['tokens.spacing', 'shared/base.css'], ['tokens.radius', 'shared/base.css'], ['tokens.unknown-var', 'shared/base.css'],
      ['assets.local-only', 'shared/base.css'], ['net.no-external', 'shared/base.css'],
    ]);
  });

  it('refuses a static design that links shared/*.js, and the script file itself (acceptance)', async () => {
    const { summary } = await runDesignCheck(input(sevenScreens(true), { fidelity: 'static' }));
    const rules = summary.errors.map((issue) => `${issue.rule} ${issue.screen}`);
    expect(rules).toEqual(expect.arrayContaining(['fidelity.static-no-scripts S1', 'fidelity.static-no-scripts S7', 'fidelity.static-no-scripts shared/app.js']));
    expect(new Set(summary.errors.map((issue) => issue.rule))).toEqual(new Set(['fidelity.static-no-scripts']));
  });

  it('warns once on a shared script that animates with no prefers-reduced-motion, on the script, never on the screens that link it', async () => {
    const folder = sevenScreens(true, { 'shared/app.js': 'const tick = () => requestAnimationFrame(tick); tick();' });
    const { summary } = await runDesignCheck(input(folder, { fidelity: 'interactive' }));
    const motion = summary.warnings.filter((issue) => issue.rule === 'motion.reduced-motion').map((issue) => issue.screen);
    expect(motion).toEqual(['shared/app.js']);
  });

  it('resolves a page\'s refs against its own folder: shared/ and assets/ below the design, never beside the page or above the design', async () => {
    for (const [head, rules] of [
      ['<link rel="stylesheet" href="../shared/base.css">', []],
      ['<link rel="stylesheet" href="shared/base.css">', ['assets.local-only']],
      ['<script src="../../shared/app.js"></script>', ['assets.local-only']],
      ['<link rel="stylesheet" href="/shared/base.css">', ['assets.local-only']],
      ['<link rel="stylesheet" href="../manifest.json">', ['assets.local-only']],
      ['<link rel="stylesheet" href="../shared/base.css?v=2#x">', []],
      // a backslash is a slash to the design scheme, as to Chromium's URL parser
      ['<link rel="stylesheet" href="..\\shared\\base.css">', []],
      ['<svg><use href="../assets/icons.svg#add"></use><use href="#local"></use><image href="../assets/a.png"></image></svg>', []],
      ['<svg><use xlink:href="https://cdn.example/icons.svg#add"></use></svg>', ['net.no-external']],
      ['<svg><filter><feImage href="../../outside.png"></feImage></filter></svg>', ['assets.local-only']],
      ['<div style="background-image: image-set(&quot;../assets/a.png&quot; 1x, url(../assets/b.png) 2x)"></div>', []],
      ['<div style="background-image: image-set(&quot;https://cdn.example/a.png&quot; 1x)"></div>', ['net.no-external']],
    ] as const) {
      const folder = screenWith('<p>x</p>', head);
      fs.mkdirSync(path.join(folder, 'shared'));
      fs.writeFileSync(path.join(folder, 'shared', 'base.css'), '.a { color: var(--color-surface); }');
      expect(await rulesOf(folder, { fidelity: 'interactive' }), head).toEqual(rules);
    }
  });
});
