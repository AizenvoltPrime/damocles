// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import type { SearchEditorConfig, ShellEditorTab } from '../../preload/shell-channels';
import SearchEditorTab from '../editor/SearchEditorTab.vue';
import { createEditorStore, EDITOR_STORE } from '../editor/editor-store';
import { shellI18n } from '../i18n';
import { fakeShellApi, SEARCH_SETTINGS, STATE } from './fakes';

const mounted: VueWrapper[] = [];

afterEach(() => {
  for (const wrapper of mounted.splice(0)) wrapper.unmount();
});

const config: SearchEditorConfig = { query: 'needle', isRegex: false, matchCase: false, wholeWord: false, include: '', exclude: '', useExcludeSettingsAndIgnoreFiles: true, onlyOpenEditors: false, contextLines: 0, showIncludesExcludes: false };
type SearchTab = ShellEditorTab & { searchEditor: NonNullable<ShellEditorTab['searchEditor']> };
const searchTab = (running: boolean): SearchTab =>
  ({ id: 's', kind: 'searchEditor', title: 'Search: needle', displayPath: 'Search: needle', documentId: 'doc-s', dirty: false, readOnly: false, conflict: false, searchEditor: { config: { ...config }, running, untitled: true } });

describe('the Search Editor header', () => {
  it('keeps an option the user turned on while main has not taken it, across a push of the same config', async () => {
    const api = fakeShellApi();
    vi.mocked(api.setSearchEditorConfig).mockImplementation(() => new Promise(() => {}));
    const wrapper = mount(SearchEditorTab, {
      props: { api, tab: searchTab(false), platform: 'win32', settings: SEARCH_SETTINGS, detailsShortcut: '', menuShortcuts: STATE.shortcuts.editorMenu },
      global: { plugins: [shellI18n], provide: { [EDITOR_STORE]: createEditorStore(api) }, stubs: { CodeEditor: true } },
      attachTo: document.body,
    });
    mounted.push(wrapper);
    await flushPromises();
    const matchCase = () => wrapper.get('[data-testid="search-editor-option-matchCase"]').attributes('data-state');

    await wrapper.get('[data-testid="search-editor-option-matchCase"]').trigger('click');
    await flushPromises();
    expect(matchCase()).toBe('on');
    expect(api.setSearchEditorConfig).toHaveBeenCalledWith('doc-s', expect.objectContaining({ matchCase: true }));

    await wrapper.setProps({ tab: searchTab(true) });
    await flushPromises();
    expect(matchCase()).toBe('on');

    const changed = searchTab(false);
    await wrapper.setProps({ tab: { ...changed, searchEditor: { ...changed.searchEditor, config: { ...config, wholeWord: true } } } });
    await flushPromises();
    expect(wrapper.get('[data-testid="search-editor-option-wholeWord"]').attributes('data-state')).toBe('on');
    expect(matchCase()).toBe('off');
  });
});
