import { describe, expect, it } from 'vitest';
import { isVendorStylesheet, vendorLayer, vendorLayered } from '../vendor-layer.ts';
import { unlayeredRuleRefusal } from '../protected-layer.ts';

describe('the vendor layer', () => {
  it('takes every dependency stylesheet but Tailwind\'s, whatever the path separator or query', () => {
    for (const id of [
      'C:\\repo\\node_modules\\@xterm\\xterm\\css\\xterm.css',
      '/repo/node_modules/monaco-editor/esm/vs/editor/browser/widget/codeEditor/editor.css',
      '/repo/node_modules/monaco-editor/esm/vs/base/browser/ui/codicons/codicon/codicon.css?used',
      '/repo/node_modules/@xterm/xterm/css/xterm.css?inline',
      '/repo/node_modules/url-kit/raw.css',
    ]) expect(isVendorStylesheet(id), id).toBe(true);
    for (const id of [
      '/repo/node_modules/tailwindcss/index.css',
      '/repo/node_modules/@tailwindcss/vite/dist/x.css',
      '/repo/src/webview/style.css',
      '/repo/node_modules/monaco-editor/esm/vs/editor/editor.main.js',
      '/repo/src/webview/components/CodeBlock.vue?vue&type=style&index=0&scoped=abc&lang.css',
    ]) expect(isVendorStylesheet(id), id).toBe(false);
  });

  it('leaves an import Vite has already turned into JavaScript', () => {
    for (const query of ['?url', '?raw', '?worker', '?sharedworker', '?used&url', '?v=1&raw']) {
      const id = `/repo/node_modules/@xterm/xterm/css/xterm.css${query}`;
      expect(isVendorStylesheet(id), id).toBe(false);
    }
  });

  it('maps the stylesheet it wraps as moved, with no mappings', () => {
    const transform = vendorLayer().transform as (code: string, id: string) => unknown;
    expect(transform('.a{color:red}', '/repo/node_modules/x/a.css')).toEqual({ code: '@layer vendor {\n.a{color:red}\n}\n', map: { mappings: '' } });
    expect(transform('export default "a.css"', '/repo/node_modules/x/a.css?url')).toBeUndefined();
    expect(transform('.a{color:red}', '/repo/src/a.css')).toBeUndefined();
  });

  it('wraps the stylesheet whole, so none of its rules is unlayered', () => {
    const css = '.xterm{position:relative}@media print{.xterm{display:none}}@keyframes blink{50%{opacity:0}}@font-face{font-family:codicon}';
    expect(unlayeredRuleRefusal(css)).toBe('it holds a rule outside every layer: .xterm');
    expect(unlayeredRuleRefusal(vendorLayered(css, 'xterm.css'))).toBeUndefined();
  });

  it('refuses a stylesheet whose @import, @charset or @namespace could not sit inside a layer', () => {
    expect(() => vendorLayered('@import "x.css";.a{}', 'a.css')).toThrow('a.css holds an @import, which cannot sit inside @layer vendor');
    expect(() => vendorLayered('@charset "utf-8";.a{}', 'a.css')).toThrow('a.css holds an @charset, which cannot sit inside @layer vendor');
    expect(() => vendorLayered('@NAMESPACE svg url(http://www.w3.org/2000/svg);.a{}', 'a.css')).toThrow('a.css holds an @namespace, which cannot sit inside @layer vendor');
    expect(() => vendorLayered('/* c */ .a{} @import "x.css";', 'a.css')).toThrow('a.css holds an @import');
  });

  it('wraps a stylesheet that only mentions those rules in a comment, a string or a URL', () => {
    for (const css of [
      '/* no @import here, nor @charset "utf-8" */.a{color:red}',
      '.a::before{content:"@import url(x.css); @namespace"}',
      '.a{background:url(https://example.com/@import/@charset.png)}',
      '@media print{.a{content:"@charset"}}',
    ]) expect(vendorLayered(css, 'a.css'), css).toBe(`@layer vendor {\n${css}\n}\n`);
  });
});
