// @vitest-environment happy-dom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { i18n } from '@/i18n';
import CodeBlock from '../CodeBlock.vue';
import { getHighlighter } from '@/composables/useShikiHighlighter';

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

afterEach(() => {
  document.body.className = '';
});

describe('CodeBlock', () => {
  it('shows the plain code while a theme it needs is still loading', async () => {
    await getHighlighter('ts', 'github-dark');
    shiki.instance.loadTheme.mockImplementationOnce(() => new Promise(() => {}));
    document.body.className = 'vscode-light';

    const wrapper = mount(CodeBlock, { props: { code: 'const x = 1;', language: 'ts' }, global: { plugins: [i18n] } });
    await flushPromises();

    expect(shiki.instance.loadTheme).toHaveBeenCalledWith('github-light');
    expect(wrapper.find('.code-block-content').text()).toBe('const x = 1;');
  });
});
