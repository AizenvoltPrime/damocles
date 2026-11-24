import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { OutputAsset, OutputBundle, OutputChunk } from 'rollup';
import { foreignLayerRefusal, PAGE_LAYERS, protectedLayerOrder, protectedLayerRefusal, unlayeredRuleRefusal } from '../protected-layer.ts';

const root = path.resolve(__dirname, '..', '..');
const STATEMENT = `@layer ${PAGE_LAYERS.join(', ')};`;
const PROTECTED_BLOCK = '@layer damocles-protected{[data-trusted]{opacity:1!important}}';
// What Tailwind's build makes of style.css: its own properties layer named ahead of the page's, then the blocks.
const BUILT = `/*! tailwindcss */@layer properties;${STATEMENT}@layer properties{@supports (x:y){*{--tw-a:initial}}}`
  + '@layer damocles-protected{[data-trusted]{opacity:1!important}}@layer theme{:root{--x:1}}@layer base{a{color:red}}'
  + '@layer components{.c{color:red}}@layer utilities{.u{color:red}}@layer vendor{.v{color:red}}@layer app{.a[data-v-1]{color:red}}'
  + '@property --tw-a{syntax:"*";inherits:false}';

describe('the page layer order check', () => {
  it('ranks vendor and app CSS after the utilities and before a theme\'s', () => {
    expect(PAGE_LAYERS).toEqual(['damocles-protected', 'theme', 'base', 'components', 'utilities', 'vendor', 'app', 'damocles-user']);
  });

  it('passes style.css as Tailwind and the minifier emit it, and the source names the page layers before anything else', () => {
    const source = fs.readFileSync(path.join(root, 'src/webview/style.css'), 'utf8');
    expect(source.slice(source.indexOf('*/') + 2).trimStart().startsWith(STATEMENT)).toBe(true);
    expect(protectedLayerRefusal(BUILT)).toBeUndefined();
    expect(unlayeredRuleRefusal(BUILT)).toBeUndefined();
    // the minifier drops a statement whose names the blocks repeat, keeping only damocles-user's, which has no block
    const minified = '@layer properties{*{--tw-a:initial}}@layer damocles-protected{a{opacity:1!important}}@layer theme{}@layer base{}@layer components{}@layer utilities{}@layer vendor{}@layer app{}@layer damocles-user;';
    expect(protectedLayerRefusal(minified)).toBeUndefined();
    expect(unlayeredRuleRefusal(`.a[data-v-1]{color:red}${minified}`)).toBe('it holds a rule outside every layer: .a[data-v-1]');
  });

  it('refuses a stylesheet whose page layers rank out of order or are missing', () => {
    expect(protectedLayerRefusal(`@layer theme, base, components, utilities;${STATEMENT}`)).toBe('it ranks the page layers theme, base, components, utilities, damocles-protected, vendor, app, damocles-user, not damocles-protected, theme, base, components, utilities, vendor, app, damocles-user');
    expect(protectedLayerRefusal('@layer theme, base, components, utilities;')).toMatch(/^it ranks the page layers theme, base, components, utilities, not /);
    expect(protectedLayerRefusal('a{color:red}')).toMatch(/^it ranks the page layers none, not /);
  });

  it('refuses a layer ranking before damocles-protected that holds an !important declaration, nested or not', () => {
    expect(protectedLayerRefusal(`@layer early{@media (min-width:1px){a{color:red !important}}}${STATEMENT}`)).toBe('early ranks before damocles-protected and holds an !important declaration');
    expect(protectedLayerRefusal(`@layer early.inner{a{color:red!important}}${STATEMENT}`)).toBe('early ranks before damocles-protected and holds an !important declaration');
    expect(protectedLayerRefusal(`@layer early{a{color:red}}${STATEMENT}${PROTECTED_BLOCK}`)).toBeUndefined();
  });

  it('finds an !important declaration in an earlier layer in any rule shape, from its tokens', () => {
    const refused = 'early ranks before damocles-protected and holds an !important declaration';
    for (const early of [
      'a{.b{color:red!important}}',
      'a{color:blue;span:hover{color:red!important}}',
      'a{b &{color:red!important}}',
      'a{&:hover{color:red!important}}',
      'a{color:red ! /* c */ IMPORTANT}',
      'a{color:red!\\69mportant}',
      '@layer inner{a{color:red!important}}',
    ]) expect(protectedLayerRefusal(`@layer early{${early}}${STATEMENT}${PROTECTED_BLOCK}`), early).toBe(refused);
    for (const early of ['a{content:"!important"}', 'a{color:red}/* !important */', 'a{background:url(!important)}', 'a{--x:important}']) {
      expect(protectedLayerRefusal(`@layer early{${early}}${STATEMENT}${PROTECTED_BLOCK}`), early).toBeUndefined();
    }
  });

  it('refuses an @import, whose layers and rules it cannot read', () => {
    expect(protectedLayerRefusal(`@import url(x.css) layer(early);${STATEMENT}${PROTECTED_BLOCK}`)).toBe('it holds an @import, whose layers cannot be read');
    expect(protectedLayerRefusal(`${STATEMENT}@import "x.css";${PROTECTED_BLOCK}`)).toBe('it holds an @import, whose layers cannot be read');
    expect(protectedLayerRefusal(fs.readFileSync(path.join(root, 'src/webview/style.css'), 'utf8'))).toBe('it holds an @import, whose layers cannot be read');
  });

  it('refuses a protected layer that holds no !important declaration', () => {
    expect(protectedLayerRefusal(STATEMENT)).toBe('damocles-protected holds no !important declaration');
    expect(protectedLayerRefusal(`${STATEMENT}@layer damocles-protected{}`)).toBe('damocles-protected holds no !important declaration');
    expect(protectedLayerRefusal(`${STATEMENT}@layer damocles-protected{[data-trusted]{opacity:1}}`)).toBe('damocles-protected holds no !important declaration');
    expect(protectedLayerRefusal(`${STATEMENT}${PROTECTED_BLOCK}`)).toBeUndefined();
  });

  it('refuses a layer ranking after damocles-user, which would beat a theme\'s rules', () => {
    expect(protectedLayerRefusal(`${STATEMENT}@layer late{a{color:red}}`)).toBe('late ranks after damocles-user');
    expect(protectedLayerRefusal(`${STATEMENT}@layer{a{color:red}}`)).toBe('anonymous 8 ranks after damocles-user');
  });
});

