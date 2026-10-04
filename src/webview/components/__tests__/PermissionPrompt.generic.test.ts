// @vitest-environment happy-dom
import { describe, it, expect, afterEach } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import { createPinia } from 'pinia';
import PermissionPrompt from '../PermissionPrompt.vue';
import { i18n } from '@/i18n';

/** A tool with no view of its own, such as a Read an ask rule names, shows its name and the input it runs with. */

const mounted: VueWrapper[] = [];

function prompt(props: { toolName: string; toolInput: Record<string, unknown>; agentDescription?: string }): VueWrapper {
  const wrapper = mount(PermissionPrompt, {
    props: { visible: true, toolUseId: 'r-1', ...props },
    global: { plugins: [i18n, createPinia()], stubs: { PermissionDestinationPicker: true } },
    attachTo: document.body,
  });
  mounted.push(wrapper);
  return wrapper;
}

afterEach(() => {
  while (mounted.length) mounted.pop()?.unmount();
});

describe('PermissionPrompt for a tool with no dedicated view', () => {
  it('names the tool and shows its input, never the edit wording', () => {
    const wrapper = prompt({ toolName: 'Read', toolInput: { file_path: 'secrets/key.pem' } });

    expect(wrapper.text()).toContain(i18n.global.t('permission.useTool', { tool: 'Read' }));
    expect(wrapper.text()).not.toContain(i18n.global.t('prompts.permission.allowEdit'));
    expect(JSON.parse(wrapper.get('[data-testid="tool-permission-input"]').text())).toEqual({ file_path: 'secrets/key.pem' });
  });

  it('names the tool once, in the title, with no subtitle repeating it', () => {
    const wrapper = prompt({ toolName: 'Read', toolInput: { file_path: 'secrets/key.pem' } });

    expect(wrapper.find('[data-testid="permission-subtitle"]').exists()).toBe(false);
  });

  it('names the subagent asking', () => {
    const wrapper = prompt({ toolName: 'mcp__docs__search', toolInput: { q: 'x' }, agentDescription: 'Explore' });

    expect(wrapper.text()).toContain(i18n.global.t('permission.useToolAgent', { agent: 'Explore', tool: 'mcp__docs__search' }));
  });

  it('renders markup in the input as text, never as HTML', () => {
    const wrapper = prompt({ toolName: 'Read', toolInput: { file_path: '<img src=x onerror="alert(1)">' } });

    expect(wrapper.get('[data-testid="tool-permission-input"]').find('img').exists()).toBe(false);
  });
});
