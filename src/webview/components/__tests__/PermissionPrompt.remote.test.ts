// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import { createPinia } from 'pinia';
import PermissionPrompt from '../PermissionPrompt.vue';
import { i18n } from '@/i18n';

// A remote chat's page: main's panel init names its host, as this computer's host store does.
window.damoclesBridge = {
  postMessage: () => {},
  onMessage: () => () => {},
  getState: () => undefined,
  setState: () => {},
  getHost: () => ({ hostId: 'h1', name: 'prod-1' }),
  onHost: () => () => {},
};

const mounted: VueWrapper[] = [];

function prompt(props: Record<string, unknown>): VueWrapper {
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

describe('PermissionPrompt on a remote chat', () => {
  it('names the host in the title, in its badge, for a command', () => {
    const title = prompt({ toolName: 'Bash', toolInput: { command: 'npm test' }, command: 'npm test' }).get('[data-testid="permission-title"]');
    expect(title.text()).toContain('Run this command on');
    expect(title.get('[data-testid="host-name-badge"]').text()).toBe('prod-1');
  });

  it('names the host for a tool with no view of its own, with the tool', () => {
    const wrapper = prompt({ toolName: 'Read', toolInput: { file_path: 'a.ts' } });
    const title = wrapper.get('[data-testid="permission-title"]');
    expect(title.text()).toContain('Allow Read with this input on');
    expect(title.get('[data-testid="host-name-badge"]').text()).toBe('prod-1');
    expect(wrapper.get('[data-testid="permission-card"]').attributes('aria-label')).toBe(i18n.global.t('permission.ariaLabel'));
  });
});