describe('the unlayered rule check', () => {
  it('refuses a style rule outside every layer, at the top level or inside a conditional rule, naming its selector', () => {
    const refused = 'it holds a rule outside every layer: .a';
    expect(unlayeredRuleRefusal('.a{color:red}')).toBe(refused);
    expect(unlayeredRuleRefusal('@layer app{.b{color:red}}.a{color:red}.c{color:red}')).toBe(refused);
    for (const wrapper of ['@media (prefers-reduced-motion:reduce)', '@supports (display:grid)', '@container app (min-width:1rem)', '@scope (.x)', '@starting-style']) {
      expect(unlayeredRuleRefusal(`${wrapper}{.a{color:red}}`), wrapper).toBe(refused);
      expect(unlayeredRuleRefusal(`@media print{${wrapper}{.a{color:red}}}`), wrapper).toBe(refused);
    }
  });

  it('accepts rules inside a layer, however nested, and the top-level rules that style nothing', () => {
    for (const css of [
      '@layer app{.a{color:red}}',
      '@media print{@layer app{.a{color:red}}}',
      '@layer app{@media print{.a{color:red}}}',
      '@layer app.inner{.a{color:red}}',
      '@layer properties{@supports ((-webkit-hyphens:none)){*,:before{--tw-a:initial}}}',
      '@layer damocles-protected, theme, base, components, utilities, vendor, app, damocles-user;',
      '@font-face{font-family:x;src:url(x.woff2)}',
      '@property --enter-delay{syntax:"<time>";inherits:false;initial-value:0s}',
      '@keyframes d-fade{from{opacity:0}to{opacity:1}}',
      '@-webkit-keyframes d-fade{0%{opacity:0}}',
      '@-moz-keyframes d-fade{from{opacity:0}to{opacity:1}}',
      '@-o-keyframes d-fade{0%{opacity:0}}',
      '@media print{@-MOZ-KEYFRAMES d-fade{0%{opacity:0}}}',
      '@counter-style x{system:cyclic;symbols:"*"}',
      '/*! tailwindcss */',
      '',
    ]) expect(unlayeredRuleRefusal(css), css).toBeUndefined();
  });
});

describe('the foreign layer check', () => {
  it('refuses a layer that is no page layer, at the top level or inside a conditional rule, in a block or a statement', () => {
    const refused = 'it names the layer late, which is not a page layer';
    for (const css of [
      '@layer late{.a{color:red}}',
      '@layer late;',
      '@layer app, late;',
      '@layer late.inner{.a{color:red}}',
      '@LAYER late{.a{color:red}}',
      '@media print{@layer late{.a{color:red}}}',
      '@supports (display:grid){@media print{@layer late{.a{color:red}}}}',
      '@layer app{.a{color:red}}@layer late{.b{color:red}}',
    ]) expect(foreignLayerRefusal(css), css).toBe(refused);
  });

  it('refuses a layer without a name, which would rank after damocles-user', () => {
    const refused = 'it holds a layer without a name, which ranks after every named one';
    expect(foreignLayerRefusal('@layer{.a{color:red}}')).toBe(refused);
    expect(foreignLayerRefusal('@layer app{.a{color:red}}@media print{@layer {.a{color:red}}}')).toBe(refused);
  });

  it('refuses an @import, whose layers and rules it cannot read', () => {
    const refused = 'it holds an @import, whose layers and rules cannot be read';
    expect(foreignLayerRefusal('@import "x.css";')).toBe(refused);
    expect(foreignLayerRefusal('@layer app;@IMPORT url(x.css) layer(late);')).toBe(refused);
  });

  it('accepts the page layers, Tailwind\'s properties layer and any layer nested in one of them', () => {
    for (const css of [
      BUILT,
      STATEMENT,
      '@layer vendor{.monaco-editor{color:red}}',
      '@layer app.inner{.a{color:red}}',
      '@layer app{@layer late{.a{color:red}}@layer{.b{color:red}}@layer other;}',
      '@media print{@layer app{@layer{.a{color:red}}}}',
      '@layer properties{@supports ((-webkit-hyphens:none)){*,:before{--tw-a:initial}}}',
      '.a::before{content:"@layer late{} @import"}/* @layer late; */',
      '@font-face{font-family:x;src:url(x.woff2)}',
      '',
    ]) expect(foreignLayerRefusal(css), css).toBeUndefined();
  });
});

