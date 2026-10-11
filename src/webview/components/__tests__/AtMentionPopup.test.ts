// @vitest-environment happy-dom
import { afterEach, describe, it, expect } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import AtMentionPopup from '../AtMentionPopup.vue';
import type { AtMentionItem } from '@shared/types/commands';
import { i18n } from '@/i18n';

const HOSTILE = '<img src=x onerror=alert(1)>';

const ITEMS: AtMentionItem[] = [
  { type: 'file', data: { relativePath: `src/${HOSTILE}.ts`, isDirectory: false } },
  { type: 'builtin-agent', data: { id: HOSTILE, name: 'n', description: 'd', icon: 'i' } },
  { type: 'custom-agent', data: { name: HOSTILE, description: 'd', source: 'project' } },
];

const mounted: VueWrapper[] = [];

function popup(items: AtMentionItem[], query: string): VueWrapper {
  const wrapper = mount(AtMentionPopup, {
    props: { isOpen: true, listId: 'mentions', items, selectedIndex: 0, anchorElement: null, query, isLoading: false },
    global: { plugins: [i18n], stubs: { teleport: true } },
  });
  mounted.push(wrapper);
  return wrapper;
}

function highlighted(wrapper: VueWrapper): string[] {
  return wrapper.findAll('[role="option"] span.font-bold').map((match) => match.text());
}

afterEach(() => {
  for (const wrapper of mounted.splice(0)) wrapper.unmount();
});

describe('the @-mention popup', () => {
  it.each(['', 'onerror'])('renders file and agent names as text, never markup (query %j)', (query) => {
    const wrapper = popup(ITEMS, query);

    expect(wrapper.find('img').exists()).toBe(false);
    const rows = wrapper.findAll('[role="option"]').map((row) => row.text());
    expect(rows[0]).toContain(`${HOSTILE}.ts`);
    expect(rows[1]).toContain(`agent-${HOSTILE}`);
    expect(rows[2]).toContain(`agent-${HOSTILE}`);
    expect(highlighted(wrapper)).toEqual(query ? [query, query, query] : []);
  });

  it('highlights the match itself after a character whose lowercase is longer', () => {
    const wrapper = popup([{ type: 'file', data: { relativePath: 'src/İstanbul-file.ts', isDirectory: false } }], 'file');

    expect(highlighted(wrapper)).toEqual(['file']);
  });
});
