// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { DOMWrapper, mount, type VueWrapper } from '@vue/test-utils';
import { nextTick } from 'vue';
import { setActivePinia, createPinia } from 'pinia';
import OpenAIAuthPanel from '../OpenAIAuthPanel.vue';
import ExtensionUiDialog from '../ExtensionUiDialog.vue';
import { applyLocale, i18n } from '@/i18n';
import { createSettingsHandlers } from '@/composables/message-handler/handlers/settings-handlers';
import type { HandlerContext } from '@/composables/message-handler/types';
import { inGreek } from '../../../__mocks__/greek-locale';
import { useSettingsStore } from '@/stores/useSettingsStore';
import { useExtensionUiStore } from '@/stores/useExtensionUiStore';
import type { ExtensionToWebviewMessage, WebviewToExtensionMessage } from '@shared/types/messages';

const posted: WebviewToExtensionMessage[] = [];
const listeners: Array<(m: ExtensionToWebviewMessage) => void> = [];
vi.mock('@/composables/usePlatformBridge', () => ({
  usePlatformBridge: () => ({
    postMessage: (m: WebviewToExtensionMessage) => posted.push(m),
    onMessage: (fn: (m: ExtensionToWebviewMessage) => void) => {
      listeners.push(fn);
      return () => {};
    },
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

const typesPosted = () => posted.map((m) => m.type);

beforeEach(() => {
  posted.length = 0;
  listeners.length = 0;
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
    useSettingsStore().setChatGPTAuthError({ message: 'ChatGPT sign-in timed out' });
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
    const toggle = wrapper.get('[role="switch"]');
    expect(toggle.attributes('disabled') !== undefined).toBe(disabled);
  });

  const toggle = (wrapper: ReturnType<typeof mountPanel>) => wrapper.get('[data-testid="openai-prefer-api-key"]');
  const ack = (message: ExtensionToWebviewMessage): void => {
    for (const fn of listeners) fn(message);
  };

  it('posts the choice and holds it until its own ack, then shows what core published', async () => {
    const wrapper = mountPanel(status({ apiKey: true, chatgpt: true }));
    await toggle(wrapper).trigger('click');
    expect(posted).toEqual([{ type: 'setOpenAIPreferApiKey', preferApiKey: true, requestId: expect.any(String) }]);
    await nextTick();
    expect(toggle(wrapper).attributes('aria-checked')).toBe('true');
    const sent = posted[0] as Extract<WebviewToExtensionMessage, { type: 'setOpenAIPreferApiKey' }>;

    ack({ type: 'setOpenAIPreferApiKeyAck', requestId: 'stale', ok: true });
    useSettingsStore().setOpenAIAuthStatus(status({ apiKey: true, chatgpt: true }), true, 'apiKey');
    ack({ type: 'setOpenAIPreferApiKeyAck', requestId: sent.requestId, ok: true });
    await nextTick();
    expect(toggle(wrapper).attributes('aria-checked')).toBe('true');
    expect(wrapper.find('[role="alert"]').exists()).toBe(false);
  });

  it('shows a refused change as its own alert, with a fallback text, and the published value', async () => {
    const wrapper = mountPanel(status({ apiKey: true, chatgpt: true }));
    await toggle(wrapper).trigger('click');
    const sent = posted[0] as Extract<WebviewToExtensionMessage, { type: 'setOpenAIPreferApiKey' }>;
    ack({ type: 'setOpenAIPreferApiKeyAck', requestId: sent.requestId, ok: false });
    await nextTick();
    expect(wrapper.get('[data-testid="openai-prefer-error"]').text()).toBe('Failed to change the preference');
    expect(wrapper.get('[data-testid="openai-prefer-error"]').attributes('role')).toBe('alert');
    expect(toggle(wrapper).attributes('aria-checked')).toBe('false');

    await toggle(wrapper).trigger('click');
    const retry = posted[1] as Extract<WebviewToExtensionMessage, { type: 'setOpenAIPreferApiKey' }>;
    expect(wrapper.find('[data-testid="openai-prefer-error"]').exists()).toBe(false);
    ack({ type: 'setOpenAIPreferApiKeyAck', requestId: retry.requestId, ok: false, error: { message: 'refused on a remote host' } });
    await nextTick();
    expect(wrapper.get('[data-testid="openai-prefer-error"]').text()).toBe('refused on a remote host');
  });

  it('is disabled while a key save runs, whose ack it never takes over', async () => {
    const wrapper = mountPanel(status({ apiKey: true, chatgpt: true }));
    await wrapper.get('input[type="password"]').setValue('sk-test');
    await wrapper.get('input[type="password"]').trigger('keydown.enter');
    expect(toggle(wrapper).attributes('disabled')).toBeDefined();
    await toggle(wrapper).trigger('click');
    expect(typesPosted()).toEqual(['setOpenAIApiKey']);

    const set = posted[0] as { requestId: string };
    ack({ type: 'setOpenAIApiKeyAck', requestId: set.requestId, ok: true, validated: true, modelCount: 3 });
    await nextTick();
    expect(wrapper.get('input[type="password"]').attributes('disabled')).toBeUndefined();
    expect(toggle(wrapper).attributes('disabled')).toBeUndefined();
  });

  it('leaves a key save its own acknowledgement when toggled before the save', async () => {
    const wrapper = mountPanel(status({ apiKey: true, chatgpt: true }));
    await toggle(wrapper).trigger('click');
    await wrapper.get('input[type="password"]').setValue('sk-test');
    await wrapper.get('input[type="password"]').trigger('keydown.enter');
    const set = posted.find((m) => m.type === 'setOpenAIApiKey') as { requestId: string };
    const prefer = posted.find((m) => m.type === 'setOpenAIPreferApiKey') as { requestId: string };
    expect(set.requestId).not.toBe(prefer.requestId);

    ack({ type: 'setOpenAIApiKeyAck', requestId: set.requestId, ok: true, validated: true, modelCount: 3 });
    await nextTick();
    expect(wrapper.get('input[type="password"]').attributes('disabled')).toBeUndefined();
  });
});

describe('OpenAIAuthPanel API key', () => {
  type Ack = Extract<ExtensionToWebviewMessage, { type: 'setOpenAIApiKeyAck' }>;

  async function save(wrapper: ReturnType<typeof mountPanel>, ack: Omit<Ack, 'type' | 'requestId'>): Promise<void> {
    await wrapper.get('input[type="password"]').setValue('sk-test');
    await wrapper.get('input[type="password"]').trigger('keydown.enter');
    const set = posted.find((m) => m.type === 'setOpenAIApiKey') as { requestId: string };
    for (const fn of listeners) fn({ type: 'setOpenAIApiKeyAck', requestId: set.requestId, ...ack });
    await nextTick();
  }

  it('announces a failed save as an alert', async () => {
    const wrapper = mountPanel();
    await save(wrapper, { ok: false, error: { message: 'keyring locked' } });
    expect(wrapper.get('[role="alert"]').text()).toBe('keyring locked');
  });

  it('announces a saved key as a status', async () => {
    const wrapper = mountPanel();
    await save(wrapper, { ok: true, validated: false, warning: { message: 'saved, not checked' } });
    expect(wrapper.findAll('[role="status"]').map((el) => el.text())).toContain('saved, not checked');
  });
});

describe('OpenAIAuthPanel active credential', () => {
  it.each([
    ['signIn', 'Active credential: sign-in'],
    ['apiKey', 'Active credential: API key'],
    ['external', 'Active credential: key set outside Damocles'],
    ['none', 'Active credential: none'],
  ] as const)('announces %s as the active credential', async (active, text) => {
    const wrapper = mountPanel();
    useSettingsStore().setOpenAIAuthStatus(status({ chatgpt: true, apiKey: true }), false, active);
    await nextTick();
    const line = wrapper.get('[data-testid="credential-active"]');
    expect(line.text()).toBe(text);
    expect(line.attributes('role')).toBe('status');
  });

  it('hides the line when core does not report it', () => {
    const wrapper = mountPanel(status({ chatgpt: true, apiKey: true }));
    expect(wrapper.find('[data-testid="credential-active"]').exists()).toBe(false);
  });
});

describe('OpenAIAuthPanel after a language switch', () => {
  const CORE_TEXT = { message: 'Could not open file: {0}', args: ['auth.json'] };
  const ack = (message: ExtensionToWebviewMessage): void => {
    for (const fn of listeners) fn(message);
  };
  afterEach(() => applyLocale('en'));

  it("renders a failed save's and a refused preference's text in the new language", async () => {
    const wrapper = mountPanel(status({ apiKey: true, chatgpt: true }));
    await wrapper.get('[data-testid="openai-prefer-api-key"]').trigger('click');
    const prefer = posted.find((m) => m.type === 'setOpenAIPreferApiKey') as { requestId: string };
    ack({ type: 'setOpenAIPreferApiKeyAck', requestId: prefer.requestId, ok: false, error: CORE_TEXT });
    await wrapper.get('input[type="password"]').setValue('sk-test');
    await wrapper.get('input[type="password"]').trigger('keydown.enter');
    const set = posted.find((m) => m.type === 'setOpenAIApiKey') as { requestId: string };
    ack({ type: 'setOpenAIApiKeyAck', requestId: set.requestId, ok: false, error: CORE_TEXT });
    await nextTick();
    expect(wrapper.get('[data-testid="openai-prefer-error"]').text()).toBe('Could not open file: auth.json');

    await applyLocale('el');
    await nextTick();
    expect(wrapper.get('[data-testid="openai-prefer-error"]').text()).toBe(inGreek(CORE_TEXT));
    expect(wrapper.findAll('[role="alert"]').map((alert) => alert.text())).toEqual([inGreek(CORE_TEXT), inGreek(CORE_TEXT)]);
  });

  it('renders a failed ChatGPT sign-in in the new language', async () => {
    const wrapper = mountPanel();
    const ctx = { stores: { settingsStore: useSettingsStore() } } as unknown as HandlerContext;
    createSettingsHandlers().openaiChatGPTAuthFailed!({ type: 'openaiChatGPTAuthFailed', error: CORE_TEXT }, ctx);
    await nextTick();
    expect(wrapper.get('[role="alert"]').text()).toBe('Could not open file: auth.json');

    await applyLocale('el');
    await nextTick();
    expect(wrapper.get('[role="alert"]').text()).toBe(inGreek(CORE_TEXT));
  });
});