describe('the build plugin', () => {
  const css = (fileName: string, source: string): OutputAsset => ({ type: 'asset', fileName, source, name: undefined, names: [], originalFileName: null, originalFileNames: [], needsCodeReference: false });
  const entry = (name: string, importedCss: string[]): OutputChunk => ({ type: 'chunk', name, fileName: `assets/${name}.js`, isEntry: true, viteMetadata: { importedCss: new Set(importedCss), importedAssets: new Set() } }) as unknown as OutputChunk;
  function check(entries: readonly string[], bundle: OutputBundle): void {
    const plugin = protectedLayerOrder(entries);
    const generate = plugin.generateBundle as (this: unknown, options: unknown, bundle: OutputBundle) => void;
    generate.call({ error: (message: string) => { throw new Error(message); } }, {}, bundle);
  }

  it('reads each named entry\'s stylesheets in the order it loads them', () => {
    const bundle: OutputBundle = { 'assets/index.js': entry('index', ['assets/index.css']), 'assets/index.css': css('assets/index.css', BUILT), 'assets/render.js': entry('render', ['assets/render.css']), 'assets/render.css': css('assets/render.css', '@layer theme, base, components, utilities;') };
    expect(() => check(['index'], bundle)).not.toThrow();
    expect(() => check(['index', 'render'], bundle)).toThrow(/^assets\/render\.css, which the render entry loads: it ranks the page layers theme, base, components, utilities, not /);
    const split: OutputBundle = { 'assets/index.js': entry('index', ['assets/early.css', 'assets/index.css']), 'assets/early.css': css('assets/early.css', '@layer early{a{color:red!important}}'), 'assets/index.css': css('assets/index.css', BUILT) };
    expect(() => check(['index'], split)).toThrow('assets/early.css, assets/index.css, which the index entry loads: early ranks before damocles-protected and holds an !important declaration');
  });

  it('fails when a named entry is missing or loads no stylesheet', () => {
    expect(() => check(['overlay'], { 'assets/index.js': entry('index', ['assets/index.css']), 'assets/index.css': css('assets/index.css', BUILT) })).toThrow('the overlay entry loads no stylesheet emitted as text to check its layer order in');
    expect(() => check(['index'], { 'assets/index.js': entry('index', []) })).toThrow('the index entry loads no stylesheet');
  });

  it('refuses an unlayered rule in any stylesheet of the bundle, an entry\'s or a lazy chunk\'s', () => {
    const base: OutputBundle = { 'assets/index.js': entry('index', ['assets/index.css']), 'assets/index.css': css('assets/index.css', BUILT), 'assets/icon.svg': css('assets/icon.svg', '<svg/>') };
    expect(() => check(['index'], { ...base, 'assets/monaco-editor.css': css('assets/monaco-editor.css', '@layer vendor{.monaco-editor{color:red}}') })).not.toThrow();
    expect(() => check(['index'], { ...base, 'assets/monaco-editor.css': css('assets/monaco-editor.css', '@layer vendor{.v{color:red}}.monaco-editor{color:red}') })).toThrow('assets/monaco-editor.css: it holds a rule outside every layer: .monaco-editor');
    expect(() => check([], { 'assets/theme-render.css': css('assets/theme-render.css', '@media print{html,body{margin:0}}') })).toThrow('assets/theme-render.css: it holds a rule outside every layer: html,body');
    expect(() => check(['index'], { ...base, 'assets/index.css': css('assets/index.css', `${BUILT}.late{color:red}`) })).toThrow('assets/index.css: it holds a rule outside every layer: .late');
  });

  it('refuses a layer that is no page layer, a layer without a name and an @import in a lazy chunk\'s stylesheet', () => {
    const base: OutputBundle = { 'assets/index.js': entry('index', ['assets/index.css']), 'assets/index.css': css('assets/index.css', BUILT) };
    const lazy = (source: string): OutputBundle => ({ ...base, 'assets/SettingsModal.css': css('assets/SettingsModal.css', source) });
    expect(() => check(['index'], lazy('@layer app{.a{color:red}}'))).not.toThrow();
    expect(() => check(['index'], lazy('@layer late{.a{color:red}}'))).toThrow('assets/SettingsModal.css: it names the layer late, which is not a page layer');
    expect(() => check(['index'], lazy('@layer{.a{color:red}}'))).toThrow('assets/SettingsModal.css: it holds a layer without a name, which ranks after every named one');
    expect(() => check(['index'], lazy('@import "x.css";@layer app{.a{color:red}}'))).toThrow('assets/SettingsModal.css: it holds an @import, whose layers and rules cannot be read');
  });
});
