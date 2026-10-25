// @vitest-environment happy-dom
import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { mount } from '@vue/test-utils';
import { defineComponent, h } from 'vue';
import { setActivePinia, createPinia } from 'pinia';
import AllowanceUnavailableBanner from '../AllowanceUnavailableBanner.vue';
import { useSettingsStore } from '@/stores/useSettingsStore';
import { i18n, applyLocale } from '@/i18n';

// What App.vue's dock does with the notice: shown while the account state reports it, until dismissed.
const Dock = defineComponent({
  setup() {
    const store = useSettingsStore();
    return () => (store.showAllowanceNotice ? h(AllowanceUnavailableBanner, { onDismiss: () => store.dismissAllowanceNotice() }) : null);
  },
});

const mounted: { unmount: () => void }[] = [];
function mountDock() {
  const wrapper = mount(Dock, { attachTo: document.body, global: { plugins: [i18n] } });
  mounted.push(wrapper);
  return wrapper;
}

beforeEach(() => {
  setActivePinia(createPinia());
});

afterEach(() => {
  while (mounted.length) mounted.pop()!.unmount();
  applyLocale('en');
  document.body.innerHTML = '';
});

describe('the allowance notice', () => {
  it('shows while the account state says the allowance could not apply, in English and Greek', async () => {
    const store = useSettingsStore();
    const wrapper = mountDock();
    expect(wrapper.find('[data-testid="allowance-banner"]').exists()).toBe(false);

    store.setAccountInfo({ model: 'claude-sonnet-5-5', dollarBilled: true, allowanceUnavailable: true });
    await wrapper.vm.$nextTick();
    const banner = wrapper.find('[data-testid="allowance-banner"]');
    expect(banner.attributes('role')).toBe('status');
    expect(banner.text()).toContain('Claude requests here bill extra usage');

    applyLocale('el');
    await wrapper.vm.$nextTick();
    expect(wrapper.find('[data-testid="allowance-banner"]').text()).toContain('επιπλέον χρήση');
  });

  it('stays closed once dismissed until the account state stops reporting it and reports it again', async () => {
    const store = useSettingsStore();
    const wrapper = mountDock();
    store.setAccountInfo({ model: 'claude-sonnet-5-5', dollarBilled: true, allowanceUnavailable: true });
    await wrapper.vm.$nextTick();

    await wrapper.find('[data-testid="banner-dismiss"]').trigger('click');
    store.setAccountInfo({ model: 'claude-sonnet-5-5', dollarBilled: true, allowanceUnavailable: true });
    await wrapper.vm.$nextTick();
    expect(wrapper.find('[data-testid="allowance-banner"]').exists()).toBe(false);

    store.setAccountInfo({ model: 'claude-sonnet-5-5', dollarBilled: false });
    store.setAccountInfo({ model: 'claude-sonnet-5-5', dollarBilled: true, allowanceUnavailable: true });
    await wrapper.vm.$nextTick();
    expect(wrapper.find('[data-testid="allowance-banner"]').exists()).toBe(true);
  });
});
