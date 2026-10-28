// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import { nextTick } from 'vue';
import { createPinia } from 'pinia';
import PermissionPrompt from '../PermissionPrompt.vue';
import { i18n } from '@/i18n';
import type { BridgeHost } from '@shared/damocles-bridge';

let pushHost: ((host: BridgeHost) => void) | undefined;
window.damoclesBridge = {
  postMessage: () => {},
  onMessage: () => () => {},
  getState: () => undefined,
  setState: () => {},
  getHost: () => ({ hostId: 'h1', name: 'prod-1', computer: 'ALEXIOS-PC' }),
  onHost: (listener) => {
    pushHost = listener;
    return () => {};
  },
  getOffline: () => undefined,
  hostAction: () => undefined,
  getConnection: () => undefined,
  onConnection: () => () => undefined,
  queueAction: () => undefined,
};

describe('PermissionPrompt on a remote chat whose host is renamed', () => {
  it('names the host by the label main pushes, at once', async () => {
    const wrapper = mount(PermissionPrompt, {
      props: { visible: true, toolUseId: 'r-1', toolName: 'Bash', toolInput: { command: 'npm test' }, command: 'npm test' },
      global: { plugins: [i18n, createPinia()], stubs: { PermissionDestinationPicker: true } },
    });
    expect(wrapper.get('[data-testid="host-name-badge"]').text()).toBe('prod-1');
    pushHost!({ hostId: 'h1', name: 'billing-prod', computer: 'ALEXIOS-PC' });
    await nextTick();
    expect(wrapper.get('[data-testid="host-name-badge"]').text()).toBe('billing-prod');
    wrapper.unmount();
  });
});
