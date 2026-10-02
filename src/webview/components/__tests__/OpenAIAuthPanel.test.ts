// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { DOMWrapper, mount, type VueWrapper } from '@vue/test-utils';
import { nextTick } from 'vue';
import { setActivePinia, createPinia } from 'pinia';
import OpenAIAuthPanel from '../OpenAIAuthPanel.vue';
import ExtensionUiDialog from '../ExtensionUiDialog.vue';
import { i18n } from '@/i18n';
import { useSettingsStore } from '@/stores/useSettingsStore';
import { useExtensionUiStore } from '@/stores/useExtensionUiStore';
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

type Status = Parameters<ReturnType<typeof useSettingsStore>['setOpenAIAuthStatus']>[0];

function status(overrides: { chatgpt?: boolean; codex?: boolean; apiKey?: boolean } = {}): Status {
  return {
    chatgpt: { signedIn: overrides.chatgpt ?? false },
    codex: { signedIn: overrides.codex ?? false },
    apikey: { configured: overrides.apiKey ?? false },
  };
}

const mounted: VueWrapper[] = [];

function mountPanel(initial: Status = status()) {
  useSettingsStore().setOpenAIAuthStatus(initial, false);
  const wrapper = mount(OpenAIAuthPanel, { global: { plugins: [i18n] }, attachTo: document.body });
  mounted.push(wrapper as VueWrapper);
  return wrapper;
}

const typesPosted = () => posted.map((m) => m.type).filter((t) => t !== 'getOpenAIAuthStatus');

beforeEach(() => {
  posted.length = 0;
  setActivePinia(createPinia());
});
afterEach(() => {
  while (mounted.length) mounted.pop()!.unmount();
  document.body.innerHTML = '';
});

describe('OpenAIAuthPanel ChatGPT sign-in', () => {
  it('leads with Sign in with ChatGPT and starts the ChatGPT flow', async () => {
    const wrapper = mountPanel();

    const buttons = wrapper.findAll('button');
    const signIn = buttons.find((b) => b.text() === 'Sign in with ChatGPT');
    expect(signIn).toBeDefined();
    expect(buttons.indexOf(signIn!)).toBe(0);

    await signIn!.trigger('click');
    expect(typesPosted()).toEqual(['startChatGPTOAuth']);
  });

  it('shows the in-progress state with the paste hint and blocks a second start', async () => {
    const wrapper = mountPanel();
    useSettingsStore().setChatGPTAuthInFlight(true);
    await nextTick();

    const waiting = wrapper.findAll('button').find((b) => b.text() === 'Waiting for browser...');
    expect(waiting?.attributes('disabled')).toBeDefined();
    const hint = wrapper.get('[data-testid="chatgpt-manual-hint"]');
    expect(hint.attributes('role')).toBe('status');
    expect(hint.text()).toContain('paste it into the prompt');

    await waiting!.trigger('click');
    expect(typesPosted()).toEqual([]);
  });

  it('sends one start for a double click, before the host answers', async () => {
    const wrapper = mountPanel();
    const signIn = wrapper.findAll('button').find((b) => b.text() === 'Sign in with ChatGPT')!;

    await signIn.trigger('click');
    await signIn.trigger('click');

    expect(typesPosted()).toEqual(['startChatGPTOAuth']);
    expect(useSettingsStore().openaiChatGPTAuthInFlight).toBe(true);
  });

  it('takes a pasted redirect URL through the host prompt while the sign-in waits', async () => {
    mountPanel();
    useSettingsStore().setChatGPTAuthInFlight(true);
    const dialog = mount(ExtensionUiDialog, { global: { plugins: [i18n] }, attachTo: document.body });
    mounted.push(dialog as VueWrapper);

    useExtensionUiStore().setRequest({
      requestId: 'host-prompt:1',
      kind: 'input',
      title: 'Complete login in your browser, or paste the final redirect URL here:',
      placeholder: 'http://localhost:1455/auth/callback',
    });
    await nextTick();
    await nextTick();

    const body = new DOMWrapper(document.body);
    const input = body.get<HTMLInputElement>('input[aria-label="Complete login in your browser, or paste the final redirect URL here:"]');
    const redirect = 'http://localhost:1455/auth/callback?code=abc&state=xyz';
    await input.setValue(redirect);
    await input.trigger('keydown', { key: 'Enter' });

    expect(posted).toContainEqual({ type: 'extensionUiResponse', requestId: 'host-prompt:1', value: redirect });
  });

  it('shows a failed sign-in as an alert', async () => {
    const wrapper = mountPanel();
    useSettingsStore().setChatGPTAuthError('ChatGPT sign-in timed out');
    await nextTick();

    expect(wrapper.get('[role="alert"]').text()).toBe('ChatGPT sign-in timed out');
  });

  it('signed in shows the status and a named Sign out that sends signOutChatGPT', async () => {
    const wrapper = mountPanel(status({ chatgpt: true }));

    expect(wrapper.text()).toContain('Signed in');
    expect(wrapper.findAll('button').some((b) => b.text() === 'Sign in with ChatGPT')).toBe(false);

    await wrapper.get('button[aria-label="Sign out of ChatGPT"]').trigger('click');
    expect(typesPosted()).toEqual(['signOutChatGPT']);
  });
});

describe('OpenAIAuthPanel legacy Codex row', () => {
  it('is absent while Codex is not signed in, and no Codex sign-in is offered', () => {
    const wrapper = mountPanel(status({ chatgpt: true }));

    expect(wrapper.find('[data-testid="legacy-codex-row"]').exists()).toBe(false);
    expect(wrapper.find('button[aria-label="Sign out of Codex (legacy)"]').exists()).toBe(false);
  });

  it('appears while Codex is signed in, with a Sign out that sends signOutCodex', async () => {
    const wrapper = mountPanel(status({ codex: true }));

    const row = wrapper.get('[data-testid="legacy-codex-row"]');
    expect(row.text()).toContain('Codex sign-in (legacy)');
    await row.get('button[aria-label="Sign out of Codex (legacy)"]').trigger('click');
    expect(typesPosted()).toEqual(['signOutCodex']);
  });

  it('disables its Sign out while a ChatGPT sign-in is in flight, which that sign-out would cancel', async () => {
    const wrapper = mountPanel(status({ codex: true }));
    useSettingsStore().setChatGPTAuthInFlight(true);
    await nextTick();

    const signOut = wrapper.get('button[aria-label="Sign out of Codex (legacy)"]');
    expect(signOut.attributes('disabled')).toBeDefined();
    await signOut.trigger('click');
    expect(typesPosted()).toEqual([]);
  });

  it('disappears once the status reports Codex signed out', async () => {
    const wrapper = mountPanel(status({ codex: true }));
    useSettingsStore().setOpenAIAuthStatus(status({ chatgpt: true }), false);
    await nextTick();

    expect(wrapper.find('[data-testid="legacy-codex-row"]').exists()).toBe(false);
  });
});

describe('OpenAIAuthPanel prefer-API-key toggle', () => {
  it.each([
    ['key and ChatGPT', status({ apiKey: true, chatgpt: true }), false],
    ['key and legacy Codex', status({ apiKey: true, codex: true }), false],
    ['key only', status({ apiKey: true }), true],
    ['ChatGPT only', status({ chatgpt: true }), true],
  ] as const)('with %s the toggle disabled is %s', (_case, initial, disabled) => {
    const wrapper = mountPanel(initial);
    const toggle = wrapper.get('#openai-prefer-apikey');
    expect(toggle.attributes('disabled') !== undefined).toBe(disabled);
  });
});
