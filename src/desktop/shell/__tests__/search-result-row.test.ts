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

const MATCH = { kind: 'match', key: 'm', file, match: { preview: { text: 'const a = 1;', matchStart: 6, matchEnd: 7 }, range: { startLine: 1, startColumn: 7, endLine: 1, endColumn: 8 } }, level: 2, position: 1, setSize: 1 } as unknown as ResultRow;

describe('SearchResultRow over a see-through sidebar', () => {
  it('paints no surface behind its actions, and masks its text under them while they show', async () => {
    const wrapper = render(MATCH);
    const strip = wrapper.get('[data-testid="search-row-actions"]').classes();
    expect(strip.filter((name) => /(^|:)(bg|from|via|to)-/.test(name))).toEqual([]);
    expect(strip).toEqual(expect.arrayContaining(['opacity-0', 'group-hover:opacity-100', 'group-focus-within:opacity-100']));
    const mask = 'mask-[linear-gradient(to_left,transparent_var(--strip),black_calc(var(--strip)+0.75rem))]';
    expect(wrapper.get('[data-testid="search-row-text"]').classes()).toEqual(expect.arrayContaining([`group-hover:${mask}`, `group-focus-within:${mask}`]));
    expect(wrapper.get('[data-testid="search-row-text"]').find('[data-testid="search-row-dismiss"]').exists()).toBe(false);
    // one button, then two: the mask reaches as far as the buttons do
    expect(wrapper.get('[role="treeitem"]').classes()).toContain('[--strip:calc(var(--spacing)*0.5+1.25rem)]');
    await wrapper.setProps({ replaceMode: true });
    expect(wrapper.get('[role="treeitem"]').classes()).toContain('[--strip:calc(var(--spacing)*1+2.5rem)]');
  });

  it('masks nothing where the actions follow the text instead of lying over it', async () => {
    const wrapper = render(MATCH);
    await wrapper.setProps({ inlineActions: true });
    const text = wrapper.get('[data-testid="search-row-text"]').classes();
    expect(text.filter((name) => name.includes('mask-') && !name.startsWith('@max-[30rem]/results:'))).toEqual([]);
    expect(text).toContain('@min-[30rem]/results:flex-initial');
    expect(wrapper.get('[data-testid="search-row-actions"]').classes()).toContain('@min-[30rem]/results:static');
  });

  it('gives a row one background class per state, so a selected row keeps its tint under the pointer', async () => {
    const wrapper = render(MATCH);
    const row = () => wrapper.get('[role="treeitem"]').classes().filter((name) => /(^|:)bg-/.test(name));
    expect(row()).toEqual(['hover:bg-(--d-hover)']);
    await wrapper.setProps({ selected: true });
    expect(row()).toEqual(['bg-(--d-accent-soft)']);
  });

  it('keeps its glyph buttons at their own size, free of the hit-size floor', async () => {
    const wrapper = render(MATCH);
    await wrapper.setProps({ replaceMode: true });
    for (const id of ['search-row-replace', 'search-row-dismiss']) {
      expect(wrapper.get(`[data-testid="${id}"]`).classes()).toEqual(expect.arrayContaining(['d-hit-free', 'size-[1.25rem]']));
    }
  });
});

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
