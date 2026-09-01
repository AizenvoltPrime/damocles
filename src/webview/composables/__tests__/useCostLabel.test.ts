// @vitest-environment happy-dom
import { describe, it, expect, beforeEach } from 'vitest';
import { defineComponent, nextTick, type PropType } from 'vue';
import { mount } from '@vue/test-utils';
import { setActivePinia, createPinia } from 'pinia';
import { i18n } from '@/i18n';
import { useSettingsStore } from '@/stores/useSettingsStore';
import { useCostLabel } from '../useCostLabel';

/**
 * pi derives `costUsd` from the API rate table whatever the session authenticates with, so a
 * subscription session must never render the figure as a charge. A team role can run a different model
 * from the panel, so an agent's own billing flag overrides the panel one.
 */

/** Renders the label and title the way a card does, so a store change has to flow through the template. */
const Probe = defineComponent({
  props: {
    cost: { type: Number, required: true },
    // An object, not a boolean prop, because Vue casts an absent boolean prop to false and that would
    // hide the panel fallback the composable is being tested for.
    agent: { type: Object as PropType<{ dollarBilled?: boolean }>, default: () => ({}) },
  },
  setup() {
    return useCostLabel();
  },
  template: '<div :title="costTitle(agent.dollarBilled)">{{ costLabel(cost, agent.dollarBilled) }}</div>',
});

function mountProbe(cost: number, agent: { dollarBilled?: boolean } = {}) {
  return mount(Probe, { props: { cost, agent }, global: { plugins: [i18n] } });
}

beforeEach(() => setActivePinia(createPinia()));

describe('useCostLabel', () => {
  it('renders a bare charge before any account info arrives', () => {
    const wrapper = mountProbe(0.0042);
    expect(wrapper.text()).toBe('$0.0042');
    expect(wrapper.attributes('title')).toBeUndefined();
  });

  it('switches to the estimate form when subscription account info arrives', async () => {
    const wrapper = mountProbe(26.45);
    expect(wrapper.text()).toBe('$26.45');

    useSettingsStore().setAccountInfo({ model: 'claude-opus-5', subscriptionType: 'allowance', dollarBilled: false });
    await nextTick();

    expect(wrapper.text()).toBe('~$26.45 est.');
    expect(wrapper.attributes('title')).toBe('Estimated at API rates. A subscription is not charged per call.');
  });

  it('renders a bare charge on API-key auth', () => {
    useSettingsStore().setAccountInfo({ model: 'claude-opus-5', subscriptionType: 'apikey', dollarBilled: true });
    const wrapper = mountProbe(26.45);
    expect(wrapper.text()).toBe('$26.45');
    expect(wrapper.attributes('title')).toBeUndefined();
  });

  it('marks an agent an estimate when its own model is not dollar billed inside an API-key panel', () => {
    useSettingsStore().setAccountInfo({ model: 'claude-opus-5', subscriptionType: 'apikey', dollarBilled: true });
    const wrapper = mountProbe(26.45, { dollarBilled: false });
    expect(wrapper.text()).toBe('~$26.45 est.');
    expect(wrapper.attributes('title')).toBe('Estimated at API rates. A subscription is not charged per call.');
  });

  it('charges an agent on a metered model inside a subscription panel', () => {
    useSettingsStore().setAccountInfo({ model: 'claude-opus-5', subscriptionType: 'allowance', dollarBilled: false });
    const wrapper = mountProbe(26.45, { dollarBilled: true });
    expect(wrapper.text()).toBe('$26.45');
    expect(wrapper.attributes('title')).toBeUndefined();
  });

  it('falls back to the panel value when no agent flag is supplied', () => {
    useSettingsStore().setAccountInfo({ model: 'claude-opus-5', subscriptionType: 'allowance', dollarBilled: false });
    const wrapper = mountProbe(26.45);
    expect(wrapper.text()).toBe('~$26.45 est.');
    expect(wrapper.attributes('title')).toBe('Estimated at API rates. A subscription is not charged per call.');
  });
});
