// @vitest-environment happy-dom
import { describe, it, expect, beforeEach } from 'vitest';
import { mount } from '@vue/test-utils';
import { setActivePinia, createPinia } from 'pinia';
import EmptyState from '../EmptyState.vue';
import { useSettingsStore } from '@/stores/useSettingsStore';
import { i18n } from '@/i18n';

beforeEach(() => setActivePinia(createPinia()));

describe('EmptyState', () => {
  it('asks what to work on in the chat folder and offers three starting prompts', async () => {
    useSettingsStore().setWorkspaceFolders([{ key: 'k', name: 'acme-api', label: 'acme-api', path: '/w/acme-api' }], 'k', 'k');
    const wrapper = mount(EmptyState, { global: { plugins: [i18n] } });

    expect(wrapper.get('h2').text()).toBe('What should we work on in acme-api?');
    const chips = wrapper.findAll('[data-testid="empty-state-suggestion"]');
    expect(chips.map((chip) => chip.text())).toEqual(['Explain this codebase', 'Find and fix a bug', 'Write tests']);

    await chips[1]!.trigger('click');
    expect(wrapper.emitted('pick')).toEqual([['Find and fix a bug']]);
  });

  it('drops the folder from the question for a chat with no folder', () => {
    const wrapper = mount(EmptyState, { global: { plugins: [i18n] } });

    expect(wrapper.get('h2').text()).toBe('What should we work on?');
  });
});
