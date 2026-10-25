// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import { nextTick } from 'vue';
import { enableAutoUnmount, mount } from '@vue/test-utils';
import PermissionDestinationPicker from '../PermissionDestinationPicker.vue';
import { i18n } from '@/i18n';

enableAutoUnmount(afterEach);

// A remote chat's page: main's panel init names its host, as this computer's host store does.
window.damoclesBridge = {
  postMessage: () => {},
  onMessage: () => () => {},
  getState: () => undefined,
  setState: () => {},
  getHost: () => ({ hostId: 'h1', name: 'prod-1' }),
  onHost: () => () => {},
};

describe('the rule destination picker on a remote chat', () => {
  it('offers the all-projects choice as "Always allow on <host>", the host in its badge, and saves it as userSettings', async () => {
    const wrapper = mount(PermissionDestinationPicker, { props: { open: true, pattern: 'Bash(ls:*)' }, global: { plugins: [i18n] }, attachTo: document.body });
    await nextTick();
    await nextTick();
    const choice = document.body.querySelector<HTMLButtonElement>('[data-testid="permission-destination-userSettings"]')!;
    expect(choice.textContent).toContain('Always allow on');
    expect(choice.querySelector('[data-testid="host-name-badge"]')?.textContent?.trim()).toBe('prod-1');
    expect(choice.textContent).toContain("Saved in prod-1's settings, so it applies to every device that uses prod-1.");
    choice.click();
    expect(wrapper.emitted('select')).toEqual([['userSettings']]);
  });

  it('names the host for a deny rule too', async () => {
    mount(PermissionDestinationPicker, { props: { open: true, pattern: 'Bash(ls:*)', behavior: 'deny' }, global: { plugins: [i18n] }, attachTo: document.body });
    await nextTick();
    await nextTick();
    expect(document.body.querySelector('[data-testid="permission-destination-userSettings"]')?.textContent).toContain('Always deny on');
  });
});
