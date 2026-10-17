// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import SearchResultRow from '../search/SearchResultRow.vue';
import type { ResultFile, ResultRow } from '../search/search-store';
import { shellI18n } from '../i18n';

const file = { key: 'src\u2066/a\u202Eb.ts', relativePath: 'src\u2066/a\u202Eb.ts', untitled: false, matches: [], fileKey: { projectKey: 'p', relativePath: 'src\u2066/a\u202Eb.ts' } } as unknown as ResultFile;

function render(row: ResultRow) {
  shellI18n.global.locale.value = 'en';
  return mount(SearchResultRow, {
    props: { row, id: 'r', current: false, selected: false, height: 22, replacing: false, replaceMode: false, showLineNumbers: false, inlineActions: false, showFolder: true },
    global: { plugins: [shellI18n] },
  });
}

describe('SearchResultRow', () => {
  it('shows a file\'s name, folder, tooltip and accessible name with control and bidi characters escaped, keeping its real path', () => {
    const wrapper = render({ kind: 'file', key: 'f', file, level: 1, expanded: true, position: 1, setSize: 1 });
    expect(wrapper.text()).toContain('a\\u{202E}b.ts');
    expect(wrapper.text()).toContain('src\\u{2066}');
    expect(wrapper.find('[role="treeitem"]').attributes('title')).toBe('src\\u{2066}/a\\u{202E}b.ts');
    expect(wrapper.find('[role="treeitem"]').attributes('aria-label')).toContain('a\\u{202E}b.ts');
    expect(wrapper.find('[role="treeitem"]').attributes('aria-label')).not.toMatch(/[\u202E\u2066]/u);
    expect(wrapper.find('[role="treeitem"]').attributes('data-path')).toBe('src\u2066/a\u202Eb.ts');
  });

  it('shows a folder row\'s label escaped', () => {
    const node = { kind: 'folder', key: 'd', path: 'src\u2066', label: 'src\u2066', children: [], files: [file], count: 0 } as const;
    const wrapper = render({ kind: 'folder', key: 'd', node, level: 1, expanded: true, position: 1, setSize: 1 });
    expect(wrapper.text()).toContain('src\\u{2066}');
    expect(wrapper.find('[role="treeitem"]').attributes('title')).toBe('src\\u{2066}');
    expect(wrapper.html()).not.toMatch(/>[^<]*[\u202E\u2066][^<]*</u);
  });
});
