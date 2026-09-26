// @vitest-environment happy-dom
import { describe, it, expect, beforeEach } from 'vitest';
import { mount } from '@vue/test-utils';
import { setActivePinia, createPinia } from 'pinia';
import type { SessionStats as Stats } from '@shared/types/session';
import SessionStats from '../SessionStats.vue';
import { useSettingsStore } from '@/stores/useSettingsStore';
import { i18n } from '@/i18n';

/**
 * The bar shows the conversation's cumulative totals, which the extension computes from pi's session
 * stats (live) or the session file (reload). The context meter keeps its own last-request snapshot.
 */

function stats(over: Partial<Stats> = {}): Stats {
  return {
    totalInputTokens: 30,
    totalOutputTokens: 1_500,
    cacheReadTokens: 9_000,
    cacheCreationTokens: 970,
    costUsd: 0.75,
    numTurns: 3,
    contextInputTokens: 2,
    contextCacheReadTokens: 3_000,
    contextCacheWriteTokens: 100,
    contextWindowSize: 200_000,
    ...over,
  };
}

function mountBar(s: Stats, dollarBilled = true) {
  useSettingsStore().setAccountInfo({ model: 'claude-opus-5-5', dollarBilled });
  return mount(SessionStats, {
    props: { stats: s },
    global: { plugins: [i18n], stubs: { Popover: { template: '<div><slot /></div>' }, PopoverTrigger: { template: '<div><slot /></div>' }, PopoverContent: true } },
  });
}

beforeEach(() => setActivePinia(createPinia()));

describe('SessionStats', () => {
  it('shows the summed cost, all prompt tokens, output and the turn count', () => {
    const text = mountBar(stats()).text();
    expect(text).toContain('$0.75');
    expect(text).toContain('10.0K');
    expect(text).toContain('1.5K');
    expect(text).toContain('3 turns');
    expect(text).toContain('90% cache');
  });

  it('keeps the context meter on the last-request snapshot', () => {
    expect(mountBar(stats()).text()).toContain('3.1K/200.0K');
  });

  it('breaks the prompt tokens down in the tooltip', () => {
    const title = mountBar(stats()).findAll('span').map((s) => s.attributes('title')).find((t) => t?.startsWith('Session tokens'));
    expect(title).toBe('Session tokens\nUncached input: 30\nCache read: 9,000\nCache write: 970\nOutput: 1,500');
  });

  it('marks a subscription session an estimate', () => {
    expect(mountBar(stats(), false).text()).toContain('~$0.75 est.');
  });

  it('marks tokens with no recorded price unpriced instead of $0.00', () => {
    const wrapper = mountBar(stats({ costUsd: 0 }));
    expect(wrapper.text()).toContain('unpriced');
    expect(wrapper.text()).not.toContain('$0.00');
    const title = wrapper.findAll('span').map((s) => s.attributes('title')).find((t) => t?.startsWith('Cost of'));
    expect(title).toContain('No price is recorded');
  });

  it('never rounds a hit rate short of 100% up to 100%', () => {
    expect(mountBar(stats({ totalInputTokens: 5, cacheReadTokens: 995, cacheCreationTokens: 0 })).text()).toContain('99% cache');
  });

  it('shows billions of tokens with a B suffix', () => {
    expect(mountBar(stats({ totalInputTokens: 0, cacheReadTokens: 1_234_500_000, cacheCreationTokens: 0 })).text()).toContain('1.2B');
  });

  it('hides the turn count and cache rate on a fresh session', () => {
    const text = mountBar(stats({ totalInputTokens: 0, totalOutputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, costUsd: 0, numTurns: 0 })).text();
    expect(text).not.toContain('turn');
    expect(text).not.toContain('cache');
    expect(text).toContain('$0.00');
  });
});
