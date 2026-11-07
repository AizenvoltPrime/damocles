import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DESIGN_CHECK_SEVERITY, runDesignCheck, type DesignCheckInput, type DesignCheckRule } from '../design-check';
import type { DesignInventory } from '../inventory';
import { issueCount } from '../../../shared/types/design';

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
  return { folder, inventory: INVENTORY, tokenNames: TOKENS, decisionIds: ['D1', 'D2'], fidelity: 'static', skillHints: [], ...overrides };
}

// the static rules; the width rules run on probes (design-check-widths.test.ts)
const FAILING_RULES = Object.keys(DESIGN_CHECK_SEVERITY).filter((rule) => !['design.frontmatter', 'screen.size', 'layout.overflow', 'ds.hidden-required', 'journey.required'].includes(rule)) as DesignCheckRule[];

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

  it('fixes every rule\'s severity in its definition; only ds.hidden-required warns', () => {
    expect(Object.entries(DESIGN_CHECK_SEVERITY).filter(([, severity]) => severity === 'warning').map(([rule]) => rule)).toEqual(['ds.hidden-required']);
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
