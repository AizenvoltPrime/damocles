// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import { createApp } from 'vue';
import { setActivePinia, createPinia } from 'pinia';
import AuthFailureBanner from '../AuthFailureBanner.vue';
import { createHandlerRegistry } from '@/composables/message-handler/handler-registry';
import type { HandlerContext, HandlerRegistry } from '@/composables/message-handler/types';
import { useUIStore, type AuthFailure } from '@/stores/useUIStore';
import { i18n, applyLocale } from '@/i18n';
import { ACCOUNT_PROVIDER_IDS, ACCOUNT_PROVIDER_NAMES } from '@shared/settings-sections';
import type { ExtensionToWebviewMessage } from '@shared/types/messages';

const mounted: VueWrapper[] = [];
function mountBanner(failure: AuthFailure) {
  const wrapper = mount(AuthFailureBanner, { props: { failure }, global: { plugins: [i18n] } });
  mounted.push(wrapper);
  return wrapper;
}

const title = (wrapper: VueWrapper) => wrapper.find('[data-testid="auth-banner"] .font-semibold').text();
const message = (wrapper: VueWrapper) => wrapper.find('[data-testid="auth-banner-message"]').text();
const action = (wrapper: VueWrapper) => wrapper.find('[data-testid="auth-banner-action"]');

beforeEach(() => setActivePinia(createPinia()));
afterEach(() => {
  while (mounted.length) mounted.pop()?.unmount();
  applyLocale('en');
});

describe('AuthFailureBanner', () => {
  it("names Anthropic in its title and message, and its Sign In opens the Anthropic row", async () => {
    const wrapper = mountBanner({ account: 'anthropic', reason: 'rejected' });
    expect(title(wrapper)).toBe('Anthropic authentication required');
    expect(message(wrapper)).toBe('Your Anthropic sign-in needs to be renewed. Sign in to continue.');
    expect(wrapper.text()).toContain('independent from the Claude Code CLI');
    expect(action(wrapper).text()).toBe('Sign In');

    await action(wrapper).trigger('click');
    expect(wrapper.emitted('open-account')).toEqual([['anthropic']]);
  });

  it.each([
    ['openai', 'OpenAI'],
    ...ACCOUNT_PROVIDER_IDS.map((id) => [id, ACCOUNT_PROVIDER_NAMES[id]] as const),
  ] as const)('names %s and opens its account row', async (account, name) => {
    const wrapper = mountBanner({ account, reason: 'rejected' });
    expect(title(wrapper)).toBe(`${name} authentication required`);
    expect(message(wrapper)).toBe(`${name} did not accept the saved credential. Update it in settings.`);
    expect(wrapper.text()).not.toContain('Claude Code CLI');
    expect(action(wrapper).text()).toBe('Open settings');

    await action(wrapper).trigger('click');
    expect(wrapper.emitted('open-account')).toEqual([[account]]);
  });

  it.each([
    ['deepseek', 'DeepSeek', 'Open settings'],
    ['anthropic', 'Anthropic', 'Sign In'],
  ] as const)('says no %s credential is saved, rather than that it was refused, and opens its row', async (account, name, actionText) => {
    const wrapper = mountBanner({ account, reason: 'missing' });
    expect(title(wrapper)).toBe(`${name} authentication required`);
    expect(message(wrapper)).toBe(`No ${name} credential is saved. Add one in settings to continue.`);
    expect(action(wrapper).text()).toBe(actionText);

    await action(wrapper).trigger('click');
    expect(wrapper.emitted('open-account')).toEqual([[account]]);
  });

  it('says the xAI account needs API access, or a saved key preferred over the sign-in', async () => {
    const wrapper = mountBanner({ account: 'xai', reason: 'noApiAccess' });
    expect(title(wrapper)).toBe('xAI authentication required');
    expect(message(wrapper)).toBe('The xAI account needs API access. Give the account API access, or save an API key and turn on Prefer API key over sign-in.');
    await action(wrapper).trigger('click');
    expect(wrapper.emitted('open-account')).toEqual([['xai']]);
  });

  it('is localized', () => {
    applyLocale('el');
    const wrapper = mountBanner({ account: 'xai', reason: 'noApiAccess' });
    expect(title(wrapper)).toBe('Απαιτείται σύνδεση στο xAI');
    expect(message(wrapper)).toBe('Ο λογαριασμός xAI χρειάζεται πρόσβαση API. Δώστε στον λογαριασμό πρόσβαση API ή αποθηκεύστε ένα κλειδί API και ενεργοποιήστε την Προτίμηση κλειδιού API έναντι σύνδεσης.');
    expect(action(wrapper).text()).toBe('Άνοιγμα ρυθμίσεων');
  });
});

describe('authFailure and authFailureCleared reaching the card', () => {
  // `createHandlerRegistry` calls `useI18n()`, which is only legal inside a component `setup`.
  function buildRegistry(): HandlerRegistry {
    let registry!: HandlerRegistry;
    const app = createApp({
      setup() {
        registry = createHandlerRegistry();
        return () => null;
      },
    });
    app.use(i18n);
    app.mount(document.createElement('div'));
    app.unmount();
    return registry;
  }

  function setup() {
    const registry = buildRegistry();
    const streamingStore = { streamingMessageId: 'streaming-1', finalizeStreamingMessage: vi.fn() };
    const ctx = { stores: { uiStore: useUIStore(), streamingStore } } as unknown as HandlerContext;
    const dispatch = (msg: ExtensionToWebviewMessage): void => {
      (registry[msg.type] as (m: ExtensionToWebviewMessage, c: HandlerContext) => void)(msg, ctx);
    };
    return { dispatch, uiStore: useUIStore(), streamingStore };
  }

  beforeEach(() => vi.spyOn(console, 'warn').mockImplementation(() => {}));
  afterEach(() => vi.restoreAllMocks());

  it('keeps the account and reason core sent', () => {
    const { dispatch, uiStore } = setup();
    dispatch({ type: 'authFailure', message: 'HTTP 402', account: 'xai', reason: 'noApiAccess' });
    expect(uiStore.authFailure).toEqual({ account: 'xai', reason: 'noApiAccess' });
  });

  it('clears any card and ends the stream on a reload, which names no account', () => {
    const { dispatch, uiStore, streamingStore } = setup();
    dispatch({ type: 'authFailure', message: 'rejected', account: 'deepseek', reason: 'rejected' });
    dispatch({ type: 'authFailureCleared' });
    expect(uiStore.authFailure).toBeNull();
    expect(streamingStore.finalizeStreamingMessage).toHaveBeenCalledOnce();
  });

  it("clears the card only for its own account's credential change, and leaves the stream running", () => {
    const { dispatch, uiStore, streamingStore } = setup();
    dispatch({ type: 'authFailure', message: 'rejected', account: 'xai', reason: 'rejected' });

    dispatch({ type: 'authFailureCleared', account: 'deepseek' });
    expect(uiStore.authFailure).toEqual({ account: 'xai', reason: 'rejected' });

    dispatch({ type: 'authFailureCleared', account: 'xai' });
    expect(uiStore.authFailure).toBeNull();
    expect(streamingStore.finalizeStreamingMessage).not.toHaveBeenCalled();
  });
});
