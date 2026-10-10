// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { nextTick } from 'vue';
import { mount, type VueWrapper } from '@vue/test-utils';
import { setActivePinia, createPinia } from 'pinia';
import CustomProviderAuthPanel from '../CustomProviderAuthPanel.vue';
import { i18n, applyLocale } from '@/i18n';
import { useSettingsStore } from '@/stores/useSettingsStore';
import type { ExtensionToWebviewMessage, WebviewToExtensionMessage } from '@shared/types/messages';

const bridge = vi.hoisted(() => ({
  posted: [] as WebviewToExtensionMessage[],
  listeners: [] as Array<(m: ExtensionToWebviewMessage) => void>,
}));
vi.mock('@/composables/usePlatformBridge', () => ({
  usePlatformBridge: () => ({
    postMessage: (m: WebviewToExtensionMessage) => bridge.posted.push(m),
    onMessage: (fn: (m: ExtensionToWebviewMessage) => void) => {
      bridge.listeners.push(fn);
      return () => {};
    },
  }),
}));

const CREDENTIALS = { typesafe: 'ok', openrouter: 'ok', openai: 'ok' } as const;

const mounted: VueWrapper[] = [];
function mountPanel(provider: 'typesafe' | 'deepseek' | 'openrouter') {
  const wrapper = mount(CustomProviderAuthPanel, { props: { provider }, global: { plugins: [i18n] } });
  mounted.push(wrapper);
  return wrapper;
}

beforeEach(() => {
  bridge.posted.length = 0;
  bridge.listeners.length = 0;
  setActivePinia(createPinia());
});
afterEach(() => {
  while (mounted.length) mounted.pop()?.unmount();
  applyLocale('en');
});

