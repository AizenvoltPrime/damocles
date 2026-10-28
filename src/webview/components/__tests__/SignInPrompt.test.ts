// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import SignInPrompt from '@/components/SignInPrompt.vue';
import { i18n } from '@/i18n';
import { usePermissionStore } from '@/stores/usePermissionStore';
import { createPermissionHandlers } from '@/composables/message-handler/handlers/permission-handlers';
import type { HandlerContext } from '@/composables/message-handler/types';
import type { ExtensionToWebviewMessage } from '@shared/types/messages';

const posted = vi.hoisted(() => [] as unknown[]);
vi.mock('@/composables/usePlatformBridge', () => ({ usePlatformBridge: () => ({ postMessage: (message: unknown) => void posted.push(message) }) }));

let wrapper: VueWrapper | null = null;

beforeEach(() => {
  setActivePinia(createPinia());
  posted.length = 0;
  i18n.global.locale.value = 'en';
  window.damoclesBridge = {
    postMessage: () => undefined,
    onMessage: () => () => undefined,
    getState: () => undefined,
    setState: () => undefined,
    getHost: () => ({ hostId: 'h1', name: 'prod-1', computer: 'ALEXIOS-PC' }),
    onHost: () => () => undefined,
    getOffline: () => undefined,
    hostAction: () => undefined,
    getConnection: () => undefined,
    onConnection: () => () => undefined,
    queueAction: () => undefined,
  };
});

afterEach(() => {
  wrapper?.unmount();
  wrapper = null;
  delete (window as { damoclesBridge?: unknown }).damoclesBridge;
});

// The card's messages arrive through the chat page's handlers, as core posts them.
function deliver(message: ExtensionToWebviewMessage): void {
  const handlers = createPermissionHandlers() as Record<string, (msg: ExtensionToWebviewMessage, ctx: HandlerContext) => void>;
  handlers[message.type]!(message, { stores: { permissionStore: usePermissionStore() } } as unknown as HandlerContext);
}

async function mountCard(): Promise<VueWrapper> {
  wrapper = mount(SignInPrompt, { global: { plugins: [i18n] }, attachTo: document.body });
  await flushPromises();
  return wrapper;
}

describe('Sign-in needed card', () => {
  it('names the provider and this computer\'s name for the host, and sends nothing until a click', async () => {
    const card = await mountCard();
    expect(card.find('[data-testid="sign-in-card"]').exists()).toBe(false);
    deliver({ type: 'signInRequest', requestId: 'w1', provider: 'anthropic' });
    await flushPromises();
    expect(card.get('[data-testid="sign-in-card"]').text()).toContain('Sign-in needed');
    expect(card.get('[data-testid="sign-in-card"]').text()).toContain('Sign in to Claude on a computer connected to prod-1.');
    expect(card.get('[data-testid="sign-in-continue"]').text()).toBe('Continue with my sign-in');
    expect(posted).toEqual([]);
  });

  it('continues with this device\'s sign-in only on the explicit click, naming the wait', async () => {
    const card = await mountCard();
    deliver({ type: 'signInRequest', requestId: 'w1', provider: 'github-copilot' });
    await flushPromises();
    expect(card.text()).toContain('Sign in to GitHub Copilot on a computer connected to prod-1.');
    await card.get('[data-testid="sign-in-continue"]').trigger('click');
    expect(posted).toEqual([{ type: 'continueWithMySignIn', requestId: 'w1' }]);
  });

  it('stops the turn with Stop, and leaves once core resolves the wait', async () => {
    const card = await mountCard();
    deliver({ type: 'signInRequest', requestId: 'w1', provider: 'some-new-provider' });
    await flushPromises();
    expect(card.text()).toContain('Sign in to some-new-provider');
    await card.get('[data-testid="sign-in-stop"]').trigger('click');
    expect(posted).toEqual([{ type: 'cancelSession' }]);
    deliver({ type: 'signInResolved', requestId: 'other' });
    await flushPromises();
    expect(card.find('[data-testid="sign-in-card"]').exists()).toBe(true);
    deliver({ type: 'signInResolved', requestId: 'w1' });
    await flushPromises();
    expect(card.find('[data-testid="sign-in-card"]').exists()).toBe(false);
  });

  it('names every account provider that signs in by its proper name', async () => {
    const card = await mountCard();
    for (const [provider, name] of [['kimi-coding', 'Kimi Code'], ['meta', 'Meta'], ['github-copilot', 'GitHub Copilot'], ['xai', 'xAI'], ['openai-codex', 'ChatGPT']] as const) {
      deliver({ type: 'signInRequest', requestId: provider, provider });
      await flushPromises();
      expect(card.text()).toContain(`Sign in to ${name} on a computer connected to prod-1.`);
      deliver({ type: 'signInResolved', requestId: provider });
    }
  });

  it('keeps one card for a wait core posts again on a replay', async () => {
    await mountCard();
    deliver({ type: 'signInRequest', requestId: 'w1', provider: 'anthropic' });
    deliver({ type: 'signInRequest', requestId: 'w1', provider: 'anthropic' });
    expect(usePermissionStore().pendingSignIns).toHaveLength(1);
  });

  it('has a Greek text', async () => {
    i18n.global.locale.value = 'el';
    const card = await mountCard();
    deliver({ type: 'signInRequest', requestId: 'w1', provider: 'anthropic' });
    await flushPromises();
    expect(card.text()).toContain('Συνδεθείτε στο Claude σε έναν υπολογιστή συνδεδεμένο στο prod-1.');
    expect(card.get('[data-testid="sign-in-continue"]').text()).toBe('Συνέχεια με τη δική μου σύνδεση');
  });
});
