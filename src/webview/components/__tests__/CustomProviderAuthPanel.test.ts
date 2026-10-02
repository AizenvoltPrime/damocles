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
  it('asks for its status and names the active memory judge', async () => {
    const wrapper = mountPanel('typesafe');
    expect(bridge.posted).toEqual([{ type: 'getTypesafeAuthStatus' }]);
    const store = useSettingsStore();

    store.setTypesafeStatus(false, { kind: 'jev', via: 'openrouter' });
    await nextTick();
    expect(wrapper.find('[data-testid="memory-judge"]').text()).toBe('Memory judge: Jev via OpenRouter');
    expect(wrapper.find('[role="status"] [data-testid="memory-judge"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="memory-judge-rejected"]').exists()).toBe(false);

    store.setTypesafeStatus(true, { kind: 'jev', via: 'typesafe' });
    await nextTick();
    expect(wrapper.find('[data-testid="memory-judge"]').text()).toBe('Memory judge: Jev via TypeSafe');

    store.setTypesafeStatus(false, { kind: 'model', model: 'anthropic/claude-haiku-4-5' });
    await nextTick();
    expect(wrapper.find('[data-testid="memory-judge"]').text()).toBe('Memory judge: anthropic/claude-haiku-4-5 (sub-call model)');
  });

  it('names each refused provider and why, inside the status region', async () => {
    const wrapper = mountPanel('typesafe');
    useSettingsStore().setTypesafeStatus(true, {
      kind: 'model',
      model: 'anthropic/claude-haiku-4-5',
      rejected: [
        { via: 'typesafe', reason: 'unauthorized' },
        { via: 'openrouter', reason: 'payment-required' },
      ],
    });
    await nextTick();

    const lines = wrapper.findAll('[role="status"] [data-testid="memory-judge-rejected"]').map((line) => line.text());
    expect(lines).toEqual([
      'Jev via TypeSafe skipped: the key was not accepted. Damocles tries it again in 5 minutes, or at once when you save its key.',
      'Jev via OpenRouter skipped: the account has no credit. Damocles tries it again in 5 minutes, or at once when you save its key.',
    ]);
  });

  it('says the sub-call model is not known yet instead of claiming none is configured', async () => {
    const wrapper = mountPanel('typesafe');
    useSettingsStore().setTypesafeStatus(false, { kind: 'unknown' });
    await nextTick();
    expect(wrapper.find('[data-testid="memory-judge"]').text()).toBe('Memory judge: the sub-call model, shown once a chat has started');
    applyLocale('el');
    await nextTick();
    expect(wrapper.find('[data-testid="memory-judge"]').text()).toBe('Κριτής μνήμης: το μοντέλο δευτερευουσών κλήσεων, που εμφανίζεται μόλις ξεκινήσει μια συνομιλία');
  });

  it('saves the key under the TypeSafe message and settles on its own ack', async () => {
    const wrapper = mountPanel('typesafe');
    await wrapper.find('input').setValue('  ts-key  ');
    await wrapper.find('input').trigger('keydown.enter');
    const set = bridge.posted.find((m) => m.type === 'setTypesafeApiKey');
    expect(set).toMatchObject({ type: 'setTypesafeApiKey', key: 'ts-key' });
    for (const fn of bridge.listeners) fn({ type: 'setTypesafeApiKeyAck', requestId: (set as { requestId: string }).requestId, ok: true });
    await nextTick();
    expect(wrapper.text()).toContain('API key saved');
  });

  it('shows no judge line on other providers', async () => {
    useSettingsStore().setTypesafeStatus(true, { kind: 'jev', via: 'typesafe' });
    const wrapper = mountPanel('deepseek');
    await nextTick();
    expect(wrapper.find('[data-testid="memory-judge"]').exists()).toBe(false);
  });
});

describe('CustomProviderAuthPanel (OpenRouter)', () => {
  it('asks for its status, saves under the OpenRouter message from the keyboard, and shows its own state', async () => {
    const wrapper = mountPanel('openrouter');
    expect(bridge.posted).toEqual([{ type: 'getOpenrouterAuthStatus' }]);
    expect(wrapper.find('h3').text()).toBe('OpenRouter Authentication');
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
    expect(wrapper.find('h3').text()).toBe('Έλεγχος ταυτότητας OpenRouter');
  });
});
