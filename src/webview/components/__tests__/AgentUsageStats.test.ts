// @vitest-environment happy-dom
import { describe, it, expect, beforeEach } from 'vitest';
import { mount } from '@vue/test-utils';
import { setActivePinia, createPinia } from 'pinia';
import type { AgentUsageTotals } from '@shared/usage-accounting';
import AgentUsageStats from '../AgentUsageStats.vue';
import { useSettingsStore } from '@/stores/useSettingsStore';
import { i18n } from '@/i18n';

const ESTIMATE_TOOLTIP = 'Estimated at API rates. A subscription is not charged per call.';

function usage(over: Partial<AgentUsageTotals> = {}): AgentUsageTotals {
  return { totalInputTokens: 10, totalOutputTokens: 100, cacheReadTokens: 900, cacheCreationTokens: 90, costUsd: 0.42, ...over };
}

function render(props: { usage: AgentUsageTotals; dollarBilled?: boolean; variant?: 'card' | 'subtitle'; separator?: string }) {
  return mount(AgentUsageStats, { props: { variant: 'card', ...props }, global: { plugins: [i18n] } });
}

const part = (wrapper: ReturnType<typeof render>, name: string) => wrapper.find(`[data-part="${name}"]`);

beforeEach(() => setActivePinia(createPinia()));

describe('AgentUsageStats', () => {
  it('counts every prompt token plus output, and itemises them in the tooltip', () => {
    const tokens = part(render({ usage: usage() }), 'tokens');
    // 10 uncached + 900 cache read + 90 cache write + 100 output.
    expect(tokens.text()).toBe('1.1K tokens');
    expect(tokens.attributes('title')).toBe('Uncached input: 10\nCache read: 900\nCache write: 90\nOutput: 100');
  });

  it('names a single token in the singular and uses the UI locale decimal separator', () => {
    const one = usage({ totalInputTokens: 0, totalOutputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0 });
    expect(part(render({ usage: one }), 'tokens').text()).toBe('1 token');

    i18n.global.locale.value = 'el';
    try {
      expect(part(render({ usage: usage() }), 'tokens').text()).toBe('1,1K tokens');
    } finally {
      i18n.global.locale.value = 'en';
    }
  });

  it('shows the cache hit rate over all prompt tokens, with its formula', () => {
    const cache = part(render({ usage: usage() }), 'cache');
    expect(cache.text()).toBe('90% cache');
    expect(cache.attributes('title')).toBe('Cache hit rate: cache read / (uncached input + cache read + cache write)');
  });

  it('marks the cost an estimate from the agent flag, whatever the panel says', () => {
    useSettingsStore().setAccountInfo({ model: 'claude-opus-5-5', dollarBilled: true });
    const cost = part(render({ usage: usage(), dollarBilled: false }), 'cost');
    expect(cost.text()).toBe('~$0.42 est.');
    expect(cost.attributes('title')).toBe(ESTIMATE_TOOLTIP);
  });

  it.each([
    { panel: false, text: '~$0.42 est.' },
    { panel: true, text: '$0.42' },
  ])('falls back to the panel flag when the agent has none (panel billed: $panel)', ({ panel, text }) => {
    useSettingsStore().setAccountInfo({ model: 'claude-opus-5-5', dollarBilled: panel });
    expect(part(render({ usage: usage() }), 'cost').text()).toBe(text);
  });

  it('hides each part whose value is zero, and renders nothing for an agent that spent nothing', () => {
    const noCache = render({ usage: usage({ cacheReadTokens: 0, costUsd: 0 }) });
    expect(part(noCache, 'tokens').exists()).toBe(true);
    expect(part(noCache, 'cache').exists()).toBe(false);
    expect(part(noCache, 'cost').exists()).toBe(false);

    const idle = render({ usage: { totalInputTokens: 0, totalOutputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, costUsd: 0 } });
    expect(idle.text()).toBe('');
  });

  it('precedes each part with the separator, so it appends to a card row or a subtitle', () => {
    const card = render({ usage: usage(), dollarBilled: true });
    // A card row spaces its items with a flex gap, which `contents` hands the parts.
    expect(card.classes()).toContain('contents');
    expect(card.findAll('span > span').map((s) => s.text())).toEqual(['•', '1.1K tokens', '•', '90% cache', '•', '$0.42']);

    const subtitle = render({ usage: usage(), dollarBilled: true, variant: 'subtitle', separator: '|' });
    expect(subtitle.classes()).not.toContain('contents');
    expect(subtitle.element.textContent).toBe('\u00a0|\u00a01.1K tokens\u00a0|\u00a090% cache\u00a0|\u00a0$0.42');
  });
});
