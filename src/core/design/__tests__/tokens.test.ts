import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createVsCodeFileConfinement } from '../../../vscode/platform/file-confinement';
import { ProjectFiles } from '../citations';
import { scanCss } from '../css-scan';
import { readInventory } from '../inventory';
import { extractTokens, lengthPx, readTokenNames, TAILWIND_DEFAULT_BREAKPOINTS, TokensRefusedError } from '../tokens';

const APP = path.resolve(__dirname, '../../../../e2e/fixtures/design-app');
const folders: string[] = [];
afterEach(() => {
  for (const folder of folders.splice(0)) fs.rmSync(folder, { recursive: true, force: true });
});
function designFolder(): string {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'design-tokens-'));
  folders.push(folder);
  return folder;
}
function projectWith(files: Record<string, string>): string {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'design-project-')));
  folders.push(root);
  for (const [file, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), text);
  }
  return root;
}
const files = (cwd: string): ProjectFiles => new ProjectFiles(cwd, createVsCodeFileConfinement());

describe('ExtractTokens (PD-46)', () => {
  it('lands the fixture app\'s @theme tokens, Tailwind\'s default breakpoints and its font', async () => {
    const folder = designFolder();
    const { details, skippedFonts } = await extractTokens({ files: ['resources/css/app.css'] }, files(APP), folder);
    expect(details.groups).toEqual({ color: 7, font: 1, radius: 3, spacing: 1 });
    expect(details.breakpoints.values).toEqual(TAILWIND_DEFAULT_BREAKPOINTS);
    expect(details.breakpoints.source).toMatch(/^Tailwind defaults/);
    expect(details.fonts).toEqual(['assets/inter-var.woff2']);
    expect(skippedFonts).toEqual([]);
    // The fixture font is a deliberate 64-byte stub: the wOF2 magic and filler, which ExtractTokens copies and no test decodes.
    expect(fs.readFileSync(path.join(folder, 'assets', 'inter-var.woff2')).subarray(0, 4).toString('latin1')).toBe('wOF2');
    const css = fs.readFileSync(path.join(folder, 'tokens.css'), 'utf8');
    expect(css).toContain('src: url("assets/inter-var.woff2");');
    expect(css).toContain('--color-primary: #2563eb;');
    expect(await readTokenNames(folder)).toContain('--radius-md');
    const inventory = await readInventory(folder);
    expect(inventory.tokens).toMatchObject({ count: 12, groups: details.groups });
    expect(inventory.breakpoints?.values).toEqual(TAILWIND_DEFAULT_BREAKPOINTS);
  });

  it('applies --breakpoint-* overrides over the defaults, and a reset drops them', async () => {
    const override = projectWith({ 'app.css': '@import "tailwindcss";\n@theme { --breakpoint-sm: 36rem; --breakpoint-3xl: 1920px; }' });
    expect((await extractTokens({ files: ['app.css'] }, files(override), designFolder())).details.breakpoints.values).toEqual({ ...TAILWIND_DEFAULT_BREAKPOINTS, sm: 576, '3xl': 1920 });
    const reset = projectWith({ 'app.css': '@import "tailwindcss";\n@theme { --breakpoint-*: initial; --breakpoint-tablet: 48rem; }' });
    expect((await extractTokens({ files: ['app.css'] }, files(reset), designFolder())).details.breakpoints.values).toEqual({ tablet: 768 });
  });

  it('says so when it finds no breakpoints: one band, presets base and primary', async () => {
    const plain = projectWith({ 'site.css': ':root { --color-ink: #111; }' });
    const { details } = await extractTokens({ files: ['site.css'] }, files(plain), designFolder());
    expect(details.breakpoints).toEqual({ source: 'None found or declared: one band, with the presets base and primary', values: {} });
  });

  it('takes declared tokens and breakpoints whose cited line holds the value', async () => {
    const project = projectWith({ '_vars.scss': '$brand: #0055aa;\n$gap: 8px;\n', 'tailwind.config.js': 'module.exports = { theme: { screens: {\n  md: "768px",\n} } };\n' });
    const { details } = await extractTokens({
      files: [],
      declared: [{ name: '--color-brand', value: '#0055aa', cite: '_vars.scss:1' }],
      breakpoints: [{ name: 'md', value: '768px', cite: 'tailwind.config.js:2' }],
    }, files(project), designFolder());
    expect(details.groups).toEqual({ color: 1 });
    expect(details.breakpoints.values).toEqual({ md: 768 });
  });

  it('refuses a declared token whose cited line lacks its value, and writes nothing (acceptance)', async () => {
    const project = projectWith({ '_vars.scss': '$brand: #0055aa;\n' });
    const folder = designFolder();
    const refused = extractTokens({ files: [], declared: [{ name: '--color-brand', value: '#ff0000', cite: '_vars.scss:1' }] }, files(project), folder);
    await expect(refused).rejects.toBeInstanceOf(TokensRefusedError);
    await expect(refused).rejects.toThrow('_vars.scss:1 does not contain #ff0000');
    expect(fs.existsSync(path.join(folder, 'tokens.css'))).toBe(false);
  });

  it('refuses a citation outside the working folder or past the file\'s end', async () => {
    const project = projectWith({ 'a.css': ':root {}', 'sub/b.css': ':root {}' });
    await expect(extractTokens({ files: [], declared: [{ name: '--x', value: '{}', cite: '../a.css:1' }] }, files(path.join(project, 'sub')), designFolder())).rejects.toThrow(/not a value/);
    await expect(extractTokens({ files: [], declared: [{ name: '--x', value: 'root', cite: '../a.css:1' }] }, files(path.join(project, 'sub')), designFolder())).rejects.toThrow(/outside the working folder/);
    await expect(extractTokens({ files: [], declared: [{ name: '--x', value: '1', cite: 'a.css:9' }] }, files(project), designFolder())).rejects.toThrow(/has only 1 lines/);
    await expect(extractTokens({ files: [], declared: [{ name: '--x', value: '1;}body{', cite: 'a.css:1' }] }, files(project), designFolder())).rejects.toThrow(/not a value tokens.css can hold/);
  });

  it('keeps out a value with an unclosed quote or bracket or a backslash, and a breakpoint override of 0 or less', async () => {
    const project = projectWith({ 'a.css': ':root { --ok: calc((1px + 2px) * 2); --list: "a(" [b]; --esc: a\\b; --square: [x; --open: foo( }', 'b.css': ':root { --open: 1; }' });
    const folder = designFolder();
    await extractTokens({ files: ['a.css'] }, files(project), folder);
    expect(await readTokenNames(folder)).toEqual(['--list', '--ok']);
    for (const value of ['foo(', '"x', 'a\\b', '([)]']) {
      await expect(extractTokens({ files: [], declared: [{ name: '--x', value, cite: 'b.css:1' }] }, files(project), designFolder())).rejects.toThrow(/not a value tokens.css can hold/);
    }
    const zero = projectWith({ 'app.css': '@import "tailwindcss";\n@theme { --breakpoint-sm: 0px; --breakpoint-md: -4rem; }' });
    await expect(extractTokens({ files: ['app.css'] }, files(zero), designFolder())).rejects.toThrow(/--breakpoint-sm is 0px, not a px, rem or em width[\s\S]*--breakpoint-md is -4rem/);
  });

  it('reads only :root and @theme properties, skips comments and strings, and stays linear', () => {
    const scan = scanCss('/* :root { --no: 1 } */ :root { --a: 1px; .x { --nested: 2 } --b: "}"; } .y { --c: 3 } @theme inline { --d: var(--a); }');
    expect(scan.tokens.map((t) => t.name)).toEqual(['--a', '--b', '--d']);
    const started = performance.now();
    scanCss(`:root { ${'--x: 1; '.repeat(100_000)}}${'{'.repeat(100_000)}`);
    expect(performance.now() - started).toBeLessThan(2000);
    expect([lengthPx('40rem'), lengthPx('768px'), lengthPx('48em'), lengthPx('1fr')]).toEqual([640, 768, 768, undefined]);
  });
});

describe('the CSS scan stays linear over hostile text (F2)', () => {
  it('reads 200k spaces inside url(), before !important, in an @import and after a ? within a second', async () => {
    const spaces = ' '.repeat(200_000);
    const started = performance.now();
    scanCss(`:root { --a: url(${spaces}; --b: 1px${spaces}x; } @import${spaces}x;`);
    scanCss(`@font-face { src: url(a${'?'.repeat(200_000)}\n); }`);
    const project = projectWith({ 'a.css': `@font-face { src: url("f.woff2${'?'.repeat(200_000)}"); }` });
    await extractTokens({ files: ['a.css'] }, files(project), designFolder());
    expect(performance.now() - started).toBeLessThan(1000);
  });

  it('still reads quoted and unquoted urls and a spaced @import of Tailwind', () => {
    expect(scanCss('@font-face { src: url( "a.woff2" ) format("woff2"), url(b.woff); }').fontFaces[0]?.urls).toEqual(['a.woff2', 'b.woff']);
    expect(scanCss('@import   url( "tailwindcss" );').tailwind).toBe(true);
    expect(scanCss(':root { --x: red !IMPORTANT; }').tokens[0]?.value).toBe('red');
  });
});
