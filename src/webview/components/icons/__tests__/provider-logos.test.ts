// @vitest-environment happy-dom
import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { defineComponent, h } from 'vue';
import { mount } from '@vue/test-utils';
import ProviderLogo from '../ProviderLogo.vue';
import { hasProviderLogo, providerLogoSvg } from '../provider-logos';

const ids = (svg: string): string[] => [...svg.matchAll(/ id="([^"]+)"/g)].map((match) => match[1]!);
const references = (svg: string): string[] => [...svg.matchAll(/url\(#([^)]+)\)/g)].map((match) => match[1]!);

describe('providerLogoSvg', () => {
  // Chromium paints no gradient whose first definition is in a hidden subtree, such as a closed popover's copy of the logo.
  it.each(['minimax', 'stepfun', 'google'])('gives each %s logo its own gradient ids, each filled from its own definition', (provider) => {
    const first = providerLogoSvg(provider)!;
    const second = providerLogoSvg(provider)!;
    expect(ids(first)).toHaveLength(1);
    expect(references(first)).toEqual(ids(first));
    expect(references(second)).toEqual(ids(second));
    expect(ids(second)).not.toEqual(ids(first));
  });

  it('returns a logo without ids unchanged, and none for a provider without a logo', () => {
    expect(providerLogoSvg('anthropic')).toBe(providerLogoSvg('anthropic'));
    expect(providerLogoSvg('nobody')).toBeUndefined();
    expect(hasProviderLogo('minimax')).toBe(true);
    expect(hasProviderLogo('nobody')).toBe(false);
  });

  it.each(['kimi-coding', 'meta', 'github-copilot'])('gives %s a logo with no gradient ids', (provider) => {
    const svg = providerLogoSvg(provider)!;
    expect(svg).toMatch(/^<svg aria-hidden="true" focusable="false" /);
    expect(ids(svg)).toEqual([]);
    expect(svg).not.toContain('<title>');
  });
});

describe('ProviderLogo', () => {
  // A vendor header and its model rows render the same vendor's logo side by side, as the composer's model menu does.
  it('gives every rendered logo of one vendor gradient ids no other element in the document has', () => {
    const wrapper = mount(defineComponent(() => () => h('div', [h(ProviderLogo, { provider: 'minimax' }), h(ProviderLogo, { provider: 'minimax' }), h(ProviderLogo, { provider: 'stepfun' })])));
    const defined = [...wrapper.element.querySelectorAll('[id]')].map((el) => el.id);
    expect(defined).toHaveLength(3);
    expect(new Set(defined).size).toBe(3);
    for (const logo of wrapper.findAll('[data-testid="provider-logo"]')) {
      expect(references(logo.html())).toEqual(ids(logo.html()));
    }
  });
});

// Numbering happens per call, so markup a caller keeps and renders twice would share ids again.
describe('logo markup', () => {
  const srcRoot = path.resolve(__dirname, '../../../..');
  const sourceFiles = (dir: string): string[] =>
    fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) return entry.name === '__tests__' ? [] : sourceFiles(full);
      return /\.(ts|vue)$/.test(entry.name) ? [full] : [];
    });

  it('is rendered only by ProviderLogo.vue', () => {
    const callers = [...sourceFiles(path.join(srcRoot, 'webview')), ...sourceFiles(path.join(srcRoot, 'desktop'))]
      .filter((file) => /\bproviderLogoSvg\s*\(/.test(fs.readFileSync(file, 'utf8')))
      .map((file) => path.relative(srcRoot, file).replace(/\\/g, '/'));
    expect(callers.sort()).toEqual(['webview/components/icons/ProviderLogo.vue', 'webview/components/icons/provider-logos.ts']);
  });
});
