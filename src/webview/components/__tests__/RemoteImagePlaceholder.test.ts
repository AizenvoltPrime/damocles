// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest';
import { mount } from '@vue/test-utils';
import RemoteImagePlaceholder from '../RemoteImagePlaceholder.vue';
import { i18n } from '@/i18n';

describe('RemoteImagePlaceholder', () => {
  it('shows the click-to-load button before opt-in and no img (zero network)', () => {
    const wrapper = mount(RemoteImagePlaceholder, { props: { src: 'https://host/a.png', alt: 'a' }, global: { plugins: [i18n] } });
    expect(wrapper.find('button').exists()).toBe(true);
    expect(wrapper.find('img').exists()).toBe(false);
    expect(wrapper.find('button').text()).toContain('host');
  });

  it('loads the img only after the button is clicked', async () => {
    const wrapper = mount(RemoteImagePlaceholder, { props: { src: 'https://host/a.png', alt: 'a' }, global: { plugins: [i18n] } });
    await wrapper.find('button').trigger('click');
    expect(wrapper.find('img[src="https://host/a.png"]').exists()).toBe(true);
    expect(wrapper.find('button').exists()).toBe(false);
  });

  it('re-gates when Vue reuses the instance for a different src', async () => {
    const wrapper = mount(RemoteImagePlaceholder, { props: { src: 'https://host/a.png', alt: 'a' }, global: { plugins: [i18n] } });
    await wrapper.find('button').trigger('click');
    expect(wrapper.find('img').exists()).toBe(true);

    // A new src must reset to the gated state — else the new remote image would auto-load unopted.
    await wrapper.setProps({ src: 'https://other/b.png' });
    expect(wrapper.find('img').exists()).toBe(false);
    expect(wrapper.find('button').exists()).toBe(true);
    expect(wrapper.find('button').text()).toContain('other');
  });

  it('passes the title through to both the button and the loaded img', async () => {
    const wrapper = mount(RemoteImagePlaceholder, { props: { src: 'https://host/a.png', alt: 'a', title: 'tip' }, global: { plugins: [i18n] } });
    expect(wrapper.find('button').attributes('title')).toBe('tip');
    await wrapper.find('button').trigger('click');
    expect(wrapper.find('img').attributes('title')).toBe('tip');
  });
});
