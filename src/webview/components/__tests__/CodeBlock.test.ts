// @vitest-environment happy-dom
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { i18n } from '@/i18n';
import CodeBlock from '../CodeBlock.vue';
import { getHighlighter } from '@/composables/useShikiHighlighter';
import { damoclesShikiTheme } from '@/composables/damoclesShikiTheme';
import { useSettingsStore } from '@/stores/useSettingsStore';
import { VSCODE_HOST_CAPABILITIES } from '@shared/types/messages';
import { CHAT_VIEW_PROVIDE } from '@/__tests__/code-highlighter';
import { CODE_HIGHLIGHTER, type CodeHighlighter } from '@/composables/code-highlighter';

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

const mounted: VueWrapper[] = [];

afterEach(() => {
  for (const wrapper of mounted.splice(0)) wrapper.unmount();
  vi.restoreAllMocks();
  document.body.className = '';
});

function mountBlock(code = 'const x = 1;') {
  const wrapper = mount(CodeBlock, { props: { code, language: 'ts' }, global: { provide: CHAT_VIEW_PROVIDE, plugins: [i18n] } });
  mounted.push(wrapper);
  return wrapper;
}

describe('CodeBlock', () => {
  it('refuses to render in an app that provides no code highlighter', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(() => mount(CodeBlock, { props: { code: 'x', language: 'ts' }, global: { plugins: [i18n] } })).toThrow('No app provides CODE_HIGHLIGHTER');
  });

  it('shows the plain code while a theme it needs is still loading', async () => {
    await getHighlighter('ts', 'github-dark');
    shiki.instance.loadTheme.mockImplementationOnce(() => new Promise(() => {}));
    document.body.className = 'vscode-light';

    const wrapper = mountBlock();
    await flushPromises();

    expect(shiki.instance.loadTheme).toHaveBeenCalledWith('github-light');
    expect(wrapper.find('.code-block-content').text()).toBe('const x = 1;');
  });

  it('shows markup in the plain fallback as text', async () => {
    shiki.instance.codeToHtml.mockImplementationOnce(() => { throw new Error('no grammar'); });
    vi.spyOn(console, 'error').mockImplementationOnce(() => undefined);
    const code = '<img src=x onerror=alert(1)>';

    const wrapper = mountBlock(code);
    await flushPromises();

    expect(shiki.instance.codeToHtml).toHaveBeenCalledWith(code, expect.anything());
    expect(wrapper.find('img').exists()).toBe(false);
    expect(wrapper.find('.code-block-content').text()).toBe(code);
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

  it('highlights again only when the code, language or theme changes, not for a push of the same capabilities', async () => {
    mountBlock();
    await flushPromises();
    shiki.instance.codeToHtml.mockClear();

    useSettingsStore().setHostCapabilities({ ...VSCODE_HOST_CAPABILITIES });
    await flushPromises();
    expect(shiki.instance.codeToHtml).not.toHaveBeenCalled();
  });

  it('shows the code it was last given when an earlier highlight resolves after a later one, or fails after it', async () => {
    type Loaded = Awaited<ReturnType<CodeHighlighter['get']>>;
    const pending: { resolve: (loaded: Loaded) => void; reject: (reason: Error) => void }[] = [];
    const slow: CodeHighlighter = {
      normalizeLanguage: (language) => language ?? 'txt',
      isReady: () => false,
      get: () => new Promise<Loaded>((resolve, reject) => { pending.push({ resolve, reject }); }),
    };
    const loaded = (label: string) => ({ codeToHtml: () => `<pre><code>${label}</code></pre>` }) as unknown as Loaded;
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const wrapper = mount(CodeBlock, { props: { code: 'one', language: 'ts' }, global: { provide: { [CODE_HIGHLIGHTER as symbol]: slow }, plugins: [i18n] } });
    mounted.push(wrapper);
    await wrapper.setProps({ code: 'two', language: 'py' });
    await wrapper.setProps({ code: 'three' });
    expect(pending).toHaveLength(3);

    pending[2]!.resolve(loaded('for three'));
    await flushPromises();
    expect(wrapper.find('.code-block-content').text()).toBe('for three');
    pending[0]!.resolve(loaded('for one'));
    await flushPromises();
    expect(wrapper.find('.code-block-content').text()).toBe('for three');
    pending[1]!.reject(new Error('no grammar'));
    await flushPromises();
    expect(wrapper.find('.code-block-content').text()).toBe('for three');
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