describe('CustomProviderAuthPanel (TypeSafe)', () => {
  it('names the active memory judge', async () => {
    const wrapper = mountPanel('typesafe');
    const store = useSettingsStore();

    store.setTypesafeStatus(false, { kind: 'classifier', via: 'openrouter' }, CREDENTIALS);
    await nextTick();
    expect(wrapper.find('[data-testid="memory-judge"]').text()).toBe('Memory judge: Jev (OpenRouter)');
    expect(wrapper.find('[role="status"] [data-testid="memory-judge"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="memory-judge-rejected"]').exists()).toBe(false);

    store.setTypesafeStatus(true, { kind: 'classifier', via: 'typesafe' }, CREDENTIALS);
    await nextTick();
    expect(wrapper.find('[data-testid="memory-judge"]').text()).toBe('Memory judge: Jev (TypeSafe)');

    store.setTypesafeStatus(false, { kind: 'classifier', via: 'openai' }, CREDENTIALS);
    await nextTick();
    expect(wrapper.find('[data-testid="memory-judge"]').text()).toBe('Memory judge: GPT-6 Luna (Decisions API)');

    store.setTypesafeStatus(false, { kind: 'model', model: 'anthropic/claude-haiku-5-5' }, CREDENTIALS);
    await nextTick();
    expect(wrapper.find('[data-testid="memory-judge"]').text()).toBe('Memory judge: Haiku 5.5');

    store.setTypesafeStatus(false, { kind: 'model', model: 'openai-codex/gpt-6-luna' }, CREDENTIALS);
    await nextTick();
    expect(wrapper.find('[data-testid="memory-judge"]').text()).toBe('Memory judge: GPT-6 Luna');
  });

  it('says why a chosen judge cannot run instead of naming another', async () => {
    const wrapper = mountPanel('typesafe');
    const store = useSettingsStore();
    store.setTypesafeStatus(false, { kind: 'none', forced: { choice: 'jev-typesafe', reason: 'no-key' } }, CREDENTIALS);
    await nextTick();
    expect(wrapper.find('[data-testid="memory-judge"]').text()).toBe(
      'Memory judge: none. Jev (TypeSafe) is the chosen judge but cannot run: its key is not set. Merges and reranks wait until it can.',
    );

    store.setTypesafeStatus(false, { kind: 'none', forced: { choice: 'gpt-6-luna-classifier', reason: 'chatgpt-active' } }, CREDENTIALS);
    await nextTick();
    expect(wrapper.find('[data-testid="memory-judge"]').text()).toContain(
      'GPT-6 Luna (Decisions API) is the chosen judge but cannot run: Sign in with ChatGPT is the active OpenAI credential, and the Decisions API accepts only an API key.',
    );

    store.setTypesafeStatus(false, { kind: 'none', forced: { choice: 'claude-sonnet-5-5', reason: 'signed-out' } }, CREDENTIALS);
    await nextTick();
    expect(wrapper.find('[data-testid="memory-judge"]').text()).toContain('Sonnet 5.5 is the chosen judge but cannot run: its provider is signed out.');
    applyLocale('el');
    await nextTick();
    expect(wrapper.find('[data-testid="memory-judge"]').text()).toBe(
      'Κριτής μνήμης: κανένας. Ο επιλεγμένος κριτής Sonnet 5.5 δεν μπορεί να εκτελεστεί: ο πάροχός του δεν είναι συνδεδεμένος. Οι συγχωνεύσεις και οι ανακατατάξεις περιμένουν μέχρι να μπορεί.',
    );
  });

  it('names a stored judge outside the catalog by its value and says this version does not offer it', async () => {
    const wrapper = mountPanel('typesafe');
    useSettingsStore().setTypesafeStatus(false, { kind: 'none', forced: { choice: 'claude-opus-1', reason: 'unrecognized' } }, CREDENTIALS);
    await nextTick();
    expect(wrapper.find('[data-testid="memory-judge"]').text()).toBe(
      'Memory judge: none. claude-opus-1 is the chosen judge but cannot run: this version of Damocles does not offer it. Merges and reranks wait until it can.',
    );
    applyLocale('el');
    await nextTick();
    expect(wrapper.find('[data-testid="memory-judge"]').text()).toBe(
      'Κριτής μνήμης: κανένας. Ο επιλεγμένος κριτής claude-opus-1 δεν μπορεί να εκτελεστεί: αυτή η έκδοση του Damocles δεν τον προσφέρει. Οι συγχωνεύσεις και οι ανακατατάξεις περιμένουν μέχρι να μπορεί.',
    );
  });

  it('names each refused provider and why, inside the status region', async () => {
    const wrapper = mountPanel('typesafe');
    useSettingsStore().setTypesafeStatus(true, {
      kind: 'model',
      model: 'anthropic/claude-haiku-5-5',
      rejected: [
        { via: 'typesafe', reason: 'unauthorized' },
        { via: 'openrouter', reason: 'payment-required' },
        { via: 'openai', reason: 'forbidden' },
      ],
    }, CREDENTIALS);
    await nextTick();

    const lines = wrapper.findAll('[role="status"] [data-testid="memory-judge-rejected"]').map((line) => line.text());
    expect(lines).toEqual([
      'Jev (TypeSafe) skipped: the key was not accepted. Damocles tries it again in 5 minutes, or at once when you save its key.',
      'Jev (OpenRouter) skipped: the account has no credit. Damocles tries it again in 5 minutes, or at once when you save its key.',
      'GPT-6 Luna (Decisions API) skipped: the key has no access to the classifier. Damocles tries it again in 5 minutes, or at once when you save its key.',
    ]);
  });

  it('says the judge model is not known yet instead of claiming none is configured', async () => {
    const wrapper = mountPanel('typesafe');
    useSettingsStore().setTypesafeStatus(false, { kind: 'unknown' }, CREDENTIALS);
    await nextTick();
    expect(wrapper.find('[data-testid="memory-judge"]').text()).toBe('Memory judge: the judge model, shown once a chat has started');
    applyLocale('el');
    await nextTick();
    expect(wrapper.find('[data-testid="memory-judge"]').text()).toBe('Κριτής μνήμης: το μοντέλο του κριτή, που εμφανίζεται μόλις ξεκινήσει μια συνομιλία');
  });

  it('saves the key under the TypeSafe message and settles on its own ack', async () => {
    const wrapper = mountPanel('typesafe');
    await wrapper.find('input').setValue('  ts-key  ');
    await wrapper.find('input').trigger('keydown.enter');
    const set = bridge.posted.find((m) => m.type === 'setTypesafeApiKey');
    expect(set).toMatchObject({ type: 'setTypesafeApiKey', key: 'ts-key' });
    for (const fn of bridge.listeners) fn({ type: 'setTypesafeApiKeyAck', requestId: (set as { requestId: string }).requestId, ok: true });
    await nextTick();
    expect(wrapper.find('[role="status"]').text()).toBe('API key saved');
  });

  it('announces a failed save as an alert', async () => {
    const wrapper = mountPanel('typesafe');
    await wrapper.find('input').setValue('ts-key');
    await wrapper.find('input').trigger('keydown.enter');
    const set = bridge.posted.find((m) => m.type === 'setTypesafeApiKey');
    for (const fn of bridge.listeners) fn({ type: 'setTypesafeApiKeyAck', requestId: (set as { requestId: string }).requestId, ok: false, error: 'keyring locked' });
    await nextTick();
    expect(wrapper.find('[role="alert"]').text()).toBe('keyring locked');
  });

  it('shows no judge line on other providers', async () => {
    useSettingsStore().setTypesafeStatus(true, { kind: 'classifier', via: 'typesafe' }, CREDENTIALS);
    const wrapper = mountPanel('deepseek');
    await nextTick();
    expect(wrapper.find('[data-testid="memory-judge"]').exists()).toBe(false);
  });
});

describe('CustomProviderAuthPanel (OpenRouter)', () => {
  it('saves under the OpenRouter message from the keyboard, and shows its own state', async () => {
    const wrapper = mountPanel('openrouter');
    expect(wrapper.find('input').attributes('aria-label')).toBe('API Key');
    expect(wrapper.find('button[aria-label="Show key"]').exists()).toBe(true);

    await wrapper.find('input').setValue(' sk-or-1 ');
    await wrapper.find('input').trigger('keydown.enter');
    const set = bridge.posted.find((m) => m.type === 'setOpenrouterApiKey');
    expect(set).toMatchObject({ type: 'setOpenrouterApiKey', key: 'sk-or-1' });
    for (const fn of bridge.listeners) fn({ type: 'setOpenrouterApiKeyAck', requestId: (set as { requestId: string }).requestId, ok: true });

    useSettingsStore().setOpenrouterConfigured(true);
    await nextTick();
    expect(wrapper.text()).toContain('Configured');
    expect(wrapper.find('button[aria-label="Clear API key"]').exists()).toBe(true);
    await wrapper.find('button[aria-label="Clear API key"]').trigger('click');
    expect(bridge.posted.at(-1)).toMatchObject({ type: 'clearOpenrouterApiKey' });
  });

  it('is localized', async () => {
    applyLocale('el');
    const wrapper = mountPanel('openrouter');
    await nextTick();
    expect(wrapper.find('input').attributes('aria-label')).toBe('Κλειδί API');
  });
});
