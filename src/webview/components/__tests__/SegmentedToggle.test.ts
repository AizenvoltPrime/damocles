// @vitest-environment happy-dom
import { describe, it, expect, afterEach } from 'vitest';
import { nextTick } from 'vue';
import { mount, type VueWrapper } from '@vue/test-utils';
import { ToggleGroupRoot } from 'reka-ui';
import SegmentedToggle from '../SegmentedToggle.vue';

const mounted: VueWrapper[] = [];
afterEach(() => {
  while (mounted.length) mounted.pop()?.unmount();
});

function mountToggle(extra: { variant?: 'measured' | 'equal'; modelValue?: string } = {}): VueWrapper {
  const wrapper = mount(SegmentedToggle, {
    props: {
      modelValue: 'cost',
      options: [{ value: 'cost', label: 'Cost' }, { value: 'tokens', label: 'Tokens' }],
      indicatorClass: 'text-(--d-card)',
      ...extra,
    },
    attachTo: document.body,
  });
  mounted.push(wrapper as VueWrapper);
  return wrapper as VueWrapper;
}

const option = (wrapper: VueWrapper, label: string) => wrapper.findAll('[data-segment]').find((b) => b.text() === label)!;

describe('SegmentedToggle', () => {
  it('ignores a press of the option already selected, which reka reports as a deselect', async () => {
    const wrapper = mountToggle();

    await option(wrapper, 'Cost').trigger('click');

    expect(wrapper.findComponent(ToggleGroupRoot).emitted('update:modelValue')).toEqual([[undefined]]);
    expect(wrapper.emitted('update:modelValue')).toBeUndefined();
  });

  it('selects another option', async () => {
    const wrapper = mountToggle();

    await option(wrapper, 'Tokens').trigger('click');

    expect(wrapper.emitted('update:modelValue')).toEqual([['tokens']]);
  });

  it('keeps the measured indicator by default', async () => {
    const wrapper = mountToggle();
    await nextTick();

    expect(wrapper.find('[data-testid="segmented-pill"]').exists()).toBe(false);
    expect(wrapper.classes()).toContain('flex');
    expect(wrapper.find('[data-testid="sliding-indicator"]').exists()).toBe(true);
    expect(wrapper.findAll('[data-segment]').map((segment) => segment.classes('justify-center'))).toEqual([false, false]);
  });

  it('draws the equal variant as equal columns with a pill moved one column by transform, never measured', async () => {
    const wrapper = mountToggle({ variant: 'equal' });
    const pill = wrapper.get('[data-testid="segmented-pill"]');

    expect(wrapper.classes()).toEqual(expect.arrayContaining(['grid', 'auto-cols-[1fr]', 'grid-flow-col']));
    expect(wrapper.attributes('style')).toContain('--segments: 2');
    expect(wrapper.find('[data-testid="sliding-indicator"]').exists()).toBe(false);
    expect(pill.attributes('style')).toContain('translateX(0%)');
    expect(wrapper.findAll('[data-segment]').map((segment) => segment.classes('justify-center'))).toEqual([true, true]);

    await wrapper.setProps({ modelValue: 'tokens' });

    expect(pill.attributes('style')).toContain('translateX(100%)');
  });

  it('shows no pill in the equal variant while no option is selected', async () => {
    const wrapper = mountToggle({ variant: 'equal', modelValue: 'none' });
    expect(wrapper.get('[data-testid="segmented-pill"]').isVisible()).toBe(false);
    await wrapper.setProps({ modelValue: 'cost' });
    expect(wrapper.get('[data-testid="segmented-pill"]').isVisible()).toBe(true);
  });
});
