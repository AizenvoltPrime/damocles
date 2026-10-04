// @vitest-environment happy-dom
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { i18n } from '@/i18n';
import CodeBlock from '../CodeBlock.vue';
import { getHighlighter } from '@/composables/useShikiHighlighter';
import { damoclesShikiTheme } from '@/composables/damoclesShikiTheme';
import { useSettingsStore } from '@/stores/useSettingsStore';
import { VSCODE_HOST_CAPABILITIES } from '@shared/types/messages';

const shiki = vi.hoisted(() => {
  const instance = {
    loadLanguage: vi.fn(async () => undefined),
    loadTheme: vi.fn(async () => undefined),
    codeToHtml: vi.fn(() => '<pre><code>highlighted</code></pre>'),
  };
  return { instance, createHighlighter: vi.fn(async () => instance) };
});

vi.mock('shiki', () => ({
  createHighlighter: shiki.createHighlighter,
  bundledLanguages: { typescript: {} },
}));
vi.mock('@/utils/perf', () => ({ perfSpan: () => ({ end: () => undefined }), resourceFields: () => ({ fields: {}, lastEnd: 0 }) }));

beforeEach(() => {
  setActivePinia(createPinia());
  shiki.instance.loadTheme.mockClear();
  shiki.instance.codeToHtml.mockClear();
});

afterEach(() => {
  document.body.className = '';
});

function mountBlock() {
  return mount(CodeBlock, { props: { code: 'const x = 1;', language: 'ts' }, global: { plugins: [i18n] } });
}

describe('CodeBlock', () => {
  it('shows the plain code while a theme it needs is still loading', async () => {
    await getHighlighter('ts', 'github-dark');
    shiki.instance.loadTheme.mockImplementationOnce(() => new Promise(() => {}));
    document.body.className = 'vscode-light';

    const wrapper = mountBlock();
    await flushPromises();

    expect(shiki.instance.loadTheme).toHaveBeenCalledWith('github-light');
    expect(wrapper.find('.code-block-content').text()).toBe('const x = 1;');
  });

  it('keeps the theme matched to VS Code without damoclesTheme, and uses the token-fed Damocles theme with it', async () => {
    document.body.className = 'vscode-dark';
    mountBlock();
    await flushPromises();
    expect(shiki.instance.codeToHtml).toHaveBeenLastCalledWith('const x = 1;', expect.objectContaining({ theme: 'github-dark' }));

    useSettingsStore().setHostCapabilities({ ...VSCODE_HOST_CAPABILITIES, damoclesTheme: true });
    await flushPromises();
    expect(shiki.instance.loadTheme).toHaveBeenCalledWith(damoclesShikiTheme);
    expect(shiki.instance.codeToHtml).toHaveBeenLastCalledWith('const x = 1;', expect.objectContaining({ theme: 'damocles' }));
  });

  it('colors the Damocles theme only through design and syntax tokens', () => {
    const colors = [
      ...Object.values(damoclesShikiTheme.colors ?? {}),
      ...(damoclesShikiTheme.tokenColors ?? []).flatMap((rule) => (rule.settings.foreground === undefined ? [] : [rule.settings.foreground])),
    ];
    expect(colors.length).toBeGreaterThan(5);
    for (const color of colors) expect(color).toMatch(/^var\(--(?:d|s)-[a-z0-9-]+\)$/);
  });
});
