// @vitest-environment happy-dom
import { describe, it, expect, beforeEach } from 'vitest';
import { mount } from '@vue/test-utils';
import { setActivePinia, createPinia } from 'pinia';
import AccountChip from '../AccountChip.vue';
import { i18n } from '@/i18n';
import { useSettingsStore } from '@/stores/useSettingsStore';
import type { AccountInfo } from '@shared/types/settings';

function mountWith(info: AccountInfo | null) {
  useSettingsStore().setAccountInfo(info);
  return mount(AccountChip, { global: { plugins: [i18n] } });
}

beforeEach(() => setActivePinia(createPinia()));

describe('AccountChip', () => {
  it.each([
    ['chatgpt-oauth', 'ChatGPT'],
    ['codex-oauth', 'Codex'],
    ['openai-api-key', 'OpenAI API key'],
  ])('labels the OpenAI token source %s as %s', (tokenSource, label) => {
    const wrapper = mountWith({ model: 'gpt-6.1-sol', tokenSource, dollarBilled: tokenSource === 'openai-api-key' });
    expect(wrapper.get('[data-testid="account-chip-openai"]').text()).toBe(label);
  });

  it('shows no chip for a custom provider token source', () => {
    const wrapper = mountWith({ model: 'step-3', tokenSource: 'stepfun', dollarBilled: false });
    expect(wrapper.text()).toBe('');
  });

  it.each(['constructor', 'toString', '__proto__'])('shows no chip for the inherited object key %s', (tokenSource) => {
    const wrapper = mountWith({ model: 'mystery', tokenSource, dollarBilled: true });
    expect(wrapper.text()).toBe('');
  });

  it('keeps the Claude subscription chip', () => {
    const wrapper = mountWith({ model: 'claude-sonnet-5-5', subscriptionType: 'allowance', dollarBilled: false });
    expect(wrapper.get('button').text()).toBe('allowance');
    expect(wrapper.find('[data-testid="account-chip-openai"]').exists()).toBe(false);
  });
});
