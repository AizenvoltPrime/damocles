// @vitest-environment happy-dom
import { describe, it, expect, afterEach } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import { ToggleGroupRoot } from 'reka-ui';
import SegmentedToggle from '../SegmentedToggle.vue';

const mounted: VueWrapper[] = [];
afterEach(() => {
  while (mounted.length) mounted.pop()?.unmount();
});

function mountToggle(): VueWrapper {
  const wrapper = mount(SegmentedToggle, {
    props: {
      modelValue: 'cost',
      options: [{ value: 'cost', label: 'Cost' }, { value: 'tokens', label: 'Tokens' }],
      indicatorClass: 'text-(--d-card)',
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
});
