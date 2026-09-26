// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import { nextTick } from 'vue';
import { setActivePinia, createPinia } from 'pinia';
import type { ToolCall } from '@shared/types/session';
import McpToolOverlay from '../McpToolOverlay.vue';
import CodeBlock from '../CodeBlock.vue';
import { i18n } from '@/i18n';

const mounted: VueWrapper[] = [];

function openOverlay(result: string): VueWrapper {
  const tool: ToolCall = { id: 't-1', name: 'mcp__db__query', input: {}, status: 'completed', result };
  const wrapper = mount(McpToolOverlay, {
    props: { tool },
    global: { plugins: [i18n], stubs: { MarkdownRenderer: true, CodeBlock: true } },
    attachTo: document.body,
  });
  mounted.push(wrapper);
  return wrapper;
}

beforeEach(() => setActivePinia(createPinia()));
afterEach(() => {
  while (mounted.length) mounted.pop()?.unmount();
});

describe('McpToolOverlay response', () => {
  it('shows a JSON array of rows that carry a type field intact, pretty-printed', async () => {
    const rows = [{ type: 'user', name: 'ada' }, { type: 'admin', name: 'grace' }];
    const overlay = openOverlay(JSON.stringify(rows));
    await nextTick();

    expect(overlay.text()).not.toContain('No response available');
    const codes = overlay.findAllComponents(CodeBlock).map((block) => block.props('code'));
    expect(codes).toContain(JSON.stringify(rows, null, 2));
  });
});
