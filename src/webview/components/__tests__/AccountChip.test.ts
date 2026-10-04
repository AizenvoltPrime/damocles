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
    expect(wrapper.get('[data-testid="account-chip"]').text()).toBe(label);
  });

  it('shows no chip for a custom provider token source', () => {
    const wrapper = mountWith({ model: 'step-3', tokenSource: 'stepfun', dollarBilled: false });
    expect(wrapper.text()).toBe('');
  });

  it.each(['constructor', 'toString', '__proto__'])('shows no chip for the inherited object key %s', (tokenSource) => {
    const wrapper = mountWith({ model: 'mystery', tokenSource, dollarBilled: true });
    expect(wrapper.text()).toBe('');
  });

  it.each([
    ['allowance', 'Subscription'],
    ['extra', 'Extra usage'],
    ['apikey', 'API key'],
  ])('labels the Claude auth mode %s as %s', (subscriptionType, label) => {
    const wrapper = mountWith({ model: 'claude-sonnet-5-5', subscriptionType, dollarBilled: subscriptionType !== 'allowance' });
    expect(wrapper.get('[data-testid="account-chip"]').text()).toBe(label);
    expect(wrapper.get('[data-testid="account-chip"]').attributes('title')).toBe(`Billed through: ${label}`);
  });

  it('shows no chip while Claude has no credential', () => {
    const wrapper = mountWith({ model: 'claude-sonnet-5-5', subscriptionType: 'none', dollarBilled: true });
    expect(wrapper.text()).toBe('');
  });

  it('names the signed-in account in a popover behind the chip', () => {
    const wrapper = mountWith({ model: 'claude-sonnet-5-5', subscriptionType: 'allowance', email: 'dev@example.com', dollarBilled: false });
    expect(wrapper.get('[data-testid="account-chip"]').attributes('aria-label')).toBe('Billed through: Subscription');
  });
});
