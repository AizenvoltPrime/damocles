// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import SearchSection from '../search/SearchSection.vue';
import { DEFAULT_SEARCH_VIEW } from '../search/search-store';
import { shellI18n } from '../i18n';
import { createEditorStore, EDITOR_STORE } from '../editor/editor-store';
import { FakeResizeObserver, fakeShellApi, SEARCH_SETTINGS, STATE } from './fakes';

const mounted: VueWrapper[] = [];

beforeEach(() => {
  shellI18n.global.locale.value = 'en';
  vi.stubGlobal('ResizeObserver', FakeResizeObserver);
});

afterEach(() => {
  for (const wrapper of mounted.splice(0)) wrapper.unmount();
  vi.unstubAllGlobals();
});

describe('Search notices', () => {
  it('names a file that cannot be previewed with control and bidi characters escaped', async () => {
    const api = fakeShellApi([], { previewReplace: vi.fn(async () => ({ ok: false as const, reason: 'changed' as const })) });
    const wrapper = mount(SearchSection, {
      props: {
        api, projectKey: 'home', projectName: 'Home', platform: 'win32', collapsed: false, settings: SEARCH_SETTINGS, shortcuts: STATE.shortcuts,
        saved: { ...DEFAULT_SEARCH_VIEW, replaceOpen: true, replaceText: 'bill' },
      },
      global: { plugins: [shellI18n], provide: { [EDITOR_STORE]: createEditorStore(api) } },
      attachTo: document.body,
    });
    mounted.push(wrapper);
    await flushPromises();
    await wrapper.find('[data-testid="search-query"]').setValue('invoice');
    await flushPromises();
    const searchId = vi.mocked(api.startSearch).mock.calls.at(-1)?.[0]?.searchId as number;
    api.searchResults({ searchId, matchCase: false, files: [{ kind: 'file', relativePath: 'src/invoice-\u202Egpj.ts', matches: [{ id: 1, range: { startLine: 1, startColumn: 1, endLine: 1, endColumn: 8 }, preview: { text: 'invoice', matchStart: 0, matchEnd: 7 } }] }] });
    await flushPromises();
    await wrapper.find('[data-row-kind="match"]').trigger('dblclick');
    await flushPromises();
    expect(wrapper.text()).toContain('src/invoice-\\u{202E}gpj.ts cannot be previewed: its text changed since the search.');
    expect(wrapper.text()).not.toContain('\u202E');
  });
});
