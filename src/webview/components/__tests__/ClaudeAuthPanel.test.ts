// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import { nextTick } from 'vue';
import { setActivePinia, createPinia } from 'pinia';
import ClaudeAuthPanel from '../ClaudeAuthPanel.vue';
import { i18n } from '@/i18n';
import { useSettingsStore } from '@/stores/useSettingsStore';
import type { WebviewToExtensionMessage } from '@shared/types/messages';

const posted: WebviewToExtensionMessage[] = [];
vi.mock('@/composables/usePlatformBridge', () => ({
  usePlatformBridge: () => ({
    postMessage: (m: WebviewToExtensionMessage) => posted.push(m),
    onMessage: () => () => {},
    getState: () => undefined,
    setState: () => {},
  }),
}));

type Mode = 'none' | 'apikey' | 'allowance' | 'extra';

const mounted: VueWrapper[] = [];

function mountPanel(mode: Mode = 'none') {
  useSettingsStore().setClaudeAuthMode(mode);
  const wrapper = mount(ClaudeAuthPanel, { global: { plugins: [i18n] }, attachTo: document.body });
  mounted.push(wrapper as VueWrapper);
  return wrapper;
}

const radio = (wrapper: VueWrapper, index: number) => wrapper.findAll('input[type="radio"]')[index]!;
const button = (wrapper: VueWrapper, text: string) => wrapper.findAll('button').find((b) => b.text() === text);

beforeEach(() => {
  posted.length = 0;
  setActivePinia(createPinia());
});
afterEach(() => {
  while (mounted.length) mounted.pop()!.unmount();
  document.body.innerHTML = '';
});

describe('ClaudeAuthPanel sign-in', () => {
  it('signed out, the preselected allowance mode signs in from the button, with no radio round trip', async () => {
    const wrapper = mountPanel();

    await button(wrapper, 'Sign in with Claude')!.trigger('click');

    expect(posted).toEqual([{ type: 'claudeSignIn', useAllowance: true }]);
  });

  it('choosing a mode never starts a sign-in on its own', async () => {
    const wrapper = mountPanel();

    await radio(wrapper, 1).setValue(true);
    expect(posted).toEqual([]);

    await button(wrapper, 'Sign in with Claude')!.trigger('click');
    expect(posted).toEqual([{ type: 'claudeSignIn', useAllowance: false }]);
  });

  it('signed in to the subscription, switching bucket flips billing with no sign-in button', async () => {
    const wrapper = mountPanel('allowance');
    expect(button(wrapper, 'Sign in with Claude')).toBeUndefined();

    await radio(wrapper, 1).setValue(true);

    expect(posted).toEqual([{ type: 'claudeSetBilling', useAllowance: false }]);
  });

  it('signed in with an API key, a subscription mode offers the sign-in button', async () => {
    const wrapper = mountPanel('apikey');
    expect(button(wrapper, 'Sign in with Claude')).toBeUndefined();

    await radio(wrapper, 0).setValue(true);

    expect(posted).toEqual([]);
    expect(button(wrapper, 'Sign in with Claude')).toBeDefined();
  });
});

describe('ClaudeAuthPanel waiting for the browser', () => {
  it('pastes a redirect URL only after the user asks to', async () => {
    const wrapper = mountPanel();
    useSettingsStore().setClaudeSignInWaiting(true);
    await nextTick();

    expect(wrapper.find('[data-testid="claude-sign-in-waiting"]').exists()).toBe(true);
    expect(wrapper.find('input[type="text"]').exists()).toBe(false);
    expect(button(wrapper, 'Sign in with Claude')).toBeUndefined();

    await button(wrapper, 'Paste link instead')!.trigger('click');
    const field = wrapper.find('input[type="text"]');
    expect(document.activeElement).toBe(field.element);

    await field.setValue('  http://localhost:1/callback?code=c&state=s  ');
    await field.trigger('keydown', { key: 'Enter' });

    expect(posted).toEqual([{ type: 'claudeSignInPaste', input: 'http://localhost:1/callback?code=c&state=s' }]);
  });

  it('cancels the sign-in', async () => {
    const wrapper = mountPanel();
    useSettingsStore().setClaudeSignInWaiting(true);
    await nextTick();

    await button(wrapper, 'Cancel')!.trigger('click');

    expect(posted).toEqual([{ type: 'claudeSignInCancel' }]);
  });

  it('closes the paste field when the wait ends', async () => {
    const wrapper = mountPanel();
    const store = useSettingsStore();
    store.setClaudeSignInWaiting(true);
    await nextTick();
    await button(wrapper, 'Paste link instead')!.trigger('click');
    await wrapper.find('input[type="text"]').setValue('partial');

    store.setClaudeSignInWaiting(false);
    await nextTick();
    store.setClaudeSignInWaiting(true);
    await nextTick();

    expect(wrapper.find('input[type="text"]').exists()).toBe(false);
  });
});
