import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { OutputAsset, OutputBundle, OutputChunk } from 'rollup';
import { PAGE_LAYERS, protectedLayerOrder, protectedLayerRefusal } from '../protected-layer.ts';

const root = path.resolve(__dirname, '..', '..');
const STATEMENT = `@layer ${PAGE_LAYERS.join(', ')};`;
const PROTECTED_BLOCK = '@layer damocles-protected{[data-trusted]{opacity:1!important}}';
// What Tailwind's build makes of style.css: its own properties layer named ahead of the page's, then the blocks.
const BUILT = `/*! tailwindcss */@layer properties;${STATEMENT}@layer properties{@supports (x:y){*{--tw-a:initial}}}`
  + '@layer damocles-protected{[data-trusted]{opacity:1!important}}@layer theme{:root{--x:1}}@layer base{a{color:red}}'
  + '@layer components{.c{color:red}}@layer utilities{.u{color:red}}';

describe('the page layer order check', () => {
  it('passes style.css as Tailwind and the minifier emit it, and the source names the page layers before anything else', () => {
    const source = fs.readFileSync(path.join(root, 'src/webview/style.css'), 'utf8');
    expect(source.slice(source.indexOf('*/') + 2).trimStart().startsWith(STATEMENT)).toBe(true);
    expect(protectedLayerRefusal(BUILT)).toBeUndefined();
    // the minifier drops a statement whose names the blocks repeat, keeping only damocles-user's, which has no block
    expect(protectedLayerRefusal('.a[data-v-1]{color:red}@layer properties{*{--tw-a:initial}}@layer damocles-protected{a{opacity:1!important}}@layer theme{}@layer base{}@layer components{}@layer utilities{}@layer damocles-user;')).toBeUndefined();
  });

  it('refuses a stylesheet whose page layers rank out of order or are missing', () => {
    expect(protectedLayerRefusal(`@layer theme, base, components, utilities;${STATEMENT}`)).toBe('it ranks the page layers theme, base, components, utilities, damocles-protected, damocles-user, not damocles-protected, theme, base, components, utilities, damocles-user');
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
    expect(protectedLayerRefusal(`${STATEMENT}@layer{a{color:red}}`)).toBe('anonymous 6 ranks after damocles-user');
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
});
