// @vitest-environment happy-dom
import { describe, it, expect, afterEach, vi } from 'vitest';
import { defineComponent, nextTick, ref } from 'vue';
import { mount } from '@vue/test-utils';
import { i18n } from '@/i18n';
import { useRelativeTime } from '../useRelativeTime';

const timestamp = ref<number | null>(null);

const Probe = defineComponent({
  setup() {
    return useRelativeTime(() => timestamp.value);
  },
  template: '<span :title="absolute">{{ relative }}</span>',
});

afterEach(() => {
  vi.useRealTimers();
  timestamp.value = null;
});

describe('useRelativeTime', () => {
  it('relabels as soon as the timestamp changes, without waiting for the interval', async () => {
    // Fake timers so the 30 s interval cannot be what relabels it.
    vi.useFakeTimers();
    timestamp.value = Date.now() - 2 * 60_000;
    const wrapper = mount(Probe, { global: { plugins: [i18n] } });
    await nextTick();
    expect(wrapper.text()).toBe(i18n.global.t('time.minutesAgo', { n: 2 }));
    const before = wrapper.attributes('title');

    timestamp.value = Date.now();
    await nextTick();

    expect(wrapper.text()).toBe(i18n.global.t('time.justNow'));
    expect(wrapper.attributes('title')).not.toBe(before);
    wrapper.unmount();
  });

  it('clears the label when the timestamp goes away', async () => {
    timestamp.value = Date.now();
    const wrapper = mount(Probe, { global: { plugins: [i18n] } });
    await nextTick();
    expect(wrapper.text()).toBe(i18n.global.t('time.justNow'));

    timestamp.value = null;
    await nextTick();

    expect(wrapper.text()).toBe('');
    wrapper.unmount();
  });

  it('still ticks on the interval while the timestamp stays put', async () => {
    vi.useFakeTimers();
    timestamp.value = Date.now();
    const wrapper = mount(Probe, { global: { plugins: [i18n] } });
    await nextTick();

    vi.advanceTimersByTime(3 * 60_000);
    await nextTick();

    expect(wrapper.text()).toBe(i18n.global.t('time.minutesAgo', { n: 3 }));
    wrapper.unmount();
  });
});
