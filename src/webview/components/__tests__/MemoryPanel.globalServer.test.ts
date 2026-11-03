// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import { setActivePinia, createPinia } from 'pinia';
import MemoryPanel from '../MemoryPanel.vue';
import { i18n } from '@/i18n';
import { useMemoryStore } from '@/stores/useMemoryStore';
import { useSettingsStore } from '@/stores/useSettingsStore';
import { VSCODE_HOST_CAPABILITIES } from '@shared/types/messages';
import type { MemoryEntry } from '@shared/types/memory';

const mounted: VueWrapper[] = [];

const memory = (over: Partial<MemoryEntry>): MemoryEntry => ({
  id: 'm1', tier: 'global', scope: 'global', kind: 'fact', content: 'prefers tabs', sessionId: null, workspace: null, createdAt: 1, updatedAt: 1, tags: [], ...over,
});

function mountPanel(globalMemoryOnServer: boolean): VueWrapper {
  useSettingsStore().hostCapabilities = { ...VSCODE_HOST_CAPABILITIES, globalMemoryOnServer };
  useMemoryStore().setMemories([memory({}), memory({ id: 'm2', tier: 'project', scope: 'project', content: 'uses vitest' })]);
  const wrapper = mount(MemoryPanel, {
    props: { notes: [], observations: [], searchResults: [], hasMoreObservations: false, loadingObservations: false },
    global: { plugins: [i18n], stubs: { MarkdownRenderer: true } },
    attachTo: document.body,
  });
  mounted.push(wrapper);
  return wrapper;
}

const rowText = (wrapper: VueWrapper, id: string): string => wrapper.get(`[data-memory-id="${id}"]`).text();
const segments = (wrapper: VueWrapper, label: string): string[] =>
  wrapper.findAll(`[aria-label="${label}"] [data-segment]`).map((segment) => segment.text());
const tierSegment = (wrapper: VueWrapper, text: string) => {
  const segment = wrapper.findAll('[aria-label="Where the new memory goes"] [data-segment]').find((s) => s.text() === text);
  if (!segment) throw new Error(`no tier segment ${text}`);
  return segment;
};

beforeEach(() => setActivePinia(createPinia()));
afterEach(() => {
  while (mounted.length) mounted.pop()?.unmount();
});

describe('MemoryPanel global scope label', () => {
  it('names the server on a global memory and the global filter where the host keeps global memory there', () => {
    const wrapper = mountPanel(true);
    expect(rowText(wrapper, 'm1')).toContain('Global (this server)');
    expect(rowText(wrapper, 'm2')).toContain('Project');
    expect(rowText(wrapper, 'm2')).not.toContain('this server');
    expect(segments(wrapper, 'Filter by scope')).toEqual(['All scopes', 'Session', 'Project', 'Global (this server)']);
    expect(segments(wrapper, 'Where the new memory goes')).toContain('Global (this server)');
  });

  it('names the server in the profile hint and the global add placeholder, and only for global', async () => {
    const wrapper = mountPanel(true);
    expect(wrapper.get('[data-testid="memory-profile-toggle"]').text()).toContain('project and global (this server) · auto-maintained');
    const input = () => wrapper.get('[data-testid="memory-new"]');
    expect(input().attributes('placeholder')).toBe('Add project memory...');
    await tierSegment(wrapper, 'Global (this server)').trigger('click');
    expect(input().attributes('placeholder')).toBe('Add global memory on this server...');
    expect(wrapper.get('label[for="memory-new"]').text()).toBe('Add global memory on this server...');
  });

  it('keeps the plain label on this computer', async () => {
    const wrapper = mountPanel(false);
    expect(rowText(wrapper, 'm1')).toContain('Global');
    await tierSegment(wrapper, 'Global').trigger('click');
    expect(wrapper.get('[data-testid="memory-new"]').attributes('placeholder')).toBe('Add global memory...');
    expect(wrapper.text()).not.toContain('this server');
  });
});
