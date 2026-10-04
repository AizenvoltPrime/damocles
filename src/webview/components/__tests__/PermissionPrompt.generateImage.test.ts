// @vitest-environment happy-dom
import { describe, it, expect, afterEach } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import { createPinia } from 'pinia';
import { TOOL_GENERATE_IMAGE } from '@shared/tool-names';
import PermissionPrompt from '../PermissionPrompt.vue';
import { i18n } from '@/i18n';

/**
 * A GenerateImage approval shows what the user is paying for and where it lands: the path exactly as
 * the model sent it (the string permission rules match) and the prompt as plain text.
 */

const mounted: VueWrapper[] = [];

function prompt(props: { filePath: string; prompt: string; imageModel?: string }): VueWrapper {
  const wrapper = mount(PermissionPrompt, {
    props: { visible: true, toolUseId: 'g-1', toolName: TOOL_GENERATE_IMAGE, ...props },
    global: { plugins: [i18n, createPinia()], stubs: { PermissionDestinationPicker: true } },
    attachTo: document.body,
  });
  mounted.push(wrapper);
  return wrapper;
}

afterEach(() => {
  while (mounted.length) mounted.pop()?.unmount();
});

describe('PermissionPrompt for GenerateImage', () => {
  it('shows the path exactly as sent and the prompt, with no diff', () => {
    const wrapper = prompt({ filePath: './assets/../assets/hero image.png', prompt: 'A red fox in snow' });

    expect(wrapper.get('[data-testid="image-permission-path"]').text()).toBe('./assets/../assets/hero image.png');
    expect(wrapper.get('[data-testid="image-permission-prompt"]').text()).toBe('A red fox in snow');
    expect(wrapper.text()).toContain(i18n.global.t('permission.generateImage'));
    expect(wrapper.text()).not.toContain(i18n.global.t('prompts.permission.allowCreate'));
    expect(wrapper.findComponent({ name: 'DiffView' }).exists()).toBe(false);
  });

  it('names the model the call is billed for and says it is billed to the OpenRouter key', () => {
    const wrapper = prompt({ filePath: 'a.png', prompt: 'p', imageModel: 'openai/gpt-image-1' });

    expect(wrapper.get('[data-testid="image-permission-model"]').text()).toBe(`${i18n.global.t('permission.imageModel')} openai/gpt-image-1`);
    expect(wrapper.get('[data-testid="image-permission-billing"]').text()).toBe(i18n.global.t('permission.imageBilled'));
  });

  it('renders markup in the prompt as text, never as HTML', () => {
    const wrapper = prompt({ filePath: 'a.png', prompt: '<img src=x onerror="alert(1)"><b>bold</b>' });
    const body = wrapper.get('[data-testid="image-permission-prompt"]');

    expect(body.text()).toBe('<img src=x onerror="alert(1)"><b>bold</b>');
    expect(body.find('img').exists()).toBe(false);
    expect(body.find('b').exists()).toBe(false);
  });

  it('keeps a long prompt in a bounded, focusable, named scroll region', () => {
    const wrapper = prompt({ filePath: 'a.png', prompt: 'word '.repeat(2000) });
    const body = wrapper.get('[data-testid="image-permission-prompt"]');

    expect(body.classes()).toEqual(expect.arrayContaining(['max-h-40', 'overflow-y-auto', 'whitespace-pre-wrap']));
    expect(body.attributes('tabindex')).toBe('0');
    expect(body.attributes('role')).toBe('region');
    expect(body.attributes('aria-label')).toBe(i18n.global.t('permission.imagePrompt'));
  });

  it('approves and denies through the existing shortcuts', async () => {
    const wrapper = prompt({ filePath: 'a.png', prompt: 'p' });
    const listbox = wrapper.get('[role="listbox"]');

    await listbox.trigger('keydown', { key: '1' });
    await listbox.trigger('keydown', { key: '3' });

    expect(wrapper.emitted('approve')).toEqual([[true], [false]]);
  });
});
